import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialTaskProgress,
  applyToolEvent,
  markDone,
  buildProgressLines,
  buildProgressStream,
  createProgressTracker,
  toSubagentToolEvent,
  type TaskProgress,
  type ProgressTheme,
} from "../../src/progress.ts";
import type { RunUsage } from "../../src/usage.ts";

const sampleUsage: RunUsage = {
  input: 12500, output: 840, cacheRead: 1_200_000, cacheWrite: 3000,
  cost: 0.4123, isSubscription: false,
  context: { percent: 12.34, window: 200000 },
};
const sampleUsageFooter = "\u219113k \u2193840 R1.2M W3.0k CH98.7% $0.412 12.3%/200k";

const fakeTheme: ProgressTheme = {
  fg: (c, t) => `<${c}>${t}</${c}>`,
};

test("initialTaskProgress: returns zeroed progress for the given agent", () => {
  const p = initialTaskProgress("scout");
  assert.deepEqual(p, { agent: "scout", runningTools: [], history: [], done: false });
});

test("applyToolEvent: tool_start appends to runningTools and history", () => {
  const initial = initialTaskProgress("scout");
  const p = applyToolEvent(initial, { type: "tool_start", toolCallId: "a", toolName: "read", summary: "read foo.ts" });
  assert.deepEqual(p.runningTools, [{ toolCallId: "a", toolName: "read" }]);
  assert.deepEqual(p.history, ["read foo.ts"]);
});

test("applyToolEvent: tool_end removes only the matching running tool, history is untouched", () => {
  let p = initialTaskProgress("scout");
  p = applyToolEvent(p, { type: "tool_start", toolCallId: "a", toolName: "read", summary: "read foo.ts" });
  p = applyToolEvent(p, { type: "tool_start", toolCallId: "b", toolName: "grep", summary: "grep /x/" });
  p = applyToolEvent(p, { type: "tool_end", toolCallId: "a" });
  assert.deepEqual(p.runningTools, [{ toolCallId: "b", toolName: "grep" }]);
  assert.deepEqual(p.history, ["read foo.ts", "grep /x/"]);
});

test("applyToolEvent: tool_end with unknown toolCallId is a no-op", () => {
  let p = initialTaskProgress("scout");
  p = applyToolEvent(p, { type: "tool_start", toolCallId: "a", toolName: "read", summary: "read foo.ts" });
  const before = p.runningTools;
  const after = applyToolEvent(p, { type: "tool_end", toolCallId: "unknown" });
  assert.deepEqual(after.runningTools, before);
});

test("applyToolEvent: history preserves arrival order across interleaved starts/ends", () => {
  let p = initialTaskProgress("scout");
  p = applyToolEvent(p, { type: "tool_start", toolCallId: "a", toolName: "read", summary: "read a.ts" });
  p = applyToolEvent(p, { type: "tool_end", toolCallId: "a" });
  p = applyToolEvent(p, { type: "tool_start", toolCallId: "b", toolName: "grep", summary: "grep /x/" });
  assert.deepEqual(p.history, ["read a.ts", "grep /x/"]);
});

test("markDone: sets done true, clears runningTools, preserves history", () => {
  let p = initialTaskProgress("scout");
  p = applyToolEvent(p, { type: "tool_start", toolCallId: "a", toolName: "read", summary: "read foo.ts" });
  const done = markDone(p);
  assert.equal(done.done, true);
  assert.equal(done.agent, p.agent);
  assert.deepEqual(done.history, p.history);
  assert.deepEqual(done.runningTools, []);
});

test("markDone: called without usage does not add the usage key", () => {
  const p = initialTaskProgress("scout");
  const done = markDone(p);
  assert.equal("usage" in done, false);
});

test("markDone: called with usage attaches it, history stays intact", () => {
  let p = initialTaskProgress("scout");
  p = applyToolEvent(p, { type: "tool_start", toolCallId: "a", toolName: "read", summary: "read foo.ts" });
  const done = markDone(p, sampleUsage);
  assert.equal(done.usage, sampleUsage);
  assert.deepEqual(done.history, p.history);
});

test("applyToolEvent: returns a new object and does not mutate the original runningTools array", () => {
  const p: TaskProgress = initialTaskProgress("scout");
  const originalRunningTools = p.runningTools;
  const event = { type: "tool_start" as const, toolCallId: "a", toolName: "read", summary: "read foo.ts" };
  const next = applyToolEvent(p, event);
  assert.notEqual(next, p);
  assert.equal(p.runningTools, originalRunningTools);
  assert.equal(originalRunningTools.length, 0);
});

