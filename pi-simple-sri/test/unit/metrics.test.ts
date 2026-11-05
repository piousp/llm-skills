import { test } from "node:test";
import assert from "node:assert/strict";
import { failureClassesOf, metricsOf } from "../../src/metrics.ts";
import type { Ledger, LedgerLine, ReadAttemptLine } from "../../src/ledger.ts";
import type {
  CaseBankCaseRecord,
  DecisionOutcomeStatus,
  DecisionRecord,
  EvidenceItem,
  GateArm,
  GateArmTally,
  GateBlock,
  GateCaseBankResult,
  GateInterval,
  GateOverlays,
  GatePreregistration,
  GateReplayResult,
  GateTokenTally,
  GateTokens,
  ReplayItemRecord,
  ReplayRunRecord,
  RunOutcome,
} from "../../src/types.ts";

// The metrics of the series of sessions (M3, S2; OA5 of the plan and its third amendment): the two rates, the coverage
// they are computed over and the split of D-B. The ledger is built by hand and no file is read -- the module is
// arithmetic over a value, and a fixture on disk would prove src/ledger.ts a second time -- and every number the report
// answers is asserted, because a report with the right keys and the wrong count is the failure this file exists to
// catch.

const SCHEMA = "pi-simple-sri/decision@1";
const TS = "2026-11-04T09:00:00.000Z";
const LATER = "2026-11-05T09:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;
const OTHER_HASH = `sha256:${"c".repeat(64)}`;
const SIGNATURE = `sha256:${"b".repeat(64)}`;

// One line of the index as the reader of src/ledger.ts hands it: `event` is a plain string, because the vocabulary of
// the writer is not the vocabulary of the reader and the event of a later version has to be readable here.
interface LineOptions {
  skill?: string;
  ts?: string;
  candidateHash?: string;
}

function lineOf(event: string, options: LineOptions = {}): ReadAttemptLine {
  return {
    ts: options.ts ?? TS,
    event,
    candidateHash: options.candidateHash ?? HASH,
    bodyHash: HASH,
    failureSignature: null,
    targetSkill: options.skill ?? "pdf-tools",
  };
}

interface EntryOptions {
  record?: DecisionRecord;
  problem?: string;
}

// One entry of the ledger: its line, the record it named and -- when it named one and could not read it -- the problem.
// `recordPath` is present exactly when the line named a record, which is what makes `records.missing` a count of the
// lines the reader tried to follow.
function entryOf(index: number, line: ReadAttemptLine, options: EntryOptions = {}): LedgerLine {
  const named = options.record !== undefined || options.problem !== undefined;
  return {
    index,
    line,
    record: options.record ?? null,
    recordPath: named ? `${line.targetSkill}/.history/20261104T090000000Z/decision.json` : null,
    ...(options.problem === undefined ? {} : { problem: options.problem }),
  };
}

function ledgerOf(...lines: LedgerLine[]): Ledger {
  return { lines, damaged: null };
}

// One evidence item of the class -- and the tool -- the key of a recurrence is made of. The id and the timestamp are the
// ones of a transcript and no number of the report reads them: that is the point of OA5, the key is derived at read time
// precisely because the stored name of a failure carries the timestamp of one session.
function evidenceOf(kind: EvidenceItem["kind"], toolName?: string): EvidenceItem {
  return {
    id: `ev-0000000${kind.length}`,
    kind,
    timestamp: 1,
    source: "transcript",
    ...(toolName === undefined ? {} : { toolName }),
  };
}

const TOKENS: GateTokens = { input: 0, output: 0 };
const TOKEN_TALLY: GateTokenTally = {
  proposal: TOKENS,
  incumbent: TOKENS,
  candidate: TOKENS,
  total: TOKENS,
};
const BUDGET = { plannedRuns: 12, usedRuns: 12, interruptedAt: null };
const UNSPENT = { plannedRuns: 0, usedRuns: 0, interruptedAt: null };

