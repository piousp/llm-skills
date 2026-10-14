import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialTranscriptState,
  applySessionEvent,
  createTranscriptSink,
  MAX_TRANSCRIPT_ENTRIES,
  MAX_TRANSCRIPT_CHARS,
  SEGMENT_SPLIT_CHARS,
  TOOL_RESULT_MAX_CHARS,
} from "../../src/transcript.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

// Synthetic AgentSessionEvent literals (progress.test.ts style): the exact
// SDK shapes are not needed, only the fields transcript.ts actually reads.
function asEvent(value: unknown): AgentSessionEvent {
  return value as AgentSessionEvent;
}

function messageUpdate(assistantMessageEvent: Record<string, unknown>): AgentSessionEvent {
  return asEvent({ type: "message_update", message: {}, assistantMessageEvent });
}
function textDelta(delta: string): AgentSessionEvent {
  return messageUpdate({ type: "text_delta", delta });
}
function textEnd(content: string): AgentSessionEvent {
  return messageUpdate({ type: "text_end", content });
}
function thinkingDelta(delta: string): AgentSessionEvent {
  return messageUpdate({ type: "thinking_delta", delta });
}
function thinkingEnd(content: string): AgentSessionEvent {
  return messageUpdate({ type: "thinking_end", content });
}
function toolStart(toolCallId: string, toolName: string, args: unknown): AgentSessionEvent {
  return asEvent({ type: "tool_execution_start", toolCallId, toolName, args });
}
function toolEnd(toolCallId: string, result: unknown, isError = false, durationMs?: number): AgentSessionEvent {
  // durationMs is optional on the event: included only when supplied, so
  // the 1.0.x (field-absent) shape is what the fold actually receives.
  const base: Record<string, unknown> = { type: "tool_execution_end", toolCallId, toolName: "read", result, isError };
  if (durationMs !== undefined) base.durationMs = durationMs;
  return asEvent(base);
}

// --- initialTranscriptState ---

test("initialTranscriptState: zeroed, empty, unbounded counters", () => {
  assert.deepEqual(initialTranscriptState(), {
    entries: [],
    currentText: "",
    currentThinking: "",
    dropped: 0,
    chars: 0,
  });
});

// --- text deltas ---

test("text deltas accumulate into currentText without entries", () => {
  let state = initialTranscriptState();
  state = applySessionEvent(state, textDelta("hello "));
  state = applySessionEvent(state, textDelta("world"));
  assert.equal(state.currentText, "hello world");
  assert.equal(state.currentThinking, "");
  assert.equal(state.entries.length, 0);
});

test("a no-op delta is identity: the same state object comes back", () => {
  const state = initialTranscriptState();
  assert.equal(applySessionEvent(state, textDelta("")), state);
});

test("text_end finalizes the accumulated deltas into one entry, not end.content", () => {
  let state = initialTranscriptState();
  state = applySessionEvent(state, textDelta("deltas are "));
  state = applySessionEvent(state, textDelta("truth"));
  // end.content ("authoritative") must NOT rewrite the live deltas (lens pin)
  state = applySessionEvent(state, textEnd("something entirely different"));
  assert.deepEqual(state.entries.map((e) => e.kind), ["text"]);
  const entry = state.entries[0];
  assert.equal(entry && entry.kind === "text" ? entry.content : undefined, "deltas are truth");
  assert.equal(state.currentText, "");
});

test("text_end with an empty accumulator and no content is a no-op", () => {
  const state = applySessionEvent(initialTranscriptState(), textEnd(""));
  assert.equal(state.entries.length, 0);
  assert.equal(state.currentText, "");
});

// --- splitting ---

test("accumulated text exceeding SEGMENT_SPLIT_CHARS pushes an entry and resets the run", () => {
  let state = initialTranscriptState();
  state = applySessionEvent(state, textDelta("a".repeat(SEGMENT_SPLIT_CHARS)));
  assert.equal(state.entries.length, 0); // AT the split threshold: not exceeding
  state = applySessionEvent(state, textDelta("b"));
  assert.deepEqual(state.entries.map((e) => e.kind), ["text"]);
  const entry = state.entries[0];
  assert.equal(entry && entry.kind === "text" ? entry.content : undefined, "a".repeat(SEGMENT_SPLIT_CHARS) + "b");
  assert.equal(state.currentText, "");
});

test("a single delta larger than SEGMENT_SPLIT_CHARS splits immediately", () => {
  let state = initialTranscriptState();
  state = applySessionEvent(state, textDelta("x".repeat(SEGMENT_SPLIT_CHARS + 1)));
  assert.equal(state.entries.length, 1);
  assert.equal(state.currentText, "");
});

