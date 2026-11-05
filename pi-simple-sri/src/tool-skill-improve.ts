import path from "node:path";
import { getAgentDir, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { caseBankReason, loadCaseBank, type CaseBankProfile } from "./case-bank.ts";
import { describeExpectation } from "./diagnosis.ts";
import { gateDirectionalCandidate, type DirectionalGateResult } from "./gate/directional-flow.ts";
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
import { wireDirectionalGate } from "./model-call.ts";
import { SKILL_IMPROVE_TOOL_NAME } from "./names.ts";
import type { GenerationUsage } from "./proposer.ts";
import { findSkill, listSkills } from "./skills-inventory.ts";
import { assertNever, type DecisionSurface, type Diagnosis, type Eligibility, type SkillRef } from "./types.ts";
import { quote, toErrorMessage } from "./values.ts";
import { writeBase } from "./write-base.ts";

// The skill_improve tool, the second surface of the loop (P9, Q7, M1). It answers four questions the
// model can ask mid-session:
//
//   diagnose  what failed in this session, and what would a replay have to test? Read-only.
//   propose   the same, plus one generation and the staging write.
//   gate      run the replay budget over a candidate already in staging, which spends tokens.
//   validate  read the case bank a bankPath names and report the first violation, or that it is valid. Read-only.
//
// diagnose and propose run the pipeline of src/improve-flow.ts, the same one /skill-improve runs, so the
// command and the tool cannot disagree about what is eligible, what counts as evidence or what the
// candidate looks like. gate runs src/gate/flow.ts, or src/gate/directional-flow.ts when the call names the bank that
// measures the candidate, which the command then carries into the acceptance.
// What differs is the answer: the command notifies, the tool returns a tool result, and the tool never
// accepts -- acceptance edits a skill and belongs to the command alone (Q12). That is why the action
// vocabulary has four values and no acceptance among them: a candidate this action gates stays in staging,
// untouched, until whoever runs the command decides to accept it, and the fourth action writes nothing at all.
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

export type SkillImproveAction = "diagnose" | "propose" | "gate" | "validate";

// The action names the four entry points of the surfaces, and the schema accepts nothing else: a tool call
// outside this union is refused by the runtime before execute() runs. None of the four accepts a candidate:
// acceptance edits a skill and belongs to the command alone (Q12).
export const skillImproveParams = Type.Object({
  action: Type.Union(
    [Type.Literal("diagnose"), Type.Literal("propose"), Type.Literal("gate"), Type.Literal("validate")],
    {
      description:
        "diagnose reports what failed and what the replay would test; propose stages a lesson candidate; gate runs the replay budget over a candidate already in staging, which spends tokens: a budget needs at least two distinct items, and below that the answer is insufficient-items; validate reads the case bank that bankPath names and reports its first violation or that the bank is valid, and it writes nothing and spends nothing",
    },
  ),
  skill: Type.String({ description: "Exact skill name, as listed by the inventory" }),
  focus: Type.Optional(Type.String({ description: "Optional hint about what to improve" })),
  // Typebox has no conditional without oneOf, so "gate needs a candidate" cannot live in the schema. It lives
  // in runGate as a typed refusal with stable details, and this description is the only warning the model gets
  // from the schema: the rule enforced, not merely documented, is the check before the first read.
  stagingPath: Type.Optional(
    Type.String({
      description:
        "Candidate directory inside staging/, as propose answered it (stagingPath, absolute or relative to the base): required by gate, ignored by the other three actions",
    }),
  ),
  // M1c: the two fields of the bank base, with the same shape of rule as stagingPath -- the schema cannot say "defect needs
  // a bank", so runGate refuses that call before the first read and the description is the warning the model gets.
  bankPath: Type.Optional(
    Type.String({
      description:
        "Path of the case bank that measures the candidate: propose asks for a directional improvement, gate measures the candidate with the cases the bank declares and validate reads it without a candidate; ignored by diagnose",
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

// What became of the call, in a closed set. "diagnosed", "proposed", "gate-accepted" and "bank-valid" are the
// successes; "not-eligible", "no-evidence", "unknown-skill", "no-model" and "bank-refused" are the refusals a
// caller can predict and handle by name; "gate-rejected" and "gate-abstained" are the two verdicts that are answers
// and not failures of the run, and they report with isError because nothing was accepted; "no-baseline" is the gate
// of the bank base that found nothing to measure against (M1c, OA9) -- nothing was spent, the candidate stays in
// staging and the attempt is retryable, so it is a state of the attempt and not a verdict. M2c adds the two of the
// fourth action: "bank-valid" is a bank the reader accepted under the profile the call declared, and "bank-refused" is
// the bank it could not read, with the reason of the reader in details. "error" is everything else: a generation that
// refused to produce a lesson, a lesson that does not validate, a write the perimeter refused, a candidate the gate
// cannot read, or a bug.
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
  | "bank-valid"
  | "bank-refused"
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
// it is present on a gate of the bank base and absent on the other one, which has no judge, and the flow of that base
// carries it in its answer -- a gate that never asked is `not-run`, which is what the record says too.
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
// the other base. The judge it requires is not a seam: the one wiring of src/model-call.ts builds it from the session, and a
// test that wants a verdict replaces the whole flow instead of the call inside it.
export interface SkillImproveToolDeps extends ImproveFlowDeps {
  appendEntry?: (customType: string, data: ImprovementEntry) => void;
  gate?: typeof gateStagedCandidate;
  gateDirectional?: typeof gateDirectionalCandidate;
  gateDeps?: GateDeps;
}

const TOOL_LABEL = "Skill improve";

const TOOL_DESCRIPTION = [
  "Diagnose a failure of this session, stage a lesson candidate for one installed skill, gate a candidate already in",
  "staging, or read the case bank a bankPath names. A propose takes its cases from the failures of the session or from the",
  "bank, with defect when that bank describes a defect an artifact shows, and gate measures the candidate with the cases of",
  "that bank. gate spends the replay budget it preregisters and every run of it spends tokens; a bank that is absent or",
  "unreadable spends nothing and leaves the attempt retryable. validate reads that one file and answers its first",
  "violation, in the words gate uses, or that the bank is valid, without writing or spending. Before any of that is spent,",
  "the tool also records a correction or a rejection: a correction the user made in this session, which propose reads, and",
  "a draft the user rejected, which is a case of a bank of a defect. It never edits the skill and never accepts a candidate:",
  "the only writes are the package staging tree, the attempt index and the session entry, and acceptance belongs to the",
  "/skill-improve command.",
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

// The bank a call names, resolved against the cwd of the session and not against the cwd of the process. The reader of
// src/case-bank.ts stats the path as it arrives, which resolves it against process.cwd(), while the path a call carries is
// the one a user typed in the directory the session runs in -- the one directory this package already resolves the
// artifact of a defect against (src/improve-flow.ts). Resolved here, before the dispatch, so the three actions that name a
// bank have one answer and details reports the path that was read. A call that names no bank is returned as it arrived.
function withResolvedBankPath(params: SkillImproveParams, cwd: string): SkillImproveParams {
  return params.bankPath === undefined ? params : { ...params, bankPath: path.resolve(cwd, params.bankPath) };
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
    // The bank of the call is resolved once, here, for the three actions that name one: the reader of
    // src/case-bank.ts stats the path it is given and resolves it against process.cwd(), and the path a call
    // carries is the one a user typed in the directory the session runs in. Everything below -- the flow, the
    // gate and details -- reads the resolved path, so what is read and what is reported are the same file.
    const resolved = withResolvedBankPath(params, ctx.cwd);

    // The four actions are the whole union, and the switch is total: a fifth one stops compiling here
    // instead of falling through to a handler that would run a different action.
    switch (resolved.action) {
      case "diagnose":
        return await runDiagnose(resolved, ctx, deps);
      case "propose":
        return await runPropose(resolved, ctx, deps, signal);
      case "gate":
        return await runGate(resolved, ctx, deps, signal);
      case "validate":
        return await runValidate(resolved);
      default:
        return assertNever(resolved.action);
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
    return failure(
      action,
      params.skill,
      "error",
      "missing-staging-path",
      missingStagingPathText(params.skill),
      bankFieldsOf(params),
    );
  }
  if (params.defect === true && params.bankPath === undefined) {
    return failure(
      action,
      params.skill,
      "error",
      "missing-bank-path",
      missingBankPathText(params.skill),
      bankFieldsOf(params),
    );
  }

  // The two halves the gate reads the candidate and the inventory from, resolved the way the flow resolves them:
  // the replay runs against the skills this session had (OA6), and the candidate sits under the base this package
  // writes to.
  const agentDir = deps.agentDir ?? getAgentDir();
  const base = deps.base ?? writeBase(agentDir);
  const skills = await (deps.listSkills ?? listSkills)({ cwd: ctx.cwd, agentDir });
  const skill = findSkill(skills, params.skill);
  if (skill === undefined) {
    // A name nobody knows, answered the way diagnose and propose answer it: the standalone the name may be, and the
    // eligible set the caller can ask for instead (F6). Those two read the inventory and answer from it; validate does
    // not answer this at all, because it reads no inventory -- the bank a call names is the only file it touches. The
    // second read here is the price of the sentence, and it happens only on a refusal.
    const standalone = skills.find((entry) => entry.kind === "standalone" && entry.name === params.skill) ?? null;
    const eligible = await listEligibleSkills(ctx, deps);
    return failure(
      action,
      params.skill,
      "unknown-skill",
      "unknown-skill",
      unknownSkillText(SURFACE, params.skill, standalone, eligible),
      bankFieldsOf(params),
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
  //
  // The name says what the value decides and not what it is copied from: it is the bank that measures the candidate, and a
  // defect names a bank without being measured by it. It is the same answer measuredByBankOf gives the command.
  const measuringBankPath = params.defect === true ? undefined : params.bankPath;

  if (measuringBankPath === undefined) {
    return answerOf(action, skill, base, params, await (deps.gate ?? gateStagedCandidate)(request, deps.gateDeps));
  }

  // The base of the bank spends the model twice -- one to replay the cases of the two arms, one to judge the answers of the
  // candidate (OA5) -- so a session without one cannot gate it at all. The wiring is the one of src/model-call.ts, shared with
  // the command: it answers the request and the seams of this flow, or the refusal of a session with no model, which is said
  // before the first read and is therefore the last moment at which nothing has been spent.
  const wired = wireDirectionalGate({
    context: ctx,
    sessionId: ctx.sessionManager.getSessionId(),
    request,
    bankPath: measuringBankPath,
    ...(deps.gateDeps === undefined ? {} : { gateDeps: deps.gateDeps }),
  });
  if (!wired.ok) {
    return failure(action, skill.name, "no-model", "no-model", noModelGateText(SURFACE, skill), bankFieldsOf(params));
  }

  return answerOf(
    action,
    skill,
    base,
    params,
    await (deps.gateDirectional ?? gateDirectionalCandidate)(wired.value.request, wired.value.deps),
  );
}

// The mapping of an answer into the documented result, for the two bases and every outcome of each. What the judge of the bank
// said travels in the answer of that base and not through a seam watched here: the flow concludes with the reading the record
// keeps, so the words of details and the words of decision.json cannot disagree.
function answerOf(
  action: SkillImproveAction,
  skill: SkillRef,
  base: string,
  params: SkillImproveParams,
  result: GateFlowResult | DirectionalGateResult,
): AgentToolResult<ToolDetails> {
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
      bankFieldsOf(params),
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
      ...(result.judgeVerdict === undefined ? {} : { judgeVerdict: result.judgeVerdict }),
    },
    ...(result.kind === "gate-accepted" ? {} : { isError: true }),
  };
}

// The two fields of a call of the bank base, on the three actions that name one -- propose, gate and validate: the bank the
// call named, already resolved against the cwd of the session, and whether it described a defect. Absent when the call named
// neither, which is the shape of M1 and what keeps that answer byte for byte the one it was.
function bankFieldsOf(params: SkillImproveParams): { bankPath?: string; defect?: boolean } {
  return {
    ...(params.bankPath === undefined ? {} : { bankPath: params.bankPath }),
    ...(params.defect === true ? { defect: true } : {}),
  };
}

// The fourth action (M2c, S1): the reader of src/case-bank.ts exposed on its own, so a model can learn what a bank is missing
// before a proposal is spent. The bank of the directional base is the one the gate reads and the proposal does not
// (src/improve-flow.ts), so a typo in it used to be the one bank error that cost a generation to find.
//
// It writes nothing, calls no model and reads no inventory: the only thing it touches is the file the call names, under the
// profile the defect flag already means -- `origin` for a defect, `baseline` for the cases to measure. There is no seam for
// the reader, and there is no reason for one: what it calls is a read of a file, a test points it at a temporary directory,
// and a seam here would exist to avoid the disk and not to replace the world.
async function runValidate(params: SkillImproveParams): Promise<AgentToolResult<ToolDetails>> {
  const action: SkillImproveAction = "validate";
  const bankPath = params.bankPath;

  // The third rule the schema cannot express: this action has nothing to read without a bank, and the refusal comes before the
  // first read. The token is the one runGate uses for a defect with no bank, because it is the same missing argument; the
  // sentence is its own, because the one of the gate speaks of a defect.
  if (bankPath === undefined) {
    return failure(action, params.skill, "error", "missing-bank-path", validateNeedsBankText(params.skill));
  }

  const profile: CaseBankProfile = params.defect === true ? "origin" : "baseline";
  const loaded = await loadCaseBank(bankPath, profile);

  // The reader is the only judge of a bank, and the reason it answers is the vocabulary the gate publishes on `no-baseline`:
  // whoever reads this refusal reads the words the failure would use later. The reader is fail-fast, so the reason names the
  // first violation and no list of them is assembled here.
  //
  // The refusal carries the two fields of the call, the way the `no-baseline` of the gate does, so a caller that logged the
  // answer keeps the path that was read. Its sentence names the file as well: most of these reasons -- `bank-invalid`,
  // `bank-not-json`, `bank-too-large` -- say what is wrong with the content and not which file holds it.
  if (!loaded.ok) {
    const reason = caseBankReason(loaded.error);
    return {
      content: [{ type: "text", text: bankRefusedText(params.skill, bankPath, reason) }],
      details: {
        action,
        skill: params.skill,
        outcome: "bank-refused",
        reason,
        ...bankFieldsOf(params),
      },
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: bankValidText(bankPath, profile, loaded.value.cases.length) }],
    details: {
      action,
      skill: params.skill,
      outcome: "bank-valid",
      ...bankFieldsOf(params),
    },
  };
}

// The sentence of a gate, from the vocabulary of src/messages.ts: three verdicts and the answer of a base with no baseline, and
// no fifth, so a variant added to src/gate/types.ts stops compiling here.
function verdictTextOf(skill: SkillRef, result: GateConcludedResult | NoBaselineResult): string {
  switch (result.kind) {
    case "gate-accepted":
      return gatePassedText(SURFACE, skill, result.plannedRuns, result.usedRuns);
    case "gate-rejected":
      // A rejection the judge produced names the case and its sentence, which the flow carries in the detail of the result
      // (M4): the reason alone is the word of the vocabulary and nothing a user could act on.
      return gateRejectedText(SURFACE, skill, result.reason, result.usedRuns, result.detail);
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
  // The fields of the call that named a bank, on the refusals that stop before a bank is read: the documented shape says
  // they are present on every answer whose call named them, and a caller that logs the refusal needs to know which call.
  extra: ReturnType<typeof bankFieldsOf> = {},
): AgentToolResult<ToolDetails> {
  return {
    content: [{ type: "text", text }],
    details: { action, skill, outcome, reason, ...extra },
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

// The sentence of the missing bank on the fourth action: the same missing argument gate refuses, said without the word defect.
function validateNeedsBankText(skill: string): string {
  return `${SKILL_IMPROVE_TOOL_NAME}: validate needs the bankPath of the case bank to read for skill ${quote(skill)}, and the call carried none; nothing was read and no run was spent.`;
}

// The refusal of the fourth action: the reason of the reader travels as the reader wrote it, prefix included, because that is
// the same text the gate publishes when the bank of a candidate cannot be read. The file is named next to it, the way the
// sentence of the success names it: most of those reasons say what is wrong with the content, and the path is what the call
// knows and what a reader needs to fix the bank.
function bankRefusedText(skill: string, file: string, reason: string): string {
  return `${SKILL_IMPROVE_TOOL_NAME}: the case bank at ${quote(file)} for skill ${quote(skill)} cannot be used: ${reason}; nothing was written and no run was spent.`;
}

// The success of the fourth action: the file, the profile the call declared and the count, which is what a model needs to know
// that the bank it wrote is the bank it meant. One file was read and nothing else happened.
function bankValidText(file: string, profile: CaseBankProfile, cases: number): string {
  return `${SKILL_IMPROVE_TOOL_NAME}: the case bank at ${quote(file)} is valid for the ${quote(profile)} profile and declares ${casesText(cases)}; only that file was read and no run was spent.`;
}

function casesText(cases: number): string {
  return cases === 1 ? "1 case" : `${cases} cases`;
}
