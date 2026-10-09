import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSubagentToolResult,
  buildSubagentAckResult,
  buildJobCompletionMessage,
  SUBAGENT_RESULT_MESSAGE_TYPE,
} from "../../src/job-messages.ts";
import type { JobSnapshot, SettledJob } from "../../src/background-jobs.ts";
import type { AgentRunResult } from "../../src/run.ts";

function runningSnapshot(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id: "S1003",
    runId: "call-1",
    startedAt: 1000,
    task: { agent: "scout", task: "Find all fetch() calls in src/" },
    progress: { agent: "scout", runningTools: [], history: [], done: false },
    state: { status: "running" },
    ...overrides,
  };
}

function settledOf(snapshot: JobSnapshot, state: SettledJob["state"]): SettledJob {
  return { ...snapshot, state };
}

// --- buildSubagentToolResult (moved from extensions/index.ts, same contract) ---

test("buildSubagentToolResult: assembles runId, run, and usage for a success", () => {
  const result: AgentRunResult = {
    agent: "scout", task: "a", durationMs: 5, status: "success", finalText: "done",
    sessionFile: "/sessions/parent/call-1/run-0/session.jsonl",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.1, isSubscription: false, context: undefined },
  };

  const toolResult = buildSubagentToolResult(result, "call-1");

  assert.equal(toolResult.details.runId, "call-1");
  assert.equal(toolResult.details.run, result);
  assert.deepEqual(toolResult.usage, {
    input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
  });
  assert.equal(toolResult.isError, false);
});

test("buildSubagentToolResult: a run without usage yields undefined aggregate usage", () => {
  const result: AgentRunResult = { agent: "scout", task: "a", durationMs: 5, status: "error", error: "boom" };
  const toolResult = buildSubagentToolResult(result, "call-2");
  assert.equal(toolResult.usage, undefined);
  assert.equal(toolResult.isError, true);
});

// --- ack result ---

test("buildSubagentAckResult: text names the job id, the agent/task (truncated first line), and the do-not-poll sentence", () => {
  const job = runningSnapshot();
  const result = buildSubagentAckResult(job);

  assert.equal(result.content[0].type, "text");
  const text = result.content[0].text;
  assert.match(text, /\bS1003\b/);
  assert.match(text, /scout: Find all fetch\(\) calls in src\//);
  assert.match(text, /delivered automatically/);
  assert.match(text, /[Dd]o not call subagent again/);
  assert.match(text, /\/subagents cancel S1003/);
});

test("buildSubagentAckResult: truncates a long first line of the task", () => {
  const longTask = "x".repeat(200);
  const job = runningSnapshot({ task: { agent: "scout", task: longTask } });
  const result = buildSubagentAckResult(job);
  assert.ok(result.content[0].text.includes("\u2026"));
  assert.ok(!result.content[0].text.includes("x".repeat(200)));
});

test("buildSubagentAckResult: details is exactly {jobId, runId, task}, isError false, no usage key", () => {
  const job = runningSnapshot();
  const result = buildSubagentAckResult(job);
  assert.deepEqual(result.details, { jobId: "S1003", runId: "call-1", task: job.task });
  assert.equal(result.isError, false);
  assert.equal("usage" in result, false);
});

// --- completion message ---

test("buildJobCompletionMessage: completed header + formatRunResult body", () => {
  const snapshot = runningSnapshot({ task: { agent: "scout", task: "a" } });
  const result: AgentRunResult = { agent: "scout", task: "a", durationMs: 1, status: "success", finalText: "done" };
  const job = settledOf(snapshot, { status: "completed", settledAt: 2000, result });

  const { message, options } = buildJobCompletionMessage(job);

  assert.equal(message.customType, SUBAGENT_RESULT_MESSAGE_TYPE);
  assert.equal(message.display, true);
  assert.match(message.content, /S1003/);
  assert.match(message.content, /completed/);
  assert.doesNotMatch(message.content, /\(\d+ tasks?\)/);
  assert.match(message.content, /done/);
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
});

test("buildJobCompletionMessage: completed details carries the run and aggregate usage", () => {
  const snapshot = runningSnapshot({ task: { agent: "scout", task: "a" } });
  const result: AgentRunResult = {
    agent: "scout", task: "a", durationMs: 1, status: "success", finalText: "done",
    sessionFile: "/s/f", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, isSubscription: false, context: undefined },
  };
  const job = settledOf(snapshot, { status: "completed", settledAt: 2000, result });

  const { message } = buildJobCompletionMessage(job);
  assert.equal(message.details.jobId, "S1003");
  assert.equal(message.details.runId, "call-1");
  assert.equal(message.details.status, "completed");
  assert.deepEqual(message.details.run, result);
  assert.deepEqual(message.details.usage, {
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  });
  assert.equal(message.details.isError, false);
});

test("buildJobCompletionMessage: cancelled header names the user, triggerTurn is false", () => {
  const snapshot = runningSnapshot({ task: { agent: "scout", task: "a" } });
  const result: AgentRunResult = { agent: "scout", task: "a", durationMs: 1, status: "error", error: "run was aborted" };
  const job = settledOf(snapshot, { status: "cancelled", settledAt: 2000, result, reason: "user" });

  const { message, options } = buildJobCompletionMessage(job);
  assert.match(message.content, /cancelled by the user/);
  assert.deepEqual(options, { triggerTurn: false });
});

test("buildJobCompletionMessage: a system-cancelled job (shutdown/headless safety net) wording differs from a user cancel", () => {
  const snapshot = runningSnapshot({ task: { agent: "scout", task: "a" } });
  const result: AgentRunResult = { agent: "scout", task: "a", durationMs: 1, status: "error", error: "run was aborted" };
  const job = settledOf(snapshot, { status: "cancelled", settledAt: 2000, result, reason: "system" });

  const { message, options } = buildJobCompletionMessage(job);
  assert.doesNotMatch(message.content, /cancelled by the user/);
  assert.match(message.content, /session ending/);
  assert.deepEqual(options, { triggerTurn: false });
});

test("buildJobCompletionMessage: failed (run-level error) carries the run, isError true", () => {
  const snapshot = runningSnapshot({ task: { agent: "scout", task: "a" } });
  const result: AgentRunResult = { agent: "scout", task: "a", durationMs: 1, status: "error", error: "boom" };
  const job = settledOf(snapshot, { status: "failed", settledAt: 2000, result });

  const { message, options } = buildJobCompletionMessage(job);
  assert.match(message.content, /finished \u2014 failed/);
  assert.match(message.content, /Agent "scout" failed: boom/);
  assert.equal(message.details.status, "failed");
  assert.equal(message.details.isError, true);
  assert.deepEqual((message.details as { run: AgentRunResult }).run, result);
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
});

test("buildJobCompletionMessage: errored (infrastructure) header carries the exception, no run", () => {
  const snapshot = runningSnapshot({ task: { agent: "scout", task: "a" } });
  const job = settledOf(snapshot, { status: "errored", settledAt: 2000, error: "boom" });

  const { message, options } = buildJobCompletionMessage(job);
  assert.match(message.content, /errored: boom/);
  assert.equal(message.details.status, "errored");
  assert.equal(message.details.isError, true);
  assert.equal("run" in message.details, false);
  assert.equal("usage" in message.details, false);
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
});