test("text_end finalizes the remainder accumulated after a split", () => {
  let state = initialTranscriptState();
  state = applySessionEvent(state, textDelta("x".repeat(SEGMENT_SPLIT_CHARS + 1)));
  state = applySessionEvent(state, textDelta("tail"));
  state = applySessionEvent(state, textEnd(""));
  assert.deepEqual(state.entries.map((e) => e.kind), ["text", "text"]);
  const last = state.entries[1];
  assert.equal(last && last.kind === "text" ? last.content : undefined, "tail");
  assert.equal(state.currentText, "");
});

// --- thinking deltas ---

test("thinking deltas mirror the text pipeline", () => {
  let state = initialTranscriptState();
  state = applySessionEvent(state, thinkingDelta("hmm "));
  state = applySessionEvent(state, thinkingDelta("ok"));
  assert.equal(state.currentThinking, "hmm ok");
  assert.equal(state.currentText, "");
  state = applySessionEvent(state, thinkingEnd(""));
  assert.deepEqual(state.entries.map((e) => e.kind), ["thinking"]);
  const entry = state.entries[0];
  assert.equal(entry && entry.kind === "thinking" ? entry.content : undefined, "hmm ok");
  assert.equal(state.currentThinking, "");
});

test("thinking_end with no deltas pushes the redacted/complete-at-start content once", () => {
  let state = initialTranscriptState();
  state = applySessionEvent(state, thinkingEnd("redacted reasoning"));
  assert.deepEqual(state.entries.map((e) => e.kind), ["thinking"]);
  const entry = state.entries[0];
  assert.equal(entry && entry.kind === "thinking" ? entry.content : undefined, "redacted reasoning");
});

// --- tool events ---

test("tool_execution_start pushes a tool-start entry labeled by formatToolCall", () => {
  const state = applySessionEvent(initialTranscriptState(), toolStart("t1", "read", { path: "a.ts" }));
  assert.deepEqual(state.entries.map((e) => e.kind), ["tool-start"]);
  const entry = state.entries[0];
  assert.equal(entry && entry.kind === "tool-start" ? entry.toolCallId : undefined, "t1");
  assert.equal(entry && entry.kind === "tool-start" ? entry.label : undefined, "read a.ts");
});

test("tool_execution_end: string results take the truncated first line", () => {
  let state = initialTranscriptState();
  state = applySessionEvent(state, toolEnd("t1", "line one\nline two"));
  const entry = state.entries[0];
  assert.equal(entry && entry.kind === "tool-end" ? entry.ok : undefined, true);
  assert.equal(entry && entry.kind === "tool-end" ? entry.summary : undefined, "line one");
});

test("tool_execution_end: long results are capped at TOOL_RESULT_MAX_CHARS", () => {
  const state = applySessionEvent(initialTranscriptState(), toolEnd("t1", "x".repeat(1000)));
  const entry = state.entries[0];
  const summary = entry && entry.kind === "tool-end" ? entry.summary : undefined;
  assert.equal(summary?.length, TOOL_RESULT_MAX_CHARS);
  assert.match(summary ?? "", /\u2026$/);
});

test("tool_execution_end: object results prefer content[0].text", () => {
  const state = applySessionEvent(
    initialTranscriptState(),
    toolEnd("t1", { content: [{ type: "text", text: "from content" }], details: {} }),
  );
  const entry = state.entries[0];
  assert.equal(entry && entry.kind === "tool-end" ? entry.summary : undefined, "from content");
});

test("tool_execution_end: object results without text content fall back to the JSON head", () => {
  const state = applySessionEvent(initialTranscriptState(), toolEnd("t1", { foo: "bar" }));
  const entry = state.entries[0];
  assert.equal(entry && entry.kind === "tool-end" ? entry.summary : undefined, `{"foo":"bar"}`);
});

test("tool_execution_end: isError marks ok=false", () => {
  const state = applySessionEvent(initialTranscriptState(), toolEnd("t1", "boom", true));
  const entry = state.entries[0];
  assert.equal(entry && entry.kind === "tool-end" ? entry.ok : undefined, false);
});

test("tool_execution_end with durationMs carries it onto the tool-end entry", () => {
  const state = applySessionEvent(initialTranscriptState(), toolEnd("t1", "done", false, 1234));
  const entry = state.entries[0];
  assert.equal(entry && entry.kind === "tool-end" ? entry.durationMs : undefined, 1234);
});

