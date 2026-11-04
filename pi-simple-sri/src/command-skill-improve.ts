import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SriFailClosedError, SriWriterError } from "./errors.ts";
import { acceptCandidate, type AcceptDeps } from "./gate/acceptance.ts";
import {
  gateDirectionalCandidate,
  type DirectionalGateResult,
} from "./gate/directional-flow.ts";
import {
  gateStagedCandidate,
  resolveStagedCandidate,
  verifiedStagedLesson,
  type GateConcludedResult,
  type GateDeps,
  type GateFlowResult,
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
} from "./improve-flow.ts";
import {
  acceptedText,
  gateAbstainedText,
  gatePassedText,
  gateRejectedText,
  listedSkills,
  noBaselineText,
  noEvidenceText,
  noModelGateText,
  noModelText,
  notEligibleText,
  proposedText,
  refusedText,
  unknownSkillText,
} from "./messages.ts";
import { wireDirectionalGate } from "./model-call.ts";
import { COMMAND_NAME, SKILL_IMPROVE_TOOL_NAME } from "./names.ts";
import { findSkill, listSkills } from "./skills-inventory.ts";
import { assertNever, type DecisionRecord, type DecisionSurface, type SkillRef } from "./types.ts";
import { quote, toErrorMessage } from "./values.ts";
import { writeBase } from "./write-base.ts";

// The /skill-improve command: one run of the loop over one named skill (P8), and from M1 the one surface of
// the package that may edit a skill.
//
// The loop itself -- settings, inventory, eligibility, evidence, diagnosis, one generation, the
// staging write and the index line -- lives in src/improve-flow.ts, because the skill_improve tool
// runs the same pipeline (P9) and two copies of it would drift. The gate lives in src/gate/flow.ts -- and, for the base of
// the bank, in src/gate/directional-flow.ts -- and the acceptance in src/gate/acceptance.ts for the same reason: the tool runs
// the first, and what stays here is what only a user command does -- parse the arguments, report every outcome as a
// notification, record the session entry with its degradation warning, and answer through another channel when there is no UI.
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
// M1c adds two branches and no second writer. A run that names a case bank (--bank=<path>) is measured by the flow of
// src/gate/directional-flow.ts instead of by the replayed turns of the session, and the bank without --defect is the whole
// dispatch: --defect names a bank too -- it is the file the artifact and the cases are declared in, and the proposal reads it
// -- but a defect is measured by the replay base (OA11), so the flag takes the run out of the bank's gate and not out of its
// bank. A run with --staged=<stagingPath> skips the proposal and gates a candidate that already exists, so the acceptance has
// no draft to serialize: it reads the lesson the candidate holds and verifies it against the hashes its record declares, which
// is the guard both gate bases run before they spend a run. Both branches accept exactly where the gate accepts, which is the
// whole rule of this surface.
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
  //
  // `gateDirectional` is the second flow of M1c, and it is a second seam because it is a second flow: the base of the bank
  // resolves no inventory and spends a judge, so a test that drives the chain of that base cannot be a request of the other
  // one. The judge it needs is built from the session by the one wiring of src/model-call.ts and is not a seam of its own --
  // the flow requires it, so a test that wants a verdict replaces the whole flow instead of the call inside it.
  gate?: typeof gateStagedCandidate;
  gateDirectional?: typeof gateDirectionalCandidate;
  gateDeps?: GateDeps;
  accept?: typeof acceptCandidate;
  acceptDeps?: AcceptDeps;
}

export interface SkillImproveArgs {
  skill?: string;
  focus?: string;
  // The bank that measures the candidate (M1c): a run that names one asks for a directional improvement and its failures
  // are the cases the file declares. It is the material of the run -- the proposal reads it -- and the flow of the gate is
  // selected by it only when the run is not a defect (OA11): see measuredByBankOf below.
  bankPath?: string;
  // The bank describes the defect an artifact shows instead of the cases to measure. It is a property of the bank, and it
  // is spelled as a flag because the file itself cannot declare it (OA3): a bank that is not there cannot say what it is.
  defect?: boolean;
  // The candidate to gate instead of proposing one (M1c, OA7): a run that already staged its candidate does not spend a
  // second generation to measure it.
  staged?: string;
}

