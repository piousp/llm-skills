import { buildProgressLine, activityWord, type ProgressTheme } from "./progress.ts";
import { firstLine, truncate } from "./text-utils.ts";
import { formatRunUsage, formatTokens } from "./usage.ts";
import type { AgentRunResult } from "./run.ts";
import { MAX_TIMEOUT_MS } from "./run.ts";
import { isValidMaxTurns } from "./overrides.ts";
import { runIdDirName } from "./subagent-session.ts";
import { isActive, type CancelResult, type InjectKind, type InjectResult, type JobSnapshot } from "./background-jobs.ts";
import {
  RECONCILED_RUN_STATUSES,
  type CacheWaste,
  type ReconciledRunStatus,
  type SubagentRelaunchCandidate,
  type SubagentSessionReport,
  type UsageBreakdownRow,
  type UsageTotals,
} from "./session-reconcile.ts";

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

/** "420ms", "1.2s" — per-tool durations for the peek transcript lines
 * (one decimal second above a full second; negatives clamp to 0ms). */
export function formatToolDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, ms)}ms`;
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
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
  return [...lines, theme.fg("dim", "  /subagents \u00b7 /subagents peek|status|cancel <id> \u00b7 /subagents steer|followUp <id> <msg> \u00b7 clear")];
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

// Plain-text man page for bare /subagents (and /subagents help): one line
// per subcommand with its argument shape, then the auto-resolution rules.
export function buildHelpText(): string {
  return [
    "/subagents subcommands:",
    "",
    "  /subagents                            this help",
    "  /subagents list                       list running and recently finished jobs (newest first)",
    "  /subagents status [id]                detail one job: activity, recent tool calls, usage",
    "  /subagents peek [id]                  live window over one job (w fullscreen, q/Esc close, Ctrl+O expand)",
    "  /subagents cancel [id]                stop a running job",
    "  /subagents steer <id> <message>       inject a message into a running job's live session",
    "  /subagents followUp <id> <message>    queue a message for the end of the run (it extends the run)",
    "  /subagents retry [id]                 re-dispatch a settled run as a new job",
    "  /subagents continue [id]              relaunch an interrupted run from its persisted child session",
    "  /subagents clear                      drop finished jobs from the list",
    "  /subagents session                    combined session spend: main + subagents",
    "",
    "Without an id, status/peek/cancel/steer/followUp pick the single active job on their own (several actives ask for one). retry/continue resolve their target from settled runs on disk; they only relaunch runs that failed, errored, or were interrupted (cancelled runs need an explicit id).",
  ].join("\n");
}

// Full status listing for the `/subagents list` command. Takes jobs in whatever
// order the caller wants shown (the registry's `list()` is already
// newest-first); this function does not re-sort.
export function buildJobListText(jobs: readonly JobSnapshot[], now: number, theme: ProgressTheme): string {
  if (jobs.length === 0) return NO_JOBS_TEXT;
  return jobs.map((job) => buildJobListEntry(job, now, theme)).join("\n");
}

export type SubagentsCommand =
  | { readonly kind: "list" }
  | { readonly kind: "help" }
  | { readonly kind: "cancel"; readonly id?: string }
  | { readonly kind: "status"; readonly id?: string }
  | { readonly kind: "peek"; readonly id?: string }
  | { readonly kind: "steer"; readonly id?: string; readonly message: string }
  | { readonly kind: "followUp"; readonly id?: string; readonly message: string }
  | { readonly kind: "retry"; readonly id?: string }
  | { readonly kind: "continue"; readonly id?: string }
  | { readonly kind: "clear" }
  | { readonly kind: "session" }
  | { readonly kind: "usage-error"; readonly message: string };

export function parseSubagentsCommand(args: string): SubagentsCommand {
  const trimmed = args.trim();
  // Bare /subagents is the help view; the listing lives at /subagents list.
  if (trimmed === "") return { kind: "help" };

  const [sub, ...rest] = trimmed.split(/\s+/);
  if (sub === "help") return { kind: "help" };
  if (sub === "list") {
    // list takes no arguments (same rule as session): anything extra is a
    // usage error rather than a silently ignored suffix.
    if (rest.length > 0) return { kind: "usage-error", message: "Usage: /subagents list" };
    return { kind: "list" };
  }
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
  if (sub === "retry" || sub === "continue") {
    // First token is the target id, same rule as status/cancel; extra tokens
    // are ignored. Bare retry/continue auto-resolve their target from the
    // settled relaunch candidates on disk.
    const id = rest[0];
    return id ? { kind: sub, id } : { kind: sub };
  }
  if (sub === "clear") return { kind: "clear" };
  if (sub === "steer" || sub === "followUp") {
    // Deliberately deterministic, no id-guessing: two or more remaining tokens
    // are id-then-message; a single remaining token is the message itself and
    // the target auto-resolves (active jobs only, like bare cancel). A
    // one-token message with an explicit id is therefore NOT expressible.
    // The split on /\s+/ collapses whitespace runs inside the message.
    if (rest.length === 0) {
      return { kind: "usage-error", message: `Usage: /subagents ${sub} <id>? <message>` };
    }
    if (rest.length === 1) return { kind: sub, message: rest[0] };
    return { kind: sub, id: rest[0], message: rest.slice(1).join(" ") };
  }
  if (sub === "session") {
    // session takes no arguments (v1: no --runs, no filters) — anything extra
    // is a usage error rather than a silently ignored suffix.
    if (rest.length > 0) return { kind: "usage-error", message: "Usage: /subagents session" };
    return { kind: "session" };
  }
  return { kind: "usage-error", message: `Unknown /subagents subcommand "${sub}". Usage: /subagents for help; /subagents peek|status|cancel|retry|continue [id]; /subagents steer|followUp <id> <message>; /subagents list|clear|session` };
}

// --- /subagents retry | continue ---

// Bare retry with nothing settled-and-retryable on disk: distinct from the
// not-found case (an explicit token was given and matched nothing) and from
// ambiguity (there WERE candidates, several of them).
export const NO_RETRYABLE_RUNS_TEXT = "No retryable runs found in this session.";
export const NO_CONTINUABLE_RUNS_TEXT = "No continuable runs found in this session.";

export function relaunchNotFoundText(token: string): string {
  return `No settled subagent run matching "${token}" found in this session.`;
}

export function notContinuableText(candidate: SubagentRelaunchCandidate): string {
  const job = candidate.jobId ? ` (job ${candidate.jobId})` : "";
  return `Run ${candidate.runId}${job} settled as ${candidate.status} with no persisted child session — nothing to continue from; /subagents retry re-dispatches it instead.`;
}

// One line per relaunch candidate — `runId (jobId) · agent · status · task
// preview` — the ambiguity listing for bare retry/continue; the caller shows
// the pickable ids. Task preview shares the widget's caption width.
const RELAUNCH_PREVIEW_WIDTH = 64;

