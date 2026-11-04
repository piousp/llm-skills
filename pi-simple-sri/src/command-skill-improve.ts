import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SriFailClosedError, SriWriterError } from "./errors.ts";
import { acceptCandidate, type AcceptDeps } from "./gate/acceptance.ts";
import {
  gateStagedCandidate,
  resolveStagedCandidate,
  type GateConcludedResult,
  type GateDeps,
} from "./gate/flow.ts";
import {
  ENTRY_TYPE,
  listEligibleSkills,
  proposeSkill,
  type ImproveFlowContext,
  type ImproveFlowDeps,
  type ImproveFlowModelRegistry,
  type ImprovementEntry,
  type ProposeFn,
  type ProposedFlowResult,
} from "./improve-flow.ts";
import { serializeLesson } from "./lesson-frontmatter.ts";
import {
  acceptedText,
  gateAbstainedText,
  gatePassedText,
  gateRejectedText,
  listedSkills,
  noEvidenceText,
  noModelText,
  notEligibleText,
  proposedText,
  refusedText,
  unknownSkillText,
} from "./messages.ts";
import { COMMAND_NAME } from "./names.ts";
import { assertNever, type DecisionRecord, type DecisionSurface, type SkillRef } from "./types.ts";
import { quote, toErrorMessage } from "./values.ts";

// The /skill-improve command: one run of the loop over one named skill (P8), and from M1 the one surface of
// the package that may edit a skill.
//
// The loop itself -- settings, inventory, eligibility, evidence, diagnosis, one generation, the
// staging write and the index line -- lives in src/improve-flow.ts, because the skill_improve tool
// runs the same pipeline (P9) and two copies of it would drift. The gate lives in src/gate/flow.ts and the
// acceptance in src/gate/acceptance.ts for the same reason: the tool runs the first, and what stays here is
// what only a user command does -- parse the arguments, report every outcome as a notification, record the
// session entry with its degradation warning, and answer through another channel when there is no UI.
//
// The sentences it reports are src/messages.ts, shared with the tool: the two surfaces say the same
// things about the same outcomes, and a surface that no longer matched the other was a bug nobody
// could see.
//
// The difference between the two surfaces is explicit and small: the command reports, and it is the one that
// accepts (M1, M2). It accepts exactly where the gate says it may -- the chain is propose, gate, accept, and
// the third step runs only on a `gate-accepted` -- so the tool can gate a candidate of the same skill and the
// skill stays untouched until the command runs.
//
// The command never touches a skill before an acceptance: every path taken here writes inside
// <package>/staging and <package>/state through the flow, and the acceptance that edits a skill is the one
// step of M1, guarded by the snapshot, the drift check and the reference line of src/gate/acceptance.ts.
//
// Importing this module reads nothing, registers nothing and starts nothing (rule 9 of the slice).
// The clock, the settings file, the inventory, the model, the writer, the gate, the acceptance and the record
// channels are all resolved inside runSkillImprove, which is the only entry point.

// The surface this module reports for, in the vocabulary of decision.json (src/types.ts): the same
// value it hands proposeSkill as the trigger of the record, and the one the shared sentences use to
// pick the wording of a surface that knows the attempt was recorded.
const SURFACE: DecisionSurface = "command";

// The session entry type and the entry it carries belong to the loop, so both surfaces record the
// same shape. They are re-exported here because this module was their first home and the callers
// that read them -- the wiring and the tests -- import them from the command.
export { ENTRY_TYPE };
export type { ImprovementEntry, ProposeFn };
export type SkillImproveModelRegistry = ImproveFlowModelRegistry;

export type NotifyType = "info" | "warning" | "error";

export type NotifyFn = (message: string, type: NotifyType) => void;

export interface SkillImproveUi {
  notify(message: string, type?: NotifyType): void;
}

export interface SkillImproveMessage {
  customType: string;
  content: string;
  display: boolean;
}

// The part of the command context this command uses, spelled out instead of taking the whole
// ExtensionCommandContext: a fake in the tests then costs six fields, and a change in pi's context
// that breaks this contract fails to compile where the wiring passes the real context.
//
// It carries no appendEntry and no sendMessage: both live on the extension API
// (ExtensionAPI.appendEntry, ExtensionAPI.sendMessage) and pi's command context has neither, so both
// channels are seams of SkillImproveDeps and the wiring is the one that connects them.
//
// The four members the loop reads come from ImproveFlowContext, so this context is a superset of it
// and reaches proposeSkill without a conversion.
export interface SkillImproveContext extends ImproveFlowContext {
  readonly hasUI: boolean;
  readonly ui: SkillImproveUi;
}

