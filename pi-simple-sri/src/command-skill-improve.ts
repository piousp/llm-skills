import { SriFailClosedError } from "./errors.ts";
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
  listedSkills,
  noEvidenceText,
  noModelText,
  notEligibleText,
  proposedText,
  refusedText,
  unknownSkillText,
} from "./messages.ts";
import { COMMAND_NAME } from "./names.ts";
import { assertNever, type DecisionSurface, type SkillRef } from "./types.ts";
import { toErrorMessage } from "./values.ts";

// The /skill-improve command: one run of the loop over one named skill (P8).
//
// The loop itself -- settings, inventory, eligibility, evidence, diagnosis, one generation, the
// staging write and the index line -- lives in src/improve-flow.ts, because the skill_improve tool
// runs the same pipeline (P9) and two copies of it would drift. What stays here is what only a user
// command does: parse the arguments, report every outcome as a notification, record the session
// entry with its degradation warning, and answer through another channel when there is no UI.
//
// The sentences it reports are src/messages.ts, shared with the tool: the two surfaces say the same
// things about the same outcomes, and a surface that no longer matched the other was a bug nobody
// could see.
//
// The difference between the two surfaces is explicit and small: the command reports, and it is the
// one that accepts (M1, M2). The tool never accepts, so acceptance never lands here by accident.
//
// M0 never touches a skill: every path taken here writes inside <package>/staging and
// <package>/state through the flow, and the acceptance that edits a skill is M1 and lives in its
// own slice.
//
// Importing this module reads nothing, registers nothing and starts nothing (rule 9 of the slice).
// The clock, the settings file, the inventory, the model, the writer and the two record channels are
// all resolved inside runSkillImprove, which is the only entry point.

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

// Every dependency the command touches: the seams of the loop, plus the two report channels and the
// entry channel. Each one is optional -- the loop resolves what it is not given -- and a test replaces
// what it needs.
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
      return;
    default:
      // The six outcomes of the flow are the whole switch: a variant added to ProposeFlowResult makes
      // this line the first thing that stops compiling, instead of reaching the user as a run that
      // reported nothing.
      return assertNever(result);
  }
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

// The command's own sentence: the usage line and the offer of the eligible set, which no other
// surface prints.
function usageText(eligible: readonly SkillRef[]): string {
  return [
    `Usage: /${COMMAND_NAME} <skill> [focus]`,
    "Stages a lesson candidate for one skill from the failures of this session and leaves the skill untouched.",
    "Eligible skills:",
    ...listedSkills(eligible),
  ].join("\n");
}
