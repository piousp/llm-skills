import os from "node:os";
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgentRegistry, type AgentRegistryPaths } from "../src/agent-registry.ts";
import { MAX_TIMEOUT_MS, type RunAgentViaSdkOptions } from "../src/run.ts";
import { SUBAGENT_TOOL_NAME, SUBAGENT_JOB_TOOL_NAME } from "../src/extension-binding.ts";
import { createRenderSubagentCall, renderSubagentResult, renderSubagentResultMessage, type GetAgents } from "../src/render-extensions.ts";
import { runSingleTask } from "../src/task-runner.ts";
import { validateSubagentParams, resolveAgent, invocationOverrideOf } from "../src/validate.ts";
import type { SubagentParams as ValidatedSubagentParams, ValidationResult } from "../src/validate.ts";
import { buildSubagentToolResult, buildSubagentAckResult, buildJobCompletionMessage, SUBAGENT_RESULT_MESSAGE_TYPE, type SubagentJobMessageDetails } from "../src/job-messages.ts";
import { createJobRegistry, createSettleBarrier, isActive, type JobSnapshot, type SettledJob } from "../src/background-jobs.ts";
import { createJobWidget } from "../src/job-widget.ts";
import { buildJobListText, buildJobStatusText, buildSubagentSessionText, buildSubagentStatusText, buildHelpText, parseSubagentsCommand, describeCancelResult, describeInjectResult, describeClearResult, jobNotFoundText, NO_JOBS_TEXT, resolveAutoTarget, resolveActiveTarget, ambiguousJobsText, buildRelaunchCandidatesText, buildRelaunchResultText, resolveRelaunchTarget, relaunchNotFoundText, notContinuableText, consumedOrphanText, noTaskText, agentNameNotOnDiskText, budgetExhaustedText, isConsumedOrphan, outOfRangeRelaunchFields, NO_RETRYABLE_RUNS_TEXT, NO_CONTINUABLE_RUNS_TEXT, type SubagentStatusAccumulator, type RelaunchKind } from "../src/job-view.ts";
import { addUsageToTotals, buildSubagentSessionReport, buildRelaunchCandidates, type ReconcileFs, type SessionEntry, type SubagentRelaunchCandidate } from "../src/session-reconcile.ts";
import { runIdDirName } from "../src/subagent-session.ts";
import type { AgentConfig } from "../src/agents.ts";
import { createPeekManager } from "../src/peek-window.ts";
import { PLAIN_THEME, type ProgressTheme } from "../src/progress.ts";
import { buildSubagentToolDescription, SUBAGENT_JOB_DESCRIPTION } from "../src/tool-description.ts";
import { toErrorMessage } from "../src/warn.ts";

// Footer status-line key for the running subagent-spend total, set through
// ctx.ui.setStatus (namespaced like the jobs widget key, src/job-widget.ts).
const STATUS_KEY = "pi-simple-agents:subagents";

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

