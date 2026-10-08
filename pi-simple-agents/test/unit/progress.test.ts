import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialTaskProgress,
  applyToolEvent,
  applyProgressEvent,
  markDone,
  buildProgressLine,
  createProgressTracker,
  toSubagentToolEvent,
  toStreamPhaseEvent,
  shortToolName,
  activityWord,
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

test("buildProgressLine: one running tool renders accent agent, dim tool count and running tool name", () => {
  const p: TaskProgress = {
    agent: "scout",
    runningTools: [{ toolCallId: "a", toolName: "read" }],
    history: ["read foo.ts"],
    done: false,
  };

  const result = buildProgressLine(p, fakeTheme);

  assert.equal(result, "<accent>scout</accent> <dim>\u00b7 tools: 1 \u00b7 running: read</dim>");
});

test("buildProgressLine: two running tools list names in start order", () => {
  const p: TaskProgress = {
    agent: "scout",
    runningTools: [
      { toolCallId: "a", toolName: "read" },
      { toolCallId: "b", toolName: "grep" },
    ],
    history: ["read foo.ts", "grep /x/"],
    done: false,
  };

  const result = buildProgressLine(p, fakeTheme);

  assert.equal(result, "<accent>scout</accent> <dim>\u00b7 tools: 2 \u00b7 running: read, grep</dim>");
});

test("buildProgressLine: no running tools, not done renders working\u2026", () => {
  const p: TaskProgress = { agent: "scout", runningTools: [], history: [], done: false };

  const result = buildProgressLine(p, fakeTheme);

  assert.equal(result, "<accent>scout</accent> <dim>\u00b7 tools: 0 \u00b7 working\u2026</dim>");
});

test("buildProgressLine: done true renders done regardless of runningTools", () => {
  const p: TaskProgress = {
    agent: "scout",
    runningTools: [{ toolCallId: "a", toolName: "read" }],
    history: ["read a.ts", "read b.ts", "read c.ts"],
    done: true,
  };

  const result = buildProgressLine(p, fakeTheme);

  assert.equal(result, "<accent>scout</accent> <dim>\u00b7 tools: 3 \u00b7 done</dim>");
});

test("buildProgressLine: done with usage appends the usage footer after the status", () => {
  const p: TaskProgress = { agent: "scout", runningTools: [], history: [], done: true, usage: sampleUsage };

  const result = buildProgressLine(p, fakeTheme);

  assert.equal(
    result,
    `<accent>scout</accent> <dim>\u00b7 tools: 0 \u00b7 done \u00b7 ${sampleUsageFooter}</dim>`,
  );
});

test("buildProgressLine: not done with usage does not render the footer (footer only appears once settled)", () => {
  const p: TaskProgress = { agent: "scout", runningTools: [], history: [], done: false, usage: sampleUsage };

  const result = buildProgressLine(p, fakeTheme);

  assert.equal(result, "<accent>scout</accent> <dim>\u00b7 tools: 0 \u00b7 working\u2026</dim>");
});

