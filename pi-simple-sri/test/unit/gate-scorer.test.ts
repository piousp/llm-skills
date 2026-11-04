import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCaseGate, evaluateGate, planCaseGate, planDesign, planGate, wilsonInterval } from "../../src/gate/scorer.ts";
import type { CaseBankCase } from "../../src/case-bank.ts";
import { sha256Digest } from "../../src/hash.ts";
import type {
  CaseGateInput,
  CaseGatePlan,
  GateArm,
  GateBounds,
  GateDesign,
  GatePlan,
  GatePlanItem,
  GatePlanOptions,
  RunOutcome,
  RunVerdict,
} from "../../src/gate/types.ts";

// The plan and the verdict of the gate (§8, OA3, OA7, OA13): the twelve runs a 2x2x3 design pays for, the rule
// preregistered with them, the aggregation of the runs into a verdict, and the descriptive interval. Everything
// here is data a test writes -- no process, no file, no clock.

const CWD = "/work/reports";
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TOLERANCE = 1e-4;

// A replay item of the diagnosis. The tool is `bash` on purpose: no marker of the intrinsic list applies to it,
// so a test about the design never has to think about OA7.
function planItem(index: number): GatePlanItem {
  return {
    item: {
      prompt: `the prompt of failure ${index}`,
      cwd: CWD,
      expectation: { class: "tool_error", version: 1, tool: "bash" },
      failureSignature: sha256Digest(`ev-0000000${index}`),
    },
  };
}

// A replay item whose failure is a read of a file that is not there: the shape OA7 excludes, with an excerpt the
// closed list matches.
function intrinsicItem(index: number): GatePlanItem {
  const { item } = planItem(index);
  return {
    item: { ...item, expectation: { class: "tool_error", version: 1, tool: "read" } },
    excerpt: "read missing-probe.txt: ENOENT: no such file or directory",
  };
}

// The plan of a design over `count` eligible items. Every test of the rule starts here, so none of them spells
// the arithmetic of §8 out again, and a refused plan fails with its own reason.
function planOf(count: number, options: GatePlanOptions = {}): GatePlan {
  const result = planGate(
    Array.from({ length: count }, (_unused, index) => planItem(index)),
    options,
  );
  if (!("design" in result)) throw new Error(`the plan of ${count} items was refused: ${result.abstain}`);
  return result;
}

function verdict(item: number, rep: number, arm: GateArm, outcome: RunOutcome): RunVerdict {
  return { item, rep, arm, outcome, usage: { input: 10, output: 2 } };
}

// The whole budget of a design, with the (item, rep) pairs each arm failed written as `item:rep`. A test about
// the counters says which pairs failed, because that is what the counters are about; a test about the rule
// usually fails one pair and lets the rest pass.
function budgetWithFailures(
  design: GateDesign,
  failed: { incumbent: readonly string[]; candidate: readonly string[] },
): RunVerdict[] {
  const runs: RunVerdict[] = [];

  for (let item = 0; item < design.items; item += 1) {
    for (let rep = 1; rep <= design.reps; rep += 1) {
      for (const arm of design.arms) {
        const pair = `${item}:${rep}`;
        runs.push(verdict(item, rep, arm, failed[arm].includes(pair) ? "fail" : "pass"));
      }
    }
  }

  return runs;
}

// The whole budget passed by both arms, which is the shape a test then breaks where it is about a break.
function perfectBudget(design: GateDesign): RunVerdict[] {
  return budgetWithFailures(design, { incumbent: [], candidate: [] });
}

function assertBounds(bounds: GateBounds, low: number, high: number): void {
  assert.ok(Math.abs(bounds.low - low) < TOLERANCE, `low ${bounds.low} is not ${low}`);
  assert.ok(Math.abs(bounds.high - high) < TOLERANCE, `high ${bounds.high} is not ${high}`);
}

