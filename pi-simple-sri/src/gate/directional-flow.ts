import fs from "node:fs";
import path from "node:path";
import { caseBankReason, readCaseBank, type CaseBankCase } from "../case-bank.ts";
import { sha256Digest } from "../hash.ts";
import { CASE_BANK_FILE, DECISION_FILE } from "../names.ts";
import { listSkills } from "../skills-inventory.ts";
import { outcomeStatusFor } from "../types.ts";
import type {
  CaseBankCaseRecord,
  DecisionRecord,
  GateCaseBankPreregistration,
  GateCaseBankResult,
  GateOverlays,
  GatePreregistration,
  GateTokens,
  JudgeCallRecord,
  JudgeRecord,
  Result,
} from "../types.ts";
import { currentTime, quote } from "../values.ts";
import { relativeToBase } from "../write-base.ts";
import { appendAttemptLine, rewriteStagingDecision, writeTextAtomically } from "../writer.ts";
import { spendBudget, tokenTallyOf, type PlannedItem } from "./budget.ts";
import {
  appendGateAnswerLine,
  preregisteredRecordOf,
  resolveStagedCandidate,
  verifiedStagedLesson,
  type CandidateRejectionReason,
  type GateConcludedResult,
  type GateConclusionReason,
  type GateDeps,
  type GateRefusedResult,
  type GateRequest,
} from "./flow.ts";
import type { JudgeError, JudgeRequest, JudgeVerdict } from "./judge.ts";
import { buildArmOverlays, gateOverlaysOf } from "./overlay.ts";
import { createReplayRunner } from "./replay-runner.ts";
import { evaluateCaseGate, evaluateGate, planCaseGate } from "./scorer.ts";
import type { CaseGateJudgeAnswer, GateVerdict, NoBaselineResult } from "./types.ts";

// The flow of the directional gate (M1c, S9): one staged candidate, a bank of cases the user wrote, the preregistration
// of the bank and of the rule before the first run, the paired budget of the replay base spent over the cases, the
// mechanical rule as a necessary condition and the preregistered judge as the second one, and the one line the index gains
// when the gate does not accept.
//
// It is a second flow and not a strategy of the first (§15, alternative 2). What it shares with gateStagedCandidate it
// imports: the resolution of the candidate, the guard of the candidate's bytes, the overlay of the two arms, the budget of
// the pair and the layout of the index line. What is its own is the material -- a bank instead of the turns of a
// diagnosis -- and the sequence that material needs, which is this list and no other:
//
//   1. resolve the candidate, and refuse one of another base (`basis-mismatch`) or one the gate already answered
//      (`already-concluded`). Both are refusals and not abstentions: nothing was spent, and nothing can be;
//   2. read the bank ONCE and parse those bytes. A bank that is not a baseline -- absent, unreadable, over its cap, not
//      JSON, not a bank of this version -- answers `no-baseline` with the stable text of the reader, writes the one line
//      of the index that names it and spends nothing;
//   3. re-verify the lesson on disk against the pair the record declares, exactly as the replay base does: a candidate
//      whose bytes moved is the one abstention that writes nothing at all;
//   4. plan the design, the rule and the floor over the cases (`planCaseGate`), the rule carrying the judge clause when the
//      bank declares a rubric;
//   5. copy the bank into the candidate, and read the copy back: the digest the preregistration pins has to be the digest of
//      a file that is actually there;
//   6. preregister -- the moment, the design, the rule, the floor and the materials of the bank -- BEFORE the first run, so
//      the bank and the rubric are pinned by bytes nobody could have chosen after seeing the result (OA4);
//   7. build the two arms with the overlay of M1, and add the hash of the SKILL.md they were copied from to the
//      preregistration, which is the field the acceptance reads;
//   8. spend the paired budget with the budget of M1, in the order case -> rep -> (incumbent, candidate). Every run is
//      judged by `evaluateExpectation` on the expectation of the fourth class, which is what closes the vacuous pass: a
//      turn that answered with no text is a `fail`, not a green `not-contains`;
//   9. evaluate: any invalid run abstains; a candidate under the rule is rejected; a perfect tie abstains on
//      `no-improvement`; and when the mechanics accepted and the rule announces the judge, one call per case of the
//      candidate arm. Every case accepted by the judge is an acceptance, one rejected is `judge-failed`, and a judge
//      nobody could read abstains with `judge-unavailable`, the partial result written and the cost of the call it could not
//      read counted all the same. The conjunction is the scorer's;
//   10. rewrite the record with the verdict, the tokens of the three components plus the judge, and the moment it decided;
//   11. write one line of the index -- `gate-rejected` or `gate-abstained`, never `gate-accepted` -- and never a byte inside
//       the skill.
//
// The two things this flow does differently from the replay base are deliberate (§8): there is no intrinsic-failure
// exclusion, because the cases are the ones the user wrote, and no skill inventory, because a bank has no session: the set
// a case runs with is its arm alone. The cwd of every run is the one of the invocation.
//
// The acceptance is not touched: `acceptCandidate` reads neither `gate.replay` nor `gate.caseBank` (§S9), and the hash it
// compares against the skill is the one both bases write in the preregistration.
//
// Nothing here resolves a seam at import time: the replay executor is resolved inside gateDirectionalCandidate, and a test
// drives the whole gate with a fake runReplay, a fake judge and no child and no provider at all.

