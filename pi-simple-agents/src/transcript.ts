import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { formatToolCall } from "./format-tool-call.ts";
import { firstLine, truncate } from "./text-utils.ts";

/** Bounded in-memory transcript of a background job's live activity, fed by
 * the raw session events and rendered later by `/subagents peek` (Wave 2).
 * Structure mirrors src/progress.ts: exported types + pure reducers first,
 * the one factory (`createTranscriptSink`) last. */

const MAX_TRANSCRIPT_ENTRIES = 2000;
const MAX_TRANSCRIPT_CHARS = 128_000;
/** Accumulated deltas above this length push a segment entry and reset the
 * run, so one open-ended stream cannot pin state.currentText forever. */
const SEGMENT_SPLIT_CHARS = 2000;
/** First-line preview cap for tool results. */
const TOOL_RESULT_MAX_CHARS = 200;

export { MAX_TRANSCRIPT_ENTRIES, MAX_TRANSCRIPT_CHARS, SEGMENT_SPLIT_CHARS, TOOL_RESULT_MAX_CHARS };

export type TranscriptEntry =
  | { kind: "text"; seq: number; content: string }
  | { kind: "thinking"; seq: number; content: string }
  | { kind: "tool-start"; seq: number; toolCallId: string; label: string }
  | { kind: "tool-end"; seq: number; toolCallId: string; ok: boolean; summary: string; durationMs?: number };

export interface TranscriptState {
  /** Bounded ring: entries[0] is the oldest surviving entry (head-evicted). */
  entries: readonly TranscriptEntry[];
  /** Accumulating text_delta run, cleared per segment/end. */
  currentText: string;
  /** Accumulating thinking_delta run, cleared per segment/end. */
  currentThinking: string;
  /** Count of entries evicted by the caps (never decremented). */
  dropped: number;
  /** Running total of stored entry characters; keeps eviction O(evicted). */
  chars: number;
}

export function initialTranscriptState(): TranscriptState {
  return { entries: [], currentText: "", currentThinking: "", dropped: 0, chars: 0 };
}

/** First-line preview of a tool result: string results use their first line;
 * structured results prefer content[0].text and fall back to the head of the
 * JSONification; JSONification failures degrade to an empty summary. */
function toolResultPreview(result: unknown): string {
  if (typeof result === "string") return firstLine(result);
  const content = (result as { content?: Array<{ text?: string }> })?.content;
  const text = content?.[0]?.text;
  if (typeof text === "string") return firstLine(text);
  try {
    return firstLine(JSON.stringify(result) ?? "");
  } catch {
    return "";
  }
}

// Stored character count of an entry, used to keep `chars` accurate while
// evicting. Each entry carries exactly one content/label/summary string.
function storedChars(entry: TranscriptEntry): number {
  switch (entry.kind) {
    case "text":
    case "thinking":
      return entry.content.length;
    case "tool-start":
      return entry.label.length;
    case "tool-end":
      return entry.summary.length;
  }
}

// An entry before its seq is stamped: same shapes as TranscriptEntry minus
// `seq` (kept as an explicit union — `Omit` over the union would collapse it
// to the common keys and reject the per-variant fields).
export type EntryDraft =
  | { kind: "text"; content: string }
  | { kind: "thinking"; content: string }
  | { kind: "tool-start"; toolCallId: string; label: string }
  | { kind: "tool-end"; toolCallId: string; ok: boolean; summary: string; durationMs?: number };

// The single append point for every entry: assigns a per-transcript
// monotonic seq (dropped + length = entries pushed so far, so it stays
// monotonic across head evictions), then evicts from the head while either
// budget is exceeded.
function pushEntry(
  state: TranscriptState,
  entry: EntryDraft,
  contentChars: number,
): TranscriptState {
  const seq = state.dropped + state.entries.length;
  let entries: readonly TranscriptEntry[] = [...state.entries, { ...entry, seq } as TranscriptEntry];
  let chars = state.chars + contentChars;
  let dropped = state.dropped;
  while (entries.length > MAX_TRANSCRIPT_ENTRIES || chars > MAX_TRANSCRIPT_CHARS) {
    const head = entries[0];
    if (!head) break; // defense against a chars bookkeeping drift: never spin
    chars -= storedChars(head);
    entries = entries.slice(1);
    dropped += 1;
  }
  if (dropped === state.dropped) return { ...state, entries, chars };
  return { ...state, entries, chars, dropped };
}

