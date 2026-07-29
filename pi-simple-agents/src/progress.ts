import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type SubagentToolEvent =
  | { type: "tool_start"; toolCallId: string; toolName: string }
  | { type: "tool_end"; toolCallId: string };

export function toSubagentToolEvent(event: AgentSessionEvent): SubagentToolEvent | undefined {
  if (event.type === "tool_execution_start") {
    return { type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName };
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
  toolCount: number;
  runningTools: RunningTool[];
  done: boolean;
}

export function initialTaskProgress(agent: string): TaskProgress {
  return { agent, toolCount: 0, runningTools: [], done: false };
}

export function applyToolEvent(progress: TaskProgress, event: SubagentToolEvent): TaskProgress {
  if (event.type === "tool_start") {
    return {
      ...progress,
      toolCount: progress.toolCount + 1,
      runningTools: [...progress.runningTools, { toolCallId: event.toolCallId, toolName: event.toolName }],
    };
  }
  return {
    ...progress,
    runningTools: progress.runningTools.filter((t) => t.toolCallId !== event.toolCallId),
  };
}

export function markDone(progress: TaskProgress): TaskProgress {
  return { ...progress, done: true, runningTools: [] };
}

// Orchestrates the per-task progress fold/emit cycle for `runTasks`: holds the
// mutable progress array as a module-confined closure local (same "local
// mutability is fine" precedent as runAgentViaSdk's settled/session locals),
// folds incoming tool events through the pure reducers above, and re-emits a
// shallow copy of the array on every change so callers can render a live feed.
export interface ProgressTracker {
  onToolEvent(index: number, event: SubagentToolEvent): void;
  markTaskDone(index: number): void;
}

export function createProgressTracker(
  agents: readonly string[],
  emit: (details: { progress: readonly TaskProgress[] }) => void,
): ProgressTracker {
  const progress: TaskProgress[] = agents.map((agent) => initialTaskProgress(agent));

  return {
    onToolEvent(index, event) {
      if (progress[index].done) return;
      progress[index] = applyToolEvent(progress[index], event);
      emit({ progress: [...progress] });
    },
    markTaskDone(index) {
      progress[index] = markDone(progress[index]);
      emit({ progress: [...progress] });
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

function buildProgressLine(progress: TaskProgress, theme: ProgressTheme): string {
  const agent = theme.fg("accent", progress.agent);
  const detail = theme.fg("dim", `\u00b7 tools: ${progress.toolCount} \u00b7 ${statusFor(progress)}`);
  return `${agent} ${detail}`;
}

export function buildProgressLines(progress: readonly TaskProgress[], theme: ProgressTheme): string {
  return progress.map((p) => buildProgressLine(p, theme)).join("\n");
}
