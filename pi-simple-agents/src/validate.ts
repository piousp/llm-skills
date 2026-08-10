import type { AgentConfig, InvocationOverride } from "./agents.ts";

export type TaskEntry = { agent: string; task: string } & InvocationOverride;

// Extracts the InvocationOverride carried by a TaskEntry (or by validated
// single-mode args of the same shape), independent of the agent/task fields
// that ride alongside it. Absent fields on the input stay absent on the
// output (never present with an `undefined` value), matching
// applyInvocationOverride's "no override fields present" fast path.
export function invocationOverrideOf(t: InvocationOverride): InvocationOverride {
  return {
    ...(t.model !== undefined ? { model: t.model } : {}),
    ...(t.tools !== undefined ? { tools: t.tools } : {}),
    ...(t.skills !== undefined ? { skills: t.skills } : {}),
    ...(t.thinking !== undefined ? { thinking: t.thinking } : {}),
    ...(t.maxTurns !== undefined ? { maxTurns: t.maxTurns } : {}),
    ...(t.timeoutMs !== undefined ? { timeoutMs: t.timeoutMs } : {}),
  };
}

export type SubagentParams =
  | ({ agent: string; task: string; tasks?: undefined } & InvocationOverride)
  | ({ agent?: undefined; task?: undefined; tasks: TaskEntry[] }
      & Partial<Record<keyof InvocationOverride, undefined>>);

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const MAX_PARALLEL_TASKS = 8;

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
// timeoutMs, thinking): same condition (present and wrong type) across
// single-mode and tasks-mode paths, same warn text format with a location
// suffix, and a single drop mechanism (destructure-rest) so the produced
// value never carries an ill-typed field. Range/integer/level-validity
// checks intentionally live at each field's own use site (resolveMaxTurns,
// resolveTimeoutMs, clampThinkingLevel), not here.
const OVERRIDE_TYPE_SPEC: ReadonlyArray<readonly [field: "maxTurns" | "timeoutMs" | "thinking", expected: "number" | "string"]> = [
  ["maxTurns", "number"],
  ["timeoutMs", "number"],
  ["thinking", "string"],
];

function warnAndDropIllTypedOverrides<T extends Record<string, unknown>>(
  record: T,
  label: string,
): T {
  let result = record;
  for (const [field, expected] of OVERRIDE_TYPE_SPEC) {
    if (result[field] !== undefined && typeof result[field] !== expected) {
      console.warn(
        `pi-simple-agents: invalid ${field} ${JSON.stringify(result[field])} ${label}, ignoring`,
      );
      const { [field]: _dropped, ...rest } = result;
      result = rest as unknown as T;
    }
  }
  return result;
}

function validateTaskEntry(entry: unknown, index: number): string | undefined {
  if (!isRecord(entry)) return `tasks[${index}] must be an object with "agent" and "task"`;
  if (!isNonEmptyString(entry.agent)) return `tasks[${index}].agent must be a non-empty string`;
  if (!isNonEmptyString(entry.task)) return `tasks[${index}].task must be a non-empty string`;
  const modelError = validateModelRef(entry.model, `tasks[${index}].model`);
  if (modelError) return modelError;
  const toolsError = validateStringArrayRef(entry.tools, `tasks[${index}].tools`);
  if (toolsError) return toolsError;
  const skillsError = validateStringArrayRef(entry.skills, `tasks[${index}].skills`);
  if (skillsError) return skillsError;
  return undefined;
}

