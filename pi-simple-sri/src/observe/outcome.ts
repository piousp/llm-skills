import type { DirectionalGateResult } from "../gate/directional-flow.ts";
import type { GateConclusionReason, GateFlowResult } from "../gate/flow.ts";
import { assertNever } from "../types.ts";
import type { GateOutcomeClass } from "./types.ts";

// What the observer keeps of a gate answer: the class that drives the review, the status of the record outcome and the
// reason, as the gate-outcome event stores them.
export interface GateClassification {
  class: GateOutcomeClass;
  status: string;
  reason: string | null;
}

// Rejected: the runs were readable and the rule (or the judge) refused. Not measurable: the bank cannot tell the lesson
// from its absence. Retryable: the gate proved nothing, so it may be asked again.
function classOfReason(reason: GateConclusionReason): GateOutcomeClass {
  switch (reason) {
    case "below-threshold":
    case "judge-failed":
      return "rejected";
    case "no-improvement":
      return "not-measurable";
    case "interrupted":
    case "invalid-run":
    case "judge-unavailable":
    case "insufficient-items":
    case "no-model":
    case "skill-unavailable":
    case "overlay-failed":
    case "candidate-mismatch":
    case "origin-moved":
      return "retryable";
    default:
      return assertNever(reason);
  }
}

export function classifyGateResult(result: GateFlowResult | DirectionalGateResult): GateClassification {
  switch (result.kind) {
    case "refused":
      return { class: "retryable", status: "refused", reason: result.rejection.reason };
    case "no-baseline":
      return { class: "retryable", status: "no-baseline", reason: result.reason };
    case "gate-accepted":
      return { class: "accepted", status: result.kind, reason: null };
    case "gate-rejected":
      return {
        class: result.reason === null ? "rejected" : classOfReason(result.reason),
        status: result.kind,
        reason: result.reason,
      };
    case "gate-abstained":
      return {
        class: result.reason === null ? "retryable" : classOfReason(result.reason),
        status: result.kind,
        reason: result.reason,
      };
    default:
      return assertNever(result);
  }
}

// What a probation proposal carries instead of a gate result: the lesson was never compared against any case.
export const PROBATION_OUTCOME: GateClassification = { class: "not-measurable", status: "probation", reason: "not measured" };
