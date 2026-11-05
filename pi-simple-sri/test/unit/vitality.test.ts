import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerLine, ReadAttemptLine } from "../../src/ledger.ts";
import { ACCEPTED_EVENT, isLater, isRetired } from "../../src/vitality.ts";

// The rule of force of an accepted lesson, in isolation (M3): the predicate src/metrics.ts builds the denominator of the
// recurrence with and the one src/standing.ts walks its checks with, now that the two copies have one owner. The ledger is
// built by hand and no file is read -- the module is arithmetic over a value, and a fixture on disk would prove
// src/ledger.ts a second time, the reason test/unit/metrics.test.ts gives for its own fixtures. There is one test per
// condition of the rule, so a change that drops one of them fails here under the name of the condition it dropped.

const SKILL = "pdf-tools";
const TS = "2026-11-04T09:00:00.000Z";
const LATER = "2026-11-05T09:00:00.000Z";
const EARLIER = "2026-11-03T09:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;
const UNPARSEABLE = "not a moment";

// One line of the index as the reader of src/ledger.ts hands it: `event` is a plain string, because the vocabulary of the
// writer is not the vocabulary of the reader -- a line of a later version may carry a name this one cannot classify -- and
// that is the reason the predicates of src/vitality.ts compare literals.
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
    targetSkill: options.skill ?? SKILL,
  };
}

// The line of the index the rule is asked about: the acceptance, without the record it names, because the force of a
// lesson does not depend on it -- an accepted line whose record is gone is still in force until a retirement takes it away.
function accepted(ts: string = TS): LedgerLine {
  return { index: 0, line: lineOf(ACCEPTED_EVENT, { ts }), record: null, recordPath: null };
}

function entryOf(index: number, line: ReadAttemptLine): LedgerLine {
  return { index, line, record: null, recordPath: null };
}

// Condition 1: the event. Only a line the retirement wrote takes the force away, and the fixture uses ACCEPTED_EVENT so
// the constant this module exports is the one the rule compares a lesson against.
test("isRetired: a later retired line of the same skill and candidate retires the lesson", () => {
  const lesson = accepted();
  const lines = [lesson, entryOf(1, lineOf("retired", { ts: LATER }))];

  assert.equal(isRetired(lesson, lines), true);
});

// Condition 2: the moment. A retirement written before the acceptance cannot take away a force that did not exist yet, and
// the comparison is of instants and not of strings.
test("isRetired: a retired line earlier than the acceptance retires nothing", () => {
  const lesson = accepted();
  const lines = [entryOf(1, lineOf("retired", { ts: EARLIER })), lesson];

  assert.equal(isRetired(lesson, lines), false);
});

// Condition 3: the skill. A candidateHash is the tie with an acceptance of one skill, and two skills hold their own
// lessons however alike the hashes are.
test("isRetired: a retired line of another skill retires nothing", () => {
  const lesson = accepted();
  const lines = [lesson, entryOf(1, lineOf("retired", { skill: "code-review", ts: LATER }))];

  assert.equal(isRetired(lesson, lines), false);
});

// Condition 4: the timestamp is data and not a promise. A moment nothing can parse is later than nothing, so a damaged line
// neither retires a lesson nor is retired by one -- the alternative, comparing the strings, would let "not a moment" sort
// after an ISO date-time and invent a retirement out of a truncated append.
test("isRetired: an unparseable moment neither retires nor is retired", () => {
  const lesson = accepted();
  const damaged = accepted(UNPARSEABLE);

  assert.equal(isLater(UNPARSEABLE, TS), false);
  assert.equal(isLater(TS, UNPARSEABLE), false);
  assert.equal(isRetired(lesson, [lesson, entryOf(1, lineOf("retired", { ts: UNPARSEABLE }))]), false);
  assert.equal(isRetired(damaged, [damaged, entryOf(1, lineOf("retired", { ts: LATER }))]), false);
});
