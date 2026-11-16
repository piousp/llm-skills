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
    textSplit: false,
    thinkingSplit: false,
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

// --- word-aware splitting ---

const wordsTo = (n: number) => "word ".repeat(Math.ceil(n / 5)).slice(0, n);

test("a split cuts at whitespace so a word straddling deltas stays whole", () => {
  let state = initialTranscriptState();
  state = applySessionEvent(state, textDelta(wordsTo(SEGMENT_SPLIT_CHARS - 6) + " subag"));
  state = applySessionEvent(state, textDelta("ent_job"));
  const entry = state.entries[0];
  assert.ok(entry && entry.kind === "text" && entry.content.endsWith(" "));
  assert.ok(state.currentText.startsWith("subagent_job"));
});

test("a newline inside the window wins over later spaces", () => {
  const head = wordsTo(1500) + "\n";
  let state = initialTranscriptState();
  state = applySessionEvent(state, textDelta(head + wordsTo(600)));
  const entry = state.entries[0];
  assert.equal(entry && entry.kind === "text" ? entry.content : undefined, head);
  assert.equal(state.currentText, wordsTo(600));
});

test("chars equals the stored entry lengths after a cut with a remainder", () => {
  let state = initialTranscriptState();
  state = applySessionEvent(state, textDelta(wordsTo(SEGMENT_SPLIT_CHARS + 50) + "zz"));
  assert.ok(state.currentText.length > 0);
  const sum = state.entries.reduce((n, e) => n + (e.kind === "text" ? e.content.length : 0), 0);
  assert.equal(state.chars, sum);
});

test("entries plus the live remainder reproduce the emitted text exactly", () => {
  const emitted = wordsTo(SEGMENT_SPLIT_CHARS * 3 + 17);
  let state = initialTranscriptState();
  for (let i = 0; i < emitted.length; i += 7) state = applySessionEvent(state, textDelta(emitted.slice(i, i + 7)));
  const stored = state.entries.map((e) => (e.kind === "text" ? e.content : "")).join("");
  assert.equal(stored + state.currentText, emitted);
});

test("text_end after a split that left no remainder does not duplicate the block", () => {
  let state = initialTranscriptState();
  state = applySessionEvent(state, textDelta("x".repeat(SEGMENT_SPLIT_CHARS + 1)));
  state = applySessionEvent(state, textEnd("x".repeat(SEGMENT_SPLIT_CHARS + 1)));
  assert.equal(state.entries.length, 1);
  assert.equal(state.textSplit, false);
});

test("thinking_end after a split that left no remainder does not duplicate the block", () => {
  let state = initialTranscriptState();
  state = applySessionEvent(state, thinkingDelta("x".repeat(SEGMENT_SPLIT_CHARS + 1)));
  state = applySessionEvent(state, thinkingEnd("x".repeat(SEGMENT_SPLIT_CHARS + 1)));
  assert.equal(state.entries.length, 1);
  assert.equal(state.thinkingSplit, false);
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

// --- message_end closes open runs ---

const messageEnd = asEvent({ type: "message_end", message: {} });
const fold = (events: AgentSessionEvent[]) => events.reduce(applySessionEvent, initialTranscriptState());
const contents = (state: ReturnType<typeof fold>) =>
  state.entries.map((e) => (e.kind === "text" || e.kind === "thinking" ? e.content : ""));

test("message_end stores an open text run when no text_end arrived", () => {
  const state = fold([textDelta("abc"), messageEnd, textEnd("whole")]);
  assert.deepEqual(contents(state), ["abc", "whole"]);
});

test("message_end clears a text split flag so a later text_end is not swallowed", () => {
  const state = fold([textDelta("x".repeat(SEGMENT_SPLIT_CHARS + 1)), messageEnd, textEnd("whole")]);
  assert.equal(state.entries.length, 2);
  assert.equal(state.textSplit, false);
});

test("message_end keeps the partial and the retry run apart", () => {
  const state = fold([textDelta("partial"), messageEnd, textDelta("retry"), textEnd("")]);
  assert.deepEqual(contents(state), ["partial", "retry"]);
});

test("message_end clears a thinking split flag so a later thinking_end is not swallowed", () => {
  const state = fold([thinkingDelta("x".repeat(SEGMENT_SPLIT_CHARS + 1)), messageEnd, thinkingEnd("whole")]);
  assert.equal(state.entries.length, 2);
  assert.equal(state.thinkingSplit, false);
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

test("a single entry above MAX_TRANSCRIPT_CHARS evicts everything before it, chars stays exact", () => {
  let state = initialTranscriptState();
  for (let i = 0; i < 3; i += 1) state = applySessionEvent(state, toolEnd(`t${i}`, `r${i}`));
  assert.equal(state.entries.length, 3);

  state = applySessionEvent(state, textEnd("x".repeat(MAX_TRANSCRIPT_CHARS + 1)));
  assert.equal(state.entries.length, 0); // the oversized entry cannot fit either
  assert.equal(state.chars, 0);
  assert.equal(state.dropped, 4); // 3 older + the oversized one
  assert.ok(!state.entries.some((e) => e.kind === "tool-end"));
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

test("createTranscriptSink: snapshot() is the same object until an event changes the state", () => {
  const sink = createTranscriptSink();
  sink.onSessionEvent(toolStart("t1", "read", { path: "a.ts" }));
  const first = sink.snapshot();
  assert.equal(sink.snapshot(), first);

  sink.onSessionEvent(asEvent({ type: "tool_execution_update", toolCallId: "t1", toolName: "read", args: {}, partialResult: "p" }));
  assert.equal(sink.snapshot(), first);

  sink.onSessionEvent(textDelta("hi"));
  assert.notEqual(sink.snapshot(), first);
});
