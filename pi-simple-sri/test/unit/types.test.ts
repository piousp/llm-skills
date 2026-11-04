import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNever, GATE_STATUSES, outcomeStatusFor } from "../../src/types.ts";
import type {
  DecisionOutcomeStatus,
  GateBlock,
  GateBudget,
  GateCaseBankResult,
  GatePreregistration,
  GateStatus,
  GateTokenTally,
} from "../../src/types.ts";

// assertNever is the end of the two dispatches over ProposeFlowResult (src/command-skill-improve.ts and
// src/tool-skill-improve.ts). Its parameter is `never`, which is the compile-time half of the rule: a
// variant added to the union leaves the value of a dispatch that forgot it narrowed to that variant, so
// the call stops compiling. This test is the runtime half.
test("assertNever: a variant the union does not have is refused with its value", () => {
  // The argument is wrong on purpose, and the directive marks the one line where it is: no value of an
  // exhaustively handled union reaches this call, and the case the guard exists for -- a caller built
  // against an older union, sending a variant the compiled one no longer has -- has no other shape.
  // @ts-expect-error a variant outside every union of this package
  assert.throws(() => assertNever("accept"), /unhandled variant: "accept"/);
});

// M1c: the gate block describes two bases and the three states of each, and from here the two bases share the three
// statuses a concluded gate has -- so `status` alone no longer names a variant and the dispatch has to narrow by `basis`
// first. That is the whole point of the two tests below: a dispatch that assumes a status says everything stops
// compiling (the `assertNever` of stateOf), and the mapping from what the gate decided to what the record says did not
// have to learn about the second basis.

const ZERO_TOKENS: GateTokenTally = {
  proposal: { input: 0, output: 0 },
  incumbent: { input: 0, output: 0 },
  candidate: { input: 0, output: 0 },
  total: { input: 0, output: 0 },
};

const SKILL_CONTENT_HASH = `sha256:${"a".repeat(64)}`;
const CASE_BANK_HASH = `sha256:${"f".repeat(64)}`;

// The tally of a gate that called the judge: `total` is the sum of the components that are there, which is the rule the
// fourth component of M1c extends and does not change.
const JUDGE_TOKENS: GateTokenTally = {
  proposal: { input: 0, output: 0 },
  incumbent: { input: 0, output: 0 },
  candidate: { input: 0, output: 0 },
  judge: { input: 300, output: 20 },
  total: { input: 300, output: 20 },
};

const NOT_PLANNED: GateBudget = { plannedRuns: 0, usedRuns: 0, interruptedAt: null };
const PLANNED: GateBudget = { plannedRuns: 8, usedRuns: 0, interruptedAt: null };
const SPENT: GateBudget = { plannedRuns: 8, usedRuns: 8, interruptedAt: null };

// The preregistration of the replay base, with the one field M1c adds to it: the hash of the SKILL.md the gate measured,
// which is neutral to the basis -- the block of one basis is null in the record of the other -- and is where the
// acceptance reads it.
const REPLAY_PREREGISTRATION: GatePreregistration = {
  recordedAt: "2026-11-02T14:04:00.000Z",
  threshold: {
    rule: "unanimous-and-strictly-better",
    candidatePasses: 4,
    incumbentPassesMax: 3,
    version: 1,
  },
  design: { reps: 2, items: 2, plannedRuns: 8, arms: ["incumbent", "candidate"] },
  mde: { basis: "replay", runsPerArm: 4, resolution: 0.25, requiredDifference: 1 },
  skillContentHash: SKILL_CONTENT_HASH,
};

// The preregistration of the second base: the same neutral field plus the two that depend on the basis -- the materials
// of the bank under the key of their basis, and the judge clause, which travels with the rule and not after it.
const CASE_BANK_PREREGISTRATION: GatePreregistration = {
  recordedAt: "2026-11-02T14:04:00.000Z",
  threshold: {
    rule: "unanimous-and-strictly-better",
    candidatePasses: 4,
    incumbentPassesMax: 3,
    version: 1,
    judge: { required: "pass", rubricHash: SKILL_CONTENT_HASH },
  },
  design: { reps: 2, items: 2, plannedRuns: 8, arms: ["incumbent", "candidate"] },
  mde: { basis: "case-bank", runsPerArm: 4, resolution: 0.25, requiredDifference: 1 },
  skillContentHash: SKILL_CONTENT_HASH,
  caseBank: {
    path: "/work/cases.json",
    contentHash: CASE_BANK_HASH,
    copy: "staging/20261102T140322481Z/pdf-tools/case-bank.json",
    cases: 2,
    rubricHash: SKILL_CONTENT_HASH,
  },
};

const ARMS = {
  incumbent: { passes: 1, runs: 4, tokens: { input: 0, output: 0 } },
  candidate: { passes: 4, runs: 4, tokens: { input: 0, output: 0 } },
};

const INTERVAL = {
  method: "wilson" as const,
  alpha: 0.05,
  incumbent: { low: 0, high: 1 },
  candidate: { low: 0, high: 1 },
  difference: { low: -1, high: 1 },
};

const OVERLAYS = {
  incumbent: "staging/20261102T140322481Z/pdf-tools/arms/incumbent/pdf-tools",
  candidate: "staging/20261102T140322481Z/pdf-tools/arms/candidate/pdf-tools",
  skillContentHash: SKILL_CONTENT_HASH,
  manifestHash: `sha256:${"e".repeat(64)}`,
};

