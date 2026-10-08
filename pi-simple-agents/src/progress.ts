import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { formatToolCall, MCP_TOOL_NAME } from "./format-tool-call.ts";
import { formatRunUsage, type RunUsage } from "./usage.ts";

export type SubagentToolEvent =
  | { type: "tool_start"; toolCallId: string; toolName: string; summary: string }
  | { type: "tool_end"; toolCallId: string };

/** The model's current streaming phase, derived from message_update deltas. */
export type StreamPhase = "thinking" | "output";

/** Everything the tracker folds into TaskProgress: tool lifecycle, the
 * model's stream phase (thinking/output, deduped downstream), and live usage
 * snapshots (one per message_end that actually added tokens). */
export type SubagentProgressEvent =
  | SubagentToolEvent
  | { type: "stream_phase"; phase: StreamPhase }
  | { type: "usage"; usage: RunUsage };

export function toSubagentToolEvent(event: AgentSessionEvent): SubagentToolEvent | undefined {
  if (event.type === "tool_execution_start") {
    return {
      type: "tool_start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      summary: formatToolCall(event.toolName, event.args),
    };
  }
  if (event.type === "tool_execution_end") {
    return { type: "tool_end", toolCallId: event.toolCallId };
  }
  return undefined;
}

// Maps the model's streaming deltas to a stream phase. Start and delta both
// set the same phase (delta is the one that actually fires per token; start
// covers models that emit a boundary event without a first delta).
const PHASE_OF_STREAM_EVENT: Record<string, StreamPhase | undefined> = {
  thinking_start: "thinking",
  thinking_delta: "thinking",
  text_start: "output",
  text_delta: "output",
};

export function toStreamPhaseEvent(event: AgentSessionEvent): SubagentProgressEvent | undefined {
  if (event.type !== "message_update") return undefined;
  const phase = PHASE_OF_STREAM_EVENT[event.assistantMessageEvent.type];
  return phase ? { type: "stream_phase", phase } : undefined;
}

export interface RunningTool {
  toolCallId: string;
  toolName: string;
}

export interface TaskProgress {
  agent: string;
  runningTools: RunningTool[];
  history: readonly string[];
  done: boolean;
  usage?: RunUsage;
  /** The model's current streaming phase; absent until the first delta. The
   * displayed activity word is NOT stored here — it is derived at render time
   * by activityWord() (running tool wins over streamPhase). */
  streamPhase?: StreamPhase;
}

export function initialTaskProgress(agent: string): TaskProgress {
  return { agent, runningTools: [], history: [], done: false };
}

export function applyToolEvent(progress: TaskProgress, event: SubagentToolEvent): TaskProgress {
  if (event.type === "tool_start") {
    return {
      ...progress,
      runningTools: [...progress.runningTools, { toolCallId: event.toolCallId, toolName: event.toolName }],
      history: [...progress.history, event.summary],
    };
  }
  return {
    ...progress,
    runningTools: progress.runningTools.filter((t) => t.toolCallId !== event.toolCallId),
  };
}

// Folds any progress event. Identity-preserving by design: a stream_phase
// event for the phase already stored returns the SAME object, so the tracker
// (and the widget refresh chain behind it) can skip re-emitting per-token
// deltas — the dedupe lives here, not in buffers or timers.
export function applyProgressEvent(progress: TaskProgress, event: SubagentProgressEvent): TaskProgress {
  if (event.type === "tool_start" || event.type === "tool_end") return applyToolEvent(progress, event);
  if (event.type === "stream_phase") {
    return progress.streamPhase === event.phase ? progress : { ...progress, streamPhase: event.phase };
  }
  return { ...progress, usage: event.usage };
}

export function markDone(progress: TaskProgress, usage?: RunUsage): TaskProgress {
  const done = { ...progress, done: true, runningTools: [] };
  return usage ? { ...done, usage } : done;
}

// Orchestrates the run's progress fold/emit cycle: holds the mutable progress
// value as a module-confined closure local (same "local mutability is fine"
// precedent as runAgentViaSdk's settled/session locals), folds incoming tool
// events through the pure reducers above, and re-emits the new value on every
// change so callers can render a live feed.
export interface ProgressTracker {
  onEvent(event: SubagentProgressEvent): void;
  markTaskDone(usage?: RunUsage): void;
}

export function createProgressTracker(
  agent: string,
  emit: (progress: TaskProgress) => void,
): ProgressTracker {
  let progress: TaskProgress = initialTaskProgress(agent);

  return {
    onEvent(event) {
      if (progress.done) return;
      const next = applyProgressEvent(progress, event);
      if (next === progress) return; // dedupe: repeated phase -> no emit, no widget refresh
      progress = next;
      emit(progress);
    },
    markTaskDone(usage) {
      progress = markDone(progress, usage);
      emit(progress);
    },
  };
}

export interface ProgressTheme {
  fg(color: "accent" | "dim", text: string): string;
}

function statusFor(progress: TaskProgress): string {
  if (progress.done) return "done";
  if (progress.runningTools.length > 0) {
    return `running: ${progress.runningTools.map((t) => t.toolName).join(", ")}`;
  }
  return progress.streamPhase ?? "working\u2026";
}

// Short label for the 1-word activity display: MCP tools (`mcp__server__tool`)
// collapse to their server name; any other tool shows as itself.
export function shortToolName(toolName: string): string {
  const match = MCP_TOOL_NAME.exec(toolName);
  return match ? match[1] : toolName;
}

// The one-word "what is it doing" label. Derived, never stored: a running
// tool wins over the stream phase (the tool IS what it's doing right now);
// with parallel tools the most recently started one is shown. Fallback is
// `waiting` — the run is alive but hasn't streamed anything or called a tool
// yet (e.g. waiting on the first delta of the turn).
export function activityWord(progress: TaskProgress): string {
  if (progress.done) return "done";
  const latest = progress.runningTools.at(-1);
  if (latest) return shortToolName(latest.toolName);
  if (progress.streamPhase) return progress.streamPhase;
  return "waiting";
}

export function buildProgressLine(progress: TaskProgress, theme: ProgressTheme): string {
  const agent = theme.fg("accent", progress.agent);
  // The usage footer only ever appears once the task is done — it's a
  // post-mortem of the run's consumption, not a live counter.
  const footer = progress.done && progress.usage ? formatRunUsage(progress.usage) : "";
  const segments = [`tools: ${progress.history.length}`, statusFor(progress), ...(footer ? [footer] : [])];
  const detail = theme.fg("dim", `\u00b7 ${segments.join(" \u00b7 ")}`);
  return `${agent} ${detail}`;
}
