import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialTaskProgress,
  applyToolEvent,
  markDone,
  buildProgressLines,
  createProgressTracker,
  type TaskProgress,
  type ProgressTheme,
} from "../../src/progress.ts";

const fakeTheme: ProgressTheme = {
  fg: (c, t) => `<${c}>${t}</${c}>`,
};

test("initialTaskProgress: returns zeroed progress for the given agent", () => {
  const p = initialTaskProgress("scout");
  assert.deepEqual(p, { agent: "scout", toolCount: 0, runningTools: [], done: false });
});

test("applyToolEvent: tool_start increments toolCount and appends to runningTools", () => {
  const initial = initialTaskProgress("scout");
  const p = applyToolEvent(initial, { type: "tool_start", toolCallId: "a", toolName: "read" });
  assert.equal(p.toolCount, 1);
  assert.deepEqual(p.runningTools, [{ toolCallId: "a", toolName: "read" }]);
});

test("applyToolEvent: tool_end removes only the matching tool, toolCount stays at the start count", () => {
  let p = initialTaskProgress("scout");
  p = applyToolEvent(p, { type: "tool_start", toolCallId: "a", toolName: "read" });
  p = applyToolEvent(p, { type: "tool_start", toolCallId: "b", toolName: "grep" });
  p = applyToolEvent(p, { type: "tool_end", toolCallId: "a" });
  assert.equal(p.toolCount, 2);
  assert.deepEqual(p.runningTools, [{ toolCallId: "b", toolName: "grep" }]);
});

test("applyToolEvent: tool_end with unknown toolCallId is a no-op", () => {
  let p = initialTaskProgress("scout");
  p = applyToolEvent(p, { type: "tool_start", toolCallId: "a", toolName: "read" });
  const before = p.runningTools;
  const after = applyToolEvent(p, { type: "tool_end", toolCallId: "unknown" });
  assert.deepEqual(after.runningTools, before);
});

test("markDone: sets done true, clears runningTools, leaves other fields unchanged", () => {
  let p = initialTaskProgress("scout");
  p = applyToolEvent(p, { type: "tool_start", toolCallId: "a", toolName: "read" });
  const done = markDone(p);
  assert.equal(done.done, true);
  assert.equal(done.agent, p.agent);
  assert.equal(done.toolCount, p.toolCount);
  assert.deepEqual(done.runningTools, []);
});

test("applyToolEvent: returns a new object and does not mutate the original runningTools array", () => {
  const p: TaskProgress = initialTaskProgress("scout");
  const originalRunningTools = p.runningTools;
  const event = { type: "tool_start" as const, toolCallId: "a", toolName: "read" };
  const next = applyToolEvent(p, event);
  assert.notEqual(next, p);
  assert.equal(p.runningTools, originalRunningTools);
  assert.equal(originalRunningTools.length, 0);
});

test("buildProgressLines: one task, one running tool renders accent agent, dim tool count and running tool name", () => {
  const p: TaskProgress = {
    agent: "scout",
    toolCount: 1,
    runningTools: [{ toolCallId: "a", toolName: "read" }],
    done: false,
  };

  const result = buildProgressLines([p], fakeTheme);

  assert.equal(result, "<accent>scout</accent> <dim>\u00b7 tools: 1 \u00b7 running: read</dim>");
});

test("buildProgressLines: two running tools list names in start order", () => {
  const p: TaskProgress = {
    agent: "scout",
    toolCount: 2,
    runningTools: [
      { toolCallId: "a", toolName: "read" },
      { toolCallId: "b", toolName: "grep" },
    ],
    done: false,
  };

  const result = buildProgressLines([p], fakeTheme);

  assert.equal(result, "<accent>scout</accent> <dim>\u00b7 tools: 2 \u00b7 running: read, grep</dim>");
});

test("buildProgressLines: no running tools, not done renders working\u2026", () => {
  const p: TaskProgress = { agent: "scout", toolCount: 0, runningTools: [], done: false };

  const result = buildProgressLines([p], fakeTheme);

  assert.equal(result, "<accent>scout</accent> <dim>\u00b7 tools: 0 \u00b7 working\u2026</dim>");
});

test("buildProgressLines: done true renders done regardless of runningTools", () => {
  const p: TaskProgress = {
    agent: "scout",
    toolCount: 3,
    runningTools: [{ toolCallId: "a", toolName: "read" }],
    done: true,
  };

  const result = buildProgressLines([p], fakeTheme);

  assert.equal(result, "<accent>scout</accent> <dim>\u00b7 tools: 3 \u00b7 done</dim>");
});

test("buildProgressLines: two tasks render two lines joined by newline in input order", () => {
  const p1: TaskProgress = { agent: "scout", toolCount: 0, runningTools: [], done: false };
  const p2: TaskProgress = { agent: "web-scout", toolCount: 2, runningTools: [], done: true };

  const result = buildProgressLines([p1, p2], fakeTheme);

  assert.equal(
    result,
    "<accent>scout</accent> <dim>\u00b7 tools: 0 \u00b7 working\u2026</dim>\n"
      + "<accent>web-scout</accent> <dim>\u00b7 tools: 2 \u00b7 done</dim>",
  );
});

test("createProgressTracker: onToolEvent on one index leaves other tasks' progress untouched", () => {
  const emitted: Array<readonly TaskProgress[]> = [];
  const tracker = createProgressTracker(["scout", "planner"], (details) => emitted.push(details.progress));

  tracker.onToolEvent(0, { type: "tool_start", toolCallId: "a", toolName: "read" });

  const last = emitted[emitted.length - 1];
  assert.deepEqual(last[1], { agent: "planner", toolCount: 0, runningTools: [], done: false });
});

test("createProgressTracker: emits a fresh array reference on every event", () => {
  const emitted: Array<readonly TaskProgress[]> = [];
  const tracker = createProgressTracker(["scout", "planner"], (details) => emitted.push(details.progress));

  tracker.onToolEvent(0, { type: "tool_start", toolCallId: "a", toolName: "read" });
  tracker.markTaskDone(0);

  assert.notEqual(emitted[0], emitted[1]);
});

test("createProgressTracker: onToolEvent is a no-op for an index already marked done", () => {
  const emitted: Array<readonly TaskProgress[]> = [];
  const tracker = createProgressTracker(["scout", "planner"], (details) => emitted.push(details.progress));

  tracker.markTaskDone(0);
  const emitCountAfterDone = emitted.length;

  tracker.onToolEvent(0, { type: "tool_start", toolCallId: "x", toolName: "read" });

  assert.equal(emitted.length, emitCountAfterDone);
  const last = emitted[emitted.length - 1];
  assert.deepEqual(last[0], { agent: "scout", toolCount: 0, runningTools: [], done: true });
});

test("createProgressTracker: markTaskDone only marks its own slot done", () => {
  const emitted: Array<readonly TaskProgress[]> = [];
  const tracker = createProgressTracker(["scout", "planner"], (details) => emitted.push(details.progress));

  tracker.markTaskDone(1);

  const last = emitted[emitted.length - 1];
  assert.equal(last[0].done, false);
  assert.equal(last[1].done, true);
});
