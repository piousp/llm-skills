import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatElapsed,
  buildJobsWidgetLines,
  buildJobListText,
  buildJobStatusText,
  buildSubagentSessionText,
  jobNotFoundText,
  parseSubagentsCommand,
  resolveAutoTarget,
  resolveActiveTarget,
  describeCancelResult,
  describeClearResult,
} from "../../src/job-view.ts";
import type { JobSnapshot, SettledJob } from "../../src/background-jobs.ts";
import type { ProgressTheme } from "../../src/progress.ts";
import type { AgentRunResult } from "../../src/run.ts";
import type { ReconciledRun, SubagentSessionReport } from "../../src/session-reconcile.ts";

const theme: ProgressTheme = { fg: (c, t) => `<${c}>${t}</${c}>` };

function progressOf(agent: string, done: boolean) {
  return { agent, runningTools: [], history: [], done };
}

const sampleResult: AgentRunResult = { agent: "scout", task: "a", durationMs: 1, status: "success", finalText: "done" };

function runningJob(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id: "S1003",
    runId: "call-1",
    startedAt: 1_000,
    task: { agent: "scout", task: "Find all fetch() calls in src/" },
    progress: progressOf("scout", false),
    state: { status: "running" },
    ...overrides,
  };
}

// --- formatElapsed ---

test("formatElapsed: 0ms is '0s'", () => assert.equal(formatElapsed(0), "0s"));
test("formatElapsed: 59s stays in seconds", () => assert.equal(formatElapsed(59_000), "59s"));
test("formatElapsed: 60s rolls over to minutes", () => assert.equal(formatElapsed(60_000), "1m 00s"));
test("formatElapsed: 3599s is just under an hour", () => assert.equal(formatElapsed(3_599_000), "59m 59s"));
test("formatElapsed: 3600s rolls over to hours", () => assert.equal(formatElapsed(3_600_000), "1h 00m"));

// --- buildJobsWidgetLines ---

test("buildJobsWidgetLines: undefined when there are no jobs", () => {
  assert.equal(buildJobsWidgetLines([], 2_000, theme), undefined);
});

test("buildJobsWidgetLines: undefined when every job is finished", () => {
  const job: SettledJob = { ...runningJob(), state: { status: "completed", settledAt: 2_000, result: sampleResult } };
  assert.equal(buildJobsWidgetLines([job], 3_000, theme), undefined);
});

test("buildJobsWidgetLines: an active job whose task is already marked done yields no widget line", () => {
  const job = runningJob({ progress: progressOf("scout", true) });
  assert.equal(buildJobsWidgetLines([job], 2_000, theme), undefined);
});

test("buildJobsWidgetLines: cancelling jobs get a distinct marker and suffix", () => {
  const job = runningJob({ state: { status: "cancelling", reason: "user" } });
  const lines = buildJobsWidgetLines([job], 2_000, theme)!;
  assert.match(lines[0], /\(cancelling\)/);
  assert.match(lines[0], /^\u25cc/);
});

test("buildJobsWidgetLines: running jobs use the running marker, elapsed derives from now - startedAt", () => {
  const job = runningJob({ startedAt: 1_000 });
  const lines = buildJobsWidgetLines([job], 13_000, theme)!;
  assert.match(lines[0], /^\u25ef/);
  assert.match(lines[0], /12s/);
});

test("buildJobsWidgetLines: long task text is truncated, theme wrapping is applied to the agent name", () => {
  const longTask = "x".repeat(200);
  const job = runningJob({ task: { agent: "scout", task: longTask } });
  const lines = buildJobsWidgetLines([job], 2_000, theme)!;
  assert.match(lines[0], /<accent>scout<\/accent>/);
  assert.ok(lines[0].includes("\u2026"));
  assert.ok(!lines[0].includes("x".repeat(200)));
});

test("buildJobsWidgetLines: appends a dim hint footer line", () => {
  const job = runningJob();
  const lines = buildJobsWidgetLines([job], 2_000, theme)!;
  assert.match(lines.at(-1)!, /\/subagents/);
});

// --- buildJobListText ---

test("buildJobListText: empty jobs list renders a friendly message", () => {
  assert.equal(buildJobListText([], 2_000, theme), "No background subagent jobs in this session.");
});