// The repetition of the candidate the judge reads (OA6): one judgement per case, and the answer it judges is the one the
// record's own comparison is about. Repetition 1 exists whenever the mechanics accepted -- a missing one would have failed
// the rule already -- so the second condition costs at most one call per case and never reads a repetition nobody ran.
const JUDGED_REP = 1;

// The zero of a component that spent nothing, written once and frozen: a judge that was not asked did not cost nothing by
// accident, it cost zero because no call was made, and the record says so instead of leaving the component out (a clause
// without calls and a bank without a clause are two different records). The object is shared by every reading that spent
// nothing, so it is frozen: a caller that wrote into it would rewrite the zero of the ones already recorded.
const ZERO_TOKENS: GateTokens = Object.freeze({ input: 0, output: 0 });

// What one call to the judge produced, as this flow records it: the verdict, the reason for it and what the call cost.
//
// It is the judge of src/gate/judge.ts plus the cost, and the cost is the reason this contract exists here. `JudgeVerdict`
// answers what the reply said and nothing about the generation, because the module that reads a reply is not the module that
// pays for it; the record of this base keeps the tokens of every call (JudgeCallRecord.usage) and of the judge as a whole
// (OA10), so the seam this flow spends has to carry them. The wiring of the surface (S10) is the one that can add them: it
// builds the CompleteFn and sees the message.
export interface JudgeAnswer extends JudgeVerdict {
  usage: GateTokens;
}

// The second condition as a seam: a request in, one verdict with its cost or the abstention that says why it has none out.
// Every test of this flow hands a fake and no test reaches a provider, which is what makes the judge a condition the suite
// can drive.
//
// Why the second condition did not speak, with the two facts the flow cannot derive on its own. `detail` is the cause a
// failed call carries -- the message of the runtime, which only the module that made the call can see -- and `usage` is what
// that call cost, present whenever a call happened and absent when nobody made one (an aborted run spends nothing). The
// flow reads both: the cost of every call it paid for goes into `tokens.judge` (OA10), and the cause travels in the detail
// of the abstention, the way the judge's own sentence does when it rejects.
export interface JudgeFailure {
  error: JudgeError;
  detail?: string;
  usage?: GateTokens;
}

export type DirectionalJudgeFn = (request: JudgeRequest) => Promise<Result<JudgeAnswer, JudgeFailure>>;

// What the gate is pointed at: the candidate of the replay base (its base, its skill, its cwd and its abort signal) plus the
// two facts only this base has.
//
// `bankPath` is the file the user wrote, absolute or relative to the cwd of the invocation: it is read once, and the copy
// that travels with the candidate is what the preregistration pins. `model` is "provider/model" of the session (OA5): the
// model every run pins and the one the judge records -- the diagnosis of this base carries no replay item to read it from,
// because the cases are the items, so the invocation states it.
//
// `agentDir` is part of the request of the gate and is not read here: this base resolves no inventory, so the only skills a
// run loads are the arm itself.
export interface DirectionalGateRequest extends GateRequest {
  bankPath: string;
  model: string;
}

