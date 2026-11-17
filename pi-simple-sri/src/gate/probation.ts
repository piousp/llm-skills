// Probation: a candidate no gate could measure, accepted by the user as it is. Two records come to it: the one a proposal wrote
// for a skill that cannot be replayed safely (the observer proposes it, src/observe/), where a gate would have nothing to run,
// and the one a case-bank gate concluded with `gate-abstained`/`no-improvement`, where the bank could not tell the lesson from
// its absence. The record says so with its own status and nothing is inferred from a verdict that never existed: a probation of
// the first kind has no preregistration and no result, `outcome.status` is "probation" in both.
//
// It is pure: no fs, no clock, no model. The acceptance (src/gate/acceptance.ts) takes the record as it takes any other and
// compares the SKILL.md against the digest the caller passes: the one recorded when the candidate was staged, never one computed
// when the user accepts, so a skill that changed since the staging is refused the way it is after a gate.

import { SriFailClosedError } from "../errors.ts";
import { outcomeStatusFor } from "../types.ts";
import type { DecisionRecord, GateBlock, GateCaseBankProbation, GateProbation } from "../types.ts";
import { quote } from "../values.ts";

// What the record says about why nothing was measured, so a reader of decision.json does not have to guess that an empty
// block means "not yet".
export const PROBATION_REASON = "not measured: no gate ran for this candidate";

// The record of a candidate that no gate measured: the one `not-run` replay record the proposal wrote, or the concluded
// case-bank record whose gate abstained for `no-improvement` (its basis, preregistration and result stay in the record), with
// the digest of the SKILL.md as it was at the staging and the moment. Any other record is refused, because turning a gated
// record into a probation one would erase a verdict.
export function probationRecordOf(record: DecisionRecord, skillContentHash: string, now: Date): DecisionRecord {
  const gate = record.gate;
  const decidedAt = now.toISOString();
  const probation = { recordedAt: decidedAt, skillContentHash };
  const outcome = { status: outcomeStatusFor("probation"), reason: PROBATION_REASON, decidedAt };

  if (gate.basis === "replay" && gate.status === "not-run") {
    const block: GateProbation = {
      basis: "replay",
      status: "probation",
      budget: gate.budget,
      tokens: gate.tokens,
      preregistration: null,
      replay: null,
      probation,
    };
    return { ...record, gate: block, outcome };
  }

  if (gate.basis === "case-bank" && gate.status === "gate-abstained" && gate.caseBank.reason === "no-improvement") {
    const block: GateCaseBankProbation = { ...gate, status: "probation", probation };
    return { ...record, gate: block, outcome };
  }

  throw new SriFailClosedError(
    `only a candidate that was proposed and not gated, or one a bank could not measure, can be put on probation: the record is ${quote(gate.basis)}/${quote(gate.status)}`,
  );
}

// The digest of the SKILL.md the acceptance compares against the skill, wherever the block keeps it: the preregistration of a
// gate that measured, the probation key of one that did not. Null when the block recorded none, which the caller refuses
// instead of accepting under a hash nobody recorded.
export function recordedSkillHashOf(gate: GateBlock): string | null {
  if (gate.status === "probation") return gate.probation.skillContentHash;
  return gate.preregistration?.skillContentHash ?? null;
}