test("planGate: 2x2x3 plans twelve runs, six per arm, with the rule and the floor preregistered", () => {
  // The whole plan is asserted, the items it chose included: a field added to the design, the rule or the floor
  // breaks this test instead of travelling into a decision record unnoticed, and the list the gate spends has to be
  // the list the prefix of three items names.
  assert.deepEqual(planOf(3), {
    items: [planItem(0), planItem(1), planItem(2)],
    design: { reps: 2, items: 3, plannedRuns: 12, arms: ["incumbent", "candidate"] },
    threshold: {
      rule: "unanimous-and-strictly-better",
      candidatePasses: 6,
      incumbentPassesMax: 5,
      version: 1,
    },
    mde: { basis: "replay", runsPerArm: 6, resolution: 1 / 6, requiredDifference: 1 },
    excluded: [],
  });
});

test("planGate: the prefix of three items and the hard ceiling of twelve runs", () => {
  // OA13: more evidence does not buy more runs. The prefix keeps the order of the evidence, so the same
  // diagnosis always plans the same runs.
  const five = planOf(5);
  assert.deepEqual(five.design, { reps: 2, items: 3, plannedRuns: 12, arms: ["incumbent", "candidate"] });

  // And the list the gate spends is that prefix: three items and not the five that were eligible, which is
  // what keeps the budget at twelve runs instead of twenty.
  assert.equal(five.items.length, 3);
  assert.deepEqual(five.items, [planItem(0), planItem(1), planItem(2)]);

  // The one option lowers the prefix, and the arithmetic follows it: two items are eight runs and four per arm.
  const shorter = planOf(3, { maxItems: 2 });
  assert.deepEqual(shorter.design, { reps: 2, items: 2, plannedRuns: 8, arms: ["incumbent", "candidate"] });
  assert.equal(shorter.threshold.candidatePasses, 4);
  assert.equal(shorter.threshold.incumbentPassesMax, 3);
  assert.equal(shorter.mde.runsPerArm, 4);
  assert.equal(shorter.mde.resolution, 1 / 4);

  // And it cannot lift the ceiling: twelve runs are the budget, whatever the caller asks for.
  assert.equal(planOf(6, { maxItems: 9 }).design.plannedRuns, 12);
});

test("planGate: one eligible item abstains with insufficient-items and plans no run", () => {
  const plan = planGate([planItem(0)]);

  // No design at all: the gate answered before spending, and there is no threshold to preregister for a
  // comparison that has no counterpart.
  assert.deepEqual(plan, { abstain: "insufficient-items", excluded: [] });
  assert.equal("design" in plan, false);
});

test("planGate: an item excluded for an intrinsic failure does not count toward the minimum and is recorded", () => {
  const plan = planGate([planItem(0), intrinsicItem(1), planItem(2)]);
  if (!("design" in plan)) throw new Error(`three items with one intrinsic planned nothing: ${plan.abstain}`);

  // Two eligible items, four runs per arm: the intrinsic failure took no slot of the three.
  assert.equal(plan.design.items, 2);
  assert.equal(plan.design.plannedRuns, 8);
  assert.equal(plan.threshold.candidatePasses, 4);
  // The item did not run, and the record says which failure it was (OA7).
  assert.deepEqual(plan.excluded, [{ failureSignature: sha256Digest("ev-00000001"), reason: "intrinsic-failure" }]);

  // The exclusion runs before the minimum is counted: two items of which one is intrinsic are one eligible item,
  // so the gate abstains instead of running.
  assert.deepEqual(planGate([planItem(0), intrinsicItem(2)]), {
    abstain: "insufficient-items",
    excluded: [{ failureSignature: sha256Digest("ev-00000002"), reason: "intrinsic-failure" }],
  });
});

test("planGate: the failures it excludes are named by a real digest, and an anonymous one is replayed", () => {
  // The excluded list travels into the record, where the schema validates the pattern of the signature: a
  // signature the plan invents would be refused by the reader of its own output.
  const plan = planGate([planItem(0), intrinsicItem(1), planItem(2)]);
  assert.equal(plan.excluded.length, 1);
  assert.match(plan.excluded[0].failureSignature, HASH_PATTERN);

  // An item whose failure has no signature cannot be named in the record, so it is replayed instead of being
  // dropped without a trace -- and an item the caller cannot pair with an excerpt is never excluded either.
  const anonymous: GatePlanItem = {
    item: { ...intrinsicItem(1).item, failureSignature: undefined },
    excerpt: "ENOENT",
  };
  assert.deepEqual(planGate([planItem(0), anonymous]).excluded, []);
  assert.deepEqual(planGate([planItem(0), { item: intrinsicItem(1).item }]).excluded, []);
});

