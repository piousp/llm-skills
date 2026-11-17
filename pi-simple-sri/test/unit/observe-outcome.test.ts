import { test } from "node:test";
import assert from "node:assert/strict";
import { PROBATION_OUTCOME, classifyGateResult } from "../../src/observe/outcome.ts";
import type { GateConcludedResult, GateConclusionReason, GateFlowResult } from "../../src/gate/flow.ts";
import type { DirectionalGateResult } from "../../src/gate/directional-flow.ts";
import type { GateVerdict } from "../../src/gate/types.ts";

function concluded(kind: GateVerdict, reason: GateConclusionReason | null): GateConcludedResult {
  return {
    kind,
    reason,
    stagingPath: "staging/s/c",
    decisionPath: "staging/s/c/decision.json",
    plannedRuns: 12,
    usedRuns: 12,
    overlays: null,
  };
}

test("classifyGateResult: gate-accepted is accepted and carries no reason", () => {
  assert.deepEqual(classifyGateResult(concluded("gate-accepted", null)), {
    class: "accepted",
    status: "gate-accepted",
    reason: null,
  });
});

test("classifyGateResult: the two rejections of the rule are rejected", () => {
  assert.deepEqual(classifyGateResult(concluded("gate-rejected", "below-threshold")), {
    class: "rejected",
    status: "gate-rejected",
    reason: "below-threshold",
  });
  assert.deepEqual(classifyGateResult(concluded("gate-rejected", "judge-failed")), {
    class: "rejected",
    status: "gate-rejected",
    reason: "judge-failed",
  });
});

test("classifyGateResult: no-improvement on an existing bank is not measurable, not a rejection", () => {
  assert.deepEqual(classifyGateResult(concluded("gate-abstained", "no-improvement")), {
    class: "not-measurable",
    status: "gate-abstained",
    reason: "no-improvement",
  });
});

const RETRYABLE_REASONS: GateConclusionReason[] = [
  "interrupted",
  "invalid-run",
  "judge-unavailable",
  "insufficient-items",
  "no-model",
  "skill-unavailable",
  "overlay-failed",
  "candidate-mismatch",
  "origin-moved",
];

for (const reason of RETRYABLE_REASONS) {
  test(`classifyGateResult: abstention ${reason} is retryable`, () => {
    assert.deepEqual(classifyGateResult(concluded("gate-abstained", reason)), {
      class: "retryable",
      status: "gate-abstained",
      reason,
    });
  });
}

test("classifyGateResult: an abstention without a reason is retryable, a rejection without one is rejected", () => {
  assert.equal(classifyGateResult(concluded("gate-abstained", null)).class, "retryable");
  assert.equal(classifyGateResult(concluded("gate-rejected", null)).class, "rejected");
});

test("classifyGateResult: a refusal is retryable and names its reason", () => {
  const refused: GateFlowResult = { kind: "refused", rejection: { reason: "already-concluded", detail: "x" } };

  assert.deepEqual(classifyGateResult(refused), { class: "retryable", status: "refused", reason: "already-concluded" });
});

test("classifyGateResult: no-baseline is retryable and carries the reader's reason", () => {
  const none: DirectionalGateResult = {
    kind: "no-baseline",
    reason: "bank-missing",
    stagingPath: "staging/s/c",
    decisionPath: "staging/s/c/decision.json",
    plannedRuns: 0,
    usedRuns: 0,
    overlays: null,
  };

  assert.deepEqual(classifyGateResult(none), { class: "retryable", status: "no-baseline", reason: "bank-missing" });
});

test("classifyGateResult: an unknown reason is refused with its own value, never swallowed", () => {
  const bogus = concluded("gate-abstained", "made-up" as unknown as GateConclusionReason);

  assert.throws(() => classifyGateResult(bogus), /made-up/);
});

test("PROBATION_OUTCOME: not measurable, status probation, reason 'not measured'", () => {
  assert.deepEqual(PROBATION_OUTCOME, { class: "not-measurable", status: "probation", reason: "not measured" });
});