// Every dependency the command touches: the seams of the loop, the two steps M1 chains after it, plus the two
// report channels and the entry channel. Each one is optional -- the loop, the gate and the acceptance resolve
// what they are not given -- and a test replaces what it needs.
//
// `notify` replaces the whole report of the run, which is what a test that only counts notifications
// wants. `sendMessage` is the channel the wiring connects: without a UI the runner hands the handler a
// no-op ui context, so the result has to leave through the session, and only the extension API can put
// it there. It is a seam and not a member of the context because pi's command context carries no
// message channel, and a wrapper that copied the context to add one would freeze the getters pi builds
// it with (dist/core/extensions/runner.js:724-728).
export interface SkillImproveDeps extends ImproveFlowDeps {
  appendEntry?: (customType: string, data: ImprovementEntry) => void;
  notify?: NotifyFn;
  sendMessage?: (message: SkillImproveMessage) => void;
  // The two steps M1 chains after the loop, each one a seam for the same reason the loop's own are: a test
  // proves the order of the chain without spending a replay or editing a skill. `gateDeps` and `acceptDeps`
  // are the seams of those steps, passed through untouched, so a test can also keep the real gate or the real
  // acceptance and replace one read or one write inside it.
  gate?: typeof gateStagedCandidate;
  gateDeps?: GateDeps;
  accept?: typeof acceptCandidate;
  acceptDeps?: AcceptDeps;
}

export interface SkillImproveArgs {
  skill?: string;
  focus?: string;
}

// The first token names the skill and every following token is the focus, so a focus with spaces
// arrives as one string. Repeated whitespace is collapsed because it carries no meaning here, and
// an argument string of spaces is no argument at all.
export function parseSkillImproveArgs(args: string): SkillImproveArgs {
  const words = args.trim().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return {};

  const [skill, ...focusWords] = words;
  const focus = focusWords.join(" ");
  return focus === "" ? { skill } : { skill, focus };
}

export async function runSkillImprove(
  args: string,
  ctx: SkillImproveContext,
  deps: SkillImproveDeps,
): Promise<void> {
  const run: Run = {
    ctx,
    deps,
    notify: deps.notify ?? channelOf(ctx, deps),
  };

  try {
    await improve(args, run);
  } catch (error) {
    // A refusal this package raises is reported, never thrown: nothing was written and the user is
    // the one who has to act on it. Any other error is a bug, and keeps its stack.
    if (!(error instanceof SriFailClosedError)) throw error;
    run.notify(error.message, "error");
  }
}

// One report channel for the whole run.
interface Run {
  ctx: SkillImproveContext;
  deps: SkillImproveDeps;
  notify: NotifyFn;
}

async function improve(args: string, run: Run): Promise<void> {
  const { ctx, deps, notify } = run;
  const parsed = parseSkillImproveArgs(args);

  // No skill named: the command answers with what it can do and on which skills, so the offer is
  // the eligible set and never the whole inventory.
  if (parsed.skill === undefined) {
    notify(usageText(await listEligibleSkills(ctx, deps)), "info");
    return;
  }

  const result = await proposeSkill(
    {
      surface: SURFACE,
      skillName: parsed.skill,
      ...(parsed.focus === undefined ? {} : { focus: parsed.focus }),
    },
    ctx,
    deps,
  );

  switch (result.kind) {
    case "unknown-skill":
      notify(unknownSkillText(SURFACE, result.skillName, result.standalone, result.eligible), "warning");
      return;
    case "not-eligible":
      recordEntry(run, result.entry);
      notify(notEligibleText(result.skill, result.reason), "warning");
      return;
    case "no-evidence":
      recordEntry(run, result.entry);
      notify(noEvidenceText(SURFACE, result.skill), "warning");
      return;
    case "no-model":
      notify(noModelText(SURFACE), "error");
      return;
    case "refused":
      // The generation refused, so the report comes first: it names the reason the user has to act
      // on, and the entry is the record of the attempt that produced it.
      notify(refusedText(result.skill, result.reason), "error");
      recordEntry(run, result.entry);
      return;
    case "proposed":
      recordEntry(run, result.entry);
      notify(proposedText(SURFACE, result.skill, result.draft.slug, result.staged.stagingPath, result.base), "info");
      // M1: the candidate is gated here, and the acceptance below it is the only write into a skill this
      // package can reach.
      await gateAndAccept(result, run);
      return;
    default:
      // The six outcomes of the flow are the whole switch: a variant added to ProposeFlowResult makes
      // this line the first thing that stops compiling, instead of reaching the user as a run that
      // reported nothing. The gate's own union is switched on in gateAndAccept, under its own assertNever.
      return assertNever(result);
  }
}

