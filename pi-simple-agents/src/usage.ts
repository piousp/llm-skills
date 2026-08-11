import type { AgentSessionEvent, ContextUsage } from "@earendil-works/pi-coding-agent";

// Structural shape of the SDK's `Usage` type. Not importable here:
// @earendil-works/pi-ai is nested under pi-coding-agent's own node_modules
// and does not resolve from this package.
export interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

// Fold state over a run's message events. `provider` is the last assistant
// message's provider seen; undefined if the run never got an assistant reply.
export interface UsageAccumulator {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  readonly provider: string | undefined;
}

// Immutable snapshot of one run's consumption. `context` is grouped so that
// "window known but percent unknown" is unrepresentable. Cache-hit % is
// derived at format time, not stored, to keep a single source of truth.
export interface RunUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  readonly isSubscription: boolean;
  readonly context: { readonly percent: number | null; readonly window: number } | undefined;
}

export function emptyUsage(): UsageAccumulator {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, provider: undefined };
}

function addUsage(acc: UsageAccumulator, usage: MessageUsage, provider: string | undefined): UsageAccumulator {
  return {
    input: acc.input + usage.input,
    output: acc.output + usage.output,
    cacheRead: acc.cacheRead + usage.cacheRead,
    cacheWrite: acc.cacheWrite + usage.cacheWrite,
    cost: acc.cost + usage.cost.total,
    provider: provider ?? acc.provider,
  };
}

// Only `message_end` carries the message's final usage; `message_start` and
// `turn_end` re-emit the same message (start with a partial/duplicate, end
// with the same final one) and would double-count if included.
export function applyUsageEvent(acc: UsageAccumulator, event: AgentSessionEvent): UsageAccumulator {
  if (event.type !== "message_end") return acc;
  const message = event.message;
  if (message.role === "assistant") {
    return addUsage(acc, message.usage, message.provider);
  }
  if (message.role === "toolResult" && message.usage) {
    return addUsage(acc, message.usage, undefined);
  }
  return acc;
}

export function toRunUsage(
  acc: UsageAccumulator,
  context: ContextUsage | undefined,
  isUsingSubscription: (provider: string) => boolean,
): RunUsage {
  return {
    input: acc.input,
    output: acc.output,
    cacheRead: acc.cacheRead,
    cacheWrite: acc.cacheWrite,
    cost: acc.cost,
    isSubscription: acc.provider !== undefined ? isUsingSubscription(acc.provider) : false,
    context: context ? { percent: context.percent, window: context.contextWindow } : undefined,
  };
}

// Local reimplementation: the original lives in an internal, non-exported
// path of @earendil-works/pi-coding-agent (dist/modes/interactive/components/footer.js).
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function formatRunUsage(usage: RunUsage): string {
  const parts: string[] = [];
  if (usage.input !== 0) parts.push(`\u2191${formatTokens(usage.input)}`);
  if (usage.output !== 0) parts.push(`\u2193${formatTokens(usage.output)}`);
  if (usage.cacheRead !== 0) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite !== 0) parts.push(`W${formatTokens(usage.cacheWrite)}`);

  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  if ((usage.cacheRead !== 0 || usage.cacheWrite !== 0) && prompt > 0) {
    parts.push(`CH${((usage.cacheRead / prompt) * 100).toFixed(1)}%`);
  }

  if (usage.cost !== 0 || usage.isSubscription) {
    parts.push(`$${usage.cost.toFixed(3)}${usage.isSubscription ? " (sub)" : ""}`);
  }

  if (usage.context) {
    const { percent, window } = usage.context;
    parts.push(percent === null ? `?/${formatTokens(window)}` : `${percent.toFixed(1)}%/${formatTokens(window)}`);
  }

  return parts.join(" ");
}
