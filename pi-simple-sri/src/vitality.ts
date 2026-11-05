import type { LedgerLine } from "./ledger.ts";

// The force of an accepted lesson (M3): the one owner of the rule that says when an acceptance stops applying. It was
// written twice before, with the same body, in src/metrics.ts (the denominator of the recurrence) and in src/standing.ts
// (the set of lessons the check walks), and each copy carried a comment asking the two to move together -- which is the way
// of saying that neither of them owned the rule.
//
// What is owned here: the two predicates the rule is made of -- whether a `retired` line of the index retires a lesson
// (`isRetired`), and whether one moment of the index is later than another (`isLater`) -- and the literal of the event the
// acceptance writes (`ACCEPTED_EVENT`). A caller that needs the rule imports it, so a change to it is one edit instead of
// two that have to agree.
//
// What is not owned here, on purpose: the reading of "accepted". The two callers disagree about it and both are right.
// src/metrics.ts demands the event `accepted` and a record whose `outcome.status` is "accepted", because an acceptance
// whose record cannot be read has no classes of failure to come back to and does not enter the denominator of the
// recurrence. src/standing.ts demands the event alone and counts the acceptance with no record apart, in `missingRecords`,
// because a lesson nobody can compare against its record is a hole in the coverage and not a lesson out of force. A shared
// `isInForce` would have to pick one of the two readings and the other one would move a number, so this module exports no
// such predicate: each caller keeps its own, and only the retirement itself is shared.
//
// It is pure: no fs, no clock, no state. `isLater` parses the two moments it is handed -- arithmetic over strings and not a
// reading of the clock -- and nothing here survives a call. The one import is the type of a line of the index, and it is
// type-only: this module keeps no runtime edge to the reader of the ledger.

// The event the acceptance writes, which is the one a lesson in force comes from. What a caller compares against it is the
// `event` of a line read from the index, which the tolerant reader keeps verbatim (src/ledger.ts): a line of a later
// version may carry a name this one cannot classify, so the comparison is against the literal and not against the narrower
// type of the writer (src/attempts.ts).
export const ACCEPTED_EVENT = "accepted";

// The event the retirement writes (rule 6). S4 wrote the name into ATTEMPT_EVENTS (src/attempts.ts), and the literal stays
// here on purpose: what this module compares is the `event` of a line read from the index -- a string the tolerant reader
// keeps verbatim -- and not the type of the writer, which is the narrower of the two.
const RETIRED_EVENT = "retired";

// Rule 6: the candidate of the line is no longer in force when another line of the same skill names the same candidate
// as `retired` and is later. That event is the one the retirement of S4 (OA4) writes, and the comparison is against the
// literal because a line of the index carries a string the tolerant reader keeps verbatim: the vocabulary of
// src/attempts.ts is the type of the writer, and this module reads what the index holds.
//
// Each of the four conditions is load-bearing: the event is what makes a line a retirement at all, the skill is the scope
// of a candidate -- two skills can hold a lesson of the same hash -- the candidate is the tie with the acceptance, and the
// moment is what keeps a retirement written before the acceptance from taking it away.
export function isRetired(lesson: LedgerLine, lines: readonly LedgerLine[]): boolean {
  return lines.some(
    (entry) =>
      entry.line.event === RETIRED_EVENT &&
      entry.line.targetSkill === lesson.line.targetSkill &&
      entry.line.candidateHash === lesson.line.candidateHash &&
      isLater(entry.line.ts, lesson.line.ts),
  );
}

// Whether one moment of the index is later than another. The two are compared as instants and not as strings: the
// spelling is an ISO date-time written by one clock (src/attempts.ts), and parsing them answers the order without a
// clock of this module. A moment nothing can parse is later than nothing, which keeps a damaged timestamp from
// inventing a retirement or a recurrence.
export function isLater(ts: string, than: string): boolean {
  const moment = Date.parse(ts);
  const other = Date.parse(than);
  return Number.isFinite(moment) && Number.isFinite(other) && moment > other;
}
