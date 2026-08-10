import type { AgentConfig } from "./agents.ts";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import type { SubagentToolEvent } from "./progress.ts";
import { toSubagentToolEvent } from "./progress.ts";
import { toErrorMessage, WARN_PREFIX } from "./warn.ts";

interface AgentRunResultBase {
  agent: string;
  task: string;
  durationMs: number;
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

const VALID_THINKING_LEVELS = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
] as const;

type ThinkingLevel = (typeof VALID_THINKING_LEVELS)[number];

export function clampThinkingLevel(level: string): ThinkingLevel | undefined {
  if ((VALID_THINKING_LEVELS as readonly string[]).includes(level)) return level as ThinkingLevel;
  console.warn(`pi-simple-agents: invalid thinking level "${level}", falling back to default`);
  return undefined;
}

export const DEFAULT_TIMEOUT_MS = 600_000; // 10 min, per Phase 1 decision.
export const MAX_TIMEOUT_MS = 7_200_000; // 2h ceiling, enforced here for every layer (frontmatter/settings/param).

export function resolveTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    if (value <= MAX_TIMEOUT_MS) return value;
    console.warn(`pi-simple-agents: timeoutMs ${value} exceeds the maximum of ${MAX_TIMEOUT_MS}ms, clamping`);
    return MAX_TIMEOUT_MS;
  }
  console.warn(`pi-simple-agents: invalid timeoutMs ${value}, falling back to default`);
  return DEFAULT_TIMEOUT_MS;
}

export const DEFAULT_CONCURRENCY = 4;

export function resolveConcurrency(value: unknown): number {
  if (value === undefined) return DEFAULT_CONCURRENCY;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  console.warn(`pi-simple-agents: invalid concurrency ${value}, falling back to default`);
  return DEFAULT_CONCURRENCY;
}

export const MAX_TURNS_LIMIT = 100;

// Shared predicate: the same valid-set check (positive integer up to the limit)
// that resolveMaxTurns uses here and that normalizeMaxTurns in frontmatter.ts
// uses with a different warn sink. Living in one place keeps the two
// chokepoint's "what counts as a valid maxTurns" definitions in lockstep;
// each chokepoint still owns its own warn and its own `number | undefined`
// return shape.
export function isValidMaxTurns(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isInteger(value)
    && value >= 1
    && value <= MAX_TURNS_LIMIT
  );
}

export function resolveMaxTurns(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (isValidMaxTurns(value)) return value;
  console.warn(`pi-simple-agents: invalid maxTurns ${value}, ignoring (no limit)`);
  return undefined;
}

export function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return Promise.resolve([]);
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;

  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });

  return Promise.all(workers).then(() => results);
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
  onToolEvent?: (event: SubagentToolEvent) => void;
  getModel?: (provider: string, modelId: string) => CreateAgentSessionOptions["model"];
}

function resolveModel(
  agent: AgentConfig,
  getModel: RunAgentViaSdkOptions["getModel"],
): CreateAgentSessionOptions["model"] {
  if (!agent.model || !getModel) return undefined;
  const parts = agent.model.split("/");
  if (parts.length < 2) return undefined;
  const model = getModel(parts[0], parts.slice(1).join("/"));
  if (!model) {
    console.warn(
      `${WARN_PREFIX}model "${agent.model}" not found in the model registry ` +
        `(provider "${parts[0]}" is not registered or the model id does not exist) — ` +
        `falling back to the session default model`,
    );
  }
  return model;
}

function subscribeToolEvents(
  agentSession: CreateAgentSessionResult["session"],
  onToolEvent: RunAgentViaSdkOptions["onToolEvent"],
): void {
  if (!onToolEvent) return;
  agentSession.subscribe((event) => {
    const toolEvent = toSubagentToolEvent(event);
    if (toolEvent) onToolEvent(toolEvent);
  });
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
// path relies on { once: true } to self-remove, matching prior behavior.
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

  return new Promise((resolve) => {
    let settled = false;
    let session: any = null;

    const settleOnce: SettleFn = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    (async () => {
      try {
        const model = resolveModel(agent, options.getModel);

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

        if (options.signal?.aborted) {
          settleOnce(errorResult(ctx, "run was aborted"));
          return;
        }

        subscribeToolEvents(agentSession, options.onToolEvent);

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

        settleOnce({
          agent: ctx.agent.name,
          task: ctx.task,
          status: "success" as const,
          finalText,
          durationMs: Date.now() - ctx.startedAt,
        });
      } catch (err) {
        settleOnce(errorResult(
          ctx,
          toErrorMessage(err),
        ));
      } finally {
        if (session) {
          try { session.dispose(); } catch { /* ignore */ }
        }
      }
    })();
  });
}