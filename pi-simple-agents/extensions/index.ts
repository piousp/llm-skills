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
import type { AgentConfig } from "../src/agents.ts";
import { applyInvocationOverride } from "../src/agents.ts";
import { createAgentRegistry } from "../src/agent-registry.ts";
import { runAgentViaSdk, mapWithConcurrencyLimit, type AgentRunResult } from "../src/run.ts";
import { createProgressTracker, buildProgressLines, type TaskProgress, type ProgressTracker } from "../src/progress.ts";
import { formatRunResults } from "../src/format-results.ts";
import { validateSubagentParams, resolveAgents, normalizeTasks, invocationOverrideOf } from "../src/validate.ts";
import type { TaskEntry } from "../src/validate.ts";
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

const registry = createAgentRegistry({
  agentsDir: AGENTS_DIR,
  userSettingsPath: path.join(os.homedir(), ".pi", "agent", "settings.json"),
});

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

export const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  model: Type.Optional(Type.String({
    description: 'Optional model override in "provider/modelId" form (e.g. "anthropic/claude-opus-4-8"). Takes precedence over the agent\'s configured model.',
  })),
  tools: Type.Optional(Type.Array(Type.String(), {
    description: 'Optional tool whitelist for this invocation only. Replaces the agent\'s configured tools entirely (no merge). Native pi tool names only — Claude Code tool-name aliases are not mapped here.',
  })),
  skills: Type.Optional(Type.Array(Type.String(), {
    description: 'Optional skill whitelist for this invocation only. Replaces the agent\'s configured skills entirely (no merge).',
  })),
  tasks: Type.Optional(
    Type.Array(
      Type.Object({
        agent: Type.String(),
        task: Type.String(),
        model: Type.Optional(Type.String({
          description: 'Optional model override in "provider/modelId" form (e.g. "anthropic/claude-opus-4-8"). Takes precedence over the agent\'s configured model.',
        })),
        tools: Type.Optional(Type.Array(Type.String(), {
          description: 'Optional tool whitelist for this invocation only. Replaces the agent\'s configured tools entirely (no merge). Native pi tool names only — Claude Code tool-name aliases are not mapped here.',
        })),
        skills: Type.Optional(Type.Array(Type.String(), {
          description: 'Optional skill whitelist for this invocation only. Replaces the agent\'s configured skills entirely (no merge).',
        })),
      }),
    ),
  ),
});
type SubagentArgs = Static<typeof SubagentParams>;

// Builds a name→config lookup for the render-time parameter line.
function toParamAgentsMap(agents: readonly AgentConfig[]): Map<string, AgentConfig> {
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
    ? toParamAgentsMap(registry.peek(context.cwd)?.agents ?? [])
    : new Map<string, AgentConfig>();
  return new Text(buildSubagentCallText(args, theme, paramAgents), 0, 0);
}

function createMinimalResourceLoader(agent: AgentConfig, cwd: string): DefaultResourceLoader {
  const result = buildLoaderOptions(agent, cwd, os.homedir());
  emitWarnings(result.warnings);
  return new DefaultResourceLoader(result.options);
}

interface RunTasksOptions {
  cwd: string;
  signal: AbortSignal | undefined;
  modelRegistry: ModelRegistry;
  callerSessionFile: string | undefined;
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined;
  concurrency: number;
}

// Runs one task end-to-end: resource loader creation/reload, session manager
// creation, the SDK run, and progress tracking teardown. Extracted from
// `runTasks` so the concurrency orchestration there stays a thin wrapper.
export async function runSingleTask(
  t: TaskEntry,
  agent: AgentConfig,
  index: number,
  tracker: ProgressTracker | undefined,
  options: Omit<RunTasksOptions, "onUpdate" | "concurrency">,
): Promise<AgentRunResult> {
  const { cwd, signal, modelRegistry, callerSessionFile } = options;
  const effectiveAgent = applyInvocationOverride(agent, invocationOverrideOf(t));

  try {
    const resourceLoader = createMinimalResourceLoader(effectiveAgent, cwd);
    await resourceLoader.reload();

    const { manager, warnings } = createSubagentSessionManager(
      effectiveAgent,
      callerSessionFile,
      cwd,
      SUBAGENT_SESSIONS_DIR,
      SESSION_MANAGER_FACTORY,
    );
    emitWarnings(warnings);

    return await runAgentViaSdk(
      effectiveAgent,
      t.task,
      {
        modelRegistry,
        signal,
        createSession: createAgentSession,
        resourceLoader,
        sessionManager: manager,
        getModel: (provider, modelId) => modelRegistry.find(provider, modelId),
        onToolEvent: tracker ? (event) => tracker.onToolEvent(index, event) : undefined,
      },
    );
  } finally {
    tracker?.markTaskDone(index);
  }
}

// Runs every task with the configured concurrency limit via the SDK runner.
// Returns settled results in the same order as `tasks`.
// When `onUpdate` is provided, tracks per-task tool-use progress (see
// src/progress.ts) and re-emits the full progress array on every tool-start/
// tool-end event and when each task settles, so the TUI can render a live
// feed. When `onUpdate` is absent, no progress tracking happens at all.
async function runTasks(
  tasks: TaskEntry[],
  resolvedAgents: AgentConfig[],
  options: RunTasksOptions,
): Promise<AgentRunResult[]> {
  const { cwd, signal, modelRegistry, callerSessionFile, onUpdate, concurrency } = options;

  const tracker = onUpdate
    ? createProgressTracker(tasks.map((t) => t.agent), (details) => onUpdate({ content: [], details }))
    : undefined;

  return mapWithConcurrencyLimit(tasks, concurrency, (t, index) =>
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

export default async function (pi: ExtensionAPI): Promise<void> {
  const { agents } = await registry.load(process.cwd());
  const description = buildSubagentToolDescription(agents);
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

      const { agents: availableAgents, concurrency } = await registry.load(ctx.cwd);
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
        concurrency,
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