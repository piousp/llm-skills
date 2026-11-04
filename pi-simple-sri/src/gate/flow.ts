import fs from "node:fs";
import path from "node:path";
import { DECISION_FILE, LESSONS_DIR } from "../names.ts";
import { assertWritable } from "../perimeter.ts";
import type { DecisionRecord, DecisionSchema, Result } from "../types.ts";
import { describe, isPlainObject, isRegularFile, quote, toErrorMessage } from "../values.ts";
import { stagingDir } from "../write-base.ts";

// The flow of the gate (M1, §S8). The slice that orchestrates overlay -> preregistration -> runs ->
// verdict -> rewritten record -> index line is the next one; what lives here today is the one function
// every half of it starts with, resolveStagedCandidate: the gate works on a candidate that is already
// staged, and it has to know which record that is before it writes, rewrites or spends anything.
//
// It is here and not in the surface (src/tool-skill-improve.ts, src/command-skill-improve.ts) because both
// surfaces use it and a candidate this function accepts is a candidate the whole package then trusts: one
// implementation, one set of guards, and no second reading of a decision.json.
//
// Nothing here spawns a process, reads the settings or calls a model: the guards run on a path and on one
// file, and the answer is the record or the reason there is none.

// The one schema this package writes, and the only one its gate reads (OA12). A candidate staged by another
// version is refused instead of being rewritten: a decision@0 record carries `predicate` where this version
// has `expectation`, so a gate that opened it would either write a record that is half of each version or
// fail halfway through its own sequence. The type of the constant is DecisionSchema, so a @2 in src/types.ts
// breaks this comparison at compile time instead of leaving a guard that silently never fires.
const DECISION_SCHEMA: DecisionSchema = "pi-simple-sri/decision@1";

// Why a staged candidate cannot be gated. Each reason names a different answer for the caller, and none of
// them is an error the run should crash on: `detail` carries the refusal with the path in it, so the record
// of the gate and the message a human reads say which directory of which skill stopped it.
export type CandidateRejectionReason =
  // The candidate is not inside <base>/staging, so this package never staged it.
  | "outside-staging"
  // The candidate directory belongs to another skill than the one the run is about.
  | "skill-mismatch"
  // decision.json, lessons/, or both: the staged candidate is not the pair the writer publishes.
  | "incomplete-candidate"
  // decision.json is not a JSON object, or it cannot be read.
  | "unreadable-record"
  // The record declares a schema this version does not read (OA12).
  | "unsupported-schema";

export interface CandidateRejection {
  reason: CandidateRejectionReason;
  detail: string;
}

export type StagedCandidateResult = Result<DecisionRecord, CandidateRejection>;

// The record of a candidate that is already in staging, or the typed refusal that says why there is none.
//
// The four guards run in this order and the first one runs before a byte is read:
//
//   1. the path is inside <base>/staging (the perimeter of the whole package, asserted by the same function
//      the writer uses), so a stagingPath of the caller's choosing cannot turn the gate into a reader of
//      any decision.json on the machine;
//   2. the directory is named after the skill, which is where writeStagingCandidate puts the candidate, so
//      a candidate of another skill is not silently gated as this one;
//   3. both halves of the candidate exist: decision.json and lessons/ -- a record with no lesson directory
//      describes a candidate nobody can replay, and an overlay of it would fail one step later, after the
//      preregistration had already been written;
//   4. the record declares the one schema this package reads (OA12), which is checked on the parsed JSON and
//      before the record is handed to anyone.
//
// `stagingPath` may be absolute or relative to `base`: every path this package publishes in a record or in
// a `details` block names a candidate relative to the base of the run, so a caller keeping one of those
// spellings is the ordinary case, and path.resolve answers the same absolute path for both.
export async function resolveStagedCandidate(
  base: string,
  skillName: string,
  stagingPath: string,
): Promise<StagedCandidateResult> {
  const candidateDir = path.resolve(base, stagingPath);
  const stagingRoot = stagingDir(base);

  // Guard 1. The rejection keeps the refusal of the perimeter verbatim: the root it compared is in it, which
  // is what a reader needs to see that the candidate was never looked at.
  try {
    assertWritable(candidateDir, [stagingRoot]);
  } catch (error) {
    return reject("outside-staging", `${quote(candidateDir)} is not a candidate inside ${quote(stagingRoot)}: ${toErrorMessage(error)}`);
  }

  // Guard 2.
  const candidateName = path.basename(candidateDir);
  if (candidateName !== skillName) {
    return reject(
      "skill-mismatch",
      `${quote(candidateDir)} is named ${quote(candidateName)}, not after the skill ${quote(skillName)}`,
    );
  }

  // Guard 3.
  const decisionPath = path.join(candidateDir, DECISION_FILE);
  if (!isRegularFile(decisionPath)) {
    return reject("incomplete-candidate", `${quote(decisionPath)} is not a file`);
  }
  const lessonsPath = path.join(candidateDir, LESSONS_DIR);
  if (!isDirectory(lessonsPath)) {
    return reject("incomplete-candidate", `${quote(lessonsPath)} is not a directory`);
  }

  // Guard 4, inside the read: the version has to be right before the record means anything.
  return await readStagedDecision(decisionPath);
}

async function readStagedDecision(decisionPath: string): Promise<StagedCandidateResult> {
  let text: string;
  try {
    text = await fs.promises.readFile(decisionPath, "utf8");
  } catch (error) {
    return reject("unreadable-record", `cannot read ${quote(decisionPath)}: ${toErrorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return reject("unreadable-record", `${quote(decisionPath)} is not JSON: ${toErrorMessage(error)}`);
  }
  if (!isPlainObject(parsed)) {
    return reject("unreadable-record", `${quote(decisionPath)} is not a decision record: it is ${describe(parsed)}`);
  }

  // Guard 4 (OA12). The reason is its own, and not a flavour of "unreadable": the file parsed and its
  // version is the problem, which is what the caller has to report -- a candidate written by an older
  // version of this package is a candidate that has to be proposed again, not one that is broken.
  if (parsed.schema !== DECISION_SCHEMA) {
    return reject(
      "unsupported-schema",
      `${quote(decisionPath)} declares the schema ${describe(parsed.schema)}: this package reads only ${quote(DECISION_SCHEMA)}`,
    );
  }

  return { ok: true, value: declaredRecord(parsed) };
}

// The record as the contract it declares. The assertion is the price of not carrying a second implementation
// of schemas/decision.schema.json in src/: the version guard above proves the file was written by this
// package, and the fields the gate reads are checked where they are used -- the pair of hashes of the
// candidate against the lesson on disk (src/writer.ts, rewriteStagingDecision), the failureSignature of the
// diagnosis where the index line is built. A full runtime validation would be the schema itself, in a package
// that has no validator and wants none.
function declaredRecord(record: Record<string, unknown>): DecisionRecord {
  return record as unknown as DecisionRecord;
}

function reject(reason: CandidateRejectionReason, detail: string): StagedCandidateResult {
  return { ok: false, error: { reason, detail } };
}

// An unreadable path and an absent one are the same answer for the guards above: neither of them is a
// candidate. src/values.ts owns the file counterpart of this check (isRegularFile); the two entries of the
// staging layout are the only place this package needs the directory one, so it stays here.
function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
