import fs from "node:fs";

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

// An array is an object to typeof, and a settings array is a shape this package never accepts.
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
