import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatElapsed,
  buildJobsWidgetLines,
  buildJobListText,
  parseSubagentsCommand,
  describeCancelResult,
  describeClearResult,
} from "../../src/job-view.ts";
import type { JobSnapshot, SettledJob } from "../../src/background-jobs.ts";
import type { ProgressTheme } from "../../src/progress.ts";
import type { AgentRunResult } from "../../src/run.ts";

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

test("buildJobListText: a failed job shows its error", () => {
  const job: SettledJob = { ...runningJob(), state: { status: "failed", settledAt: 4_000, error: "boom" } };
  const text = buildJobListText([job], 9_000, theme);
  assert.match(text, /failed/);
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
test("parseSubagentsCommand: 'cancel' with no id is a usage error", () => {
  const result = parseSubagentsCommand("cancel");
  assert.equal(result.kind, "usage-error");
});
test("parseSubagentsCommand: unknown subcommand is a usage error", () => {
  const result = parseSubagentsCommand("foo");
  assert.equal(result.kind, "usage-error");
});
test("parseSubagentsCommand: 'clear' is a clear command", () => {
  assert.deepEqual(parseSubagentsCommand("clear"), { kind: "clear" });
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
