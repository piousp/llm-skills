import os from "node:os";
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgentRegistry, type AgentRegistryPaths } from "../src/agent-registry.ts";
import { MAX_TIMEOUT_MS, type RunAgentViaSdkOptions } from "../src/run.ts";
import { SUBAGENT_TOOL_NAME } from "../src/extension-binding.ts";
import { createRenderSubagentCall, renderSubagentResult, renderSubagentResultMessage, type GetAgents } from "../src/render-extensions.ts";
import { runSingleTask } from "../src/task-runner.ts";
import { validateSubagentParams, resolveAgent } from "../src/validate.ts";
import type { ValidationResult } from "../src/validate.ts";
import { buildSubagentToolResult, buildSubagentAckResult, buildJobCompletionMessage, SUBAGENT_RESULT_MESSAGE_TYPE, type SubagentJobMessageDetails } from "../src/job-messages.ts";
import { createJobRegistry, createSettleBarrier, isActive, type JobSnapshot, type JobTask, type SettledJob } from "../src/background-jobs.ts";
import { createJobWidget } from "../src/job-widget.ts";
import { buildJobListText, buildJobStatusText, buildSubagentSessionText, parseSubagentsCommand, describeCancelResult, describeInjectResult, describeClearResult, jobNotFoundText, NO_JOBS_TEXT, resolveAutoTarget, resolveActiveTarget, ambiguousJobsText } from "../src/job-view.ts";
import { buildSubagentSessionReport, type ReconcileFs } from "../src/session-reconcile.ts";
import { createPeekManager } from "../src/peek-window.ts";
import { buildSubagentToolDescription } from "../src/tool-description.ts";
import { toErrorMessage } from "../src/warn.ts";

// Production defaults for the agent registry; both derived from the real
// home. Tests pass per-instance fixture paths via the factory's pathsOverride
// seam (see the default export below) and never read these.
const AGENTS_DIR = path.join(os.homedir(), ".pi/agent/agents");
const USER_SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");

function errorResult(error: string) {
  return {
    content: [{ type: "text" as const, text: error }],
    details: { error },
    isError: true,
  };
}

// The ReconcileFs seam for /subagents session: thin synchronous node reads
// where every failure (missing session.jsonl, unreadable dir) degrades to
// undefined, which the reconciliation treats as "not there" — a run whose
// child file vanished falls back to its completion message's usage, a
// missing directory just ends the walk.
function nodeReconcileFs(): ReconcileFs {
  return {
    readTextFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    },
    listDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return undefined;
      }
    },
  };
}

export type { SubagentToolDetails } from "../src/render-extensions.ts";

// This package's published entry point (see "pi": { "extensions" } in
// package.json), so dropping the export entirely is a public API change
// (needs a deliberate deprecation decision) — kept
// even though nothing in this repo calls it anymore. Its signature changed
// in 1.0.0 (now takes one AgentRunResult, not an array; see CHANGELOG.md),
// a deliberate breaking change, not a compatibility guarantee. Lives in
// src/job-messages.ts, which also uses its own assembly logic internally
// for the background-job completion message, without importing from here.
export { buildSubagentToolResult };

