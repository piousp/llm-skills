import type { AgentConfig, AgentOverrides } from "./agents.ts";
import { normalizeClaudeModel } from "./claude-compat.ts";
import { WARN_PREFIX } from "./warn.ts";

export const MAX_TURNS_LIMIT = 100;

// Shared predicate: the same valid-set check (positive integer up to the limit)
// that resolveMaxTurns (run.ts) and normalizeMaxTurns (frontmatter.ts) use with
// different warn sinks. Living in one place keeps the chokepoints' "what counts
// as a valid maxTurns" definitions in lockstep; each chokepoint still owns its
// own warn and its own `number | undefined` return shape.
// (Moved here from run.ts with isValidModelRef so the runtime import graph stays
// acyclic: run.ts imports these guards from overrides.ts, and overrides.ts no
// longer imports run.ts.)
export function isValidMaxTurns(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isInteger(value)
    && value >= 1
    && value <= MAX_TURNS_LIMIT
  );
}

// Single form guard for a "provider/modelId" model reference (Q1: the one rule
// everywhere — params path here in validate.ts, run path in resolveModel).
export function isValidModelRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0) return false;
  return slashIndex < value.length - 1;
}

export interface InvocationOverride {
  model?: string;
  tools?: string[];
  skills?: string[];
  /** Per-invocation thinking-level override. Presence-gated like the other
      override fields: undefined means "inherit", any string replaces the
      frontmatter/settings value (invalid levels warn at the clampThinkingLevel
      chokepoint, not here). */
  thinking?: string;
  /** Per-invocation maxTurns override (1..100). Presence-gated like the
      other override fields: undefined means "inherit", any integer 1..100
      replaces the frontmatter/settings value. */
  maxTurns?: number;
  /** Per-invocation timeoutMs override, in ms. Presence-gated like the other
      override fields: undefined means "inherit", any value replaces the
      frontmatter/settings value (range/ceiling enforced at the
      resolveTimeoutMs chokepoint, not here). */
  timeoutMs?: number;
}

// Single source of truth for the 6 invocation-override fields, in the
// order they're checked/copied/rejected everywhere they appear (this file,
// src/validate.ts, extensions/index.ts's SubagentParams schema).
export const OVERRIDE_KEYS = ["model", "tools", "skills", "thinking", "maxTurns", "timeoutMs"] as const;

function copyOverrideKey<K extends (typeof OVERRIDE_KEYS)[number]>(
  target: AgentConfig,
  source: InvocationOverride,
  key: K,
): void {
  const value = source[key];
  if (value !== undefined) (target as Record<K, unknown>)[key] = value;
}

