import fs from "node:fs";
import path from "node:path";
import { SriConfigError } from "./errors.ts";
import { SETTINGS_FILE } from "./names.ts";
import { DEFAULT_JUDGE_CALLS_PER_DAY } from "./observe/types.ts";
import type { ObserveConfig, ObserveModelRef } from "./observe/types.ts";
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

// The parsed settings file, or undefined when there is none. Both readers below start here, so the two fail closed on the
// same unreadable or invalid file with the same wording.
function readSettingsJson(settingsPath: string): unknown {
  if (!fs.existsSync(settingsPath)) return undefined;

  let text: string;
  try {
    text = fs.readFileSync(settingsPath, "utf8");
  } catch (error) {
    throw fail(`cannot read settings: ${toErrorMessage(error)}`, settingsPath);
  }

  // Strict JSON, no JSONC: pi parses settings.json with JSON.parse as well (E3).
  try {
    return JSON.parse(text);
  } catch (error) {
    throw fail(`invalid JSON: ${toErrorMessage(error)}`, settingsPath);
  }
}

// Reads the settings file given by the caller (the agent dir path comes from
// getAgentDir() at the call site, never hardcoded here). A missing file is the
// default config: every skill eligible except the name this package reserves (src/names.ts) and what
// `deny` removes.
export function readSriConfig(settingsPath: string): SriConfig {
  const raw = readSettingsJson(settingsPath);
  if (raw === undefined) return emptyConfig();

  return parseSriConfigAt(raw, settingsPath);
}

// The reader a surface hands over for the file above: readSriConfig in production, and any function of the same shape in a
// test. It is a type and not a second function because the seam was already spelled out verbatim in the dependencies of the
// loop (src/improve-flow.ts), and the gate would have been the third copy of it.
export type ConfigReader = (settingsPath: string) => SriConfig;

// The settings of one agent directory (B4). It is the only place outside src/names.ts that spells the name of the file: the
// three sites that used to join the two by hand -- the inventory of the loop, the eligibility guard of the gate and the
// acceptance of the command -- ask here instead, so a run cannot read the settings of one directory while its gate reads the
// settings of another. The reader is a parameter because the seam a test replaces is the reader, and not the join.
export function readSriConfigOf(agentDir: string, read: ConfigReader = readSriConfig): SriConfig {
  return read(path.join(agentDir, SETTINGS_FILE));
}

// The observer's settings, `pi-simple-sri.observe`. They are parsed apart from the skills lists: a broken `observe` must
// not take eligibility down with it, and the other way round. Off by default: nothing is observed until the user opts in.
function emptyObserveConfig(): ObserveConfig {
  return { enabled: false, judgeModel: null, judgeCallsPerDay: DEFAULT_JUDGE_CALLS_PER_DAY, replayAllow: [] };
}

// "provider/id", split at the first slash: the id of a model may hold slashes of its own.
function readJudgeModel(value: unknown, label: string, settingsPath?: string): ObserveModelRef {
  const slash = typeof value === "string" ? value.indexOf("/") : -1;
  if (typeof value !== "string" || slash < 1 || slash === value.length - 1) {
    throw fail(`${label} must be "provider/id", got ${describe(value)}`, settingsPath);
  }
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

function readObjectAt(parent: Record<string, unknown>, key: string, label: string, settingsPath?: string): Record<string, unknown> | undefined {
  const value = parent[key];
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw fail(`${label} must be an object, got ${describe(value)}`, settingsPath);
  }
  return value;
}

function parseObserveConfigAt(raw: unknown, settingsPath?: string): ObserveConfig {
  const config = emptyObserveConfig();
  if (!isPlainObject(raw)) {
    throw fail(`settings must be a JSON object, got ${describe(raw)}`, settingsPath);
  }

  const section = readObjectAt(raw, SETTINGS_KEY, `"${SETTINGS_KEY}"`, settingsPath);
  const observePath = `${SETTINGS_KEY}.observe`;
  const observe = section === undefined ? undefined : readObjectAt(section, "observe", `"${observePath}"`, settingsPath);
  if (observe === undefined) return config;

  if (observe.enabled !== undefined) {
    if (typeof observe.enabled !== "boolean") {
      throw fail(`"${observePath}.enabled" must be a boolean, got ${describe(observe.enabled)}`, settingsPath);
    }
    config.enabled = observe.enabled;
  }

  if (observe.judgeModel !== undefined) {
    config.judgeModel = readJudgeModel(observe.judgeModel, `"${observePath}.judgeModel"`, settingsPath);
  }

  const limits = readObjectAt(observe, "limits", `"${observePath}.limits"`, settingsPath);
  const calls = limits?.judgeCallsPerDay;
  if (calls !== undefined) {
    if (typeof calls !== "number" || !Number.isInteger(calls) || calls < 0) {
      throw fail(`"${observePath}.limits.judgeCallsPerDay" must be a non-negative integer, got ${describe(calls)}`, settingsPath);
    }
    config.judgeCallsPerDay = calls;
  }

  const replay = readObjectAt(observe, "replay", `"${observePath}.replay"`, settingsPath);
  if (replay?.allow !== undefined) {
    config.replayAllow = readStringList(replay.allow, `"${observePath}.replay.allow"`, settingsPath);
  }

  return config;
}

// Validates an already-parsed settings object; the same contract as parseSriConfig for the observer's keys.
export function parseObserveConfig(raw: unknown): ObserveConfig {
  return parseObserveConfigAt(raw);
}

export function readObserveConfig(settingsPath: string): ObserveConfig {
  const raw = readSettingsJson(settingsPath);
  if (raw === undefined) return emptyObserveConfig();

  return parseObserveConfigAt(raw, settingsPath);
}

export type ObserveConfigReader = (settingsPath: string) => ObserveConfig;

// The observer's settings of one agent directory; the join and the reader seam are the ones of readSriConfigOf.
export function readObserveConfigOf(agentDir: string, read: ObserveConfigReader = readObserveConfig): ObserveConfig {
  return read(path.join(agentDir, SETTINGS_FILE));
}
