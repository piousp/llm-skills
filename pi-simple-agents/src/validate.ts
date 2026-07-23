import type { AgentConfig } from "./agents.ts";

export type SubagentParams =
  | { agent: string; task: string; tasks?: undefined }
  | { agent?: undefined; task?: undefined; tasks: Array<{ agent: string; task: string }> };

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const MAX_PARALLEL_TASKS = 8;

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateTaskEntry(entry: unknown, index: number): string | undefined {
  if (!isRecord(entry)) return `tasks[${index}] must be an object with "agent" and "task"`;
  if (!isNonEmptyString(entry.agent)) return `tasks[${index}].agent must be a non-empty string`;
  if (!isNonEmptyString(entry.task)) return `tasks[${index}].task must be a non-empty string`;
  return undefined;
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

  if (hasSingle) {
    if (!isNonEmptyString(raw.agent)) {
      return { ok: false, error: '"agent" must be a non-empty string.' };
    }
    if (!isNonEmptyString(raw.task)) {
      return { ok: false, error: '"task" must be a non-empty string.' };
    }
    return { ok: true, value: { agent: raw.agent, task: raw.task } };
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
    value: { tasks: raw.tasks as Array<{ agent: string; task: string }> },
  };
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
  agents: AgentConfig[],
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
