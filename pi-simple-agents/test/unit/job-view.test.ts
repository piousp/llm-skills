import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatElapsed,
  formatToolDuration,
  buildJobsWidgetLines,
  buildJobListText,
  buildHelpText,
  buildJobStatusText,
  buildSubagentSessionText,
  buildSubagentStatusText,
  type SubagentStatusAccumulator,
  jobNotFoundText,
  parseSubagentsCommand,
  resolveAutoTarget,
  resolveActiveTarget,
  describeCancelResult,
  describeInjectResult,
  describeClearResult,
  budgetExhaustedText,
  buildRelaunchCandidatesText,
  buildRelaunchResultText,
  resolveRelaunchTarget,
  relaunchNotFoundText,
  notContinuableText,
  consumedOrphanText,
  noTaskText,
  agentNameNotOnDiskText,
  isConsumedOrphan,
  isContinuable,
  outOfRangeRelaunchFields,
  NO_RETRYABLE_RUNS_TEXT,
  NO_CONTINUABLE_RUNS_TEXT,
} from "../../src/job-view.ts";
import type { JobSnapshot, SettledJob } from "../../src/background-jobs.ts";
import type { ProgressTheme } from "../../src/progress.ts";
import type { AgentRunResult } from "../../src/run.ts";
import { MAX_TIMEOUT_MS } from "../../src/run.ts";
import type { ReconciledRun, SubagentRelaunchCandidate, SubagentSessionReport } from "../../src/session-reconcile.ts";

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

// --- formatToolDuration ---

test("formatToolDuration: 420ms stays milliseconds", () => assert.equal(formatToolDuration(420), "420ms"));
test("formatToolDuration: 1234ms rolls over to one decimal second", () => assert.equal(formatToolDuration(1234), "1.2s"));
test("formatToolDuration: 0 is '0ms'", () => assert.equal(formatToolDuration(0), "0ms"));
test("formatToolDuration: negatives clamp to '0ms'", () => assert.equal(formatToolDuration(-50), "0ms"));

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

test("buildHelpText: every subcommand appears with its argument shape", () => {
  const text = buildHelpText();
  for (const sub of ["list", "status [id]", "peek [id]", "cancel [id]", "steer <id> <message>", "followUp <id> <message>", "retry [id]", "continue [id]", "clear", "session"]) {
    assert.match(text, new RegExp(sub.replace(/\[/g, "\\[").replace(/\]/g, "\\]")));
  }
});

test("buildHelpText: states the auto-resolution rules", () => {
  const text = buildHelpText();
  assert.match(text, /Without an id/);
  assert.match(text, /failed, errored, or were interrupted/);
});

// --- parseSubagentsCommand ---