export function buildRelaunchCandidatesText(
  candidates: readonly SubagentRelaunchCandidate[],
  theme: ProgressTheme,
  verb: "retryable" | "continuable",
): string {
  // Defensive: an empty pool should never reach here (the wiring answers a
  // bare relaunch with the verb's none-text before resolving). Render the
  // matching wording rather than a bare header when it does.
  if (candidates.length === 0) return verb === "continuable" ? NO_CONTINUABLE_RUNS_TEXT : NO_RETRYABLE_RUNS_TEXT;
  const lines = candidates.map((candidate) => {
    const job = candidate.jobId ? ` (${theme.fg("dim", candidate.jobId)})` : "";
    const agent = theme.fg("accent", candidate.agent);
    const status = theme.fg("dim", candidate.status);
    const task = candidate.task !== undefined ? truncate(firstLine(candidate.task), RELAUNCH_PREVIEW_WIDTH) : "";
    const taskPart = task ? ` · ${task}` : "";
    return `  ${theme.fg("accent", candidate.runId)}${job} · ${agent} · ${status}${taskPart}`;
  });
  lines.unshift(`Several ${verb} runs — specify an id:`);
  return lines.join("\n");
}

// Success output for a completed relaunch, one arm per verb — moved verbatim
// from the /subagents wiring so the wording stays pinned in one pure place.
// The agent name comes from the candidate (`resolveAgent` resolves by name,
// so the candidate's and the resolved agent's name are the same string);
// `newRunId` renders only in retry's arm (continue's wording carries the
// seed file, the runId plumbing is identical). `droppedFields` names the
// recorded parameters the relaunch dropped as out of range (the agent's own
// value applies instead); from 1.5.0 on it is always empty until that
// degrade ships, so the texts stay byte-identical.
export function buildRelaunchResultText(
  kind: RelaunchKind,
  candidate: SubagentRelaunchCandidate,
  jobId: string,
  newRunId: string,
  droppedFields: readonly ("maxTurns" | "timeoutMs")[] = [],
): string {
  const paramsRecorded = candidate.params !== undefined;
  const dropClauses = !paramsRecorded || droppedFields.length === 0
    ? ""
    : droppedFields
        .map((field) => {
          const value = paramsRecorded ? candidate.params?.[field] : undefined;
          return `the recorded ${field}${value !== undefined ? ` ${value}` : ""} is out of range`;
        })
        .join("; ") + "; the agent's own value applies";
  // Explicit id on a cancelled run: the same note both verbs show (the run
  // is not a bare-candidate — user intent, so only an explicit request
  // targets it).
  const cancelledNote = candidate.status === "cancelled"
    ? " Note: this run settled as cancelled, and it is being re-dispatched at your explicit request."
    : "";
  if (kind === "retry") {
    const paramsNote = paramsRecorded
      ? ` — re-dispatched with the original call's parameters${dropClauses ? ` (${dropClauses})` : ""}.`
      : " — the original call's parameters were not recorded; running the agent's defaults.";
    return `Retrying ${candidate.agent} as job ${jobId} (runId ${newRunId})${paramsNote}${cancelledNote}`;
  }
  const paramsNote = paramsRecorded
    ? `, then continues with the original call's parameters (same maxTurns budget: the fork restarts the turn counter at zero${dropClauses ? `; ${dropClauses}` : ""}).`
    : "; the original call's parameters were not recorded, so the agent's defaults apply.";
  return (
    `Continuing ${candidate.agent} as job ${jobId} from ${candidate.sessionFile}` +
    " — the new session branches from the interrupted one; the agent re-verifies half-done work first" +
    paramsNote +
    cancelledNote
  );
}

