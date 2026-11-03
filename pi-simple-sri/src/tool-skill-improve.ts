import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  ENTRY_TYPE,
  diagnoseSkill,
  proposeSkill,
  type ImproveFlowContext,
  type ImproveFlowDeps,
  type ImprovementEntry,
} from "./improve-flow.ts";
import {
  noEvidenceText,
  noModelText,
  notEligibleText,
  proposedText,
  refusedText,
  unknownSkillText,
} from "./messages.ts";
import { SKILL_IMPROVE_TOOL_NAME } from "./names.ts";
import type { GenerationUsage } from "./proposer.ts";
import { assertNever, type DecisionSurface, type Diagnosis, type Eligibility, type SkillRef } from "./types.ts";
import { quote, toErrorMessage } from "./values.ts";

// The skill_improve tool, the second surface of the loop (P9, Q7). It answers two questions the
// model can ask mid-session:
//
//   diagnose  what failed in this session, and what would a replay have to test? Read-only.
//   propose   the same, plus one generation and the staging write. It never accepts.
//
// Both actions run the pipeline of src/improve-flow.ts, the same one /skill-improve runs, so the
// command and the tool cannot disagree about what is eligible, what counts as evidence or what the
// candidate looks like. What differs is the answer: the command notifies, the tool returns a tool
// result, and neither accepts -- acceptance edits a skill and belongs to the command alone (Q12).
//
// Rule 3: the description below travels in every session that loads this tool, so it says in one
// sentence that the tool never edits the skill. The rest of the promise is in the code: the only
// writes this module can reach are the flow's staging tree, its index line and the session entry.
//
// Rule 4: nothing here throws at the runtime. Every refusal -- ours, the proposer's, the writer's,
// or a bug -- leaves as a result with isError: true, the reason and the data that names the target,
// because a thrown error would lose the details and the transcript would keep a stack instead of a
// reason.
//
// Rule 5: a propose that called the model reports the usage of that generation in details, so the
// cost of the call is visible where the call was made.
//
// Rule 6: details has the documented shape { action, skill, outcome, reason?, stagingPath?,
// decisionPath?, usage? } and nothing else. A caller that logs it never has to guess. The session entry
// is not part of that shape: when it cannot be recorded the answer says so in its text and details keeps
// the outcome of the work itself, because the entry is the /tree view of an attempt whose record is the
// candidate and its index line (F2).
//
// Rule 7: importing this module reads nothing and starts nothing; createSkillImproveTool only
// captures the dependencies the flow and the entry channel need.

// The tool's name has one owner (src/names.ts), re-exported here because this module registers it and
// the callers that read it import it from the tool.
export { SKILL_IMPROVE_TOOL_NAME };

// The surface this module reports for, in the vocabulary of decision.json (src/types.ts): the same
// value it hands proposeSkill as the trigger of the record, and the one the shared sentences use to
// pick the wording of a surface that never accepts.
const SURFACE: DecisionSurface = "tool";

export type SkillImproveAction = "diagnose" | "propose";

// The action names the two entry points of the flow, and the schema accepts nothing else: a tool
// call outside this union is refused by the runtime before execute() runs.
export const skillImproveParams = Type.Object({
  action: Type.Union([Type.Literal("diagnose"), Type.Literal("propose")], {
    description: "diagnose reports what failed and what the replay would test; propose stages a lesson candidate",
  }),
  skill: Type.String({ description: "Exact skill name, as listed by the inventory" }),
  focus: Type.Optional(Type.String({ description: "Optional hint about what to improve" })),
});

export type SkillImproveParams = Static<typeof skillImproveParams>;

// What became of the call, in a closed set. "diagnosed" and "proposed" are the successes;
// "not-eligible", "no-evidence", "unknown-skill" and "no-model" are the refusals a caller can
// predict and handle by name; "error" is everything else: a generation that refused to produce a
// lesson, a lesson that does not validate, a write the perimeter refused, or a bug.
export type SkillImproveOutcome =
  | "diagnosed"
  | "proposed"
  | "not-eligible"
  | "no-evidence"
  | "unknown-skill"
  | "no-model"
  | "error";

// The documented shape of `details` (rule 6). `reason` is the vocabulary of the refusal for the
// predictable ones and the refusal message for "error"; the two paths and the base are present exactly
// when a candidate was staged. The paths are relative to that base, the way the records name them, so a
// consumer opens the candidate by joining the two fields instead of guessing a prefix.
export interface ToolDetails {
  action: SkillImproveAction;
  skill: string;
  outcome: SkillImproveOutcome;
  reason?: string;
  base?: string;
  stagingPath?: string;
  decisionPath?: string;
  usage?: GenerationUsage;
}

