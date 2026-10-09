import type { AgentConfig } from "./agents.ts";
import type { CreateAgentSessionOptions, CreateAgentSessionResult, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SubagentProgressEvent } from "./progress.ts";
import { toSubagentToolEvent, toStreamPhaseEvent } from "./progress.ts";
import { toErrorMessage, WARN_PREFIX } from "./warn.ts";
import { applyUsageEvent, emptyUsage, toRunUsage, type UsageAccumulator, type RunUsage } from "./usage.ts";
import { needsExtensionBinding, type ExtensionMode } from "./extension-binding.ts";
import { isValidMaxTurns, isValidModelRef } from "./overrides.ts";

interface AgentRunResultBase {
  agent: string;
  task: string;
  durationMs: number;
  usage?: RunUsage;
  /** Path of this run's own persisted session file, if the caller's session manager persists (undefined when in-memory). */
  sessionFile?: string;
}

export type AgentRunResult =
  | (AgentRunResultBase & { status: "success"; finalText?: string })
  | (AgentRunResultBase & { status: "error"; error: string });

type SettleFn = (result: AgentRunResult) => void;

interface AgentRunContext {
  agent: AgentConfig;
  task: string;
  startedAt: number;
}

function errorResult(ctx: AgentRunContext, error: string): AgentRunResult {
  return {
    agent: ctx.agent.name,
    task: ctx.task,
    status: "error",
    error,
    durationMs: Date.now() - ctx.startedAt,
  };
}

function successResult(ctx: AgentRunContext, finalText: string | undefined): AgentRunResult {
  return {
    agent: ctx.agent.name,
    task: ctx.task,
    status: "success",
    finalText,
    durationMs: Date.now() - ctx.startedAt,
  };
}

const VALID_THINKING_LEVELS = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
] as const;

type ThinkingLevel = (typeof VALID_THINKING_LEVELS)[number];

export function clampThinkingLevel(level: string): ThinkingLevel | undefined {
  if ((VALID_THINKING_LEVELS as readonly string[]).includes(level)) return level as ThinkingLevel;
  console.warn(`${WARN_PREFIX}invalid thinking level "${level}", falling back to default`);
  return undefined;
}

export type AwaitOutcome = "settled" | "timeout" | "aborted" | "failed";

/**
 * Waits at most `ms` for `work`, or until `signal` aborts, whichever comes
 * first. Never rejects: `work`'s rejection surfaces through the return
 * value (`{ outcome: "failed", error }`), and a rejection that arrives
 * *after* we've already stopped waiting (timeout/abort) is swallowed with
 * an attached no-op `.catch()` so it can never surface as an unhandled
 * rejection.
 */
export function awaitAtMost(
  work: Promise<unknown>,
  ms: number,
  signal?: AbortSignal,
): Promise<{ outcome: AwaitOutcome; error?: unknown }> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (result: { outcome: AwaitOutcome; error?: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => finish({ outcome: "timeout" }), ms);

    const onAbort = () => finish({ outcome: "aborted" });
    signal?.addEventListener("abort", onAbort, { once: true });

    // Both branches of .then() route into finish(), which is a no-op once
    // already settled (timeout/abort) — so a late rejection is handled here,
    // not left to surface as an unhandled rejection.
    work.then(
      () => finish({ outcome: "settled" }),
      (error) => finish({ outcome: "failed", error }),
    );
  });
}

export const DEFAULT_TIMEOUT_MS = 600_000; // 10 min.
export const MAX_TIMEOUT_MS = 7_200_000; // 2h ceiling, enforced here for every layer (frontmatter/settings/param).

export function resolveTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    if (value <= MAX_TIMEOUT_MS) return value;
    console.warn(`${WARN_PREFIX}timeoutMs ${value} exceeds the maximum of ${MAX_TIMEOUT_MS}ms, clamping`);
    return MAX_TIMEOUT_MS;
  }
  console.warn(`${WARN_PREFIX}invalid timeoutMs ${value}, falling back to default`);
  return DEFAULT_TIMEOUT_MS;
}

// (MAX_TURNS_LIMIT/isValidMaxTurns live in src/overrides.ts, the single home
// for override-field validation — resolveMaxTurns here, normalizeMaxTurns in
// frontmatter.ts and validateAgentOverridesEntry share the same predicate.)