test("planDesign: the design of n items, and the basis of its floor", () => {
  // The design is a function of the count alone, so a caller with no list of replay items to prefix asks for the
  // same arithmetic of §8 instead of spelling it out again.
  assert.deepEqual(planDesign(2, "replay").design, {
    reps: 2,
    items: 2,
    plannedRuns: 8,
    arms: ["incumbent", "candidate"],
  });

  // The ceiling is the prefix of three: five items are three, and twelve runs.
  assert.equal(planDesign(3, "replay").design.plannedRuns, 12);
  assert.equal(planDesign(5, "replay").design.plannedRuns, 12);

  // The rule that comes with the design: every run of the candidate, one run fewer of the incumbent.
  assert.deepEqual(planDesign(3, "replay").threshold, {
    rule: "unanimous-and-strictly-better",
    candidatePasses: 6,
    incumbentPassesMax: 5,
    version: 1,
  });

  // `basis` reaches the floor as given, and the floor resolves one run of each arm.
  assert.deepEqual(planDesign(2, "case-bank").mde, {
    basis: "case-bank",
    runsPerArm: 4,
    resolution: 1 / 4,
    requiredDifference: 1,
  });
});

test("evaluateGate: accepts a candidate that passed every run against an incumbent that missed one", () => {
  const plan = planOf(3);
  const evaluation = evaluateGate(
    plan.design,
    plan.threshold,
    budgetWithFailures(plan.design, { incumbent: ["2:2"], candidate: [] }),
  );

  assert.equal(evaluation.verdict, "gate-accepted");
  // Nothing stopped it, which is the one case the reason is null.
  assert.equal(evaluation.reason, null);
  assert.deepEqual(evaluation.arms, {
    incumbent: { passes: 5, runs: 6, tokens: { input: 60, output: 12 } },
    candidate: { passes: 6, runs: 6, tokens: { input: 60, output: 12 } },
  });
  // One pair only the candidate passed: the whole improvement this design can see, and it is one run.
  assert.equal(evaluation.regressions, 0);
  assert.equal(evaluation.interval.method, "wilson");
  assert.equal(evaluation.interval.alpha, 0.05);
  assertBounds(evaluation.interval.candidate, 0.6097, 1);
  assertBounds(evaluation.interval.incumbent, 0.4365, 0.9699);
  assertBounds(evaluation.interval.difference, 0.0301, 0.5635);
});

test("evaluateGate: rejects a candidate that passed five of six runs", () => {
  const plan = planOf(3);
  const evaluation = evaluateGate(
    plan.design,
    plan.threshold,
    budgetWithFailures(plan.design, { incumbent: [], candidate: ["2:2"] }),
  );

  // The rule demands unanimity: one missing run of the candidate is below the threshold, and the pair it missed
  // is the pair the incumbent passed.
  assert.equal(evaluation.verdict, "gate-rejected");
  assert.equal(evaluation.reason, "below-threshold");
  assert.equal(evaluation.regressions, 1);
});

test("evaluateGate: abstains with no-improvement when both arms pass every run", () => {
  const plan = planOf(3);
  const evaluation = evaluateGate(plan.design, plan.threshold, perfectBudget(plan.design));

  // A candidate that is as good as the skill it would replace is not better, and this design cannot tell the two
  // apart from noise: abstaining is the expected result under the MDE.
  assert.equal(evaluation.verdict, "gate-abstained");
  assert.equal(evaluation.reason, "no-improvement");
  assert.equal(evaluation.regressions, 0);
  // No pair improved, so the difference sits at the lower end of what six runs can resolve.
  assertBounds(evaluation.interval.difference, 0, 0.3903);
});

