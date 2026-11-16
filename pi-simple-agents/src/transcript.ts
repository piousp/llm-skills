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
/** A split never cuts before this offset, so segments stay reasonably sized. */
const MIN_SEGMENT_CHARS = SEGMENT_SPLIT_CHARS / 2;
/** First-line preview cap for tool results. */
const TOOL_RESULT_MAX_CHARS = 200;

export { MAX_TRANSCRIPT_ENTRIES, MAX_TRANSCRIPT_CHARS, SEGMENT_SPLIT_CHARS, TOOL_RESULT_MAX_CHARS };

export type TranscriptEntry =
  | { readonly kind: "text"; readonly seq: number; readonly content: string }
  | { readonly kind: "thinking"; readonly seq: number; readonly content: string }
  | { readonly kind: "tool-start"; readonly seq: number; readonly toolCallId: string; readonly label: string }
  | {
      readonly kind: "tool-end";
      readonly seq: number;
      readonly toolCallId: string;
      readonly ok: boolean;
      readonly summary: string;
      readonly durationMs?: number;
    };

export interface TranscriptState {
  /** Bounded ring: entries[0] is the oldest surviving entry (head-evicted). */
  readonly entries: readonly TranscriptEntry[];
  /** Accumulating text_delta run, cleared per segment/end. */
  readonly currentText: string;
  /** Accumulating thinking_delta run, cleared per segment/end. */
  readonly currentThinking: string;
  /** Count of entries evicted by the caps (never decremented). */
  readonly dropped: number;
  /** Running total of stored entry characters; keeps eviction O(evicted). */
  readonly chars: number;
  /** A text run was split mid-stream: its text_end content is already stored. */
  readonly textSplit: boolean;
  /** Same as textSplit, for the thinking run. */
  readonly thinkingSplit: boolean;
}

export function initialTranscriptState(): TranscriptState {
  return { entries: [], currentText: "", currentThinking: "", dropped: 0, chars: 0, textSplit: false, thinkingSplit: false };
}

// Where to cut an over-long accumulator: after the last newline of the window
// [MIN_SEGMENT_CHARS, length), else after the last space/tab, else at the end
// (URLs, JSON, base64 have no safe boundary).
function segmentCut(acc: string): number {
  const nl = acc.lastIndexOf("\n");
  if (nl >= MIN_SEGMENT_CHARS) return nl + 1;
  const ws = Math.max(acc.lastIndexOf(" "), acc.lastIndexOf("\t"));
  if (ws >= MIN_SEGMENT_CHARS) return ws + 1;
  return acc.length;
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
  const added = { ...entry, seq } as TranscriptEntry;
  const old = state.entries;
  const total = old.length + 1;
  let chars = state.chars + contentChars;
  // k = heads to evict; the new entry is the last candidate once the old ones are gone.
  let k = 0;
  while (total - k > MAX_TRANSCRIPT_ENTRIES || chars > MAX_TRANSCRIPT_CHARS) {
    if (k === total) break; // defense against a chars bookkeeping drift: never spin
    chars -= storedChars(k < old.length ? old[k] : added);
    k += 1;
  }
  const entries: readonly TranscriptEntry[] = k > old.length ? [] : [...old.slice(k), added];
  if (k === 0) return { ...state, entries, chars };
  return { ...state, entries, chars, dropped: state.dropped + k };
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
  const flag = kind === "text" ? "textSplit" : "thinkingSplit";
  const cleared =
    kind === "text"
      ? { ...state, currentText: "", textSplit: false }
      : { ...state, currentThinking: "", thinkingSplit: false };
  if (accumulator === "") {
    // A mid-stream split already stored the whole block: end content is a duplicate.
    if (state[flag]) return cleared;
    // No deltas and no content: nothing to finalize -> identity.
    if (!endContent) return state;
    // Redacted thinking (or a complete-at-start block): no deltas to
    // preserve — this single entry IS the content.
    return pushEntry(cleared, { kind, content: endContent }, endContent.length);
  }
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
        const cut = segmentCut(currentText);
        return pushEntry(
          { ...state, currentText: currentText.slice(cut), textSplit: true },
          { kind: "text", content: currentText.slice(0, cut) },
          cut,
        );
      }
      return { ...state, currentText };
    }
    if (a.type === "thinking_delta") {
      if (!a.delta) return state;
      const currentThinking = state.currentThinking + a.delta;
      if (currentThinking.length > SEGMENT_SPLIT_CHARS) {
        const cut = segmentCut(currentThinking);
        return pushEntry(
          { ...state, currentThinking: currentThinking.slice(cut), thinkingSplit: true },
          { kind: "thinking", content: currentThinking.slice(0, cut) },
          cut,
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
  /** The live state itself (immutable): its reference identity is the
   * transcript's version — it changes exactly when a fold changes it. */
  snapshot(): TranscriptState;
}

export function createTranscriptSink(): TranscriptSink {
  let state: TranscriptState = initialTranscriptState();

  return {
    onSessionEvent(event) {
      state = applySessionEvent(state, event);
    },
    snapshot() {
      return state;
    },
  };
}