const PREREGISTRATION: GatePreregistration = {
  recordedAt: TS,
  threshold: { rule: "unanimous-and-strictly-better", candidatePasses: 6, incumbentPassesMax: 5, version: 1 },
  design: { reps: 2, items: 3, plannedRuns: 12, arms: ["incumbent", "candidate"] },
  mde: { basis: "replay", runsPerArm: 6, resolution: 1 / 6, requiredDifference: 1 },
};

const OVERLAYS: GateOverlays = {
  incumbent: "staging/incumbent/pdf-tools",
  candidate: "staging/candidate/pdf-tools",
  skillContentHash: HASH,
  manifestHash: HASH,
};

const INTERVAL: GateInterval = {
  method: "wilson",
  alpha: 0.05,
  incumbent: { low: 0, high: 1 },
  candidate: { low: 0, high: 1 },
  difference: { low: -1, high: 1 },
};

// One run of one item in one arm. `checkFailures` is present exactly when the text of the turn was judged and did not
// pass, and its absence is the shape a turn an `isError` sank leaves behind (src/gate/expectation.ts, checksOutcome).
function runOf(arm: GateArm, rep: number, outcome: RunOutcome, checkFailures?: readonly string[]): ReplayRunRecord {
  return {
    arm,
    rep,
    outcome,
    ...(checkFailures === undefined ? {} : { checkFailures: [...checkFailures] }),
    stopReason: "end_turn",
    skillLoaded: true,
    usage: TOKENS,
    durationMs: 1,
    exitCode: 0,
  };
}

// A replay item of the fourth class: the one whose runs are judged by a text, which is the material of the split of D-B.
function defectItemOf(index: number, reps: readonly ReplayRunRecord[]): ReplayItemRecord {
  return {
    index,
    failureSignature: SIGNATURE,
    expectation: { class: "quality_defect", version: 1, checks: [{ kind: "contains", value: "SRI-OK" }] },
    model: "provider/model",
    reps: [...reps],
  };
}

// A replay item of the first class: judged by the calls of the turn and not by its text, so its failures are outside the
// split of D-B (rule 8).
function toolItemOf(index: number, reps: readonly ReplayRunRecord[]): ReplayItemRecord {
  return {
    index,
    failureSignature: SIGNATURE,
    expectation: { class: "tool_error", version: 1, tool: "read" },
    model: "provider/model",
    reps: [...reps],
  };
}

function bankCaseOf(reps: readonly ReplayRunRecord[]): CaseBankCaseRecord {
  return {
    index: 0,
    id: "c1",
    model: "provider/model",
    checks: [{ kind: "contains", value: "SRI-OK" }],
    reps: [...reps],
  };
}

// The tallies of the two arms, counted from the runs the items carry. They are the numbers the gate writes; the report
// reads `arms.incumbent.runs` from them and the `regressions` of the result, and nothing else of the block.
function armsOf(items: readonly { reps: readonly ReplayRunRecord[] }[]): {
  incumbent: GateArmTally;
  candidate: GateArmTally;
} {
  const tallyOf = (arm: GateArm): GateArmTally => {
    const runs = items.flatMap((item) => item.reps).filter((run) => run.arm === arm);
    return {
      passes: runs.filter((run) => run.outcome === "pass").length,
      runs: runs.length,
      tokens: TOKENS,
    };
  };

  return { incumbent: tallyOf("incumbent"), candidate: tallyOf("candidate") };
}

// The block of a gate that never ran: the state a proposed candidate leaves behind, which contributes no pair.
function notRunGate(): GateBlock {
  return { basis: "replay", status: "not-run", budget: UNSPENT, tokens: TOKEN_TALLY, preregistration: null, replay: null };
}

type ConcludedStatus = "gate-accepted" | "gate-rejected" | "gate-abstained";

// A concluded gate of the replay base over the items it ran.
function concludedReplayGate(
  items: readonly ReplayItemRecord[],
  regressions: number,
  status: ConcludedStatus = "gate-rejected",
): GateBlock {
  const replay: GateReplayResult = {
    completedAt: TS,
    verdict: status,
    reason: status === "gate-accepted" ? null : "below-threshold",
    items: [...items],
    arms: armsOf(items),
    interval: INTERVAL,
    regressions,
    excluded: [],
    overlays: OVERLAYS,
  };

  return { basis: "replay", status, budget: BUDGET, tokens: TOKEN_TALLY, preregistration: PREREGISTRATION, replay };
}

