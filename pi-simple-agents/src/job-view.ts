import { buildProgressLine, activityWord, type ProgressTheme } from "./progress.ts";
import { firstLine, truncate } from "./text-utils.ts";
import { formatRunUsage } from "./usage.ts";
import type { AgentRunResult } from "./run.ts";
import { isActive, type CancelResult, type JobSnapshot } from "./background-jobs.ts";

/** "0s", "1m 00s", "1h 00m" — stable-width, no fractional seconds. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

// One-word "what is it doing" column, derived by progress.ts's activityWord
// (running tool wins over stream phase; `waiting` when nothing has streamed
// yet). Preview is capped narrower than the tool-call previews to keep the
// whole line short enough for the widget.
const WIDGET_PREVIEW_WIDTH = 48;

function unfinishedTaskLine(job: JobSnapshot, now: number, theme: ProgressTheme): string | undefined {
  if (job.progress.done) return undefined;

  const cancelling = job.state.status === "cancelling";
  const marker = cancelling ? "\u25cc" : "\u25ef"; // cancelling / running
  const suffix = cancelling ? " (cancelling)" : "";
  const elapsed = theme.fg("dim", formatElapsed(now - job.startedAt));

  const agent = theme.fg("accent", job.task.agent);
  const activity = theme.fg("dim", activityWord(job.progress));
  const preview = truncate(firstLine(job.task.task), WIDGET_PREVIEW_WIDTH);
  return `${marker} ${job.id} ${agent} ${activity} ${preview}  ${elapsed}${suffix}`;
}

// Persistent-widget content: one line per still-running job, or `undefined`
// when nothing is running (the caller clears the widget in that case instead
// of showing an empty panel).
export function buildJobsWidgetLines(
  jobs: readonly JobSnapshot[],
  now: number,
  theme: ProgressTheme,
): string[] | undefined {
  const active = jobs.filter((j) => isActive(j.state));
  const lines = active
    .map((job) => unfinishedTaskLine(job, now, theme))
    .filter((line): line is string => line !== undefined);
  if (lines.length === 0) return undefined;
  return [...lines, theme.fg("dim", "  /subagents \u00b7 /subagents peek|status|cancel <id> \u00b7 clear")];
}

// Shared not-found wording for both /subagents cancel and /subagents status.
export function jobNotFoundText(id: string): string {
  return `No job with id "${id}" in this session.`;
}

// Shared empty-registry wording for the /subagents list view and the bare
// /subagents peek fallback (nothing to open a window on).
export const NO_JOBS_TEXT = "No background subagent jobs in this session.";

// One settled-task outcome line (agent — success|FAILED · usage), shared by
// the list/status views and the peek window's frozen result line.
export function buildFinishedTaskLine(result: AgentRunResult, theme: ProgressTheme): string {
  const label = result.status === "error" ? "FAILED" : "success";
  const footerText = result.usage ? formatRunUsage(result.usage) : "";
  const footer = footerText ? ` \u00b7 ${theme.fg("dim", footerText)}` : "";
  return `  ${theme.fg("accent", result.agent)} \u2014 ${label}${footer}`;
}

function buildJobListEntry(job: JobSnapshot, now: number, theme: ProgressTheme): string {
  const state = job.state;
  const settledAt = "settledAt" in state ? state.settledAt : now;
  const elapsed = formatElapsed(settledAt - job.startedAt);
  const header = `${job.id} ${state.status} \u00b7 ${elapsed}`;

  switch (state.status) {
    case "running":
    case "cancelling":
      return [header, buildProgressLine(job.progress, theme)].join("\n");
    case "errored":
      // Infrastructure crash: no run result exists, only the exception message.
      return [header, `  ${state.error}`].join("\n");
    case "failed":
    case "completed":
    case "cancelled":
      return [header, buildFinishedTaskLine(state.result, theme)].join("\n");
  }
}

// Full status listing for the `/subagents` command. Takes jobs in whatever
// order the caller wants shown (the registry's `list()` is already
// newest-first); this function does not re-sort.
export function buildJobListText(jobs: readonly JobSnapshot[], now: number, theme: ProgressTheme): string {
  if (jobs.length === 0) return NO_JOBS_TEXT;
  return jobs.map((job) => buildJobListEntry(job, now, theme)).join("\n");
}

export type SubagentsCommand =
  | { readonly kind: "list" }
  | { readonly kind: "cancel"; readonly id?: string }
  | { readonly kind: "status"; readonly id?: string }
  | { readonly kind: "peek"; readonly id?: string }
  | { readonly kind: "clear" }
  | { readonly kind: "usage-error"; readonly message: string };

export function parseSubagentsCommand(args: string): SubagentsCommand {
  const trimmed = args.trim();
  if (trimmed === "") return { kind: "list" };

  const [sub, ...rest] = trimmed.split(/\s+/);
  if (sub === "cancel") {
    // Bare cancel auto-resolves its target (active jobs only).
    const id = rest[0];
    return id ? { kind: "cancel", id } : { kind: "cancel" };
  }
  if (sub === "status") {
    // Bare status auto-resolves its target (active first, newest settled fallback).
    const id = rest[0];
    return id ? { kind: "status", id } : { kind: "status" };
  }
  if (sub === "peek") {
    // Extra args ignored, same rule as status/cancel: first token is the id.
    const id = rest[0];
    return id ? { kind: "peek", id } : { kind: "peek" };
  }
  if (sub === "clear") return { kind: "clear" };
  return { kind: "usage-error", message: `Unknown /subagents subcommand "${sub}". Usage: /subagents [status|peek|cancel] <id> [|clear]` };
}

// Shared ambiguous-target wording for the bare /subagents peek, status and
// cancel fallbacks (several active jobs — the user must pick an id).
export function ambiguousJobsText(ids: readonly string[]): string {
  return `Several jobs running \u2014 specify an id: ${ids.join(", ")}`;
}

// Picks the default target for a bare `/subagents peek|status` (no id):
// exactly one active job wins, several actives are ambiguous (ids in the
// caller's order — newest-first when the caller passes jobs.list()), and
// with no active jobs the newest settled one (jobs[0], list() is
// newest-first) is shown.
export type PeekTarget =
  | { readonly kind: "job"; readonly job: JobSnapshot }
  | { readonly kind: "ambiguous"; readonly ids: readonly string[] }
  | { readonly kind: "none" };

export function resolveAutoTarget(jobs: readonly JobSnapshot[]): PeekTarget {
  const active = jobs.filter((j) => isActive(j.state));
  if (active.length === 1) return { kind: "job", job: active[0] };
  if (active.length > 1) return { kind: "ambiguous", ids: active.map((j) => j.id) };
  if (jobs.length > 0) return { kind: "job", job: jobs[0] };
  return { kind: "none" };
}

// Picks the default target for a bare `/subagents cancel` (no id): only
// ACTIVE jobs are candidates (a settled job is nothing to cancel). Same union
// and shape as resolveAutoTarget, but with no active jobs the result is
// always none — no settled fallback.
export function resolveActiveTarget(jobs: readonly JobSnapshot[]): PeekTarget {
  const active = jobs.filter((j) => isActive(j.state));
  if (active.length === 1) return { kind: "job", job: active[0] };
  if (active.length > 1) return { kind: "ambiguous", ids: active.map((j) => j.id) };
  return { kind: "none" };
}

export function describeClearResult(removed: number): string {
  return removed > 0
    ? `Cleared ${removed} finished job${removed === 1 ? "" : "s"}.`
    : "No finished jobs to clear.";
}

// How much of a running job's tool history `/subagents status <id>` shows
// before eliding the older entries.
const STATUS_HISTORY_CAP = 10;

// Detailed single-job view for `/subagents status <id>`. Settled jobs reuse
// buildJobListEntry verbatim (header + result/error + usage footer) — that
// view already says everything a settled job can say. Running jobs get the
// live extras the list view doesn't show: the current activity word, the last
// tool call summary, the (capped) tool history, and usage so far.
export function buildJobStatusText(job: JobSnapshot, now: number, theme: ProgressTheme): string {
  if (!isActive(job.state)) return buildJobListEntry(job, now, theme);

  const lines = [
    `${job.id} ${job.state.status} \u00b7 ${formatElapsed(now - job.startedAt)}`,
    `  ${theme.fg("accent", job.task.agent)} ${theme.fg("dim", `\u00b7 activity: ${activityWord(job.progress)}`)}`,
  ];
  const history = job.progress.history;
  if (history.length > 0) {
    lines.push(`  tool: ${history[history.length - 1]}`);
    const shown = history.slice(-STATUS_HISTORY_CAP);
    const elided = history.length > STATUS_HISTORY_CAP ? `\u2026 (+${history.length - STATUS_HISTORY_CAP} earlier) \u00b7 ` : "";
    lines.push(`  tools (${history.length}): ${elided}${shown.join(" \u00b7 ")}`);
  }
  if (job.progress.usage) {
    lines.push(`  usage: ${formatRunUsage(job.progress.usage)}`);
  }
  return lines.join("\n");
}

export function describeCancelResult(result: CancelResult): { text: string; level: "info" | "warning" } {
  switch (result.kind) {
    case "cancelling":
      return { text: `Cancelling job ${result.job.id}\u2026`, level: "info" };
    case "not-running":
      return {
        text: `Job ${result.job.id} is already ${result.job.state.status} \u2014 nothing to cancel.`,
        level: "warning",
      };
    case "not-found":
      return { text: jobNotFoundText(result.id), level: "warning" };
  }
}
