import fs from "node:fs";
import path from "node:path";
import { buildAttemptLine, type AttemptEvent } from "../attempts.ts";
import { sha256Digest } from "../hash.ts";
import { DECISION_FILE, LESSONS_DIR } from "../names.ts";
import { assertWritable, isInsideOrEqual } from "../perimeter.ts";
import { findSkill, listSkills, type ListSkillsOptions } from "../skills-inventory.ts";
import { assertNever, outcomeStatusFor } from "../types.ts";
import type {
  DecisionRecord,
  DecisionSchema,
  GateOverlays,
  GatePreregistration,
  GateReplayResult,
  GateTokenTally,
  GateTokens,
  ReplayItem,
  ReplayItemRecord,
  ReplayRunRecord,
  Result,
  SkillRef,
} from "../types.ts";
import { currentTime, describe, isDirectory, isPlainObject, isRegularFile, quote, toErrorMessage } from "../values.ts";
import { relativeToBase, stagingDir } from "../write-base.ts";
import { appendAttemptLine, lessonHashes, rewriteStagingDecision, writeTextAtomically } from "../writer.ts";
import { evaluateExpectation, isIntrinsicFailure } from "./expectation.ts";
import { buildArmOverlays, type OverlayArms, type OverlayRequest, type OverlayResult } from "./overlay.ts";
import { createReplayRunner } from "./replay-runner.ts";
import { evaluateGate, planGate } from "./scorer.ts";
import type {
  GateAbstentionReason,
  GateArm,
  GateArmTally,
  GatePlan,
  GatePlanItem,
  GateVerdict,
  GateVerdictReason,
  ReplayRun,
  ReplayRunFn,
  RunVerdict,
} from "./types.ts";

// The flow of the gate (M1, S8): one staged candidate, the rule preregistered before the first run, the
// paired budget spent over the two arms, the verdict of that budget, the record rewritten with it, and the
// one line the index gains when the gate answers.
//
// The order is the contract, and each step exists to stop the next one:
//
//   1. resolveStagedCandidate names the record of the candidate, and refuses one this version cannot read;
//   2. the lesson on disk is hashed against the pair the record declares, so a candidate whose bytes moved
//      since it was staged abstains before a byte is written into it;
//   3. the plan -- the design, the rule and the floor of the design -- is computed from the diagnosis and
//      written into the record as the preregistration BEFORE the first run. A threshold recorded after the
//      runs would be a threshold chosen with the result in hand, and the timestamp of the preregistration is
//      what makes "recorded before the runs" checkable from the record alone;
//   4. the two arms are built in staging, so a replay reads a copy of the skill and never the skill;
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
// It is here and not in the surface (src/tool-skill-improve.ts, src/command-skill-improve.ts) because both
// surfaces run it and a candidate this module gates is one the whole package then trusts: one
// implementation, one set of guards, and no second reading of a decision.json.
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

// OA9: the two caps of the plan, and neither is a setting. 180 s is the life of one run -- the runner stops
// the child at the deadline and insists five seconds later -- and 20 min is the life of the whole gate, which
// is checked between runs here because the flow is what owns the budget.
const RUN_TIMEOUT_MS = 180_000;
const GATE_TIMEOUT_MS = 20 * 60 * 1000;