test("buildJobListText: a running job shows its header and reuses buildProgressLine for the body", () => {
  const job = runningJob();
  const text = buildJobListText([job], 2_000, theme);
  assert.match(text, /S1003/);
  assert.match(text, /running/);
  assert.match(text, /<accent>scout<\/accent>/); // from buildProgressLine
});

test("buildJobListText: a completed job shows its status and usage footer", () => {
  const result: AgentRunResult = {
    agent: "scout", task: "a", durationMs: 1, status: "success", finalText: "done",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, isSubscription: false, context: undefined },
  };
  const job: SettledJob = { ...runningJob(), state: { status: "completed", settledAt: 4_000, result } };
  const text = buildJobListText([job], 9_000, theme);
  assert.match(text, /completed/);
  assert.match(text, /scout/);
  assert.match(text, /success/);
  assert.match(text, /\$0\.01/); // formatRunUsage cost footer
});

test("buildJobListText: a failed job shows the FAILED run label", () => {
  const job: SettledJob = {
    ...runningJob(),
    state: { status: "failed", settledAt: 4_000, result: { agent: "scout", task: "s", durationMs: 1, status: "error", error: "boom" } },
  };
  const text = buildJobListText([job], 9_000, theme);
  assert.match(text, /failed/);
  assert.match(text, /FAILED/);
});

test("buildJobListText: an errored job shows its error", () => {
  const job: SettledJob = { ...runningJob(), state: { status: "errored", settledAt: 4_000, error: "boom" } };
  const text = buildJobListText([job], 9_000, theme);
  assert.match(text, /errored/);
  assert.match(text, /boom/);
});

test("buildJobListText: preserves the order of the given jobs array (caller decides ordering)", () => {
  const jobA: SettledJob = { ...runningJob({ id: "S1001" }), state: { status: "completed", settledAt: 2_000, result: sampleResult } };
  const jobB: SettledJob = { ...runningJob({ id: "S1002" }), state: { status: "completed", settledAt: 3_000, result: sampleResult } };
  const text = buildJobListText([jobB, jobA], 5_000, theme);
  assert.ok(text.indexOf("S1002") < text.indexOf("S1001"));
});

// --- parseSubagentsCommand ---

test("parseSubagentsCommand: empty string is list", () => {
  assert.deepEqual(parseSubagentsCommand(""), { kind: "list" });
});
test("parseSubagentsCommand: whitespace-only is list", () => {
  assert.deepEqual(parseSubagentsCommand("   "), { kind: "list" });
});
test("parseSubagentsCommand: 'cancel <id>' is a cancel command", () => {
  assert.deepEqual(parseSubagentsCommand("cancel S1002"), { kind: "cancel", id: "S1002" });
});
test("parseSubagentsCommand: bare 'cancel' auto-resolves its target", () => {
  assert.deepEqual(parseSubagentsCommand("cancel"), { kind: "cancel" });
});
test("parseSubagentsCommand: 'status <id>' is a status command", () => {
  assert.deepEqual(parseSubagentsCommand("status S1001"), { kind: "status", id: "S1001" });
});
test("parseSubagentsCommand: bare 'status' auto-resolves its target", () => {
  assert.deepEqual(parseSubagentsCommand("status"), { kind: "status" });
});
test("parseSubagentsCommand: 'status <id> extra' takes the first token as the id (same rule as cancel)", () => {
  assert.deepEqual(parseSubagentsCommand("status S1001 extra words"), { kind: "status", id: "S1001" });
});
test("parseSubagentsCommand: unknown subcommand lists status in the usage hint", () => {
  const result = parseSubagentsCommand("foo");
  if (result.kind === "usage-error") {
    assert.match(result.message, /status\|peek\|cancel/);
    assert.match(result.message, /\|clear/);
  }
});
test("parseSubagentsCommand: unknown subcommand is a usage error", () => {
  const result = parseSubagentsCommand("foo");
  assert.equal(result.kind, "usage-error");
});
test("parseSubagentsCommand: 'clear' is a clear command", () => {
  assert.deepEqual(parseSubagentsCommand("clear"), { kind: "clear" });
});

// --- parseSubagentsCommand: peek ---