// A candidate `continue` can branch from: it must have left a persisted
// child session on disk. Bare continue's pool and the explicit-id guard
// both read the same predicate, so the two paths cannot drift.
export function isContinuable(candidate: SubagentRelaunchCandidate): boolean {
  return candidate.sessionFile !== undefined;
}

// Whether a relaunch already consumed this candidate's orphaned child in
// this session (the consumed-orphan set is in-memory, per session, so a
// restart clears it — and a second pi process cannot see this session's
// set at all). Only interrupted candidates are ever consumed, and only at
// the relaunch wiring's launch site, marked by the parent dir segment of
// the new run.
export function isConsumedOrphan(
  candidate: SubagentRelaunchCandidate,
  consumedSegments: ReadonlySet<string>,
): boolean {
  return candidate.status === "interrupted" && consumedSegments.has(runIdDirName(candidate.runId));
}

// Which recorded relaunch parameters are structurally well-typed but OUT OF
// RANGE — maxTurns outside the 1..100 integer window, timeoutMs non-positive,
// non-finite, or above the 2h ceiling. The relaunch-time validateSubagentParams
// pass judges types and forms only, so without this a recorded out-of-range
// value would silently degrade at run time (resolveMaxTurns/resolveTimeoutMs
// warn and fall back/clamp); the wiring drops these keys instead — the
// agent's own value applies — and says so in the output.
export type OutOfRangeRelaunchField = "maxTurns" | "timeoutMs";
export function outOfRangeRelaunchFields(
  params: { maxTurns?: number; timeoutMs?: number } | undefined,
): OutOfRangeRelaunchField[] {
  if (!params) return [];
  const dropped: OutOfRangeRelaunchField[] = [];
  if (params.maxTurns !== undefined && !isValidMaxTurns(params.maxTurns)) dropped.push("maxTurns");
  if (
    params.timeoutMs !== undefined
    && !(typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      && params.timeoutMs > 0 && params.timeoutMs <= MAX_TIMEOUT_MS)
  ) dropped.push("timeoutMs");
  return dropped;
}

// Which relaunch verb the wiring is resolving; the bare pools differ: retry
// excludes runs settled as cancelled (a cancel is user intent, not a failure
// to recover from), continue additionally requires a persisted child session
// to branch from — and, in symmetry with retry, skips runs settled as
// cancelled too. An explicit id goes around both pools: the wiring applies
// its precondition notes/warnings on top.
export type RelaunchKind = "retry" | "continue";

