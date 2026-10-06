import os from "node:os";
import path from "node:path";
import { Type, type Static } from "typebox";
import type {
  ExtensionAPI,
  Theme,
  ToolRenderResultOptions,
  AgentToolResult,
  MessageRenderer,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Text, MouseRegion, Box, type Component } from "@earendil-works/pi-tui";
import { createAgentSession, DefaultResourceLoader, SessionManager, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../src/agents.ts";
import { applyInvocationOverride } from "../src/agents.ts";
import { createAgentRegistry } from "../src/agent-registry.ts";
import { runAgentViaSdk, MAX_TIMEOUT_MS, type AgentRunResult, type RunAgentViaSdkOptions } from "../src/run.ts";
import { SUBAGENT_TOOL_NAME } from "../src/extension-binding.ts";
import type { ProgressTracker } from "../src/progress.ts";
import { buildSubagentResultText } from "../src/render-result.ts";
import { validateSubagentParams, resolveAgent, invocationOverrideOf } from "../src/validate.ts";
import type { SubagentParams as ValidatedSubagentParams, ValidationResult } from "../src/validate.ts";
import { buildSubagentCallText } from "../src/render-call.ts";
import { buildLoaderOptions } from "../src/loader-config.ts";
import { childSessionDir, createSubagentSessionManager } from "../src/subagent-session.ts";
import { buildSubagentToolResult, buildSubagentAckResult, buildJobCompletionMessage, SUBAGENT_RESULT_MESSAGE_TYPE, type SubagentJobMessageDetails } from "../src/job-messages.ts";
import { createJobRegistry, createSettleBarrier, type JobTask, type SettledJob } from "../src/background-jobs.ts";
import { createJobWidget } from "../src/job-widget.ts";
import { buildJobListText, parseSubagentsCommand, describeCancelResult, describeClearResult } from "../src/job-view.ts";
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
// can take. A type alias (not an interface) is used deliberately: object type
// aliases carry an implicit index signature, so each member stays assignable
// to `Record<string, unknown>` wherever the host's tool types expect that
// shape.
//
// execute() launches a background job and returns the `{jobId,...}` ack
// immediately, without waiting for the run. The settled run's own
// `{runId,run}` shape only exists on the completion message (see
// SubagentJobMessageDetails in src/job-messages.ts), delivered later via
// pi.sendMessage(), not on this tool's own result.
export type SubagentToolDetails =
  | { jobId: string; runId: string; task: JobTask }
  | { error: string };

// This package's published entry point (see "pi": { "extensions" } in
// package.json), so dropping the export entirely is a public API change
// (needs a deliberate deprecation decision, see docs/FOLLOWUPS.md) — kept
// even though nothing in this repo calls it anymore. Its signature changed
// in 1.0.0 (now takes one AgentRunResult, not an array; see CHANGELOG.md),
// a deliberate breaking change, not a compatibility guarantee. Lives in
// src/job-messages.ts, which also uses its own assembly logic internally
// for the background-job completion message, without importing from here.
export { buildSubagentToolResult };

// The 6 per-invocation override fields reported to the model.
const overrideProperties = {
  model: Type.Optional(Type.String({
    description: 'Optional model override in "provider/modelId" form (e.g. "anthropic/claude-opus-4-8"). Takes precedence over the agent\'s configured model.',
  })),
  tools: Type.Optional(Type.Array(Type.String(), {
    description: 'Optional tool whitelist for this invocation only. Replaces the agent\'s configured tools entirely (no merge). pi tool names, including MCP tools as mcp__<server>__<tool>; `*` matches any characters (e.g. mcp__mde-build__*). Claude Code tool-name aliases are not mapped here.',
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
};

export const SubagentParams = Type.Object({
  agent: Type.String(),
  task: Type.String(),
  ...overrideProperties,
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
  expanded?: boolean;
}

// Renders the tool_box title. Collapsed: agent name + truncated first line of
// the task. Expanded (Ctrl+O / click, which also expands the result): the full
// task under each agent.
function renderSubagentCall(
  args: SubagentArgs,
  theme: Theme,
  context: RenderCallContext | undefined,
) {
  const paramAgents = context?.argsComplete
    ? toParamAgentsMap(registry.peek(context.cwd)?.agents ?? [])
    : new Map<string, AgentConfig>();
  return new Text(buildSubagentCallText(args, theme, paramAgents, context?.expanded === true), 0, 0);
}

function createMinimalResourceLoader(agent: AgentConfig, cwd: string): DefaultResourceLoader {
  const result = buildLoaderOptions(agent, cwd, os.homedir());
  emitWarnings(result.warnings);
  return new DefaultResourceLoader(result.options);
}

// childSessionDir's run index. Always 0 now that a job runs exactly one
// task; kept as a named constant (not inlined) to preserve the "run-0"
// session path convention downstream usage tooling already reconciles
// against.
const RUN_INDEX = 0;

interface RunTaskOptions {
  cwd: string;
  signal: AbortSignal | undefined;
  modelRuntime: ModelRuntime;
  callerSessionFile: string | undefined;
  /** The subagent tool call's own toolCallId — the basis for this run's childSessionDir. */
  runId: string;
  mode: RunAgentViaSdkOptions["mode"];
  /** Test seam: defaults to the real createAgentSession. */
  createSession?: RunAgentViaSdkOptions["createSession"];
}

// Runs one task end-to-end: resource loader creation/reload, session manager
// creation, the SDK run, and progress tracking teardown. The tracker (owned
// by the background job that invoked this) receives tool-use progress (see
// src/progress.ts); the job registry's `onChange` turns that into the live
// widget/`/subagents` feed — there is no more direct line to this tool
// call's own `onUpdate`, since execute() has already returned by the time
// any of this runs.
export async function runSingleTask(
  t: ValidatedSubagentParams,
  agent: AgentConfig,
  tracker: ProgressTracker | undefined,
  options: RunTaskOptions,
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
      childSessionDir(callerSessionFile, runId, RUN_INDEX),
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
        onToolEvent: tracker ? (event) => tracker.onToolEvent(event) : undefined,
        mode,
      },
    );
    usage = result.usage;
    return result;
  } finally {
    // usage is only set once runAgentViaSdk actually resolves; a throw before
    // that (e.g. resourceLoader.reload() rejecting) leaves it undefined, which
    // markTaskDone treats identically to the argument being omitted.
    tracker?.markTaskDone(usage);
  }
}

// Renders the tool call's own immediate result: the launch ack, or the
// pre-launch `{error}` result for validation/runtime-init failures. The
// settled run's own output arrives later as a separate `subagent-result`
// message, rendered by renderSubagentResultMessage below, not here.
function renderSubagentResult(
  result: AgentToolResult<SubagentToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _context: { lastComponent?: Component },
): Text {
  const content = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

  if (result.details && "jobId" in result.details) {
    if (!options.expanded) {
      return new Text(theme.fg("dim", `\u23fa backgrounded job ${result.details.jobId} \u00b7 /subagents to manage`), 0, 0);
    }
    return new Text(content, 0, 0);
  }

  // `{error}` (or no details at all): generic passthrough — collapsed hides,
  // expanded shows the content.
  return new Text(
    buildSubagentResultText({ expanded: options.expanded, content, run: undefined }, theme),
    0,
    0,
  );
}

// Renders the completion message a background job injects via
// pi.sendMessage() when it settles. Distinct from renderSubagentResult
// above: that one renders the launch tool call, this one renders the
// separate transcript entry the result arrives in later.
//
// Styled to match a native tool result — same `Box` + toolSuccessBg/
// toolErrorBg background the host's own ToolExecutionComponent uses
// (tool-execution.ts: updateDisplay()), same `toolTitle` token for the
// header — and wrapped in its own MouseRegion so it is individually
// clickable to toggle expand, the same mechanism createResultRegion() uses
// there. CustomMessageComponent (the generic wrapper every
// registerMessageRenderer output gets) provides neither on its own: no box
// styling (it only boxes its *default*, non-custom rendering), and no click
// handling (only the global Ctrl+O toggle reaches a custom renderer). This
// closure-local `expanded` is what gives this block its own independent
// click state on top of that global toggle. The parent rebuilds this
// component from scratch on the next global toggle/resize/theme change, at
// which point it re-reads `options.expanded` — a click only persists until
// the next such rebuild.
const renderSubagentResultMessage: MessageRenderer<SubagentJobMessageDetails> = (message, options, theme) => {
  const details = message.details;
  // Optional chain kept deliberately: dev sessions persisted from earlier
  // 1.0.0 builds may carry the old array-shaped `tasks` field instead of
  // `task`, and should still render (as "result", with no footer) rather
  // than throw.
  const who = details?.task?.agent ?? "result";
  const status = details?.status ? ` \u00b7 job ${details.jobId} \u00b7 ${details.status}` : "";
  const title = `${theme.fg("toolTitle", theme.bold(`subagent ${who}`))}${theme.fg("dim", status)}`;
  const content = typeof message.content === "string" ? message.content : "";
  const bgToken = details?.isError ? "toolErrorBg" : "toolSuccessBg";

  let expanded = options.expanded;
  const box = new Box(1, 1, (t) => theme.bg(bgToken, t));

  function refreshBox(): void {
    box.clear();
    const body = buildSubagentResultText({ expanded, content, run: details?.run }, theme);
    box.addChild(new Text(body ? `${title}\n${body}` : title, 0, 0));
  }

  return new MouseRegion(
    {
      render: (width: number) => {
        refreshBox();
        return box.render(width);
      },
      invalidate: () => box.invalidate(),
    },
    (event) => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      expanded = !expanded;
      return { handled: true };
    },
  );
};

// The job registry's onSettled hook, pulled out to its own function so the
// wiring (build the completion message, hand it to pi.sendMessage with the
// right delivery options) is unit-testable with a fake `pi` and a synthetic
// SettledJob, without needing a real job to actually run and settle.
export function deliverJobResult(pi: Pick<ExtensionAPI, "sendMessage">, job: SettledJob): void {
  const { message, options } = buildJobCompletionMessage(job);
  pi.sendMessage(message, options);
}

export default async function (
  pi: ExtensionAPI,
  createModelRuntime: () => Promise<ModelRuntime> = () => ModelRuntime.create(),
  // Test seam only: lets a test substitute a fake AgentSession for every job
  // this instance of the extension launches, so execute()'s own happy path
  // (launch -> job settles -> deliverJobResult -> pi.sendMessage) is
  // exercisable without a real model/network call. Always undefined in
  // production, where runSingleTask's own default (the real
  // createAgentSession) applies.
  createSessionOverride?: RunAgentViaSdkOptions["createSession"],
): Promise<void> {
  let modelRuntimeResult: ValidationResult<ModelRuntime>;
  try {
    modelRuntimeResult = { ok: true, value: await createModelRuntime() };
  } catch (error) {
    modelRuntimeResult = { ok: false, error: toErrorMessage(error) };
  }

  // Captured from whichever handler last ran (execute(), the /subagents
  // command, or any pi.on() handler below) — there is no "current context"
  // otherwise available to the registry's onChange/onSettled callbacks,
  // which can fire well after any single handler call has returned.
  let uiRef: { ui: ExtensionUIContext; hasUI: boolean } | undefined;
  function captureUi(ctx: { ui: ExtensionUIContext; hasUI: boolean }): void {
    uiRef = { ui: ctx.ui, hasUI: ctx.hasUI };
  }

  const widget = createJobWidget({
    getUi: () => (uiRef?.hasUI ? uiRef.ui : undefined),
    now: Date.now,
    schedule: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    },
    cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
  });

  const jobs = createJobRegistry({
    now: Date.now,
    onSettled: (job) => deliverJobResult(pi, job),
    onChange: (list) => widget.refresh(list),
  });

  const { agents } = await registry.load(process.cwd());
  const description = buildSubagentToolDescription(agents);
  pi.registerTool({
    name: SUBAGENT_TOOL_NAME,
    label: "Subagent",
    description,
    parameters: SubagentParams,
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
    execute: async (toolCallId, rawParams, _signal, _onUpdate, ctx) => {
      captureUi(ctx);
      if (!modelRuntimeResult.ok) {
        return errorResult(`failed to initialize model runtime: ${modelRuntimeResult.error}`);
      }

      const parsedParams = validateSubagentParams(rawParams);
      if (!parsedParams.ok) {
        return errorResult(parsedParams.error);
      }
      const params = parsedParams.value;

      const { agents: availableAgents } = await registry.load(ctx.cwd);
      const resolved = resolveAgent(params.agent, availableAgents);
      if (!resolved.ok) {
        return errorResult(resolved.error);
      }

      const callerSessionFile = ctx.sessionManager.getSessionFile();
      const jobTask: JobTask = { agent: resolved.value.name, task: params.task };

      const job = jobs.start({
        runId: toolCallId,
        task: jobTask,
        // Deliberately NOT the tool call's own `signal`: coupling them would
        // abort the job the instant this launching turn ends. Only
        // /subagents cancel and shutdown should abort a background job.
        run: ({ signal: jobSignal, tracker }) =>
          runSingleTask(params, resolved.value, tracker, {
            cwd: ctx.cwd,
            signal: jobSignal,
            modelRuntime: modelRuntimeResult.value,
            runId: toolCallId,
            callerSessionFile,
            // Threads the host's real run mode into this subagent's nested
            // bindExtensions() call (see runSingleTask, src/run.ts).
            mode: ctx.mode,
            createSession: createSessionOverride,
          }),
      });

      return buildSubagentAckResult(job);
    },
  });

  pi.registerMessageRenderer(SUBAGENT_RESULT_MESSAGE_TYPE, renderSubagentResultMessage);

  pi.registerCommand("subagents", {
    description: "List background subagent jobs; /subagents cancel <id> or /subagents clear",
    handler: async (args, ctx) => {
      captureUi(ctx);
      const command = parseSubagentsCommand(args);
      if (command.kind === "list") {
        ctx.ui.notify(buildJobListText(jobs.list(), Date.now(), ctx.ui.theme), "info");
        return;
      }
      if (command.kind === "cancel") {
        const { text, level } = describeCancelResult(jobs.cancel(command.id));
        ctx.ui.notify(text, level);
        return;
      }
      if (command.kind === "clear") {
        ctx.ui.notify(describeClearResult(jobs.clearFinished()), "info");
        return;
      }
      ctx.ui.notify(command.message, "warning");
    },
  });

  const settleBarrier = createSettleBarrier(jobs);
  pi.on("agent_before_settle", (event, ctx) => {
    captureUi(ctx);
    return settleBarrier(event, { hasUI: ctx.hasUI, signal: ctx.signal });
  });
  pi.on("agent_settled", (_event, ctx) => {
    captureUi(ctx);
    // cancelAll() is already a no-op when nothing is running.
    if (!ctx.hasUI) jobs.cancelAll();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    captureUi(ctx);
    jobs.shutdown();
    widget.dispose();
  });
}