// The result of the second base, in the shape gate.caseBank declares. An empty list of cases is a gate that ran nothing,
// which is exactly what this file needs: the compiler proves the fixture and the contract describe the same block.
const CASE_BANK_RESULT: GateCaseBankResult = {
  completedAt: "2026-11-02T14:20:00.000Z",
  verdict: "gate-accepted",
  reason: null,
  cases: [],
  arms: ARMS,
  interval: INTERVAL,
  regressions: 0,
  judge: {
    model: "anthropic/claude-sonnet-4-5",
    rubricHash: SKILL_CONTENT_HASH,
    verdict: "pass",
    calls: [],
    tokens: { input: 0, output: 0 },
  },
  overlays: OVERLAYS,
};

const BASES = ["replay", "case-bank"] as const;
type BasisName = (typeof BASES)[number];

// The block of one basis in one status, field for field what the schema of that state requires. The switch is exhaustive
// over GATE_STATUSES inside each basis and over the two bases at the top, so a variant the block gains later -- or a
// status the union gains -- loses its case here and this file stops compiling.
function gateOf(basis: BasisName, status: GateStatus): GateBlock {
  switch (basis) {
    case "replay":
      switch (status) {
        case "not-run":
          return { basis: "replay", status: "not-run", budget: NOT_PLANNED, tokens: ZERO_TOKENS, preregistration: null, replay: null };
        case "preregistered":
          return {
            basis: "replay",
            status: "preregistered",
            budget: PLANNED,
            tokens: ZERO_TOKENS,
            preregistration: REPLAY_PREREGISTRATION,
            replay: null,
          };
        case "gate-accepted":
        case "gate-rejected":
        case "gate-abstained":
          return {
            basis: "replay",
            status,
            budget: SPENT,
            tokens: ZERO_TOKENS,
            preregistration: REPLAY_PREREGISTRATION,
            replay: {
              completedAt: "2026-11-02T14:20:00.000Z",
              verdict: status,
              reason: null,
              items: [],
              arms: ARMS,
              interval: INTERVAL,
              regressions: 0,
              excluded: [],
              overlays: OVERLAYS,
            },
          };
        default:
          return assertNever(status);
      }
    case "case-bank":
      switch (status) {
        case "not-run":
          return {
            basis: "case-bank",
            status: "not-run",
            budget: NOT_PLANNED,
            tokens: ZERO_TOKENS,
            preregistration: null,
            replay: null,
            caseBank: null,
          };
        case "preregistered":
          return {
            basis: "case-bank",
            status: "preregistered",
            budget: PLANNED,
            tokens: ZERO_TOKENS,
            preregistration: CASE_BANK_PREREGISTRATION,
            replay: null,
            caseBank: null,
          };
        case "gate-accepted":
        case "gate-rejected":
        case "gate-abstained":
          return {
            basis: "case-bank",
            status,
            budget: SPENT,
            tokens: JUDGE_TOKENS,
            preregistration: CASE_BANK_PREREGISTRATION,
            replay: null,
            caseBank: { ...CASE_BANK_RESULT, verdict: status },
          };
        default:
          return assertNever(status);
      }
    default:
      return assertNever(basis);
  }
}

// The dispatch over the basis, which is the one the second base extends: a block whose `basis` this switch does not list
// leaves `gate` narrowed to a variant that is not `never`, so the call below stops compiling. That is the compile-time
// half of the record contract of M1c, and the reason `basis` and not `status` is the discriminator now.
function basisOf(gate: GateBlock): "replay" | "case-bank" {
  switch (gate.basis) {
    case "replay":
      return "replay";
    case "case-bank":
      return "case-bank";
    default:
      return assertNever(gate);
  }
}

// The dispatch over the status, with the basis read from the one function above: it is how a caller of the record names a
// block after M1c -- the status says what happened and the basis says which gate did it, and neither says both.
function stateOf(gate: GateBlock): string {
  switch (gate.status) {
    case "not-run":
      return `${basisOf(gate)}:not-run`;
    case "preregistered":
      return `${basisOf(gate)}:preregistered`;
    case "gate-accepted":
    case "gate-rejected":
    case "gate-abstained":
      return `${basisOf(gate)}:${gate.status}`;
    default:
      return assertNever(gate);
  }
}

test("GateBlock: every basis in every status is one variant, and the dispatch over them closes", () => {
  const states = BASES.flatMap((basis) =>
    GATE_STATUSES.map((status) => ({ gate: gateOf(basis, status), name: `${basis}:${status}` })),
  );

  // The ten records the six variants can hold -- two states without a result and three with one, in each base -- named
  // the way a dispatch that narrows by basis and then by status names them.
  assert.deepEqual(
    states.map((entry) => stateOf(entry.gate)),
    states.map((entry) => entry.name),
  );
});

// §TECHNICAL 3: gate.status and outcome.status are related by one mapping, and M1c did not touch it. This is the
// statement that it did not have to: the mapping reads a status and never a basis, so a case-bank gate that concluded
// maps exactly as a replay gate that concluded, and the totality is a property of the code.
test("outcomeStatusFor: total over GATE_STATUSES, the statuses both bases write", () => {
  const declared: readonly DecisionOutcomeStatus[] = [
    "proposed",
    "not-eligible",
    "gate-accepted",
    "gate-rejected",
    "gate-abstained",
    "accepted",
  ];

  for (const status of GATE_STATUSES) {
    const outcome = outcomeStatusFor(status);
    assert.equal(declared.includes(outcome), true, `the gate status ${status} maps to ${outcome}`);
  }

  // The second base holds one of those statuses in every state, and the block it writes is the argument of the same
  // call: the parameter of gateOf is GateStatus, so a status outside the mapping is a record this file cannot build.
  for (const status of GATE_STATUSES) {
    assert.equal(gateOf("case-bank", status).status, status);
  }
});
