import fs from "node:fs";
import path from "node:path";
import { buildAttemptLine, type AttemptEvent } from "../attempts.ts";
import { signatureOf } from "../diagnosis.ts";
import { sha256Digest } from "../hash.ts";
import { DECISION_FILE, LESSONS_DIR } from "../names.ts";
import { assertWritable, isInsideOrEqual } from "../perimeter.ts";
import { findSkill, listSkills, type ListSkillsOptions } from "../skills-inventory.ts";
import { assertNever, outcomeStatusFor } from "../types.ts";
import type {
  DecisionRecord,
  DecisionSchema,
  GateBasis,
  GateBudget,
  GateCaseBankNotRun,
  GateCaseBankPreregistered,
  GateNotRun,
  GateOverlays,
  GatePreregistered,
  GatePreregistration,
  GateReplayResult,
  GateTokenTally,
  ReplayItem,
  Result,
  SkillRef,
} from "../types.ts";
import { currentTime, describe, isDirectory, isPlainObject, isRegularFile, quote, toErrorMessage } from "../values.ts";
import { relativeToBase, stagingDir } from "../write-base.ts";
import { appendAttemptLine, lessonHashes, rewriteStagingDecision, writeTextAtomically } from "../writer.ts";
import { spendBudget, tokenTallyOf, type PlannedItem } from "./budget.ts";
import { buildArmOverlays, gateOverlaysOf, type OverlayRequest, type OverlayResult } from "./overlay.ts";
import { createReplayRunner } from "./replay-runner.ts";
import { evaluateGate, planGate } from "./scorer.ts";
import type {
  GateAbstentionReason,
  GatePlanItem,
  GateVerdict,
  GateVerdictReason,
  ReplayRunFn,
} from "./types.ts";

// The flow of the gate (M1, S8): one staged candidate, the rule preregistered before the first run, the
// paired budget spent over the two arms, the verdict of that budget, the record rewritten with it, and the
// one line the index gains when the gate answers.
//
// The order is the contract, and each step exists to stop the next one:
//
//   1. resolveStagedCandidate names the record of the candidate, and refuses one this version cannot read; the two guards
//      of the base refuse, in the same breath, a record of the case-bank base (`basis-mismatch`) and one a gate already
//      answered (`already-concluded`), before anything is written or run;
//   2. the lesson on disk is hashed against the pair the record declares, so a candidate whose bytes moved
//      since it was staged abstains before a byte is written into it;
//   3. the plan -- the design, the rule and the floor of the design -- is computed from the diagnosis and
//      written into the record as the preregistration BEFORE the first run. A threshold recorded after the
//      runs would be a threshold chosen with the result in hand, and the timestamp of the preregistration is
//      what makes "recorded before the runs" checkable from the record alone;
//   4. the two arms are built in staging, so a replay reads a copy of the skill and never the skill. The hash of the
//      SKILL.md they were copied from is the one the acceptance compares against the skill, so it joins the
//      preregistration here -- still before the first run -- in the field that is neutral to the basis;
//   5. the budget is spent in the order item -> rep -> (incumbent, candidate), with the two arms of a pair
//      adjacent in time, and the raw JSONL of every run is kept under the candidate as its audit trail;
//   6. the verdict is the preregistered rule applied to the verdicts -- never a rule read off the numbers --
//      and the record is rewritten with it, so one file stays authoritative;
//   7. the index gains exactly one line, `gate-rejected` or `gate-abstained`, carrying the failure signature
//      of the diagnosis (OA4).
//
// A gate that passes writes no line of the index and no byte outside the candidate: `gate-accepted` is a
// state of decision.json, and the line of an accepted candidate is the `accepted` event the acceptance
// writes when it edits the skill. That is why `gate-accepted` is not in the event vocabulary at all.
//
// M1c adds the two refusals of the base and one guard, and no branch. Right after step 1 the record says which base would
// measure it and whether a gate already answered: a record of the `case-bank` base is refused with `basis-mismatch` -- its
// items are the cases of a bank and this flow would plan over a `diagnosis.replayItems` that does not carry them -- and one
// whose status is not `not-run` with `already-concluded`, because a verdict a reader may already have acted on is not
// rewritten. Then, before step 3 plans anything, the artifact of every evidence item that names one is re-read and hashed
// against the digest the evidence recorded, and bytes that no longer match abstain with `origin-moved`. The items, the plan,
// the budget, the verdict and the line are the ones of M1, unchanged -- the branch of the defect changes where the items come
// from and what judges them, and nothing about how the gate spends.
//
// It is here and not in the surface (src/tool-skill-improve.ts, src/command-skill-improve.ts) because both
// surfaces run it and a candidate this module gates is one the whole package then trusts: one
// implementation, one set of guards, and no second reading of a decision.json.
//
// Two pieces of this sequence are exported because the second base of M1c is a second flow and not a copy of this one:
// `verifiedStagedLesson` is the guard of the candidate's bytes, which both bases run before they write anything, and
// `appendGateAnswerLine` is the one writer of the line the index gains, which both bases write. What each base decides is
// its own; how a candidate is verified and how the index hears about it is the gate's, and it lives in one place.
//
// Nothing here resolves a seam at import time, and nothing it does starts a process the caller did not
// allow: the replay executor is resolved inside gateStagedCandidate, and a test drives the whole gate with a
// fake runReplay and no child at all.

