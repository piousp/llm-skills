// The settings contract, resolved once inside `session_start`: the block `pi.getSettings()` returns, the environment and
// the agent directory go in, and the configuration the rest of the package reads comes out. No import, no file, no
// clock, no database that touches the user's memory: every function here is a function of its arguments alone, and
// `resolveConfig` never throws, because its input is what a user typed into a JSON file.

import { isAbsolute, join } from "node:path";
import { appendUnique, toSlug } from "./query.ts";

/** Key of the block this package owns inside `settings.json`. */
export const SETTINGS_KEY = "pi-memory-lite";

/** Environment variable that overrides the data directory; it wins over the settings block. */
export const DIR_ENV_VAR = "PI_MEMORY_LITE_DIR";

/** Directory under `<agentDir>` that holds the memory, when neither the environment nor settings says otherwise. */
export const MEMORIES_DIR = "lite-memories";

/** File the database lives in, always under the resolved directory. */
export const DB_FILE = "memory.db";

/** Category vocabulary used when settings name none; every element is already a slug. */
export const DEFAULT_CATEGORIES: readonly string[] = [
  "general",
  "decision",
  "preference",
  "env",
  "project",
  "gotcha",
  "convention",
  "workflow",
  "reference",
  "person",
];

/** How the tools reach the model: declared, found through `codemode`, or found through `tool_search`. */
export type Exposure = "direct" | "codemode" | "deferred";

/** Declared by default: the other two modes buy permanent cost with discoverability. */
export const DEFAULT_EXPOSURE: Exposure = "direct";

/** The three values `exposure` accepts. */
export const EXPOSURES: readonly Exposure[] = ["direct", "codemode", "deferred"];

/** Node version `node:sqlite` needs, as `[major, minor]`. */
export const MIN_NODE: readonly [number, number] = [22, 14];

/**
 * The floor of the 23 line. 23.0 to 23.3 still gate `node:sqlite` behind `--experimental-sqlite`, a flag a pi session
 * does not pass, so a 23.x build above `MIN_NODE` and below this one has no module at all (§5).
 */
export const MIN_NODE_23: readonly [number, number] = [23, 4];

/** The configuration the rest of the package reads; every field is final by the time this is returned. */
export interface ResolvedConfig {
  /** Absolute path of the data directory, whatever level supplied it. */
  readonly dir: string;
  /** `join(dir, DB_FILE)`. */
  readonly dbPath: string;
  /** Slugs, no duplicates, order preserved. */
  readonly categories: readonly string[];
  /** `true` when a slug outside `categories` may be written and created. */
  readonly allowUnknownCategory: boolean;
  /** How the four tools reach the model. */
  readonly exposure: Exposure;
  /** Which level supplied the directory. */
  readonly source: "env" | "settings" | "default";
}

/** What the caller has in hand when the session starts. */
export interface ResolveConfigInput {
  /** Exactly what `pi.getSettings()` returned: unvalidated, possibly not an object at all. */
  readonly raw: unknown;
  /** `process.env`, injected so the resolver stays a function of its arguments. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `getAgentDir()` of `@earendil-works/pi-coding-agent`, the base of the default directory; the context has no such field. */
  readonly agentDir: string;
}

/**
 * Resolves the settings into a configuration plus the warnings the caller logs, prefixed. Never throws: every malformed
 * level falls through to the next one, so a typo degrades one option instead of breaking the session.
 */
export function resolveConfig(input: ResolveConfigInput): { config: ResolvedConfig; warnings: string[] } {
  const warnings: string[] = [];
  const block = readSettingsBlock(input.raw, warnings);

  const exposure = resolveExposure(block, warnings);
  const categories = resolveCategories(block, warnings);
  const allowUnknownCategory = resolveAllowUnknownCategory(block, warnings);
  const { dir, source } = resolveDir(block, input.env, input.agentDir, warnings);

  return {
    config: { dir, dbPath: join(dir, DB_FILE), categories, allowUnknownCategory, exposure, source },
    warnings,
  };
}

/**
 * Compares a Node version against the two floors `node:sqlite` has: `MIN_NODE` for the 22 line and `MIN_NODE_23` for the
 * 23 line. Never throws: an unreadable version is a failure with the same message, so the caller has one branch to write
 * and the model reads one sentence.
 */
export function checkNodeVersion(version: string): { ok: true } | { ok: false; message: string } {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return { ok: false, message: nodeVersionMessage(version, MIN_NODE.join(".")) };

  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (isSupportedNode(major, minor)) return { ok: true };

  return { ok: false, message: nodeVersionMessage(version, requiredNodeVersion(major)) };
}

/**
 * Whether this pair reaches `node:sqlite`: two floors and not one, because the 23 line has its own (`MIN_NODE_23`) above
 * the 22 one. 23.0 to 23.3 pass a comparison against `MIN_NODE` alone and still cannot import the module (§5).
 */
function isSupportedNode(major: number, minor: number): boolean {
  const [floorMajor, floorMinor] = nodeFloor(major);
  return major > floorMajor || (major === floorMajor && minor >= floorMinor);
}

/**
 * The floor the version found has to reach, so the sentence names the requirement that was missed: a 23.1 build is above
 * 22.14, and telling its user to upgrade to 22.14 would describe a version they already exceed.
 */