// The seams of the flow plus the one channel a tool context does not carry: appendEntry lives on the
// extension API, so the wiring passes it in and a test replaces it.
export interface SkillImproveToolDeps extends ImproveFlowDeps {
  appendEntry?: (customType: string, data: ImprovementEntry) => void;
}

const TOOL_LABEL = "Skill improve";

const TOOL_DESCRIPTION = [
  "Diagnose a failure of this session and stage a lesson candidate for one installed skill.",
  "It never edits the skill and never accepts a candidate: the only writes are the package staging",
  "tree, the attempt index and the session entry, and acceptance belongs to the /skill-improve",
  "command.",
].join(" ");

export function createSkillImproveTool(
  deps: SkillImproveToolDeps,
): ToolDefinition<typeof skillImproveParams, ToolDetails> {
  return {
    name: SKILL_IMPROVE_TOOL_NAME,
    label: TOOL_LABEL,
    description: TOOL_DESCRIPTION,
    parameters: skillImproveParams,
    // Q7: the tool is part of the model's own toolset. It is not read-only as a whole -- propose
    // stages a candidate -- so no readOnlyHint is declared: the hint is per tool, and the two
    // actions do not share it.
    exposure: "direct",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // The context pi hands a tool satisfies ImproveFlowContext as it stands; the check is the
      // call itself, so a change in pi's context fails to compile here. The signal is the one pi
      // aborts when the call is cancelled, and it travels to the single model call of a propose (F7).
      return await runSkillImproveTool(params, ctx, deps, signal);
    },
  };
}

// The body of execute, exported so it can be exercised with a four-field fake instead of a whole
// ExtensionToolContext, the same way runSkillImprove is for the command. `signal` is the abort signal
// of the call, absent when the caller has nothing to abort with.
export async function runSkillImproveTool(
  params: SkillImproveParams,
  ctx: ImproveFlowContext,
  deps: SkillImproveToolDeps,
  signal: AbortSignal | undefined = undefined,
): Promise<AgentToolResult<ToolDetails>> {
  try {
    return params.action === "diagnose"
      ? await runDiagnose(params, ctx, deps)
      : await runPropose(params, ctx, deps, signal);
  } catch (error) {
    // The refusal this package raises and a bug both matter to the model, and neither may escape:
    // the reason and the skill travel in details, the sentence in content.
    const reason = toErrorMessage(error);
    return failure(params.action, params.skill, "error", reason, failedText(params.skill, reason));
  }
}

async function runDiagnose(
  params: SkillImproveParams,
  ctx: ImproveFlowContext,
  deps: SkillImproveToolDeps,
): Promise<AgentToolResult<ToolDetails>> {
  const action: SkillImproveAction = "diagnose";
  const result = await diagnoseSkill({ skillName: params.skill }, ctx, deps);

  if (result.kind === "unknown-skill") {
    return failure(
      action,
      params.skill,
      "unknown-skill",
      "unknown-skill",
      unknownSkillText(SURFACE, result.skillName, result.standalone, result.eligible),
    );
  }

  // Nothing to diagnose is an error and not an empty diagnosis: a summary of zero failures would
  // read like a diagnosis that found the skill healthy (rule 1 of P9).
  if (result.kind === "no-evidence") {
    return failure(
      action,
      result.skill.name,
      "no-evidence",
      "no-evidence",
      noEvidenceDiagnosisText(result.skill),
    );
  }

  // The three kinds above are the whole DiagnoseFlowResult, so what is left is the diagnosis.
  return {
    content: [
      {
        type: "text",
        text: diagnosedText(result.skill, result.eligibility, result.diagnosis),
      },
    ],
    // No usage: diagnose never called the model, and an absent field says so better than zero.
    details: { action, skill: result.skill.name, outcome: "diagnosed" },
  };
}