test("buildProgressLine: done with a usage that renders empty omits the footer segment", () => {
  const emptyRunUsage: RunUsage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, isSubscription: false, context: undefined,
  };
  const p: TaskProgress = { agent: "scout", runningTools: [], history: [], done: true, usage: emptyRunUsage };

  const result = buildProgressLine(p, fakeTheme);

  assert.equal(result, "<accent>scout</accent> <dim>\u00b7 tools: 0 \u00b7 done</dim>");
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

test("createProgressTracker: emits a new TaskProgress on every event", () => {
  const emitted: TaskProgress[] = [];
  const tracker = createProgressTracker("scout", (p) => emitted.push(p));

  tracker.onEvent({ type: "tool_start", toolCallId: "a", toolName: "read", summary: "read foo.ts" });
  tracker.markTaskDone();

  assert.equal(emitted.length, 2);
  assert.notEqual(emitted[0], emitted[1]);
  assert.deepEqual(emitted[0].runningTools, [{ toolCallId: "a", toolName: "read" }]);
  assert.equal(emitted[1].done, true);
});

test("createProgressTracker: onEvent after markTaskDone is a no-op (no further emit)", () => {
  const emitted: TaskProgress[] = [];
  const tracker = createProgressTracker("scout", (p) => emitted.push(p));

  tracker.markTaskDone();
  const emitCountAfterDone = emitted.length;

  tracker.onEvent({ type: "tool_start", toolCallId: "x", toolName: "read", summary: "read foo.ts" });

  assert.equal(emitted.length, emitCountAfterDone);
});

test("createProgressTracker: markTaskDone with usage attaches it to the emitted progress", () => {
  const emitted: TaskProgress[] = [];
  const tracker = createProgressTracker("scout", (p) => emitted.push(p));

  tracker.markTaskDone(sampleUsage);

  const last = emitted[emitted.length - 1];
  assert.equal(last.done, true);
  assert.equal(last.usage, sampleUsage);
});

// --- SubagentProgressEvent / applyProgressEvent ---

test("applyProgressEvent: stream_phase sets streamPhase through the thinking -> output transition", () => {
  let p = initialTaskProgress("scout");
  p = applyProgressEvent(p, { type: "stream_phase", phase: "thinking" });
  assert.equal(p.streamPhase, "thinking");
  p = applyProgressEvent(p, { type: "stream_phase", phase: "output" });
  assert.equal(p.streamPhase, "output");
});

test("applyProgressEvent: repeating the stored phase returns the SAME object (per-token delta dedupe)", () => {
  const p = applyProgressEvent(initialTaskProgress("scout"), { type: "stream_phase", phase: "thinking" });
  const again = applyProgressEvent(p, { type: "stream_phase", phase: "thinking" });
  assert.equal(again, p);
});

test("applyProgressEvent: a different phase returns a new object with the rest of the state intact", () => {
  const started = applyToolEvent(initialTaskProgress("scout"), {
    type: "tool_start", toolCallId: "a", toolName: "read", summary: "read foo.ts",
  });
  const next = applyProgressEvent(started, { type: "stream_phase", phase: "output" });
  assert.notEqual(next, started);
  assert.equal(next.streamPhase, "output");
  assert.deepEqual(next.runningTools, started.runningTools);
  assert.deepEqual(next.history, started.history);
});

test("applyProgressEvent: usage event attaches the usage snapshot without touching anything else", () => {
  const started = applyToolEvent(initialTaskProgress("scout"), {
    type: "tool_start", toolCallId: "a", toolName: "read", summary: "read foo.ts",
  });
  const next = applyProgressEvent(started, { type: "usage", usage: sampleUsage });
  assert.equal(next.usage, sampleUsage);
  assert.deepEqual(next.runningTools, started.runningTools);
  assert.deepEqual(next.history, started.history);
  assert.equal(next.done, false);
});

test("applyProgressEvent: tool events delegate to applyToolEvent unchanged", () => {
  const p = applyProgressEvent(initialTaskProgress("scout"), {
    type: "tool_start", toolCallId: "a", toolName: "read", summary: "read foo.ts",
  });
  assert.deepEqual(p.runningTools, [{ toolCallId: "a", toolName: "read" }]);
  assert.equal(p.streamPhase, undefined);
});

// --- toStreamPhaseEvent ---

test("toStreamPhaseEvent: thinking_start/thinking_delta map to thinking", () => {
  for (const type of ["thinking_start", "thinking_delta"]) {
    const event = toStreamPhaseEvent({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type, delta: "x", partial: {} },
    } as any);
    assert.deepEqual(event, { type: "stream_phase", phase: "thinking" });
  }
});

test("toStreamPhaseEvent: text_start/text_delta map to output", () => {
  for (const type of ["text_start", "text_delta"]) {
    const event = toStreamPhaseEvent({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type, delta: "x", partial: {} },
    } as any);
    assert.deepEqual(event, { type: "stream_phase", phase: "output" });
  }
});

test("toStreamPhaseEvent: non-delta assistant events and other session events are ignored", () => {
  for (const assistantType of ["start", "done", "toolcall_delta", "text_end", "thinking_end"]) {
    assert.equal(
      toStreamPhaseEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: assistantType } } as any),
      undefined,
    );
  }
  assert.equal(toStreamPhaseEvent({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: {} } as any), undefined);
  assert.equal(toStreamPhaseEvent({ type: "turn_start" } as any), undefined);
});

// --- shortToolName ---