// The one schema this package writes, and the only one its gate reads (OA12). A candidate staged by another
// version is refused instead of being rewritten: a decision@0 record carries `predicate` where this version
// has `expectation`, so a gate that opened it would either write a record that is half of each version or
// fail halfway through its own sequence. The type of the constant is DecisionSchema, so a @2 in src/types.ts
// breaks this comparison at compile time instead of leaving a guard that silently never fires.
const DECISION_SCHEMA: DecisionSchema = "pi-simple-sri/decision@1";

// Why a staged candidate cannot be gated. Each reason names a different answer for the caller, and none of
// them is an error the run should crash on: `detail` carries the refusal with the path in it, so the record
// of the gate and the message a human reads say which directory of which skill stopped it.
export type CandidateRejectionReason =
  // The candidate is not inside <base>/staging, so this package never staged it.
  | "outside-staging"
  // The candidate directory belongs to another skill than the one the run is about.
  | "skill-mismatch"
  // decision.json, lessons/, or both: the staged candidate is not the pair the writer publishes.
  | "incomplete-candidate"
  // decision.json is not a JSON object, or it cannot be read.
  | "unreadable-record"
  // The record declares a schema this version does not read (OA12).
  | "unsupported-schema"
  // The record announces the other base of the gate (M1c): a candidate proposed with a bank is measured by a case bank, a
  // candidate proposed from a transcript by a replay, and the gate of one base reading the record of the other would decide
  // on a material the record does not describe.
  | "basis-mismatch"
  // The gate of the record already answered (M1c): `preregistered` or one of the three concluded statuses. A candidate is
  // gated once -- the rule is preregistered against a candidate nobody has measured yet -- so a second gate is refused
  // instead of rewriting a verdict somebody may already have read.
  | "already-concluded";

export interface CandidateRejection {
  reason: CandidateRejectionReason;
  detail: string;
}

export type StagedCandidateResult = Result<DecisionRecord, CandidateRejection>;

// The record of a candidate that is already in staging, or the typed refusal that says why there is none.
//
// The four guards run in this order and the first one runs before a byte is read:
//
//   1. the path is inside <base>/staging (the perimeter of the whole package, asserted by the same function
//      the writer uses), so a stagingPath of the caller's choosing cannot turn the gate into a reader of
//      any decision.json on the machine;
//   2. the directory is named after the skill, which is where writeStagingCandidate puts the candidate, so
//      a candidate of another skill is not silently gated as this one;
//   3. both halves of the candidate exist: decision.json and lessons/ -- a record with no lesson directory
//      describes a candidate nobody can replay, and an overlay of it would fail one step later, after the
//      preregistration had already been written;
//   4. the record declares the one schema this package reads (OA12), which is checked on the parsed JSON and
//      before the record is handed to anyone.
//
// `stagingPath` may be absolute or relative to `base`: every path this package publishes in a record or in
// a `details` block names a candidate relative to the base of the run, so a caller keeping one of those
// spellings is the ordinary case, and path.resolve answers the same absolute path for both.
export async function resolveStagedCandidate(
  base: string,
  skillName: string,
  stagingPath: string,
): Promise<StagedCandidateResult> {
  const candidateDir = path.resolve(base, stagingPath);
  const stagingRoot = stagingDir(base);

  // Guard 1. The rejection keeps the refusal of the perimeter verbatim: the root it compared is in it, which
  // is what a reader needs to see that the candidate was never looked at.
  try {
    assertWritable(candidateDir, [stagingRoot]);
  } catch (error) {
    return reject("outside-staging", `${quote(candidateDir)} is not a candidate inside ${quote(stagingRoot)}: ${toErrorMessage(error)}`);
  }

  // Guard 2.
  const candidateName = path.basename(candidateDir);
  if (candidateName !== skillName) {
    return reject(
      "skill-mismatch",
      `${quote(candidateDir)} is named ${quote(candidateName)}, not after the skill ${quote(skillName)}`,
    );
  }

  // Guard 3.
  const decisionPath = path.join(candidateDir, DECISION_FILE);
  if (!isRegularFile(decisionPath)) {
    return reject("incomplete-candidate", `${quote(decisionPath)} is not a file`);
  }
  const lessonsPath = path.join(candidateDir, LESSONS_DIR);
  if (!isDirectory(lessonsPath)) {
    return reject("incomplete-candidate", `${quote(lessonsPath)} is not a directory`);
  }

  // Guard 4, inside the read: the version has to be right before the record means anything.
  return await readStagedDecision(decisionPath);
}

