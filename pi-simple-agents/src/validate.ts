import type { AgentConfig } from "./agents.ts";
import {
  invocationOverrideOf,
  isValidModelRef,
  isStringArray,
  overrideValueMatches,
  OVERRIDE_KEYS,
  OVERRIDE_TYPE_SPEC,
  type InvocationOverride,
} from "./overrides.ts";
import { WARN_PREFIX } from "./warn.ts";

// Re-exports: override semantics moved to src/overrides.ts (single home);
// these keep this module's previous export surface valid. render-call.ts
// and task-runner.ts import invocationOverrideOf through this re-export;
// applyInvocationOverride consumers resolve it via agents.ts's re-export.
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

// isStringArray/isValidModelRef come from src/overrides.ts — their single home.
function validateModelRef(value: unknown, label: string): string | undefined {
  if (value === undefined || isValidModelRef(value)) return undefined;
  return `${label} must be a string in "provider/modelId" form, e.g. "anthropic/claude-opus-4-8".`;
}

function validateStringArrayRef(value: unknown, label: string): string | undefined {
  if (value === undefined || isStringArray(value)) return undefined;
  return `${label} must be an array of strings.`;
}

// Drops the scalar invocation-override fields whose type does not match the
// shared type spec (src/overrides.ts's OVERRIDE_TYPE_SPEC — the same table
// the settings/ack layers read), warning each drop with a location suffix
// and building the result by destructure-rest, so an ill-typed field is
// never carried on the produced value. Only the scalar trio runs here:
// model/tools/skills keep their own hard-error checks above (an ill-typed
// one is a validation error, not a silent drop). Range/integer/level-validity checks
// intentionally live at each field's own use site (resolveMaxTurns,
// resolveTimeoutMs, clampThinkingLevel), not here.
function warnAndDropIllTypedOverrides(
  record: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  let result = record;
  for (const field of OVERRIDE_KEYS) {
    if (field === "model" || field === "tools" || field === "skills") continue;
    if (result[field] !== undefined && !overrideValueMatches(result[field], OVERRIDE_TYPE_SPEC[field])) {
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