export function resolveMaxTurns(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (isValidMaxTurns(value)) return value;
  console.warn(`${WARN_PREFIX}invalid maxTurns ${value}, ignoring (no limit)`);
  return undefined;
}

type CreateSessionOpts = Pick<
  CreateAgentSessionOptions,
  "modelRuntime" | "model" | "thinkingLevel" | "tools" | "excludeTools" | "resourceLoader" | "sessionManager"
>;

export interface RunAgentViaSdkOptions {
  modelRuntime: NonNullable<CreateAgentSessionOptions["modelRuntime"]>;
  createSession: (opts: CreateSessionOpts) => Promise<Pick<CreateAgentSessionResult, "session">>;
  resourceLoader: CreateAgentSessionOptions["resourceLoader"];
  sessionManager: CreateAgentSessionOptions["sessionManager"];
  signal?: AbortSignal;
  onProgressEvent?: (event: SubagentProgressEvent) => void;
  getModel?: (provider: string, modelId: string) => CreateAgentSessionOptions["model"];
  /** Host run mode, used to gate MCP/extension initialization to modes that exit cleanly (see bindExtensionsIfNeeded). */
  mode?: ExtensionMode;
  /** Overrides EXTENSION_BIND_TIMEOUT_MS. Test seam; production callers should leave this unset. */
  extensionBindTimeoutMs?: number;
}

// bindExtensions reaches out to child processes/sockets (an MCP server
// handshake); runAgentViaSdk's own timeoutMs/AbortSignal only wrap the
// prompt phase (see runWithTimeoutAndAbort below), so without this bound a
// hung handshake would block the whole run indefinitely, uninterruptibly.
export const EXTENSION_BIND_TIMEOUT_MS = 60_000;

type ModelResolution =
  | { ok: true; model: CreateAgentSessionOptions["model"] }
  | { ok: false; error: string };

// Q1: strict, zero fallbacks. The only way to the session default model is no
// model or "inherit"; any other value must be a well-formed "provider/modelId"
// ref that resolves in the registry, otherwise the run FAILS with a clear
// error naming the agent, the value, and the fix. The run — not the config
// load — is the single validation chokepoint (dropping bad values at load
// would silently yield the session default, the fallback this removes).
function resolveModel(
  agent: AgentConfig,
  getModel: RunAgentViaSdkOptions["getModel"],
): ModelResolution {
  if (!agent.model || !getModel) return { ok: true, model: undefined }; // inherit / documented test seam (Q5)
  if (!isValidModelRef(agent.model)) {
    return {
      ok: false,
      error: `agent "${agent.name}" has an invalid "model" value "${agent.model}": expected "provider/modelId" form (e.g. "anthropic/claude-opus-4-8"), "inherit", or no model at all — the run was not started`,
    };
  }
  const slashIndex = agent.model.indexOf("/");
  const provider = agent.model.slice(0, slashIndex);
  const modelId = agent.model.slice(slashIndex + 1);
  const model = getModel(provider, modelId);
  if (!model) {
    return {
      ok: false,
      error: `model "${agent.model}" (configured for agent "${agent.name}") was not found in the model registry — provider "${provider}" is not registered or the model id does not exist; the run fails instead of falling back to the session default model (fix the "model" setting or remove it to inherit the session default)`,
    };
  }
  return { ok: true, model };
}