test("evaluateGate: one invalid run abstains the whole gate", () => {
  const plan = planOf(3);

  // A broken run in either arm leaves the baseline unreadable, so nothing the other arm proved can be compared.
  const broken: readonly (readonly [number, "timeout" | "exit-code" | "stream-unparseable"])[] = [
    [0, "timeout"],
    [3, "exit-code"],
    [11, "stream-unparseable"],
  ];
  for (const [index, reason] of broken) {
    const runs = perfectBudget(plan.design);
    runs[index] = { ...runs[index], outcome: "invalid", invalidReason: reason };
    const evaluation = evaluateGate(plan.design, plan.threshold, runs);

    assert.equal(evaluation.verdict, "gate-abstained", `run ${index}`);
    assert.equal(evaluation.reason, "invalid-run", `run ${index}`);
  }

  // An interruption is reported as itself: it is the one abstention a person caused.
  const interrupted = perfectBudget(plan.design);
  interrupted[5] = { ...interrupted[5], outcome: "invalid", invalidReason: "interrupted" };
  const evaluation = evaluateGate(plan.design, plan.threshold, interrupted);
  assert.equal(evaluation.verdict, "gate-abstained");
  assert.equal(evaluation.reason, "interrupted");
});

test("evaluateGate: a budget that did not complete is not judged", () => {
  const plan = planOf(3);
  // Eleven of twelve runs: five complete pairs and the incumbent of the sixth.
  const partial = perfectBudget(plan.design).slice(0, 11);
  const evaluation = evaluateGate(plan.design, plan.threshold, partial);

  assert.equal(evaluation.verdict, "gate-abstained");
  assert.equal(evaluation.reason, "invalid-run");
  assert.equal(evaluation.arms.incumbent.runs, 6);
  assert.equal(evaluation.arms.candidate.runs, 5);
});

test("evaluateGate: regressions count pairs, not runs", () => {
  const plan = planOf(3);
  // The incumbent failed one pair and the candidate another: one regression, one improvement, and the two
  // counters describe different pairs.
  const crossed = evaluateGate(
    plan.design,
    plan.threshold,
    budgetWithFailures(plan.design, { incumbent: ["0:1"], candidate: ["2:2"] }),
  );

  assert.equal(crossed.regressions, 1);
  assert.equal(crossed.verdict, "gate-rejected");
  assertBounds(crossed.interval.difference, 0.0301, 0.5635);

  // Both arms failing the same pair is no regression: the pair was already broken before the candidate.
  const samePair = evaluateGate(
    plan.design,
    plan.threshold,
    budgetWithFailures(plan.design, { incumbent: ["2:2"], candidate: ["2:2"] }),
  );
  assert.equal(samePair.regressions, 0);
});

test("wilsonInterval: the extremes of six runs, the empty sample and a middle one", () => {
  // The fixed values of the two extremes, with n = 6: the interval a reader of the record can recompute. The
  // bounds are asserted with the tolerance of the arithmetic, not with an equality that floating point could
  // miss by one ulp.
  const none = wilsonInterval(0, 6, 0.05);
  assertBounds(none, 0, 0.3903);
  assert.ok(none.low >= 0, `low ${none.low} is below zero`);

  const all = wilsonInterval(6, 6, 0.05);
  assertBounds(all, 0.6097, 1);
  assert.ok(all.high <= 1, `high ${all.high} is above one`);

  // A sample of nothing says nothing.
  assert.deepEqual(wilsonInterval(0, 0, 0.05), { low: 0, high: 1 });

  // A middle sample, and the two properties that make the interval usable as a description: it contains the
  // observed proportion and it is not the whole range.
  const middle = wilsonInterval(5, 6, 0.05);
  assertBounds(middle, 0.4365, 0.9699);
  assert.ok(middle.low <= 5 / 6 && 5 / 6 <= middle.high);

  // A count outside its own sample is clamped instead of producing an interval outside [0, 1].
  assert.deepEqual(wilsonInterval(9, 6, 0.05), wilsonInterval(6, 6, 0.05));
});

