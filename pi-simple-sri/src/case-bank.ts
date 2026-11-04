import fs from "node:fs";
import { validateCheck, type CaseCheck } from "./checks.ts";
import { sha256Digest } from "./hash.ts";
import type { Result } from "./types.ts";
import { describe, isMissingPathError, isPlainObject, quote, toErrorMessage } from "./values.ts";

// The neutral bank of cases (M1c): the format a package ships its cases in, and the reader that turns the file into
// data or into the reason it is not data.
//
// A bank is one JSON object declared by its own `format` const, and it is read under one of two profiles that the
// invocation chooses (OA3): `baseline` for a directional improvement, which may declare the rubric the judge applies
// to every case, and `origin` for a defect, which carries the artifact that originated it and forbids a rubric. The
// file does not say which profile it belongs to -- it cannot, because a bank that is not there is still read as one
// of the two -- so the profile is an argument, and this module is the only place where the two readings of the same
// bytes differ.
//
// The relation profile <-> fields therefore lives here and not in schemas/case-bank.schema.json: JSON Schema cannot
// tie the presence of one property to the value of another without if/then/oneOf, and the public contract stays a
// single flat shape. That is the limitation OA3 accepted, and it is written down in both files: the schema declares
// the limit of every field, and this validator is the authority on which profile accepts which fields.
//
// Absence is a value and never an exception (OA9): a bank that is not there answers `absent`, and the flow that
// declared the branch turns it into `no-baseline` instead of failing a run that never started.
//
// What this module does not do: it resolves no path against any working directory, stats no artifact and judges no
// case. `origin.path` travels as it was written -- the flow that reads a defect resolves it and fails closed before
// spending when the artifact is not there -- and whether a case asks a good question is nobody's question here.
//
// The checks of a bank are read with the one reader of the package: every check goes through validateCheck of
// src/checks.ts, which compiles the regex and refuses a field of the wrong kind. A second reading of a check here
// would be a second answer to the same question, and the two would drift in the answer a replay is judged by.

// The versioned id of the format, and the `const` schemas/case-bank.schema.json declares: a bank of another version
// is a different contract and is refused whole instead of being read as this one with fields missing.
export const CASE_BANK_FORMAT = "pi-simple-sri/case-bank@1";

// The cap of the whole file, checked before a byte is parsed and before the bytes are read: the size is consulted with
// one stat, and a file over the limit is refused without being loaded. Fifty cases of a few hundred bytes each fit in a
// fraction of it, so the cap is not a budget on the cases: it is what stops a wrong path that points at a database
// or at a bundle from being read into memory and then rejected by the JSON parser. The length of the bytes is compared
// again after the read, because a file can grow between the two calls.
export const MAX_CASE_BANK_BYTES = 1_048_576;

// Q23: fewer cases than this cannot tell a candidate from the incumbent, so the bank declares its floor instead of
// letting the gate that replays it invent one; the ceiling keeps one bank from becoming a suite.
export const MIN_CASES = 2;
export const MAX_CASES = 50;

// The two profiles an invocation declares (OA3). The value is not stored in the file: it is what the caller already
// knows before it reads anything, and it is the reason a missing bank means `no-baseline` on one branch and
// `no-evidence` on the other.
export type CaseBankProfile = "baseline" | "origin";

// How a defect was found, the same two values EvidenceOrigin.kind declares in src/types.ts. Declared once and
// derived to a type, the way CASE_CHECK_KINDS and LESSON_STATUSES are: the schema declares the same enum, and
// test/unit/case-bank.test.ts is where the two files are read together.
export const CASE_BANK_ORIGIN_KINDS = ["review-finding", "rejected-draft"] as const;
export type CaseBankOriginKind = (typeof CASE_BANK_ORIGIN_KINDS)[number];

// Why a bank could not be read. `absent` is the one member that is not a problem with the file: it is the answer of
// a branch whose base does not exist yet, and the caller reports it as a state of the attempt.
export type CaseBankError = "absent" | "unreadable" | "too-large" | "not-json" | "invalid";