// Runs one task end-to-end (resource loader, session manager, SDK run,
// progress teardown); lives in src/task-runner.ts and is re-exported here to
// keep the entry point's public API unchanged (also imported above for the
// job wiring's own use).
export { runSingleTask } from "../src/task-runner.ts";

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
  // Test seam only: lets a test point the agent registry at fixture paths
  // (agents dir + user settings) instead of the real ~/.pi/agent layout, so
  // the entry's wiring tests are hermetic — no real-home reads at setup,
  // execute, or nested-loader time. Always undefined in production, where
  // the real paths above apply. Mirrors createSessionOverride above.
  pathsOverride?: AgentRegistryPaths,
): Promise<void> {
  const agentsDir = pathsOverride?.agentsDir ?? AGENTS_DIR;
  const userSettingsPath = pathsOverride?.userSettingsPath ?? USER_SETTINGS_PATH;
  // agentsDir always has the <home>/.pi/agent/agents layout (package
  // convention — the default above and every test fixture mirror it), so
  // ~THREE dirname levels recover the home root (agents → agent → .pi → home).
  // Two levels yields <home>/.pi, and buildLoaderOptions would then assemble
  // the nested loader's agentDir as <home>/.pi/.pi/agent — a nonexistent path
  // whose empty settings silently strip every user package tool from child
  // sessions (1.2.0 regression, fixed here).
  const homeDir = path.dirname(path.dirname(path.dirname(agentsDir)));
  const registry = createAgentRegistry({ agentsDir, userSettingsPath });
  const getAgents: GetAgents = (cwd) => registry.peek(cwd)?.agents ?? [];

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

  // /subagents peek's live overlay: same schedule/cancel pair as the widget
  // (unref'd timers), so the pulse never holds the process open. Render
  // prefs track the session's thinking visibility and the TUI's tool
  // expansion state, read live on every rendered frame.
  const peekManager = createPeekManager({
    getUi: () => (uiRef?.hasUI ? uiRef.ui : undefined),
    now: Date.now,
    getRenderPrefs: () => ({
      // Runtime guard (=== true / ?? true): the host API types declare both
      // fields, but test fakes and older hosts may not supply them.
      hideThinking: pi.getSettings().hideThinkingBlock === true,
      toolsExpanded: uiRef?.ui?.getToolsExpanded?.() ?? true,
    }),
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
    renderCall: createRenderSubagentCall(getAgents),
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
        run: ({ signal: jobSignal, tracker, transcript, live }) =>
          runSingleTask(params, resolved.value, tracker, {
            cwd: ctx.cwd,
            signal: jobSignal,
            modelRuntime: modelRuntimeResult.value,
            runId: toolCallId,
            callerSessionFile,
            // Threads the host's real run mode into this subagent's nested
            // bindExtensions() call (see runSingleTask, src/run.ts).
            mode: ctx.mode,
            homeDir,
            // Feed the run's raw session events into the job's transcript
            // for /subagents peek (Wave 2 renders it; append-only).
            onSessionEvent: (e) => transcript.onSessionEvent(e),
            // The job's live-session handle: runAgentViaSdk reports the
            // session's liveness window (ready right before the prompt, gone
            // before teardown) into the registry's per-job sink, so
            // /subagents steer|followUp can inject into the running session.
            onSessionReady: (session) => live.set(session),
            onSessionGone: () => live.clear(),
            createSession: createSessionOverride,
          }),
      });

      return buildSubagentAckResult(job);
    },
  });

  pi.registerMessageRenderer(SUBAGENT_RESULT_MESSAGE_TYPE, renderSubagentResultMessage);

  pi.registerCommand("subagents", {
    description: "List background subagent jobs; /subagents peek|status|cancel <id>, /subagents steer|followUp <id> <message>, /subagents clear, or /subagents session",
    handler: async (args, ctx) => {
      captureUi(ctx);
      const command = parseSubagentsCommand(args);
      if (command.kind === "list") {
        ctx.ui.notify(buildJobListText(jobs.list(), Date.now(), ctx.ui.theme), "info");
        return;
      }
      if (command.kind === "status") {
        let job: JobSnapshot;
        if (command.id) {
          const found = jobs.get(command.id);
          if (!found) {
            ctx.ui.notify(jobNotFoundText(command.id), "warning");
            return;
          }
          job = found;
        } else {
          // Bare status auto-picks its target: the single active job, or the
          // newest settled one; several actives are ambiguous and ask for an id.
          const target = resolveAutoTarget(jobs.list());
          if (target.kind === "ambiguous") {
            ctx.ui.notify(ambiguousJobsText(target.ids), "info");
            return;
          }
          if (target.kind === "none") {
            ctx.ui.notify(NO_JOBS_TEXT, "info");
            return;
          }
          job = target.job;
        }
        ctx.ui.notify(buildJobStatusText(job, Date.now(), ctx.ui.theme), "info");
        return;
      }
      if (command.kind === "cancel") {
        let cancelId = command.id;
        if (!cancelId) {
          // Bare cancel only targets active jobs (a settled job is nothing to
          // cancel); several actives are ambiguous and ask for an id.
          const target = resolveActiveTarget(jobs.list());
          if (target.kind === "ambiguous") {
            ctx.ui.notify(ambiguousJobsText(target.ids), "info");
            return;
          }
          if (target.kind === "none") {
            ctx.ui.notify("No running jobs to cancel.", "warning");
            return;
          }
          cancelId = target.job.id;
        }
        const { text, level } = describeCancelResult(jobs.cancel(cancelId));
        ctx.ui.notify(text, level);
        return;
      }
      if (command.kind === "steer" || command.kind === "followUp") {
        let injectId = command.id;
        if (!injectId) {
          // Bare steer/followUp only targets active jobs, like bare cancel (a
          // settled job can no longer be messaged); several actives are
          // ambiguous and ask for an id.
          const target = resolveActiveTarget(jobs.list());
          if (target.kind === "ambiguous") {
            ctx.ui.notify(ambiguousJobsText(target.ids), "info");
            return;
          }
          if (target.kind === "none") {
            ctx.ui.notify(
              command.kind === "steer" ? "No running jobs to steer." : "No running jobs to follow up on.",
              "warning",
            );
            return;
          }
          injectId = target.job.id;
        }
        // Awaiting the inject keeps the guard chain's result (not-live, a
        // throwing live session) observable through the same notify as cancel.
        const result = command.kind === "steer"
          ? await jobs.steer(injectId, command.message)
          : await jobs.followUp(injectId, command.message);
        const { text, level } = describeInjectResult(command.kind, result);
        ctx.ui.notify(text, level);
        return;
      }
      if (command.kind === "peek") {
        // The overlay needs the real TUI: custom components only mount in
        // interactive mode, so anything else degrades to a warning.
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          ctx.ui.notify("peek requires an interactive TUI session", "warning");
          return;
        }
        // With an id, the same not-found wording as cancel/status. Bare peek
        // picks its target: the single active job, or the newest settled one;
        // several actives are ambiguous and ask for an id.
        let job: JobSnapshot;
        if (command.id) {
          const found = jobs.get(command.id);
          if (!found) {
            ctx.ui.notify(jobNotFoundText(command.id), "warning");
            return;
          }
          job = found;
        } else {
          const target = resolveAutoTarget(jobs.list());
          if (target.kind === "ambiguous") {
            ctx.ui.notify(ambiguousJobsText(target.ids), "info");
            return;
          }
          if (target.kind === "none") {
            ctx.ui.notify(NO_JOBS_TEXT, "info");
            return;
          }
          job = target.job;
        }
        peekManager.open(job, () => jobs.get(job.id), () => jobs.getTranscript(job.id));
        return;
      }
      if (command.kind === "clear") {
        ctx.ui.notify(describeClearResult(jobs.clearFinished()), "info");
        return;
      }
      if (command.kind === "session") {
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) {
          ctx.ui.notify("No session file on disk yet - /subagents session needs a persisted session.", "warning");
          return;
        }
        // Registry used ONLY to label in-flight orphans as "running", never
        // as a usage source (usage is always read from disk).
        const activeRunIds = new Set(jobs.list().filter((j) => isActive(j.state)).map((j) => j.runId));
        const report = buildSubagentSessionReport(sessionFile, nodeReconcileFs(), activeRunIds);
        ctx.ui.notify(buildSubagentSessionText(report, ctx.ui.theme), "info");
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
    peekManager.close();
  });
}