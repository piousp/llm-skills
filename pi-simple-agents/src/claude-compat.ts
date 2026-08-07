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

// Filter names down to those the inert set recognises and tag each with a
// `prefix:` so downstream sorting/claim logic can tell the groups apart.
// Same filter+map shape across fields/tools/models, so it lives here once.
function inertKeysFor<T>(set: ReadonlySet<T>, names: Iterable<T>, prefix: string): string[] {
  return [...names]
    .filter((name) => set.has(name))
    .map((name) => `${prefix}:${name}`);
}

export function reportInertUsage(
  usage: { fields: Iterable<string>; tools: Iterable<string>; models: Iterable<string> },
  registry: Map<string, number>,
): string | undefined {
  const inertKeys = [
    ...inertKeysFor(CLAUDE_INERT_FIELDS, usage.fields, "field"),
    ...inertKeysFor(CLAUDE_INERT_TOOLS, usage.tools, "tool"),
    ...inertKeysFor(CLAUDE_MODEL_ALIASES, usage.models, "model"),
  ];
  const claimed = claimUnwarned(inertKeys, registry);

  if (claimed.length === 0) return undefined;

  const fields = claimed
    .filter((key) => key.startsWith("field:"))
    .map((key) => key.slice("field:".length))
    .sort();
  const tools = claimed
    .filter((key) => key.startsWith("tool:"))
    .map((key) => key.slice("tool:".length))
    .sort();
  const models = claimed
    .filter((key) => key.startsWith("model:"))
    .map((key) => key.slice("model:".length))
    .sort();

  const parts: string[] = [];
  if (fields.length > 0) parts.push(`fields: ${fields.join(", ")}`);
  if (tools.length > 0) parts.push(`tools: ${tools.join(", ")}`);
  if (models.length > 0) {
    parts.push(`model aliases: ${models.join(", ")} (Claude Code compatibility)`);
  }

  return `pi-simple-agents: accepted but inert in pi — ${parts.join("; ")}`;
}