// The dependencies of the flow, with their production defaults resolved inside gateDirectionalCandidate.
//
// `judge` is the one without a default and the only required one: the judge is built from the model of the session and the
// registry (src/model-call.ts), which the surface owns (S10), so this flow refuses to run a gate that announces a second
// condition without the call that would answer it. A gate that cannot judge is an abstention, and requiring the seam is what
// stops a caller from finding out after twelve runs.
export type DirectionalGateDeps = GateDeps & { judge: DirectionalJudgeFn };

export type DirectionalGateSeams = Required<DirectionalGateDeps>;

// The union the surface switches on. It reuses `GateConcludedResult` as it stands -- the same verdict, the same two relative
// paths, the same budget and the same overlays -- so a caller consumes the two bases with one switch and the fields a caller
// reads do not depend on which base answered. `NoBaselineResult` is the third member because it is neither a refusal nor a
// conclusion: the gate never started, and its answer has to say so.
export type DirectionalGateResult = GateRefusedResult | GateConcludedResult | NoBaselineResult;

// The gate over a candidate that was proposed with a bank.
export async function gateDirectionalCandidate(
  request: DirectionalGateRequest,
  deps: DirectionalGateDeps,
): Promise<DirectionalGateResult> {
  const seams = directionalSeamsOf(deps);
  const candidateDir = path.resolve(request.base, request.stagingPath);
  const decisionPath = path.join(candidateDir, DECISION_FILE);

  // Step 1. The record, and the two guards of this base. A candidate of another base is not measured by a bank -- its record
  // says how it would decide, and that is not this way -- and a candidate the gate already answered is not gated twice: a
  // second verdict would overwrite one a reader may already have acted on.
  const resolved = await resolveStagedCandidate(request.base, request.skill.name, request.stagingPath);
  if (!resolved.ok) return { kind: "refused", rejection: resolved.error };
  const record = resolved.value;

  const basis = record.gate.basis;
  if (basis !== "case-bank") {
    return refused(
      "basis-mismatch",
      `${quote(relativeToBase(request.base, decisionPath))} announces a gate of the ${quote(basis)} base: a gate over a case bank reads a record of the case-bank base`,
    );
  }

  const status = record.gate.status;
  if (status !== "not-run") {
    return refused(
      "already-concluded",
      `${quote(relativeToBase(request.base, decisionPath))} is ${quote(status)}: a candidate is gated once, and the rule of a gate that already answered is not preregistered again`,
    );
  }

  // Step 2. The bank, read once. The bytes that were parsed come back with the data, so the digest the preregistration pins
  // is the digest of what was judged: a second read of the path could hand a different file, and no check afterwards would
  // know which of the two the runs were about.
  const loaded = await readCaseBank(request.bankPath, "baseline");
  if (!loaded.ok) {
    // OA9: a bank that is not a baseline leaves the candidate staged and the record in the state it was, and the attempt is
    // retryable. The line of the index says which problem stopped it, in the stable words of the reader.
    return await noBaseline({
      request,
      seams,
      record,
      candidateDir,
      reason: caseBankReason(loaded.error),
    });
  }
  const bank = loaded.value.bank;

  // Step 3. The bytes of the candidate, before anything is written, with the guard of the replay base: the lesson on disk is
  // the one the record declares, and the files of this base -- the copy of the bank, the runs, the record -- are written only
  // for a candidate whose own bytes still agree with it.
  const lesson = await verifiedStagedLesson(candidateDir, record);
  if (!lesson.ok) {
    return {
      kind: "gate-abstained",
      reason: "candidate-mismatch",
      stagingPath: relativeToBase(request.base, candidateDir),
      decisionPath: relativeToBase(request.base, decisionPath),
      plannedRuns: 0,
      usedRuns: 0,
      overlays: null,
      detail: lesson.error,
    };
  }
  const lessonText = lesson.value;

  // Step 4. The plan. The rubric is pinned by the digest of its text and never carried inline: it travels inside the copy of
  // the bank, next to the candidate, which is where a reader of the record finds it (OA4).
  const rubric = bank.rubric;
  const rubricHash = rubric === undefined ? null : sha256Digest(rubric);
  const plan = planCaseGate({
    cases: bank.cases,
    rubricHash,
    cwd: request.cwd,
    model: request.model,
    failureSignature: record.diagnosis.failureSignature,
  });
  if ("abstain" in plan) {
    // Unreachable through the reader, which refuses a bank of fewer than MIN_CASES cases. Kept total, and answered with the
    // same word the replay base answers a design it cannot compare: a bank of one case is a base that does not exist yet.
    return await noBaseline({
      request,
      seams,
      record,
      candidateDir,
      reason: `insufficient-items: the bank ${quote(path.resolve(request.bankPath))} holds ${bank.cases.length} cases, fewer than a paired design compares`,
    });
  }

  // Step 5. The copy that travels with the candidate, written before the preregistration that pins it and read back: the
  // digest of the record has to name a file that is there and that is those bytes.
  const copyPath = path.join(candidateDir, CASE_BANK_FILE);
  await seams.writeStream(copyPath, loaded.value.bytes.toString("utf8"), candidateDir);
  const copyDigest = sha256Digest(await fs.promises.readFile(copyPath));
  if (copyDigest !== loaded.value.contentHash) {
    return {
      kind: "gate-abstained",
      reason: "candidate-mismatch",
      stagingPath: relativeToBase(request.base, candidateDir),
      decisionPath: relativeToBase(request.base, decisionPath),
      plannedRuns: 0,
      usedRuns: 0,
      overlays: null,
      detail: `the copy ${quote(copyPath)} hashes to ${copyDigest}, not to the ${loaded.value.contentHash} of the bank that was read`,
    };
  }

  // Step 6. The preregistration, before the first run. The materials of the bank travel with it: the path the user keeps it
  // in, the digest of the bytes that were parsed, the copy inside the candidate, how many cases the bank holds and the digest
  // of the rubric when there is one.
  const caseBank: GateCaseBankPreregistration = {
    path: path.resolve(request.bankPath),
    contentHash: loaded.value.contentHash,
    copy: relativeToBase(request.base, copyPath),
    cases: bank.cases.length,
    rubricHash,
  };
  const preregistration: GatePreregistration = {
    recordedAt: seams.now().toISOString(),
    threshold: plan.threshold,
    design: plan.design,
    mde: plan.mde,
    caseBank,
  };
  await seams.rewriteDecision(
    request.base,
    candidateDir,
    preregisteredRecordOf(record, "case-bank", preregistration, plan.design.plannedRuns),
  );

  // Step 7. The two arms, from the skill as it stands and from the skill plus the candidate lesson: the overlay of the replay
  // base, unchanged, so the only thing the comparison can be about is the `## Lessons` section.
  const overlays = await seams.buildOverlays({
    base: request.base,
    stagingPath: candidateDir,
    skill: request.skill,
    slug: record.candidate.slug,
    title: record.candidate.title,
    lessonText,
  });
  if (!overlays.ok) {
    // The preregistration stays on disk: the rule and the materials were recorded and the gate ended without a result, which
    // is what a preregistered record means.
    return await answered({
      request,
      seams,
      record,
      candidateDir,
      verdict: "gate-abstained",
      reason: overlays.error.reason,
      plannedRuns: plan.design.plannedRuns,
      usedRuns: 0,
      overlays: null,
      detail: overlays.error.detail,
    });
  }

  // Step 7, second half, and the last moment before the first run: the hash of the SKILL.md the two arms were copied from is
  // recorded in the preregistration, which is the block both bases share and where the acceptance reads it.
  const measured: GatePreregistration = {
    ...preregistration,
    skillContentHash: overlays.value.skillContentHash,
  };
  await seams.rewriteDecision(
    request.base,
    candidateDir,
    preregisteredRecordOf(record, "case-bank", measured, plan.design.plannedRuns),
  );

  // Step 8. The budget of the replay base, over the cases instead of the turns: case (in the order of the file) -> rep ->
  // (incumbent, candidate), the same caps and the same persistence of the raw stream. The planned items travel without their
  // runs, exactly as they do there.
  const plannedItems: PlannedItem[] = plan.items.map((entry, index) => ({
    index,
    // A case names no failure of its own: it is a question about the behavior the ask is about, so every case of the bank
    // inherits the signature of the attempt.
    failureSignature: record.diagnosis.failureSignature,
    expectation: entry.item.expectation,
    model: request.model,
  }));

  // The answer of the candidate for every case, kept while the budget is spent. The record of a run has no final text -- the
  // schema of decision@1 declares none, and a text nobody judges would be a field nobody reads -- and the judge is asked
  // about exactly the text the checks already read, which is why the flow wraps the seam instead of the budget learning a
  // field.
  const answers = new Map<number, string>();
  const budgetSeams: DirectionalGateSeams = {
    ...seams,
    runReplay: async (runRequest) => {
      const run = await seams.runReplay(runRequest);
      if (runRequest.arm === "candidate" && runRequest.rep === JUDGED_REP) {
        answers.set(runRequest.item, run.finalText);
      }
      return run;
    },
  };

  const budget = await spendBudget({
    request,
    seams: budgetSeams,
    plan,
    selected: plan.items,
    models: plan.items.map(() => request.model),
    // OA6 of M1 is the set of skills the session of a turn had; a bank has no session. The arm is the whole set a case runs
    // with, which is also why this base reads no inventory.
    sharedDirs: plan.items.map((): string[] => []),
    items: plannedItems,
    candidateDir,
    arms: overlays.value,
  });

  // Step 9. The rule, and then the second condition. The mechanics are read first because the judge is never spent on a
  // comparison the rule already refused (OA6), and the conjunction of the two is the scorer's: an acceptance of the mechanics
  // that the judge does not accompany never leaves this step as an acceptance.
  const mechanical = evaluateGate(plan.design, plan.threshold, budget.runs);
  const judged: JudgeReading =
    mechanical.verdict === "gate-accepted" && plan.threshold.judge !== undefined
      ? await judgeCases({
          cases: plan.cases,
          answers,
          rubric,
          request,
          judge: seams.judge,
        })
      : { answer: "not-run", calls: [], tokens: ZERO_TOKENS };

  const evaluation = evaluateCaseGate(plan.design, plan.threshold, budget.runs, judged.answer);
  // An interruption is reported as itself, whatever the partial runs say (OA9 of M1): the scorer reads a short budget as an
  // unreadable one, and "the gate ran out of its twenty minutes" is the answer a person needs.
  const verdict: GateVerdict = budget.interruptedAt === null ? evaluation.verdict : "gate-abstained";
  const reason: GateConclusionReason | null = budget.interruptedAt === null ? evaluation.reason : "interrupted";
  // What the index and the answer add after the vocabulary word: the judge's own sentence when it rejected a case, the case
  // and the cause when it could not answer, and nothing when the record already says it (M4).
  const detail = budget.interruptedAt === null ? judged.detail : undefined;

  // Step 10. The record, with the preregistration it was judged by next to the result it produced.
  const completedAt = seams.now();
  const caseBankOverlays: GateOverlays = gateOverlaysOf(request.base, overlays.value);

  // One entry per case the design ran, with the checks its runs were judged by: copied from the bank so the record stands
  // alone, exactly as the expectation of a replay item is.
  const cases: CaseBankCaseRecord[] = plan.cases.map((entry, index) => ({
    index,
    id: entry.id,
    model: request.model,
    checks: entry.checks,
    reps: budget.items[index].reps,
  }));

  // The second condition as it answered, or null when the bank declared no rubric and the gate announced none: the `verdict`
  // of the block tells the judge that did not have to speak from the one that did, and a reader never guesses which happened.
  const judgeRecord: JudgeRecord | null =
    plan.threshold.judge === undefined
      ? null
      : {
          model: request.model,
          rubricHash,
          verdict: evaluation.judge,
          calls: judged.calls,
          tokens: judged.tokens,
        };

  const result: GateCaseBankResult = {
    completedAt: completedAt.toISOString(),
    verdict,
    reason,
    cases,
    arms: evaluation.arms,
    interval: evaluation.interval,
    regressions: evaluation.regressions,
    judge: judgeRecord,
    overlays: caseBankOverlays,
  };

  const concluded: DecisionRecord = {
    ...record,
    gate: {
      basis: "case-bank",
      status: verdict,
      budget: {
        plannedRuns: plan.design.plannedRuns,
        usedRuns: budget.usedRuns,
        interruptedAt: budget.interruptedAt,
      },
      tokens: tokenTallyOf(
        record.gate.tokens.proposal,
        evaluation.arms,
        judgeRecord === null ? undefined : judged.tokens,
      ),
      preregistration: measured,
      replay: null,
      caseBank: result,
    },
    outcome: { status: outcomeStatusFor(verdict), reason, decidedAt: completedAt.toISOString() },
  };

  // The record before the line: the index is an event about a candidate, so it never names a record that does not carry the
  // verdict yet.
  await seams.rewriteDecision(request.base, candidateDir, concluded);

  // Step 11. The one line of the index, and nothing inside the skill: `gate-accepted` is a state of decision.json, and the
  // line of an accepted candidate is the `accepted` event the acceptance writes when it edits the skill.
  return await answered({
    request,
    seams,
    record,
    candidateDir,
    verdict,
    reason,
    plannedRuns: plan.design.plannedRuns,
    usedRuns: budget.usedRuns,
    overlays: caseBankOverlays,
    ...(detail === undefined ? {} : { detail }),
  });
}