// The same reading for the second base (M1c, S9): the plan over a bank of cases and the evaluation that co-conditions the
// rule with the judge. The helpers below are the two facts of a bank that the plan reads -- its cases and the digest of its
// rubric -- so a test of the rule never spells a case out again.

// One case of a bank, in the shape the reader of src/case-bank.ts answers: an id, the prompt the replay sends and the checks
// every one of which has to pass on the final answer.
function bankCase(index: number): CaseBankCase {
  return {
    id: `case-${index}`,
    prompt: `the question of case ${index}`,
    checks: [{ kind: "contains", value: `answer-${index}` }],
  };
}

const RUBRIC = "PASS when the answer names the flag and runs nothing destructive.";
const RUBRIC_HASH = sha256Digest(RUBRIC);
const CASE_MODEL = "anthropic/claude-sonnet-4-5";
const CASE_CWD = "/work/reports";

// What the plan of a bank is computed from, with every field of the invocation fixed here: the cwd and the model are facts
// of the run, and a test about the arithmetic of the design never has to think about them.
function caseInput(count: number, rubricHash: string | null = RUBRIC_HASH): CaseGateInput {
  return {
    cases: Array.from({ length: count }, (_unused, index) => bankCase(index)),
    rubricHash,
    cwd: CASE_CWD,
    model: CASE_MODEL,
    failureSignature: sha256Digest("directional_improvement"),
  };
}

// The plan of a bank of `count` cases, so a test of the rule starts from a planned design and a refused plan fails with its
// own reason instead of the shape of a union.
function casePlan(count: number, rubricHash: string | null = RUBRIC_HASH): CaseGatePlan {
  const plan = planCaseGate(caseInput(count, rubricHash));
  if (!("design" in plan)) throw new Error(`the plan of ${count} cases was refused: ${plan.abstain}`);
  return plan;
}

// The rule of a bank gate as the preregistration would carry it is the one `planCaseGate` answers, so no helper of this
// suite spells it out again: the design, the rule and the floor are asserted where they are planned.

// The whole budget of a two-case design, with the (case, rep) pairs each arm failed written as `case:rep`, exactly as the
// replay suite does over items.
function caseBudget(failed: { incumbent: readonly string[]; candidate: readonly string[] }): RunVerdict[] {
  const runs: RunVerdict[] = [];

  for (let item = 0; item < 2; item += 1) {
    for (let rep = 1; rep <= 2; rep += 1) {
      for (const arm of ["incumbent", "candidate"] as const) {
        const pair = `${item}:${rep}`;
        runs.push(verdict(item, rep, arm, failed[arm].includes(pair) ? "fail" : "pass"));
      }
    }
  }

  return runs;
}

// The shape the rule accepts: the candidate passes every run and the incumbent misses one.
const ACCEPTING_BUDGET: readonly string[] = ["1:1"];

test("planCaseGate: two cases plan the 2x2x2 design, and the rule carries the judge the rubric announced", () => {
  const plan = casePlan(2);

  // The design is the one of the paired replay over the count of cases: two repetitions, two cases, eight runs.
  assert.deepEqual(plan.design, { reps: 2, items: 2, plannedRuns: 8, arms: ["incumbent", "candidate"] });
  // The rule is the rule of the replay base, with the second condition inside it: a clause recorded with the rule cannot be
  // added or dropped once the result is known.
  assert.deepEqual(plan.threshold, {
    rule: "unanimous-and-strictly-better",
    candidatePasses: 4,
    incumbentPassesMax: 3,
    version: 1,
    judge: { required: "pass", rubricHash: RUBRIC_HASH },
  });
  // The floor says what it was computed from: the cases of a bank, not the turns of a diagnosis.
  assert.deepEqual(plan.mde, { basis: "case-bank", runsPerArm: 4, resolution: 1 / 4, requiredDifference: 1 });
  // The cases are the ones the user wrote, so nothing was excluded -- the list exists and is empty instead of absent.
  assert.deepEqual(plan.excluded, []);

  // The cases and their items are the same list twice: the record names a case by its id and its checks, the budget names it
  // by its coordinates and its expectation, and the expectation is the fourth class with the checks the bank declared.
  assert.deepEqual(plan.cases, [bankCase(0), bankCase(1)]);
  assert.deepEqual(plan.items, [
    {
      item: {
        prompt: bankCase(0).prompt,
        cwd: CASE_CWD,
        expectation: { class: "quality_defect", version: 1, checks: bankCase(0).checks },
        model: CASE_MODEL,
        failureSignature: sha256Digest("directional_improvement"),
      },
    },
    {
      item: {
        prompt: bankCase(1).prompt,
        cwd: CASE_CWD,
        expectation: { class: "quality_defect", version: 1, checks: bankCase(1).checks },
        model: CASE_MODEL,
        failureSignature: sha256Digest("directional_improvement"),
      },
    },
  ]);
});