// The syntax of the command, in one place: the usage line it prints and the sentence of a usage error. The flags are
// `--name=value` in a single token, so a focus with spaces cannot be confused with one of them, and `--` ends the flags.
const USAGE_SYNTAX = `<skill> [focus] [--bank=<path>] [--defect] [--staged=<stagingPath>]`;

// The first token names the skill and the following ones are the focus, so a focus with spaces arrives as one string.
// Repeated whitespace is collapsed because it carries no meaning here, and an argument string of spaces is no argument at
// all.
//
// The three flags of M1c are recognized wherever they appear, and a flag is one token with its value after the equals sign
// -- a bank path with a space in it is one token, which is why the value never arrives as the next word. `--` ends the
// flags, and everything after it is the focus as written: that is the escape for a focus that starts with `--`, and the
// reason the parse can be strict about every other token that does.
//
// A usage error is thrown and not returned: this function answers the arguments or nothing, and the command reports the
// refusal it raises the way it reports every other refusal of the package -- nothing was read, nothing was spent and no
// line of the index was written.
export function parseSkillImproveArgs(args: string): SkillImproveArgs {
  const words = args.trim().split(/\s+/).filter((word) => word !== "");

  let skill: string | undefined;
  let bankPath: string | undefined;
  let staged: string | undefined;
  let defect = false;
  const focusWords: string[] = [];

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];

    // The terminator: the rest of the line is the focus, whatever it spells.
    if (word === "--") {
      focusWords.push(...words.slice(index + 1));
      break;
    }

    if (word.startsWith("--")) {
      const flag = flagOf(word);
      const value = flag.value;
      if (flag.name === "defect" && value === undefined) {
        defect = true;
        continue;
      }
      if ((flag.name === "bank" || flag.name === "staged") && value !== undefined && value !== "") {
        if (flag.name === "bank") bankPath = value;
        else staged = value;
        continue;
      }
      // A flag this command does not have, a boolean flag given a value, and a flag whose value is missing or empty are
      // one answer: the token is not one of the three the command understands, and the sentence names the token.
      throw new SriFailClosedError(usageErrorText(word));
    }

    if (skill === undefined) {
      skill = word;
      continue;
    }
    focusWords.push(word);
  }

  // A defect is what a bank of the other profile describes, so the flag without the bank names no material at all: the
  // run would propose from an ask nobody wrote and then find nothing to measure it against, one generation later.
  if (defect && bankPath === undefined) {
    throw new SriFailClosedError(
      `/${COMMAND_NAME} --defect needs the bank the defect is written down in: --defect says what --bank=<path> describes, and the run named no bank. Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`,
    );
  }

  const parsed: SkillImproveArgs = {};
  if (skill !== undefined) parsed.skill = skill;
  const focus = focusWords.join(" ");
  if (focus !== "") parsed.focus = focus;
  if (bankPath !== undefined) parsed.bankPath = bankPath;
  if (defect) parsed.defect = true;
  if (staged !== undefined) parsed.staged = staged;
  return parsed;
}

// The two shapes a flag token can take: the boolean one, and `--name=value` in a single token.
interface Flag {
  name: string;
  value?: string;
}

function flagOf(word: string): Flag {
  const equals = word.indexOf("=");
  if (equals === -1) return { name: word.slice(2) };
  return { name: word.slice(2, equals), value: word.slice(equals + 1) };
}