// The chain M1 adds (Q12, OA1): a candidate the loop staged is gated, and it is written into the skill only
// when the gate passes. This function decides nothing about either step -- it reports, and it calls the
// acceptance exactly where the gate said it may.
async function gateAndAccept(candidate: ProposedFlowResult, run: Run): Promise<void> {
  const { ctx, deps, notify } = run;

  // The gate spends tokens, and this is the last moment at which nothing has been spent. The budget itself is
  // fixed inside the gate (planGate, from the design and the items of the diagnosis), so the sentence says
  // what is about to happen instead of a count this surface would have to recompute for itself.
  notify(gateStartedText(candidate.skill), "info");

  const result = await (deps.gate ?? gateStagedCandidate)(
    {
      base: candidate.base,
      // The agent directory the loop read the settings and the inventory from, so the replay is measured against
      // the skills this session had (OA6).
      agentDir: deps.agentDir ?? getAgentDir(),
      cwd: ctx.cwd,
      stagingPath: candidate.staged.stagingPath,
      // The skill the loop resolved and wrote the candidate for, not a second lookup by name: the two steps must
      // be about the same directory, and the gate refuses a candidate named after another skill.
      skill: candidate.skill,
    },
    deps.gateDeps,
  );

  switch (result.kind) {
    case "refused":
      // A candidate this version cannot gate is a refusal of the whole run: nothing was written and no run was
      // spent, so the reason has to reach the user as the error it is instead of as a verdict of the gate.
      throw new SriWriterError(
        `the gate refused the candidate for skill ${quote(candidate.skill.name)}: ${result.rejection.detail}`,
        candidate.staged.decisionPath,
      );
    case "gate-rejected":
      notify(gateRejectedText(SURFACE, candidate.skill, result.reason, result.usedRuns), "warning");
      return;
    case "gate-abstained":
      notify(gateAbstainedText(SURFACE, candidate.skill, result.reason, result.detail), "warning");
      return;
    case "gate-accepted":
      notify(gatePassedText(SURFACE, candidate.skill, result.plannedRuns, result.usedRuns), "info");
      await acceptIntoSkill(candidate, result, run);
      return;
    default:
      // The three verdicts and the refusal are the whole GateFlowResult: a variant added there stops compiling
      // here, instead of reaching the user as a gate that reported nothing.
      return assertNever(result);
  }
}

// Step 7 of the protocol of §7, and the only path of this package that writes inside a skill. Everything it
// needs comes from two places and no third one: the candidate the loop staged, and the record the gate rewrote,
// which carries the candidate it measured and the hashes of the skill it measured it against.
async function acceptIntoSkill(
  candidate: ProposedFlowResult,
  gate: GateConcludedResult,
  run: Run,
): Promise<void> {
  const { deps, notify } = run;
  const { record, skillContentHash } = await stagedRecordOf(candidate, gate);

  // The bytes the acceptance writes are the candidate's: the draft is serialized again by the one function that
  // produced the file in staging, so the two calls answer the same text -- the equality src/improve-flow.ts
  // already relies on to publish the bytes it validated -- and the writer verifies the result against the hash
  // the record declares before it writes a byte into the skill.
  const lesson = serializeLesson(candidate.draft);
  if (!lesson.ok) {
    throw new SriWriterError(
      `the lesson for ${quote(candidate.skill.name)} no longer serializes: ${lesson.error}`,
      gate.decisionPath,
    );
  }

  const outcome = await (deps.accept ?? acceptCandidate)(
    {
      base: candidate.base,
      // realDir and not dir: the acceptance writes through the real path of a skill reached by a symlink (Q11).
      skill: { name: candidate.skill.name, realDir: candidate.skill.realDir },
      candidate: {
        slug: record.candidate.slug,
        title: record.candidate.title,
        lessonText: lesson.value,
        contentHash: record.candidate.contentHash,
      },
      decision: record,
      // The SKILL.md the gate measured: an edit between the gate and this call is refused as drift instead of
      // being published under a verdict about a skill that no longer exists.
      expectedSkillContentHash: skillContentHash,
      failureSignature: record.diagnosis.failureSignature,
    },
    deps.acceptDeps,
  );

  if (!outcome.ok) {
    // A candidate the protocol refused wrote nothing: the snapshot is taken before the first edit and the lesson
    // is withdrawn when the reference line cannot land, so the detail is the whole answer and the run stops here.
    notify(outcome.error.detail, "error");
    return;
  }

  notify(
    acceptedText(candidate.skill, record.candidate.slug, outcome.value.lessonPath, outcome.value.historyPath),
    "info",
  );

  // M2: await ctx.waitForIdle(); await ctx.reload();
  //
  // Step 8 and not a step of this module: the reload is a call on the context pi hands a command, and
  // SkillImproveContext declares neither `waitForIdle` nor `reload`. M2 will have to widen that contract with
  // `waitForIdle(): Promise<void>` and `reload(): Promise<void>` -- pi exposes both on the command context -- and
  // put the two calls here, after the acceptance answered and before the run reports the task done.
}