test("planCaseGate: the prefix of three cases is the hard ceiling of twelve runs", () => {
  // More cases do not buy more runs, and the order of the file is kept: the same bank always plans the same cases.
  const plan = casePlan(5);

  assert.equal(plan.design.items, 3);
  assert.equal(plan.design.plannedRuns, 12);
  assert.deepEqual(plan.cases, [bankCase(0), bankCase(1), bankCase(2)]);
  assert.deepEqual(plan.items.map((entry) => entry.item.prompt), ["the question of case 0", "the question of case 1", "the question of case 2"]);
});

test("planCaseGate: a bank with no rubric announces no second condition", () => {
  // The clause is absent and not falsified: a record that says nothing about a judge is a gate whose rule is the only
  // condition it announced.
  const plan = casePlan(2, null);

  assert.equal("judge" in plan.threshold, false);
  assert.deepEqual(plan.threshold, {
    rule: "unanimous-and-strictly-better",
    candidatePasses: 4,
    incumbentPassesMax: 3,
    version: 1,
  });
});

test("planCaseGate: one case abstains with insufficient-items and plans no run", () => {
  // The reader of the bank refuses fewer than MIN_CASES cases, so this is the guard of the flow: a design over one case
  // compares a run against itself, and the gate answers before spending.
  assert.deepEqual(planCaseGate(caseInput(1)), { abstain: "insufficient-items", excluded: [] });
  assert.deepEqual(planCaseGate({ ...caseInput(0), cases: [] }), { abstain: "insufficient-items", excluded: [] });
});

test("evaluateCaseGate: a mechanical refusal is the answer whatever the judge said", () => {
  const plan = casePlan(2);
  // The candidate missed one run, so the rule refused it -- and the judge does not get to upgrade a refusal: the mechanics are
  // the necessary condition, and the second condition can only refuse to accompany an acceptance.
  const runs = caseBudget({ incumbent: [], candidate: ["1:1"] });

  for (const answer of ["pass", "fail", "unavailable", "not-run"] as const) {
    const evaluation = evaluateCaseGate(plan.design, plan.threshold, runs, answer);
    assert.equal(evaluation.verdict, "gate-rejected", `with the judge answering ${answer}`);
    assert.equal(evaluation.reason, "below-threshold", `with the judge answering ${answer}`);
    assert.equal(evaluation.judge, "not-run", `with the judge answering ${answer}`);
  }
});

test("evaluateCaseGate: an accepted rule with no clause accepts, and the judge did not speak", () => {
  const plan = casePlan(2, null);
  const evaluation = evaluateCaseGate(
    plan.design,
    plan.threshold,
    caseBudget({ incumbent: ACCEPTING_BUDGET, candidate: [] }),
    // Even an answer of the judge is ignored: the record announced no second condition, so the rule is the only one there is.
    "pass",
  );

  assert.equal(evaluation.verdict, "gate-accepted");
  assert.equal(evaluation.reason, null);
  assert.equal(evaluation.judge, "not-run");
});

