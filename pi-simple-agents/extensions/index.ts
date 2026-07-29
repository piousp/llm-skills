import os from "node:os";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { ExtensionAPI, Theme, ToolRenderResultOptions, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { createAgentSession, DefaultResourceLoader, SessionManager, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { discoverAgents, applyOverrides, loadOverrides, type AgentConfig, type AgentOverrides, type CacheEntry } from "../src/agents.ts";
import { runAgentViaSdk, mapWithConcurrencyLimit, type AgentRunResult } from "../src/run.ts";
import { formatRunResults } from "../src/format-results.ts";
import { validateSubagentParams, resolveAgents } from "../src/validate.ts";
import { buildSubagentCallText } from "../src/render-call.ts";
import { buildLoaderOptions } from "../src/loader-config.ts";
import { createSubagentSessionManager } from "../src/subagent-session.ts";
import { buildSubagentToolDescription } from "../src/tool-description.ts";
import { emitWarnings } from "../src/warn.ts";

const AGENTS_DIR = path.join(os.homedir(), ".pi/agent/agents");
const SUBAGENT_SESSIONS_DIR = path.join(os.homedir(), ".pi/agent/sessions/subagents");
const SESSION_MANAGER_FACTORY = {
  forkFrom: (s: string, t: string, d: string) => SessionManager.forkFrom(s, t, d),
  inMemory: (c: string) => SessionManager.inMemory(c),
};

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

// Builds a name→config lookup for the render-time parameter line.
function toParamAgentsMap(agents: AgentConfig[]): Map<string, AgentConfig> {
  return new Map(agents.map((agent) => [agent.name, agent]));
}

// `ToolRenderContext` isn't re-exported from the package's public entry point,
// so this structural subset (the only fields used here) stands in for it. It
// stays assignable to the real renderCall context param because every field
// it declares also exists on the host's ToolRenderContext.
interface RenderCallContext {
  cwd: string;
  argsComplete: boolean;
}

// Renders the tool_box title: agent name + truncated first line of the task.
// The host only supports expand/collapse on the result body (renderResult),
// not on the call title, so there is no separate "expanded" title variant.
function renderSubagentCall(
  args: SubagentArgs,
  theme: Theme,
  context: RenderCallContext | undefined,
) {
  const paramAgents = context?.argsComplete
    ? toParamAgentsMap(loadAvailableAgents(context.cwd))
    : new Map<string, AgentConfig>();
  return new Text(buildSubagentCallText(args, theme, paramAgents), 0, 0);
}

// Normalizes validateSubagentParams' two accepted shapes ({agent, task} or
// {tasks: [...]}) into the single task-entry array every downstream step
// (agent resolution, spawning, progress indexing) operates on.
function normalizeTasks(params: { agent?: string; task?: string; tasks?: TaskEntry[] }): TaskEntry[] {
  return params.tasks === undefined ? [{ agent: params.agent!, task: params.task! }] : params.tasks;
}

function createMinimalResourceLoader(agent: AgentConfig, cwd: string): DefaultResourceLoader {
  const result = buildLoaderOptions(agent, cwd, os.homedir());
  emitWarnings(result.warnings);
  return new DefaultResourceLoader(result.options);
}

// Runs every task with concurrency limit (4) via the SDK runner.
// Returns settled results in the same order as `tasks`.
// No onUpdate calls during progress — the TUI renders a lightweight "Running..."
// indicator by default, avoiding the cost of repeated full re-renders.
interface RunTasksOptions {
  cwd: string;
  signal: AbortSignal | undefined;
  modelRegistry: ModelRegistry;
  callerSessionFile: string | undefined;
}

async function runTasks(
  tasks: TaskEntry[],
  resolvedAgents: AgentConfig[],
  options: RunTasksOptions,
): Promise<AgentRunResult[]> {
  const { cwd, signal, modelRegistry, callerSessionFile } = options;
  return mapWithConcurrencyLimit(tasks, 4, async (t, index) => {
    const agent = resolvedAgents[index];

    const resourceLoader = createMinimalResourceLoader(agent, cwd);
    await resourceLoader.reload();

    const { manager, warnings } = createSubagentSessionManager(
      agent,
      callerSessionFile,
      cwd,
      SUBAGENT_SESSIONS_DIR,
      SESSION_MANAGER_FACTORY,
    );
    emitWarnings(warnings);

    return runAgentViaSdk(agent, t.task, {
      modelRegistry,
      signal,
      createSession: createAgentSession,
      resourceLoader,
      sessionManager: manager,
      getModel: (provider, modelId) => modelRegistry.find(provider, modelId),
    });
  });
}

function renderSubagentResult(
  result: AgentToolResult<Record<string, unknown> | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _context: { lastComponent?: Component },
): Text {
  // During progress, return empty text — the TUI already shows a generic
  // "Running..." indicator. No setText, no re-render for incremental updates.
  if (options.isPartial) return new Text("", 0, 0);

  // Final result: show the full content.
  const content = result.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("\n");
  return new Text(content ? theme.fg("toolOutput", content) : "", 0, 0);
}

export default function (pi: ExtensionAPI) {
  const description = buildSubagentToolDescription(loadAvailableAgents(process.cwd()));
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description,
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

      const results = await runTasks(tasks, resolved.value, {
        cwd: ctx.cwd,
        signal,
        modelRegistry: ctx.modelRegistry,
        callerSessionFile: ctx.sessionManager.getSessionFile(),
      });

      const formatted = formatRunResults(results);
      return {
        content: [{ type: "text", text: formatted.text }],
        details: { runs: results },
        isError: formatted.isError,
      };
    },
  });
}