// What the judge answered, with what it cost and the one fact the index needs when it is why the gate did not accept.
interface JudgeReading {
  answer: CaseGateJudgeAnswer;
  calls: JudgeCallRecord[];
  tokens: GateTokens;
  detail?: string;
}

// The second condition: one call per case of the candidate arm, asked only when the mechanics accepted and the rule
// announced the judge (OA6).
//
// It stops at the first answer that decides the set. A FAIL is a rejection -- one case the judge rejected is a candidate the
// rule does not publish, and the other cases cannot un-reject it -- and a call that failed or a reply nobody could read is
// the abstention of the second condition. What was asked before the stop is kept, so the record of a partial answer is the
// answer a reader has, and a call nobody made is not invented.
async function judgeCases(input: {
  cases: readonly CaseBankCase[];
  answers: ReadonlyMap<number, string>;
  rubric: string | undefined;
  request: DirectionalGateRequest;
  judge: DirectionalJudgeFn;
}): Promise<JudgeReading> {
  const calls: JudgeCallRecord[] = [];
  let tokens: GateTokens = ZERO_TOKENS;

  // The rule announces a judge and the bank declares no rubric: unreachable through `planCaseGate`, which only writes the
  // clause when there is a digest to pin. Answered as the abstention it is instead of asking a judge about nothing.
  if (input.rubric === undefined) {
    return { answer: "unavailable", calls, tokens, detail: "the rule announces a judge and the bank declares no rubric" };
  }
  const rubric: string = input.rubric;

  for (const [index, entry] of input.cases.entries()) {
    // The mechanics accepted, so the candidate answered this case in every repetition -- and a case with no answer to judge
    // is a defect of this flow, not a reading: it abstains the gate instead of handing the judge an empty answer.
    const response = input.answers.get(index);
    if (response === undefined) {
      return {
        answer: "unavailable",
        calls,
        tokens,
        detail: `the answer of the candidate to the case ${quote(entry.id)} was not kept`,
      };
    }

    const asked = await input.judge({
      caseId: entry.id,
      prompt: entry.prompt,
      response,
      rubric,
      model: input.request.model,
      ...(input.request.signal === undefined ? {} : { signal: input.request.signal }),
    });
    if (!asked.ok) {
      // The call happened, so its cost belongs to the record even though the verdict does not exist: an abstention of the
      // second condition is not a free condition.
      return {
        answer: "unavailable",
        calls,
        tokens: tokensPlus(tokens, asked.error.usage),
        detail: judgeFailureDetail(entry.id, asked.error),
      };
    }

    calls.push({ caseId: entry.id, verdict: asked.value.verdict, reason: asked.value.reason, usage: asked.value.usage });
    tokens = tokensPlus(tokens, asked.value.usage);

    if (asked.value.verdict === "fail") {
      return {
        answer: "fail",
        calls,
        tokens,
        detail: asked.value.reason === "" ? entry.id : `${entry.id}: ${asked.value.reason}`,
      };
    }
  }

  return { answer: "pass", calls, tokens };
}

