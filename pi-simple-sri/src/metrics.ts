import { isKnownAttemptEvent } from "./attempts.ts";
import type { Ledger, LedgerLine } from "./ledger.ts";
import type { GateBlock, GateStatus, ReplayRunRecord } from "./types.ts";

// The metrics of the series of sessions (M3, S2; OA5 of the plan with the third amendment of the author): the numbers
// the exit criterion of the milestone is written with, projected from the ledger and from nothing else.
//
// What it is not. It is not a reader: src/ledger.ts hands it the lines and the records they name, and this module opens
// no file, starts no process, reads no clock and calls no model. It is not a cache: the rates are recomputed from the
// ledger on every call, because a stored number goes wrong the day `staging/` is pruned and correcting it would be a
// second rule -- the invalidation of the cache -- that nothing in the goal asks for. And it is not a judge: it counts
// what the gate and the acceptance already decided, because re-deriving a verdict from the runs would be a second gate
// that could disagree with the first.
//
// Two rates and one column of support (OA5, amendment 3). `acceptanceRate` is the share of the attempts that reached a
// gate that the acceptance accepted. `recurrenceRate` is the definition the author gave of a regression -- going back to
// a path that had already been corrected -- read as "of the accepted lessons still in force, how many came back". It is
// not called a regression rate because `regressions` is already a number of the gate with another meaning: that one
// travels as `gateRegressionRate`, over the pairs the gate replayed, and it supports the other two instead of replacing
// them.
//
// The key of a recurrence is the class of failure and not the stored signature (OA5, amendment 3). A signature is
// computed over the ids of evidence (src/diagnosis.ts) and every id carries the timestamp of its failure
// (src/evidence.ts), so two sessions that hit the same wall never produce the same one. `failureClassesOf` is the
// comparable key -- `<kind>:<tool>` over the evidence of a record, derived here at read time, with no field of the
// contract touched. It is coarser than the signature on purpose: it says that a `tool_error` in `read` came back, not
// that the same failure did, which is the granularity the author confirmed ("the simplest thing first").
//
// The coverage travels in the answer (rule 5). `records` counts the lines whose record resolved and the ones that named
// a record that is no longer there, because `historyPath` points inside the skill and `decisionPath` points into a
// `staging/` anybody may prune: a rate printed without its coverage claims a measurement over records never read.
//
// D-B is the last number (rule 8, OA9 of the plan). Among the items of the fourth class that the gate ran, a failed run
// without `checkFailures` is a turn a tool sank before there was text to judge, and one with the list is a turn whose
// text did not pass (src/gate/expectation.ts, checksOutcome). The split is read off records already written, and it is
// what lets the unanimity rule be discussed with a number instead of an anecdote.

// The key of the events this version cannot name (rule 1). The vocabulary belongs to the writer (src/attempts.ts) and
// the type of the reader is wider on purpose (src/ledger.ts), so a line of a later version is counted under a key that
// says so: dropping it would leave a total smaller than the number of lines the index has.
const UNKNOWN_EVENT = "unknown";

// The tool of an evidence class that watches no tool. "-" and not the empty string: the key is read by a human, and
// "user_correction:-" says out loud that the class is the whole of it.
const NO_TOOL = "-";

// The event the retirement writes (rule 6). S4 wrote the name into ATTEMPT_EVENTS (src/attempts.ts), and the literal stays
// here on purpose: what this module compares is the `event` of a line read from the index -- a string the tolerant reader
// keeps verbatim -- and not the type of the writer, which is the narrower of the two.
const RETIRED_EVENT = "retired";

// The three statuses of a gate that concluded, of either basis (rule 2). The two that are absent are a gate that never
// ran and one that only preregistered its rule, and neither measured a thing a rate could be built on.
const CONCLUDED_GATE_STATUSES = ["gate-accepted", "gate-rejected", "gate-abstained"] as const;

type ConcludedGateStatus = (typeof CONCLUDED_GATE_STATUSES)[number];

function isConcludedGateStatus(status: GateStatus): status is ConcludedGateStatus {
  return CONCLUDED_GATE_STATUSES.some((concluded) => concluded === status);
}

// What the gate concluded, as the report reads it. `attempts` is derived and not counted: it is the sum of the three
// verdicts below, computed where they are counted, so the total of the report and its parts cannot disagree.
//
// The three are counted by the event of the line and not by the record it names, because an abstention that ended before
// the budget leaves the record in "not-run" or "preregistered" with the line of the index already written
// (src/gate/flow.ts): demanding a concluded record of the three would drop real abstentions from the report. The pairs of
// the regression are the other way round -- they come from the record, because a gate that did not conclude replayed no
// pair a regression could be counted over.
export interface GateTally {
  attempts: number; // accepted + rejected + abstained, by construction (see gateCountsOf)
  accepted: number;
  rejected: number;
  abstained: number;
  pairs: number; // the runs of the incumbent arm of every concluded gate: the denominator of the regression rate
  regressions: number; // the pairs the incumbent passed and the candidate failed (src/gate/scorer.ts, regressionsOf)
}