// Emits session_start in the subagent's own nested AgentSession, so
// extensions that depend on that hook (e.g. pi's built-in MCP extension
// connecting servers and registering mcp__* tools) actually initialize.
// Skipped when needsExtensionBinding finds no such dependency (see
// extension-binding.ts), to avoid paying MCP connection cost in subagents
// that only use base built-in tools. No mode gate:
// the host itself (pi's print/json/tui/rpc modes) already binds+shuts down
// symmetrically on its own exit path (see shutdownExtensionsIfBound below),
// so the same pattern here is safe in every mode.
// Returns true iff bindExtensions was actually issued (session_start was
// emitted) — the caller owns the symmetric shutdownExtensionsIfBound() call
// once the run settles, regardless of whether the bind itself succeeded.
async function bindExtensionsIfNeeded(
  agentSession: CreateAgentSessionResult["session"],
  mode: RunAgentViaSdkOptions["mode"],
  bindTimeoutMs: number,
  signal: AbortSignal | undefined,
  requestedToolNames: readonly string[] | undefined,
): Promise<boolean> {
  if (!needsExtensionBinding(agentSession.getAllTools(), requestedToolNames)) return false;
  const { outcome, error } = await awaitAtMost(
    agentSession.bindExtensions({ mode }),
    bindTimeoutMs,
    signal,
  );
  if (outcome === "failed") {
    console.warn(`${WARN_PREFIX}failed to initialize extensions for subagent: ${toErrorMessage(error)}`);
  } else if (outcome === "timeout") {
    console.warn(
      `${WARN_PREFIX}extension initialization did not complete within ${bindTimeoutMs}ms for subagent; ` +
        `continuing without waiting further`,
    );
  }
  // "aborted": no warning here — the pre-existing options.signal?.aborted
  // check right after this call already settles the run as "run was
  // aborted", so a second message would be redundant.
  // session_start was emitted either way (the catch above is for a rejection
  // after that point, not for never having called bindExtensions), so the
  // symmetric shutdown must still run — an extension that partially started
  // servers on a bind failure needs the same session_shutdown chance to stop
  // them.
  return true;
}

// Symmetric counterpart to bindExtensionsIfNeeded: emits session_shutdown on
// the session's own ExtensionRunner before dispose(), exactly as the SDK's
// own AgentSessionRuntime.dispose() does (core/agent-session-runtime.js) —
// this is what lets an MCP extension stop the MCP server
// child process(es) it spawned as a side effect of session_start, instead of
// leaving them running past this subagent's lifetime. No-op when `bound` is
// false (bindExtensions was never called, so there is nothing to shut down).
// Precondition this relies on: the MCP extension's state is scoped to this
// nested session's own extension factory invocation, not shared with the
// host's — so this shutdown only stops the subagent's own MCP connections,
// never the host's (verified for pi 0.99's built-in extension in
// dist/extensions/mcp/index.js: servers/sessionActive are closure-local to
// the `(pi) => {...}` factory createMcpExtension returns).
async function shutdownExtensionsIfBound(
  agentSession: CreateAgentSessionResult["session"],
  bound: boolean,
): Promise<void> {
  if (!bound) return;
  try {
    if (agentSession.extensionRunner.hasHandlers("session_shutdown")) {
      await agentSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    }
  } catch (error) {
    console.warn(`${WARN_PREFIX}failed to shut down extensions for subagent: ${toErrorMessage(error)}`);
  }
}

function subscribeTurnCounter(
  agentSession: CreateAgentSessionResult["session"],
  maxTurns: number,
  onLimit: () => void,
): void {
  let turnCount = 0;
  agentSession.subscribe((event) => {
    if (event.type !== "turn_start") return;
    turnCount += 1;
    if (turnCount > maxTurns) onLimit();
  });
}

// Registers the abort listener, schedules the timeout, and issues the prompt.
// Resolves when prompt() resolves normally, or after abort() is triggered by
// signal-abort or timeout — prompt's own rejection/resolution races the abort;
// the caller's settleOnce dedupes, so no "resolved vs aborted" discriminant is
// needed here. onTimeout is invoked once, before abort() is issued, so the
// caller can settle "timed out" before disposal races the prompt's rejection.
// Listener removal only happens on the normal-completion path — the abort
// path relies on { once: true } to self-remove instead.
export async function runWithTimeoutAndAbort(
  agentSession: CreateAgentSessionResult["session"],
  task: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onTimeout: () => void,
): Promise<void> {
  const abortHandler = () => { agentSession.abort(); };
  signal?.addEventListener("abort", abortHandler, { once: true });

  const timer = setTimeout(() => {
    onTimeout();
    Promise.resolve(agentSession.abort()).catch(() => { /* ignore */ });
  }, timeoutMs);

  try {
    await agentSession.prompt(task);
    signal?.removeEventListener("abort", abortHandler);
  } finally {
    clearTimeout(timer);
  }
}