// pi's exported `SessionEntry` union is not directly assignable to the
// permissive `GenericSessionEntry` union (index signature) the reconciliation
// works over, and nothing here can strengthen a host-owned type into the
// structural shapes directly. Entries come from the host's live session
// manager (already validated by the host), so one documented cast is the
// correct adapter — not a loose `any`.
function toReconcileEntries(entries: readonly unknown[]): SessionEntry[] {
  const typed = entries.filter(
    (entry): entry is { type: string } =>
      entry !== null && typeof entry === "object" && typeof (entry as { type?: unknown }).type === "string",
  );
  return typed as SessionEntry[];
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

export const SubagentJobParams = Type.Object({
  action: Type.Union(
    ["status", "list", "cancel", "steer", "followUp", "retry", "continue"].map((a) => Type.Literal(a)),
    { description: 'Job action. Read-only (always allowed): "status", "list". Interventions (once per job without asking the user): "cancel", "steer", "followUp", "retry", "continue".' },
  ),
  id: Type.Optional(Type.String({
    description: 'Target job id from the subagent acknowledgment (e.g. "S1002"); retry/continue also accept a run id. Omit to auto-target: status/cancel/steer/followUp pick the single active job (several actives return the ids to pick from); retry/continue resolve from settled runs on disk.',
  })),
  message: Type.Optional(Type.String({
    description: 'The message to inject \u2014 required for "steer" and "followUp", ignored otherwise.',
  })),
});

// The seven job actions, in the order the description lists them: the one list
// the schema above, the validator below, and the dispatcher's union share.
const JOB_ACTIONS = ["status", "list", "cancel", "steer", "followUp", "retry", "continue"] as const;

type JobAction = (typeof JOB_ACTIONS)[number];

// Raw-params validator for subagent_job, shaped like validateSubagentParams
// (src/validate.ts): execute() receives whatever the model reported, so the
// action is narrowed against JOB_ACTIONS and the two message-carrying verbs
// require a non-empty message. Structural problems only \u2014 everything the job
// itself answers (not found, not running, budget spent) is a normal result.
function validateJobParams(raw: unknown): ValidationResult<{ action: JobAction; id?: string; message?: string }> {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: `Provide an object with an "action" of ${JOB_ACTIONS.join("|")}.` };
  }
  const fields = raw as Record<string, unknown>;
  const action = JOB_ACTIONS.find((candidate) => candidate === fields.action);
  if (!action) {
    return { ok: false, error: `Unknown action ${JSON.stringify(fields.action)} \u2014 expected one of ${JOB_ACTIONS.join("|")}.` };
  }
  const { id, message } = fields;
  if (id !== undefined && typeof id !== "string") {
    return { ok: false, error: '"id" must be a string.' };
  }
  if (message !== undefined && typeof message !== "string") {
    return { ok: false, error: '"message" must be a string.' };
  }
  if ((action === "steer" || action === "followUp") && !message) {
    return { ok: false, error: `Action "${action}" needs a non-empty "message" to inject.` };
  }
  return { ok: true, value: { action, id, message } };
}

// The job registry's onSettled hook, pulled out to its own function so the
// wiring (build the completion message, hand it to pi.sendMessage with the
// right delivery options) is unit-testable with a fake `pi` and a synthetic
// SettledJob, without needing a real job to actually run and settle.
export function deliverJobResult(pi: Pick<ExtensionAPI, "sendMessage">, job: SettledJob): void {
  const { message, options } = buildJobCompletionMessage(job);
  pi.sendMessage(message, options);
}

// The new runId a retry/continue relaunch gets: kind-namespaced per source
// run, one attempt counter per source run (the wiring tracks it, so two
// relaunches of the same candidate never collide), compacted to a ≤64-char
// directory segment through runIdDirName exactly like every other runId
// (src/subagent-session.ts).
export function relaunchRunId(kind: RelaunchKind, sourceRunId: string, attempt: number): string {
  return `${kind}-${sourceRunId}-${attempt}`;
}

// A relaunch's params minus the out-of-range recorded fields the wiring
// dropped (see outOfRangeRelaunchFields in src/job-view.ts): an absent key
// means the agent's own value applies, exactly like a first call that did
// not override the field.
function stripRelaunchFields(
  params: ValidatedSubagentParams,
  dropped: readonly ("maxTurns" | "timeoutMs")[],
): ValidatedSubagentParams {
  if (dropped.length === 0) return params;
  const stripped = { agent: params.agent, task: params.task, ...invocationOverrideOf(params) };
  for (const field of dropped) delete (stripped as Record<string, unknown>)[field];
  return stripped;
}

// Per-verb choice table for the shared relaunch guard chain (handleRelaunch
// below): everything retry and continue read differently from a candidate
// lives here, so the two commands cannot drift apart. Retry re-dispatches
// the original task verbatim with no seed; continue sends the fixed
// continuation prompt and branches from the candidate's persisted child.
interface RelaunchSpec {
  kind: RelaunchKind;
  noneText: string;
  verb: "retryable" | "continuable";
  taskOf(candidate: SubagentRelaunchCandidate): string | undefined;
  seedSessionFileOf(candidate: SubagentRelaunchCandidate): string | undefined;
}