// The artifact a defect came from, as the bank declares it: how it was found, where it is, and the entry that does
// not hold. The reader neither resolves the path nor reads the file -- the flow owns both -- so what a bank keeps
// here is exactly what its author wrote.
export interface CaseBankOrigin {
  kind: CaseBankOriginKind;
  path: string;
  excerpt: string;
}

// One case: the id that names it in the record and in `checkFailures`, the prompt the replay sends, and the checks
// every one of which has to pass on the final answer (AND: an OR is two cases, because the rule of the gate is
// unanimity between cases).
export interface CaseBankCase {
  id: string;
  prompt: string;
  checks: readonly CaseCheck[];
}

// The bank as the reader answered it. `format` is a string and not the literal type: it is the field the reader
// compared against CASE_BANK_FORMAT, and typing it as the constant would say the reader never refuses one.
export interface CaseBank {
  format: string;
  description?: string;
  rubric?: string;
  origin?: CaseBankOrigin;
  cases: readonly CaseBankCase[];
}

// The bank, the bytes it was read from and the digest of those bytes.
//
// It is what a gate that preregisters a bank needs (OA4): the record pins the digest of the bytes it judged, and a
// preregistration computed from a second read of the path would describe whatever the file says at that later moment. The
// two reads are the classic check-then-use gap, and the answer is not to check harder -- it is to hand the bytes of the
// read that was parsed to the caller that has to pin them.
export interface LoadedCaseBank {
  bank: CaseBank;
  bytes: Buffer;
  contentHash: string; // "sha256:" + 64 hex over the bytes, the same value caseBankDigest computes
}

// What a refusal carries: the kind, so a caller decides by code and not by message text, and the detail, which is
// the path, the count or the first violation of the file.
export interface CaseBankFailure {
  error: CaseBankError;
  detail: string;
}

// The four limits of the optional text fields and of the excerpt, the same numbers the schema declares as
// minLength and maxLength. The excerpt limit is the one src/evidence.ts declares for an evidence excerpt: the entry
// that originated a defect and the excerpt the record keeps are the same text, and two different limits would let
// the bank hold a finding the record then has to cut.
const MAX_DESCRIPTION_CODE_POINTS = 500;
const MAX_RUBRIC_CODE_POINTS = 8000;
const MAX_PROMPT_CODE_POINTS = 4000;
const MAX_EXCERPT_CODE_POINTS = 200;

// The id of a case is a slug, the same shape a lesson slug has (schemas/decision.schema.json declares both), because
// it is the coordinate a failure names.
const MAX_ID_CODE_POINTS = 64;
const CASE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// The fields each level declares. Every level of the format is closed (additionalProperties: false), so a key that
// is not here is refused by name instead of dropped: a bank with a misspelled field is a mistake its author has to
// see, and the schema would refuse the record that carried it anyway.
const ROOT_FIELDS: readonly string[] = ["format", "description", "rubric", "origin", "cases"];
const ORIGIN_FIELDS: readonly string[] = ["kind", "path", "excerpt"];
const CASE_FIELDS: readonly string[] = ["id", "prompt", "checks"];

// The reader. The size is consulted before the bytes, the cap is checked on both, and the same bytes are what
// caseBankDigest hashes: the bank a preregistration pins is the bank this call read, not a re-serialization of it.
//
// It answers the data alone, which is what a caller that only wants to know whether the file is a bank needs. A caller
// that has to pin what it read -- the gate, whose preregistration keeps the digest of the bytes it judged -- reads through
// readCaseBank below instead: the two are one reader with one parse, and the narrower answer is derived from the wider one.
export async function loadCaseBank(
  file: string,
  profile: CaseBankProfile,
): Promise<Result<CaseBank, CaseBankFailure>> {
  const loaded = await readCaseBank(file, profile);
  return loaded.ok ? { ok: true, value: loaded.value.bank } : loaded;
}