test("parseSubagentsCommand: bare 'peek' targets nothing yet", () => {
  assert.deepEqual(parseSubagentsCommand("peek"), { kind: "peek" });
});
test("parseSubagentsCommand: 'peek S1002' targets that id", () => {
  assert.deepEqual(parseSubagentsCommand("peek S1002"), { kind: "peek", id: "S1002" });
});
test("parseSubagentsCommand: 'peek S1002 extra' takes the first token as the id (same rule as status/cancel)", () => {
  assert.deepEqual(parseSubagentsCommand("peek S1002 extra words"), { kind: "peek", id: "S1002" });
});

// --- resolveAutoTarget ---

test("resolveAutoTarget: exactly one active job wins", () => {
  const job = runningJob({ id: "S1001" });
  assert.deepEqual(resolveAutoTarget([job]), { kind: "job", job });
});
test("resolveAutoTarget: several active jobs are ambiguous, ids newest-first (caller's list order)", () => {
  const a = runningJob({ id: "S1002" });
  const b = runningJob({ id: "S1003" });
  const c = runningJob({ id: "S1004" });
  const result = resolveAutoTarget([c, b, a]);
  assert.deepEqual(result, { kind: "ambiguous", ids: ["S1004", "S1003", "S1002"] });
});
test("resolveAutoTarget: no active jobs -> the newest settled one (jobs[0])", () => {
  const older: SettledJob = { ...runningJob({ id: "S1001" }), state: { status: "completed", settledAt: 2_000, result: sampleResult } };
  const newer: SettledJob = { ...runningJob({ id: "S1002" }), state: { status: "completed", settledAt: 3_000, result: sampleResult } };
  assert.deepEqual(resolveAutoTarget([newer, older]), { kind: "job", job: newer });
});
test("resolveAutoTarget: an empty list is none", () => {
  assert.deepEqual(resolveAutoTarget([]), { kind: "none" });
});
test("resolveAutoTarget: a cancelling job still counts as active", () => {
  const job = runningJob({ state: { status: "cancelling", reason: "user" } });
  assert.deepEqual(resolveAutoTarget([job]), { kind: "job", job });
});

// --- resolveActiveTarget ---

test("resolveActiveTarget: exactly one active job wins", () => {
  const job = runningJob({ id: "S1001" });
  assert.deepEqual(resolveActiveTarget([job]), { kind: "job", job });
});
test("resolveActiveTarget: several active jobs are ambiguous, ids newest-first (caller's list order)", () => {
  const a = runningJob({ id: "S1002" });
  const b = runningJob({ id: "S1003" });
  const result = resolveActiveTarget([b, a]);
  assert.deepEqual(result, { kind: "ambiguous", ids: ["S1003", "S1002"] });
});
test("resolveActiveTarget: no active jobs -> none, even when settled jobs exist", () => {
  const settled: SettledJob = { ...runningJob({ id: "S1001" }), state: { status: "completed", settledAt: 2_000, result: sampleResult } };
  assert.deepEqual(resolveActiveTarget([settled]), { kind: "none" });
});
test("resolveActiveTarget: an empty list is none", () => {
  assert.deepEqual(resolveActiveTarget([]), { kind: "none" });
});

test("describeClearResult: some removed reports the count, singular for 1", () => {
  assert.equal(describeClearResult(1), "Cleared 1 finished job.");
  assert.equal(describeClearResult(3), "Cleared 3 finished jobs.");
});
test("describeClearResult: zero removed reports nothing to clear", () => {
  assert.equal(describeClearResult(0), "No finished jobs to clear.");
});

// --- describeCancelResult ---

test("describeCancelResult: cancelling is informational", () => {
  const job = runningJob();
  const { text, level } = describeCancelResult({ kind: "cancelling", job });
  assert.match(text, /S1003/);
  assert.equal(level, "info");
});
test("describeCancelResult: not-running is a warning naming the job's current status", () => {
  const job: JobSnapshot = { ...runningJob(), state: { status: "completed", settledAt: 2_000, result: sampleResult } };
  const { text, level } = describeCancelResult({ kind: "not-running", job });
  assert.match(text, /S1003/);
  assert.match(text, /completed/);
  assert.equal(level, "warning");
});
test("describeCancelResult: not-found is a warning naming the unknown id", () => {
  const { text, level } = describeCancelResult({ kind: "not-found", id: "S9999" });
  assert.match(text, /S9999/);
  assert.equal(level, "warning");
});
test("jobNotFoundText: single shared wording for cancel and status", () => {
  const cancelView = describeCancelResult({ kind: "not-found", id: "S9999" });
  assert.equal(jobNotFoundText("S9999"), cancelView.text);
});