test("tool_execution_end without durationMs leaves the field absent (1.0.x shape)", () => {
  const state = applySessionEvent(initialTranscriptState(), toolEnd("t1", "done"));
  const entry = state.entries[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.kind, "tool-end");
  // Byte-identical to the pre-1.3.3 shape: no own property at all.
  assert.ok(!("durationMs" in entry), "no own durationMs property on 1.0.x entries");
});

test("durationMs changes no eviction budget: entries, dropped and chars match the no-duration fold", () => {
  // storedChars counts only strings (summary/label/content); a numeric
  // optional field must not leak into the head-eviction math.
  let withDuration = initialTranscriptState();
  let withoutDuration = initialTranscriptState();
  for (let i = 0; i < MAX_TRANSCRIPT_ENTRIES + 5; i += 1) {
    withDuration = applySessionEvent(withDuration, toolEnd(`t${i}`, `r${i}`, false, 1234));
    withoutDuration = applySessionEvent(withoutDuration, toolEnd(`t${i}`, `r${i}`));
  }
  assert.equal(withDuration.entries.length, withoutDuration.entries.length);
  assert.equal(withDuration.dropped, withoutDuration.dropped);
  assert.equal(withDuration.chars, withoutDuration.chars);
});

// --- identity / ignored events ---

test("tool_execution_update is identity: the same state object comes back", () => {
  const state = initialTranscriptState();
  const next = applySessionEvent(state, asEvent({ type: "tool_execution_update", toolCallId: "t1", toolName: "read", args: {}, partialResult: "p" }));
  assert.equal(next, state);
});

test("unknown events are identity: message_end, queue_update, whatever else", () => {
  const state = initialTranscriptState();
  assert.equal(applySessionEvent(state, asEvent({ type: "message_end", message: {} })), state);
  assert.equal(applySessionEvent(state, asEvent({ type: "queue_update", steering: [], followUp: [] })), state);
  assert.equal(applySessionEvent(state, asEvent({ type: "session_start" })), state);
});

// --- eviction ---

test("entry-cap eviction drops the oldest entries and increments dropped", () => {
  let state = initialTranscriptState();
  for (let i = 0; i < MAX_TRANSCRIPT_ENTRIES + 5; i += 1) {
    state = applySessionEvent(state, toolEnd(`t${i}`, `r${i}`));
  }
  assert.equal(state.entries.length, MAX_TRANSCRIPT_ENTRIES);
  assert.equal(state.dropped, 5);
  const first = state.entries[0];
  assert.equal(first && first.kind === "tool-end" ? first.summary : undefined, "r5"); // oldest five evicted
  // seq stays monotonic across evictions.
  assert.equal(state.entries.at(-1)?.seq, MAX_TRANSCRIPT_ENTRIES + 4);
});

test("char-cap eviction drops the oldest entry when the total exceeds MAX_TRANSCRIPT_CHARS", () => {
  let state = initialTranscriptState();
  const chunk = "c".repeat(1990); // under SEGMENT_SPLIT_CHARS, finalized per pair by text_end
  for (let i = 0; i < 64; i += 1) {
    state = applySessionEvent(state, textDelta(chunk));
    state = applySessionEvent(state, textEnd(""));
  }
  assert.equal(state.entries.length, 64); // 64 * 1990 = 127,360 <= 128,000
  assert.equal(state.dropped, 0);

  state = applySessionEvent(state, textDelta(chunk));
  state = applySessionEvent(state, textEnd("")); // 129,350 > 128,000 -> evict the head
  assert.equal(state.entries.length, 64);
  assert.equal(state.dropped, 1);
  assert.equal(state.entries[0]?.seq, 1);
  assert.equal(state.entries.at(-1)?.seq, 64);
});

// --- sink ---

test("createTranscriptSink: onSessionEvent folds events, snapshot reflects them", () => {
  const sink = createTranscriptSink();
  sink.onSessionEvent(textDelta("hi"));
  sink.onSessionEvent(textEnd(""));
  const snap = sink.snapshot();
  assert.equal(snap.entries.length, 1);
  assert.equal(snap.currentText, "");
});

test("createTranscriptSink: snapshot is isolated from later mutations", () => {
  const sink = createTranscriptSink();
  sink.onSessionEvent(textDelta("hi"));
  sink.onSessionEvent(textEnd(""));
  const snap = sink.snapshot();
  sink.onSessionEvent(toolStart("t1", "read", { path: "a.ts" }));
  assert.equal(snap.entries.length, 1); // old snapshot untouched
  assert.equal(sink.snapshot().entries.length, 2);
});
