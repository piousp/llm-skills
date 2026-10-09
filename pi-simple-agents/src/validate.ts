import type { AgentConfig } from "./agents.ts";
import { invocationOverrideOf, type InvocationOverride } from "./overrides.ts";
import { WARN_PREFIX } from "./warn.ts";

// Re-exports: override semantics moved to src/overrides.ts (single home);
// these keep this module's previous export surface valid for its importers
// (render-call.ts, extensions/task-runner.ts, run.test.ts, validate.test.ts).
export { invocationOverrideOf, applyInvocationOverride, applyOverrides, OVERRIDE_KEYS } from "./overrides.ts";
export type { InvocationOverride } from "./overrides.ts";

export type SubagentParams = { agent: string; task: string } & InvocationOverride;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidModelRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0) return false;
  return slashIndex < value.length - 1;
}

function validateModelRef(value: unknown, label: string): string | undefined {
  if (value === undefined || isValidModelRef(value)) return undefined;
  return `${label} must be a string in "provider/modelId" form, e.g. "anthropic/claude-opus-4-8".`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function validateStringArrayRef(value: unknown, label: string): string | undefined {
  if (value === undefined || isStringArray(value)) return undefined;
  return `${label} must be an array of strings.`;
}

// Shared type-guard for the scalar invocation-override fields (maxTurns,
// timeoutMs, thinking): same condition (present and wrong type), same warn
// text format with a location suffix, and a single drop mechanism
// (destructure-rest) so the produced value never carries an ill-typed field.
// Range/integer/level-validity checks intentionally live at each field's own
// use site (resolveMaxTurns, resolveTimeoutMs, clampThinkingLevel), not here.
const OVERRIDE_TYPE_SPEC: ReadonlyArray<readonly [field: "maxTurns" | "timeoutMs" | "thinking", expected: "number" | "string"]> = [
  ["maxTurns", "number"],
  ["timeoutMs", "number"],
  ["thinking", "string"],
];

function warnAndDropIllTypedOverrides(
  record: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  let result = record;
  for (const [field, expected] of OVERRIDE_TYPE_SPEC) {
    if (result[field] !== undefined && typeof result[field] !== expected) {
      console.warn(
        `${WARN_PREFIX}invalid ${field} ${JSON.stringify(result[field])} ${label}, ignoring`,
      );
      const { [field]: _dropped, ...rest } = result;
      result = rest;
    }
  }
  return result;
}

export function validateSubagentParams(raw: unknown): ValidationResult<SubagentParams> {
  if (!isRecord(raw)) {
    return { ok: false, error: 'Provide an object with "agent" and "task".' };
  }

  if (!isNonEmptyString(raw.agent)) {
    return { ok: false, error: '"agent" must be a non-empty string.' };
  }
  if (!isNonEmptyString(raw.task)) {
    return { ok: false, error: '"task" must be a non-empty string.' };
  }
  const modelError = validateModelRef(raw.model, '"model"');
  if (modelError) return { ok: false, error: modelError };
  const toolsError = validateStringArrayRef(raw.tools, '"tools"');
  if (toolsError) return { ok: false, error: toolsError };
  const skillsError = validateStringArrayRef(raw.skills, '"skills"');
  if (skillsError) return { ok: false, error: skillsError };

  // See warnAndDropIllTypedOverrides above for what this drops and why.
  const cleaned = warnAndDropIllTypedOverrides(raw, "in subagent params");
  return {
    ok: true,
    value: {
      agent: raw.agent,
      task: raw.task,
      ...invocationOverrideOf(cleaned as InvocationOverride),
    },
  };
}

// Validates that `name` is a known agent and resolves it to its full
// AgentConfig, so callers never need a post-hoc `.find(...)!` lookup.
export function resolveAgent(
  name: string,
  agents: readonly AgentConfig[],
): ValidationResult<AgentConfig> {
  const found = agents.find((agent) => agent.name === name);
  if (found) return { ok: true, value: found };
  const availableNames = agents.map((agent) => agent.name).join(", ");
  return { ok: false, error: `Unknown agent: ${name}. Available agents: ${availableNames}` };
}
