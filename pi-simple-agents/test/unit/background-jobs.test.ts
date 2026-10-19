import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createJobRegistry,
  createSettleBarrier,
  type InjectResult,
  type JobRegistry,
  type JobSnapshot,
  type LiveSessionApi,
  type LiveSessionSink,
  type SettledJob,
} from "../../src/background-jobs.ts";
import type { AgentRunResult } from "../../src/run.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

function asEvent(value: unknown): AgentSessionEvent {
  return value as AgentSessionEvent;
}

type JobIo = Parameters<Parameters<JobRegistry["start"]>[0]["run"]>[0];

function sampleRunResult(agent: string, task: string): AgentRunResult {
  return { agent, task, status: "success", finalText: "ok", durationMs: 1 };
}

// Deferred promise the test controls, so `run` settles only when the test says so.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeClock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

interface Harness {
  registry: JobRegistry;
  settled: SettledJob[];
  changes: (readonly JobSnapshot[])[];
  clock: ReturnType<typeof makeClock>;
}

function harness(maxRecent?: number): Harness {
  const clock = makeClock();
  const settled: SettledJob[] = [];
  const changes: (readonly JobSnapshot[])[] = [];
  const registry = createJobRegistry({
    now: clock.now,
    onSettled: (job) => settled.push(job),
    onChange: (jobs) => changes.push(jobs),
    maxRecent,
  });
  return { registry, settled, changes, clock };
}

test("start: returns a running snapshot with a sequential id and copied tasks", () => {
  const { registry } = harness();
  const task = { agent: "scout", task: "find x" };
  const job1 = registry.start({ runId: "r1", task, run: () => new Promise(() => {}) });
  assert.equal(job1.id, "S1001");
  assert.equal(job1.state.status, "running");
  assert.deepEqual(job1.task, task);
  assert.deepEqual(job1.progress, { agent: task.agent, runningTools: [], history: [], done: false });

  const job2 = registry.start({ runId: "r2", task, run: () => new Promise(() => {}) });
  assert.equal(job2.id, "S1002");
});

test("start: calls run exactly once, asynchronously, with a non-aborted signal", async () => {
  const { registry } = harness();
  let calls = 0;
  let sawSignal: AbortSignal | undefined;
  registry.start({
    runId: "r1",
    task: { agent: "scout", task: "x" },
    run: ({ signal }) => {
      calls += 1;
      sawSignal = signal;
      return Promise.resolve(sampleRunResult("scout", "x"));
    },
  });
  // run must not have been invoked synchronously inside start().
  assert.equal(calls, 0);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(sawSignal?.aborted, false);
});