// Closes a text/thinking run: deltas already accumulated are the live
// truth, `end.content` only closes the run — and covers the redacted /
// complete-at-start case where the provider never emitted deltas.
function finalizeRun(
  state: TranscriptState,
  kind: "text" | "thinking",
  accumulator: string,
  endContent: string | undefined,
): TranscriptState {
  if (accumulator === "") {
    // No deltas and no content: nothing to finalize -> identity.
    if (!endContent) return state;
    // Redacted thinking (or a complete-at-start block): no deltas to
    // preserve — this single entry IS the content.
    return pushEntry(
      kind === "text" ? { ...state, currentText: "" } : { ...state, currentThinking: "" },
      { kind, content: endContent },
      endContent.length,
    );
  }
  const cleared = kind === "text" ? { ...state, currentText: "" } : { ...state, currentThinking: "" };
  return pushEntry(cleared, { kind, content: accumulator }, accumulator.length);
}

// Folds one raw session event. Identity-preserving by design (progress.ts
// precedent): tool_execution_update and every non-mapped event return the
// SAME state object, so renderers keyed on reference changes never fire for
// partial tool output or events the transcript does not carry.
export function applySessionEvent(state: TranscriptState, event: AgentSessionEvent): TranscriptState {
  if (event.type === "message_update") {
    const a = event.assistantMessageEvent;
    if (a.type === "text_delta") {
      if (!a.delta) return state;
      const currentText = state.currentText + a.delta;
      if (currentText.length > SEGMENT_SPLIT_CHARS) {
        return pushEntry({ ...state, currentText: "" }, { kind: "text", content: currentText }, currentText.length);
      }
      return { ...state, currentText };
    }
    if (a.type === "thinking_delta") {
      if (!a.delta) return state;
      const currentThinking = state.currentThinking + a.delta;
      if (currentThinking.length > SEGMENT_SPLIT_CHARS) {
        return pushEntry(
          { ...state, currentThinking: "" },
          { kind: "thinking", content: currentThinking },
          currentThinking.length,
        );
      }
      return { ...state, currentThinking };
    }
    if (a.type === "text_end") return finalizeRun(state, "text", state.currentText, a.content);
    if (a.type === "thinking_end") return finalizeRun(state, "thinking", state.currentThinking, a.content);
    return state;
  }
  if (event.type === "tool_execution_start") {
    const label = formatToolCall(event.toolName, event.args);
    return pushEntry(state, { kind: "tool-start", toolCallId: event.toolCallId, label }, label.length);
  }
  if (event.type === "tool_execution_end") {
    const summary = truncate(toolResultPreview(event.result), TOOL_RESULT_MAX_CHARS);
    // durationMs is optional on the event (hosts < 1.1.0 omit it): copied
    // only when present, so a 1.0.x tool-end entry stays byte-identical to
    // the pre-1.3.3 shape (no own property at all) and storedChars budgets
    // are untouched (they count only strings).
    return pushEntry(
      state,
      event.durationMs !== undefined
        ? { kind: "tool-end", toolCallId: event.toolCallId, ok: !event.isError, summary, durationMs: event.durationMs }
        : { kind: "tool-end", toolCallId: event.toolCallId, ok: !event.isError, summary },
      summary.length,
    );
  }
  return state;
}

// The one stateful seam: append-only fold with the mutable state held as a
// closure local (same "local mutability is fine" precedent as
// createProgressTracker in src/progress.ts). Settled jobs simply stop
// feeding it — no close/flush API (YAGNI).
export interface TranscriptSink {
  onSessionEvent(event: AgentSessionEvent): void;
  snapshot(): TranscriptState;
}

export function createTranscriptSink(): TranscriptSink {
  let state: TranscriptState = initialTranscriptState();

  return {
    onSessionEvent(event) {
      state = applySessionEvent(state, event);
    },
    snapshot() {
      return { ...state, entries: [...state.entries] };
    },
  };
}