function validateSingleMode(raw: Record<string, unknown>): ValidationResult<SubagentParams> {
  if (!isNonEmptyString(raw.agent)) {
    return { ok: false, error: '"agent" must be a non-empty string.' };
  }
  if (!isNonEmptyString(raw.task)) {
    return { ok: false, error: '"task" must be a non-empty string.' };
  }
  const modelError = validateModelRef(raw.model, '"model"');
  if (modelError) {
    return { ok: false, error: modelError };
  }
  const toolsError = validateStringArrayRef(raw.tools, '"tools"');
  if (toolsError) {
    return { ok: false, error: toolsError };
  }
  const skillsError = validateStringArrayRef(raw.skills, '"skills"');
  if (skillsError) {
    return { ok: false, error: skillsError };
  }
  // maxTurns/timeoutMs/thinking: minimal type-guard at this validation seam.
  // Correctly-typed values pass through unchanged; anything else is warned
  // and dropped, so each field's use site never sees the wrong type.
  // Range/integer/level checks intentionally live at those use sites, not here.
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

function validateTasksMode(raw: Record<string, unknown>): ValidationResult<SubagentParams> {
  const topLevelOverrideFields: Array<[keyof InvocationOverride, unknown]> = [
    ["model", raw.model],
    ["tools", raw.tools],
    ["skills", raw.skills],
    ["thinking", raw.thinking],
    ["maxTurns", raw.maxTurns],
    ["timeoutMs", raw.timeoutMs],
  ];
  for (const [field, value] of topLevelOverrideFields) {
    if (value !== undefined) {
      return {
        ok: false,
        error: `top-level "${field}" is only valid with {agent, task}; in tasks mode set "${field}" per entry.`,
      };
    }
  }

  if (!Array.isArray(raw.tasks)) {
    return { ok: false, error: '"tasks" must be an array.' };
  }

  if (raw.tasks.length === 0) {
    return { ok: false, error: '"tasks" must not be empty.' };
  }

  if (raw.tasks.length > MAX_PARALLEL_TASKS) {
    return {
      ok: false,
      error: `"tasks" has ${raw.tasks.length} entries, exceeding MAX_PARALLEL_TASKS (${MAX_PARALLEL_TASKS}).`,
    };
  }

  for (let i = 0; i < raw.tasks.length; i++) {
    const entryError = validateTaskEntry(raw.tasks[i], i);
    if (entryError) return { ok: false, error: entryError };
  }

  // Drop ill-typed override fields from each entry, warning once per bad
  // value (see warnAndDropIllTypedOverrides). Entries with correctly-typed or
  // absent fields pass through unchanged. validateTaskEntry above guarantees
  // every entry is a record with the required agent/task shape, so the casts
  // are safe.
  const validatedTasks: TaskEntry[] = raw.tasks.map((entry, i) =>
    warnAndDropIllTypedOverrides(
      entry as Record<string, unknown>,
      `in tasks[${i}]`,
    ) as unknown as TaskEntry
  );

  return {
    ok: true,
    value: { tasks: validatedTasks },
  };
}

export function validateSubagentParams(raw: unknown): ValidationResult<SubagentParams> {
  if (!isRecord(raw)) {
    return { ok: false, error: 'Provide either {agent, task} or {tasks: [...]}, not neither.' };
  }

  const hasSingle = raw.agent !== undefined || raw.task !== undefined;
  const hasTasks = raw.tasks !== undefined;

  if (hasSingle && hasTasks) {
    return {
      ok: false,
      error: "Provide exactly one of {agent, task} or {tasks: [...]}, not both.",
    };
  }

  if (!hasSingle && !hasTasks) {
    return {
      ok: false,
      error: "Provide exactly one of {agent, task} or {tasks: [...]}; neither was given.",
    };
  }

  return hasSingle ? validateSingleMode(raw) : validateTasksMode(raw);
}

// Normalizes validateSubagentParams' two accepted shapes ({agent, task} or
// {tasks: [...]}) into the single task-entry array every downstream step
// (agent resolution, spawning, progress indexing) operates on.
export function normalizeTasks(params: SubagentParams): TaskEntry[] {
  return params.tasks === undefined
    ? [
        {
          agent: params.agent,
          task: params.task,
          ...invocationOverrideOf(params),
        },
      ]
    : params.tasks;
}

function findUnknownNames(names: string[], availableNames: string[]): string[] {
  return names.filter((name) => !availableNames.includes(name));
}

function unknownAgentsMessage(unknown: string[], availableNames: string[]): string {
  return `Unknown agent(s): ${unknown.join(", ")}. Available agents: ${availableNames.join(", ")}`;
}

// Validates every name in `names` exists among `agents` (one unified message
// listing every unknown name, not just the first) and resolves them to their
// full AgentConfig so callers never need a post-hoc `.find(...)!` lookup.
export function resolveAgents(
  names: string[],
  agents: readonly AgentConfig[],
): ValidationResult<AgentConfig[]> {
  const availableNames = agents.map((agent) => agent.name);
  const unknown = findUnknownNames(names, availableNames);
  if (unknown.length > 0) {
    return { ok: false, error: unknownAgentsMessage(unknown, availableNames) };
  }

  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  const resolved = names.map((name) => byName.get(name)!);
  return { ok: true, value: resolved };
}