// Where the raw stream of every run is kept, inside the candidate directory of staging:
// <candidate>/gate/runs/<item>-<rep>-<arm>.jsonl. The coordinates are the ones the run carried, so a reader
// of the record can find the bytes of any row without a second index.
const GATE_DIR = "gate";
const RUNS_DIR = "runs";
const RUN_STREAM_EXT = ".jsonl";

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
  | "unsupported-schema";

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

  // Step 2. The bytes the record declares. A lesson that moved since it was staged is the one abstention
  // that writes nothing at all -- not even its line -- because neither the record nor the index may describe
  // a candidate whose own bytes disagree with it, and the rewrite below would refuse the write anyway. The
  // detail travels in the answer, which is the only place it can be said (M4).
  const lesson = await readStagedLesson(candidateDir, record.candidate.lessonPath);
  const mismatch = lesson.ok ? undeclaredBytes(lesson.value, record) : lesson.error;
  if (!lesson.ok || mismatch !== null) {
    return {
      kind: "gate-abstained",
      reason: "candidate-mismatch",
      stagingPath: relativeToBase(request.base, candidateDir),
      decisionPath: relativeToBase(request.base, path.join(candidateDir, DECISION_FILE)),
      plannedRuns: 0,
      usedRuns: 0,
      overlays: null,
      ...(mismatch === null ? {} : { detail: mismatch }),
    };
  }
  const lessonText = lesson.value;

  // Step 3, first half: the plan, which is pure and costs nothing. Fewer than two eligible items is the one
  // abstention the scorer answers instead of planning, and the exclusions travel with it.
  const planItems = planItemsOf(record);
  const plan = planGate(planItems);
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

  // The prefix of the plan, in the order the evidence gave the items (OA13).
  const selected = selectedItemsOf(planItems, plan);

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
  const preregistered: DecisionRecord = {
    ...record,
    gate: {
      basis: "replay",
      status: "preregistered",
      budget: { plannedRuns: plan.design.plannedRuns, usedRuns: 0, interruptedAt: null },
      tokens: record.gate.tokens,
      preregistration,
      replay: null,
    },
    outcome: { ...record.outcome, status: outcomeStatusFor("preregistered") },
  };
  await seams.rewriteDecision(request.base, candidateDir, preregistered);

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

  // Steps 5 and 6. The budget, and the reading of it.
  const items: ReplayItemRecord[] = selected.map((entry, index) => ({
    index,
    // A replay item names its own failure; one that does not is an item of the diagnosis's failure, and the
    // signature of the diagnosis is the only one this record can honestly put in its place.
    failureSignature: entry.item.failureSignature ?? record.diagnosis.failureSignature,
    expectation: entry.item.expectation,
    model: models[index],
    reps: [],
  }));

  const budget = await spendBudget({
    request,
    seams,
    plan,
    selected,
    models,
    sharedDirs,
    items,
    candidateDir,
    arms: overlays.value,
  });

  const evaluation = evaluateGate(plan.design, plan.threshold, budget.runs);
  // An interruption is reported as itself, whatever the partial runs say (OA9): the scorer reads a short
  // budget as an unreadable one, and "the gate ran out of its twenty minutes" is the answer a person needs.
  const verdict: GateVerdict = budget.interruptedAt === null ? evaluation.verdict : "gate-abstained";
  const reason: GateConclusionReason | null = budget.interruptedAt === null ? evaluation.reason : "interrupted";

  const completedAt = seams.now();
  const replayOverlays: GateOverlays = {
    incumbent: relativeToBase(request.base, overlays.value.incumbentDir),
    candidate: relativeToBase(request.base, overlays.value.candidateDir),
    skillContentHash: overlays.value.skillContentHash,
    manifestHash: overlays.value.manifestHash,
  };

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
      preregistration,
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
// default opens a runner, and a runner starts nothing until a run is asked for.
interface GateSeams {
  now: () => Date;
  runReplay: ReplayRunFn;
  buildOverlays: (input: OverlayRequest) => Promise<OverlayResult>;
  rewriteDecision: typeof rewriteStagingDecision;
  appendAttempt: typeof appendAttemptLine;
  writeStream: typeof writeTextAtomically;
  listSkills: (options: ListSkillsOptions) => Promise<SkillRef[]>;
}

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

// What the budget of one gate produced: the verdicts the scorer reads, the items as the record shows them,
// how many runs were started, and the moment the gate gave up (null when it did not).
interface BudgetResult {
  runs: RunVerdict[];
  items: ReplayItemRecord[];
  usedRuns: number;
  interruptedAt: number | null;
}

interface BudgetInput {
  request: GateRequest;
  seams: GateSeams;
  plan: GatePlan;
  selected: readonly GatePlanItem[];
  models: readonly string[];
  sharedDirs: readonly (readonly string[])[];
  items: ReplayItemRecord[];
  candidateDir: string;
  arms: OverlayArms;
}

