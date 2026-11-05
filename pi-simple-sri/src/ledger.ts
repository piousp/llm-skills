import fs from "node:fs";
import path from "node:path";
import { ATTEMPTS_FILE } from "./names.ts";
import { DECISION_SCHEMA } from "./types.ts";
import type { AttemptLine, DecisionRecord, Result } from "./types.ts";
import { describe, errorCode, isMissingPathError, isPlainObject, quote, toErrorMessage } from "./values.ts";
import { stateDir } from "./write-base.ts";

// The reader of the index of attempts (Q14) and of the decision.json each of its lines names. It is the other half
// of appendAttemptLine (src/writer.ts), and until M3 the index had three writers and no reader at all: the series of
// sessions could not be counted, and the exit criterion of the milestone is a count.
//
// What it reads: the lines of <base>/state/attempts.jsonl, one JSON event per line, and the record the line points
// at. What it does not decide: whether an attempt was good, whether a lesson deserves to retire, whether a skill is
// where it should be. Those are judgements of other modules over the value this one answers.
//
// Why it is tolerant, which is the whole design of the module: the type of the writer is not the type of the reader.
// `AttemptLine.event` is KnownAttemptEvent because only buildAttemptLine decides what this version emits
// (src/attempts.ts), and a line read here may carry an event a later version wrote. A reader that refused it would
// lose the lines it can still understand -- the same reason isAttemptEvent and isKnownAttemptEvent are two
// predicates and not one. So `event` is a string in ReadAttemptLine, an unknown event is kept verbatim and counted
// like any other line, and nothing here normalizes or rewrites what it read.
//
// The one thing that stops the reading is a line nothing can interpret. A file of one JSON object per line has no
// way back from its first illegible line: the truncated tail of an interrupted append is that line, and whatever
// follows it addresses no event either. The lines before it are answered and `damaged` names the position and the
// problem, so a caller reports a series that stops where the file broke instead of one with a silent gap.
//
// It never writes. No mkdir, no writeFile, no rename, no rm: reading is not a privilege that has to be defended, so
// this module has no perimeter and no mutation queue, and the base is resolved with path.resolve instead of being
// required absolute the way the write chokepoint requires it.
//
// The one write it reads is the record of a gate, and only its version and its spine: the whole shape of decision.json is
// the business of the gate (readStagedDecision in src/gate/flow.ts), which this module does not import. A record exists
// here to be counted next to the line that named it, not to be gated a second time.
//
// The spine is what the three consumers of this reader dereference -- `skill.realDir` and the four strings of `candidate`
// (src/standing.ts and the retirement flow), `evidence` and `outcome.status` (src/metrics.ts) -- and every one of those
// fields is a required key of schemas/decision.schema.json, so no record this package wrote is refused. That guard is
// narrow on purpose: a block nested deeper and malformed (a `gate.caseBank` without `cases`) stays the problem of the
// consumer that reads it, because validating the whole document here would be a second implementation of the schema at
// run time, and DEVELOPER.md rejects that by design. The limit is written down, not hidden.

// The version of decision.json this reader opens has one owner, src/types.ts, where the literal and the type of the
// field are declared together (DECISION_SCHEMA). This module imports it instead of spelling it a second time, and the
// imported value is typed DecisionSchema, so a @2 in src/types.ts breaks the type and this guard at compile time instead
// of leaving a comparison that silently never fires.

// The line as a reader sees it: `event` is a string, because the vocabulary of the writer is not the vocabulary of
// the reader -- an index written by a later version carries events this one cannot name, and a reader that refused
// them would lose the lines it can still understand.
export interface ReadAttemptLine extends Omit<AttemptLine, "event"> {
  event: string;
}

export interface LedgerLine {
  index: number; // 0-based, the position of the line in the file
  line: ReadAttemptLine;
  record: DecisionRecord | null; // the decision.json this line names, resolved
  recordPath: string | null; // absolute, or null when the line names no record
  problem?: string; // why `record` is null although the line named one
}

export interface Ledger {
  lines: LedgerLine[];
  damaged: { index: number; problem: string } | null;
}

