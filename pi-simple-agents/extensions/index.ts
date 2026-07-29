import os from "node:os";
import path from "node:path";
import { Type, type Static } from "typebox";
import type {
  ExtensionAPI,
  Theme,
  ToolRenderResultOptions,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { createAgentSession, DefaultResourceLoader, SessionManager, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { discoverAgents, applyOverrides, loadOverrides, type AgentConfig, type AgentOverrides, type CacheEntry } from "../src/agents.ts";
import { runAgentViaSdk, mapWithConcurrencyLimit, type AgentRunResult } from "../src/run.ts";
import { createProgressTracker, buildProgressLines, type TaskProgress, type ProgressTracker } from "../src/progress.ts";
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

// One discriminated union for every shape the subagent tool's `details` field
// can take, replacing the ad-hoc `Record<string, unknown> | undefined` it used
// to flow through. A type alias (not an interface) is used deliberately: object
// type aliases carry an implicit index signature, so each member stays
// assignable to `Record<string, unknown>` wherever the host's tool types still
// expect that shape.
export type SubagentToolDetails =
  | { progress: readonly TaskProgress[] }
  | { runs: AgentRunResult[] }
  | { error: string };

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
// When `onUpdate` is provided, tracks per-task tool-use progress (see
// src/progress.ts) and re-emits the full progress array on every tool-start/
// tool-end event and when each task settles, so the TUI can render a live
// feed. When `onUpdate` is absent, no progress tracking happens at all.
interface RunTasksOptions {
  cwd: string;
  signal: AbortSignal | undefined;
  modelRegistry: ModelRegistry;
  callerSessionFile: string | undefined;
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined;
}

// Runs one task end-to-end: resource loader creation/reload, session manager
// creation, the SDK run, and progress tracking teardown. Extracted from
// `runTasks` so the concurrency orchestration there stays a thin wrapper.
async function runSingleTask(
  t: TaskEntry,
  agent: AgentConfig,
  index: number,
  tracker: ProgressTracker | undefined,
  options: Omit<RunTasksOptions, "onUpdate">,
): Promise<AgentRunResult> {
  const { cwd, signal, modelRegistry, callerSessionFile } = options;

  try {
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

    return await runAgentViaSdk(agent, t.task, {
      modelRegistry,
      signal,
      createSession: createAgentSession,
      resourceLoader,
      sessionManager: manager,
      getModel: (provider, modelId) => modelRegistry.find(provider, modelId),
      onToolEvent: tracker ? (event) => tracker.onToolEvent(index, event) : undefined,
    });
  } finally {
    tracker?.markTaskDone(index);
  }
}

async function runTasks(
  tasks: TaskEntry[],
  resolvedAgents: AgentConfig[],
  options: RunTasksOptions,
): Promise<AgentRunResult[]> {
  const { cwd, signal, modelRegistry, callerSessionFile, onUpdate } = options;

  const tracker = onUpdate
    ? createProgressTracker(tasks.map((t) => t.agent), (details) => onUpdate({ content: [], details }))
    : undefined;

  return mapWithConcurrencyLimit(tasks, 4, (t, index) =>
    runSingleTask(t, resolvedAgents[index], index, tracker, { cwd, signal, modelRegistry, callerSessionFile }),
  );
}

function renderSubagentResult(
  result: AgentToolResult<SubagentToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _context: { lastComponent?: Component },
): Text {
  // During progress, render the live tool-progress feed once an update with
  // `details.progress` has arrived (see src/progress.ts); before the first
  // update there is nothing to show yet, so fall back to empty text.
  if (options.isPartial) {
    const progress = result.details && "progress" in result.details ? result.details.progress : undefined;
    return new Text(progress ? buildProgressLines(progress, theme) : "", 0, 0);
  }

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
        onUpdate,
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