// Step 5 of the sequence: item -> rep -> (incumbent, candidate), which keeps the two arms of one pair
// adjacent in time, so a difference between them is about the section and not about the hour.
//
// The budget stops at the first run nobody can read (OA3): the arm it broke in is the baseline the other arm
// is compared against, so the rest of the twelve would be spent on a comparison the scorer has already
// refused. It stops the same way for an interruption, before starting a child.
async function spendBudget(input: BudgetInput): Promise<BudgetResult> {
  const runsDir = prepareRunsDir(input.candidateDir);
  const arms: Record<GateArm, string> = {
    incumbent: input.arms.incumbentDir,
    candidate: input.arms.candidateDir,
  };
  const startedAt = input.seams.now().getTime();
  const runs: RunVerdict[] = [];
  let usedRuns = 0;

  for (const [index, entry] of input.selected.entries()) {
    const item = input.items[index];

    for (let rep = 1; rep <= input.plan.design.reps; rep += 1) {
      for (const arm of input.plan.design.arms) {
        // OA9: the twenty minutes of the gate are checked between runs, so an interruption costs at most the
        // run that is in flight, and a caller that already gave up starts no child at all.
        const interruptedAt = interruptionOf(input.request.signal, startedAt, input.seams.now);
        if (interruptedAt !== null) return { runs, items: input.items, usedRuns, interruptedAt };

        // The order of `skillDirs` is the order pi loads them in: the arm first, then the rest of the set the
        // session had, so the skill under test is the copy and the others are the skills themselves (OA6).
        const run: ReplayRun = await input.seams.runReplay({
          item: index,
          rep,
          arm,
          prompt: entry.item.prompt,
          skillName: input.request.skill.name,
          skillDirs: [arms[arm], ...input.sharedDirs[index]],
          cwd: entry.item.cwd,
          model: input.models[index],
          timeoutMs: RUN_TIMEOUT_MS,
          ...(input.request.signal === undefined ? {} : { signal: input.request.signal }),
        });

        usedRuns += 1;
        const verdict = evaluateExpectation(entry.item.expectation, run);
        runs.push(verdict);

        // OA10: the raw stream is persisted before the next run starts, so an interruption leaves the bytes of
        // the run it cut on disk, and the record points at them.
        const stream = await persistStream({
          seams: input.seams,
          base: input.request.base,
          runsDir,
          run,
        });
        item.reps.push(runRecordOf(verdict, run, stream));

        if (run.outcome === "invalid") {
          const interrupted = run.invalidReason === "interrupted" ? input.seams.now().getTime() : null;
          return { runs, items: input.items, usedRuns, interruptedAt: interrupted };
        }
      }
    }
  }

  return { runs, items: input.items, usedRuns, interruptedAt: null };
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
  const stagingPath = relativeToBase(input.request.base, input.candidateDir);
  const decisionPath = relativeToBase(input.request.base, path.join(input.candidateDir, DECISION_FILE));

  const event = eventOf(input.verdict);
  if (event !== undefined) {
    const reason = attemptReasonOf(input);
    await input.seams.appendAttempt(
      input.request.base,
      buildAttemptLine({
        now: input.seams.now(),
        event,
        targetSkill: input.request.skill.name,
        // The pair the record already carries, so the gate's lines group with the `proposed` line of the same
        // candidate on candidateHash instead of inventing a second name for it.
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
  }

  return {
    kind: input.verdict,
    reason: input.reason,
    stagingPath,
    decisionPath,
    plannedRuns: input.plannedRuns,
    usedRuns: input.usedRuns,
    overlays: input.overlays,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  };
}

// M4: the abstention names its reason, and the line names what the reason is about. The vocabulary word alone
// leaves a reader without the file that stopped the gate, and the detail alone loses the word every reader
// groups on, so the line carries both in one string. Absent when there is no detail to give: then the reason
// is the whole story and the line says nothing more.
function attemptReasonOf(input: AnswerInput): string | undefined {
  if (input.reason === null || input.detail === undefined) return undefined;
  return `${input.reason}: ${input.detail}`;
}

// An acceptance is the one verdict with no line: the index records what happened to the skill, and a gate
// that passed has not touched the skill yet -- the acceptance does, and it writes `accepted` when it does.
// The switch is total over the verdicts, so a fourth one would stop compiling here instead of being
// classified as an abstention by a fallthrough.
function eventOf(verdict: GateVerdict): AttemptEvent | undefined {
  switch (verdict) {
    case "gate-accepted":
      return undefined;
    case "gate-rejected":
      return "gate-rejected";
    case "gate-abstained":
      return "gate-abstained";
    default:
      return assertNever(verdict);
  }
}

// The items of the diagnosis paired with the excerpt of the evidence each was built from (OA7). The excerpt
// does not travel on ReplayItem -- the schema of decision@1 closes that block -- so it is recovered from the
// evidence: a replay item's failure signature is the digest of the id of one evidence item, so the digest of
// every id names the excerpt it came from without a second rule for what a signature is.
function planItemsOf(record: DecisionRecord): GatePlanItem[] {
  const excerptBySignature = new Map<string, string>();
  for (const item of record.evidence) {
    if (item.excerpt !== undefined) excerptBySignature.set(sha256Digest(item.id), item.excerpt);
  }

  return record.diagnosis.replayItems.map((item) => {
    const excerpt = item.failureSignature === undefined ? undefined : excerptBySignature.get(item.failureSignature);
    return excerpt === undefined ? { item } : { item, excerpt };
  });
}

// The prefix of the plan: the eligible items in the order the diagnosis gave them, cut at the count the plan
// fixed (OA13). planGate answers with the count and not with the items, so the cut reads the count from the
// plan and the eligibility from the one predicate that defines it -- and this flow pairs an excerpt with an
// item exactly when the item names a failure it can pair, which is the condition the exclusion in the scorer
// applies before it counts anything.
function selectedItemsOf(items: readonly GatePlanItem[], plan: GatePlan): GatePlanItem[] {
  const eligible = items.filter((entry) => !isIntrinsicFailure(entry.item, entry.excerpt));
  return eligible.slice(0, plan.design.items);
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

// The gate's own directory inside the candidate: created here, so it is checked before it exists (I10), and
// guarded by the candidate directory, which is the narrowest root a run stream belongs to.
function prepareRunsDir(candidateDir: string): string {
  const runsDir = path.join(candidateDir, GATE_DIR, RUNS_DIR);
  assertWritable(runsDir, [candidateDir]);
  fs.mkdirSync(runsDir, { recursive: true });
  return runsDir;
}

// OA10: the bytes of one run, under the coordinates it carried. A run that wrote nothing has no file -- there
// are no bytes to keep and no path to point at -- and the record then carries no `stream` for it.
async function persistStream(input: {
  seams: GateSeams;
  base: string;
  runsDir: string;
  run: ReplayRun;
}): Promise<string | undefined> {
  const { request, rawStream } = input.run;
  if (rawStream === "") return undefined;

  const target = path.join(input.runsDir, `${request.item}-${request.rep}-${request.arm}${RUN_STREAM_EXT}`);
  await input.seams.writeStream(target, rawStream, input.runsDir);
  return relativeToBase(input.base, target);
}

// One run as the record shows it. The outcome is the verdict's and not the runner's: the runner can only say
// the process answered, and whether that answer passes is the reading of the expectation. The two fields the
// runner added are copied when it has them: the bytes the cap cut (OA10) and the cause the process gave.
function runRecordOf(verdict: RunVerdict, run: ReplayRun, stream: string | undefined): ReplayRunRecord {
  return {
    arm: run.request.arm,
    rep: run.request.rep,
    outcome: verdict.outcome,
    ...(verdict.invalidReason === undefined ? {} : { invalidReason: verdict.invalidReason }),
    ...(run.invalidDetail === undefined ? {} : { invalidDetail: run.invalidDetail }),
    stopReason: run.stopReason,
    skillLoaded: run.skillLoaded,
    usage: run.usage,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    ...(stream === undefined ? {} : { stream }),
    ...(run.truncatedAt === undefined ? {} : { truncatedAt: run.truncatedAt }),
  };
}

// The moment the gate has to stop, or null while it may keep spending. A caller that gave up outranks the
// clock: both are the same answer, and the run that was in flight is the interruption.
function interruptionOf(
  signal: AbortSignal | undefined,
  startedAt: number,
  now: () => Date,
): number | null {
  const at = now().getTime();
  if (signal?.aborted === true) return at;
  return at - startedAt >= GATE_TIMEOUT_MS ? at : null;
}

// What the whole decision spent, split by where it went. `total` is the sum of the three (Q6): a reader never
// adds them again, and the proposal is the number the record already carried before the gate ran.
function tokenTallyOf(
  proposal: GateTokens,
  arms: { incumbent: GateArmTally; candidate: GateArmTally },
): GateTokenTally {
  const incumbent = arms.incumbent.tokens;
  const candidate = arms.candidate.tokens;

  return {
    proposal,
    incumbent,
    candidate,
    total: {
      input: proposal.input + incumbent.input + candidate.input,
      output: proposal.output + incumbent.output + candidate.output,
    },
  };
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