// The same reader, answering the bytes it read and the digest of those bytes next to the data (M1c, S9). One read, one
// parse, and the caller that pins the bank and the parser that judged it are looking at the same file.
export async function readCaseBank(
  file: string,
  profile: CaseBankProfile,
): Promise<Result<LoadedCaseBank, CaseBankFailure>> {
  const bytes = await readBankBytes(file);
  if (!bytes.ok) return bytes;

  // The net of a file that grew between the stat of readBankBytes and this read: the cap is on the bytes as well, so the
  // limit holds whichever of the two readings saw the file last.
  if (bytes.value.length > MAX_CASE_BANK_BYTES) return tooLarge(bytes.value.length);

  let raw: unknown;
  try {
    raw = JSON.parse(bytes.value.toString("utf8"));
  } catch (error) {
    return refuse("not-json", toErrorMessage(error));
  }

  const parsed = parseCaseBank(raw, profile);
  if (!parsed.ok) return refuse("invalid", parsed.error);

  return {
    ok: true,
    value: { bank: parsed.value, bytes: bytes.value, contentHash: caseBankDigest(bytes.value) },
  };
}

// The digest of a bank as it is on disk, which is what a preregistration pins (OA4): the bytes and not the data, so
// a file that differs in whitespace or in the order of its keys is a different bank. A string is hashed as UTF-8,
// the same way src/hash.ts hashes it, so the two forms of the same file agree.
export function caseBankDigest(bytes: Buffer | string): string {
  return sha256Digest(bytes);
}

// The stable text of a refusal, which is what travels in `reason` of an index line and in the sentence a user reads
// (OA9): the first token names the problem and the rest is its detail. The table is total over CaseBankError, so a
// member added to the union stops compiling here instead of reaching a line with no text of its own.
const REASON_PREFIX: Record<CaseBankError, string> = {
  absent: "bank-absent",
  unreadable: "bank-unreadable",
  "too-large": "bank-too-large",
  "not-json": "bank-not-json",
  invalid: "bank-invalid",
};

export function caseBankReason(failure: CaseBankFailure): string {
  return `${REASON_PREFIX[failure.error]}: ${failure.detail}`;
}

// Reading the bytes is the only place the file system is touched, and the size is consulted before them: the cap exists
// so that a wrong path at a database or at a bundle is never loaded, and a read that happened before the comparison would
// pay exactly the cost the cap promises not to pay. A file that is not there is a value, not a rejection: ENOTDIR is the
// same absence one level down, the reading src/values.ts gives it. Anything else is a file the run cannot read, and the
// message of the runtime travels next to the path because an EACCES and an EISDIR are different problems and the line that
// reports it should say which one happened.
async function readBankBytes(file: string): Promise<Result<Buffer, CaseBankFailure>> {
  try {
    const stats = await fs.promises.stat(file);
    // The cap is on the bytes of a file: a path that is not one -- a directory, a device -- is left to the read below, which
    // answers the problem it has, exactly as it answered it before the size was consulted.
    if (stats.isFile() && stats.size > MAX_CASE_BANK_BYTES) return tooLarge(stats.size);
  } catch (error) {
    return readFailureOf(file, error);
  }

  try {
    return { ok: true, value: await fs.promises.readFile(file) };
  } catch (error) {
    return readFailureOf(file, error);
  }
}

// The one reading of a failure of the file system, from the stat and from the read alike: absent for a path that is not
// there, unreadable for one that is and cannot be read, with the message of the runtime next to the path.
function readFailureOf(file: string, error: unknown): Result<never, CaseBankFailure> {
  const absent = isMissingPathError(error);
  return {
    ok: false,
    error: {
      error: absent ? "absent" : "unreadable",
      detail: absent ? file : `${file}: ${toErrorMessage(error)}`,
    },
  };
}

// The one refusal of the cap, from the size the stat answered and from the length of the bytes that were read: the two
// readings name the same limit in the same words, so a caller decides by `too-large` whichever one stopped it.
function tooLarge(size: number): Result<never, CaseBankFailure> {
  return refuse("too-large", `${size} bytes, over the ${MAX_CASE_BANK_BYTES} byte limit`);
}