// What the gate is pointed at. `base` and `stagingPath` name the candidate the same way resolveStagedCandidate
// does -- a `stagingPath` relative to `base` is the ordinary spelling -- and `agentDir` and `cwd` are the two
// halves the skill inventory is discovered from, so the set of skills a replay loads is the set the session
// had (OA6).
//
// `skill` is the whole reference the inventory resolved and not the pair of fields the gate itself reads:
// the overlay contract takes a SkillRef (src/gate/overlay.ts) and a narrower value would make this module
// invent the fields it does not have -- a description, a kind, whether the skill has lessons -- which are
// inventory facts and not things a gate may guess.
export interface GateRequest {
  base: string; // writeBase(agentDir): staging/ and state/ live under it
  agentDir: string;
  cwd: string;
  stagingPath: string;
  skill: SkillRef;
  // The abort signal of the surface that asked, when it has one: a tool call carries one pi can abort, a
  // command has nothing to abort with and leaves it absent. It travels to every run of the budget.
  signal?: AbortSignal;
}

// Every dependency the flow touches, with its production default resolved inside gateStagedCandidate. The
// replay executor is here and not in the factory of the extension: opening a runner arms nothing, but the
// rule the plan fixes is that the gate -- and not the wiring -- is what decides to run, so no surface is
// handed a runner it could start by accident.
export interface GateDeps {
  now?: () => Date;
  runReplay?: ReplayRunFn;
  buildOverlays?: (input: OverlayRequest) => Promise<OverlayResult>;
  rewriteDecision?: typeof rewriteStagingDecision;
  appendAttempt?: typeof appendAttemptLine;
  writeStream?: typeof writeTextAtomically;
  // The inventory the skills of a replay item are resolved against (OA6). It is a seam for the same reason
  // the writer is: a test proves that an item naming a skill that no longer exists abstains the gate without
  // discovering a single real skill.
  listSkills?: (options: ListSkillsOptions) => Promise<SkillRef[]>;
}

// Why the gate concluded what it concluded, in the two closed vocabularies it decides with: the reason the
// rule produces (`below-threshold`) and the abstention vocabulary of the gate. It is a union of the two and
// not a new list, so a reason cannot reach a record without the scorer or this module having named it first.
export type GateConclusionReason = GateVerdictReason | GateAbstentionReason;

// The candidate could not be gated at all: the directory is not a candidate of this skill, its record is not
// JSON, or its schema is another version. Nothing was written and no run was spent, so there is no record of
// the gate to report and the refusal is the whole answer.
export interface GateRefusedResult {
  kind: "refused";
  rejection: CandidateRejection;
}

// What the gate concluded. `kind` is the gate status the record carries, so the surface switches on the same
// three values the schema reserves for a concluded gate, and an acceptance is the one the acceptance slice
// (S9) turns into a write.
//
// The paths are the ones this package publishes everywhere else: relative to the base of the run. `overlays`
// is null until the two arms exist, which is exactly the case of an abstention that never built them; on an
// acceptance it is what the acceptance compares against the skill before editing it.
//
// `detail` is what an abstention that cost no run is about, when the flow knows it: the file an overlay could
// not copy, the skill of the item that no longer resolves, the lesson whose bytes moved. It is absent when the
// reason is the whole story, and it is the same text the line of the index keeps, so the answer and the index
// cannot describe two different refusals.
export interface GateConcludedResult {
  kind: GateVerdict;
  reason: GateConclusionReason | null;
  stagingPath: string;
  decisionPath: string;
  plannedRuns: number;
  usedRuns: number;
  overlays: GateOverlays | null;
  detail?: string;
}

// The union the command switches on. It is its own and not ProposeFlowResult: a gate answers about a
// candidate that already exists, and its three concluded outcomes belong to command-skill-improve.ts, whose
// `default: assertNever(result)` keeps closing the M0 union untouched.
export type GateFlowResult = GateRefusedResult | GateConcludedResult;