// --- widget: activity word in the running line ---

function jobWithProgress(progressOverrides: Record<string, unknown> = {}, overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  const base = { agent: "scout", runningTools: [], history: [], done: false, ...progressOverrides };
  return runningJob({ progress: base, ...overrides });
}

test("buildJobsWidgetLines: a running tool shows the one-word tool name", () => {
  const job = jobWithProgress({ runningTools: [{ toolCallId: "a", toolName: "grep" }], history: ["grep /x/"] });
  const lines = buildJobsWidgetLines([job], 2_000, theme)!;
  assert.match(lines[0], /<dim>grep<\/dim>/);
  assert.doesNotMatch(lines[0], /working/);
});

test("buildJobsWidgetLines: an mcp running tool shows the short server name", () => {
  const job = jobWithProgress({ runningTools: [{ toolCallId: "a", toolName: "mcp__playwright__navigate" }], history: ["playwright/navigate url=.."] });
  const lines = buildJobsWidgetLines([job], 2_000, theme)!;
  assert.match(lines[0], /<dim>playwright<\/dim>/);
  assert.doesNotMatch(lines[0], /mcp__/);
});

test("buildJobsWidgetLines: a thinking-only run shows 'thinking', a fresh run shows 'waiting'", () => {
  const thinking = jobWithProgress({ streamPhase: "thinking" });
  assert.match(buildJobsWidgetLines([thinking], 2_000, theme)![0], /<dim>thinking<\/dim>/);
  const fresh = jobWithProgress({});
  assert.match(buildJobsWidgetLines([fresh], 2_000, theme)![0], /<dim>waiting<\/dim>/);
});

test("buildJobsWidgetLines: the hint footer mentions the status subcommand", () => {
  const job = runningJob();
  const lines = buildJobsWidgetLines([job], 2_000, theme)!;
  assert.match(lines.at(-1)!, /status\|cancel <id>/);
});

test("buildJobsWidgetLines: the hint footer mentions the unified peek|status|cancel", () => {
  const job = runningJob();
  const lines = buildJobsWidgetLines([job], 2_000, theme)!;
  assert.match(lines.at(-1)!, /peek\|status\|cancel <id>/);
});

// --- buildJobStatusText ---

const usageForStatus = { input: 13000, output: 840, cacheRead: 1_200_000, cacheWrite: 3000, cost: 0.412, isSubscription: false, context: undefined };

test("buildJobStatusText: a running job shows activity, last tool, capped history, and live usage", () => {
  const history = ["read a.ts", "grep /x/", "write b.ts"];
  const job = jobWithProgress({
    runningTools: [{ toolCallId: "b", toolName: "grep" }],
    history,
    usage: usageForStatus,
  }, { startedAt: 1_000 });
  const text = buildJobStatusText(job, 4_000, theme);

  const lines = text.split("\n");
  assert.match(lines[0], /^S1003 running \u00b7 3s$/);
  assert.match(lines[1], /scout/);
  assert.match(lines[1], /activity: grep/); // the running tool wins the word...
  assert.match(lines[2], /^  tool: write b\.ts$/); // ...but the tool line is the most recently STARTED call
  assert.match(lines[3], /^  tools \(3\): read a\.ts \u00b7 grep \/x\/ \u00b7 write b\.ts$/);
  assert.match(lines[4], /^  usage: /);
  assert.match(lines[4], /\$0\.412/);
});

test("buildJobStatusText: history beyond 10 entries elides the older ones", () => {
  const history = Array.from({ length: 12 }, (_, i) => `read f${i}.ts`);
  const job = jobWithProgress({ history, runningTools: [{ toolCallId: "z", toolName: "read" }] });
  const text = buildJobStatusText(job, 2_000, theme);
  assert.match(text, /tools \(12\): \u2026 \(\+2 earlier\) \u00b7 read f2\.ts \u00b7 .*read f11\.ts/);
  assert.doesNotMatch(text, /read f0\.ts/);
  assert.doesNotMatch(text, /read f1\.ts /);
});

test("buildJobStatusText: a fresh running job (no history, no usage) omits the tool/usage lines", () => {
  const job = jobWithProgress({});
  const text = buildJobStatusText(job, 2_000, theme);
  assert.match(text, /activity: waiting/);
  assert.doesNotMatch(text, /tool:/);
  assert.doesNotMatch(text, /usage:/);
});