export type RelaunchTargetResolution =
  | { readonly kind: "candidate"; readonly candidate: SubagentRelaunchCandidate }
  | { readonly kind: "ambiguous"; readonly candidates: readonly SubagentRelaunchCandidate[] }
  | { readonly kind: "not-found"; readonly token: string }
  | { readonly kind: "none" };

/**
 * Resolution precedence: explicit token (matches a candidate's runId or
 * jobId, against the whole candidate list) > exactly one candidate > several
 * candidates (ambiguous: the id must be picked) > none.
 */
export function resolveRelaunchTarget(
  kind: RelaunchKind,
  id: string | undefined,
  candidates: readonly SubagentRelaunchCandidate[],
): RelaunchTargetResolution {
  if (id !== undefined) {
    const matches = candidates.filter(
      (candidate) => candidate.runId === id || (candidate.jobId !== undefined && candidate.jobId === id),
    );
    if (matches.length === 1) return { kind: "candidate", candidate: matches[0] };
    if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
    return { kind: "not-found", token: id };
  }
  // Bare/auto pools: retry excludes runs settled as cancelled (a cancel is
  // user intent, not a failure to recover from); continue additionally
  // requires a persisted child session to branch from — and, in symmetry
  // with retry, excludes runs settled as cancelled too. An explicit id goes
  // around both pools: the wiring applies its precondition notes/warnings
  // on top.
  const isBareRetryCandidate = (candidate: SubagentRelaunchCandidate): boolean =>
    candidate.status !== "cancelled";
  const isBareContinueCandidate = (candidate: SubagentRelaunchCandidate): boolean =>
    isContinuable(candidate) && candidate.status !== "cancelled";
  const pool = candidates.filter(kind === "continue" ? isBareContinueCandidate : isBareRetryCandidate);
  if (pool.length === 1) return { kind: "candidate", candidate: pool[0] };
  if (pool.length > 1) return { kind: "ambiguous", candidates: pool };
  return { kind: "none" };
}

// Wording for an explicit id that resolves to an orphan this session has
// already retried or continued once: the consumed-orphan set is in-memory,
// per session, so a restart clears it (and a second pi process cannot see
// this session's set at all).
export function consumedOrphanText(runId: string): string {
  return `Run ${runId} was already retried or continued in this session (its orphaned child was consumed once).`;
}

// A bare continue/retry target whose task text never reached disk: the new
// job has nothing to run. `continue` never hits this (it sends the fixed
// continuation prompt); retry needs the original task verbatim.
export function noTaskText(candidate: SubagentRelaunchCandidate): string {
  return `Run ${candidate.runId} has no recoverable task text on disk — nothing to re-dispatch.`;
}

