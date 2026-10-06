import { WARN_PREFIX } from "./warn.ts";

export const CLAUDE_TOOL_MAP: Readonly<Record<string, string>> = {
  Read: "read",
  Grep: "grep",
  Glob: "find",
  Bash: "bash",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  LS: "ls",
  WebSearch: "web_search",
  WebFetch: "web_read",
};

export const CLAUDE_INERT_TOOLS: ReadonlySet<string> = new Set([
  "Task",
  "TodoWrite",
  "NotebookEdit",
  "SlashCommand",
  "KillShell",
  "BashOutput",
  "ExitPlanMode",
  "AskUserQuestion",
]);

export const CLAUDE_INERT_FIELDS: ReadonlySet<string> = new Set([
  "permissionMode",
  "mcpServers",
  "hooks",
  "memory",
  "background",
  "isolation",
  "color",
  "effort",
  "initialPrompt",
]);

export const CLAUDE_MODEL_ALIASES: ReadonlySet<string> = new Set([
  "sonnet",
  "opus",
  "haiku",
  "fable",
]);

export function mapClaudeTools(names: string[]): { tools: string[]; inert: string[] } {
  const tools: string[] = [];
  const inert: string[] = [];
  const seenTools = new Set<string>();
  const seenInert = new Set<string>();

  for (const name of names) {
    const mapped = CLAUDE_TOOL_MAP[name] ?? name;
    if (!seenTools.has(mapped)) {
      seenTools.add(mapped);
      tools.push(mapped);
    }
    if (CLAUDE_INERT_TOOLS.has(name) && !seenInert.has(name)) {
      seenInert.add(name);
      inert.push(name);
    }
  }

  return { tools, inert };
}

export function normalizeClaudeModel(model: string): { model?: string; alias?: string } {
  if (model === "inherit") {
    return { model: undefined };
  }
  if (CLAUDE_MODEL_ALIASES.has(model)) {
    return { model, alias: model };
  }
  return { model };
}

export function claimUnwarned(
  keys: string[],
  registry: Map<string, number>,
  ttlMs = 60_000,
): string[] {
  const now = Date.now();
  const claimed: string[] = [];

  for (const key of keys) {
    const lastWarned = registry.get(key);
    if (lastWarned === undefined || now - lastWarned >= ttlMs) {
      claimed.push(key);
      registry.set(key, now);
    }
  }

  return claimed;
}

// Filters names down to those the inert set recognises, claims each
// (prefixing only to namespace the shared registry's keys across the three
// groups — a tool and a model alias could share a literal name), and
// returns the ones actually claimed this cycle, sorted. Grouping happens on
// the plain names before the prefix is added, so there's no decode step.
function claimedNamesFor<T extends string>(
  prefix: string,
  set: ReadonlySet<T>,
  names: Iterable<T>,
  registry: Map<string, number>,
): T[] {
  const candidates = [...names].filter((name) => set.has(name));
  const claimed = new Set(claimUnwarned(candidates.map((name) => `${prefix}:${name}`), registry));
  return candidates.filter((name) => claimed.has(`${prefix}:${name}`)).sort();
}

export function reportInertUsage(
  usage: { fields: Iterable<string>; tools: Iterable<string>; models: Iterable<string> },
  registry: Map<string, number>,
): string | undefined {
  const fields = claimedNamesFor("field", CLAUDE_INERT_FIELDS, usage.fields, registry);
  const tools = claimedNamesFor("tool", CLAUDE_INERT_TOOLS, usage.tools, registry);
  const models = claimedNamesFor("model", CLAUDE_MODEL_ALIASES, usage.models, registry);

  if (fields.length === 0 && tools.length === 0 && models.length === 0) return undefined;

  const parts: string[] = [];
  if (fields.length > 0) parts.push(`fields: ${fields.join(", ")}`);
  if (tools.length > 0) parts.push(`tools: ${tools.join(", ")}`);
  if (models.length > 0) {
    parts.push(`model aliases: ${models.join(", ")} (Claude Code compatibility)`);
  }

  return `${WARN_PREFIX}accepted but inert in pi — ${parts.join("; ")}`;
}