const RETRY_SPEC: RelaunchSpec = {
  kind: "retry",
  noneText: NO_RETRYABLE_RUNS_TEXT,
  verb: "retryable",
  taskOf: (candidate) => candidate.task,
  seedSessionFileOf: () => undefined,
};

const CONTINUE_SPEC: RelaunchSpec = {
  kind: "continue",
  noneText: NO_CONTINUABLE_RUNS_TEXT,
  verb: "continuable",
  taskOf: () => CONTINUATION_PROMPT,
  seedSessionFileOf: (candidate) => candidate.sessionFile,
};

const RELAUNCH_SPECS: Record<RelaunchKind, RelaunchSpec> = { retry: RETRY_SPEC, continue: CONTINUE_SPEC };

// The one task /subagents continue sends: the agent re-verifies what the
// interrupted attempt may have left half-done before finishing the job —
// the seed carries the old conversation, so there is nothing else to tell it.
export const CONTINUATION_PROMPT =
  "Continue the interrupted task from the conversation history above. First " +
  "re-verify the state of any files or operations the previous attempt may " +
  "have left half-done, then proceed to complete the task.";

// What a job action hands back to its caller: the notification text plus the
// level /subagents notifies it with (the tool path returns the same text to the
// model instead). Views and successes are "info"; every guard is "warning".
type JobActionText = { text: string; level: "info" | "warning" };

