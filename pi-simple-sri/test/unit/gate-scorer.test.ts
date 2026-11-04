import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGate, planGate, wilsonInterval } from "../../src/gate/scorer.ts";
import { sha256Digest } from "../../src/hash.ts";
import type {
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
  assert.deepEqual(planOf(5).design, { reps: 2, items: 3, plannedRuns: 12, arms: ["incumbent", "candidate"] });

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