test("buildProgressLines: one task, one running tool renders accent agent, dim tool count and running tool name", () => {
  const p: TaskProgress = {
    agent: "scout",
    runningTools: [{ toolCallId: "a", toolName: "read" }],
    history: ["read foo.ts"],
    done: false,
  };

  const result = buildProgressLines([p], fakeTheme);

  assert.equal(result, "<accent>scout</accent> <dim>\u00b7 tools: 1 \u00b7 running: read</dim>");
});

test("buildProgressLines: two running tools list names in start order", () => {
  const p: TaskProgress = {
    agent: "scout",
    runningTools: [
      { toolCallId: "a", toolName: "read" },
      { toolCallId: "b", toolName: "grep" },
    ],
    history: ["read foo.ts", "grep /x/"],
    done: false,
  };

  const result = buildProgressLines([p], fakeTheme);

  assert.equal(result, "<accent>scout</accent> <dim>\u00b7 tools: 2 \u00b7 running: read, grep</dim>");
});

test("buildProgressLines: no running tools, not done renders working\u2026", () => {
  const p: TaskProgress = { agent: "scout", runningTools: [], history: [], done: false };

  const result = buildProgressLines([p], fakeTheme);

  assert.equal(result, "<accent>scout</accent> <dim>\u00b7 tools: 0 \u00b7 working\u2026</dim>");
});

test("buildProgressLines: done true renders done regardless of runningTools", () => {
  const p: TaskProgress = {
    agent: "scout",
    runningTools: [{ toolCallId: "a", toolName: "read" }],
    history: ["read a.ts", "read b.ts", "read c.ts"],
    done: true,
  };

  const result = buildProgressLines([p], fakeTheme);

  assert.equal(result, "<accent>scout</accent> <dim>\u00b7 tools: 3 \u00b7 done</dim>");
});

test("buildProgressLines: done with usage appends the usage footer after the status", () => {
  const p: TaskProgress = { agent: "scout", runningTools: [], history: [], done: true, usage: sampleUsage };

  const result = buildProgressLines([p], fakeTheme);

  assert.equal(
    result,
    `<accent>scout</accent> <dim>\u00b7 tools: 0 \u00b7 done \u00b7 ${sampleUsageFooter}</dim>`,
  );
});

test("buildProgressLines: not done with usage does not render the footer (footer only appears once settled)", () => {
  const p: TaskProgress = { agent: "scout", runningTools: [], history: [], done: false, usage: sampleUsage };

  const result = buildProgressLines([p], fakeTheme);

  assert.equal(result, "<accent>scout</accent> <dim>\u00b7 tools: 0 \u00b7 working\u2026</dim>");
});

test("buildProgressLines: done with a usage that renders empty omits the footer segment", () => {
  const emptyRunUsage: RunUsage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, isSubscription: false, context: undefined,
  };
  const p: TaskProgress = { agent: "scout", runningTools: [], history: [], done: true, usage: emptyRunUsage };

  const result = buildProgressLines([p], fakeTheme);

  assert.equal(result, "<accent>scout</accent> <dim>\u00b7 tools: 0 \u00b7 done</dim>");
});

test("buildProgressLines: two tasks render two lines joined by newline in input order", () => {
  const p1: TaskProgress = { agent: "scout", runningTools: [], history: [], done: false };
  const p2: TaskProgress = { agent: "web-scout", runningTools: [], history: ["read a.ts", "read b.ts"], done: true };

  const result = buildProgressLines([p1, p2], fakeTheme);

  assert.equal(
    result,
    "<accent>scout</accent> <dim>\u00b7 tools: 0 \u00b7 working\u2026</dim>\n"
      + "<accent>web-scout</accent> <dim>\u00b7 tools: 2 \u00b7 done</dim>",
  );
});

test("buildProgressStream: single task, empty history renders only the status line (same as buildProgressLines)", () => {
  const p: TaskProgress = { agent: "scout", runningTools: [], history: [], done: false };

  const result = buildProgressStream([p], fakeTheme);

  assert.equal(result, buildProgressLines([p], fakeTheme));
});

test("buildProgressStream: single task with history renders the status line followed by indented dim entries in order", () => {
  const p: TaskProgress = {
    agent: "scout",
    runningTools: [{ toolCallId: "a", toolName: "grep" }],
    history: ["read foo.ts", "grep /x/"],
    done: false,
  };

  const result = buildProgressStream([p], fakeTheme);

  assert.equal(
    result,
    "<accent>scout</accent> <dim>\u00b7 tools: 2 \u00b7 running: grep</dim>\n"
      + "  <dim>read foo.ts</dim>\n"
      + "  <dim>grep /x/</dim>",
  );
});