// What the judge could not answer, in the one sentence the line of the index and the answer keep: the case it was asked
// about, the word it answered, and -- when the seam could tell -- why the call failed.
function judgeFailureDetail(caseId: string, failure: JudgeFailure): string {
  const answered = `the judge of the case ${quote(caseId)} answered ${quote(failure.error)}`;
  return failure.detail === undefined ? answered : `${answered}: ${failure.detail}`;
}

// The sum of two costs, with the absent one as the identity: a call that never happened adds nothing, and the component of a
// judge that only answered some of its cases is the sum of the ones it did.
function tokensPlus(tokens: GateTokens, extra: GateTokens | undefined): GateTokens {
  return extra === undefined ? tokens : { input: tokens.input + extra.input, output: tokens.output + extra.output };
}

// The seams with their production default, resolved once per call. `runReplay` opens a runner that starts nothing until a run
// is asked for, and `judge` arrives from the caller because this flow has no way to build a model call: the registry, the
// model and the session of the run are the surface's (S10).
//
// `listSkills` has no default of its own here because the budget of the pair takes the seams of the gate whole; this base
// resolves no inventory, so the default is never called and the field is what makes the two seam sets one type.
function directionalSeamsOf(deps: DirectionalGateDeps): DirectionalGateSeams {
  return {
    now: deps.now ?? currentTime,
    runReplay: deps.runReplay ?? createReplayRunner(),
    buildOverlays: deps.buildOverlays ?? buildArmOverlays,
    rewriteDecision: deps.rewriteDecision ?? rewriteStagingDecision,
    appendAttempt: deps.appendAttempt ?? appendAttemptLine,
    writeStream: deps.writeStream ?? writeTextAtomically,
    listSkills: deps.listSkills ?? listSkills,
    judge: deps.judge,
  };
}

