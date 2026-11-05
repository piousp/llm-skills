import fs from "node:fs";
import { SriConfigError } from "./errors.ts";
import type { SriConfig } from "./types.ts";
import { describe, isPlainObject, toErrorMessage } from "./values.ts";

// The error class lives in src/errors.ts with the rest of the fail-closed errors; it is
// re-exported here because this is the module that raises it.
export { SriConfigError };

// Q16: the extension only reads this key from settings.json, which the user edits
// by hand. No project-level override.
const SETTINGS_KEY = "pi-simple-sri";

// parseSriConfig has no file to blame, so its errors carry no path at all: undefined, not the
// empty string, which would be a path the user cannot tell apart from a real one.
function fail(message: string, settingsPath?: string): SriConfigError {
  const where = settingsPath === undefined ? "" : ` in ${settingsPath}`;
  return new SriConfigError(`${message}${where}`, settingsPath);
}

function emptyConfig(): SriConfig {
  return { allow: [], deny: [] };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function readStringList(value: unknown, label: string, settingsPath?: string): string[] {
  if (!isStringArray(value)) {
    throw fail(`${label} must be an array of strings, got ${describe(value)}`, settingsPath);
  }
  return [...value];
}

// Shared body of parseSriConfig and readSriConfig; settingsPath is only used to
// build error messages and to fill SriConfigError.settingsPath.
function parseSriConfigAt(raw: unknown, settingsPath?: string): SriConfig {
  if (!isPlainObject(raw)) {
    throw fail(`settings must be a JSON object, got ${describe(raw)}`, settingsPath);
  }

  const section = raw[SETTINGS_KEY];
  if (section === undefined) return emptyConfig();

  if (!isPlainObject(section)) {
    throw fail(`"${SETTINGS_KEY}" must be an object, got ${describe(section)}`, settingsPath);
  }

  const skills = section.skills;
  if (skills === undefined) return emptyConfig();

  if (!isPlainObject(skills)) {
    throw fail(`"${SETTINGS_KEY}.skills" must be an object, got ${describe(skills)}`, settingsPath);
  }

  const allowLabel = `"${SETTINGS_KEY}.skills.allow"`;
  const denyLabel = `"${SETTINGS_KEY}.skills.deny"`;

  return {
    allow: skills.allow === undefined ? [] : readStringList(skills.allow, allowLabel, settingsPath),
    deny: skills.deny === undefined ? [] : readStringList(skills.deny, denyLabel, settingsPath),
  };
}

// Validates an already-parsed settings object. Unknown keys, outside and inside
// the `pi-simple-sri` key, are ignored: other extensions share this file.
export function parseSriConfig(raw: unknown): SriConfig {
  return parseSriConfigAt(raw);
}

// Reads the settings file given by the caller (the agent dir path comes from
// getAgentDir() at the call site, never hardcoded here). A missing file is the
// default config: every skill eligible except the name this package reserves (src/names.ts) and what
// `deny` removes.
export function readSriConfig(settingsPath: string): SriConfig {
  if (!fs.existsSync(settingsPath)) return emptyConfig();

  let text: string;
  try {
    text = fs.readFileSync(settingsPath, "utf8");
  } catch (error) {
    throw fail(`cannot read settings: ${toErrorMessage(error)}`, settingsPath);
  }

  // Strict JSON, no JSONC: pi parses settings.json with JSON.parse as well (E3).
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw fail(`invalid JSON: ${toErrorMessage(error)}`, settingsPath);
  }

  return parseSriConfigAt(raw, settingsPath);
}