test("buildProgressStream: two tasks render each block in input order", () => {
  const p1: TaskProgress = { agent: "scout", runningTools: [], history: ["read a.ts"], done: false };
  const p2: TaskProgress = { agent: "web-scout", runningTools: [], history: [], done: true };

  const result = buildProgressStream([p1, p2], fakeTheme);

  assert.equal(
    result,
    "<accent>scout</accent> <dim>\u00b7 tools: 1 \u00b7 working\u2026</dim>\n"
      + "  <dim>read a.ts</dim>\n"
      + "<accent>web-scout</accent> <dim>\u00b7 tools: 0 \u00b7 done</dim>",
  );
});

test("buildProgressStream: done with usage puts the footer on the header line, history lines untouched", () => {
  const p: TaskProgress = {
    agent: "scout",
    runningTools: [],
    history: ["read foo.ts"],
    done: true,
    usage: sampleUsage,
  };

  const result = buildProgressStream([p], fakeTheme);

  assert.equal(
    result,
    `<accent>scout</accent> <dim>\u00b7 tools: 1 \u00b7 done \u00b7 ${sampleUsageFooter}</dim>\n`
      + "  <dim>read foo.ts</dim>",
  );
});

test("toSubagentToolEvent: tool_execution_start maps args through formatToolCall into summary", () => {
  const event = toSubagentToolEvent({
    type: "tool_execution_start",
    toolCallId: "a",
    toolName: "read",
    args: { path: "a.ts" },
  } as any);

  assert.deepEqual(event, { type: "tool_start", toolCallId: "a", toolName: "read", summary: "read a.ts" });
});

test("toSubagentToolEvent: tool_execution_end maps without a summary", () => {
  const event = toSubagentToolEvent({
    type: "tool_execution_end",
    toolCallId: "a",
    toolName: "read",
    result: "big content",
    isError: false,
  } as any);

  assert.deepEqual(event, { type: "tool_end", toolCallId: "a" });
});

test("toSubagentToolEvent: tool_execution_update is ignored", () => {
  const event = toSubagentToolEvent({
    type: "tool_execution_update",
    toolCallId: "a",
    toolName: "read",
    args: {},
    partialResult: {},
  } as any);

  assert.equal(event, undefined);
});

test("createProgressTracker: onToolEvent on one index leaves other tasks' progress untouched", () => {
  const emitted: Array<readonly TaskProgress[]> = [];
  const tracker = createProgressTracker(["scout", "planner"], (details) => emitted.push(details.progress));

  tracker.onToolEvent(0, { type: "tool_start", toolCallId: "a", toolName: "read", summary: "read foo.ts" });

  const last = emitted[emitted.length - 1];
  assert.deepEqual(last[1], { agent: "planner", runningTools: [], history: [], done: false });
});

test("createProgressTracker: emits a fresh array reference on every event", () => {
  const emitted: Array<readonly TaskProgress[]> = [];
  const tracker = createProgressTracker(["scout", "planner"], (details) => emitted.push(details.progress));

  tracker.onToolEvent(0, { type: "tool_start", toolCallId: "a", toolName: "read", summary: "read foo.ts" });
  tracker.markTaskDone(0);

  assert.notEqual(emitted[0], emitted[1]);
});

test("createProgressTracker: onToolEvent is a no-op for an index already marked done", () => {
  const emitted: Array<readonly TaskProgress[]> = [];
  const tracker = createProgressTracker(["scout", "planner"], (details) => emitted.push(details.progress));

  tracker.markTaskDone(0);
  const emitCountAfterDone = emitted.length;

  tracker.onToolEvent(0, { type: "tool_start", toolCallId: "x", toolName: "read", summary: "read foo.ts" });

  assert.equal(emitted.length, emitCountAfterDone);
  const last = emitted[emitted.length - 1];
  assert.deepEqual(last[0], { agent: "scout", runningTools: [], history: [], done: true });
});

test("createProgressTracker: markTaskDone only marks its own slot done", () => {
  const emitted: Array<readonly TaskProgress[]> = [];
  const tracker = createProgressTracker(["scout", "planner"], (details) => emitted.push(details.progress));

  tracker.markTaskDone(1);

  const last = emitted[emitted.length - 1];
  assert.equal(last[0].done, false);
  assert.equal(last[1].done, true);
});

test("createProgressTracker: markTaskDone with usage attaches usage only to its own slot", () => {
  const emitted: Array<readonly TaskProgress[]> = [];
  const tracker = createProgressTracker(["scout", "planner"], (details) => emitted.push(details.progress));

  tracker.markTaskDone(1, sampleUsage);

  const last = emitted[emitted.length - 1];
  assert.equal("usage" in last[0], false);
  assert.equal(last[1].usage, sampleUsage);
});