export function runAgentViaSdk(
  agent: AgentConfig,
  task: string,
  options: RunAgentViaSdkOptions,
): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const ctx: AgentRunContext = { agent, task, startedAt };
  const isSubscription = (provider: string) => options.modelRuntime.isUsingSubscription(provider);

  return new Promise((resolve) => {
    let settled = false;
    let session: CreateAgentSessionResult["session"] | null = null;
    let boundExtensions = false;
    let usageAcc = emptyUsage();

    // Snapshot whatever usage has accumulated so far and attach it to the
    // result, regardless of which path settles the run (success, error,
    // timeout, maxTurns, or abort) — the tokens were already spent.
    const settleOnce: SettleFn = (result) => {
      if (settled) return;
      settled = true;
      const usage = toRunUsage(
        usageAcc,
        session?.getContextUsage(),
        isSubscription,
      );
      const sessionFile = options.sessionManager?.getSessionFile?.();
      resolve({ ...result, usage, sessionFile });
    };

    (async () => {
      try {
        const modelResolution = resolveModel(agent, options.getModel);
        if (!modelResolution.ok) {
          // Fails before createSession: no session, no tokens spent; the
          // error carries the run's identity into the job's completion message.
          settleOnce(errorResult(ctx, modelResolution.error));
          return;
        }
        const model = modelResolution.model;

        const thinkingLevel = agent.thinking
          ? clampThinkingLevel(agent.thinking)
          : undefined;

        const { session: agentSession } = await options.createSession({
          modelRuntime: options.modelRuntime,
          model,
          thinkingLevel,
          tools: agent.tools,
          excludeTools: agent.disallowedTools,
          resourceLoader: options.resourceLoader,
          sessionManager: options.sessionManager,
        });
        session = agentSession;

        boundExtensions = await bindExtensionsIfNeeded(
          agentSession,
          options.mode,
          options.extensionBindTimeoutMs ?? EXTENSION_BIND_TIMEOUT_MS,
          options.signal,
          agent.tools,
        );

        if (options.signal?.aborted) {
          settleOnce(errorResult(ctx, "run was aborted"));
          return;
        }

        // Unconditional single subscription: usage accumulation does not
        // depend on the collector, and the collector (when present) receives
        // both translated progress events (tools + stream phases) and live
        // usage snapshots whenever the accumulator actually changed. The
        // done-guard and the per-token phase dedupe live in the tracker
        // (progress.ts), not here.
        const onSessionEvent = (event: AgentSessionEvent) => {
          const before = usageAcc;
          usageAcc = applyUsageEvent(usageAcc, event);
          const onProgressEvent = options.onProgressEvent;
          if (!onProgressEvent) return;
          const progressEvent = toSubagentToolEvent(event) ?? toStreamPhaseEvent(event);
          if (progressEvent) onProgressEvent(progressEvent);
          if (usageAcc !== before) {
            onProgressEvent({
              type: "usage",
              usage: toRunUsage(
                usageAcc,
                agentSession.getContextUsage(),
                isSubscription,
              ),
            });
          }
        };
        agentSession.subscribe(onSessionEvent);

        const maxTurns = resolveMaxTurns(agent.maxTurns);
        if (maxTurns !== undefined) {
          subscribeTurnCounter(agentSession, maxTurns, () => {
            settleOnce(errorResult(ctx, `reached maxTurns limit of ${maxTurns}`));
            Promise.resolve(agentSession.abort()).catch(() => { /* ignore */ });
          });
        }

        const timeoutMs = resolveTimeoutMs(agent.timeoutMs);
        await runWithTimeoutAndAbort(
          agentSession,
          task,
          timeoutMs,
          options.signal,
          () => settleOnce(errorResult(ctx, `timed out after ${timeoutMs}ms`)),
        );

        // If the signal aborted during the prompt, the abort handler already
        // unblocked agentSession.prompt() via agentSession.abort() but did not
        // settle the run. Mirror the pre-abort check above so a mid-prompt
        // signal abort settles as the same "run was aborted" error rather than
        // falling through to the success block. settleOnce keeps this safe
        // against races with the timeout or maxTurns paths (already-settled
        // runs are no-ops here).
        if (options.signal?.aborted) {
          settleOnce(errorResult(ctx, "run was aborted"));
          return;
        }

        const finalText = agentSession.getLastAssistantText() ?? undefined;

        settleOnce(successResult(ctx, finalText));
      } catch (err) {
        settleOnce(errorResult(
          ctx,
          toErrorMessage(err),
        ));
      } finally {
        if (session) {
          await shutdownExtensionsIfBound(session, boundExtensions);
          try { session.dispose(); } catch { /* ignore */ }
        }
      }
    })();
  });
}