// Extracts the InvocationOverride carried by validated subagent params,
// independent of the agent/task fields that ride alongside it. Absent fields
// on the input stay absent on the output (never present with an `undefined`
// value), matching applyInvocationOverride's "no override fields present"
// fast path.
export function invocationOverrideOf(t: InvocationOverride): InvocationOverride {
  const result: InvocationOverride = {};
  for (const key of OVERRIDE_KEYS) {
    const value = t[key];
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

export function applyInvocationOverride(
  agent: AgentConfig,
  override: InvocationOverride,
): AgentConfig {
  if (OVERRIDE_KEYS.every((key) => override[key] === undefined)) {
    return agent;
  }

  const result: AgentConfig = { ...agent };
  for (const key of OVERRIDE_KEYS) copyOverrideKey(result, override, key);
  return result;
}

export function applyOverrides(
  agents: AgentConfig[],
  overrides: AgentOverrides,
): AgentConfig[] {
  return agents.map((agent) => {
    const override = overrides[agent.name];
    if (!override) return agent;
    return { ...agent, ...override };
  });
}

// Identity/lifecycle fields a settings file may never override: they are
// produced solely by agent discovery (name, description, source, filePath,
// systemPrompt), so a settings-supplied value could only corrupt the agent's
// identity or its documented provenance.
export const SETTINGS_EXCLUDED_FIELDS = ["name", "description", "source", "filePath", "systemPrompt"] as const;

// The complete set of AgentConfig fields a settings file MAY override.
export const SETTINGS_OVERRIDABLE_FIELDS = [
  "model",
  "tools",
  "disallowedTools",
  "skills",
  "defaultReads",
  "thinking",
  "maxTurns",
  "timeoutMs",
  "systemPromptMode",
  "inheritProjectContext",
  "inheritSkills",
  "inheritExtensions",
  "defaultContext",
] as const;

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isExcludedField(field: string): boolean {
  return (SETTINGS_EXCLUDED_FIELDS as readonly string[]).includes(field);
}

function isOverridableField(field: string): field is (typeof SETTINGS_OVERRIDABLE_FIELDS)[number] {
  return (SETTINGS_OVERRIDABLE_FIELDS as readonly string[]).includes(field);
}

// Type check for the 12 non-model overridable fields (model is checked at
// its own branch: only "must be a string" applies there). Types are checked
// here at the JSON config layer, mirroring frontmatter's layering: range and
// validity checks stay at each field's chokepoint (resolveTimeoutMs owns the
// timeoutMs ceiling, clampThinkingLevel owns thinking levels) — except
// maxTurns, where frontmatter already checks the range, so settings checks
// it here through the same isValidMaxTurns predicate (defined above in this
// module).
function isWellTypedSettingsValue(
  field: Exclude<(typeof SETTINGS_OVERRIDABLE_FIELDS)[number], "model">,
  value: unknown,
): boolean {
  switch (field) {
    case "tools":
    case "skills":
    case "disallowedTools":
    case "defaultReads":
      return isStringArray(value);
    case "thinking":
      return typeof value === "string";
    case "maxTurns":
      return isValidMaxTurns(value);
    case "timeoutMs":
      return typeof value === "number";
    case "systemPromptMode":
      return value === "append" || value === "replace";
    case "defaultContext":
      return value === "forked" || value === "fresh";
    case "inheritProjectContext":
    case "inheritSkills":
    case "inheritExtensions":
      return typeof value === "boolean";
  }
}

// Validates one agentOverrides[<agentName>] entry from a settings file.
// Warns and drops every ill-typed, excluded, or unknown field; the returned
// partial carries only validated fields. A dropped field leaves no key on
// the result; a source `model: "inherit"` stays present with an `undefined`
// value — that is how "inherit" travels through the merge to cancel a
// lower-layer model. Model form and resolvability are deliberately NOT
// judged here: any string is kept verbatim and fails the run at the
// resolveModel chokepoint instead of being silently dropped to the session
// default.
export function validateAgentOverridesEntry(
  agentName: string,
  raw: unknown,
  settingsPath: string,
): Partial<AgentConfig> {
  if (!isPlainObject(raw)) {
    console.warn(
      `${WARN_PREFIX}agentOverrides[${JSON.stringify(agentName)}] in (${settingsPath}) is not an object, ignoring`,
    );
    return {};
  }

  const label = `in agentOverrides[${JSON.stringify(agentName)}] (${settingsPath})`;
  const result: Partial<AgentConfig> = {};

  for (const [field, value] of Object.entries(raw)) {
    if (isExcludedField(field)) {
      console.warn(
        `${WARN_PREFIX}agentOverrides[${JSON.stringify(agentName)}].${field} in (${settingsPath}) is not overridable (identity/lifecycle field), ignoring`,
      );
      continue;
    }
    if (!isOverridableField(field)) {
      console.warn(
        `${WARN_PREFIX}unknown field ${JSON.stringify(field)} ${label}, ignoring`,
      );
      continue;
    }
    if (field === "model") {
      if (typeof value !== "string") {
        console.warn(`${WARN_PREFIX}invalid model ${JSON.stringify(value)} ${label}, ignoring`);
        continue;
      }
      // "inherit" → undefined via normalizeClaudeModel's inherit mapping;
      // any other string is kept verbatim (no alias semantics hard-coded).
      result.model = value === "inherit" ? normalizeClaudeModel(value).model : value;
      continue;
    }
    if (!isWellTypedSettingsValue(field, value)) {
      console.warn(`${WARN_PREFIX}invalid ${field} ${JSON.stringify(value)} ${label}, ignoring`);
      continue;
    }
    (result as Record<string, unknown>)[field] = value;
  }

  return result;
}
