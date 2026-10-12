import { buildProgressLine, activityWord, type ProgressTheme } from "./progress.ts";
import { firstLine, truncate } from "./text-utils.ts";
import { formatRunUsage, formatTokens } from "./usage.ts";
import type { AgentRunResult } from "./run.ts";
import { isActive, type CancelResult, type JobSnapshot } from "./background-jobs.ts";
import { RECONCILED_RUN_STATUSES, type ReconciledRunStatus, type SubagentSessionReport } from "./session-reconcile.ts";

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
  | { readonly kind: "session" }
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
  if (sub === "session") {
    // session takes no arguments (v1: no --runs, no filters) — anything extra
    // is a usage error rather than a silently ignored suffix.
    if (rest.length > 0) return { kind: "usage-error", message: "Usage: /subagents session" };
    return { kind: "session" };
  }
  return { kind: "usage-error", message: `Unknown /subagents subcommand "${sub}". Usage: /subagents [status|peek|cancel] [id] [|clear|session]` };
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

// --- /subagents session ---

// The per-agent rows render exactly like the totals' cost rows; the optional
// bold emphasis mirrors pi's section headers (theme.bold on the real TUI
// theme; ProgressTheme keeps it optional so plain-text fakes still work).
function buildSubagentSessionSections(report: SubagentSessionReport, theme: ProgressTheme): string {
  const bold = theme.bold ? (text: string) => theme.bold!(text) : (text: string) => text;
  const dim = (text: string) => theme.fg("dim", text);
  // Locale pinned so report text is byte-identical across machines (bare
  // toLocaleString() follows the host locale: some render a narrow space).
  const counter = (n: number) => n.toLocaleString("en-US");

  const lines: string[] = [];
  lines.push(bold("Subagent Session Report"));
  lines.push("");

  const countsText = RECONCILED_RUN_STATUSES.map((status) => `${status} ${counter(report.counts[status])}`).join(", ");
  lines.push(`${dim("Runs:")} ${counter(report.runs.length)} (${countsText})`);
  const turns = report.runs.reduce((sum, run) => sum + (run.stats?.turns ?? 0), 0);
  lines.push(`${dim("Turns:")} ${counter(turns)}`);

  lines.push("");
  lines.push(bold("Subagent Totals"));
  lines.push(dim("Tokens:"));
  const { input, cacheRead, cacheWrite } = report.totals;
  // "Input" is the full prompt volume. With cache activity, split it into
  // cached (served from cache) vs uncached (everything else) — the only
  // provider-independent split. Cache writes, where reported, are a detail
  // of the uncached portion. (pi's own split rule, verbatim.)
  const promptTokens = input + cacheRead + cacheWrite;
  lines.push(`  ${dim("Input:")} ${counter(promptTokens)}`);
  if (promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)) {
    const hitRate = dim(`(${((cacheRead / promptTokens) * 100).toFixed(1)}%)`);
    lines.push(`    ${dim("Cached:")} ${counter(cacheRead)} ${hitRate}`);
    const written = cacheWrite > 0 ? ` ${dim(`(${counter(cacheWrite)} written to cache)`)}` : "";
    lines.push(`    ${dim("Uncached:")} ${counter(input + cacheWrite)}${written}`);
  }
  lines.push(`  ${dim("Output:")} ${counter(report.totals.output)}`);
  lines.push(`  ${dim("Total:")} ${counter(promptTokens + report.totals.output)}`);

  if (report.totals.cost > 0 || report.cacheWaste.missedTokens > 0) {
    lines.push(dim("Cost:"));
    lines.push(`  ${dim("Total:")} $${report.totals.cost.toFixed(3)}`);
    // Per-key rows only when there is more than one bucket — a single bucket
    // just repeats the Total above (pi's rule).
    if (report.breakdown.length > 1) {
      for (const row of report.breakdown) {
        lines.push(`  ${dim(`${row.key}:`)} $${row.cost.toFixed(3)} ${dim(`(${formatTokens(row.tokens)} tokens)`)}`);
      }
    }
    if (report.cacheWaste.missedTokens > 0) {
      const missLabel = report.cacheWaste.missCount === 1 ? "1 miss" : `${report.cacheWaste.missCount} misses`;
      const detail = `${counter(report.cacheWaste.missedTokens)} tokens, ${missLabel}`;
      lines.push(
        report.cacheWaste.missedCost >= 0.0001
          ? `${dim("Cache Re-billed:")} $${report.cacheWaste.missedCost.toFixed(3)} ${dim(`(${detail})`)}`
          : `${dim("Cache Re-billed:")} ${detail}`,
      );
    }
  }

  if (report.byAgent.length > 0) {
    lines.push("");
    lines.push(bold("By Agent"));
    for (const row of report.byAgent) {
      const orphanSuffix = row.orphaned ? dim(" (orphaned)") : "";
      lines.push(
        `  ${row.agent}: ${counter(row.runs)} ${row.runs === 1 ? "run" : "runs"}, ${formatTokens(row.tokens)} tokens, $${row.cost.toFixed(3)}${orphanSuffix}`,
      );
    }
  }
  return lines.join("\n");
}

// Full /subagents session view: aggregate totals plus a per-agent breakdown,
// mirroring pi's /session layout (bold section headers, dim labels) but
// scoped to the session's subagent runs.
export function buildSubagentSessionText(report: SubagentSessionReport, theme: ProgressTheme): string {
  if (report.runs.length === 0) return "No subagent runs recorded for this session.";
  return buildSubagentSessionSections(report, theme);
}
