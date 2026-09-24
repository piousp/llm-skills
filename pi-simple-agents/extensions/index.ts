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
import { createAgentSession, DefaultResourceLoader, SessionManager, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../src/agents.ts";
import { applyInvocationOverride } from "../src/agents.ts";
import { createAgentRegistry } from "../src/agent-registry.ts";
import { runAgentViaSdk, mapWithConcurrencyLimit, MAX_TIMEOUT_MS, type AgentRunResult, type RunAgentViaSdkOptions } from "../src/run.ts";
import { SUBAGENT_TOOL_NAME } from "../src/extension-binding.ts";
import { createProgressTracker, type TaskProgress, type ProgressTracker } from "../src/progress.ts";
import { buildSubagentResultText } from "../src/render-result.ts";
import { formatRunResults } from "../src/format-results.ts";
import { validateSubagentParams, resolveAgents, normalizeTasks, invocationOverrideOf } from "../src/validate.ts";
import type { TaskEntry, ValidationResult } from "../src/validate.ts";
import { buildSubagentCallText } from "../src/render-call.ts";
import { buildLoaderOptions } from "../src/loader-config.ts";
import { childSessionDir, createSubagentSessionManager } from "../src/subagent-session.ts";
import { aggregateRunUsage } from "../src/usage.ts";
import { buildSubagentToolDescription } from "../src/tool-description.ts";
import { emitWarnings, toErrorMessage } from "../src/warn.ts";

const AGENTS_DIR = path.join(os.homedir(), ".pi/agent/agents");
const SESSION_MANAGER_FACTORY = {
  forkFrom: (s: string, t: string, d: string) => SessionManager.forkFrom(s, t, d),
  atPath: (f: string, c: string) => SessionManager.open(f, path.dirname(f), c),
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
/** Per-child projection of a run's persisted session + usage, aligned by index to `runs`. */
export interface ChildResult {
  sessionFile?: string;
  usage?: AgentRunResult["usage"];
}

export type SubagentToolDetails =
  | { progress: readonly TaskProgress[] }
  | { runId: string; runs: AgentRunResult[]; results: ChildResult[] }
  | { error: string };

// Pure tail of execute(): assembles the tool result from the settled runs.
// Extracted so the runId/results/usage contract is unit-testable without a
// real model session. `usage` is promoted to the canonical AgentToolResult
// field (not just details) so Pi's own usage accounting and any /usage
// tooling that reads it directly can see the subagent's real cost.
export function buildSubagentToolResult(results: AgentRunResult[], runId: string) {
  const formatted = formatRunResults(results);
  const childResults: ChildResult[] = results.map((r) => ({ sessionFile: r.sessionFile, usage: r.usage }));
  return {
    content: [{ type: "text" as const, text: formatted.text }],
    details: { runId, runs: results, results: childResults },
    usage: aggregateRunUsage(results),
    isError: formatted.isError,
  };
}

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
  thinking: Type.Optional(Type.String({
    description: 'Optional per-invocation thinking-level override (e.g. "off", "minimal", "low", "medium", "high", "xhigh", "max"). Takes precedence over the agent\'s configured thinking level. An unrecognized level is warned and ignored at run time, falling back to the agent\'s configured level. Omit to inherit.',
  })),
  maxTurns: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 100,
    description: 'Optional per-invocation maxTurns override (1-100). Limits the number of model turns (one turn = one model response + its tool batch) before the run settles as an error. Takes precedence over the agent\'s configured maxTurns. Omit to inherit.',
  })),
  timeoutMs: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: MAX_TIMEOUT_MS,
    description: `Optional per-invocation timeout override, in milliseconds (max ${MAX_TIMEOUT_MS}, i.e. 2 hours — values above this are clamped with a warning). Limits how long the run's prompt execution may take before it settles as an error. Takes precedence over the agent's configured timeoutMs. Omit to inherit.`,
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
        thinking: Type.Optional(Type.String({
          description: 'Optional per-invocation thinking-level override (e.g. "off", "minimal", "low", "medium", "high", "xhigh", "max"). Takes precedence over the agent\'s configured thinking level. An unrecognized level is warned and ignored at run time, falling back to the agent\'s configured level. Omit to inherit.',
        })),
        maxTurns: Type.Optional(Type.Integer({
          minimum: 1,
          maximum: 100,
          description: 'Optional per-invocation maxTurns override (1-100). Limits the number of model turns (one turn = one model response + its tool batch) before the run settles as an error. Takes precedence over the agent\'s configured maxTurns. Omit to inherit.',
        })),
        timeoutMs: Type.Optional(Type.Integer({
          minimum: 1,
          maximum: MAX_TIMEOUT_MS,
          description: `Optional per-invocation timeout override, in milliseconds (max ${MAX_TIMEOUT_MS}, i.e. 2 hours — values above this are clamped with a warning). Limits how long the run's prompt execution may take before it settles as an error. Takes precedence over the agent's configured timeoutMs. Omit to inherit.`,
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
  modelRuntime: ModelRuntime;
  callerSessionFile: string | undefined;
  /** The subagent tool call's own toolCallId — the basis for each run's childSessionDir. */
  runId: string;
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined;
  concurrency: number;
  mode: RunAgentViaSdkOptions["mode"];
  /** Test seam: defaults to the real createAgentSession. */
  createSession?: RunAgentViaSdkOptions["createSession"];
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
  const { cwd, signal, modelRuntime, callerSessionFile, runId, mode, createSession = createAgentSession } = options;
  const effectiveAgent = applyInvocationOverride(agent, invocationOverrideOf(t));
  let usage: AgentRunResult["usage"];

  try {
    const resourceLoader = createMinimalResourceLoader(effectiveAgent, cwd);
    await resourceLoader.reload();

    const { manager, warnings } = createSubagentSessionManager(
      effectiveAgent,
      callerSessionFile,
      cwd,
      childSessionDir(callerSessionFile, runId, index),
      SESSION_MANAGER_FACTORY,
    );
    emitWarnings(warnings);

    const result = await runAgentViaSdk(
      effectiveAgent,
      t.task,
      {
        modelRuntime,
        signal,
        createSession,
        resourceLoader,
        sessionManager: manager,
        getModel: (provider, modelId) => modelRuntime.getModel(provider, modelId),
        onToolEvent: tracker ? (event) => tracker.onToolEvent(index, event) : undefined,
        mode,
      },
    );
    usage = result.usage;
    return result;
  } finally {
    // usage is only set once runAgentViaSdk actually resolves; a throw before
    // that (e.g. resourceLoader.reload() rejecting) leaves it undefined, which
    // markTaskDone treats identically to the argument being omitted.
    tracker?.markTaskDone(index, usage);
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
  const { cwd, signal, modelRuntime, callerSessionFile, runId, onUpdate, concurrency, mode } = options;

  const tracker = onUpdate
    ? createProgressTracker(tasks.map((t) => t.agent), (details) => onUpdate({ content: [], details }))
    : undefined;

  return mapWithConcurrencyLimit(tasks, concurrency, (t, index) =>
    runSingleTask(t, resolvedAgents[index], index, tracker, { cwd, signal, modelRuntime, callerSessionFile, runId, mode }),
  );
}

function renderSubagentResult(
  result: AgentToolResult<SubagentToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _context: { lastComponent?: Component },
): Text {
  const progress = result.details && "progress" in result.details ? result.details.progress : undefined;
  const runs = result.details && "runs" in result.details ? result.details.runs : undefined;
  const content = result.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("\n");

  return new Text(
    buildSubagentResultText({ isPartial: options.isPartial, expanded: options.expanded, progress, content, runs }, theme),
    0,
    0,
  );
}

export default async function (
  pi: ExtensionAPI,
  createModelRuntime: () => Promise<ModelRuntime> = () => ModelRuntime.create(),
): Promise<void> {
  let modelRuntimeResult: ValidationResult<ModelRuntime>;
  try {
    modelRuntimeResult = { ok: true, value: await createModelRuntime() };
  } catch (error) {
    modelRuntimeResult = { ok: false, error: toErrorMessage(error) };
  }

  const { agents } = await registry.load(process.cwd());
  const description = buildSubagentToolDescription(agents);
  pi.registerTool({
    name: SUBAGENT_TOOL_NAME,
    label: "Subagent",
    description,
    parameters: SubagentParams,
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
    execute: async (toolCallId, rawParams, signal, onUpdate, ctx) => {
      if (!modelRuntimeResult.ok) {
        return errorResult(`failed to initialize model runtime: ${modelRuntimeResult.error}`);
      }

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
        modelRuntime: modelRuntimeResult.value,
        runId: toolCallId,
        callerSessionFile: ctx.sessionManager.getSessionFile(),
        onUpdate,
        concurrency,
        // Threads the host's real run mode into every subagent's nested
        // bindExtensions() call (see runSingleTask, src/run.ts). Omitting
        // this field is caught by tsc (RunTasksOptions.mode is required),
        // but a *wrong* constant here (e.g. a stray "print") is not caught
        // by any test — the unit test at
        // "runSingleTask: forwards options.mode through..." only verifies
        // runSingleTask's own forwarding, not this specific call site.
        mode: ctx.mode,
      });

      return buildSubagentToolResult(results, toolCallId);
    },
  });
}