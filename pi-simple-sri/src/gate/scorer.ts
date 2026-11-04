import { SriFailClosedError } from "../errors.ts";
import type { ReplayItem } from "../types.ts";
import { isIntrinsicFailure } from "./expectation.ts";
import type {
  GateArm,
  GateArmTally,
  GateBounds,
  GateDesign,
  GateEvaluation,
  GatePlanItem,
  GatePlanOptions,
  GatePlanResult,
  GateReplayExclusion,
  GateThreshold,
  GateVerdict,
  GateVerdictReason,
  RunOutcome,
  RunVerdict,
} from "./types.ts";

// The plan and the verdict of the gate (M1, S7): what the budget pays for before the first run, and what the
// runs proved once they are paid. Pure over data, like the evaluator it consumes: no process, no file, no
// clock, and no dependency.
//
// The design is fixed by §8 of the plan and not by the caller: two repetitions of each item in two arms, at
// most three items, which is twelve runs and the hard ceiling of the budget. The prefix of three is the
// plan's answer to a cost that grows with the evidence (OA13): the items keep the order the evidence gave
// them, so the same diagnosis always plans the same runs.
//
// Two numbers are preregistered with the design and neither is the other: `threshold` is the rule the gate is
// judged by, and `mde` is the floor of the design -- the smallest difference this many runs can tell apart.
// Reporting the floor next to the rule is what stops a rule that asks for less than the design resolves.

// The design of §8: two repetitions per item, two arms, at most three items.
const REPS = 2;
const MAX_ITEMS = 3;

// Two items are the least a paired design can compare. With one, every run of an arm has a single
// counterpart and a difference of one run is a difference of the whole sample, so the gate answers
// "insufficient-items" instead of pretending to measure.
const MIN_ITEMS = 2;

// The arms of the paired replay, in the order a pair is spent: the skill as it stands, then the candidate.
const ARMS: readonly GateArm[] = ["incumbent", "candidate"];

// The two-sided level of the interval. The interval describes and never decides, so the level is a constant
// of the report and not a setting.
const ALPHA = 0.05;

// What the floor was computed from, recorded with it: the paired replay of `runsPerArm` runs per arm.
const MDE_BASIS = "replay";

export function planGate(items: readonly GatePlanItem[], options: GatePlanOptions = {}): GatePlanResult {
  const excluded: GateReplayExclusion[] = [];
  const eligible: ReplayItem[] = [];

  // OA7: the exclusion runs before anything is counted, so an intrinsic failure never takes one of the three
  // slots of a failure the gate can measure.
  for (const entry of items) {
    const exclusion = exclusionOf(entry);
    if (exclusion === undefined) {
      eligible.push(entry.item);
    } else {
      excluded.push(exclusion);
    }
  }

  // OA13: a deterministic prefix, in the order the evidence gave the items. The ceiling is hard: the option
  // can lower the prefix, never lift it past the twelve runs the budget allows.
  const maxItems = Math.min(options.maxItems ?? MAX_ITEMS, MAX_ITEMS);
  const selected = eligible.slice(0, maxItems);
  if (selected.length < MIN_ITEMS) return { abstain: "insufficient-items", excluded };

  const runsPerArm = REPS * selected.length;

  return {
    design: { reps: REPS, items: selected.length, plannedRuns: runsPerArm * ARMS.length, arms: [...ARMS] },
    threshold: {
      rule: "unanimous-and-strictly-better",
      candidatePasses: runsPerArm,
      incumbentPassesMax: runsPerArm - 1,
      version: 1,
    },
    mde: {
      basis: MDE_BASIS,
      runsPerArm,
      // The smallest non-zero difference of a pass rate over `runsPerArm` runs: one run.
      resolution: 1 / runsPerArm,
      // The pass rate the rule demands of the candidate: every run. The two are in the same units, which is
      // how a reader sees that the rule asks for far more than the floor resolves.
      requiredDifference: 1,
    },
    excluded,
  };
}

export function evaluateGate(
  design: GateDesign,
  threshold: GateThreshold,
  runs: readonly RunVerdict[],
): GateEvaluation {
  const arms = { incumbent: tallyOf(runs, "incumbent"), candidate: tallyOf(runs, "candidate") };
  const pairs = pairsOf(runs);
  const { verdict, reason } = verdictOf(design, threshold, runs, arms);

  return {
    verdict,
    reason,
    arms,
    interval: {
      method: "wilson",
      alpha: ALPHA,
      incumbent: wilsonInterval(arms.incumbent.passes, arms.incumbent.runs, ALPHA),
      candidate: wilsonInterval(arms.candidate.passes, arms.candidate.runs, ALPHA),
      // The difference is computed on the paired count and not on two independent rates: each (item, rep) is
      // one comparison, and what the gate adds is the pairs only the candidate passed.
      difference: wilsonInterval(improvedPairs(pairs), pairs.length, ALPHA),
    },
    regressions: regressionsOf(pairs),
  };
}