test("evaluateCaseGate: an accepted rule accepts only when the judge accompanied it", () => {
  const plan = casePlan(2);
  const runs = caseBudget({ incumbent: ACCEPTING_BUDGET, candidate: [] });

  const accepted = evaluateCaseGate(plan.design, plan.threshold, runs, "pass");
  assert.equal(accepted.verdict, "gate-accepted");
  assert.equal(accepted.reason, null);
  assert.equal(accepted.judge, "pass");
  // The rest of the reading is the reading of the rule: the same arms, the same interval, the same counters.
  assert.equal(accepted.arms.candidate.passes, 4);
  assert.equal(accepted.arms.incumbent.passes, 3);
  assert.equal(accepted.regressions, 0);
});

test("evaluateCaseGate: mechanics accepted and one case rejected by the judge is a rejection", () => {
  const plan = casePlan(2);
  const evaluation = evaluateCaseGate(
    plan.design,
    plan.threshold,
    caseBudget({ incumbent: ACCEPTING_BUDGET, candidate: [] }),
    "fail",
  );

  // Q3, Q24: the judge is a second condition and never the first one. The runs were readable and the rule was met, so this is
  // a rejection and not an abstention -- with its own reason, so a reader knows which of the two conditions refused.
  assert.equal(evaluation.verdict, "gate-rejected");
  assert.equal(evaluation.reason, "judge-failed");
  assert.equal(evaluation.judge, "fail");
});

test("evaluateCaseGate: a judge nobody could read abstains, and a judge nobody asked abstains too", () => {
  const plan = casePlan(2);
  const runs = caseBudget({ incumbent: ACCEPTING_BUDGET, candidate: [] });

  for (const answer of ["unavailable", "not-run"] as const) {
    const evaluation = evaluateCaseGate(plan.design, plan.threshold, runs, answer);

    // The gate announced a second condition and cannot apply it, so it cannot accept: the abstention is the honest answer,
    // and the record keeps what was actually asked in the calls of the block.
    assert.equal(evaluation.verdict, "gate-abstained", `with the judge answering ${answer}`);
    assert.equal(evaluation.reason, "judge-unavailable", `with the judge answering ${answer}`);
    assert.equal(evaluation.judge, "not-run", `with the judge answering ${answer}`);
  }
});

test("evaluateCaseGate: a perfect tie abstains before the judge is consulted", () => {
  const plan = casePlan(2);
  // Both arms pass every run: under this design the candidate is as good as the skill, which is not better. The second
  // condition cannot turn a tie into an acceptance, so the judge never had to speak.
  const evaluation = evaluateCaseGate(plan.design, plan.threshold, caseBudget({ incumbent: [], candidate: [] }), "pass");

  assert.equal(evaluation.verdict, "gate-abstained");
  assert.equal(evaluation.reason, "no-improvement");
  assert.equal(evaluation.judge, "not-run");
});

test("criterio de salida de M1: with 2x2x3 the acceptance demands unanimity and abstaining is the expected result under the MDE", () => {
  const plan = planOf(3);

  // Six runs per arm: the candidate has to pass all six, and the incumbent at most five. The rule asks for the
  // whole pass rate, far above the one-run floor the design resolves.
  assert.equal(plan.threshold.candidatePasses, 6);
  assert.equal(plan.threshold.incumbentPassesMax, 5);
  assert.equal(plan.mde.runsPerArm, 6);
  assert.equal(plan.mde.resolution, 1 / 6);
  assert.equal(plan.mde.requiredDifference, 1);

  // Five of six is not a smaller improvement: it is below the preregistered rule.
  const fiveOfSix = evaluateGate(
    plan.design,
    plan.threshold,
    budgetWithFailures(plan.design, { incumbent: [], candidate: ["2:2"] }),
  );
  assert.equal(fiveOfSix.verdict, "gate-rejected");

  // Two perfect arms abstain: under this design, a candidate that is as good as the skill is not better.
  const bothPerfect = evaluateGate(plan.design, plan.threshold, perfectBudget(plan.design));
  assert.equal(bothPerfect.verdict, "gate-abstained");
  assert.equal(bothPerfect.reason, "no-improvement");
});