// The slice of the command context the shared job actions read. Deliberately
// not the whole ExtensionUIContext: /subagents passes ctx.ui.theme (a host
// Theme, which satisfies ProgressTheme), the subagent_job tool path passes the
// plain theme, and every view here only ever needs ProgressTheme.
type JobActionContext = {
  cwd: string;
  mode: RunAgentViaSdkOptions["mode"];
  sessionManager: { getSessionFile(): string | undefined };
  theme: ProgressTheme;
};

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

  // Running total of the session's subagent spend for the footer status
  // line — scoped to the factory closure like `jobs`/`uiRef`, never
  // module-level. Every settle counts one run (errored ones settle at zero
  // tokens); the registry fires onSettled exactly once per settle, so
  // accumulation is idempotent by design. `/subagents clear` does NOT reset
  // it (this is effective session spend, the same scope /subagents session
  // reports); only session_shutdown clears the status line.
  const statusAcc: SubagentStatusAccumulator = { runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

  const jobs = createJobRegistry({
    now: Date.now,
    onSettled: (job) => {
      deliverJobResult(pi, job);
      // setStatus is a no-op outside the TUI (the host's non-interactive UI
      // context is a no-op), so no mode guard is needed — and before the
      // first settle the accumulator stays untouched, so the line only
      // appears once a run actually settled.
      statusAcc.runs += 1;
      const usage = "result" in job.state ? job.state.result.usage : undefined;
      addUsageToTotals(statusAcc, usage);
      uiRef?.ui?.setStatus(STATUS_KEY, buildSubagentStatusText(statusAcc));
    },
    onChange: (list) => widget.refresh(list),
  });

  // In-memory per-session bookkeeping for /subagents retry|continue:
  // - consumedOrphanSegments: dir segments of orphaned children already
  //   re-launched once in this session (each orphan is only continuable once
  //   per session; message-driven runs are never consumed — they stay
  //   retryable until jobs/entries say otherwise).
  // - relaunchAttempts: one attempt counter per source runId, feeding
  //   relaunchRunId so each relaunch gets a fresh, unique runId.
  // Nothing persists across a restart, exactly like the job registry.
  const consumedOrphanSegments = new Set<string>();
  const relaunchAttempts = new Map<string, number>();
  // One intervention per job, tool path only: a runId spent here refuses the
  // next tool-driven cancel/steer/followUp/retry/continue. The /subagents
  // command never passes a budget, so a user-typed action is never refused;
  // a relaunch mints a new runId, which is budget-fresh by construction.
  const toolInterventions = new Set<string>();

  // One closure for everything that starts a run of one task: the subagent
  // tool's execute() and the /subagents retry|continue commands launch
  // through the same path, so a relaunch carries exactly the same job
  // plumbing (tracker/transcript/live-session taps, delivery, the footer
  // accumulator) a tool-launched job does. What varies per call site: the
  // params (agent/task, plus the ack-recorded per-call overrides the
  // relaunch wiring re-validated), the raw runId, the caller session file
  // (whose child dir the new session nests under), the caller's UI mode,
  // and continue's seed file.
  function launchSubagentJob(input: {
    params: ValidatedSubagentParams;
    agent: AgentConfig;
    runId: string;
    cwd: string;
    mode: RunAgentViaSdkOptions["mode"];
    callerSessionFile: string | undefined;
    seedSessionFile?: string;
  }): JobSnapshot {
    // The tool path checks `modelRuntimeResult.ok` in execute() before
    // reaching here, and the retry/continue branches check it right below;
    // the throw is unreachable in both flows and exists so the compiler can
    // narrow `.value` at the single launch chokepoint.
    if (!modelRuntimeResult.ok) {
      throw new Error(`failed to initialize model runtime: ${modelRuntimeResult.error}`);
    }
    return jobs.start({
      runId: input.runId,
      task: { agent: input.agent.name, task: input.params.task },
      // Deliberately NOT the tool call's own `signal`: coupling them would
      // abort the job the instant this launching turn ends. Only
      // /subagents cancel and shutdown should abort a background job.
      run: ({ signal: jobSignal, tracker, transcript, live }) =>
        runSingleTask(input.params, input.agent, tracker, {
          cwd: input.cwd,
          signal: jobSignal,
          modelRuntime: modelRuntimeResult.value,
          runId: input.runId,
          callerSessionFile: input.callerSessionFile,
          // Threads the caller's real run mode into this subagent's nested
          // bindExtensions() call (see runSingleTask, src/run.ts).
          mode: input.mode,
          homeDir,
          // /subagents continue only: seed the new session from the
          // interrupted run's own child file (src/task-runner.ts repairs
          // the seed's dangling tool calls in the forked copy).
          seedSessionFile: input.seedSessionFile,
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
  }

  // The shared guard chain behind both relaunch verbs: runtime + persisted-
  // session guards, disk-first candidate resolution, the per-candidate
  // preconditions, agent resolution, re-validation, and the launch itself.
  // Every per-verb choice (none-text, ambiguity header verb, task text, seed
  // file) comes from the spec table above, so retry and continue cannot
  // drift apart; the command handler is a thin dispatch.
  async function handleRelaunch(
    spec: RelaunchSpec,
    command: { readonly kind: RelaunchKind; readonly id?: string },
    ctx: JobActionContext & { budget?: Set<string> },
  ): Promise<JobActionText> {
    if (!modelRuntimeResult.ok) {
      return { text: `failed to initialize model runtime: ${modelRuntimeResult.error}`, level: "warning" };
    }
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) {
      return { text: "No session file on disk yet — /subagents retry|continue needs a persisted session.", level: "warning" };
    }
    // Same resolution inputs as /subagents session: the disk-first walk
    // (orphans labeled "running" when a live registry job owns the
    // runId — those are live work, not relaunch candidates). A relaunch
    // goes through the SAME registry-load path the tool call itself
    // does, so the agent config resolves identically.
    const { agents: availableAgents } = await registry.load(ctx.cwd);
    const activeRunIds = new Set(jobs.list().filter((j) => isActive(j.state)).map((j) => j.runId));
    const candidates = buildRelaunchCandidates(sessionFile, nodeReconcileFs(), activeRunIds);
    // Consumed orphans vanish from the auto/bare pools (they are done
    // — each interrupted child can be branch-continued or re-dispatched
    // once per session); an explicit id still resolves against the
    // whole list, so the consumed case can be named precisely.
    const pool = command.id
      ? candidates
      : candidates.filter((c) => !isConsumedOrphan(c, consumedOrphanSegments));
    const target = resolveRelaunchTarget(spec.kind, command.id, pool);

    if (target.kind === "ambiguous") {
      return { text: buildRelaunchCandidatesText(target.candidates, ctx.theme, spec.verb), level: "info" };
    }
    if (target.kind === "not-found") {
      return { text: relaunchNotFoundText(target.token), level: "warning" };
    }
    if (target.kind === "none") {
      return { text: spec.noneText, level: "info" };
    }
    const candidate = target.candidate;

    // One intervention per job: only the tool path seeds a budget (the
    // command never does), so a user-issued relaunch is never stopped here.
    if (ctx.budget?.has(candidate.runId)) {
      return { text: budgetExhaustedText(spec.kind, candidate.jobId, candidate.runId), level: "warning" };
    }

    // An orphan already re-dispatched once in this session: interrupted
    // candidates are the only consumed entries (marked at the launch
    // below); message-driven settled runs are never consumed.
    if (isConsumedOrphan(candidate, consumedOrphanSegments)) {
      return { text: consumedOrphanText(candidate.runId), level: "warning" };
    }
    const seedSessionFile = spec.seedSessionFileOf(candidate);
    // continue needs a persisted child session to branch from; a run
    // that settled without one (no child dir on disk) is re-dispatched
    // by retry instead. Bare continue never resolves here (the pool is
    // pre-filtered to sessionFile-bearing candidates).
    if (spec.kind === "continue" && !seedSessionFile) {
      return { text: notContinuableText(candidate), level: "warning" };
    }
    // An interrupted run whose launch ack was also lost carries no
    // agent name anywhere on disk; nothing to resolve or run.
    if (spec.kind === "continue" && candidate.agent === "unknown") {
      return { text: agentNameNotOnDiskText(candidate), level: "warning" };
    }
    // Same resolution as the subagent tool's own call — the error text
    // is verbatim ("Unknown agent: X. Available agents: …"); a retry
    // of an interrupted run whose resolved agent name is no longer on
    // disk stops here with no launch.
    const resolved = resolveAgent(candidate.agent, availableAgents);
    if (!resolved.ok) {
      return { text: resolved.error, level: "warning" };
    }

    // Faithful relaunch: the launch ack records the original call's
    // REQUESTED overrides (details.params) and they are reconstructed
    // here, then re-validated through the SAME validateSubagentParams
    // path the tool runs, so the relaunch enters the identical
    // runSingleTask → applyInvocationOverride pipeline a first launch
    // does. The EFFECTIVE resolution is unrecoverable (it materializes
    // inside the run, after the ack was returned), but the requested
    // overrides are what a first launch would have applied — legacy
    // acks (no recorded params) run the agent's own defaults, and the
    // success output says which of the two happened.
    const task = spec.taskOf(candidate);
    if (task === undefined) {
      return { text: noTaskText(candidate), level: "warning" };
    }
    const revalidated = validateSubagentParams({ agent: resolved.value.name, task, ...candidate.params });
    if (!revalidated.ok) {
      return { text: `Run ${candidate.runId}'s recorded parameters failed validation (${revalidated.error}) — nothing was launched.`, level: "warning" };
    }
    // A well-typed but OUT-OF-RANGE recorded value would otherwise degrade
    // silently at run time (resolveMaxTurns/resolveTimeoutMs warn and fall
    // back or clamp). Reported visibly instead: the relaunch drops the key
    // — the agent's own value applies — and the output says so.
    const dropped = outOfRangeRelaunchFields(revalidated.value);
    const attempt = (relaunchAttempts.get(candidate.runId) ?? 0) + 1;
    relaunchAttempts.set(candidate.runId, attempt);
    const newRunId = relaunchRunId(spec.kind, candidate.runId, attempt);
    const job = launchSubagentJob({
      params: stripRelaunchFields(revalidated.value, dropped),
      agent: resolved.value,
      runId: newRunId,
      cwd: ctx.cwd,
      mode: ctx.mode,
      callerSessionFile: sessionFile,
      seedSessionFile,
    });
    if (candidate.status === "interrupted") {
      // The orphan's child dir is consumed by this launch: one branch
      // per orphan per session.
      consumedOrphanSegments.add(runIdDirName(candidate.runId));
    }
    ctx.budget?.add(candidate.runId);
    return { text: buildRelaunchResultText(spec.kind, candidate, job.id, newRunId, dropped), level: "info" };
  }

  // The shared dispatch behind the seven job actions: the /subagents command
  // and the subagent_job tool resolve their target and walk the same guard
  // chain, so their wording and levels cannot drift apart. `budget` is the tool
  // path's one-intervention-per-job record — a Set because this dispatcher both
  // checks it (has) and records into it (add, only on success); the command
  // path passes none, so a user-issued action is never refused.
  async function handleJobAction(
    action: "status" | "list" | "cancel" | "steer" | "followUp" | "retry" | "continue",
    id: string | undefined,
    message: string | undefined,
    ctx: JobActionContext,
    budget?: Set<string>,
  ): Promise<JobActionText> {
    if (action === "list") {
      return { text: buildJobListText(jobs.list(), Date.now(), ctx.theme), level: "info" };
    }
    if (action === "status") {
      let job: JobSnapshot;
      if (id) {
        const found = jobs.get(id);
        if (!found) {
          return { text: jobNotFoundText(id), level: "warning" };
        }
        job = found;
      } else {
        // Bare status auto-picks its target: the single active job, or the
        // newest settled one; several actives are ambiguous and ask for an id.
        const target = resolveAutoTarget(jobs.list());
        if (target.kind === "ambiguous") {
          return { text: ambiguousJobsText(target.ids), level: "info" };
        }
        if (target.kind === "none") {
          return { text: NO_JOBS_TEXT, level: "info" };
        }
        job = target.job;
      }
      return { text: buildJobStatusText(job, Date.now(), ctx.theme), level: "info" };
    }
    if (action === "cancel") {
      let snapshot: JobSnapshot | undefined;
      let cancelId = id;
      if (!cancelId) {
        // Bare cancel only targets active jobs (a settled job is nothing to
        // cancel); several actives are ambiguous and ask for an id.
        const target = resolveActiveTarget(jobs.list());
        if (target.kind === "ambiguous") {
          return { text: ambiguousJobsText(target.ids), level: "info" };
        }
        if (target.kind === "none") {
          return { text: "No running jobs to cancel.", level: "warning" };
        }
        snapshot = target.job;
        cancelId = target.job.id;
      } else {
        // An explicit id may name nothing at all: jobs.cancel answers
        // not-found on its own, so no snapshot means no budget to check.
        snapshot = jobs.get(cancelId);
      }
      if (snapshot && budget?.has(snapshot.runId)) {
        return { text: budgetExhaustedText("cancel", snapshot.id, snapshot.runId), level: "warning" };
      }
      const result = jobs.cancel(cancelId);
      if (result.kind === "cancelling") budget?.add(result.job.runId);
      return describeCancelResult(result);
    }
    if (action === "steer" || action === "followUp") {
      // Both verbs carry a message (the parser guarantees one); the empty
      // fallback only keeps the inject signature total.
      const injectMessage = message ?? "";
      let snapshot: JobSnapshot | undefined;
      let injectId = id;
      if (!injectId) {
        // Bare steer/followUp only targets active jobs, like bare cancel (a
        // settled job can no longer be messaged); several actives are
        // ambiguous and ask for an id.
        const target = resolveActiveTarget(jobs.list());
        if (target.kind === "ambiguous") {
          return { text: ambiguousJobsText(target.ids), level: "info" };
        }
        if (target.kind === "none") {
          return {
            text: action === "steer" ? "No running jobs to steer." : "No running jobs to follow up on.",
            level: "warning",
          };
        }
        snapshot = target.job;
        injectId = target.job.id;
      } else {
        snapshot = jobs.get(injectId);
      }
      if (snapshot && budget?.has(snapshot.runId)) {
        return { text: budgetExhaustedText(action, snapshot.id, snapshot.runId), level: "warning" };
      }
      // Awaiting the inject keeps the guard chain's result (not-live, a
      // throwing live session) observable through the same notify as cancel.
      const result = action === "steer"
        ? await jobs.steer(injectId, injectMessage)
        : await jobs.followUp(injectId, injectMessage);
      // Only a delivered message spends the budget: a failed guard (not-live,
      // not-running, ...) leaves the job's one intervention unspent.
      if (result.kind === "injected") budget?.add(result.job.runId);
      return describeInjectResult(action, result);
    }
    return handleRelaunch(RELAUNCH_SPECS[action], { kind: action, id }, { ...ctx, budget });
  }

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
      const job = launchSubagentJob({
        params,
        agent: resolved.value,
        runId: toolCallId,
        cwd: ctx.cwd,
        mode: ctx.mode,
        callerSessionFile,
      });

      // The ack records the call's REQUESTED overrides (details.params) so
      // /subagents retry|continue can relaunch faithfully; the key is
      // omitted when the call carried no overrides.
      return buildSubagentAckResult(job, invocationOverrideOf(params));
    },
  });

  // The job-management tool: the same seven-action chain /subagents runs, with
  // the one-intervention-per-job budget and the plain theme (the model reads
  // these texts, so theme markup would be noise).
  pi.registerTool({
    name: SUBAGENT_JOB_TOOL_NAME,
    label: "Subagent job",
    description: SUBAGENT_JOB_DESCRIPTION,
    parameters: SubagentJobParams,
    // Sequential on purpose: sibling tool calls are serialized, so two
    // interventions on the same job in one batch cannot both pass the budget
    // pre-check.
    executionMode: "sequential",
    execute: async (_toolCallId, rawParams, _signal, _onUpdate, ctx) => {
      const parsedParams = validateJobParams(rawParams);
      if (!parsedParams.ok) {
        return errorResult(parsedParams.error);
      }
      const { action, id, message } = parsedParams.value;
      // Guard-chain outcomes are normal results (what happened to the job);
      // only a malformed call is an error above.
      const { text } = await handleJobAction(
        action,
        id,
        message,
        { cwd: ctx.cwd, mode: ctx.mode, sessionManager: ctx.sessionManager, theme: PLAIN_THEME },
        toolInterventions,
      );
      return { content: [{ type: "text" as const, text }], details: { action, id } };
    },
  });

  pi.registerMessageRenderer(SUBAGENT_RESULT_MESSAGE_TYPE, renderSubagentResultMessage);

  pi.registerCommand("subagents", {
    description: "Background subagent jobs; /subagents peek|status|cancel|retry|continue [id], /subagents steer|followUp <id> <message>, /subagents list|clear|session, bare /subagents for help",
    handler: async (args, ctx) => {
      captureUi(ctx);
      const command = parseSubagentsCommand(args);
      if (command.kind === "help") {
        ctx.ui.notify(buildHelpText(), "info");
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
        // as a usage source (usage is always read from disk). MAIN (the
        // parent's own spend) comes from the in-memory session — getEntries()
        // is enough, the session lives fully in memory and re-parsing the
        // parent .jsonl would duplicate the same work with no gain. The
        // persisted-session guard above stays first: a session that never
        // hit disk gets no report at all, and its MAIN is never computed.
        const activeRunIds = new Set(jobs.list().filter((j) => isActive(j.state)).map((j) => j.runId));
        const report = buildSubagentSessionReport(
          sessionFile,
          nodeReconcileFs(),
          activeRunIds,
          undefined,
          toReconcileEntries(ctx.sessionManager.getEntries()),
        );
        ctx.ui.notify(buildSubagentSessionText(report, ctx.ui.theme), "info");
        return;
      }
      if (command.kind === "usage-error") {
        ctx.ui.notify(command.message, "warning");
        return;
      }
      // The seven job actions are the same chain the subagent_job tool runs;
      // this handler only owns the notify.
      const { text, level } = await handleJobAction(
        command.kind,
        "id" in command ? command.id : undefined,
        "message" in command ? command.message : undefined,
        { cwd: ctx.cwd, mode: ctx.mode, sessionManager: ctx.sessionManager, theme: ctx.ui.theme },
      );
      ctx.ui.notify(text, level);
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
    // Clear the footer status line first — the accumulated spend is this
    // session's, it means nothing the moment the session dies.
    uiRef?.ui?.setStatus(STATUS_KEY, undefined);
    jobs.shutdown();
    widget.dispose();
    peekManager.close();
  });
}