// The body of the reader, over the value JSON.parse answered. The order of the checks is the order of this list, and
// it is the order a detail names: the format first (a bank of another version is not this contract and its other
// problems are not ours to list), the closed root, the optional root fields, and the cases last, because a bank
// whose `format` is wrong is not a bank with two bad cases.
function parseCaseBank(raw: unknown, profile: CaseBankProfile): Result<CaseBank, string> {
  if (!isPlainObject(raw)) return problem(`the bank must be a JSON object, got ${describe(raw)}`);

  if (raw.format !== CASE_BANK_FORMAT) {
    return problem(`"format" must be ${quote(CASE_BANK_FORMAT)}, got ${describe(raw.format)}`);
  }

  const unknownField = Object.keys(raw).find((key) => !ROOT_FIELDS.includes(key));
  if (unknownField !== undefined) return problem(`the bank has no ${quote(unknownField)} field`);

  let description: string | undefined;
  if (Object.hasOwn(raw, "description")) {
    const accepted = textField("description", raw.description, MAX_DESCRIPTION_CODE_POINTS, 0);
    if (!accepted.ok) return accepted;
    description = accepted.value;
  }

  let rubric: string | undefined;
  if (Object.hasOwn(raw, "rubric")) {
    // A defect has an observable truth: a rubric would leave the judge deciding something the artifact in front of
    // it already says, so the profile that reads a defect refuses one instead of ignoring it.
    if (profile === "origin") return problem(`a bank of profile ${quote("origin")} has no "rubric" field`);

    const accepted = textField("rubric", raw.rubric, MAX_RUBRIC_CODE_POINTS);
    if (!accepted.ok) return accepted;
    rubric = accepted.value;
  }

  let origin: CaseBankOrigin | undefined;
  if (Object.hasOwn(raw, "origin")) {
    // The other half of the same rule: a directional bank has no artifact behind it, so an `origin` there is a file
    // that thinks it is a defect and is read as one only when the invocation says so.
    if (profile === "baseline") return problem(`a bank of profile ${quote("baseline")} has no "origin" field`);

    const accepted = parseOrigin(raw.origin);
    if (!accepted.ok) return accepted;
    origin = accepted.value;
  } else if (profile === "origin") {
    return problem(`a bank of profile ${quote("origin")} requires an "origin"`);
  }

  const cases = parseCases(raw.cases);
  if (!cases.ok) return cases;

  return {
    ok: true,
    value: {
      format: CASE_BANK_FORMAT,
      ...(description === undefined ? {} : { description }),
      ...(rubric === undefined ? {} : { rubric }),
      ...(origin === undefined ? {} : { origin }),
      cases: cases.value,
    },
  };
}

function parseOrigin(raw: unknown): Result<CaseBankOrigin, string> {
  if (!isPlainObject(raw)) return problem(`"origin" must be an object, got ${describe(raw)}`);

  const unknownField = Object.keys(raw).find((key) => !ORIGIN_FIELDS.includes(key));
  if (unknownField !== undefined) return problem(`"origin" has no ${quote(unknownField)} field`);

  const kind = raw.kind;
  if (!isCaseBankOriginKind(kind)) {
    return problem(
      `"origin.kind" must be one of ${CASE_BANK_ORIGIN_KINDS.map(quote).join(", ")}, got ${describe(kind)}`,
    );
  }

  const declaredPath = raw.path;
  if (typeof declaredPath !== "string" || declaredPath === "") {
    return problem(`"origin.path" must be a non-empty string, got ${describe(declaredPath)}`);
  }

  const excerpt = textField("origin.excerpt", raw.excerpt, MAX_EXCERPT_CODE_POINTS);
  if (!excerpt.ok) return excerpt;

  return { ok: true, value: { kind, path: declaredPath, excerpt: excerpt.value } };
}

function parseCases(raw: unknown): Result<readonly CaseBankCase[], string> {
  if (!Array.isArray(raw)) return problem(`"cases" must be an array, got ${describe(raw)}`);

  const entries: readonly unknown[] = raw;
  if (entries.length < MIN_CASES || entries.length > MAX_CASES) {
    return problem(`"cases" must hold ${MIN_CASES} to ${MAX_CASES} cases, got ${entries.length}`);
  }

  const cases: CaseBankCase[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const accepted = parseCase(entry, index);
    if (!accepted.ok) return accepted;

    // The id is the coordinate a failure names, so two cases cannot answer to it. The message points at the second
    // occurrence, which is the one the author has to rename.
    if (seen.has(accepted.value.id)) {
      return problem(`"cases[${index}].id" repeats the id ${quote(accepted.value.id)}`);
    }
    seen.add(accepted.value.id);
    cases.push(accepted.value);
  }

  return { ok: true, value: cases };
}