// The gate of an accepted candidate, as the `.history/` record keeps it: `gate.status` stays "gate-accepted", because
// that is what the gate decided, and the acceptance writes the outcome (src/gate/acceptance.ts, step 5).
function acceptedGate(): GateBlock {
  return concludedReplayGate(
    [toolItemOf(0, [runOf("incumbent", 1, "fail"), runOf("candidate", 1, "pass")])],
    0,
    "gate-accepted",
  );
}

// A concluded gate of the case-bank base: the result lives under the key of its basis and it is the one block whose
// material is a list of cases instead of a list of replay items.
function concludedCaseBankGate(cases: readonly CaseBankCaseRecord[], regressions: number): GateBlock {
  const caseBank: GateCaseBankResult = {
    completedAt: TS,
    verdict: "gate-abstained",
    reason: "no-improvement",
    cases: [...cases],
    arms: armsOf(cases),
    interval: INTERVAL,
    regressions,
    judge: null,
    overlays: OVERLAYS,
  };

  return {
    basis: "case-bank",
    status: "gate-abstained",
    budget: BUDGET,
    tokens: TOKEN_TALLY,
    preregistration: PREREGISTRATION,
    replay: null,
    caseBank,
  };
}

interface RecordOptions {
  skill?: string;
  evidence?: readonly EvidenceItem[];
  gate?: GateBlock;
  outcome?: DecisionOutcomeStatus;
}

// A decision.json of this version. The fields the report reads are the ones the options name; the rest is the shape the
// schema declares, filled once here so every test is about the number it asserts and not about the record around it.
function recordOf(options: RecordOptions = {}): DecisionRecord {
  const skill = options.skill ?? "pdf-tools";

  return {
    schema: SCHEMA,
    createdAt: TS,
    trigger: { surface: "command", focus: null },
    skill: { name: skill, dir: `/skills/${skill}`, realDir: `/skills/${skill}`, wasSymlink: false, eligible: true },
    eligibility: { allow: [], deny: [] },
    evidence: [...(options.evidence ?? [])],
    diagnosis: { summary: "", failureSignature: SIGNATURE, replayItems: [] },
    candidate: {
      kind: "new-lesson",
      slug: "a-lesson",
      title: "A lesson",
      lessonPath: "lessons/a-lesson.md",
      contentHash: HASH,
      bodyHash: HASH,
    },
    gate: options.gate ?? notRunGate(),
    outcome: { status: options.outcome ?? "proposed", reason: null, decidedAt: null },
  };
}