// Every line of the index, in the order of the file, each with the record it names.
//
// An absent index is not an error: a package just installed has no attempts yet, and a caller asking for the series
// of a machine that never ran one deserves an empty answer and not an exception. Any other failure of this read is
// not a case this module can answer -- a permission or an EIO over the index is the state of the machine -- and it
// travels as it is. The record of a line is the other way round: it is an annex of a line that was already read, so
// failing to open it is a `problem` of the line even when the failure is a permission.
export async function readLedger(base: string): Promise<Ledger> {
  const resolvedBase = path.resolve(base);
  const indexPath = path.join(stateDir(resolvedBase), ATTEMPTS_FILE);

  let text: string;
  try {
    text = await fs.promises.readFile(indexPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return { lines: [], damaged: null };
    throw error;
  }

  // The append writes the newline with the line, so the last element of the split is the text after that newline and
  // not a line of the index. Only that one is dropped: an empty line anywhere else is a line nothing can interpret,
  // and it is named as damaged where it is instead of being skipped as if the file were shorter.
  const rawLines = text.split("\n");
  if (rawLines[rawLines.length - 1] === "") rawLines.pop();

  const lines: LedgerLine[] = [];
  for (const [index, raw] of rawLines.entries()) {
    const parsed = parseLine(indexPath, raw);
    if (!parsed.ok) return { lines, damaged: { index, problem: parsed.error } };

    const resolved = await resolveRecord(resolvedBase, parsed.value);
    lines.push({
      index,
      line: parsed.value,
      record: resolved.record,
      recordPath: resolved.recordPath,
      ...(resolved.problem === undefined ? {} : { problem: resolved.problem }),
    });
  }

  return { lines, damaged: null };
}

// One line of the index as a value, or the reason it is not one. The index names the file and not the position,
// because the position is `damaged.index` and the caller that reports it already has it.
function parseLine(indexPath: string, raw: string): Result<ReadAttemptLine, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `${quote(indexPath)}: ${toErrorMessage(error)}` };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: `${quote(indexPath)}: not an attempt line: it is ${describe(parsed)}` };
  }

  // The event is the only field the entry needs: it is what the line is about, and a line without one has nothing a
  // reader could group it by. The rest of the shape is not validated here -- a field of a later version is additive
  // and optional by the rules of src/attempts.ts, and a reader that demanded the fields it knows would refuse the
  // lines it should still read.
  if (typeof parsed.event !== "string" || parsed.event === "") {
    return { ok: false, error: `${quote(indexPath)}: not an attempt line: its event is ${describe(parsed.event)}` };
  }

  // The cast is the price of not carrying a second implementation of the shape of the line in src/: what was checked
  // is the one field every reader of this module needs, and the fields a caller reads next are answered where they
  // are used -- the acceptance and the gate are the writers, so a line is what they wrote or it is damaged above.
  return { ok: true, value: parsed as unknown as ReadAttemptLine };
}

// The record a line names, resolved. `historyPath` is the one an accepted line names -- the authoritative record
// inside the skill, which is the only event that wrote one -- and `decisionPath` is the record of a staged candidate,
// which is what the rest of the vocabulary names. Both are published relative to the base of the run
// (src/write-base.ts), and path.resolve answers the same absolute path for the absolute spelling a history path can
// carry, so a base that moved only moves the relative ones.
async function resolveRecord(
  base: string,
  line: ReadAttemptLine,
): Promise<{ record: DecisionRecord | null; recordPath: string | null; problem?: string }> {
  const named = line.event === "accepted" ? line.historyPath : line.decisionPath;
  // A field that is not a path is not a name: a hand-edited line can carry a number there, and path.resolve would
  // throw where the answer is the same one a line that names nothing gets.
  if (typeof named !== "string" || named === "") return { record: null, recordPath: null };

  const recordPath = path.resolve(base, named);
  const record = await readRecord(recordPath);
  return record.ok
    ? { record: record.value, recordPath }
    : { record: null, recordPath, problem: record.error };
}