export function agentNameNotOnDiskText(candidate: SubagentRelaunchCandidate): string {
  return `Run ${candidate.runId}'s agent name is not persisted anywhere (no launch acknowledgment, no completion message) — recovered it as "unknown", so there is no agent to continue.`;
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

// Shared core of resolveAutoTarget/resolveActiveTarget: exactly one active
// job wins, several actives are ambiguous (ids in the caller's order —
// newest-first when the caller passes jobs.list()), and no actives fall back
// to the caller's chosen PeekTarget.
function resolveTargetByActive(jobs: readonly JobSnapshot[], noActive: PeekTarget): PeekTarget {
  const active = jobs.filter((j) => isActive(j.state));
  if (active.length === 1) return { kind: "job", job: active[0] };
  if (active.length > 1) return { kind: "ambiguous", ids: active.map((j) => j.id) };
  return noActive;
}

export function resolveAutoTarget(jobs: readonly JobSnapshot[]): PeekTarget {
  return resolveTargetByActive(
    jobs,
    jobs.length > 0 ? { kind: "job", job: jobs[0] } : { kind: "none" },
  );
}

// Picks the default target for a bare `/subagents cancel` (no id): only
// ACTIVE jobs are candidates (a settled job is nothing to cancel), so the
// no-active fallback is always none.
export function resolveActiveTarget(jobs: readonly JobSnapshot[]): PeekTarget {
  return resolveTargetByActive(jobs, { kind: "none" });
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

// Verb phrasing shared by every describeInjectResult arm: what there is
// nothing of, and what the failed verb is called.
const INJECT_NOTHING_TO: Record<InjectKind, string> = {
  steer: "nothing to steer",
  followUp: "nothing to follow up on",
};

// Mirrors describeCancelResult for steer/followUp: warnings for every guard
// the registry's inject() can stop at, info for a successful injection — the
// SDK's "queued" (the model will receive it) vs "handled" (an extension
// consumed it) disposition surfaced verbatim.
export function describeInjectResult(kind: InjectKind, result: InjectResult): { text: string; level: "info" | "warning" } {
  switch (result.kind) {
    case "not-found":
      return { text: jobNotFoundText(result.id), level: "warning" };
    case "not-running":
      return {
        text: `Job ${result.job.id} is already ${result.job.state.status} \u2014 ${INJECT_NOTHING_TO[kind]}.`,
        level: "warning",
      };
    case "cancelling":
      return { text: `Job ${result.job.id} is cancelling \u2014 ${INJECT_NOTHING_TO[kind]}.`, level: "warning" };
    case "not-live":
      return {
        text: `Job ${result.job.id} is running but has no live session yet (still starting up, or already wrapping up) \u2014 ${INJECT_NOTHING_TO[kind]}.`,
        level: "warning",
      };
    case "failed":
      return {
        text: `Failed to ${kind === "steer" ? "steer" : "follow up on"} job ${result.job.id}: ${result.error}`,
        level: "warning",
      };
    case "injected":
      if (kind === "steer") {
        return {
          text: result.disposition === "queued"
            ? `Steering message queued for job ${result.job.id}.`
            : `Steering message handled for job ${result.job.id} (an extension consumed it).`,
          level: "info",
        };
      }
      return {
        text: result.disposition === "queued"
          ? `Follow-up queued for job ${result.job.id} \u2014 the job settles only after it is processed.`
          : `Follow-up handled for job ${result.job.id} (an extension consumed it).`,
        level: "info",
      };
  }
}

/**
 * The tool's one-intervention-per-job refusal: names the spent target, states
 * the rule, and routes the model to ask the user (who runs /subagents unbudgeted).
 */
export function budgetExhaustedText(
  action: "cancel" | "steer" | "followUp" | "retry" | "continue",
  jobId: string | undefined,
  runId: string,
): string {
  const id = jobId ?? runId;
  const target = jobId ? `Job ${jobId} (run ${runId})` : `Run ${runId}`;
  return `${target} was already acted on once by a tool in this session — the one-intervention-per-job limit is spent. Tell the user what you intended, and ask them to run \`/subagents ${action} ${id}\` themselves if it should happen again.`;
}

// --- /subagents session ---

// The per-agent rows render exactly like the totals' cost rows; the optional
// bold emphasis mirrors pi's section headers (theme.bold on the real TUI
// theme; ProgressTheme keeps it optional so plain-text fakes still work).
// One tokens/cost block (header + cached/uncached split + cost rows), reused
// for Main Session, Subagents, and Total so all three render identically.
function renderUsageBlock(
  totals: UsageTotals,
  breakdown: readonly UsageBreakdownRow[],
  cacheWaste: CacheWaste,
  theme: ProgressTheme,
  header: string,
): string[] {
  const bold = theme.bold ? (text: string) => theme.bold!(text) : (text: string) => text;
  const dim = (text: string) => theme.fg("dim", text);
  // Locale pinned so report text is byte-identical across machines (bare
  // toLocaleString() follows the host locale: some render a narrow space).
  const counter = (n: number) => n.toLocaleString("en-US");

  const lines: string[] = [bold(header)];
  lines.push(dim("Tokens:"));
  const { input, cacheRead, cacheWrite } = totals;
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
  lines.push(`  ${dim("Output:")} ${counter(totals.output)}`);
  lines.push(`  ${dim("Total:")} ${counter(promptTokens + totals.output)}`);

  if (totals.cost > 0 || cacheWaste.missedTokens > 0) {
    lines.push(dim("Cost:"));
    lines.push(`  ${dim("Total:")} $${totals.cost.toFixed(3)}`);
    // Per-key rows only when there is more than one bucket — a single bucket
    // just repeats the Total above (pi's rule).
    if (breakdown.length > 1) {
      for (const row of breakdown) {
        lines.push(`  ${dim(`${row.key}:`)} $${row.cost.toFixed(3)} ${dim(`(${formatTokens(row.tokens)} tokens)`)}`);
      }
    }
    if (cacheWaste.missedTokens > 0) {
      const missLabel = cacheWaste.missCount === 1 ? "1 miss" : `${cacheWaste.missCount} misses`;
      const detail = `${counter(cacheWaste.missedTokens)} tokens, ${missLabel}`;
      lines.push(
        cacheWaste.missedCost >= 0.0001
          ? `${dim("Cache Re-billed:")} $${cacheWaste.missedCost.toFixed(3)} ${dim(`(${detail})`)}`
          : `${dim("Cache Re-billed:")} ${detail}`,
      );
    }
  }
  return lines;
}

function buildSubagentSessionSections(report: SubagentSessionReport, theme: ProgressTheme): string {
  const bold = theme.bold ? (text: string) => theme.bold!(text) : (text: string) => text;
  const dim = (text: string) => theme.fg("dim", text);
  const counter = (n: number) => n.toLocaleString("en-US");

  const lines: string[] = [];
  lines.push(bold("Subagent Session Report"));
  lines.push("");

  const countsText = RECONCILED_RUN_STATUSES.map((status) => `${status} ${counter(report.counts[status])}`).join(", ");
  lines.push(`${dim("Runs:")} ${counter(report.runs.length)} (${countsText})`);
  const turns = report.runs.reduce((sum, run) => sum + (run.stats?.turns ?? 0), 0);
  lines.push(`${dim("Turns:")} ${counter(turns)}`);

  if (report.main) {
    lines.push("");
    lines.push(...renderUsageBlock(report.main.totals, report.main.breakdown, report.main.cacheWaste, theme, "Main Session"));
  }
  // With mainEntries supplied, a session that never launched a subagent
  // still shows Main and Total; the all-zero Subagents block is omitted.
  if (report.runs.length > 0) {
    lines.push("");
    lines.push(...renderUsageBlock(report.totals, report.breakdown, report.cacheWaste, theme, "Subagents"));
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

  if (report.main && report.combined && report.combinedBreakdown) {
    // TOTAL's cache waste is MAIN's plus the subagents' — CacheWaste fields
    // are plain additive counters, so no combined field exists for it.
    const totalCacheWaste: CacheWaste = {
      missedTokens: report.main.cacheWaste.missedTokens + report.cacheWaste.missedTokens,
      missedCost: report.main.cacheWaste.missedCost + report.cacheWaste.missedCost,
      missCount: report.main.cacheWaste.missCount + report.cacheWaste.missCount,
    };
    lines.push("");
    lines.push(...renderUsageBlock(report.combined, report.combinedBreakdown, totalCacheWaste, theme, "Total (Main + Subagents)"));
  }
  return lines.join("\n");
}

// Full /subagents session view, mirroring pi's /session layout (bold section
// headers, dim labels): Main Session (the parent's own spend, when its
// entries were supplied), Subagents (the reconciled child runs), and Total
// (Main + Subagents) at the end, plus the per-agent breakdown.
export function buildSubagentSessionText(report: SubagentSessionReport, theme: ProgressTheme): string {
  // The short no-runs wording only exists for reports without main: the
  // wiring always supplies the parent's entries, so a session that launched
  // zero subagents renders its (zero) Main and Total blocks instead.
  if (!report.main && report.runs.length === 0) return "No subagent runs recorded for this session.";
  return buildSubagentSessionSections(report, theme);
}

// --- subagent footer status line ---

// Running total of the session's subagent spend, updated in the job
// registry's onSettled hook (extensions/index.ts) and rendered once per
// settle into the footer status line.
export type SubagentStatusAccumulator = { runs: number } & UsageTotals;

// "sub: 3 runs, 1.2M tok, $0.980" — the one settle-per-update footer line.
// The token figure is the full volume (all four buckets); the cost segment
// drops at zero so subscription-accounted sessions show tokens only.
export function buildSubagentStatusText(acc: SubagentStatusAccumulator): string {
  const tokens = acc.input + acc.output + acc.cacheRead + acc.cacheWrite;
  const cost = acc.cost !== 0 ? `, $${acc.cost.toFixed(3)}` : "";
  return `sub: ${acc.runs} ${acc.runs === 1 ? "run" : "runs"}, ${formatTokens(tokens)} tok${cost}`;
}
