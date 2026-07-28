import os from "node:os";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createAgentSession, DefaultResourceLoader, SessionManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { discoverAgents, applyOverrides, loadOverrides, type AgentConfig, type AgentOverrides, type CacheEntry } from "../src/agents.ts";
import { runAgentViaSdk, mapWithConcurrencyLimit, type AgentRunResult } from "../src/run.ts";
import { formatRunResults } from "../src/format-results.ts";
import { validateSubagentParams, resolveAgents } from "../src/validate.ts";

const AGENTS_DIR = path.join(os.homedir(), ".pi/agent/agents");

const agentCache = new Map<string, CacheEntry<AgentConfig[]>>();
const overridesCache = new Map<string, CacheEntry<AgentOverrides>>();

function loadAvailableAgents(cwd: string): AgentConfig[] {
  const agents = discoverAgents(AGENTS_DIR, agentCache);
  const userSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
  const overrides = loadOverrides(userSettingsPath, projectSettingsPath, overridesCache);
  return applyOverrides(agents, overrides);
}

function errorResult(error: string) {
  return {
    content: [{ type: "text" as const, text: error }],
    details: { error },
    isError: true,
  };
}

type TaskEntry = { agent: string; task: string };

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  tasks: Type.Optional(
    Type.Array(
      Type.Object({
        agent: Type.String(),
        task: Type.String(),
      }),
    ),
  ),
});
type SubagentArgs = Static<typeof SubagentParams>;

function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0] ?? "";
}

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

// Collapsed one-line summary for a single task entry, e.g. "agent: first line of the task".
function describeTask(t: TaskEntry): string {
  return `${t.agent}: ${truncate(firstLine(t.task))}`;
}

// Renders the tool_box title: agent name + truncated first line of the task.
// The host only supports expand/collapse on the result body (renderResult),
// not on the call title, so there is no separate "expanded" title variant.
function renderSubagentCall(args: SubagentArgs, theme: Theme) {
  const prefix = theme.fg("toolTitle", theme.bold("subagent "));

  if (args.tasks?.length) {
    const suffix = args.tasks.length > 1 ? ", ..." : "";
    return new Text(`${prefix}(${args.tasks.length}): ${describeTask(args.tasks[0])}${suffix}`, 0, 0);
  }

  const agent = args.agent ?? "?";
  const task = args.task ? `: ${truncate(firstLine(args.task))}` : "";
  return new Text(`${prefix}${theme.fg("accent", agent)}${task}`, 0, 0);
}

// Normalizes validateSubagentParams' two accepted shapes ({agent, task} or
// {tasks: [...]}) into the single task-entry array every downstream step
// (agent resolution, spawning, progress indexing) operates on.
function normalizeTasks(params: { agent?: string; task?: string; tasks?: TaskEntry[] }): TaskEntry[] {
  return params.tasks === undefined ? [{ agent: params.agent!, task: params.task! }] : params.tasks;
}

function createMinimalResourceLoader(agent: AgentConfig, cwd: string): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir: path.join(os.homedir(), ".pi", "agent"),
    noExtensions: true,
    noSkills: agent.inheritSkills === false,
    noContextFiles: agent.inheritProjectContext === false,
    systemPromptOverride:
      agent.systemPromptMode === "replace" && agent.systemPrompt
        ? () => agent.systemPrompt
        : undefined,
    appendSystemPromptOverride:
      agent.systemPromptMode === "append" && agent.systemPrompt
        ? (base) => [...base, agent.systemPrompt]
        : undefined,
  });
}

// Runs every task with concurrency limit (4) via the SDK runner.
// Returns settled results in the same order as `tasks`.
// No onUpdate calls during progress — the TUI renders a lightweight "Running..."
// indicator by default, avoiding the cost of repeated full re-renders.
async function runTasks(
  tasks: TaskEntry[],
  resolvedAgents: AgentConfig[],
  cwd: string,
  signal: AbortSignal | undefined,
  modelRuntime: ModelRuntime,
): Promise<AgentRunResult[]> {
  return mapWithConcurrencyLimit(tasks, 4, async (t, index) => {
    const agent = resolvedAgents[index];

    const resourceLoader = createMinimalResourceLoader(agent, cwd);
    await resourceLoader.reload();

    return runAgentViaSdk(agent, t.task, {
      modelRuntime,
      signal,
      createSession: createAgentSession as any,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      getModel: (provider, modelId) => modelRuntime.getModel(provider, modelId),
    });
  });
}

function renderSubagentResult(
  result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  _context: { lastComponent?: Text },
): Text {
  // During progress, return empty text — the TUI already shows a generic
  // "Running..." indicator. No setText, no re-render for incremental updates.
  if (options.isPartial) return new Text("", 0, 0);

  // Final result: show the full content.
  const content = result.content.map((c) => c.text ?? "").join("\n");
  return new Text(content ? theme.fg("toolOutput", content) : "", 0, 0);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Run one or more subagents and wait for their results",
    parameters: SubagentParams,
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
    execute: async (_toolCallId, rawParams, signal, onUpdate, ctx) => {
      const parsedParams = validateSubagentParams(rawParams);
      if (!parsedParams.ok) {
        return errorResult(parsedParams.error);
      }

      const tasks = normalizeTasks(parsedParams.value);

      const availableAgents = loadAvailableAgents(ctx.cwd);
      const resolved = resolveAgents(tasks.map((t) => t.agent), availableAgents);
      if (!resolved.ok) {
        return errorResult(resolved.error);
      }

      const modelRuntime = (ctx.modelRegistry as any).runtime as ModelRuntime;
      const results = await runTasks(tasks, resolved.value, ctx.cwd, signal, modelRuntime);

      const formatted = formatRunResults(results);
      return {
        content: [{ type: "text", text: formatted.text }],
        details: { runs: results },
        isError: formatted.isError,
      };
    },
  });
}