test("shortToolName: mcp tools collapse to their server name", () => {
  assert.equal(shortToolName("mcp__playwright__navigate"), "playwright");
  assert.equal(shortToolName("mcp__a__b"), "a");
});

test("shortToolName: plain and malformed names pass through unchanged", () => {
  assert.equal(shortToolName("read"), "read");
  assert.equal(shortToolName("mcp__only-one-segment"), "mcp__only-one-segment");
});

// --- activityWord ---

test("activityWord: a running tool wins over everything, named via shortToolName", () => {
  const p: TaskProgress = {
    agent: "scout",
    runningTools: [{ toolCallId: "a", toolName: "read" }],
    history: ["read a.ts"],
    done: false,
    streamPhase: "thinking",
  };
  assert.equal(activityWord(p), "read");
});

test("activityWord: mcp running tool shows the server name", () => {
  const p: TaskProgress = {
    agent: "scout",
    runningTools: [{ toolCallId: "a", toolName: "mcp__playwright__navigate" }],
    history: ["playwright/navigate"],
    done: false,
  };
  assert.equal(activityWord(p), "playwright");
});

test("activityWord: parallel tools show the most recently started one", () => {
  const p: TaskProgress = {
    agent: "scout",
    runningTools: [
      { toolCallId: "a", toolName: "read" },
      { toolCallId: "b", toolName: "grep" },
    ],
    history: ["read a.ts", "grep /x/"],
    done: false,
  };
  assert.equal(activityWord(p), "grep");
});

test("activityWord: no tools falls back to the stream phase", () => {
  assert.equal(activityWord({ agent: "scout", runningTools: [], history: [], done: false, streamPhase: "thinking" }), "thinking");
  assert.equal(activityWord({ agent: "scout", runningTools: [], history: [], done: false, streamPhase: "output" }), "output");
});

test("activityWord: nothing streamed yet is waiting; done is done", () => {
  assert.equal(activityWord(initialTaskProgress("scout")), "waiting");
  assert.equal(activityWord({ agent: "scout", runningTools: [], history: ["read a.ts"], done: true, streamPhase: "output" }), "done");
});

// --- buildProgressLine with streamPhase ---

test("buildProgressLine: no running tools with a stream phase renders the phase instead of working\u2026", () => {
  const p: TaskProgress = { agent: "scout", runningTools: [], history: [], done: false, streamPhase: "thinking" };
  assert.equal(buildProgressLine(p, fakeTheme), "<accent>scout</accent> <dim>\u00b7 tools: 0 \u00b7 thinking</dim>");
});

test("createProgressTracker: two identical stream_phase events emit ONCE (dedupe before widget refresh)", () => {
  const emitted: TaskProgress[] = [];
  const tracker = createProgressTracker("scout", (p) => emitted.push(p));

  tracker.onEvent({ type: "stream_phase", phase: "thinking" });
  tracker.onEvent({ type: "stream_phase", phase: "thinking" });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].streamPhase, "thinking");
});

test("createProgressTracker: a changed phase emits again, usage events emit with the snapshot", () => {
  const emitted: TaskProgress[] = [];
  const tracker = createProgressTracker("scout", (p) => emitted.push(p));

  tracker.onEvent({ type: "stream_phase", phase: "thinking" });
  tracker.onEvent({ type: "stream_phase", phase: "output" });
  tracker.onEvent({ type: "usage", usage: sampleUsage });

  assert.equal(emitted.length, 3);
  assert.equal(emitted[1].streamPhase, "output");
  assert.equal(emitted[2].usage, sampleUsage);
});

test("createProgressTracker: any progress event after markTaskDone is a no-op (guard serves all event types)", () => {
  const emitted: TaskProgress[] = [];
  const tracker = createProgressTracker("scout", (p) => emitted.push(p));

  tracker.markTaskDone();
  const emitCountAfterDone = emitted.length;

  tracker.onEvent({ type: "stream_phase", phase: "thinking" });
  tracker.onEvent({ type: "usage", usage: sampleUsage });
  tracker.onEvent({ type: "tool_start", toolCallId: "x", toolName: "read", summary: "read foo.ts" });

  assert.equal(emitted.length, emitCountAfterDone);
  assert.equal(emitted[emitted.length - 1].streamPhase, undefined);
});