// One row of the report per skill, with the three verdicts of the gate and the two numbers of the recurrence. The
// lesson counts are here and not in the ledger because a lesson is a fact of a skill: the same lesson is one entry of
// this row and never a row of its own.
export interface SkillTally {
  skill: string;
  accepted: number;
  rejected: number;
  abstained: number;
  recurrences: number; // lessons of this skill that came back
  lessons: number; // lessons of this skill that are accepted and still in force
}

export interface Metrics {
  attempts: Record<string, number>; // only the events that appear, plus "unknown" (rule 1)
  gated: GateTally;
  bySkill: readonly SkillTally[];
  records: { present: number; missing: number };
  acceptanceRate: number; // 0 when the denominator is 0 (rule 4)
  recurrenceRate: number;
  gateRegressionRate: number;
  buried: { toolError: number; text: number }; // the split of D-B over the items of the fourth class (rule 8)
}

// The key that names a class of failure, comparable between sessions: the sorted set of `<kind>:<tool>` over the
// evidence of one record, with "-" for the classes that watch no tool. It lives here and not in the record because what
// a record stores names one failure of one transcript, and the class is the only thing two sessions can share.
//
// The parameter is structural and not EvidenceItem: the key is made of two fields, and a caller may pass the evidence of
// a record as it read it without this module depending on the rest of the shape of the item.
export function failureClassesOf(evidence: readonly { kind: string; toolName?: string }[]): string[] {
  return [...new Set(evidence.map((item) => `${item.kind}:${item.toolName ?? NO_TOOL}`))].sort();
}

// The whole report, from the ledger and from nothing else.
export function metricsOf(ledger: Ledger): Metrics {
  const { gated, buried } = gateCountsOf(ledger.lines);
  const bySkill = skillTalliesOf(ledger.lines);

  return {
    attempts: attemptCountsOf(ledger.lines),
    gated,
    bySkill,
    records: coverageOf(ledger.lines),
    // Rule 4, on the denominator the lens names: the attempts that reached a gate, which is `gated.attempts` because that
    // field is the three verdicts by construction (see GateTally) and not a count of the records with a concluded gate. The
    // rate whose denominator is 0 is 0, and the text that prints it says so in words instead of printing "0.00" as if a
    // measurement had happened (src/messages.ts).
    acceptanceRate: rateOf(gated.accepted, gated.attempts),
    recurrenceRate: rateOf(totalOf(bySkill, "recurrences"), totalOf(bySkill, "lessons")),
    gateRegressionRate: rateOf(gated.regressions, gated.pairs),
    buried,
  };
}