// Four attempts reached a gate -- two acceptances, one rejection and one abstention -- and two of them were accepted.
//
// The abstention is the case the derived total exists for: it ended before the budget, so its record stayed in "not-run"
// while the line of the index already carried the answer (src/gate/flow.ts, answerGateConclusion). A total counted from the
// records would read 3 for this ledger, one less than the three verdicts it has to add up to; the total is that sum, so it
// reads 4 here. The proposed attempt is the other half of rule 1: it is counted in `attempts` and it enters no rate, because
// it never reached a gate. The two acceptances are two lessons of one skill, with hashes of their own.
test("metricsOf: the acceptance rate is over the attempts that reached a gate", () => {
  const ledger = ledgerOf(
    entryOf(0, lineOf("accepted"), { record: recordOf({ gate: acceptedGate(), outcome: "accepted" }) }),
    entryOf(1, lineOf("accepted", { candidateHash: OTHER_HASH }), {
      record: recordOf({ gate: acceptedGate(), outcome: "accepted" }),
    }),
    entryOf(2, lineOf("gate-rejected"), { record: recordOf({ gate: concludedReplayGate([], 0) }) }),
    entryOf(3, lineOf("gate-abstained"), { record: recordOf({ gate: notRunGate() }) }),
    entryOf(4, lineOf("proposed")),
  );

  const metrics = metricsOf(ledger);

  assert.deepEqual(metrics.attempts, { accepted: 2, "gate-rejected": 1, "gate-abstained": 1, proposed: 1 });
  assert.equal(metrics.gated.accepted, 2);
  assert.equal(metrics.gated.rejected, 1);
  assert.equal(metrics.gated.abstained, 1);
  // The denominator of the rate is the three verdicts: the proposed attempt is in `attempts` and outside the rate, so
  // the rate is 2/4 and not 2/5.
  assert.equal(metrics.acceptanceRate, 0.5);
  // The contract of the total: `gated.attempts` is accepted + rejected + abstained, computed where the three are counted, so
  // the abstention whose record stayed in "not-run" is in it and the total of the report is the sum of its parts. Four
  // attempts reached a gate: the two acceptances, the rejection and the abstention.
  assert.equal(metrics.gated.attempts, metrics.gated.accepted + metrics.gated.rejected + metrics.gated.abstained);
  assert.equal(metrics.gated.attempts, 4);
  assert.deepEqual(metrics.records, { present: 4, missing: 0 });
  // Both acceptances are lessons in force (rule 6 counts lines) and neither came back: nothing later names a failure.
  assert.deepEqual(metrics.bySkill, [
    { skill: "pdf-tools", accepted: 2, rejected: 1, abstained: 1, recurrences: 0, lessons: 2 },
  ]);
  assert.equal(metrics.recurrenceRate, 0);
});

// The column of support of OA5: the pairs the gate replayed and the ones it counted as a regression. The two numbers are
// read from the block the gate wrote and never re-derived from the runs, so the report cannot disagree with the record
// (src/gate/scorer.ts, regressionsOf).
test("metricsOf: the regression rate of a gate is its regressions over the pairs it replayed", () => {
  const gate = concludedReplayGate(
    [
      defectItemOf(0, [
        runOf("incumbent", 1, "pass"),
        runOf("candidate", 1, "fail"),
        runOf("incumbent", 2, "pass"),
        runOf("candidate", 2, "pass"),
      ]),
      defectItemOf(1, [
        runOf("incumbent", 1, "pass"),
        runOf("candidate", 1, "pass"),
        runOf("incumbent", 2, "pass"),
        runOf("candidate", 2, "pass"),
      ]),
    ],
    1,
  );

  const metrics = metricsOf(ledgerOf(entryOf(0, lineOf("gate-rejected"), { record: recordOf({ gate }) })));

  // Four runs of the incumbent: two items replayed twice in each arm.
  assert.equal(metrics.gated.pairs, 4);
  assert.equal(metrics.gated.regressions, 1);
  assert.equal(metrics.gateRegressionRate, 0.25);
  assert.equal(metrics.gated.attempts, 1);
});

// A pruned `staging/` is the ordinary way a record of a rejected candidate disappears (rule 5): the line was written and
// the attempt happened, so the answer is the coverage and not a smaller series. The rates of this ledger are the ones of
// the same ledger without the line of the lost record, which is the assertion that matters: a coverage miss does not
// move a number.
test("metricsOf: a record that is gone is coverage and not a number of the rates", () => {
  const withMiss = metricsOf(
    ledgerOf(
      entryOf(0, lineOf("accepted"), { record: recordOf({ gate: acceptedGate(), outcome: "accepted" }) }),
      entryOf(1, lineOf("gate-rejected"), { record: recordOf({ gate: concludedReplayGate([], 1) }) }),
      entryOf(2, lineOf("proposed"), { problem: "'staging/20261104T090000000Z/pdf-tools/decision.json': not a file" }),
    ),
  );
  const withoutMiss = metricsOf(
    ledgerOf(
      entryOf(0, lineOf("accepted"), { record: recordOf({ gate: acceptedGate(), outcome: "accepted" }) }),
      entryOf(1, lineOf("gate-rejected"), { record: recordOf({ gate: concludedReplayGate([], 1) }) }),
    ),
  );

  assert.deepEqual(withMiss.records, { present: 2, missing: 1 });
  assert.equal(withMiss.acceptanceRate, 0.5);
  assert.equal(withMiss.gateRegressionRate, withoutMiss.gateRegressionRate);
  assert.equal(withMiss.acceptanceRate, withoutMiss.acceptanceRate);
  assert.deepEqual(withoutMiss.records, { present: 2, missing: 0 });
});

