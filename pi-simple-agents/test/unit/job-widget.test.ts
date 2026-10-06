import { test } from "node:test";
import assert from "node:assert/strict";
import { createJobWidget, JOBS_WIDGET_KEY, type JobWidgetUi } from "../../src/job-widget.ts";
import type { JobSnapshot } from "../../src/background-jobs.ts";

function fakeScheduler() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  return {
    schedule: (fn: () => void, _ms: number) => {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    cancel: (handle: unknown) => {
      pending.delete(handle as number);
    },
    fire(handle: number) {
      // Real setTimeout handles are one-shot: once fired, they're no longer
      // pending, same as a real timer. createJobWidget relies on this to
      // decide whether a tick needs to reschedule itself.
      const fn = pending.get(handle);
      pending.delete(handle);
      fn?.();
    },
    pendingCount: () => pending.size,
  };
}

function fakeUi() {
  const calls: Array<{ key: string; lines: string[] | undefined }> = [];
  const ui: JobWidgetUi = {
    setWidget: (key, lines) => calls.push({ key, lines }),
    theme: { fg: (_c, t) => t },
  };
  return { ui, calls };
}

function runningJob(startedAt = 0): JobSnapshot {
  return {
    id: "S1001",
    runId: "call-1",
    startedAt,
    task: { agent: "scout", task: "x" },
    progress: { agent: "scout", runningTools: [], history: [], done: false },
    state: { status: "running" },
  };
}

test("refresh with a running job calls setWidget with lines and starts exactly one ticker", () => {
  const scheduler = fakeScheduler();
  const { ui, calls } = fakeUi();
  let now = 0;
  const widget = createJobWidget({ getUi: () => ui, now: () => now, schedule: scheduler.schedule, cancel: scheduler.cancel });

  widget.refresh([runningJob()]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, JOBS_WIDGET_KEY);
  assert.ok(calls[0].lines && calls[0].lines.length > 0);
  assert.equal(scheduler.pendingCount(), 1);
});

test("a tick re-renders using the advanced clock", () => {
  const scheduler = fakeScheduler();
  const { ui, calls } = fakeUi();
  let now = 0;
  const widget = createJobWidget({ getUi: () => ui, now: () => now, schedule: scheduler.schedule, cancel: scheduler.cancel });

  widget.refresh([runningJob(0)]);
  const beforeTick = calls.at(-1)!.lines!.join("\n");

  now = 5_000;
  scheduler.fire(1); // the handle returned by the first schedule() call

  const afterTick = calls.at(-1)!.lines!.join("\n");
  assert.notEqual(afterTick, beforeTick);
  assert.match(afterTick, /5s/);
});

test("refresh with no running jobs clears the widget and cancels the ticker", () => {
  const scheduler = fakeScheduler();
  const { ui, calls } = fakeUi();
  const widget = createJobWidget({ getUi: () => ui, now: () => 0, schedule: scheduler.schedule, cancel: scheduler.cancel });

  widget.refresh([runningJob()]);
  assert.equal(scheduler.pendingCount(), 1);

  const finished: JobSnapshot = { ...runningJob(), state: { status: "completed", settledAt: 0, result: { agent: "scout", task: "x", durationMs: 1, status: "success", finalText: "done" } } };
  widget.refresh([finished]);

  assert.equal(calls.at(-1)!.lines, undefined);
  assert.equal(scheduler.pendingCount(), 0);
});

test("repeated refresh calls while jobs stay active do not stack tickers", () => {
  const scheduler = fakeScheduler();
  const { ui } = fakeUi();
  const widget = createJobWidget({ getUi: () => ui, now: () => 0, schedule: scheduler.schedule, cancel: scheduler.cancel });

  widget.refresh([runningJob()]);
  widget.refresh([runningJob()]);
  widget.refresh([runningJob()]);

  assert.equal(scheduler.pendingCount(), 1);
});

test("dispose cancels the ticker and clears the widget", () => {
  const scheduler = fakeScheduler();
  const { ui, calls } = fakeUi();
  const widget = createJobWidget({ getUi: () => ui, now: () => 0, schedule: scheduler.schedule, cancel: scheduler.cancel });

  widget.refresh([runningJob()]);
  widget.dispose();

  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(calls.at(-1)!.lines, undefined);
});

test("a tick that finds nothing to render (UI became unavailable) stops rescheduling itself", () => {
  const scheduler = fakeScheduler();
  const { ui, calls } = fakeUi();
  let uiAvailable: typeof ui | undefined = ui;
  const widget = createJobWidget({ getUi: () => uiAvailable, now: () => 0, schedule: scheduler.schedule, cancel: scheduler.cancel });

  widget.refresh([runningJob()]);
  assert.equal(scheduler.pendingCount(), 1);

  // The UI disappears (e.g. a mode change) between refresh() and the next
  // scheduled tick \u2014 refresh() itself never gets a chance to notice and
  // call stopTicking(), so the tick's own "nothing to render" branch is what
  // has to stop the rescheduling.
  uiAvailable = undefined;
  scheduler.fire(1);

  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(calls.length, 1); // the tick itself never called setWidget again
});

test("getUi() returning undefined means nothing is called", () => {
  const scheduler = fakeScheduler();
  const widget = createJobWidget({ getUi: () => undefined, now: () => 0, schedule: scheduler.schedule, cancel: scheduler.cancel });

  widget.refresh([runningJob()]);
  widget.dispose();

  assert.equal(scheduler.pendingCount(), 0);
});