test("buildJobStatusText: a cancelling job keeps its header status", () => {
  const job = jobWithProgress({ history: ["read a.ts"] }, { state: { status: "cancelling", reason: "user" } });
  const text = buildJobStatusText(job, 2_000, theme);
  assert.match(text, /^S1003 cancelling/);
});

test("buildJobStatusText: settled jobs render exactly the list entry (reuse pin)", () => {
  const settled: SettledJob = { ...runningJob(), state: { status: "completed", settledAt: 4_000, result: sampleResult } };
  assert.equal(buildJobStatusText(settled, 9_000, theme), buildJobListText([settled], 9_000, theme));
});

test("buildJobStatusText: a failed job shows the FAILED run label via the list entry", () => {
  const failed: SettledJob = {
    ...runningJob(),
    state: { status: "failed", settledAt: 4_000, result: { agent: "scout", task: "s", durationMs: 1, status: "error", error: "boom" } },
  };
  const text = buildJobStatusText(failed, 9_000, theme);
  assert.match(text, /failed/);
  assert.match(text, /FAILED/);
});

// --- parseSubagentsCommand: session ---

test("parseSubagentsCommand: 'session' with no arguments is a session command", () => {
  assert.deepEqual(parseSubagentsCommand("session"), { kind: "session" });
  assert.deepEqual(parseSubagentsCommand("  session  "), { kind: "session" });
});

test("parseSubagentsCommand: 'session' with ANY extra argument is a usage error naming the session usage string", () => {
  for (const args of ["session --runs", "session foo", "session --runs 5", "session extra words"]) {
    const result = parseSubagentsCommand(args);
    assert.deepEqual(result, { kind: "usage-error", message: "Usage: /subagents session" }, args);
  }
});

// --- buildSubagentSessionText ---

// Render tests use a passthrough theme (no markup, and no bold — the theme
// fake omits bold, which ProgressTheme allows) so the pin below is readable.
const plainTheme: ProgressTheme = { fg: (_c, t) => t };

function noWaste() {
  return { missedTokens: 0, missedCost: 0, missCount: 0 };
}

function stubRun(overrides: Partial<ReconciledRun> = {}): ReconciledRun {
  return {
    runId: "r",
    depth: 1,
    agent: "scout",
    status: "completed",
    orphaned: false,
    ...overrides,
  };
}

function sessionReport(overrides: Partial<SubagentSessionReport> = {}): SubagentSessionReport {
  return {
    runs: [
      stubRun({ runId: "r1", agent: "scout", stats: { turns: 7, userMessages: 1, toolResults: 2, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, breakdown: [], cacheWaste: noWaste() } }),
      stubRun({ runId: "r2", agent: "planner", status: "failed", stats: { turns: 3, userMessages: 1, toolResults: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, breakdown: [], cacheWaste: noWaste() } }),
    ],
    totals: { input: 900, output: 300, cacheRead: 110_000, cacheWrite: 2_000, cost: 1.234 },
    breakdown: [
      { key: "anthropic/claude-sonnet-4", cost: 1.1, tokens: 1_200_000 },
      { key: "Tools/summaries", cost: 0.01, tokens: 45_000 },
      { key: "unattributed", cost: 0.124, tokens: 120_000 },
    ],
    cacheWaste: { missedTokens: 12_345, missedCost: 0.016, missCount: 3 },
    byAgent: [
      { agent: "scout", runs: 3, tokens: 1_200_000, cost: 0.98, orphaned: false },
      { agent: "planner", runs: 2, tokens: 80_000, cost: 0.254, orphaned: false },
      { agent: "unknown", runs: 1, tokens: 2_000, cost: 0, orphaned: true },
    ],
    counts: { completed: 1, failed: 1, cancelled: 0, errored: 0, running: 0, unknown: 0 },
    ...overrides,
  };
}

test("buildSubagentSessionText: an empty report is a short no-runs message", () => {
  assert.equal(buildSubagentSessionText(sessionReport({ runs: [] }), plainTheme), "No subagent runs recorded for this session.");
});