function requiredNodeVersion(major: number): string {
  return nodeFloor(major).join(".");
}

/**
 * The one floor of a Node line: `MIN_NODE_23` for the 23 line, which carries a floor of its own, and `MIN_NODE` for every
 * other, because the release that added the module did it once and the two lines are only read apart (§5).
 */
function nodeFloor(major: number): readonly [number, number] {
  return major === MIN_NODE_23[0] ? MIN_NODE_23 : MIN_NODE;
}

/** One sentence naming the version found and the floor it missed; the caller adds the `[pi-memory-lite]` prefix to log. */
function nodeVersionMessage(version: string, required: string): string {
  return `pi-memory-lite requires Node >= ${required} for node:sqlite (found ${version}); the memory tools are registered but will return this error.`;
}

/**
 * The block of this package, or an empty one. An absent block is the normal state of a fresh install and warns about
 * nothing; a present block of the wrong shape warns and names the shape that was found instead.
 */
function readSettingsBlock(raw: unknown, warnings: string[]): Record<string, unknown> {
  if (!isRecord(raw)) {
    warnings.push(`The settings must be an object, got ${describeShape(raw)}.`);
    return {};
  }
  if (!(SETTINGS_KEY in raw)) return {};
  const block = raw[SETTINGS_KEY];
  if (!isRecord(block)) {
    warnings.push(`The "${SETTINGS_KEY}" block must be an object, got ${describeShape(block)}.`);
    return {};
  }
  return block;
}

/**
 * A value of `EXPOSURES` is taken; anything else degrades to `direct` with a warning, because the other two modes keep
 * the tools out of the prompt and a typo would silently hide memory from the model.
 */
function resolveExposure(block: Record<string, unknown>, warnings: string[]): Exposure {
  if (!("exposure" in block)) return DEFAULT_EXPOSURE;

  const value = block.exposure;
  if (isExposure(value)) return value;

  const found = typeof value === "string" ? `"${value}"` : describeShape(value);
  const allowed = EXPOSURES.map((exposure) => `"${exposure}"`).join(", ");
  warnings.push(`The "exposure" setting must be one of ${allowed}, got ${found}; "${DEFAULT_EXPOSURE}" is used.`);
  return DEFAULT_EXPOSURE;
}

/** Normalized to slugs, empties dropped one warning at a time, duplicates removed preserving the first appearance. */
function resolveCategories(block: Record<string, unknown>, warnings: string[]): readonly string[] {
  if (!("categories" in block)) return DEFAULT_CATEGORIES;

  const value = block.categories;
  if (!Array.isArray(value)) {
    warnings.push(`The "categories" setting must be an array, got ${describeShape(value)}; the defaults are used.`);
    return DEFAULT_CATEGORIES;
  }

  const categories: string[] = [];
  for (const element of value) {
    if (typeof element !== "string") {
      warnings.push(`A "categories" element must be a string, got ${describeShape(element)}; it is dropped.`);
      continue;
    }
    const slug = toSlug(element);
    if (slug === "") {
      warnings.push(`The "categories" element "${element}" normalizes to an empty slug; it is dropped.`);
      continue;
    }
    appendUnique(categories, slug);
  }

  // An empty vocabulary is not a configuration: it would reject every write, so it degrades to the default list.
  if (categories.length === 0) {
    warnings.push('No "categories" element survives normalization; the defaults are used.');
    return DEFAULT_CATEGORIES;
  }
  return categories;
}

/** `false` unless the value is exactly `true`; `false` itself is a valid boolean and warns about nothing. */
function resolveAllowUnknownCategory(block: Record<string, unknown>, warnings: string[]): boolean {
  if (!("allowUnknownCategory" in block)) return false;

  const value = block.allowUnknownCategory;
  if (typeof value === "boolean") return value;

  warnings.push(`The "allowUnknownCategory" setting must be a boolean, got ${describeShape(value)}; false is used.`);
  return false;
}

/** Environment, then the block, then `<agentDir>/lite-memories`: first absolute non-empty path wins, rejects warn. */
function resolveDir(
  block: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
  agentDir: string,
  warnings: string[],
): { dir: string; source: ResolvedConfig["source"] } {
  const fromEnv = env[DIR_ENV_VAR];
  if (fromEnv !== undefined) {
    if (isAbsolutePath(fromEnv)) return { dir: fromEnv, source: "env" };
    warnings.push(`The ${DIR_ENV_VAR} environment variable must be a non-empty absolute path, got ${quote(fromEnv)}; it is ignored.`);
  }

  if ("dir" in block) {
    const value = block.dir;
    if (isAbsolutePath(value)) return { dir: value, source: "settings" };
    warnings.push(`The "dir" setting must be a non-empty absolute path, got ${quote(value)}; it is ignored.`);
  }

  return { dir: join(agentDir, MEMORIES_DIR), source: "default" };
}

/** Arrays are their own shape here: a settings file whose top level is `[]` is an empty object to nobody. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExposure(value: unknown): value is Exposure {
  return typeof value === "string" && (EXPOSURES as readonly string[]).includes(value);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isAbsolute(value);
}

/** Name of the shape a value has, for a warning that has to say what it found instead. */
function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** The value as a warning shows it: quoted when it is a string, named by shape when it is not. */
function quote(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : describeShape(value);
}