// The Wilson score interval of a proportion, without a dependency and without an approximation: the
// quantiles below are the exact values of the normal distribution for the levels this package reports.
//
// The interval describes and never decides. With six runs per arm the intervals of a perfect candidate and a
// perfect incumbent still touch, which is exactly why the rule is unanimity plus strict superiority and the
// interval is only recorded next to it.
export function wilsonInterval(passes: number, runs: number, alpha: number): GateBounds {
  // A sample of nothing says nothing, and the whole range is the only honest answer to it.
  if (runs <= 0) return { low: 0, high: 1 };

  const z = normalQuantile(alpha);
  const n = runs;
  // A count outside its own sample is clamped instead of producing an interval outside [0, 1].
  const p = Math.min(Math.max(passes, 0), n) / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));

  // The bounds are clamped for the same reason: at 0 of 6 the arithmetic lands on -1e-17, and an interval
  // that starts below zero is a number a reader has to explain.
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

// The two-sided quantiles of the three conventional levels, as a table: the interval is descriptive, and a
// number nobody can recompute from the code is not a description of anything.
const NORMAL_QUANTILES: ReadonlyMap<number, number> = new Map([
  [0.1, 1.6448536269514722],
  [0.05, 1.959963984540054],
  [0.01, 2.5758293035489004],
]);

function normalQuantile(alpha: number): number {
  const z = NORMAL_QUANTILES.get(alpha);
  if (z === undefined) {
    throw new SriFailClosedError(`no two-sided normal quantile for alpha ${alpha}`);
  }
  return z;
}

// The exclusion of one item, when its failure is intrinsic to the task (OA7). An item whose failure has no
// signature cannot be named in the record, so it is replayed instead of being dropped without a trace: the
// list exists to show what did not run, and an anonymous entry would not show it.
function exclusionOf(entry: GatePlanItem): GateReplayExclusion | undefined {
  if (!isIntrinsicFailure(entry.item, entry.excerpt)) return undefined;

  const failureSignature = entry.item.failureSignature;
  if (failureSignature === undefined) return undefined;

  return { failureSignature, reason: "intrinsic-failure" };
}

// The aggregation of §8, in the order that fails closed: a broken run first, then the rule as it was
// preregistered.
function verdictOf(
  design: GateDesign,
  threshold: GateThreshold,
  runs: readonly RunVerdict[],
  arms: { incumbent: GateArmTally; candidate: GateArmTally },
): { verdict: GateVerdict; reason: GateVerdictReason | null } {
  // OA3: one broken run abstains the whole gate, because the arm it broke in is the baseline the other arm is
  // compared against. An interruption is reported as itself: it is the one abstention a person caused.
  const broken = runs.filter((run) => run.outcome === "invalid");
  if (broken.length > 0) {
    const interrupted = broken.some((run) => run.invalidReason === "interrupted");
    return { verdict: "gate-abstained", reason: interrupted ? "interrupted" : "invalid-run" };
  }

  // A budget that did not complete cannot be judged by a rule written for the runs it planned: eleven of
  // twelve runs is not a smaller gate, it is a gate that proved nothing about the twelfth.
  const plannedPerArm = design.reps * design.items;
  if (arms.incumbent.runs < plannedPerArm || arms.candidate.runs < plannedPerArm) {
    return { verdict: "gate-abstained", reason: "invalid-run" };
  }

  // The rule: the candidate passes every run, and the incumbent misses at least one, or the candidate is not
  // strictly better than the skill it would replace.
  if (arms.candidate.passes < threshold.candidatePasses) {
    return { verdict: "gate-rejected", reason: "below-threshold" };
  }
  if (arms.incumbent.passes > threshold.incumbentPassesMax) {
    return { verdict: "gate-abstained", reason: "no-improvement" };
  }

  return { verdict: "gate-accepted", reason: null };
}

function tallyOf(runs: readonly RunVerdict[], arm: GateArm): GateArmTally {
  const armRuns = runs.filter((run) => run.arm === arm);

  return {
    passes: armRuns.filter((run) => run.outcome === "pass").length,
    runs: armRuns.length,
    tokens: armRuns.reduce(
      (total, run) => ({
        input: total.input + run.usage.input,
        output: total.output + run.usage.output,
      }),
      { input: 0, output: 0 },
    ),
  };
}

// One (item, rep) pair, as the two arms answered it. An arm that never ran leaves its field absent: no run is
// not a failure, and the gate abstains before either count below is read.
interface RunPair {
  incumbent?: RunOutcome;
  candidate?: RunOutcome;
}

function pairsOf(runs: readonly RunVerdict[]): RunPair[] {
  const byPair = new Map<string, RunPair>();

  for (const run of runs) {
    const key = `${run.item}:${run.rep}`;
    const pair: RunPair = byPair.get(key) ?? {};
    pair[run.arm] = run.outcome;
    byPair.set(key, pair);
  }

  return [...byPair.values()];
}

// The pairs only the candidate passed: what the gate adds over the skill as it stands.
function improvedPairs(pairs: readonly RunPair[]): number {
  return pairs.filter((pair) => pair.candidate === "pass" && pair.incumbent === "fail").length;
}

// A regression is a pair the incumbent passed and the candidate failed: the same item, the same repetition,
// two arms. Counting per run instead would let a pass in one repetition hide a failure in the other.
function regressionsOf(pairs: readonly RunPair[]): number {
  return pairs.filter((pair) => pair.incumbent === "pass" && pair.candidate === "fail").length;
}