// The answer of a gate that found no baseline: the line of the index that names it -- `no-baseline`, with the hashes of the
// candidate so it groups with the `proposed` line of the same attempt -- and the result that says the gate never started.
//
// The record is not touched. It said `not-run`/`proposed` before this answer and it says so after, which is the truth of an
// attempt that can be retried (OA1, Q23): there is no verdict to write, and a state invented for it would make the retry a
// decision about a gate that concluded.
async function noBaseline(input: {
  request: DirectionalGateRequest;
  seams: DirectionalGateSeams;
  record: DecisionRecord;
  candidateDir: string;
  reason: string;
}): Promise<NoBaselineResult> {
  const paths = await appendGateAnswerLine({
    seams: input.seams,
    base: input.request.base,
    skillName: input.request.skill.name,
    candidateDir: input.candidateDir,
    record: input.record,
    answer: "no-baseline",
    reason: input.reason,
  });

  return {
    kind: "no-baseline",
    reason: input.reason,
    stagingPath: paths.stagingPath,
    decisionPath: paths.decisionPath,
    plannedRuns: 0,
    usedRuns: 0,
    overlays: null,
  };
}

// The reading of the gate and the one line of the index it gains, in the same words the replay base uses: the answer, the
// paths, the budget and the overlays of one concluded gate. The line itself is written by the one writer of both bases.
interface AnswerInput {
  request: DirectionalGateRequest;
  seams: DirectionalGateSeams;
  record: DecisionRecord;
  candidateDir: string;
  verdict: GateVerdict;
  reason: GateConclusionReason | null;
  plannedRuns: number;
  usedRuns: number;
  overlays: GateOverlays | null;
  detail?: string;
}

async function answered(input: AnswerInput): Promise<GateConcludedResult> {
  const paths = await appendGateAnswerLine({
    seams: input.seams,
    base: input.request.base,
    skillName: input.request.skill.name,
    candidateDir: input.candidateDir,
    record: input.record,
    answer: input.verdict,
    reason: input.reason,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  });

  return {
    kind: input.verdict,
    reason: input.reason,
    stagingPath: paths.stagingPath,
    decisionPath: paths.decisionPath,
    plannedRuns: input.plannedRuns,
    usedRuns: input.usedRuns,
    overlays: input.overlays,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  };
}

function refused(reason: CandidateRejectionReason, detail: string): GateRefusedResult {
  return { kind: "refused", rejection: { reason, detail } };
}
