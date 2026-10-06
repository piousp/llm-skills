import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { formatToolCall } from "./format-tool-call.ts";
import { formatRunUsage, type RunUsage } from "./usage.ts";

export type SubagentToolEvent =
  | { type: "tool_start"; toolCallId: string; toolName: string; summary: string }
  | { type: "tool_end"; toolCallId: string };

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
  onToolEvent(event: SubagentToolEvent): void;
  markTaskDone(usage?: RunUsage): void;
}

export function createProgressTracker(
  agent: string,
  emit: (progress: TaskProgress) => void,
): ProgressTracker {
  let progress: TaskProgress = initialTaskProgress(agent);

  return {
    onToolEvent(event) {
      if (progress.done) return;
      progress = applyToolEvent(progress, event);
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
  return "working\u2026";
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
