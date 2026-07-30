import type { AgentConfig, InvocationOverride } from "./agents.ts";

export type TaskEntry = { agent: string; task: string } & InvocationOverride;

// Extracts the InvocationOverride carried by a TaskEntry (or by validated
// single-mode args of the same shape), independent of the agent/task fields
// that ride alongside it. Absent fields on the input stay absent on the
// output (never present with an `undefined` value), matching
// applyInvocationOverride's "no override fields present" fast path.
export function invocationOverrideOf(
  t: { model?: string; tools?: string[]; skills?: string[] },
): InvocationOverride {
  return {
    ...(t.model !== undefined ? { model: t.model } : {}),
    ...(t.tools !== undefined ? { tools: t.tools } : {}),
    ...(t.skills !== undefined ? { skills: t.skills } : {}),
  };
}

export type SubagentParams =
  | ({ agent: string; task: string; tasks?: undefined } & InvocationOverride)
  | {
      agent?: undefined;
      task?: undefined;
      model?: undefined;
      tools?: undefined;
      skills?: undefined;
      tasks: TaskEntry[];
    };

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
  return {
    ok: true,
    value: {
      agent: raw.agent,
      task: raw.task,
      ...invocationOverrideOf(raw as { model?: string; tools?: string[]; skills?: string[] }),
    },
  };
}

function validateTasksMode(raw: Record<string, unknown>): ValidationResult<SubagentParams> {
  const topLevelOverrideFields: Array<["model" | "tools" | "skills", unknown]> = [
    ["model", raw.model],
    ["tools", raw.tools],
    ["skills", raw.skills],
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

  return {
    ok: true,
    value: { tasks: raw.tasks as TaskEntry[] },
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