// The gate over a candidate that is already in staging.
export async function gateStagedCandidate(
  request: GateRequest,
  deps: GateDeps = {},
): Promise<GateFlowResult> {
  const seams = gateSeamsOf(deps);
  const candidateDir = path.resolve(request.base, request.stagingPath);

  // Step 1. The record, or the refusal that says why there is none.
  const resolved = await resolveStagedCandidate(request.base, request.skill.name, request.stagingPath);
  if (!resolved.ok) return { kind: "refused", rejection: resolved.error };
  const record = resolved.value;

  // M1c: the two guards of the base, which the flow of the bank runs and this one owed. A record of another base names the
  // material its own gate would measure -- the cases of a bank -- and a replay over it would plan from a diagnosis that does
  // not carry those items, abstain `insufficient-items` and leave a line about a gate that never measured anything. A record
  // whose gate already answered is refused for the reason the directional flow gives it: a candidate is gated once, and a
  // second verdict would rewrite one a reader may already have acted on.
  const basis = record.gate.basis;
  if (basis !== "replay") {
    return {
      kind: "refused",
      rejection: {
        reason: "basis-mismatch",
        detail: `${quote(relativeToBase(request.base, candidateDir))} announces a gate of the ${quote(basis)} base: a gate over a replayed diagnosis reads a record of the replay base`,
      },
    };
  }

  const status = record.gate.status;
  if (status !== "not-run") {
    return {
      kind: "refused",
      rejection: {
        reason: "already-concluded",
        detail: `${quote(relativeToBase(request.base, candidateDir))} is ${quote(status)}: a candidate is gated once, and the rule of a gate that already answered is not preregistered again`,
      },
    };
  }

  // The artifact of a defect, re-verified before the plan and before any run (M1c, S8). The truth of a defect is a file,
  // and the record keeps the digest of the bytes it read: a file that moved since the proposal describes a failure nobody
  // measured, so the gate abstains instead of spending a budget against it. It is the one guard the branch adds, and it
  // runs before the rest because a gate about nothing is the cheapest one to stop.
  const moved = await movedOriginOf(record, request.cwd);
  if (moved !== null) {
    return await answered({
      request,
      seams,
      record,
      candidateDir,
      verdict: "gate-abstained",
      reason: "origin-moved",
      plannedRuns: 0,
      usedRuns: 0,
      overlays: null,
      detail: moved,
    });
  }

  // Step 2. The bytes the record declares. A lesson that moved since it was staged is the one abstention
  // that writes nothing at all -- not even its line -- because neither the record nor the index may describe
  // a candidate whose own bytes disagree with it, and the rewrite below would refuse the write anyway. The
  // detail travels in the answer, which is the only place it can be said (M4).
  const lesson = await verifiedStagedLesson(candidateDir, record);
  if (!lesson.ok) {
    return {
      kind: "gate-abstained",
      reason: "candidate-mismatch",
      stagingPath: relativeToBase(request.base, candidateDir),
      decisionPath: relativeToBase(request.base, path.join(candidateDir, DECISION_FILE)),
      plannedRuns: 0,
      usedRuns: 0,
      overlays: null,
      detail: lesson.error,
    };
  }
  const lessonText = lesson.value;

  // Step 3, first half: the plan, which is pure and costs nothing. Fewer than two eligible items is the one
  // abstention the scorer answers instead of planning, and the exclusions travel with it.
  const plan = planGate(planItemsOf(record));
  if ("abstain" in plan) {
    return await answered({
      request,
      seams,
      record,
      candidateDir,
      verdict: "gate-abstained",
      reason: "insufficient-items",
      plannedRuns: 0,
      usedRuns: 0,
      overlays: null,
    });
  }

  // The items the plan chose, in the order the evidence gave them (OA13). The eligibility of OA7 was applied
  // there and not again here: one predicate, so the list spent is the list counted.
  const selected = plan.items;

  // OA5: every run pins "provider/model", and an item whose transcript named no model cannot be replayed at
  // all -- a run started with no model measures whatever the child defaults to. The gate abstains before it
  // spends anything, which is the honest reading of "the diagnosis cannot say what failed".
  const models = modelsOf(selected);
  if (models === undefined) {
    return await answered({
      request,
      seams,
      record,
      candidateDir,
      verdict: "gate-abstained",
      reason: "no-model",
      plannedRuns: plan.design.plannedRuns,
      usedRuns: 0,
      overlays: null,
    });
  }

  // OA6: the rest of the skills the item's session had, resolved against the current inventory. One of them
  // missing is an abstention before the first run: a replay of the same item with a different set of skills
  // is a different task, and its verdict would be about something nobody measured.
  const inventory = await inventoryOf(request, seams, selected);
  const sharedDirs: string[][] = [];
  for (const entry of selected) {
    const dirs = sharedSkillDirs(entry.item, inventory, request.skill);
    if (!dirs.ok) {
      return await answered({
        request,
        seams,
        record,
        candidateDir,
        verdict: "gate-abstained",
        reason: "skill-unavailable",
        plannedRuns: plan.design.plannedRuns,
        usedRuns: 0,
        overlays: null,
        detail: dirs.error,
      });
    }
    sharedDirs.push(dirs.value);
  }

  // Step 3. The preregistration, written before the first run so the rule cannot be chosen once the numbers
  // are known. The token tally and the outcome do not move: the generation is the only thing spent so far,
  // and a preregistered gate has decided nothing, which is what `proposed` already says.
  const preregistration: GatePreregistration = {
    recordedAt: seams.now().toISOString(),
    threshold: plan.threshold,
    design: plan.design,
    mde: plan.mde,
  };
  await seams.rewriteDecision(
    request.base,
    candidateDir,
    preregisteredRecordOf(record, "replay", preregistration, plan.design.plannedRuns),
  );

  // Step 4. The two arms, from the skill as it stands and from the skill plus the candidate lesson. The
  // overlay copies into staging and never touches the skill, so a gate that passes leaves the skill alone.
  const overlays = await seams.buildOverlays({
    base: request.base,
    stagingPath: candidateDir,
    skill: request.skill,
    slug: record.candidate.slug,
    title: record.candidate.title,
    lessonText,
  });
  if (!overlays.ok) {
    // The preregistration stays on disk: the rule was recorded and the gate ended without a result, which is
    // what a preregistered record means. The reason travels in the line and in this answer, with the refusal of
    // the copy in it -- which file of which skill stopped the overlay (M4).
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

  // Step 4, second half, and the last moment before the first run. The hash of the SKILL.md the two arms were copied
  // from is what the acceptance compares against the skill later, so it is recorded in the preregistration -- the field
  // neutral to the basis, which the case-bank base writes the same way -- instead of in the result of one basis, which
  // is null in the record of the other. The record is rewritten with it before any run, so what every run saw on disk
  // is the preregistration the concluded record carries.
  const measured: GatePreregistration = {
    ...preregistration,
    skillContentHash: overlays.value.skillContentHash,
  };
  await seams.rewriteDecision(
    request.base,
    candidateDir,
    preregisteredRecordOf(record, "replay", measured, plan.design.plannedRuns),
  );

  // Steps 5 and 6. The budget, and the reading of it.
  //
  // The planned items travel without their runs: the budget builds the records the record carries and answers with
  // them, so nothing of this list is written by another function.
  const plannedItems: PlannedItem[] = selected.map((entry, index) => ({
    index,
    // A replay item names its own failure; one that does not is an item of the diagnosis's failure, and the
    // signature of the diagnosis is the only one this record can honestly put in its place.
    failureSignature: entry.item.failureSignature ?? record.diagnosis.failureSignature,
    expectation: entry.item.expectation,
    model: models[index],
  }));

  const budget = await spendBudget({
    request,
    seams,
    plan,
    selected,
    models,
    sharedDirs,
    items: plannedItems,
    candidateDir,
    arms: overlays.value,
  });

  const evaluation = evaluateGate(plan.design, plan.threshold, budget.runs);
  // An interruption is reported as itself, whatever the partial runs say (OA9): the scorer reads a short
  // budget as an unreadable one, and "the gate ran out of its twenty minutes" is the answer a person needs.
  const verdict: GateVerdict = budget.interruptedAt === null ? evaluation.verdict : "gate-abstained";
  const reason: GateConclusionReason | null = budget.interruptedAt === null ? evaluation.reason : "interrupted";

  const completedAt = seams.now();
  const replayOverlays: GateOverlays = gateOverlaysOf(request.base, overlays.value);

  // Step 6. The record, with the preregistration it was judged by next to the result it produced, so a
  // reader can check the rule against the numbers without trusting this module.
  const concluded: DecisionRecord = {
    ...record,
    gate: {
      basis: "replay",
      status: verdict,
      budget: {
        plannedRuns: plan.design.plannedRuns,
        usedRuns: budget.usedRuns,
        interruptedAt: budget.interruptedAt,
      },
      tokens: tokenTallyOf(record.gate.tokens.proposal, evaluation.arms),
      preregistration: measured,
      replay: {
        completedAt: completedAt.toISOString(),
        verdict,
        reason,
        items: budget.items,
        arms: evaluation.arms,
        interval: evaluation.interval,
        regressions: evaluation.regressions,
        excluded: plan.excluded,
        overlays: replayOverlays,
      } satisfies GateReplayResult,
    },
    outcome: { status: outcomeStatusFor(verdict), reason, decidedAt: completedAt.toISOString() },
  };

  // The record before the line: the index is an event about a candidate, so it never names a record that
  // does not carry the verdict yet.
  await seams.rewriteDecision(request.base, candidateDir, concluded);

  return await answered({
    request,
    seams,
    record,
    candidateDir,
    verdict,
    reason,
    plannedRuns: plan.design.plannedRuns,
    usedRuns: budget.usedRuns,
    overlays: replayOverlays,
  });
}

// The seams with their production default, resolved once per call. `runReplay` is the one that matters: the
// default opens a runner, and a runner starts nothing until a run is asked for. The budget spends them, so
// the type of this resolver is what names everything a budget is allowed to touch (./budget.ts).
//
// The type of a resolved seam is derived from the deps and not declared again: every field of GateDeps is one
// this resolver fills, so `Required<>` is exactly what a resolved seam is, and a new dependency means editing
// GateDeps and this resolver instead of a third list that could fall behind them.
export type GateSeams = Required<GateDeps>;

function gateSeamsOf(deps: GateDeps): GateSeams {
  return {
    now: deps.now ?? currentTime,
    runReplay: deps.runReplay ?? createReplayRunner(),
    buildOverlays: deps.buildOverlays ?? buildArmOverlays,
    rewriteDecision: deps.rewriteDecision ?? rewriteStagingDecision,
    appendAttempt: deps.appendAttempt ?? appendAttemptLine,
    writeStream: deps.writeStream ?? writeTextAtomically,
    listSkills: deps.listSkills ?? listSkills,
  };
}

// The block of a gate that has not concluded, in either base and in either of the two states a gate has before its runs.
// The fields neutral to the basis come first -- basis, status, the budget, the tokens and the rule -- and then the key the
// base declares: `replay` is null in the two bases, because the schema requires the key of every block and ties it to no
// basis, and `caseBank: null` is the one only the bank base declares. That single difference is the whole difference
// between the four literals the flows used to write (the replay base, the bank base, and the candidate a proposal stages),
// and `preregistration` is the rule when the gate has written one and null before it has, which is what tells
// `preregistered` from `not-run`.
export function notConcludedGateOf(
  basis: GateBasis,
  tokens: GateTokenTally,
  plannedRuns: number,
  preregistration: GatePreregistration | null,
): GateNotRun | GatePreregistered | GateCaseBankNotRun | GateCaseBankPreregistered {
  const budget: GateBudget = { plannedRuns, usedRuns: 0, interruptedAt: null };

  if (preregistration === null) {
    const block: GateNotRun = { basis: "replay", status: "not-run", budget, tokens, preregistration: null, replay: null };
    const bankBlock: GateCaseBankNotRun = { ...block, basis: "case-bank", caseBank: null };
    return basis === "replay" ? block : bankBlock;
  }

  const block: GatePreregistered = {
    basis: "replay",
    status: "preregistered",
    budget,
    tokens,
    preregistration,
    replay: null,
  };
  const bankBlock: GateCaseBankPreregistered = { ...block, basis: "case-bank", caseBank: null };
  return basis === "replay" ? block : bankBlock;
}

// The record of a gate that has recorded its rule and has run nothing, in the base that measures it. It is one literal for
// the two moments the preregistration is written -- the moment the rule is known and the moment the hash of the SKILL.md the
// arms were copied from is known -- so the two writes cannot describe two different gates, and both happen before the first
// run. The base is an argument because both bases of the gate write this record the same way and differ only in the key of
// their block (notConcludedGateOf above).
export function preregisteredRecordOf(
  record: DecisionRecord,
  basis: GateBasis,
  preregistration: GatePreregistration,
  plannedRuns: number,
): DecisionRecord {
  return {
    ...record,
    gate: notConcludedGateOf(basis, record.gate.tokens, plannedRuns, preregistration),
    outcome: { ...record.outcome, status: outcomeStatusFor("preregistered") },
  };
}

// The verdict of the gate and the one line of the index it gains. The record is the caller's and can be older
// than this answer: the abstentions that end before the budget -- insufficient-items, no-model, skill-unavailable,
// overlay-failed -- leave it in "not-run" or in "preregistered" while the line and the answer carry the result.
interface AnswerInput {
  request: GateRequest;
  seams: GateSeams;
  record: DecisionRecord;
  candidateDir: string;
  verdict: GateVerdict;
  reason: GateConclusionReason | null;
  plannedRuns: number;
  usedRuns: number;
  overlays: GateOverlays | null;
  // What the reason is about, when the flow knows it: the file an overlay could not copy, the skill that no
  // longer resolves. It reaches the line of the index and the answer, and it is absent when the reason is the
  // whole story (M4).
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

// The answer a line of the index reports: the three verdicts of a concluded gate, and the missing baseline of the base
// M1c adds, which is an event of the index and not a state of the record (OA1).
export type GateAnswerEvent = GateVerdict | "no-baseline";

// What a line of the index is made of, with the two paths the caller publishes in the record of the candidate.
export interface GateLineInput {
  seams: Pick<GateSeams, "now" | "appendAttempt">;
  base: string;
  skillName: string;
  candidateDir: string;
  record: DecisionRecord;
  answer: GateAnswerEvent;
  // The reason as its vocabulary spells it, or the stable text of an answer that has no vocabulary word of the gate's own
  // (`caseBankReason`). `detail` is what the reason is about, and the two reach the line in one field.
  reason: string | null;
  detail?: string;
}

export interface GateAnswerPaths {
  stagingPath: string;
  decisionPath: string;
}

// The one writer of the line the index gains when a gate answers something other than an acceptance (S9).
//
// It is exported because the two bases of M1c write the same five facts -- the hashes of the candidate, the failure
// signature of the diagnosis, the two relative paths and the reason with its detail -- and two copies of that layout would
// be two answers to "what does a gate tell the index". The pairs it names are the record's own, so the line groups with the
// `proposed` line of the same candidate on candidateHash instead of inventing a second name for it (Q14).
export async function appendGateAnswerLine(input: GateLineInput): Promise<GateAnswerPaths> {
  const stagingPath = relativeToBase(input.base, input.candidateDir);
  const decisionPath = relativeToBase(input.base, path.join(input.candidateDir, DECISION_FILE));
  const paths = { stagingPath, decisionPath };

  const event = eventOf(input.answer);
  if (event === undefined) return paths;

  const reason = lineReasonOf(input.reason, input.detail);
  await input.seams.appendAttempt(
    input.base,
    buildAttemptLine({
      now: input.seams.now(),
      event,
      targetSkill: input.skillName,
      hashes: {
        candidateHash: input.record.candidate.contentHash,
        bodyHash: input.record.candidate.bodyHash,
      },
      // OA4: the failure the candidate is about, so a reader of the index can group every attempt on one
      // failure without opening a decision.json.
      failureSignature: input.record.diagnosis.failureSignature,
      stagingPath,
      decisionPath,
      ...(reason === undefined ? {} : { reason }),
    }),
  );

  return paths;
}

// M4: the answer names its reason, and the line names what the reason is about. The vocabulary word alone leaves a reader
// without the file that stopped the gate, and the detail alone loses the word every reader groups on, so the line carries
// both in one string. The detail is the optional half -- a rejection below the threshold has none -- and then the reason is
// the whole story the line keeps; only a gate that answered without a reason leaves the field out.
function lineReasonOf(reason: string | null, detail: string | undefined): string | undefined {
  if (reason === null) return undefined;
  return detail === undefined ? reason : `${reason}: ${detail}`;
}

// An acceptance is the one verdict with no line: the index records what happened to the skill, and a gate
// that passed has not touched the skill yet -- the acceptance does, and it writes `accepted` when it does.
// The switch is total over the answers, so a fourth verdict or a third event would stop compiling here instead of being
// classified as an abstention by a fallthrough.
function eventOf(answer: GateAnswerEvent): AttemptEvent | undefined {
  switch (answer) {
    case "gate-accepted":
      return undefined;
    case "gate-rejected":
      return "gate-rejected";
    case "gate-abstained":
      return "gate-abstained";
    case "no-baseline":
      return "no-baseline";
    default:
      return assertNever(answer);
  }
}

// The items of the diagnosis paired with the excerpt of the evidence each was built from (OA7). The excerpt
// does not travel on ReplayItem -- the schema of decision@1 closes that block -- so it is recovered from the
// evidence: a replay item's failure signature is the signature of one evidence id, so signing every id with the
// one rule that defines it (signatureOf, src/diagnosis.ts) names the excerpt it came from. The rule is imported
// and not spelled out again, because a second spelling of it would stop pairing the two -- and then the
// exclusion of OA7 would quietly stop happening -- the day the rule changed.
function planItemsOf(record: DecisionRecord): GatePlanItem[] {
  const excerptBySignature = new Map<string, string>();
  for (const item of record.evidence) {
    if (item.excerpt !== undefined) excerptBySignature.set(signatureOf([item.id]), item.excerpt);
  }

  return record.diagnosis.replayItems.map((item) => {
    const excerpt = item.failureSignature === undefined ? undefined : excerptBySignature.get(item.failureSignature);
    return excerpt === undefined ? { item } : { item, excerpt };
  });
}

// The model of every planned item, or undefined when one of them has none: a run pins the model of the
// failing turn (OA5), and an item that cannot name it cannot be replayed as the same failure.
function modelsOf(items: readonly GatePlanItem[]): string[] | undefined {
  const models: string[] = [];
  for (const entry of items) {
    const model = entry.item.model;
    if (model === undefined) return undefined;
    models.push(model);
  }
  return models;
}

// The inventory, discovered only when an item names a skill other than the one under test: with nothing to
// resolve there is nothing to read, and a gate over one skill does not have to walk the skills directory.
async function inventoryOf(
  request: GateRequest,
  seams: GateSeams,
  selected: readonly GatePlanItem[],
): Promise<SkillRef[]> {
  const names = new Set<string>();
  for (const entry of selected) {
    for (const name of entry.item.skills ?? []) {
      if (name !== request.skill.name) names.add(name);
    }
  }
  if (names.size === 0) return [];

  return await seams.listSkills({ cwd: request.cwd, agentDir: request.agentDir });
}

// The real directories of the other skills of one item's session (OA6), or the reason one of them cannot be
// loaded. The skill under test is skipped: its place in the set is the arm, which the caller prepends.
//
// A name that does not resolve is an abstention and not a smaller set: pi loads exactly the `--skill`
// directories it is given, so replaying with one skill fewer reproduces neither the failure nor the prompt
// that produced it. A standalone skill does not resolve either, and for the same reason: it has no directory
// of its own to hand to `--skill`.
function sharedSkillDirs(
  item: ReplayItem,
  inventory: readonly SkillRef[],
  target: SkillRef,
): Result<string[], string> {
  const dirs: string[] = [];

  for (const name of item.skills ?? []) {
    if (name === target.name) continue;
    const skill = findSkill(inventory, name);
    if (skill === undefined) {
      return { ok: false, error: `the skill ${quote(name)} of the replay item no longer resolves` };
    }
    if (skill.realDir === target.realDir) continue;
    if (!dirs.includes(skill.realDir)) dirs.push(skill.realDir);
  }

  return { ok: true, value: dirs };
}

// The lesson of the candidate as the bytes its record declares, or the detail of the disagreement (S9).
//
// It is exported because both bases of M1c read it: a candidate whose lesson moved is the one abstention that writes
// nothing at all, and the comparison -- the file the record names, the pair of hashes and the reason the two do not agree --
// is one rule with one owner. A second copy in the flow of the bank would be a second answer to "are these the bytes the
// record declares", and the two would drift the day one of them learned about a third hash.
export async function verifiedStagedLesson(
  candidateDir: string,
  record: DecisionRecord,
): Promise<Result<string, string>> {
  const lesson = await readStagedLesson(candidateDir, record.candidate.lessonPath);
  if (!lesson.ok) return lesson;

  const mismatch = undeclaredBytes(lesson.value, record);
  return mismatch === null ? lesson : { ok: false, error: mismatch };
}

// The lesson of the candidate, read from the path the record names. The path is data from a file, so it is
// checked before it is opened: the lesson of a candidate lives inside that candidate and nowhere else.
async function readStagedLesson(candidateDir: string, lessonPath: string): Promise<Result<string, string>> {
  const resolved = path.resolve(candidateDir, lessonPath);
  if (!isInsideOrEqual(resolved, path.resolve(candidateDir))) {
    return { ok: false, error: `the record names a lesson outside the candidate directory: ${quote(lessonPath)}` };
  }

  try {
    return { ok: true, value: await fs.promises.readFile(resolved, "utf8") };
  } catch (error) {
    return { ok: false, error: `cannot read ${quote(resolved)}: ${toErrorMessage(error)}` };
  }
}

// Whether the lesson on disk is the one the record declares, as a reason or null. The pair is recomputed with
// the one function that computes it (D4, src/writer.ts), which is also what the rewrite verifies before it
// replaces a record: a candidate measured against a lesson nobody can find would be a verdict about nothing.
function undeclaredBytes(lessonText: string, record: DecisionRecord): string | null {
  const hashes = lessonHashes(lessonText);
  if (!hashes.ok) {
    return `the lesson ${quote(record.candidate.lessonPath)} is not a lesson file: ${hashes.error}`;
  }

  const declared = record.candidate;
  if (hashes.value.contentHash !== declared.contentHash || hashes.value.bodyHash !== declared.bodyHash) {
    return `the lesson ${quote(declared.lessonPath)} hashes to ${hashes.value.contentHash}, not to the ${declared.contentHash} the record declares`;
  }

  return null;
}

// The first artifact of the record whose bytes are not the ones the evidence recorded, as the detail of the abstention, or
// null when every artifact still hashes to its digest.
//
// The evidence of a defect keeps the path and the digest of the bytes it read (EvidenceOrigin), and nothing else in the
// record can prove the file is still the same: a finding that was edited, a draft that was rewritten and an artifact that
// was deleted are one answer here, and the detail says which of them happened. The path is resolved against the cwd of the
// invocation, which is the directory the proposal resolved it against; the path a record keeps is already absolute, and
// resolving it again answers the same file.
//
// The first discrepancy is the whole detail: a gate that refused for one moved artifact says nothing about the rest, and
// reading them would spend the runs this guard exists to save.
async function movedOriginOf(record: DecisionRecord, cwd: string): Promise<string | null> {
  for (const item of record.evidence) {
    const origin = item.origin;
    if (origin === undefined) continue;

    const artifactPath = path.resolve(cwd, origin.path);
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(artifactPath);
    } catch (error) {
      return `the artifact ${quote(artifactPath)} of the evidence ${quote(item.id)} cannot be read: ${toErrorMessage(error)}`;
    }

    const digest = sha256Digest(bytes);
    if (digest !== origin.contentHash) {
      return `the artifact ${quote(artifactPath)} of the evidence ${quote(item.id)} hashes to ${digest}, not to the ${origin.contentHash} the evidence records`;
    }
  }

  return null;
}

async function readStagedDecision(decisionPath: string): Promise<StagedCandidateResult> {
  let text: string;
  try {
    text = await fs.promises.readFile(decisionPath, "utf8");
  } catch (error) {
    return reject("unreadable-record", `cannot read ${quote(decisionPath)}: ${toErrorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return reject("unreadable-record", `${quote(decisionPath)} is not JSON: ${toErrorMessage(error)}`);
  }
  if (!isPlainObject(parsed)) {
    return reject("unreadable-record", `${quote(decisionPath)} is not a decision record: it is ${describe(parsed)}`);
  }

  // Guard 4 (OA12). The reason is its own, and not a flavour of "unreadable": the file parsed and its
  // version is the problem, which is what the caller has to report -- a candidate written by an older
  // version of this package is a candidate that has to be proposed again, not one that is broken.
  if (parsed.schema !== DECISION_SCHEMA) {
    return reject(
      "unsupported-schema",
      `${quote(decisionPath)} declares the schema ${describe(parsed.schema)}: this package reads only ${quote(DECISION_SCHEMA)}`,
    );
  }

  // The record as the contract it declares. The assertion is the price of not carrying a second
  // implementation of schemas/decision.schema.json in src/: the version guard above proves the file was
  // written by this package, and the fields the gate reads are checked where they are used -- the pair of
  // hashes of the candidate against the lesson on disk (undeclaredBytes, and the same guard inside the
  // rewrite), the failureSignature of the diagnosis where the index line is built. A full runtime
  // validation would be the schema itself, in a package that has no validator and wants none.
  return { ok: true, value: parsed as unknown as DecisionRecord };
}

function reject(reason: CandidateRejectionReason, detail: string): StagedCandidateResult {
  return { ok: false, error: { reason, detail } };
}
