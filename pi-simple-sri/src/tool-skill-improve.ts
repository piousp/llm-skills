import path from "node:path";
import { getAgentDir, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { describeExpectation } from "./diagnosis.ts";
import { modelIdentity } from "./evidence.ts";
import {
  gateDirectionalCandidate,
  type DirectionalGateResult,
  type DirectionalJudgeFn,
} from "./gate/directional-flow.ts";
import {
  gateStagedCandidate,
  type GateConcludedResult,
  type GateDeps,
  type GateFlowResult,
} from "./gate/flow.ts";
import type { GateVerdict, NoBaselineResult } from "./gate/types.ts";
import {
  ENTRY_TYPE,
  diagnoseSkill,
  listEligibleSkills,
  proposeSkill,
  type ImproveFlowContext,
  type ImproveFlowDeps,
  type ImprovementEntry,
} from "./improve-flow.ts";
import {
  gateAbstainedText,
  gatePassedText,
  gateRejectedText,
  noBaselineText,
  noEvidenceText,
  noModelGateText,
  noModelText,
  notEligibleText,
  proposedText,
  refusedText,
  unknownSkillText,
} from "./messages.ts";
import { createDirectionalJudge, createModelCall } from "./model-call.ts";
import { SKILL_IMPROVE_TOOL_NAME } from "./names.ts";
import type { GenerationUsage } from "./proposer.ts";
import { findSkill, listSkills } from "./skills-inventory.ts";
import { assertNever, type DecisionSurface, type Diagnosis, type Eligibility, type SkillRef } from "./types.ts";
import { quote, toErrorMessage } from "./values.ts";
import { writeBase } from "./write-base.ts";

// The skill_improve tool, the second surface of the loop (P9, Q7, M1). It answers three questions the
// model can ask mid-session:
//
//   diagnose  what failed in this session, and what would a replay have to test? Read-only.
//   propose   the same, plus one generation and the staging write.
//   gate      run the replay budget over a candidate already in staging, which spends tokens.
//
// diagnose and propose run the pipeline of src/improve-flow.ts, the same one /skill-improve runs, so the
// command and the tool cannot disagree about what is eligible, what counts as evidence or what the
// candidate looks like. gate runs src/gate/flow.ts, or src/gate/directional-flow.ts when the call names the bank that
// measures the candidate, which the command then carries into the acceptance.
// What differs is the answer: the command notifies, the tool returns a tool result, and the tool never
// accepts -- acceptance edits a skill and belongs to the command alone (Q12). That is why the action
// vocabulary has three values and no fourth: a candidate this action gates stays in staging, untouched,
// until whoever runs the command decides to accept it.
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
// Rule 6: details has the documented shape { action, skill, outcome, reason?, base?, stagingPath?,
// decisionPath?, usage?, verdict?, plannedRuns?, usedRuns?, gatePath?, bankPath?, defect?, judgeVerdict? } and nothing else. A
// caller that logs it never has to guess. The session entry is not part of that shape: when it cannot be recorded the answer
// says so in its text and details keeps the outcome of the work itself, because the entry is the /tree view of
// an attempt whose record is the candidate and its index line (F2).
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

// The name of the gate's own directory inside a candidate (src/gate/flow.ts keeps the raw stream of every run
// there). It is the one literal this module shares with that layout, and it is here because details hands a
// caller the path of those bytes instead of making it guess.
const GATE_DIR = "gate";

export type SkillImproveAction = "diagnose" | "propose" | "gate";

// The action names the three entry points of the surfaces, and the schema accepts nothing else: a tool call
// outside this union is refused by the runtime before execute() runs. There is no acceptance action (Q12).
export const skillImproveParams = Type.Object({
  action: Type.Union([Type.Literal("diagnose"), Type.Literal("propose"), Type.Literal("gate")], {
    description:
      "diagnose reports what failed and what the replay would test; propose stages a lesson candidate; gate runs the replay budget over a candidate already in staging, which spends tokens",
  }),
  skill: Type.String({ description: "Exact skill name, as listed by the inventory" }),
  focus: Type.Optional(Type.String({ description: "Optional hint about what to improve" })),
  // Typebox has no conditional without oneOf, so "gate needs a candidate" cannot live in the schema. It lives
  // in runGate as a typed refusal with stable details, and this description is the only warning the model gets
  // from the schema: the rule enforced, not merely documented, is the check before the first read.
  stagingPath: Type.Optional(
    Type.String({
      description:
        "Candidate directory inside staging/, as propose answered it (stagingPath, absolute or relative to the base): required by gate, ignored by the other actions",
    }),
  ),
  // M1c: the two fields of the bank base, with the same shape of rule as stagingPath -- the schema cannot say "defect needs
  // a bank", so runGate refuses that call before the first read and the description is the warning the model gets.
  bankPath: Type.Optional(
    Type.String({
      description:
        "Path of the case bank that measures the candidate: propose asks for a directional improvement and gate measures it with the cases the bank declares; ignored by diagnose",
    }),
  ),
  defect: Type.Optional(
    Type.Boolean({
      description:
        "The bank describes the defect an artifact shows instead of the cases to measure: needs bankPath, and a defect is measured by the paired replay of its cases; ignored by diagnose",
    }),
  ),
});

export type SkillImproveParams = Static<typeof skillImproveParams>;

// What became of the call, in a closed set. "diagnosed", "proposed" and "gate-accepted" are the successes;
// "not-eligible", "no-evidence", "unknown-skill" and "no-model" are the refusals a caller can predict and
// handle by name; "gate-rejected" and "gate-abstained" are the two verdicts that are answers and not failures
// of the run, and they report with isError because nothing was accepted; "no-baseline" is the gate of the bank
// base that found nothing to measure against (M1c, OA9) -- nothing was spent, the candidate stays in staging and
// the attempt is retryable, so it is a state of the attempt and not a verdict; "error" is everything else: a
// generation that refused to produce a lesson, a lesson that does not validate, a write the perimeter refused,
// a candidate the gate cannot read, or a bug.
export type SkillImproveOutcome =
  | "diagnosed"
  | "proposed"
  | "not-eligible"
  | "no-evidence"
  | "unknown-skill"
  | "no-model"
  | "gate-accepted"
  | "gate-rejected"
  | "gate-abstained"
  | "no-baseline"
  | "error";

// The documented shape of `details` (rule 6). `reason` is the vocabulary of the refusal for the predictable
// ones, the refusal message for "error", and the gate's own vocabulary on a gate -- the reason a rejection
// produced or the reason the gate abstained for. The two paths and the base are present exactly when a
// candidate was named. The paths are relative to that base, the way the records name them, so a consumer opens
// the candidate by joining the two fields instead of guessing a prefix.
//
// The four gate fields are present exactly on "gate-accepted", "gate-rejected" and "gate-abstained":
// `verdict` repeats the outcome in the vocabulary of decision.json so a consumer does not have to know this
// tool's outcome names, `plannedRuns` and `usedRuns` are the budget the gate preregistered and what it cost,
// and `gatePath` is the directory of the raw run streams inside the candidate (the same relative spelling as
// the two paths below).
//
// M1c adds three. `bankPath` and `defect` are the fields of the call of the bank base, present on the outcome of
// every call that named them and absent on the call of M1, which names neither. `judgeVerdict` is what the judge of
// that base answered about the whole set of cases, in the three words the record keeps (CaseGateEvaluation.judge):
// it is present on a gate of the bank base and absent on the other one, which has no judge, and it is read from the
// seam this surface wired -- a gate that never asked is `not-run`, which is what the record says too.
export interface ToolDetails {
  action: SkillImproveAction;
  skill: string;
  outcome: SkillImproveOutcome;
  reason?: string;
  base?: string;
  stagingPath?: string;
  decisionPath?: string;
  usage?: GenerationUsage;
  verdict?: GateVerdict;
  plannedRuns?: number;
  usedRuns?: number;
  gatePath?: string;
  bankPath?: string;
  defect?: boolean;
  judgeVerdict?: "pass" | "fail" | "not-run";
}

// The seams of the flow, the gate the third action runs, and the one channel a tool context does not carry:
// appendEntry lives on the extension API, so the wiring passes it in and a test replaces it. `gate` is a seam
// because the answer of a gate is what this module maps into details, and a test proves that mapping without
// spending a replay; `gateDeps` are the gate's own seams, passed through untouched. There is no acceptance
// seam: this surface has no path that writes a skill (Q12).
//
// `gateDirectional` is the second flow of M1c and is a second seam for the same reason: its answer is a different union
// (a base with no baseline is one of its outcomes), so a test that proves the dispatch cannot drive it through the seam of
// the other base. The judge it requires is built here from the session and is not a seam: the flow refuses to run without
// it, so a test that wants a verdict replaces the whole flow instead of the call inside it.
export interface SkillImproveToolDeps extends ImproveFlowDeps {
  appendEntry?: (customType: string, data: ImprovementEntry) => void;
  gate?: typeof gateStagedCandidate;
  gateDirectional?: typeof gateDirectionalCandidate;
  gateDeps?: GateDeps;
}

const TOOL_LABEL = "Skill improve";

const TOOL_DESCRIPTION = [
  "Diagnose a failure of this session, stage a lesson candidate for one installed skill, or gate a candidate",
  "that is already in staging. The candidate of a propose comes from the failures of the session, or from the cases a",
  "bankPath declares -- with defect when that bank describes a defect an artifact shows instead of the cases to",
  "measure --, and gate measures it with the cases of the same bank. gate spends the replay budget of the paired",
  "design it preregisters, and every run of that budget spends tokens; a bank that is absent or unreadable spends",
  "nothing, leaves the candidate in staging and leaves the attempt retryable. It never edits the skill and never",
  "accepts a candidate: the only writes are the package staging tree, the attempt index and the session entry, and",
  "acceptance belongs to the /skill-improve command.",
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
    // The three actions are the whole union, and the switch is total: a fourth one stops compiling here
    // instead of falling through to a handler that would run a different action.
    switch (params.action) {
      case "diagnose":
        return await runDiagnose(params, ctx, deps);
      case "propose":
        return await runPropose(params, ctx, deps, signal);
      case "gate":
        return await runGate(params, ctx, deps, signal);
      default:
        return assertNever(params.action);
    }
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
      // M1c: the bank makes the run a directional one, and a defect is the bank of the other profile. The flow reads the
      // bank of a defect before it spends a generation and refuses with `no-evidence` when it cannot; the bank of a
      // directional run is read by the gate, because a bank that is not there is a missing baseline and not a reason to
      // refuse the proposal (OA9).
      ...(params.bankPath === undefined ? {} : { bankPath: params.bankPath }),
      ...(params.defect === true ? { defect: true } : {}),
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
        // The reason travels with the sentence: the branch of the defect answers with this outcome when its bank or its
        // artifact cannot be read, and the sentence may not claim that the session showed no failure (M1c, S8).
        withWarning(noEvidenceText(SURFACE, result.skill, result.entry.reason), warning),
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
          ...bankFieldsOf(params),
        },
      };
    }
    default:
      return assertNever(result);
  }
}