// Rule 1: one count per line, under the event when this version knows it and under "unknown" when it does not. The
// vocabulary is not filled with zeros: a report with twelve zeros hides the fact that there were no attempts at all.
function attemptCountsOf(lines: readonly LedgerLine[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const { line } of lines) {
    const key = isKnownAttemptEvent(line.event) ? line.event : UNKNOWN_EVENT;
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return counts;
}

// Rule 5: the two halves of the coverage. A line that names no record at all -- a refusal that answered before a
// candidate existed -- is neither present nor missing: there was nothing to read, and the line says so.
function coverageOf(lines: readonly LedgerLine[]): { present: number; missing: number } {
  const coverage = { present: 0, missing: 0 };

  for (const entry of lines) {
    if (entry.record !== null) coverage.present += 1;
    else if (entry.problem !== undefined) coverage.missing += 1;
  }

  return coverage;
}

// The numbers of the gate and the split of D-B, read in one pass because they come from one record (rules 2, 3 and 8).
function gateCountsOf(
  lines: readonly LedgerLine[],
): { gated: GateTally; buried: { toolError: number; text: number } } {
  const gated: GateTally = { attempts: 0, accepted: 0, rejected: 0, abstained: 0, pairs: 0, regressions: 0 };
  const buried = { toolError: 0, text: 0 };

  for (const entry of lines) {
    const verdict = verdictOf(entry);
    if (verdict === "accepted") gated.accepted += 1;
    if (verdict === "rejected") gated.rejected += 1;
    if (verdict === "abstained") gated.abstained += 1;

    if (entry.record === null) continue;
    const reading = gateReadingOf(entry.record.gate);
    if (reading === null) continue;

    // Rule 3: a gate that did not conclude contributes no pair, and the pairs it did replay are the runs of the
    // incumbent arm -- the same arm the regression counts compare against.
    gated.pairs += reading.pairs;
    gated.regressions += reading.regressions;
    buried.toolError += reading.buried.toolError;
    buried.text += reading.buried.text;
  }

  // Rule 2: the total is the sum of the three verdicts, computed in the one place that counts them. It is not counted on
  // its own, because a total counted from the records answers a smaller number for the same ledger -- see GateTally -- and a
  // report whose total does not add up is worse than a report that is not there.
  gated.attempts = gated.accepted + gated.rejected + gated.abstained;

  return { gated, buried };
}

// The verdict a line reports, or null for every other line (rule 2). The acceptance is the one verdict whose record has
// to agree -- the line `accepted` is the one the acceptance writes and the `.history/` record is what backs it -- and the
// two refusals are read off the line alone, because their record is not authoritative about them: the abstentions that
// end before the budget leave it in "not-run" or "preregistered" while the line already carries the answer
// (src/gate/flow.ts, answerGateConclusion).
function verdictOf(entry: LedgerLine): "accepted" | "rejected" | "abstained" | null {
  switch (entry.line.event) {
    case "accepted":
      return entry.record !== null && entry.record.outcome.status === "accepted" ? "accepted" : null;
    case "gate-rejected":
      return "rejected";
    case "gate-abstained":
      return "abstained";
    default:
      // The open event of the tolerant reader: a name this version cannot classify is not a verdict of the gate, and
      // neither is a refusal that answered before there was anything to measure.
      return null;
  }
}

// What one concluded gate adds to the report: the pairs of its incumbent arm, the regressions it counted and the split of
// D-B over the items it ran.
interface GateReading {
  pairs: number;
  regressions: number;
  buried: { toolError: number; text: number };
}

// The numbers a concluded gate contributes, or null when it did not conclude (rules 2, 3 and 8). The result of the gate
// lives under the key of its basis, and the null of the other key is the guard: `replay` is null in the three states of
// the case-bank base and `caseBank` does not exist on the blocks of the replay base (src/types.ts).
function gateReadingOf(gate: GateBlock): GateReading | null {
  if (!isConcludedGateStatus(gate.status)) return null;

  if (gate.basis === "case-bank") {
    const result = gate.caseBank;
    if (result === null) return null;

    // Rule 8: every case of a bank is an item of the fourth class -- its `checks` are the predicates a turn is judged
    // by -- so a run of a case is a run of a quality_defect item and there is no expectation to filter on.
    const buried = { toolError: 0, text: 0 };
    for (const bankCase of result.cases) countBuriedRuns(bankCase.reps, buried);

    return { pairs: result.arms.incumbent.runs, regressions: result.regressions, buried };
  }

  const result = gate.replay;
  if (result === null) return null;

  // Rule 8: only the items of the fourth class are judged by a text. A tool class and a correction are judged by the
  // calls of the turn, so their failures are outside the split of D-B.
  const buried = { toolError: 0, text: 0 };
  for (const item of result.items) {
    if (item.expectation.class !== "quality_defect") continue;
    countBuriedRuns(item.reps, buried);
  }

  return { pairs: result.arms.incumbent.runs, regressions: result.regressions, buried };
}

// Why a failed run of an item of the fourth class failed, in the two causes the record already tells apart (rule 8):
// a fail without `checkFailures` was sunk by an `isError` before there was text to judge, and a fail with the list is a
// text that did not pass the checks of the item.
function countBuriedRuns(runs: readonly ReplayRunRecord[], buried: { toolError: number; text: number }): void {
  for (const run of runs) {
    // A run that is not a failure measured nothing: it is neither a tool nor a text, and an `invalid` run counted in
    // either column would attribute a cause to a run that produced no verdict.
    if (run.outcome !== "fail") continue;
    if (run.checkFailures === undefined || run.checkFailures.length === 0) buried.toolError += 1;
    else buried.text += 1;
  }
}

// Rule 9: one row per skill the index names, sorted by name, with the three verdicts of the gate and the two numbers of
// the recurrence.
function skillTalliesOf(lines: readonly LedgerLine[]): SkillTally[] {
  const tallies = new Map<string, SkillTally>();

  // An attempt that answered nothing -- a refusal, a proposal, a gate that abstained -- still names the skill it was
  // about, so the row exists even when every counter of it stays at zero: hiding the skill would hide the attempts.
  for (const entry of lines) {
    const tally = tallyFor(tallies, entry.line.targetSkill);
    const verdict = verdictOf(entry);
    if (verdict === "accepted") tally.accepted += 1;
    if (verdict === "rejected") tally.rejected += 1;
    if (verdict === "abstained") tally.abstained += 1;
  }

  for (const lesson of lessonsOf(lines)) {
    const tally = tallyFor(tallies, lesson.skill);
    tally.lessons += 1;
    if (recurred(lesson, lines)) tally.recurrences += 1;
  }

  return [...tallies.values()].sort(bySkillName);
}

// The row of a skill, created on first sight. The map is the state of this function and does not outlive the call, so
// two calls over the same ledger answer the same rows.
function tallyFor(tallies: Map<string, SkillTally>, skill: string): SkillTally {
  const known = tallies.get(skill);
  if (known !== undefined) return known;

  const created: SkillTally = { skill, accepted: 0, rejected: 0, abstained: 0, recurrences: 0, lessons: 0 };
  tallies.set(skill, created);
  return created;
}

// The order of the report is the name of the skill, compared the way the default sort of strings compares: the same
// order src/diagnosis.ts gives the names of the tools of a diagnosis, so two reports of one ledger never disagree about
// which row comes first.
function bySkillName(left: SkillTally, right: SkillTally): number {
  if (left.skill < right.skill) return -1;
  return left.skill > right.skill ? 1 : 0;
}

// A lesson of the ledger that is accepted and still in force (rules 6 and 7): the acceptance of rule 2, its moment in
// the index, and the classes of failure it corrected.
interface AcceptedLesson {
  index: number; // the position of its own line, which is how it is kept from being its own recurrence
  skill: string;
  ts: string;
  classes: string[];
}

// Rule 6: the lines `accepted` whose candidate no later `retired` line of the same skill names. The acceptance used here
// is the one of rule 2, so every accepted lesson is also an accepted attempt and the two counts of the report cannot
// disagree about what an acceptance is.
//
// The classes of a lesson are the ones of the evidence of its own record: they are the failures it corrected, which is
// the path a recurrence goes back to. A lesson whose record is gone has no class to come back to and cannot recur.
function lessonsOf(lines: readonly LedgerLine[]): AcceptedLesson[] {
  const lessons: AcceptedLesson[] = [];

  for (const entry of lines) {
    if (verdictOf(entry) !== "accepted") continue;
    if (isRetired(entry, lines)) continue;

    lessons.push({
      index: entry.index,
      skill: entry.line.targetSkill,
      ts: entry.line.ts,
      classes: entry.record === null ? [] : failureClassesOf(entry.record.evidence),
    });
  }

  return lessons;
}

// Rule 6: the candidate of the line is no longer in force when another line of the same skill names the same candidate
// as `retired` and is later. That event is the one the retirement of S4 (OA4) writes, and the comparison is against the
// literal because a line of the index carries a string the tolerant reader keeps verbatim: the vocabulary of
// src/attempts.ts is the type of the writer, and this module reads what the index holds.
function isRetired(lesson: LedgerLine, lines: readonly LedgerLine[]): boolean {
  return lines.some(
    (entry) =>
      entry.line.event === RETIRED_EVENT &&
      entry.line.targetSkill === lesson.line.targetSkill &&
      entry.line.candidateHash === lesson.line.candidateHash &&
      isLater(entry.line.ts, lesson.line.ts),
  );
}

// Rule 7: a lesson came back when a later line of the same skill names a record whose classes of failure cut the ones
// the lesson corrected. The answer is a boolean and not a count because "it came back" is a fact of the lesson and not
// of every attempt that proves it: a lesson that recurred five times recurred once.
//
// The line of the lesson itself is excluded twice on purpose -- by its index and by the strict comparison of moments --
// because a lesson is not its own recurrence, and a line of the same moment is a line of the same attempt.
function recurred(lesson: AcceptedLesson, lines: readonly LedgerLine[]): boolean {
  if (lesson.classes.length === 0) return false;

  return lines.some(
    (entry) =>
      entry.index !== lesson.index &&
      entry.line.targetSkill === lesson.skill &&
      // A line whose record is gone proves no failure, so it cannot prove that one came back.
      entry.record !== null &&
      isLater(entry.line.ts, lesson.ts) &&
      intersects(failureClassesOf(entry.record.evidence), lesson.classes),
  );
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  return left.some((key) => right.includes(key));
}

// Whether one moment of the index is later than another. The two are compared as instants and not as strings: the
// spelling is an ISO date-time written by one clock (src/attempts.ts), and parsing them answers the order without a
// clock of this module. A moment nothing can parse is later than nothing, which keeps a damaged timestamp from
// inventing a retirement or a recurrence.
function isLater(ts: string, than: string): boolean {
  const moment = Date.parse(ts);
  const other = Date.parse(than);
  return Number.isFinite(moment) && Number.isFinite(other) && moment > other;
}

// Rule 4: the rate nobody measured is 0. The text that prints it names the empty denominator in words (src/messages.ts),
// so a zero here is never read as "measured zero".
function rateOf(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function totalOf(tallies: readonly SkillTally[], key: "recurrences" | "lessons"): number {
  return tallies.reduce((total, tally) => total + tally[key], 0);
}