// The record the gate left in the candidate, with the hash of the skill it measured. The acceptance writes the
// first into the history of the skill and compares the second with the SKILL.md on disk, so both come from the
// file the gate rewrote instead of from a second reading of the candidate built here.
async function stagedRecordOf(
  candidate: ProposedFlowResult,
  gate: GateConcludedResult,
): Promise<{ record: DecisionRecord; skillContentHash: string }> {
  const resolved = await resolveStagedCandidate(candidate.base, candidate.skill.name, gate.stagingPath);
  if (!resolved.ok) {
    throw new SriWriterError(
      `the gate answered ${quote(gate.kind)} for ${quote(gate.decisionPath)} and its record cannot be read: ${resolved.error.detail}`,
      gate.decisionPath,
    );
  }

  const record = resolved.value;
  // The record is the authority of the two steps: a gate that answered one verdict and a record that carries
  // another describe two runs, and the acceptance is the one step that must never guess between them.
  if (record.gate.status !== "gate-accepted") {
    throw new SriWriterError(
      `the gate answered ${quote(gate.kind)} for ${quote(gate.decisionPath)} and the record says ${quote(record.gate.status)}: nothing was accepted`,
      gate.decisionPath,
    );
  }

  return { record, skillContentHash: record.gate.replay.overlays.skillContentHash };
}

// The report channel. With UI the notification is the result; without it the runner hands the
// extension a no-op ui context (dist/core/extensions/runner.js:133-136), so notify would swallow the
// text. The command context carries no channel of its own, so a wiring that wants the text in the
// session passes sendMessage; when nothing does, stderr is where pi itself reports without UI
// (runner.js:455-457).
function channelOf(ctx: SkillImproveContext, deps: SkillImproveDeps): NotifyFn {
  return (message, type) => {
    if (ctx.hasUI) {
      ctx.ui.notify(message, type);
      return;
    }

    const sendMessage = deps.sendMessage;
    if (sendMessage !== undefined) {
      sendMessage({ customType: ENTRY_TYPE, content: message, display: true });
      return;
    }

    console.error(`${COMMAND_NAME}: ${message}`);
  };
}

function recordEntry(run: Run, entry: ImprovementEntry): void {
  const append = run.deps.appendEntry;
  if (append === undefined) {
    // The entry is the /tree view of the attempt, not the audit trail: the line in
    // state/attempts.jsonl already carries the same hashes and the same skill, and staging is
    // written either way. A run that cannot record the entry says so instead of pretending.
    run.notify(
      `${ENTRY_TYPE}: the session entry was not recorded: the run has no appendEntry channel.`,
      "warning",
    );
    return;
  }

  // F2: the same reasoning covers a channel that throws. The durable record of the run is the index
  // line and the candidate, and the entry is the view of it in /tree, so a failure here is a warning
  // and never the outcome: the command still reports the candidate it staged or the refusal it got.
  try {
    append(ENTRY_TYPE, entry);
  } catch (error) {
    run.notify(
      `${ENTRY_TYPE}: the session entry was not recorded: ${toErrorMessage(error)}`,
      "warning",
    );
  }
}

// The command's own sentence: what is about to be spent, said before it is (no other surface spends it, and a
// gate of twelve runs is a long silence otherwise).
function gateStartedText(skill: SkillRef): string {
  return `gating the candidate for skill ${quote(skill.name)} with a paired replay of the skill against the skill plus the lesson; the gate spends tokens on every run, and the candidate is written into the skill only if it passes.`;
}

// The command's own sentence: the usage line and the offer of the eligible set, which no other
// surface prints.
function usageText(eligible: readonly SkillRef[]): string {
  return [
    `Usage: /${COMMAND_NAME} <skill> [focus]`,
    "Stages a lesson candidate for one skill from the failures of this session, gates it with a paired replay and accepts it into the skill only when the gate passes; the gate spends tokens.",
    "Eligible skills:",
    ...listedSkills(eligible),
  ].join("\n");
}