function usageErrorText(word: string): string {
  return `/${COMMAND_NAME} does not understand ${quote(word)}: the flags are --bank=<path>, --defect and --staged=<stagingPath>, each one token with its value after the equals sign, and -- ends the flags so that what follows is the focus. Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`;
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

  // M1c, OA7: --staged skips the proposal and enters the gate of the candidate the path names. A run that already has a
  // candidate does not spend a second generation to measure it, and the candidate is the one the path resolves -- the same
  // record, the same lesson and the same hashes the run that staged it wrote.
  if (parsed.staged !== undefined) {
    await gateStagedCandidateRun(parsed.skill, parsed.staged, parsed, run);
    return;
  }

  // The proposal is written from the bank whenever the run names one, --defect included: the artifact the defect was read
  // from and the cases that measure it are declared in that file, and the branch reads both before it generates. Which base
  // measures the candidate is a separate question, and the answer is measuredByBankOf below.
  const result = await proposeSkill(
    {
      surface: SURFACE,
      skillName: parsed.skill,
      ...(parsed.focus === undefined ? {} : { focus: parsed.focus }),
      ...bankFieldOf(parsed.bankPath),
      ...(parsed.defect === true ? { defect: true } : {}),
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
      // The reason travels with the sentence: a run of the defect branch that could not read its bank or its artifact
      // answers with this outcome too, and the sentence may not claim the session showed nothing (M1c, S8).
      recordEntry(run, result.entry);
      notify(noEvidenceText(SURFACE, result.skill, result.entry.reason), "warning");
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
      await gateAndAccept(
        {
          base: result.base,
          skill: result.skill,
          stagingPath: result.staged.stagingPath,
          ...bankFieldOf(measuredByBankOf(parsed)),
        },
        run,
      );
      return;
    default:
      // The six outcomes of the flow are the whole switch: a variant added to ProposeFlowResult makes
      // this line the first thing that stops compiling, instead of reaching the user as a run that
      // reported nothing. The gate's own union is switched on in gateAndAccept, under its own assertNever.
      return assertNever(result);
  }
}

// Whether a bank measures the candidate of this run (M1c): a run that named one and did not ask for a defect is measured by a
// case bank, and every other run -- the session's failures, and the defect an artifact shows, which the replay base measures
// (OA11) -- by a replayed budget. The answer is the bank to hand the gate, and undefined is the answer "by replay".
//
// It is read by the dispatch of the gate and by nothing else: the proposal of a defect is still written from the bank, and a
// function that also emptied the request would take the material of the branch away from it. The record of the candidate is
// what catches a surface that got it wrong: each flow refuses a record of the other base with `basis-mismatch`.
function measuredByBankOf(parsed: SkillImproveArgs): string | undefined {
  return parsed.defect === true ? undefined : parsed.bankPath;
}

function bankFieldOf(bankPath: string | undefined): { bankPath?: string } {
  return bankPath === undefined ? {} : { bankPath };
}

// What the gate of one run is pointed at, and the only three things both branches need: the base the candidate was written
// under, the skill it belongs to -- resolved by the loop for a candidate it staged, by the inventory for a candidate that
// already exists -- and the path of the candidate, in the spelling the records use (relative to that base).
interface GateTarget {
  base: string;
  skill: SkillRef;
  stagingPath: string;
  bankPath?: string;
}

// The branch of --staged (M1c, OA7): no proposal, no staging write, no attempt line of its own -- the run only measures a
// candidate that exists. The skill is resolved from the inventory by name, the way the tool's gate resolves it, because
// there is no loop to resolve it here and the candidate directory is named after it.
async function gateStagedCandidateRun(
  skillName: string,
  stagingPath: string,
  parsed: SkillImproveArgs,
  run: Run,
): Promise<void> {
  const { ctx, deps, notify } = run;
  const agentDir = deps.agentDir ?? getAgentDir();
  const skills = await (deps.listSkills ?? listSkills)({ cwd: ctx.cwd, agentDir });
  const skill = findSkill(skills, skillName);

  if (skill === undefined) {
    // A name nobody knows, answered the way the command answers it everywhere else: the standalone the name may be, and
    // the eligible set the user can ask for instead (F6).
    const standalone = skills.find((entry) => entry.kind === "standalone" && entry.name === skillName) ?? null;
    notify(unknownSkillText(SURFACE, skillName, standalone, await listEligibleSkills(ctx, deps)), "warning");
    return;
  }

  await gateAndAccept(
    {
      base: deps.base ?? writeBase(agentDir),
      skill,
      stagingPath,
      ...bankFieldOf(measuredByBankOf(parsed)),
    },
    run,
  );
}

// The chain M1 adds (Q12, OA1): a candidate is gated, and it is written into the skill only when the gate passes. This
// function decides nothing about either step -- it reports, and it calls the acceptance exactly where the gate said it may.
// M1c adds one branch and no second write: a gate of the bank base that found no baseline is a state of the attempt, so it is
// reported with the path the retry needs and the skill is left alone.
async function gateAndAccept(target: GateTarget, run: Run): Promise<void> {
  const { notify } = run;

  // The gate spends tokens, and this is the last moment at which nothing has been spent. The budget itself is
  // fixed inside the gate (planGate, from the design and the items of the diagnosis), so the sentence says
  // what is about to happen instead of a count this surface would have to recompute for itself.
  notify(gateStartedText(target.skill), "info");

  const result = await runGate(target, run);

  switch (result.kind) {
    case "refused":
      // A candidate this version cannot gate is a refusal of the whole run: nothing was written and no run was
      // spent, so the reason has to reach the user as the error it is instead of as a verdict of the gate.
      throw new SriWriterError(
        `the gate refused the candidate for skill ${quote(target.skill.name)}: ${result.rejection.detail}`,
        target.stagingPath,
      );
    case "gate-rejected":
      // A rejection the judge produced names the case and its sentence, and the flow keeps both in the detail of the result,
      // which is the same text the line of the index carries (M4).
      notify(gateRejectedText(SURFACE, target.skill, result.reason, result.usedRuns, result.detail), "warning");
      return;
    case "gate-abstained":
      notify(gateAbstainedText(SURFACE, target.skill, result.reason, result.detail), "warning");
      return;
    case "no-baseline":
      // Nothing was spent and the record was left in the state it was, so the attempt is retryable (OA1, OA9): the
      // sentence carries the reason of the reader of the bank and the path the retry is pointed at.
      notify(noBaselineText(SURFACE, target.skill, result.reason, result.stagingPath), "warning");
      return;
    case "gate-accepted":
      notify(gatePassedText(SURFACE, target.skill, result.plannedRuns, result.usedRuns), "info");
      await acceptIntoSkill(target, result, run);
      return;
    default:
      // The three verdicts, the refusal and the answer of a base with no baseline are the whole union of the two flows: a
      // variant added there stops compiling here, instead of reaching the user as a gate that reported nothing.
      return assertNever(result);
  }
}

// The gate of one candidate, in the flow of its base. The two flows answer about the same candidate and are pointed at it the
// same way; what differs is the material, and the material is decided by the `bankPath` the caller put in the target -- which
// the callers fill from measuredByBankOf, because a defect names a bank and is still measured by a replay.
async function runGate(target: GateTarget, run: Run): Promise<GateFlowResult | DirectionalGateResult> {
  const { ctx, deps } = run;
  // The agent directory the loop read the settings and the inventory from, so the replay is measured against the skills
  // this session had (OA6).
  const agentDir = deps.agentDir ?? getAgentDir();
  const request = {
    base: target.base,
    agentDir,
    cwd: ctx.cwd,
    stagingPath: target.stagingPath,
    // The skill the loop resolved and wrote the candidate for, or the one the inventory answered for a staged candidate:
    // the gate refuses a candidate named after another skill.
    skill: target.skill,
  };

  if (target.bankPath === undefined) {
    return await (deps.gate ?? gateStagedCandidate)(request, deps.gateDeps);
  }

  // The base of the bank needs the model of the session twice -- one to replay the cases of the two arms, one to judge the
  // answers of the candidate (OA5) -- so a session without one cannot gate it at all. The wiring is the one of
  // src/model-call.ts, shared with the tool: it answers the request and the seams of this flow, or the refusal of a session
  // with no model, which this surface reports as the error it is.
  const wired = wireDirectionalGate({
    context: ctx,
    sessionId: ctx.sessionManager.getSessionId(),
    request,
    bankPath: target.bankPath,
    ...(deps.gateDeps === undefined ? {} : { gateDeps: deps.gateDeps }),
  });
  if (!wired.ok) throw new SriFailClosedError(noModelGateText(SURFACE, target.skill));

  return await (deps.gateDirectional ?? gateDirectionalCandidate)(wired.value.request, wired.value.deps);
}

// Step 7 of the protocol of §7, and the only path of this package that writes inside a skill. Everything it
// needs comes from two places and no third one: the candidate the gate measured, and the record the gate rewrote,
// which carries the candidate it measured and the hashes of the skill it measured it against.
async function acceptIntoSkill(target: GateTarget, gate: GateConcludedResult, run: Run): Promise<void> {
  const { deps, notify } = run;
  const { record, skillContentHash } = await stagedRecordOf(target, gate);

  // The bytes the acceptance writes are the bytes the candidate holds, read from the lesson the record names and verified
  // against the pair of hashes it declares (verifiedStagedLesson, the guard both gate bases run before they spend). Nothing
  // is serialized here: a run that skipped the proposal (--staged) has no draft to serialize, and a second serialization
  // would be a second answer to "are these the bytes the gate measured" -- the file is, and the record says which one.
  const lesson = await verifiedStagedLesson(path.resolve(target.base, gate.stagingPath), record);
  if (!lesson.ok) {
    throw new SriWriterError(
      `the candidate for ${quote(target.skill.name)} no longer holds the lesson its record declares: ${lesson.error}`,
      gate.decisionPath,
    );
  }

  const outcome = await (deps.accept ?? acceptCandidate)(
    {
      base: target.base,
      // realDir and not dir: the acceptance writes through the real path of a skill reached by a symlink (Q11).
      skill: { name: target.skill.name, realDir: target.skill.realDir },
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
    acceptedText(target.skill, record.candidate.slug, outcome.value.lessonPath, outcome.value.historyPath),
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
  target: GateTarget,
  gate: GateConcludedResult,
): Promise<{ record: DecisionRecord; skillContentHash: string }> {
  const resolved = await resolveStagedCandidate(target.base, target.skill.name, gate.stagingPath);
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

  // The hash of the SKILL.md the gate measured is read from the preregistration and not from the result of a basis:
  // that block is the one the two bases share, and the result of the replay base -- where M1 kept it -- is null in a
  // gate of the case-bank base. A preregistration with no hash describes a gate that measured nothing this acceptance
  // can be compared against, so the read fails closed instead of accepting under a hash nobody recorded.
  const skillContentHash = record.gate.preregistration.skillContentHash;
  if (skillContentHash === undefined) {
    throw new SriWriterError(
      `the gate answered ${quote(gate.kind)} for ${quote(gate.decisionPath)} and its preregistration carries no skillContentHash: nothing was accepted`,
      gate.decisionPath,
    );
  }

  return { record, skillContentHash };
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
// surface prints. The flags of M1c are in the syntax line because the parser accepts them and the usage error
// names them; what each one is for is the description of the command and of the tool (extensions/index.ts).
//
// The four ways of giving feedback are listed here and not in a description, because the user who typed the command
// alone is exactly the one the channel is for (M1c, S11, Q26): the failures of the session, the two profiles of a bank
// and the tool the model registers a correction with. Each line is the invocation that reaches it, so the help is
// usable without reading anything else.
function usageText(eligible: readonly SkillRef[]): string {
  return [
    `Usage: /${COMMAND_NAME} ${USAGE_SYNTAX}`,
    "Stages a lesson candidate for one skill -- from the failures of this session, or from the cases a --bank=<path> declares, with --defect when that bank describes a defect an artifact shows -- gates it with a paired replay and accepts it into the skill only when the gate passes; --staged=<stagingPath> gates a candidate that is already in staging, and the gate spends tokens.",
    "Feedback it can record, in four ways:",
    `  - a tool failure of this session: /${COMMAND_NAME} <skill> [focus]`,
    `  - a directional improvement, measured against the cases a bank declares: /${COMMAND_NAME} <skill> --bank=<path>`,
    `  - a defect an artifact shows, measured against the truth that bank declares: /${COMMAND_NAME} <skill> --bank=<path> --defect`,
    `  - a correction or a rejection the model registers before anything is spent: the ${SKILL_IMPROVE_TOOL_NAME} tool`,
    "Eligible skills:",
    ...listedSkills(eligible),
  ].join("\n");
}
