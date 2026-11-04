import fs from "node:fs";
// Type-only, so the contract root that imports this module keeps no run time dependency on it back: the
// reader of a path below answers the Result every reader of this package already answers.
import type { Result } from "./types.ts";

// Value helpers shared by the modules that read settings, check the write perimeter, move
// bytes, read lessons back and date a run (I15). Each of them existed as a byte-identical private
// copy in two to four modules; there is one definition now so a change cannot land in only one
// path.

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// JSON.stringify emits a double-quoted scalar with its quotes and backslashes escaped, so a
// path with quotes or accents stays readable in an error message, and a lesson title with a
// colon or a quote survives the round trip through the YAML double-quoted style that
// src/lesson-frontmatter.ts writes.
export function quote(value: string): string {
  return JSON.stringify(value);
}

// The value as JSON, which is how the messages that reject it name what they got: a double-quoted
// string, a number, null. JSON.stringify answers undefined for a value it does not serialize (a
// function, a symbol, undefined itself), and that is when String() names it instead.
export function describe(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

// A text cut to a cap counted in code points and never in UTF-16 units: Array.from walks code points, so a surrogate pair
// (an emoji, a rare CJK character) is never cut in half, and a lone surrogate -- not valid UTF-8 -- never reaches a record.
// The excerpt of a finding, the summary of a defect, the reason of a judge and the final text of an answer are the same
// reading of the same cap, which is why the caps stay in the callers and the cut lives here.
export function cutCodePoints(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

// The same unit for a field that is counted instead of cut: JSON Schema counts the characters of a string as code points,
// so a limit the schema declares is compared against this measure and never against `length`.
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

// An array is an object to typeof, and a settings array is a shape this package never accepts.
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The first key an object declares that its level does not, as the sentence that refuses it: every level of the formats
// this package reads is closed (additionalProperties: false), so an unknown key is named instead of dropped, and `where`
// is the coordinate the sentence names -- the level, the case, or the kind of check. It answers undefined when the object
// declares nothing else, and the caller turns that into its own kind of answer (a problem, a rejected check).
export function closedObjectProblemOf(
  raw: Record<string, unknown>,
  fields: readonly string[],
  where: string,
): string | undefined {
  const unknown = Object.keys(raw).find((key) => !fields.includes(key));
  return unknown === undefined ? undefined : `${where} has no ${quote(unknown)} field`;
}

// The fs error code of a failure, when it carries one: callers decide by code and never by
// message text, which varies with the locale of the runtime.
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

// A path that does not exist. ENOTDIR is the same absence one level down: a component of the
// path is a file, so the rest of it cannot be there.
export function isMissingPathError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

// A path that already exists, found by a mkdir that was meant to create it.
export function isAlreadyExistsError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

// Which of the two failures of a read a path answered, in the words every reader of this package shares: `absent` for a
// path that is not there -- ENOTDIR included, the same absence one level down -- with the path alone, and `unreadable`
// for one that is and cannot be read, with the message of the runtime next to the path, because an EACCES and an EISDIR
// are different problems and the line that reports one has to say which. Each caller translates the two words into its
// own vocabulary (bank-absent, artifact-absent) instead of deciding again what absence is.
export interface ReadFailure {
  error: "absent" | "unreadable";
  detail: string;
}

export function readFailureOf(target: string, error: unknown): ReadFailure {
  return isMissingPathError(error)
    ? { error: "absent", detail: target }
    : { error: "unreadable", detail: `${target}: ${toErrorMessage(error)}` };
}

// The bytes of a file, or the same reading of why they are not there: a read that failed is a value and not an exception,
// so a caller that has to report absence in its own vocabulary decides on the answer instead of catching.
export async function readBytes(target: string): Promise<Result<Buffer, ReadFailure>> {
  try {
    return { ok: true, value: await fs.promises.readFile(target) };
  } catch (error) {
    return { ok: false, error: readFailureOf(target, error) };
  }
}

// A path that cannot be stat'ed is not a regular file: "absent" and "unreadable" are the same
// answer for the callers, which is what the private copies did before they moved here.
export function isRegularFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

// The directory counterpart of the check above, for the two places this package asks it: the entries of the
// staging layout, whose absence and whose failed stat are both "not a directory" to the guards, and the cwd of
// a replay, refused before a process exists. `statSync` follows symlinks, so a linked directory is a directory:
// what the caller gets is the path it named.
export function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// The one clock: the acceptance, the gate and the improve flow all fall back to it when a caller injects no
// clock of its own, so a run that is not under test reads the time the same way in all three.
export function currentTime(): Date {
  return new Date();
}