// D-B (rule 8, OA9): of the items of the fourth class the gate ran, why did the failed runs fail. A fail without
// `checkFailures` is a turn an `isError` sank before there was a text to judge; a fail with the list is a text that did
// not pass. An `invalid` run measured nothing and enters neither column. The material here is the other basis of the
// gate -- the cases of a bank, where `checks` are the predicates and there is no expectation to filter on.
test("metricsOf: the split of D-B separates a tool that sank a turn from a text that did not pass", () => {
  const gate = concludedCaseBankGate(
    [
      bankCaseOf([
        runOf("incumbent", 1, "fail"),
        runOf("candidate", 1, "fail", ["0:contains"]),
        runOf("candidate", 2, "invalid", ["0:contains"]),
      ]),
    ],
    1,
  );

  const metrics = metricsOf(ledgerOf(entryOf(0, lineOf("gate-abstained"), { record: recordOf({ gate }) })));

  assert.deepEqual(metrics.buried, { toolError: 1, text: 1 });
  // And the case-bank block is read for the pairs of rule 3 as well, under the key of its own basis.
  assert.equal(metrics.gated.pairs, 1);
  assert.equal(metrics.gated.regressions, 1);
  assert.equal(metrics.gated.attempts, 1);
});

// Rule 1: a line whose event this version cannot name is counted under "unknown" and kept in the total. The names below
// are not in the vocabulary of src/attempts.ts, which is the situation a reader of a later index is in.
test("metricsOf: an event this version does not know is counted as unknown", () => {
  const metrics = metricsOf(
    ledgerOf(entryOf(0, lineOf("proposed")), entryOf(1, lineOf("gate-retired-later")), entryOf(2, lineOf("superseded"))),
  );

  assert.deepEqual(metrics.attempts, { proposed: 1, unknown: 2 });
  // An unknown event is no verdict of the gate either, and no rate is invented from it.
  assert.equal(metrics.gated.attempts, 0);
  assert.equal(metrics.acceptanceRate, 0);
});

// Rule 7, with the granularity the author confirmed (OA5, amendment 3): the recurrence is the same class of failure --
// `kind:tool` -- coming back on the same skill after the acceptance. The stored signature is not comparable between
// sessions, which is why the key is derived.
test("metricsOf: a lesson recurs when a later line of its skill names a failure of its class", () => {
  const lesson = entryOf(0, lineOf("accepted", { skill: "a" }), {
    record: recordOf({
      skill: "a",
      evidence: [evidenceOf("tool_error", "read")],
      gate: acceptedGate(),
      outcome: "accepted",
    }),
  });

  const cameBack = metricsOf(
    ledgerOf(
      lesson,
      entryOf(1, lineOf("proposed", { skill: "a", ts: LATER }), {
        record: recordOf({ skill: "a", evidence: [evidenceOf("tool_error", "read")] }),
      }),
    ),
  );
  assert.equal(cameBack.bySkill[0].lessons, 1);
  assert.equal(cameBack.bySkill[0].recurrences, 1);
  assert.equal(cameBack.recurrenceRate, 1);

  // The same line with a failure of another class is not a recurrence: the lesson corrected a tool and what came back
  // was a correction.
  const otherClass = metricsOf(
    ledgerOf(
      lesson,
      entryOf(1, lineOf("proposed", { skill: "a", ts: LATER }), {
        record: recordOf({ skill: "a", evidence: [evidenceOf("user_correction")] }),
      }),
    ),
  );
  assert.equal(otherClass.bySkill[0].lessons, 1);
  assert.equal(otherClass.bySkill[0].recurrences, 0);
  assert.equal(otherClass.recurrenceRate, 0);

  // And a line that is not later is not a line that came back: rule 7 asks for a `ts` greater than the acceptance's.
  const before = metricsOf(
    ledgerOf(
      lesson,
      entryOf(1, lineOf("proposed", { skill: "a", ts: TS }), {
        record: recordOf({ skill: "a", evidence: [evidenceOf("tool_error", "read")] }),
      }),
    ),
  );
  assert.equal(before.bySkill[0].recurrences, 0);
});