test("parseSubagentsCommand: empty string is help", () => {
  assert.deepEqual(parseSubagentsCommand(""), { kind: "help" });
});
test("parseSubagentsCommand: whitespace-only is help", () => {
  assert.deepEqual(parseSubagentsCommand("   "), { kind: "help" });
});
test("parseSubagentsCommand: bare 'list' lists", () => {
  assert.deepEqual(parseSubagentsCommand("list"), { kind: "list" });
});
test("parseSubagentsCommand: 'list' takes no arguments (same rule as session)", () => {
  const result = parseSubagentsCommand("list extra");
  assert.equal(result.kind, "usage-error");
  if (result.kind === "usage-error") assert.equal(result.message, "Usage: /subagents list");
});
test("parseSubagentsCommand: bare 'help' is help", () => {
  assert.deepEqual(parseSubagentsCommand("help"), { kind: "help" });
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
    assert.match(result.message, /peek\|status\|cancel\|retry\|continue \[id\]/);
    assert.match(result.message, /list\|clear\|session/);
  }
});
test("parseSubagentsCommand: unknown subcommand is a usage error", () => {
  const result = parseSubagentsCommand("foo");
  assert.equal(result.kind, "usage-error");
});
test("parseSubagentsCommand: unknown subcommand usage hint points at bare help", () => {
  const result = parseSubagentsCommand("foo");
  if (result.kind === "usage-error") {
    assert.match(result.message, /Usage: \/subagents for help/);
  }
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

// --- parseSubagentsCommand: steer/followUp ---

// Deterministic rule (no id-guessing): two or more tokens after the verb are
// id-then-message; a single token is the message itself (auto-target).
test("parseSubagentsCommand: 'steer <id> <message>' carries both", () => {
  assert.deepEqual(parseSubagentsCommand("steer S1002 turn left"), { kind: "steer", id: "S1002", message: "turn left" });
});
test("parseSubagentsCommand: 'followUp <id> <message>' is symmetric", () => {
  assert.deepEqual(parseSubagentsCommand("followUp S1002 one more thing"), { kind: "followUp", id: "S1002", message: "one more thing" });
});
test("parseSubagentsCommand: a single token after the verb is the message, auto-target resolves", () => {
  assert.deepEqual(parseSubagentsCommand("steer hurry"), { kind: "steer", message: "hurry" });
  assert.deepEqual(parseSubagentsCommand("followUp again"), { kind: "followUp", message: "again" });
});
test("parseSubagentsCommand: bare 'steer'/'followUp' with no message is a usage error", () => {
  assert.deepEqual(parseSubagentsCommand("steer"), { kind: "usage-error", message: "Usage: /subagents steer <id>? <message>" });
  assert.deepEqual(parseSubagentsCommand("followUp"), { kind: "usage-error", message: "Usage: /subagents followUp <id>? <message>" });
});
test("parseSubagentsCommand: whitespace runs collapse in the steer message", () => {
  assert.deepEqual(
    parseSubagentsCommand("  steer   S1001   lots   of   inner   spaces  "),
    { kind: "steer", id: "S1001", message: "lots of inner spaces" },
  );
});
test("parseSubagentsCommand: unknown subcommand usage hint mentions steer|followUp", () => {
  const result = parseSubagentsCommand("foo");
  if (result.kind === "usage-error") {
    assert.match(result.message, /steer\|followUp/);
  }
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

// --- describeInjectResult ---

test("describeInjectResult: not-found reuses the shared jobNotFoundText as a warning, for both verbs", () => {
  for (const kind of ["steer", "followUp"] as const) {
    const { text, level } = describeInjectResult(kind, { kind: "not-found", id: "S9999" });
    assert.equal(text, jobNotFoundText("S9999"));
    assert.equal(level, "warning");
  }
});
test("describeInjectResult: not-running names the settled status with verb-appropriate wording", () => {
  const job: JobSnapshot = { ...runningJob(), state: { status: "completed", settledAt: 2_000, result: sampleResult } };
  const steerView = describeInjectResult("steer", { kind: "not-running", job });
  assert.equal(steerView.text, "Job S1003 is already completed \u2014 nothing to steer.");
  assert.equal(steerView.level, "warning");
  const followUpView = describeInjectResult("followUp", { kind: "not-running", job });
  assert.equal(followUpView.text, "Job S1003 is already completed \u2014 nothing to follow up on.");
  assert.equal(followUpView.level, "warning");
});
test("describeInjectResult: cancelling mirrors cancel's wording shape, for both verbs", () => {
  const job = runningJob({ state: { status: "cancelling", reason: "user" } });
  const steerView = describeInjectResult("steer", { kind: "cancelling", job });
  assert.equal(steerView.text, "Job S1003 is cancelling \u2014 nothing to steer.");
  assert.equal(steerView.level, "warning");
  const followUpView = describeInjectResult("followUp", { kind: "cancelling", job });
  assert.equal(followUpView.text, "Job S1003 is cancelling \u2014 nothing to follow up on.");
  assert.equal(followUpView.level, "warning");
});
test("describeInjectResult: not-live explains the liveness window, for both verbs", () => {
  const job = runningJob();
  const steerView = describeInjectResult("steer", { kind: "not-live", job });
  assert.equal(
    steerView.text,
    "Job S1003 is running but has no live session yet (still starting up, or already wrapping up) \u2014 nothing to steer.",
  );
  assert.equal(steerView.level, "warning");
  const followUpView = describeInjectResult("followUp", { kind: "not-live", job });
  assert.equal(
    followUpView.text,
    "Job S1003 is running but has no live session yet (still starting up, or already wrapping up) \u2014 nothing to follow up on.",
  );
  assert.equal(followUpView.level, "warning");
});
test("describeInjectResult: failed names the verb and the error, for both verbs", () => {
  const job = runningJob();
  const steerView = describeInjectResult("steer", { kind: "failed", job, error: "boom" });
  assert.equal(steerView.text, "Failed to steer job S1003: boom");
  assert.equal(steerView.level, "warning");
  const followUpView = describeInjectResult("followUp", { kind: "failed", job, error: "boom" });
  assert.equal(followUpView.text, "Failed to follow up on job S1003: boom");
  assert.equal(followUpView.level, "warning");
});
test("describeInjectResult: injected surfaces the SDK disposition verbatim per verb", () => {
  const job = runningJob();
  assert.deepEqual(
    describeInjectResult("steer", { kind: "injected", job, disposition: "queued" }),
    { text: "Steering message queued for job S1003.", level: "info" },
  );
  assert.deepEqual(
    describeInjectResult("steer", { kind: "injected", job, disposition: "handled" }),
    { text: "Steering message handled for job S1003 (an extension consumed it).", level: "info" },
  );
  assert.deepEqual(
    describeInjectResult("followUp", { kind: "injected", job, disposition: "queued" }),
    { text: "Follow-up queued for job S1003 \u2014 the job settles only after it is processed.", level: "info" },
  );
  assert.deepEqual(
    describeInjectResult("followUp", { kind: "injected", job, disposition: "handled" }),
    { text: "Follow-up handled for job S1003 (an extension consumed it).", level: "info" },
  );
});

// --- budgetExhaustedText ---

// The tool path's one-intervention-per-job refusal: it must name the spent
// target precisely and hand the model the exact command to relay to the user
// (who runs /subagents without a budget).
test("budgetExhaustedText: with a jobId names both ids and routes the user to /subagents <action> <jobId>", () => {
  const text = budgetExhaustedText("cancel", "S1003", "call-1");
  assert.match(text, /Job S1003 \(run call-1\)/);
  assert.match(text, /one-intervention-per-job limit is spent/);
  assert.match(text, /`\/subagents cancel S1003`/);
});
test("budgetExhaustedText: without a jobId names the run id and routes the user to /subagents <action> <runId>", () => {
  const text = budgetExhaustedText("steer", undefined, "retry-call-1-1");
  assert.match(text, /^Run retry-call-1-1 was already acted on once/);
  assert.match(text, /`\/subagents steer retry-call-1-1`/);
  assert.doesNotMatch(text, /Job undefined/);
});
test("budgetExhaustedText: each of the five interventions renders its own command", () => {
  for (const action of ["cancel", "steer", "followUp", "retry", "continue"] as const) {
    const text = budgetExhaustedText(action, "S1003", "call-1");
    assert.match(text, new RegExp(`\`/subagents ${action} S1003\``));
  }
  // Every one of them is a distinct text (the action is not shared wording).
  const texts = (["cancel", "steer", "followUp", "retry", "continue"] as const).map((action) =>
    budgetExhaustedText(action, "S1003", "call-1"),
  );
  assert.equal(new Set(texts).size, texts.length);
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

test("buildJobsWidgetLines: the hint footer mentions steer|followUp with its message argument", () => {
  const job = runningJob();
  const lines = buildJobsWidgetLines([job], 2_000, theme)!;
  assert.match(lines.at(-1)!, /steer\|followUp <id> <msg>/);
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
    "Subagents",
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

// --- buildSubagentSessionText: the Main + Total blocks ---

// A synthetic main/combined/combinedBreakdown on top of the shared fixture:
// round numbers so the pinned snapshot is exact.
const mainStats = {
  turns: 4,
  userMessages: 1,
  toolResults: 3,
  totals: { input: 500, output: 100, cacheRead: 4_000, cacheWrite: 500, cost: 0.2 },
  breakdown: [
    { key: "anthropic/main-model", cost: 0.15, tokens: 3_500 },
    { key: "Tools/summaries", cost: 0.05, tokens: 1_000 },
  ],
  cacheWaste: { missedTokens: 1_000, missedCost: 0.005, missCount: 1 },
};

function reportWithMain(): SubagentSessionReport {
  return sessionReport({
    main: mainStats,
    combined: {
      input: 500 + 900,
      output: 100 + 300,
      cacheRead: 4_000 + 110_000,
      cacheWrite: 500 + 2_000,
      cost: 0.2 + 1.234,
    },
    combinedBreakdown: [
      { key: "anthropic/claude-sonnet-4", cost: 1.1, tokens: 1_200_000 },
      { key: "anthropic/main-model", cost: 0.15, tokens: 3_500 },
      { key: "unattributed", cost: 0.124, tokens: 120_000 },
      { key: "Tools/summaries", cost: 0.06, tokens: 55_000 },
    ],
  });
}

test("buildSubagentSessionText: with main entries the report renders Main, Subagents, and Total blocks", () => {
  // Main hit rate: 4,000 / 5,000 = 80.0%. Combined: 114,000 / 117,900 = 96.7%,
  // cache waste = main (1,000/3 misses) + subagents (12,345/1) summed — 13,345 tokens.
  const expected = [
    "Subagent Session Report",
    "",
    "Runs: 2 (completed 1, failed 1, cancelled 0, errored 0, running 0, unknown 0)",
    "Turns: 10",
    "",
    "Main Session",
    "Tokens:",
    "  Input: 5,000",
    "    Cached: 4,000 (80.0%)",
    "    Uncached: 1,000 (500 written to cache)",
    "  Output: 100",
    "  Total: 5,100",
    "Cost:",
    "  Total: $0.200",
    "  anthropic/main-model: $0.150 (3.5k tokens)",
    "  Tools/summaries: $0.050 (1.0k tokens)",
    "Cache Re-billed: $0.005 (1,000 tokens, 1 miss)",
    "",
    "Subagents",
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
    "",
    "Total (Main + Subagents)",
    "Tokens:",
    "  Input: 117,900",
    "    Cached: 114,000 (96.7%)",
    "    Uncached: 3,900 (2,500 written to cache)",
    "  Output: 400",
    "  Total: 118,300",
    "Cost:",
    "  Total: $1.434",
    "  anthropic/claude-sonnet-4: $1.100 (1.2M tokens)",
    "  anthropic/main-model: $0.150 (3.5k tokens)",
    "  unattributed: $0.124 (120k tokens)",
    "  Tools/summaries: $0.060 (55k tokens)",
    "Cache Re-billed: $0.021 (13,345 tokens, 4 misses)",
  ].join("\n");
  assert.equal(buildSubagentSessionText(reportWithMain(), plainTheme), expected);
});

test("buildSubagentSessionText: zero subagent runs with main entries still render Main and Total", () => {
  const text = buildSubagentSessionText(sessionReport({
    runs: [],
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    breakdown: [],
    cacheWaste: noWaste(),
    byAgent: [],
    main: noMainStats(),
    combined: noMainStats().totals,
    combinedBreakdown: [],
  }), plainTheme);
  assert.match(text, /Main Session/);
  assert.match(text, /Total \(Main \+ Subagents\)/);
  // Zero subagent spend: the Subagents usage block and By Agent are omitted
  // (the Total header contains the word, so the bare line is what's pinned).
  assert.doesNotMatch(text, /\nSubagents\n/);
  assert.doesNotMatch(text, /By Agent/);
  // Everything is zero: no Cost section anywhere (pi's visibility rule).
  assert.doesNotMatch(text, /Cost:/);
});

// MAIN with zero tokens and zero cost omits the Cost section — the same
// visibility rule pi's own /session applies.
test("buildSubagentSessionText: MAIN with zero cost shows no cost inside its block", () => {
  const report = reportWithMain();
  report.main = {
    ...mainStats,
    totals: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0 },
    breakdown: [],
    cacheWaste: noWaste(),
  };
  const text = buildSubagentSessionText(report, plainTheme);
  const mainBlock = text.slice(text.indexOf("Main Session"), text.indexOf("Subagents"));
  assert.doesNotMatch(mainBlock, /Cost:/);
  assert.doesNotMatch(mainBlock, /Cache Re-billed/);
  assert.match(mainBlock, /Input: 500/);
});

function noMainStats() {
  return {
    turns: 0,
    userMessages: 0,
    toolResults: 0,
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    breakdown: [],
    cacheWaste: noWaste(),
  };
}

// --- buildSubagentStatusText ---

const statusAcc = (overrides: Partial<SubagentStatusAccumulator> = {}): SubagentStatusAccumulator => ({
  runs: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  ...overrides,
});

test("buildSubagentStatusText: plural runs with millions and a cost", () => {
  assert.equal(
    buildSubagentStatusText(statusAcc({ runs: 3, input: 1_150_000, output: 50_000, cost: 0.98 })),
    "sub: 3 runs, 1.2M tok, $0.980",
  );
});

test("buildSubagentStatusText: singular run drops the cost segment at zero cost", () => {
  // formatTokens(12000) = "12k"; 0 cost (e.g. subscription) omits the $ part.
  assert.equal(buildSubagentStatusText(statusAcc({ runs: 1, input: 12_000 })), "sub: 1 run, 12k tok");
});

test("buildSubagentStatusText: tokens sum all four buckets", () => {
  // 1,000,000 input + 150,000 cacheRead + 50,000 output + 0 cacheWrite = 1.2M.
  assert.equal(
    buildSubagentStatusText(statusAcc({ runs: 2, input: 1_000_000, output: 50_000, cacheRead: 150_000, cacheWrite: 0, cost: 2.0 })),
    "sub: 2 runs, 1.2M tok, $2.000",
  );
});

// --- /subagents retry | continue: parse ---

test("parseSubagentsCommand: bare 'retry'/'continue' auto-resolve their target", () => {
  assert.deepEqual(parseSubagentsCommand("retry"), { kind: "retry" });
  assert.deepEqual(parseSubagentsCommand("continue"), { kind: "continue" });
});

test("parseSubagentsCommand: 'retry <id>'/'continue <id>' carry the id (first token)", () => {
  assert.deepEqual(parseSubagentsCommand("retry S1002"), { kind: "retry", id: "S1002" });
  assert.deepEqual(parseSubagentsCommand("continue call-abc-1"), { kind: "continue", id: "call-abc-1" });
  assert.deepEqual(parseSubagentsCommand("retry S1002 extra tokens"), { kind: "retry", id: "S1002" });
});

test("parseSubagentsCommand: unknown subcommand footer mentions retry and continue", () => {
  const result = parseSubagentsCommand("foo");
  if (result.kind === "usage-error") {
    assert.match(result.message, /status\\|peek\\|cancel/);
    assert.match(result.message, /steer\\|followUp/);
    assert.match(result.message, /retry\\|continue/);
    assert.match(result.message, /\\|clear/);
  }
});

// --- /subagents retry | continue: target resolution ---

const relaunchCandidate = (overrides: Partial<SubagentRelaunchCandidate> = {}): SubagentRelaunchCandidate => ({
  runId: "call-a",
  jobId: "S1001",
  agent: "scout",
  task: "do the thing",
  status: "failed",
  sessionFile: "/p/session/call-a/run-0/session.jsonl",
  ...overrides,
});

test("resolveRelaunchTarget: explicit token matches runId against the WHOLE candidate list", () => {
  const cancelled = relaunchCandidate({ runId: "call-c", status: "cancelled" });
  const resolved = resolveRelaunchTarget("retry", "call-c", [relaunchCandidate(), cancelled]);
  assert.deepEqual(resolved, { kind: "candidate", candidate: cancelled });
});

test("resolveRelaunchTarget: explicit token matches a jobId too", () => {
  const resolved = resolveRelaunchTarget("continue", "S1001", [relaunchCandidate()]);
  assert.deepEqual(resolved, { kind: "candidate", candidate: relaunchCandidate() });
});

test("resolveRelaunchTarget: unknown token is not-found, naming the token", () => {
  const resolved = resolveRelaunchTarget("retry", "nope", [relaunchCandidate()]);
  assert.deepEqual(resolved, { kind: "not-found", token: "nope" });
  assert.match(relaunchNotFoundText("nope"), /nope/);
});

test("resolveRelaunchTarget: bare retry excludes cancelled candidates; a single survivor wins", () => {
  const cancelled = relaunchCandidate({ runId: "call-c", status: "cancelled" });
  const failed = relaunchCandidate({ runId: "call-a", status: "failed" });
  assert.deepEqual(resolveRelaunchTarget("retry", undefined, [failed, cancelled]).kind, "candidate");
  assert.deepEqual(resolveRelaunchTarget("retry", undefined, [cancelled]), { kind: "none" });
});

test("resolveRelaunchTarget: bare continue pre-filters to sessionFile-bearing candidates only", () => {
  const dirless = relaunchCandidate({ runId: "call-d", status: "errored", sessionFile: undefined });
  const continuable = relaunchCandidate({ runId: "call-o", status: "interrupted", sessionFile: "/x/child.jsonl" });
  assert.deepEqual(resolveRelaunchTarget("continue", undefined, [dirless, continuable]).kind, "candidate");
  // explicit continue id on the dirless run RESOLVES (the wiring then warns):
  const explicit = resolveRelaunchTarget("continue", "call-d", [dirless, continuable]);
  assert.equal(explicit.kind === "candidate", true);
  if (explicit.kind === "candidate") assert.equal(explicit.candidate.runId, "call-d");
  // nothing continuable at all -> resolution none
  assert.deepEqual(resolveRelaunchTarget("continue", undefined, [dirless]), { kind: "none" });
});

test("resolveRelaunchTarget: bare continue also excludes runs settled as cancelled; an explicit id still resolves one", () => {
  // A cancelled run WITH a persisted child session: user intent, never a
  // bare-continue candidate — same rule bare retry already applies.
  const cancelledWithChild = relaunchCandidate({ runId: "call-cc", status: "cancelled" });
  assert.deepEqual(resolveRelaunchTarget("continue", undefined, [cancelledWithChild]), { kind: "none" });
  // Explicit id still resolves against the whole list; the wiring applies
  // its precondition guards on top.
  const explicit = resolveRelaunchTarget("continue", "call-cc", [cancelledWithChild]);
  if (explicit.kind === "candidate") assert.equal(explicit.candidate.runId, "call-cc");
  else throw new Error("expected candidate");
});

test("isContinuable / isConsumedOrphan: the shared relaunch candidate predicates", () => {
  const interrupted = relaunchCandidate({ runId: "call-o", status: "interrupted" });
  assert.equal(isContinuable(interrupted), true);
  const dirless = relaunchCandidate({ runId: "call-d", status: "errored", sessionFile: undefined });
  assert.equal(isContinuable(dirless), false);
  // Only interrupted candidates are ever consumed (marked by the wiring's
  // launch), and consumption matches on the candidate's parent dir segment.
  assert.equal(isConsumedOrphan(interrupted, new Set(["call-o"])), true);
  assert.equal(isConsumedOrphan(interrupted, new Set(["other"])), false);
  const failed = relaunchCandidate({ runId: "call-a", status: "failed" });
  assert.equal(isConsumedOrphan(failed, new Set(["call-a"])), false);
});

test("resolveRelaunchTarget: several bare candidates are ambiguous", () => {
  const resolved = resolveRelaunchTarget("retry", undefined, [relaunchCandidate(), relaunchCandidate({ runId: "call-b" })]);
  if (resolved.kind === "ambiguous") assert.equal(resolved.candidates.length, 2);
  else throw new Error("expected ambiguous");
  assert.deepEqual(NO_RETRYABLE_RUNS_TEXT, "No retryable runs found in this session.");
  assert.deepEqual(NO_CONTINUABLE_RUNS_TEXT, "No continuable runs found in this session.");
});

// --- /subagents retry | continue: candidate text ---

test("buildRelaunchCandidatesText: one line per candidate, the verb header, labels and the jobId parenthetical", () => {
  const text = buildRelaunchCandidatesText(
    [
      relaunchCandidate({ runId: "call-a", status: "failed" }),
      relaunchCandidate({ runId: "call-o", status: "interrupted", jobId: undefined, task: "recover me" }),
    ],
    theme,
    "retryable",
  );
  assert.match(text, /^Several retryable runs — specify an id:/);
  assert.match(text, /call-a.*S1001/);
  assert.match(text, /failed/);
  assert.match(text, /call-o(?!\()/);
  assert.match(text, /interrupted/);
  assert.match(text, /recover me/);
});

test("buildRelaunchCandidatesText: the continuable verb names its own header", () => {
  const text = buildRelaunchCandidatesText([relaunchCandidate()], theme, "continuable");
  assert.match(text, /^Several continuable runs — specify an id:/);
});

test("buildRelaunchCandidatesText: an empty list names the verb's none wording", () => {
  assert.equal(buildRelaunchCandidatesText([], theme, "retryable"), NO_RETRYABLE_RUNS_TEXT);
  assert.equal(buildRelaunchCandidatesText([], theme, "continuable"), NO_CONTINUABLE_RUNS_TEXT);
});

// --- /subagents retry | continue: relaunch success texts ---

// Byte-exact anchors: these are the notify texts the wiring sends on a
// completed relaunch (also pinned through the e2e wiring tests). Each of the
// 2 verbs × 2 params arms, plus the dropped-out-of-range renderings.

const relaunchWithParams = relaunchCandidate({ params: { model: "zprov/zmodel-rec" } });

test("buildRelaunchResultText: retry with recorded params (exact)", () => {
  assert.equal(
    buildRelaunchResultText("retry", relaunchWithParams, "S1002", "retry-call-a-1"),
    "Retrying scout as job S1002 (runId retry-call-a-1) — re-dispatched with the original call's parameters.",
  );
});

test("buildRelaunchResultText: retry legacy ack names the not-recorded fallback (exact)", () => {
  assert.equal(
    buildRelaunchResultText("retry", relaunchCandidate(), "S1002", "retry-call-a-1"),
    "Retrying scout as job S1002 (runId retry-call-a-1) — the original call's parameters were not recorded; running the agent's defaults.",
  );
});

test("buildRelaunchResultText: retry of a cancelled run carries the explicit-request note (exact)", () => {
  assert.equal(
    buildRelaunchResultText(
      "retry",
      relaunchCandidate({ status: "cancelled", params: undefined }),
      "S1002",
      "retry-call-a-1",
    ),
    "Retrying scout as job S1002 (runId retry-call-a-1) — the original call's parameters were not recorded; running the agent's defaults. Note: this run settled as cancelled, and it is being re-dispatched at your explicit request.",
  );
});

test("buildRelaunchResultText: continue with recorded params (exact; newRunId is not rendered)", () => {
  assert.equal(
    buildRelaunchResultText("continue", relaunchWithParams, "S1002", "continue-call-a-1"),
    "Continuing scout as job S1002 from /p/session/call-a/run-0/session.jsonl — the new session branches from the interrupted one; the agent re-verifies half-done work first, then continues with the original call's parameters (same maxTurns budget: the fork restarts the turn counter at zero).",
  );
});

test("buildRelaunchResultText: continue legacy ack names the not-recorded fallback (exact)", () => {
  assert.equal(
    buildRelaunchResultText("continue", relaunchCandidate(), "S1002", "continue-call-a-1"),
    "Continuing scout as job S1002 from /p/session/call-a/run-0/session.jsonl — the new session branches from the interrupted one; the agent re-verifies half-done work first; the original call's parameters were not recorded, so the agent's defaults apply.",
  );
});

test("buildRelaunchResultText: continue of a cancelled run carries the same explicit-request note (exact)", () => {
  assert.equal(
    buildRelaunchResultText(
      "continue",
      relaunchCandidate({ status: "cancelled", params: undefined }),
      "S1002",
      "continue-call-a-1",
    ),
    "Continuing scout as job S1002 from /p/session/call-a/run-0/session.jsonl — the new session branches from the interrupted one; the agent re-verifies half-done work first; the original call's parameters were not recorded, so the agent's defaults apply. Note: this run settled as cancelled, and it is being re-dispatched at your explicit request.",
  );
});

test("buildRelaunchResultText: a dropped maxTurns renders the degrade note (exact)", () => {
  const dropped = buildRelaunchResultText(
    "retry",
    relaunchCandidate({ params: { model: "zprov/zmodel-rec", maxTurns: 200, timeoutMs: 999999999 } }),
    "S1002",
    "retry-call-a-1",
    ["maxTurns"],
  );
  assert.equal(
    dropped,
    "Retrying scout as job S1002 (runId retry-call-a-1) — re-dispatched with the original call's parameters (the recorded maxTurns 200 is out of range; the agent's own value applies).",
  );
  // Both dropped fields render one clause each, in the given order.
  assert.equal(
    buildRelaunchResultText(
      "retry",
      relaunchCandidate({ params: { model: "zprov/zmodel-rec", maxTurns: 200 }, status: "failed" }),
      "S1002",
      "retry-call-a-1",
      ["maxTurns", "timeoutMs"],
    ),
    "Retrying scout as job S1002 (runId retry-call-a-1) — re-dispatched with the original call's parameters (the recorded maxTurns 200 is out of range; the recorded timeoutMs is out of range; the agent's own value applies).",
  );
});

test("buildRelaunchResultText: a dropped field lands inside the continue parens (exact)", () => {
  assert.equal(
    buildRelaunchResultText(
      "continue",
      relaunchWithParams,
      "S1002",
      "continue-call-a-1",
      ["maxTurns"],
    ),
    "Continuing scout as job S1002 from /p/session/call-a/run-0/session.jsonl — the new session branches from the interrupted one; the agent re-verifies half-done work first, then continues with the original call's parameters (same maxTurns budget: the fork restarts the turn counter at zero; the recorded maxTurns is out of range; the agent's own value applies).",
  );
});

// --- /subagents retry | continue: relaunch range degrade (the wiring's
// out-of-range drop detection, pure) ---

test("outOfRangeRelaunchFields: only maxTurns/timeoutMs outside their allowed range are named", () => {
  assert.deepEqual(outOfRangeRelaunchFields(undefined), []);
  assert.deepEqual(outOfRangeRelaunchFields({}), []);
  assert.deepEqual(outOfRangeRelaunchFields({ maxTurns: 100, timeoutMs: 600_000 }), []);
  assert.deepEqual(outOfRangeRelaunchFields({ maxTurns: 200 }), ["maxTurns"]);
  assert.deepEqual(outOfRangeRelaunchFields({ maxTurns: 0 }), ["maxTurns"]);
  assert.deepEqual(outOfRangeRelaunchFields({ maxTurns: 2.5 }), ["maxTurns"]);
  assert.deepEqual(outOfRangeRelaunchFields({ timeoutMs: 999999999 }), ["timeoutMs"]);
  assert.deepEqual(outOfRangeRelaunchFields({ timeoutMs: 0 }), ["timeoutMs"]);
  assert.deepEqual(outOfRangeRelaunchFields({ timeoutMs: MAX_TIMEOUT_MS }), []);
  assert.deepEqual(outOfRangeRelaunchFields({ maxTurns: 200, timeoutMs: 999999999 }), ["maxTurns", "timeoutMs"]);
});

test("relaunch precondition texts name their run", () => {
  const dirless = relaunchCandidate({ runId: "call-d", status: "errored", sessionFile: undefined });
  assert.match(notContinuableText(dirless), /call-d/);
  assert.match(notContinuableText(dirless), /no persisted child session/);
  assert.match(consumedOrphanText("call-o"), /call-o/);
  assert.match(consumedOrphanText("call-o"), /already retried or continued/);
  assert.match(noTaskText(dirless), /call-d/);
  assert.match(agentNameNotOnDiskText(dirless), /"unknown"/);
});