async function runPropose(
  params: SkillImproveParams,
  ctx: ImproveFlowContext,
  deps: SkillImproveToolDeps,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<ToolDetails>> {
  const action: SkillImproveAction = "propose";
  const result = await proposeSkill(
    {
      surface: SURFACE,
      skillName: params.skill,
      ...(params.focus === undefined ? {} : { focus: params.focus }),
      ...(signal === undefined ? {} : { signal }),
    },
    ctx,
    deps,
  );

  // The six outcomes of the flow, one case each: a variant added to ProposeFlowResult loses its case
  // here and stops compiling in the default, instead of falling through to the answer for a candidate.
  switch (result.kind) {
    case "unknown-skill":
      return failure(
        action,
        params.skill,
        "unknown-skill",
        "unknown-skill",
        unknownSkillText(SURFACE, result.skillName, result.standalone, result.eligible),
      );
    case "not-eligible": {
      const warning = recordEntry(deps, result.entry);
      return failure(
        action,
        result.skill.name,
        "not-eligible",
        result.reason,
        withWarning(notEligibleText(result.skill, result.reason), warning),
      );
    }
    case "no-evidence": {
      const warning = recordEntry(deps, result.entry);
      return failure(
        action,
        result.skill.name,
        "no-evidence",
        "no-evidence",
        withWarning(noEvidenceText(SURFACE, result.skill), warning),
      );
    }
    case "no-model":
      return failure(action, result.skill.name, "no-model", "no-model", noModelText(SURFACE));
    case "refused": {
      const warning = recordEntry(deps, result.entry);
      return failure(
        action,
        result.skill.name,
        "error",
        result.reason,
        withWarning(refusedText(result.skill, result.reason), warning),
      );
    }
    case "proposed": {
      // The candidate is the only outcome that reached the writer, so its case is the one that carries
      // the paths and the usage. F2: the outcome is the candidate's whatever the session entry did --
      // the entry is the /tree view of an attempt whose record is the staging candidate and its index
      // line -- so a failure to record it adds a sentence to the answer and leaves details untouched.
      const warning = recordEntry(deps, result.entry);
      return {
        content: [
          {
            type: "text",
            text: withWarning(
              proposedText(SURFACE, result.skill, result.draft.slug, result.staged.stagingPath, result.base),
              warning,
            ),
          },
        ],
        details: {
          action,
          skill: result.skill.name,
          outcome: "proposed",
          base: result.base,
          stagingPath: result.staged.stagingPath,
          decisionPath: result.staged.decisionPath,
          usage: result.usage,
        },
      };
    }
    default:
      return assertNever(result);
  }
}

// The session entry is the /tree view of the attempt, and a tool carries no warning channel of its own:
// the sentence this function answers with is added to the text of the result instead of replacing it. A
// run with no channel at all says nothing -- there is no channel to blame -- and a channel that throws
// names its reason, which is the one thing the caller can act on (F2).
function recordEntry(deps: SkillImproveToolDeps, entry: ImprovementEntry): string | null {
  const append = deps.appendEntry;
  if (append === undefined) return null;

  try {
    append(ENTRY_TYPE, entry);
    return null;
  } catch (error) {
    return `${ENTRY_TYPE}: the session entry was not recorded: ${toErrorMessage(error)}`;
  }
}

function withWarning(text: string, warning: string | null): string {
  return warning === null ? text : `${text}\n${warning}`;
}

function failure(
  action: SkillImproveAction,
  skill: string,
  outcome: SkillImproveOutcome,
  reason: string,
  text: string,
): AgentToolResult<ToolDetails> {
  return {
    content: [{ type: "text", text }],
    details: { action, skill, outcome, reason },
    isError: true,
  };
}

// The tool's own sentence: what a diagnosis found, which no other surface prints.
function diagnosedText(skill: SkillRef, eligibility: Eligibility, diagnosis: Diagnosis): string {
  return [
    `skill ${quote(skill.name)} is ${eligibilityText(eligibility)}.`,
    `diagnosis: ${diagnosis.summary}`,
    `failure signature: ${diagnosis.failureSignature}`,
    `replay items: ${diagnosis.replayItems.length}`,
    ...diagnosis.replayItems.map((item) => `  - ${item.predicate}`),
    "No candidate was proposed: diagnose reports what a replay would test and writes nothing.",
  ].join("\n");
}

function eligibilityText(eligibility: Eligibility): string {
  return eligibility.eligible ? "eligible" : `not eligible (${eligibility.reason})`;
}

function noEvidenceDiagnosisText(skill: SkillRef): string {
  return `skill ${quote(skill.name)}: this session shows no failure to diagnose, and nothing was written.`;
}

function failedText(skill: string, reason: string): string {
  return `${SKILL_IMPROVE_TOOL_NAME} could not finish for skill ${quote(skill)}: ${reason}`;
}