// Rule 6: a lesson is in force until a later line of its skill names the same candidate as `retired`. S4 is the writer of
// that line; the reader of the index is tolerant by design (src/ledger.ts), so the comparison already holds for the index
// that slice will write.
test("metricsOf: a retired lesson is out of force and out of the denominator of the recurrence", () => {
  const lesson = entryOf(0, lineOf("accepted", { skill: "a" }), {
    record: recordOf({
      skill: "a",
      evidence: [evidenceOf("tool_error", "read")],
      gate: acceptedGate(),
      outcome: "accepted",
    }),
  });

  const retired = metricsOf(ledgerOf(lesson, entryOf(1, lineOf("retired", { skill: "a", ts: LATER }))));
  assert.equal(retired.bySkill[0].lessons, 0);
  assert.equal(retired.bySkill[0].recurrences, 0);
  // A rate whose denominator is 0 is 0, and the text that prints it says so with words instead of a number.
  assert.equal(retired.recurrenceRate, 0);
  // The retirement takes away the force of the lesson and not the fact that the acceptance happened.
  assert.equal(retired.gated.accepted, 1);
  // The line of the retirement is counted and not dropped. It reads under its own event because the vocabulary of
  // src/attempts.ts names `retired` since M3 (S4), which is the slice that writes it.
  assert.equal(retired.attempts.retired, 1);

  // A `retired` line that is earlier than the acceptance retires nothing: the criterion is a later moment.
  const earlier = metricsOf(
    ledgerOf(lesson, entryOf(1, lineOf("retired", { skill: "a", ts: "2026-11-01T09:00:00.000Z" }))),
  );
  assert.equal(earlier.bySkill[0].lessons, 1);

  // And a retirement of another skill, or of another candidate of the same skill, is not this lesson's.
  const elsewhere = metricsOf(ledgerOf(lesson, entryOf(1, lineOf("retired", { skill: "b", ts: LATER }))));
  assert.equal(elsewhere.bySkill[0].lessons, 1);
  assert.deepEqual(
    elsewhere.bySkill.map((tally) => tally.skill),
    ["a", "b"],
  );
});

// Rule 8 names the two shapes of a fail with no text to judge: `checkFailures` absent or empty. The second one is not the
// shape src/gate/expectation.ts writes today -- it leaves the field out -- and it is read the same way, because a list of
// no failed check is still a failure with nothing to judge. An item of another class is outside the split, and one that
// passed is outside it too.
test("metricsOf: an empty list of checks is a tool error, and a class judged by tools is outside the split", () => {
  const gate = concludedReplayGate(
    [
      defectItemOf(0, [runOf("incumbent", 1, "fail", []), runOf("candidate", 1, "pass")]),
      toolItemOf(1, [runOf("incumbent", 1, "fail"), runOf("candidate", 1, "fail")]),
    ],
    0,
  );

  const metrics = metricsOf(ledgerOf(entryOf(0, lineOf("gate-rejected"), { record: recordOf({ gate }) })));

  assert.deepEqual(metrics.buried, { toolError: 1, text: 0 });
});

// The key of OA5 on its own: sorted, without repeats, and with "-" where the class watches no tool.
test("failureClassesOf: the key is sorted, deduplicated and names the tool of a class that has one", () => {
  assert.deepEqual(
    failureClassesOf([
      { kind: "tool_error", toolName: "read" },
      { kind: "retry_loop", toolName: "bash" },
      { kind: "tool_error", toolName: "read" },
      { kind: "user_correction" },
    ]),
    ["retry_loop:bash", "tool_error:read", "user_correction:-"],
  );

  // No evidence is no class: an empty list cuts nothing, so it can never be a recurrence of anything.
  assert.deepEqual(failureClassesOf([]), []);
});