test("buildSubagentSessionText: full report renders the /session layout, byAgent ordered, orphaned suffix", () => {
  // Hit rate: 110,000 / (900 + 110,000 + 2,000) = 97.4%. Tokens via
  // formatTokens; counters via toLocaleString.
  const expected = [
    "Subagent Session Report",
    "",
    "Runs: 2 (completed 1, failed 1, cancelled 0, errored 0, running 0, unknown 0)",
    "Turns: 10",
    "",
    "Subagent Totals",
    "Tokens:",
    "  Input: 112,900",
    "    Cached: 110,000 (97.4%)",
    "    Uncached: 2,900 (2,000 written to cache)",
    "  Output: 300",
    "  Total: 113,200",
    "Cost:",
    "  Total: $1.234",
    "  anthropic/claude-sonnet-4: $1.100 (1.2M tokens)",
    "  Tools/summaries: $0.010 (45k tokens)",
    "  unattributed: $0.124 (120k tokens)",
    "Cache Re-billed: $0.016 (12,345 tokens, 3 misses)",
    "",
    "By Agent",
    "  scout: 3 runs, 1.2M tokens, $0.980",
    "  planner: 2 runs, 80k tokens, $0.254",
    "  unknown: 1 run, 2.0k tokens, $0.000 (orphaned)",
  ].join("\n");
  assert.equal(buildSubagentSessionText(sessionReport(), plainTheme), expected);
});

test("buildSubagentSessionText: the theme's bold and dim are applied when present", () => {
  const boldTheme: ProgressTheme = { fg: (c, t) => `<${c}>${t}</${c}>`, bold: (t) => `<b>${t}</b>` };
  const text = buildSubagentSessionText(sessionReport(), boldTheme);
  assert.match(text, /^<b>Subagent Session Report<\/b>/);
  assert.match(text, /<dim>Runs:<\/dim> 2/);
  assert.match(text, /<dim>Cache Re-billed:<\/dim>/);
  assert.match(text, /<dim> \(orphaned\)<\/dim>/);
});

test("buildSubagentSessionText: the Cost section is omitted when cost is zero and nothing was re-billed", () => {
  const text = buildSubagentSessionText(sessionReport({
    totals: { input: 500, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0 },
    breakdown: [{ key: "anthropic/m", cost: 0, tokens: 500 }],
    cacheWaste: noWaste(),
    byAgent: [{ agent: "scout", runs: 2, tokens: 510, cost: 0, orphaned: false }],
  }), plainTheme);
  assert.doesNotMatch(text, /Cost:/);
  assert.doesNotMatch(text, /Cache Re-billed/);
  assert.doesNotMatch(text, /Total: \$/);
  assert.match(text, /  scout: 2 runs, 510 tokens, \$0\.000/);
});

test("buildSubagentSessionText: the cached/uncached split appears only with cache activity", () => {
  const withCache = buildSubagentSessionText(sessionReport(), plainTheme);
  assert.match(withCache, /Cached: 110,000 \(97\.4%\)/);
  assert.match(withCache, /Uncached: 2,900 \(2,000 written to cache\)/);

  const withoutCache = buildSubagentSessionText(sessionReport({
    totals: { input: 500, output: 10, cacheRead: 0, cacheWrite: 0, cost: 1.0 },
  }), plainTheme);
  assert.doesNotMatch(withoutCache, /Cached:/);
  assert.doesNotMatch(withoutCache, /Uncached:/);
  assert.match(withoutCache, /Input: 500/);
});

test("buildSubagentSessionText: per-key breakdown rows appear only with more than one bucket; unattributed only when message-only runs exist", () => {
  const singleBucket = buildSubagentSessionText(sessionReport({
    breakdown: [{ key: "anthropic/m", cost: 0.5, tokens: 1_000 }],
  }), plainTheme);
  assert.doesNotMatch(singleBucket, /anthropic\/m:/); // single bucket just repeats Total
  assert.doesNotMatch(singleBucket, /unattributed/);
});

test("buildSubagentSessionText: cache re-billed below the $0.0001 cost threshold still shows its token detail", () => {
  const text = buildSubagentSessionText(sessionReport({
    cacheWaste: { missedTokens: 2_000, missedCost: 0.00005, missCount: 1 },
  }), plainTheme);
  assert.match(text, /Cache Re-billed: 2,000 tokens, 1 miss/);
  assert.doesNotMatch(text, /Cache Re-billed: \$/);
});