// The gate over a candidate that is already in staging (M1). This action never stages and never accepts: it
// resolves the skill a replay would load, names the candidate by the stagingPath the call carries, and maps the
// verdict of src/gate/flow.ts into the documented answer. Nothing here writes: the gate's own writes are the
// record it rewrites inside the candidate and the line of the index, both under the base of the run, and the
// skill itself is only read -- the overlay copies it into staging.
//
// M1c adds one dispatch and no second write: a call that names the bank that measures the candidate is answered by
// src/gate/directional-flow.ts, and every other call -- including the one of a defect, whose bank the replay base measures
// (OA11) -- by the flow above. What the two answers have in common is the candidate, and that is why the mapping into details
// is one function.
async function runGate(
  params: SkillImproveParams,
  ctx: ImproveFlowContext,
  deps: SkillImproveToolDeps,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<ToolDetails>> {
  const action: SkillImproveAction = "gate";
  const stagingPath = params.stagingPath;

  // The two rules the schema cannot express, both refusals before the first read and with the same stable details as every
  // other error of this action. Amendment 3 of S10 is the first: gate with no candidate has nothing to measure. M1c adds the
  // second: a defect is a bank of the other profile, so a call that asks for one and names no bank names no material at all.
  if (stagingPath === undefined) {
    return failure(action, params.skill, "error", "missing-staging-path", missingStagingPathText(params.skill));
  }
  if (params.defect === true && params.bankPath === undefined) {
    return failure(action, params.skill, "error", "missing-bank-path", missingBankPathText(params.skill));
  }

  // The two halves the gate reads the candidate and the inventory from, resolved the way the flow resolves them:
  // the replay runs against the skills this session had (OA6), and the candidate sits under the base this package
  // writes to.
  const agentDir = deps.agentDir ?? getAgentDir();
  const base = deps.base ?? writeBase(agentDir);
  const skills = await (deps.listSkills ?? listSkills)({ cwd: ctx.cwd, agentDir });
  const skill = findSkill(skills, params.skill);
  if (skill === undefined) {
    // A name nobody knows, answered the way the other two actions answer it: the standalone the name may be, and
    // the eligible set the caller can ask for instead (F6). The second read of the inventory is the price of that
    // sentence, and it happens only on a refusal.
    const standalone = skills.find((entry) => entry.kind === "standalone" && entry.name === params.skill) ?? null;
    const eligible = await listEligibleSkills(ctx, deps);
    return failure(
      action,
      params.skill,
      "unknown-skill",
      "unknown-skill",
      unknownSkillText(SURFACE, params.skill, standalone, eligible),
    );
  }

  // The candidate, named the way both flows name it: the base it sits under, the skill the inventory resolved, the directory
  // of the candidate and the signal pi aborts the call with -- which reaches every run of the budget, so a cancelled call
  // stops between runs instead of spending the rest of them.
  const request = {
    base,
    agentDir,
    cwd: ctx.cwd,
    stagingPath,
    skill,
    ...(signal === undefined ? {} : { signal }),
  };

  // The one dispatch of the two bases (M1c): a call that names a bank and no defect is measured by the cases of that bank, and
  // every other call -- the failures of the session, and the defect an artifact shows, which the replay base measures (OA11) --
  // by the replayed turns of the diagnosis. The record of the candidate is what catches a surface that guessed wrong: each flow
  // refuses a record of the other base with `basis-mismatch`.
  const bankPath = params.defect === true ? undefined : params.bankPath;

  if (bankPath === undefined) {
    return answerOf(action, skill, base, params, {
      result: await (deps.gate ?? gateStagedCandidate)(request, deps.gateDeps),
    });
  }

  // The base of the bank spends the model twice -- one to replay the cases of the two arms, one to judge the answers of the
  // candidate (OA5) -- so a session without one cannot gate it at all. Said before the first read, which is the last moment at
  // which nothing has been spent.
  const model = ctx.model;
  const identity = model === undefined ? undefined : modelIdentity(model.provider, model.id);
  if (model === undefined || identity === undefined) {
    return failure(action, skill.name, "no-model", "no-model", noModelGateText(SURFACE, skill));
  }

  // What the judge answers during this call, watched at the seam this surface wires: the answer of the gate does not carry it,
  // and the record of the bank keeps it in the same three words (CaseGateEvaluation.judge).
  const judged: JudgeTally = { answer: "not-run" };
  const result = await (deps.gateDirectional ?? gateDirectionalCandidate)(
    { ...request, bankPath, model: identity },
    {
      ...deps.gateDeps,
      judge: watchingJudge(
        createDirectionalJudge(
          createModelCall({ registry: ctx.modelRegistry, model, sessionId: ctx.sessionManager.getSessionId() }),
        ),
        judged,
      ),
    },
  );

  return answerOf(action, skill, base, params, { result, judgeVerdict: judged.answer });
}

// The answer of a gate, with what the judge of the bank said when this call wired one. The two flows answer different unions --
// the base of the bank adds the candidate nobody could measure -- so the mapping into details is one function and not two.
interface GateAnswer {
  result: GateFlowResult | DirectionalGateResult;
  judgeVerdict?: "pass" | "fail" | "not-run";
}

// What the judge of the bank answered during one call, as the record of the gate names it. The surface is the only place that
// sees the judge it wired, so the seam is watched here instead of being re-derived from the reason of the verdict, which cannot
// tell a bank without a rubric from one whose judge agreed.
interface JudgeTally {
  answer: "pass" | "fail" | "not-run";
}

// A judge that records the answer it gave. A call that failed or a reply nobody could read is `not-run`, which is the word the
// record keeps for the second condition that did not speak.
function watchingJudge(judge: DirectionalJudgeFn, tally: JudgeTally): DirectionalJudgeFn {
  return async (request) => {
    const result = await judge(request);
    tally.answer = result.ok ? result.value.verdict : "not-run";
    return result;
  };
}

// The mapping of an answer into the documented result, for the two bases and every outcome of each.
function answerOf(
  action: SkillImproveAction,
  skill: SkillRef,
  base: string,
  params: SkillImproveParams,
  answer: GateAnswer,
): AgentToolResult<ToolDetails> {
  const { result, judgeVerdict } = answer;

  if (result.kind === "refused") {
    // The candidate cannot be gated at all -- it is not inside staging, it belongs to another skill, its record is unreadable or
    // from a version this package does not read, or it announces the other base -- and nothing was written, so the refusal and
    // the path in it are the whole answer.
    return failure(
      action,
      skill.name,
      "error",
      result.rejection.reason,
      failedText(skill.name, result.rejection.detail),
    );
  }

  if (result.kind === "no-baseline") {
    // The base of the bank with nothing to measure against (OA9): the gate never started, so this is an error of the call and
    // not a verdict -- `verdict` is absent because nothing concluded -- and the details are the keys every answer of this outcome
    // keeps, which is the reason of the reader and the two paths the retry is pointed at. No budget: the flow spent none, and the
    // zeros of the result say that better than two fields of a gate that never ran.
    return {
      content: [{ type: "text", text: verdictTextOf(skill, result) }],
      details: {
        action,
        skill: skill.name,
        outcome: "no-baseline",
        reason: result.reason,
        base,
        stagingPath: result.stagingPath,
        decisionPath: result.decisionPath,
        ...bankFieldsOf(params),
      },
      isError: true,
    };
  }

  // A concluded gate: one key set for the three verdicts, and only an acceptance is not an error of the call.
  return {
    content: [{ type: "text", text: verdictTextOf(skill, result) }],
    details: {
      action,
      skill: skill.name,
      outcome: result.kind,
      // The verdict of the gate in the vocabulary of decision.json: a consumer reads the status the record keeps
      // without having to know this tool's outcome names, and one value means the two fields cannot disagree.
      verdict: result.kind,
      ...(result.reason === null ? {} : { reason: result.reason }),
      base,
      stagingPath: result.stagingPath,
      decisionPath: result.decisionPath,
      gatePath: path.join(result.stagingPath, GATE_DIR),
      plannedRuns: result.plannedRuns,
      usedRuns: result.usedRuns,
      ...bankFieldsOf(params),
      ...(judgeVerdict === undefined ? {} : { judgeVerdict }),
    },
    ...(result.kind === "gate-accepted" ? {} : { isError: true }),
  };
}

// The two fields of a call of the bank base, on propose and on gate alike: the bank the call named and whether it described a
// defect. Absent when the call named neither, which is the shape of M1 and what keeps that answer byte for byte the one it was.
function bankFieldsOf(params: SkillImproveParams): { bankPath?: string; defect?: boolean } {
  return {
    ...(params.bankPath === undefined ? {} : { bankPath: params.bankPath }),
    ...(params.defect === true ? { defect: true } : {}),
  };
}

// The sentence of a gate, from the vocabulary of src/messages.ts: three verdicts and the answer of a base with no baseline, and
// no fifth, so a variant added to src/gate/types.ts stops compiling here.
function verdictTextOf(skill: SkillRef, result: GateConcludedResult | NoBaselineResult): string {
  switch (result.kind) {
    case "gate-accepted":
      return gatePassedText(SURFACE, skill, result.plannedRuns, result.usedRuns);
    case "gate-rejected":
      return gateRejectedText(SURFACE, skill, result.reason, result.usedRuns);
    case "gate-abstained":
      return gateAbstainedText(SURFACE, skill, result.reason, result.detail);
    case "no-baseline":
      return noBaselineText(SURFACE, skill, result.reason, result.stagingPath);
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
    ...diagnosis.replayItems.map((item) => `  - ${describeExpectation(item.expectation)}`),
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

// The tool's own sentence: what the call lacked, and that it cost nothing at all.
function missingStagingPathText(skill: string): string {
  return `${SKILL_IMPROVE_TOOL_NAME}: gate needs the stagingPath of the candidate for skill ${quote(skill)}, and the call carried none; nothing was read and no run was spent.`;
}

// The second rule the schema cannot express (M1c): the defect is what the bank describes, so the flag without the bank names no
// material and the call is refused before anything is read.
function missingBankPathText(skill: string): string {
  return `${SKILL_IMPROVE_TOOL_NAME}: a defect of skill ${quote(skill)} needs the bank that describes it, and the call carried defect with no bankPath; nothing was read and no run was spent.`;
}