function parseCase(raw: unknown, index: number): Result<CaseBankCase, string> {
  const at = `cases[${index}]`;
  if (!isPlainObject(raw)) return problem(`${quote(at)} must be an object, got ${describe(raw)}`);

  const unknownField = Object.keys(raw).find((key) => !CASE_FIELDS.includes(key));
  if (unknownField !== undefined) return problem(`${quote(at)} has no ${quote(unknownField)} field`);

  const id = caseId(`${at}.id`, raw.id);
  if (!id.ok) return id;

  const prompt = textField(`${at}.prompt`, raw.prompt, MAX_PROMPT_CODE_POINTS);
  if (!prompt.ok) return prompt;

  const checks = parseChecks(raw.checks, at);
  if (!checks.ok) return checks;

  return { ok: true, value: { id: id.value, prompt: prompt.value, checks: checks.value } };
}

// The list of checks of one case. The count belongs to the bank and is checked here; the shape of each element
// belongs to src/checks.ts and is asked there, with the coordinate prepended so a failure names the case it is in.
function parseChecks(raw: unknown, at: string): Result<readonly CaseCheck[], string> {
  const field = `${at}.checks`;
  if (!Array.isArray(raw)) return problem(`${quote(field)} must be an array, got ${describe(raw)}`);

  const entries: readonly unknown[] = raw;
  if (entries.length === 0) return problem(`${quote(field)} must hold at least one check, got 0`);

  const checks: CaseCheck[] = [];
  for (const [position, entry] of entries.entries()) {
    const accepted = validateCheck(entry);
    if (!accepted.ok) return problem(`the check at ${quote(`${field}[${position}]`)}: ${accepted.error}`);
    checks.push(accepted.value);
  }

  return { ok: true, value: checks };
}

// One string field with the bounds the schema declares as minLength and maxLength. JSON Schema counts the characters
// of a string as code points, so the length is counted with Array.from, the same reading src/checks.ts uses for the
// text of a check: an emoji is one character for the schema and has to be one here.
function textField(field: string, value: unknown, max: number, min = 1): Result<string, string> {
  if (typeof value !== "string") return problem(`${quote(field)} must be a string, got ${describe(value)}`);

  const length = Array.from(value).length;
  if (length < min || length > max) {
    // The count and not the text: a rubric over its limit would otherwise repeat eight thousand characters in the
    // sentence a user reads.
    const bounds = min === 0 ? `at most ${max} characters` : `${min} to ${max} characters`;
    return problem(`${quote(field)} must be ${bounds}, got ${length}`);
  }

  return { ok: true, value };
}

function caseId(field: string, value: unknown): Result<string, string> {
  if (typeof value !== "string") return problem(`${quote(field)} must be a string, got ${describe(value)}`);

  if (Array.from(value).length > MAX_ID_CODE_POINTS || !CASE_ID_PATTERN.test(value)) {
    return problem(
      `${quote(field)} must match ${CASE_ID_PATTERN.source} and be at most ${MAX_ID_CODE_POINTS} characters, got ${describe(value)}`,
    );
  }

  return { ok: true, value };
}

// Derived from the array, never from a second literal, in the same way src/checks.ts derives its kind validator.
function isCaseBankOriginKind(value: unknown): value is CaseBankOriginKind {
  return typeof value === "string" && CASE_BANK_ORIGIN_KINDS.some((kind) => kind === value);
}

// The shape of every rejection of this module that is a message and not a kind: the caller of the reader wraps it in
// its own error, and the caller of a validator reads it as it is.
function problem(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

function refuse(error: CaseBankError, detail: string): Result<never, CaseBankFailure> {
  return { ok: false, error: { error, detail } };
}