// Why a record cannot be read, in the words the line reports it with. A record that is absent, that is not JSON or
// that declares another version is a `problem` of the line and never an exception: the line itself was read, and the
// attempt it records happened whether or not its record survived the staging directory it was written in.
function recordFailureText(recordPath: string, error: unknown): string {
  // A path that is not there, and a directory, are one answer: what the line names is not a file its record can be
  // read from. Every other failure keeps the words of the runtime next to the path, because a permission and a
  // broken medium are not the same problem and the line that reports one has to say which.
  if (isMissingPathError(error) || errorCode(error) === "EISDIR") return `${quote(recordPath)}: not a file`;
  return `${quote(recordPath)}: ${toErrorMessage(error)}`;
}

// The first field of the spine of a record that is missing or has the wrong type, written the way the line reports it, or
// null when the spine is whole. The spine is exactly what the three consumers of this reader dereference, in the order
// they read it: `skill.realDir` (src/standing.ts and the retirement flow), the four strings of `candidate` (the same two),
// `evidence` (src/metrics.ts), `outcome.status` (src/metrics.ts) and `gate.status` with `gate.basis` (src/metrics.ts).
//
// Every one of those fields is a required key of schemas/decision.schema.json, so a record this package wrote is never
// refused here, and a record whose deeper blocks are malformed -- `gate.caseBank` without `cases` -- passes this guard and
// fails where its consumer reads it: the whole shape of the document has one owner, the gate, and a second reading of it
// at run time is the duplication DEVELOPER.md rejects. What this answers is the tail of the sentence and not the whole of
// it: the path it was read from belongs to readRecord, and this function knows no path.
function recordProblemOf(parsed: Record<string, unknown>): string | null {
  const skill = parsed.skill;
  if (!isPlainObject(skill)) return `skill is ${describe(skill)}`;
  if (typeof skill.realDir !== "string") return `skill.realDir is ${describe(skill.realDir)}`;

  const candidate = parsed.candidate;
  if (!isPlainObject(candidate)) return `candidate is ${describe(candidate)}`;
  for (const field of ["slug", "lessonPath", "contentHash", "bodyHash"]) {
    if (typeof candidate[field] !== "string") return `candidate.${field} is ${describe(candidate[field])}`;
  }

  if (!Array.isArray(parsed.evidence)) return `evidence is ${describe(parsed.evidence)}`;

  const outcome = parsed.outcome;
  if (!isPlainObject(outcome)) return `outcome is ${describe(outcome)}`;
  if (typeof outcome.status !== "string") return `outcome.status is ${describe(outcome.status)}`;

  const gate = parsed.gate;
  if (!isPlainObject(gate)) return `gate is ${describe(gate)}`;
  for (const field of ["status", "basis"]) {
    if (typeof gate[field] !== "string") return `gate.${field} is ${describe(gate[field])}`;
  }

  return null;
}

async function readRecord(recordPath: string): Promise<Result<DecisionRecord, string>> {
  let text: string;
  try {
    text = await fs.promises.readFile(recordPath, "utf8");
  } catch (error) {
    return { ok: false, error: recordFailureText(recordPath, error) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `${quote(recordPath)}: ${toErrorMessage(error)}` };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: `${quote(recordPath)}: not a decision record: it is ${describe(parsed)}` };
  }

  // The version comes first: a record written by a version of this package this one does not read is not a record it can
  // count, and saying so is the difference between a coverage problem and a wrong number. The shape of such a record is
  // not this version's business either, so the spine below is asked of the records that declare the version this one reads.
  if (parsed.schema !== DECISION_SCHEMA) {
    return { ok: false, error: `${quote(recordPath)}: unsupported schema ${describe(parsed.schema)}` };
  }

  // The spine, and not the schema: a record that declares this version and lost a field its consumers dereference is a
  // record this module cannot hand over, so the line reports it as its own problem and the reading of the next line goes
  // on. It is not `damaged` -- the line of the index was read, and what is broken is the annex it names.
  const problem = recordProblemOf(parsed);
  if (problem !== null) {
    return { ok: false, error: `${quote(recordPath)}: not a decision record: ${problem}` };
  }

  return { ok: true, value: parsed as unknown as DecisionRecord };
}
