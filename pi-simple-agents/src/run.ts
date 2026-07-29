import type { AgentConfig } from "./agents.ts";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import type { SubagentToolEvent } from "./progress.ts";
import { toSubagentToolEvent } from "./progress.ts";

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

export function resolveTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  console.warn(`pi-simple-agents: invalid timeoutMs ${value}, falling back to default`);
  return DEFAULT_TIMEOUT_MS;
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
  "modelRegistry" | "model" | "thinkingLevel" | "tools" | "excludeTools" | "resourceLoader" | "sessionManager"
>;

export interface RunAgentViaSdkOptions {
  modelRegistry: CreateAgentSessionOptions["modelRegistry"];
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
  return getModel(parts[0], parts.slice(1).join("/"));
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
    let timer: ReturnType<typeof setTimeout> | undefined;

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
          modelRegistry: options.modelRegistry,
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

        const abortHandler = () => { agentSession.abort(); };
        options.signal?.addEventListener("abort", abortHandler, { once: true });

        subscribeToolEvents(agentSession, options.onToolEvent);

        const timeoutMs = resolveTimeoutMs(agent.timeoutMs);
        timer = setTimeout(() => {
          if (settled) return;
          settleOnce(errorResult(ctx, `timed out after ${timeoutMs}ms`));
          Promise.resolve(agentSession.abort()).catch(() => { /* ignore */ });
        }, timeoutMs);

        await agentSession.prompt(task);

        options.signal?.removeEventListener("abort", abortHandler);
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
          err instanceof Error ? err.message : String(err),
        ));
      } finally {
        if (timer) clearTimeout(timer);
        if (session) {
          try { session.dispose(); } catch { /* ignore */ }
        }
      }
    })();
  });
}