import type { AgentConfig } from "./agents.ts";

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

export function clampThinkingLevel(level: string): string | undefined {
  if ((VALID_THINKING_LEVELS as readonly string[]).includes(level)) return level;
  console.warn(`pi-simple-agents: invalid thinking level "${level}", falling back to default`);
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

export interface RunAgentViaSdkOptions {
  modelRuntime: unknown;
  createSession: (opts: {
    modelRuntime: unknown;
    model?: unknown;
    thinkingLevel?: string;
    tools?: string[];
    resourceLoader?: unknown;
    sessionManager?: unknown;
  }) => Promise<{ session: {
    prompt(text: string): Promise<void>;
    subscribe(listener: (event: any) => void): () => void;
    getLastAssistantText(): string;
    dispose(): void;
    abort(): void;
  } }>;
  resourceLoader: unknown;
  sessionManager: unknown;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  getModel?: (provider: string, modelId: string) => unknown;
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
        let model: unknown = undefined;
        if (agent.model && options.getModel) {
          const parts = agent.model.split("/");
          if (parts.length >= 2) {
            model = options.getModel(parts[0], parts.slice(1).join("/"));
          }
        }

        const thinkingLevel = agent.thinking
          ? clampThinkingLevel(agent.thinking)
          : undefined;

        const { session: agentSession } = await options.createSession({
          modelRuntime: options.modelRuntime,
          model,
          thinkingLevel,
          tools: agent.tools,
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

        if (options.onProgress) {
          agentSession.subscribe((event: any) => {
            if (
              event.type === "message_update" &&
              event.assistantMessageEvent?.type === "text_delta"
            ) {
              options.onProgress!(event.assistantMessageEvent.delta);
            }
          });
        }

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
        if (session) {
          try { session.dispose(); } catch { /* ignore */ }
        }
      }
    })();
  });
}