test("tracker events update the snapshot's progress and call onChange", async () => {
  const { registry, changes } = harness();
  let tracker!: Parameters<Parameters<JobRegistry["start"]>[0]["run"]>[0]["tracker"];
  registry.start({
    runId: "r1",
    task: { agent: "scout", task: "x" },
    run: (io) => {
      tracker = io.tracker;
      return new Promise(() => {});
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  tracker.onEvent({ type: "tool_start", toolCallId: "t1", toolName: "read", summary: "read foo" });
  const last = changes.at(-1)!;
  assert.equal(last[0].progress.history.length, 1);
  assert.equal(last[0].progress.runningTools.length, 1);

  tracker.markTaskDone();
  const afterDone = changes.at(-1)!;
  assert.equal(afterDone[0].progress.done, true);

  // Re-emitting after done is a no-op: createProgressTracker's own guard
  // (progress.ts) returns early without calling emit once a task is done.
  const beforeReemit = changes.length;
  tracker.onEvent({ type: "tool_start", toolCallId: "t2", toolName: "grep", summary: "grep bar" });
  assert.equal(changes.length, beforeReemit);
  assert.equal(changes.at(-1)![0].progress.runningTools.length, 0);
});

test("completion: run resolves -> completed, settledAt = now(), onSettled fires once, whenIdle resolves", async () => {
  const { registry, settled, clock } = harness();
  const d = deferred<AgentRunResult>();
  const job = registry.start({
    runId: "r1",
    task: { agent: "scout", task: "x" },
    run: () => d.promise,
  });
  await Promise.resolve();
  await Promise.resolve();

  clock.advance(500);
  const idle = registry.whenIdle();
  const result = sampleRunResult("scout", "x");
  d.resolve(result);
  await idle;

  assert.equal(settled.length, 1);
  const job1 = settled[0];
  assert.equal(job1.id, job.id);
  assert.equal(job1.state.status, "completed");
  assert.equal(job1.state.settledAt, 1_500);
  assert.deepEqual((job1.state as { result: AgentRunResult }).result, result);
  assert.equal(registry.hasRunning(), false);
});

test("crash: run rejects -> errored with toErrorMessage; start() itself never throws", async () => {
  const { registry, settled } = harness();
  const d = deferred<AgentRunResult>();
  registry.start({ runId: "r1", task: { agent: "scout", task: "x" }, run: () => d.promise });
  await Promise.resolve();
  await Promise.resolve();

  d.reject(new Error("boom"));
  await registry.whenIdle();

  assert.equal(settled.length, 1);
  assert.equal(settled[0].state.status, "errored");
  assert.equal((settled[0].state as { error: string }).error, "boom");
});

test("failure: run resolves with an error result -> failed, run result retained", async () => {
  const { registry, settled } = harness();
  const result: AgentRunResult = { agent: "scout", task: "x", durationMs: 1, status: "error", error: "model not found" };
  const d = deferred<AgentRunResult>();
  registry.start({ runId: "r1", task: { agent: "scout", task: "x" }, run: () => d.promise });
  await Promise.resolve();
  await Promise.resolve();

  d.resolve(result);
  await registry.whenIdle();

  assert.equal(settled.length, 1);
  assert.equal(settled[0].state.status, "failed");
  assert.deepEqual((settled[0].state as { result: AgentRunResult }).result, result);
});

test("failure: run throws synchronously -> failed, caught by start()", async () => {
  const { registry, settled } = harness();
  assert.doesNotThrow(() => {
    registry.start({
      runId: "r1",
      task: { agent: "scout", task: "x" },
      run: () => {
        throw new Error("sync boom");
      },
    });
  });
  await registry.whenIdle();
  assert.equal(settled.length, 1);
  assert.equal(settled[0].state.status, "errored");
  assert.equal((settled[0].state as { error: string }).error, "sync boom");
});

test("cancel: running -> cancelling, aborts the signal, onChange fires; resolves as cancelled not completed", async () => {
  const { registry, changes } = harness();
  let sawSignal!: AbortSignal;
  const d = deferred<AgentRunResult>();
  const job = registry.start({
    runId: "r1",
    task: { agent: "scout", task: "x" },
    run: ({ signal }) => {
      sawSignal = signal;
      return d.promise;
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  const result = registry.cancel(job.id);
  assert.equal(result.kind, "cancelling");
  assert.equal(sawSignal.aborted, true);
  assert.equal(changes.at(-1)![0].state.status, "cancelling");

  d.resolve(sampleRunResult("scout", "x"));
  await registry.whenIdle();
  const settledState = registry.list()[0].state;
  assert.equal(settledState.status, "cancelled");
  assert.equal((settledState as { reason: string }).reason, "user");
});

test("cancel: a second cancel does not abort again (idempotent)", async () => {
  const { registry } = harness();
  let abortCount = 0;
  const job = registry.start({
    runId: "r1",
    task: { agent: "scout", task: "x" },
    run: ({ signal }) => {
      signal.addEventListener("abort", () => (abortCount += 1));
      return new Promise(() => {});
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  registry.cancel(job.id);
  registry.cancel(job.id);
  assert.equal(abortCount, 1);
});

test("cancel: cancelling an already-finished job returns not-running", async () => {
  const { registry } = harness();
  const job = registry.start({ runId: "r1", task: { agent: "scout", task: "x" }, run: () => Promise.resolve(sampleRunResult("scout", "x")) });
  await registry.whenIdle();
  const result = registry.cancel(job.id);
  assert.equal(result.kind, "not-running");
});

test("cancel: unknown id returns not-found", () => {
  const { registry } = harness();
  const result = registry.cancel("S9999");
  assert.equal(result.kind, "not-found");
  assert.equal((result as { id: string }).id, "S9999");
});

test("cancelAll: marks cancelled jobs with reason 'system', distinct from a user cancel", async () => {
  const { registry } = harness();
  const d = deferred<AgentRunResult>();
  registry.start({ runId: "r1", task: { agent: "scout", task: "x" }, run: () => d.promise });
  await Promise.resolve();
  await Promise.resolve();

  registry.cancelAll();
  d.resolve(sampleRunResult("scout", "x"));
  await registry.whenIdle();

  const state = registry.list()[0].state;
  assert.equal(state.status, "cancelled");
  assert.equal((state as { reason: string }).reason, "system");
});

test("cancelAll: calling it again on an already-cancelling job does not emit a redundant onChange", async () => {
  const { registry, changes } = harness();
  registry.start({ runId: "r1", task: { agent: "scout", task: "x" }, run: () => new Promise(() => {}) });
  await Promise.resolve();
  await Promise.resolve();

  registry.cancelAll();
  const changesAfterFirst = changes.length;
  registry.cancelAll(); // every job is already "cancelling" now
  assert.equal(changes.length, changesAfterFirst);
});

test("cancelAll: aborts every running job, keeps the registry open for future starts", async () => {
  const { registry, settled } = harness();
  const signals: AbortSignal[] = [];
  const d1 = deferred<AgentRunResult>();
  const d2 = deferred<AgentRunResult>();
  registry.start({
    runId: "r1",
    task: { agent: "scout", task: "x" },
    run: ({ signal }) => {
      signals.push(signal);
      return d1.promise;
    },
  });
  registry.start({
    runId: "r2",
    task: { agent: "scout", task: "y" },
    run: ({ signal }) => {
      signals.push(signal);
      return d2.promise;
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  registry.cancelAll();
  assert.ok(signals.every((s) => s.aborted));

  d1.resolve(sampleRunResult("scout", "x"));
  d2.resolve(sampleRunResult("scout", "y"));
  await registry.whenIdle();
  assert.equal(settled.length, 2);

  // Registry still accepts new jobs after cancelAll.
  const job3 = registry.start({ runId: "r3", task: { agent: "scout", task: "z" }, run: () => Promise.resolve(sampleRunResult("scout", "x")) });
  assert.equal(job3.state.status, "running");
});

test("shutdown: aborts running jobs and suppresses onSettled/onChange for later settles; idempotent", async () => {
  const { registry, settled, changes } = harness();
  const d = deferred<AgentRunResult>();
  registry.start({ runId: "r1", task: { agent: "scout", task: "x" }, run: () => d.promise });
  await Promise.resolve();
  await Promise.resolve();

  registry.shutdown();
  registry.shutdown(); // idempotent, must not throw

  const settledBefore = settled.length;
  const changesBefore = changes.length;
  d.resolve(sampleRunResult("scout", "x"));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(settled.length, settledBefore);
  assert.equal(changes.length, changesBefore);
});

test("shutdown: a whenIdle() caller waiting during shutdown still resolves once the job settles", async () => {
  const { registry } = harness();
  const d = deferred<AgentRunResult>();
  registry.start({ runId: "r1", task: { agent: "scout", task: "x" }, run: () => d.promise });
  await Promise.resolve();
  await Promise.resolve();

  let idleResolved = false;
  const idle = registry.whenIdle().then(() => (idleResolved = true));

  registry.shutdown();
  assert.equal(idleResolved, false); // still running until the deferred settles

  d.resolve(sampleRunResult("scout", "x"));
  await idle;
  assert.equal(idleResolved, true);
});

test("list: newest first, retention drops the oldest finished job beyond maxRecent, running jobs are never dropped", async () => {
  const { registry } = harness(2);
  const d = deferred<AgentRunResult>();
  const stillRunning = registry.start({ runId: "r0", task: { agent: "scout", task: "keep-running" }, run: () => d.promise });

  for (let i = 1; i <= 3; i += 1) {
    registry.start({ runId: `r${i}`, task: { agent: "scout", task: `t${i}` }, run: () => Promise.resolve(sampleRunResult("scout", `t${i}`)) });
    // let each settle before starting the next, so ordering is deterministic
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  const ids = registry.list().map((j) => j.id);
  // Running job always present; only the 2 most recent finished jobs kept (maxRecent=2).
  assert.ok(ids.includes(stillRunning.id));
  const finishedIds = ids.filter((id) => id !== stillRunning.id);
  assert.equal(finishedIds.length, 2);
  assert.deepEqual(finishedIds, ["S1004", "S1003"]); // newest first, S1002 dropped

  d.resolve(sampleRunResult("scout", "x"));
  await registry.whenIdle();
});

test("list: default retention (no maxRecent override) keeps exactly the 50 most recent finished jobs", async () => {
  const { registry } = harness(); // no maxRecent override -> MAX_RECENT_JOBS default

  for (let i = 1; i <= 51; i += 1) {
    registry.start({ runId: `r${i}`, task: { agent: "scout", task: `t${i}` }, run: () => Promise.resolve(sampleRunResult("scout", `t${i}`)) });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  const ids = registry.list().map((j) => j.id);
  assert.equal(ids.length, 50);
  assert.ok(!ids.includes("S1001")); // the very first job, oldest, is the one dropped
  assert.ok(ids.includes("S1051")); // the most recent of the 51 started
});

test("get: returns the live snapshot for a running job, and the settled one after completion", async () => {
  const { registry, settled } = harness();
  const d = deferred<AgentRunResult>();
  const running = registry.start({ runId: "r1", task: { agent: "scout", task: "watch me" }, run: () => d.promise });

  assert.deepEqual(registry.get(running.id), running);

  d.resolve(sampleRunResult("scout", "x"));
  await registry.whenIdle();
  const settledSnapshot = registry.get(running.id);
  assert.equal(settledSnapshot?.state.status, "completed");
  assert.equal(settled?.length, 1);
});

test("get: unknown ids return undefined, including ids pruned by maxRecent", async () => {
  const { registry } = harness(1); // keep at most 1 finished job
  registry.start({ runId: "r1", task: { agent: "scout", task: "t1" }, run: () => Promise.resolve(sampleRunResult("scout", "t1")) });
  const second = registry.start({ runId: "r2", task: { agent: "scout", task: "t2" }, run: () => Promise.resolve(sampleRunResult("scout", "t2")) });
  await registry.whenIdle();

  assert.equal(registry.get("S9999"), undefined); // never existed
  assert.ok(registry.get(second.id)); // newest finished job kept
  const firstPruned = "S1001";
  assert.equal(registry.get(firstPruned), undefined); // pruned by maxRecent
});

test("getTranscript: every started job gets a transcript; events fed through the run io land in it", async () => {
  const { registry } = harness();
  let transcript!: JobIo["transcript"];
  const job = registry.start({
    runId: "r1",
    task: { agent: "scout", task: "x" },
    run: (io) => {
      transcript = io.transcript;
      transcript.onSessionEvent(asEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } }));
      return new Promise(() => {});
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  const snapshot = registry.getTranscript(job.id);
  assert.ok(snapshot);
  assert.equal(snapshot.entries.length, 1);
  const entry = snapshot.entries[0];
  assert.equal(entry && entry.kind === "tool-start" ? entry.label : undefined, "read a.ts");

  assert.equal(registry.getTranscript("S9999"), undefined); // unknown id
});

test("getTranscript: transcripts of pruned jobs are gone with the job", async () => {
  const { registry } = harness(1); // keep at most 1 finished job
  registry.start({ runId: "r1", task: { agent: "scout", task: "t1" }, run: () => Promise.resolve(sampleRunResult("scout", "t1")) });
  registry.start({ runId: "r2", task: { agent: "scout", task: "t2" }, run: () => Promise.resolve(sampleRunResult("scout", "t2")) });
  await registry.whenIdle();
  assert.equal(registry.getTranscript("S1001"), undefined); // pruned together with the job
  assert.ok(registry.getTranscript("S1002"));
});

test("transcript: feeding session events does NOT add any onChange emissions (no widget refresh for peek)", async () => {
  const fed = harness();
  const unfed = harness();
  const events: AgentSessionEvent[] = [
    asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "hi", partial: {} } }),
    asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_end", content: "hi", partial: {} } }),
    asEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } }),
    asEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "ok", isError: false }),
  ];
  const run = (io: JobIo, feed: boolean): Promise<AgentRunResult> => {
    if (feed) for (const event of events) io.transcript.onSessionEvent(event);
    return Promise.resolve(sampleRunResult("scout", "x"));
  };
  fed.registry.start({ runId: "r1", task: { agent: "scout", task: "x" }, run: (io) => run(io, true) });
  unfed.registry.start({ runId: "r1", task: { agent: "scout", task: "x" }, run: (io) => run(io, false) });
  await fed.registry.whenIdle();
  await unfed.registry.whenIdle();

  // Same run shape, same settle notifications — the transcript feed alone
  // must be invisible to onChange (the perf invariant pin).
  assert.equal(fed.changes.length, unfed.changes.length);
  // And the fed registry actually captured the events.
  assert.ok((fed.registry.getTranscript("S1001")?.entries.length ?? 0) >= 2);
});

test("clearFinished: drops every settled job, keeps running ones, returns the count removed", async () => {
  const { registry, changes } = harness();
  const d = deferred<AgentRunResult>();
  const stillRunning = registry.start({ runId: "r0", task: { agent: "scout", task: "keep-running" }, run: () => d.promise });
  registry.start({ runId: "r1", task: { agent: "scout", task: "t1" }, run: () => Promise.resolve(sampleRunResult("scout", "t1")) });
  registry.start({ runId: "r2", task: { agent: "scout", task: "t2" }, run: () => Promise.resolve(sampleRunResult("scout", "t2")) });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  const changesBefore = changes.length;
  const removed = registry.clearFinished();

  assert.equal(removed, 2);
  assert.deepEqual(registry.list().map((j) => j.id), [stillRunning.id]);
  assert.ok(changes.length > changesBefore); // emitChange fired

  d.resolve(sampleRunResult("scout", "x"));
  await registry.whenIdle();
});

test("clearFinished: no-op (returns 0, no onChange) when there is nothing finished", () => {
  const { registry, changes } = harness();
  registry.start({ runId: "r1", task: { agent: "scout", task: "x" }, run: () => new Promise(() => {}) });
  const changesBefore = changes.length;

  assert.equal(registry.clearFinished(), 0);
  assert.equal(changes.length, changesBefore);
});

test("whenIdle: resolves immediately when nothing is running", async () => {
  const { registry } = harness();
  let resolved = false;
  registry.whenIdle().then(() => (resolved = true));
  await Promise.resolve();
  assert.equal(resolved, true);
});

test("whenIdle: with two running jobs resolves only after the second settles", async () => {
  const { registry } = harness();
  const d1 = deferred<AgentRunResult>();
  const d2 = deferred<AgentRunResult>();
  registry.start({ runId: "r1", task: { agent: "scout", task: "x" }, run: () => d1.promise });
  registry.start({ runId: "r2", task: { agent: "scout", task: "y" }, run: () => d2.promise });
  await Promise.resolve();
  await Promise.resolve();

  let resolved = false;
  registry.whenIdle().then(() => (resolved = true));

  d1.resolve(sampleRunResult("scout", "x"));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resolved, false);

  d2.resolve(sampleRunResult("scout", "y"));
  await registry.whenIdle();
  assert.equal(resolved, true);
});

test("hook errors: onSettled throwing does not break state and does not surface as an unhandled rejection", async (t) => {
  const clock = makeClock();
  const warnSpy = t.mock.method(console, "warn");
  const registry = createJobRegistry({
    now: clock.now,
    onSettled: () => {
      throw new Error("listener boom");
    },
    onChange: () => {},
  });
  const job = registry.start({ runId: "r1", task: { agent: "scout", task: "x" }, run: () => Promise.resolve(sampleRunResult("scout", "x")) });
  await registry.whenIdle();
  assert.equal(registry.list().find((j) => j.id === job.id)?.state.status, "completed");
  assert.ok(warnSpy.mock.calls.some((c) => String(c.arguments[0]).includes("onSettled handler threw")));
});

test("hook errors: onChange throwing does not break state and warns once per occurrence", async (t) => {
  const clock = makeClock();
  const warnSpy = t.mock.method(console, "warn");
  const registry = createJobRegistry({
    now: clock.now,
    onSettled: () => {},
    onChange: () => {
      throw new Error("onChange boom");
    },
  });
  const job = registry.start({ runId: "r1", task: { agent: "scout", task: "x" }, run: () => Promise.resolve(sampleRunResult("scout", "x")) });
  await registry.whenIdle();
  assert.equal(registry.list().find((j) => j.id === job.id)?.state.status, "completed");
  assert.ok(warnSpy.mock.calls.some((c) => String(c.arguments[0]).includes("onChange handler threw")));
});

// --- steer/followUp (message injection) ---

// Fake LiveSessionApi: records every steer/followUp call, returns the
// configured disposition, and optionally throws (a rejecting live session).
function fakeLive(opts: { disposition?: "queued" | "handled"; throws?: boolean } = {}) {
  const calls: Array<{ which: "steer" | "followUp"; message: string }> = [];
  const api: LiveSessionApi = {
    steer: async (message) => {
      calls.push({ which: "steer", message });
      if (opts.throws) throw new Error("inject boom");
      return opts.disposition ?? "queued";
    },
    followUp: async (message) => {
      calls.push({ which: "followUp", message });
      if (opts.throws) throw new Error("inject boom");
      return opts.disposition ?? "queued";
    },
  };
  return { api, calls };
}

// Starts one job whose run stays pending on the returned deferred, with the
// given live api already registered through the run io's sink (mirrors the
// real wiring: runAgentViaSdk's onSessionReady -> live.set).
function startLiveJob(registry: JobRegistry, api: LiveSessionApi) {
  const d = deferred<AgentRunResult>();
  const job = registry.start({
    runId: "r1",
    task: { agent: "scout", task: "x" },
    run: (io) => {
      io.live.set(api);
      return d.promise;
    },
  });
  return { job, d };
}

// The two microtasks every start()-based test needs before `run` (and its
// live.set) has actually been invoked.
async function afterRunStarts() {
  await Promise.resolve();
  await Promise.resolve();
}

test("steer/followUp: unknown id returns not-found", async () => {
  const { registry } = harness();
  assert.deepEqual(await registry.steer("S9999", "m"), { kind: "not-found", id: "S9999" });
  assert.deepEqual(await registry.followUp("S9999", "m"), { kind: "not-found", id: "S9999" });
});

test("steer/followUp: a settled job is not-running and the live session is never consulted", async () => {
  const { registry } = harness();
  const { api, calls } = fakeLive();
  const { job, d } = startLiveJob(registry, api);
  await afterRunStarts();
  d.resolve(sampleRunResult("scout", "x"));
  await registry.whenIdle();

  const steerView = await registry.steer(job.id, "m");
  assert.equal(steerView.kind, "not-running");
  const followUpView = await registry.followUp(job.id, "m");
  assert.equal(followUpView.kind, "not-running");
  if (steerView.kind === "not-running") assert.equal(steerView.job.id, job.id);
  assert.deepEqual(calls, []); // finalizeSettle already nulled the handle
});

test("steer/followUp: a cancelling job is cancelling and the live session is never called", async () => {
  const { registry } = harness();
  const { api, calls } = fakeLive();
  const { job, d } = startLiveJob(registry, api);
  await afterRunStarts();

  registry.cancel(job.id);
  assert.equal((await registry.steer(job.id, "m")).kind, "cancelling");
  assert.equal((await registry.followUp(job.id, "m")).kind, "cancelling");
  assert.deepEqual(calls, []); // the abort is already in flight

  d.resolve(sampleRunResult("scout", "x"));
  await registry.whenIdle();
});

test("steer: a running job with no live session yet (pre-prompt window) is not-live", async () => {
  const { registry } = harness();
  const d = deferred<AgentRunResult>();
  const job = registry.start({ runId: "r1", task: { agent: "scout", task: "x" }, run: () => d.promise });
  await afterRunStarts();

  const result = await registry.steer(job.id, "m");
  assert.equal(result.kind, "not-live");
  if (result.kind === "not-live") assert.equal(result.job.id, job.id);

  d.resolve(sampleRunResult("scout", "x"));
  await registry.whenIdle();
});

test("steer: live cleared while the job still reads running (the teardown window) is not-live", async () => {
  const { registry } = harness();
  const { api } = fakeLive();
  let sink!: LiveSessionSink;
  const d = deferred<AgentRunResult>();
  const job = registry.start({
    runId: "r1",
    task: { agent: "scout", task: "x" },
    run: (io) => {
      sink = io.live;
      io.live.set(api);
      return d.promise;
    },
  });
  await afterRunStarts();

  // Simulates onSessionGone firing (top of the run's teardown) while the
  // run's promise — and so the job's state — has not settled yet.
  sink.clear();
  assert.equal((await registry.steer(job.id, "m")).kind, "not-live");

  d.resolve(sampleRunResult("scout", "x"));
  await registry.whenIdle();
});

test("steer: a live session injects the message and surfaces the disposition verbatim", async () => {
  const { registry } = harness();
  const { api, calls } = fakeLive();
  const { job, d } = startLiveJob(registry, api);
  await afterRunStarts();

  const result = await registry.steer(job.id, "turn left");
  assert.deepEqual(result, { kind: "injected", job: registry.get(job.id), disposition: "queued" });
  assert.deepEqual(calls, [{ which: "steer", message: "turn left" }]);

  d.resolve(sampleRunResult("scout", "x"));
  await registry.whenIdle();
});

test("followUp: a live session queues the message and surfaces the disposition verbatim", async () => {
  const { registry } = harness();
  const { api, calls } = fakeLive({ disposition: "handled" });
  const { job, d } = startLiveJob(registry, api);
  await afterRunStarts();

  const result = await registry.followUp(job.id, "one more thing");
  assert.deepEqual(result, { kind: "injected", job: registry.get(job.id), disposition: "handled" });
  assert.deepEqual(calls, [{ which: "followUp", message: "one more thing" }]);

  d.resolve(sampleRunResult("scout", "x"));
  await registry.whenIdle();
});

test("steer: a live session that throws surfaces as failed with the error, never a rejection", async () => {
  const { registry } = harness();
  const { api } = fakeLive({ throws: true });
  const { job, d } = startLiveJob(registry, api);
  await afterRunStarts();

  const result: InjectResult = await registry.steer(job.id, "m");
  assert.deepEqual(result, { kind: "failed", job: registry.get(job.id), error: "inject boom" });

  d.resolve(sampleRunResult("scout", "x"));
  await registry.whenIdle();
});

test("steer: finalizeSettle nulls live — a stale sink set after the settle cannot resurrect the handle", async () => {
  const { registry } = harness();
  const { api } = fakeLive();
  let sink!: LiveSessionSink;
  const d = deferred<AgentRunResult>();
  const job = registry.start({
    runId: "r1",
    task: { agent: "scout", task: "x" },
    run: (io) => {
      sink = io.live;
      io.live.set(api);
      return d.promise;
    },
  });
  await afterRunStarts();
  d.resolve(sampleRunResult("scout", "x"));
  await registry.whenIdle();

  // A late onSessionReady racing past the settle: the guarded sink must
  // refuse, and the guard chain reports the settled job as not-running.
  sink.set(api);
  assert.equal((await registry.steer(job.id, "m")).kind, "not-running");
});

// --- settle barrier ---

function fakeRegistry(opts: { hasRunning: boolean; whenIdle: () => Promise<void> }) {
  let cancelAllCalls = 0;
  return {
    hasRunning: () => opts.hasRunning,
    whenIdle: opts.whenIdle,
    cancelAll: () => {
      cancelAllCalls += 1;
    },
    get cancelAllCalls() {
      return cancelAllCalls;
    },
  };
}

test("settle barrier: hasUI true resolves without calling whenIdle", async () => {
  let whenIdleCalls = 0;
  const reg = fakeRegistry({
    hasRunning: true,
    whenIdle: () => {
      whenIdleCalls += 1;
      return new Promise(() => {});
    },
  });
  const barrier = createSettleBarrier(reg);
  await barrier(undefined, { hasUI: true, signal: undefined });
  assert.equal(whenIdleCalls, 0);
});

test("settle barrier: hasUI false, nothing running resolves immediately", async () => {
  const reg = fakeRegistry({ hasRunning: false, whenIdle: () => Promise.resolve() });
  const barrier = createSettleBarrier(reg);
  await barrier(undefined, { hasUI: false, signal: undefined });
});

test("settle barrier: hasUI false with running jobs waits for whenIdle", async () => {
  let released!: () => void;
  const idle = new Promise<void>((res) => (released = res));
  const reg = fakeRegistry({ hasRunning: true, whenIdle: () => idle });
  const barrier = createSettleBarrier(reg);

  let settledBarrier = false;
  const p = barrier(undefined, { hasUI: false, signal: undefined }).then(() => (settledBarrier = true));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settledBarrier, false);

  released();
  await p;
  assert.equal(settledBarrier, true);
});

test("settle barrier: aborting the signal while waiting calls cancelAll and resolves", async () => {
  const controller = new AbortController();
  const reg = fakeRegistry({ hasRunning: true, whenIdle: () => new Promise(() => {}) });
  const barrier = createSettleBarrier(reg);

  const p = barrier(undefined, { hasUI: false, signal: controller.signal });
  controller.abort();
  await p;
  assert.equal(reg.cancelAllCalls, 1);
});
