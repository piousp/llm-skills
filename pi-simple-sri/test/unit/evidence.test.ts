import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, JsonObject, ToolCall, UserMessage } from "@earendil-works/pi-ai";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { MAX_EXCERPT_CODE_POINTS, deriveEvidence, mergeEvidence } from "../../src/evidence.ts";
import type { EvidenceItem, EvidenceKind } from "../../src/types.ts";

// Session entries are fabricated here, never read from a session file: evidence.ts only looks at
// the message, the entry timestamp and the tool calls, so a literal is the whole input.

const BASE_MS = Date.parse("2026-11-02T14:00:00.000Z");
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ID_PATTERN = /^ev-[0-9a-f]{8}$/;

interface Instant {
  iso: string;
  ms: number;
}

// Seconds since BASE_MS: readable offsets in the fixtures and a distinct entry id per instant.
function at(seconds: number): Instant {
  const ms = BASE_MS + seconds * 1000;
  return { iso: new Date(ms).toISOString(), ms };
}

function entryOf(seconds: number, message: SessionMessageEntry["message"]): SessionMessageEntry {
  const instant = at(seconds);
  return {
    type: "message",
    id: `entry-${seconds}`,
    parentId: null,
    timestamp: instant.iso,
    message,
  };
}

function userEntry(seconds: number, content: UserMessage["content"]): SessionMessageEntry {
  return entryOf(seconds, { role: "user", content, timestamp: at(seconds).ms });
}

function toolCall(callId: string, name: string, args: JsonObject): ToolCall {
  return { type: "toolCall", id: callId, name, arguments: args };
}

// The model a turn ran on: the pair an AssistantMessage records, which the evidence turns into the
// "provider/model" a replay pins (OA5).
interface TurnModel {
  provider: string;
  model: string;
}

const DEFAULT_TURN: TurnModel = { provider: "anthropic", model: "claude-sonnet-4-5" };
const OTHER_TURN: TurnModel = { provider: "anthropic", model: "claude-opus-4-1" };

function assistantEntry(
  seconds: number,
  calls: ToolCall[],
  turn: TurnModel = DEFAULT_TURN,
): SessionMessageEntry {
  const message: AssistantMessage = {
    role: "assistant",
    content: calls,
    api: "anthropic-messages",
    provider: turn.provider,
    model: turn.model,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: calls.length > 0 ? "toolUse" : "stop",
    timestamp: at(seconds).ms,
  };
  return entryOf(seconds, message);
}

interface ToolResultFields {
  callId: string;
  toolName: string;
  text: string;
  isError: boolean;
}

function toolResultEntry(seconds: number, fields: ToolResultFields): SessionMessageEntry {
  const content: { type: "text"; text: string }[] = fields.text === "" ? [] : [{ type: "text", text: fields.text }];
  return entryOf(seconds, {
    role: "toolResult",
    toolCallId: fields.callId,
    toolName: fields.toolName,
    content,
    isError: fields.isError,
    timestamp: at(seconds).ms,
  });
}

// One transcript with a single failing bash call, from the user prompt to the error result.
function failingBashTranscript(errorText = "pdftotext: cannot open report.pdf"): SessionMessageEntry[] {
  return [
    userEntry(0, "extract the merged-cell table from report.pdf"),
    assistantEntry(1, [toolCall("call-1", "bash", { command: "pdftotext report.pdf -" })]),
    toolResultEntry(2, { callId: "call-1", toolName: "bash", text: errorText, isError: true }),
  ];
}

function argsHashOf(args: JsonObject): string | undefined {
  const entries = [
    userEntry(0, "go"),
    assistantEntry(1, [toolCall("call-1", "bash", args)]),
    toolResultEntry(2, { callId: "call-1", toolName: "bash", text: "boom", isError: true }),
  ];
  return deriveEvidence(entries).items[0].argsHash;
}

function evidenceItem(id: string, source: EvidenceItem["source"], kind: EvidenceKind = "tool_error"): EvidenceItem {
  return { id, kind, timestamp: 0, source };
}

test("deriveEvidence: a toolResult with isError produces a tool_error", () => {
  const { items } = deriveEvidence(failingBashTranscript());

  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.kind, "tool_error");
  assert.equal(item.toolName, "bash");
  assert.match(item.argsHash ?? "", HASH_PATTERN);
  assert.equal(item.excerpt, "pdftotext: cannot open report.pdf");
  assert.equal(item.timestamp, at(2).ms);
  assert.equal(item.source, "transcript");
  assert.match(item.id, ID_PATTERN);
});

test("deriveEvidence: a toolResult without isError produces no evidence", () => {
  const entries = [
    userEntry(0, "list the directory"),
    assistantEntry(1, [toolCall("call-1", "bash", { command: "ls" })]),
    toolResultEntry(2, { callId: "call-1", toolName: "bash", text: "report.pdf", isError: false }),
  ];

  assert.deepEqual(deriveEvidence(entries).items, []);
});

test("deriveEvidence: argsHash is stable across a different key order and changes with a value", () => {
  const first = argsHashOf({ command: "ls", timeout: 10 });
  const second = argsHashOf({ timeout: 10, command: "ls" });
  const third = argsHashOf({ command: "ls", timeout: 11 });

  assert.equal(first, second);
  assert.notEqual(first, third);
});

// The canonical form sorts keys at every level, not only at the top.
test("deriveEvidence: argsHash sorts nested keys too", () => {
  const first = argsHashOf({ options: { recursive: true, limit: 5 }, command: "ls" });
  const second = argsHashOf({ command: "ls", options: { limit: 5, recursive: true } });

  assert.equal(first, second);
});

test("deriveEvidence: three calls with the same arguments produce one retry_loop", () => {
  const args = { command: "pdftotext report.pdf -" };
  const entries = [
    userEntry(0, "extract the table"),
    assistantEntry(1, [toolCall("call-1", "bash", args)]),
    toolResultEntry(2, { callId: "call-1", toolName: "bash", text: "", isError: false }),
    assistantEntry(3, [toolCall("call-2", "bash", args)]),
    toolResultEntry(4, { callId: "call-2", toolName: "bash", text: "", isError: false }),
    assistantEntry(5, [toolCall("call-3", "bash", args)]),
    toolResultEntry(6, { callId: "call-3", toolName: "bash", text: "", isError: false }),
  ];

  const { items } = deriveEvidence(entries);

  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.kind, "retry_loop");
  assert.equal(item.toolName, "bash");
  assert.match(item.argsHash ?? "", HASH_PATTERN);
  // The timestamp of the call that crossed the threshold, not of the first one.
  assert.equal(item.timestamp, at(5).ms);
});

test("deriveEvidence: three calls with different arguments are not a retry_loop", () => {
  const entries = [
    userEntry(0, "extract the table"),
    assistantEntry(1, [toolCall("call-1", "bash", { command: "ls page-1.pdf" })]),
    toolResultEntry(2, { callId: "call-1", toolName: "bash", text: "", isError: false }),
    assistantEntry(3, [toolCall("call-2", "bash", { command: "ls page-2.pdf" })]),
    toolResultEntry(4, { callId: "call-2", toolName: "bash", text: "", isError: false }),
    assistantEntry(5, [toolCall("call-3", "bash", { command: "ls page-3.pdf" })]),
    toolResultEntry(6, { callId: "call-3", toolName: "bash", text: "", isError: false }),
  ];

  assert.deepEqual(deriveEvidence(entries).items, []);
});

test("deriveEvidence: two calls with the same arguments are not a retry_loop", () => {
  const args = { command: "ls" };
  const entries = [
    userEntry(0, "list the directory"),
    assistantEntry(1, [toolCall("call-1", "bash", args)]),
    toolResultEntry(2, { callId: "call-1", toolName: "bash", text: "", isError: false }),
    assistantEntry(3, [toolCall("call-2", "bash", args)]),
    toolResultEntry(4, { callId: "call-2", toolName: "bash", text: "", isError: false }),
  ];

  assert.deepEqual(deriveEvidence(entries).items, []);
});

// Q1 counts the calls of a session, not a run of them: another call in between does not reset the
// count, and another tool with the same arguments is another pair.
test("deriveEvidence: a retry_loop counts non-consecutive calls and keeps tools apart", () => {
  const entries = [
    userEntry(0, "extract the table"),
    assistantEntry(1, [toolCall("call-1", "bash", { command: "ls" })]),
    toolResultEntry(2, { callId: "call-1", toolName: "bash", text: "", isError: false }),
    assistantEntry(3, [toolCall("call-2", "read", { path: "report.pdf" })]),
    toolResultEntry(4, { callId: "call-2", toolName: "read", text: "", isError: false }),
    assistantEntry(5, [toolCall("call-3", "bash", { command: "ls" })]),
    toolResultEntry(6, { callId: "call-3", toolName: "bash", text: "", isError: false }),
    assistantEntry(7, [toolCall("call-4", "bash", { command: "ls" })]),
    toolResultEntry(8, { callId: "call-4", toolName: "bash", text: "", isError: false }),
  ];

  const { items } = deriveEvidence(entries);

  assert.deepEqual(
    items.map((item) => [item.kind, item.toolName, item.timestamp]),
    [["retry_loop", "bash", at(7).ms]],
  );
});

// I1, G6: the threshold is a crossing, not a recurrence. A fourth identical call re-counts but
// does not add a second item, and it still counts when every call succeeded (Q1).
test("deriveEvidence: a fourth identical call does not add a second retry_loop", () => {
  const args = { command: "pdftotext report.pdf -" };
  const entries = [
    userEntry(0, "extract the table"),
    assistantEntry(1, [toolCall("call-1", "bash", args)]),
    toolResultEntry(2, { callId: "call-1", toolName: "bash", text: "", isError: false }),
    assistantEntry(3, [toolCall("call-2", "bash", args)]),
    toolResultEntry(4, { callId: "call-2", toolName: "bash", text: "", isError: false }),
    assistantEntry(5, [toolCall("call-3", "bash", args)]),
    toolResultEntry(6, { callId: "call-3", toolName: "bash", text: "", isError: false }),
    assistantEntry(7, [toolCall("call-4", "bash", args)]),
    toolResultEntry(8, { callId: "call-4", toolName: "bash", text: "", isError: false }),
  ];

  const { items } = deriveEvidence(entries);

  assert.deepEqual(
    items.map((item) => [item.kind, item.timestamp]),
    [["retry_loop", at(5).ms]],
  );
});

test("deriveEvidence: the user correction is cut at MAX_EXCERPT_CODE_POINTS code points without splitting a surrogate pair", () => {
  const correction = "😀".repeat(MAX_EXCERPT_CODE_POINTS + 100);
  const entries = [...failingBashTranscript(), userEntry(3, correction)];

  const { items } = deriveEvidence(entries);

  assert.deepEqual(
    items.map((item) => item.kind),
    ["tool_error", "user_correction"],
  );
  // The cut lands exactly on the cap its owner declares, and a lone surrogate would be 3 bytes instead of 4: the pair
  // is never cut in half.
  const userCorrection = items[1];
  const excerpt = userCorrection.excerpt ?? "";
  assert.equal(excerpt, "😀".repeat(MAX_EXCERPT_CODE_POINTS));
  assert.equal([...excerpt].length, MAX_EXCERPT_CODE_POINTS);
  assert.equal(Buffer.byteLength(excerpt, "utf8"), 4 * MAX_EXCERPT_CODE_POINTS);
  assert.match(userCorrection.id, ID_PATTERN);
});

test("deriveEvidence: the user correction carries the tool of the error it follows", () => {
  const entries = [...failingBashTranscript(), userEntry(3, "no, the table is on page 4")];

  const { items } = deriveEvidence(entries);

  const userCorrection = items[1];
  assert.equal(userCorrection.kind, "user_correction");
  assert.equal(userCorrection.toolName, "bash");
  assert.equal(userCorrection.excerpt, "no, the table is on page 4");
  assert.equal(userCorrection.timestamp, at(3).ms);
  assert.notEqual(userCorrection.id, items[0].id);
});

// Q1: the correction has to arrive before another result. A retry in between means the model
// corrected itself.
test("deriveEvidence: a user message after a later tool result is not a correction", () => {
  const entries = [
    ...failingBashTranscript(),
    assistantEntry(3, [toolCall("call-2", "bash", { command: "pdftotext -layout report.pdf -" })]),
    toolResultEntry(4, { callId: "call-2", toolName: "bash", text: "| a | b |", isError: false }),
    userEntry(5, "no, that is wrong"),
  ];

  assert.deepEqual(
    deriveEvidence(entries).items.map((item) => item.kind),
    ["tool_error"],
  );
});

test("deriveEvidence: a user message without text is not a correction", () => {
  const entries = [
    ...failingBashTranscript(),
    userEntry(3, [{ type: "image", data: "eA==", mimeType: "image/png" }]),
  ];

  assert.deepEqual(
    deriveEvidence(entries).items.map((item) => item.kind),
    ["tool_error"],
  );
});

test("deriveEvidence: the same transcript yields the same ids", () => {
  const entries = [...failingBashTranscript(), userEntry(3, "no, the table is on page 4")];

  const first = deriveEvidence(entries).items.map((item) => item.id);
  const second = deriveEvidence(entries).items.map((item) => item.id);

  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, first.length);
});

test("deriveEvidence: a failure carries the last user prompt before it and the assistant cycle it belongs to", () => {
  const entries = [
    ...failingBashTranscript(),
    userEntry(3, "no, the table is on page 4"),
    userEntry(4, "try the other file"),
    assistantEntry(5, [toolCall("call-2", "bash", { command: "pdftotext other.pdf -" })]),
    toolResultEntry(6, { callId: "call-2", toolName: "bash", text: "boom", isError: true }),
  ];

  const { items, contextById } = deriveEvidence(entries);
  const [firstError, correction, secondError] = items;

  assert.equal(contextById.get(firstError.id)?.prompt, "extract the merged-cell table from report.pdf");
  assert.equal(contextById.get(firstError.id)?.assistantCycleIndex, 0);
  // The correction belongs to the assistant turn that failed, not to the turn it opens.
  assert.equal(contextById.get(correction.id)?.prompt, "extract the merged-cell table from report.pdf");
  assert.equal(contextById.get(correction.id)?.assistantCycleIndex, 0);
  assert.equal(contextById.get(secondError.id)?.prompt, "try the other file");
  // The assistant replies to the prompt the two user messages left unanswered, so this failure
  // belongs to the second assistant turn even though no user reply opened it.
  assert.equal(contextById.get(secondError.id)?.assistantCycleIndex, 1);
});

// M1, G5: the index counts assistant turns, never user messages. The reply that continues after a
// tool result stays in the turn already open, so both failures of the same prompt carry 0.
test("deriveEvidence: two assistant replies under one prompt share the assistant cycle index", () => {
  const entries = [
    userEntry(0, "extract the table from report.pdf"),
    assistantEntry(1, [toolCall("call-1", "read", { path: "report.pdf" })]),
    toolResultEntry(2, { callId: "call-1", toolName: "read", text: "page 1", isError: false }),
    assistantEntry(3, [toolCall("call-2", "bash", { command: "pdftotext report.pdf -" })]),
    toolResultEntry(4, { callId: "call-2", toolName: "bash", text: "boom", isError: true }),
    userEntry(5, "no, the table is on page 4"),
  ];

  const { items, contextById } = deriveEvidence(entries);
  const [toolError, correction] = items;

  assert.deepEqual(
    items.map((item) => item.kind),
    ["tool_error", "user_correction"],
  );
  assert.equal(contextById.get(toolError.id)?.assistantCycleIndex, 0);
  assert.equal(contextById.get(correction.id)?.assistantCycleIndex, 0);
});

// Q13, OA5: a replay item pins the model that produced the failure. The assistant turn is the
// unit: a later turn under another model is another attribution, and the failures already recorded
// keep the one they had.
test("deriveEvidence: each failure keeps the model of the assistant turn it happened in", () => {
  const entries = [
    userEntry(0, "extract the merged-cell table from report.pdf"),
    assistantEntry(1, [toolCall("call-1", "bash", { command: "pdftotext report.pdf -" })]),
    toolResultEntry(2, { callId: "call-1", toolName: "bash", text: "pdftotext: cannot open", isError: true }),
    userEntry(3, "and now summarize report.pdf"),
    assistantEntry(4, [toolCall("call-2", "bash", { command: "pdftotext -layout report.pdf -" })], OTHER_TURN),
    toolResultEntry(5, { callId: "call-2", toolName: "bash", text: "pdftotext: cannot open", isError: true }),
  ];

  const { items, contextById } = deriveEvidence(entries);
  const [firstError, secondError] = items.filter((item) => item.kind === "tool_error");

  // The second turn switched model, and the first failure still names the one that produced it.
  assert.equal(contextById.get(firstError.id)?.model, "anthropic/claude-sonnet-4-5");
  assert.equal(contextById.get(firstError.id)?.assistantCycleIndex, 0);
  assert.equal(contextById.get(secondError.id)?.model, "anthropic/claude-opus-4-1");
  assert.equal(contextById.get(secondError.id)?.assistantCycleIndex, 1);
});

// A correction is evidence about the error it answers, so it inherits the model of that turn and
// not the model of the first turn of the session.
test("deriveEvidence: a user correction carries the model of the cycle that failed", () => {
  const entries = [
    userEntry(0, "extract the merged-cell table from report.pdf"),
    assistantEntry(1, []),
    userEntry(2, "the table is in report.pdf, not in notes.md"),
    assistantEntry(3, [toolCall("call-1", "bash", { command: "pdftotext report.pdf -" })], OTHER_TURN),
    toolResultEntry(4, { callId: "call-1", toolName: "bash", text: "pdftotext: cannot open", isError: true }),
    userEntry(5, "no, the table is on page 4"),
  ];

  const { items, contextById } = deriveEvidence(entries);
  const [toolError, correction] = items;

  assert.equal(correction.kind, "user_correction");
  assert.equal(contextById.get(correction.id)?.assistantCycleIndex, 1);
  assert.equal(contextById.get(correction.id)?.model, "anthropic/claude-opus-4-1");
  assert.equal(contextById.get(correction.id)?.model, contextById.get(toolError.id)?.model);
});

// Nothing is invented: a transcript with no assistant reply has no model to name, so the context
// says so by omission instead of borrowing the model of whoever runs the diagnosis.
test("deriveEvidence: a failure with no assistant message carries no model", () => {
  const entries = [
    userEntry(0, "run the export"),
    toolResultEntry(1, { callId: "call-1", toolName: "bash", text: "boom", isError: true }),
  ];

  const { items, contextById } = deriveEvidence(entries);
  const [toolError] = items;

  assert.equal(contextById.get(toolError.id)?.prompt, "run the export");
  assert.equal(contextById.get(toolError.id)?.model, undefined);
  assert.equal(contextById.get(toolError.id)?.assistantCycleIndex, undefined);
});

test("mergeEvidence: keeps the first list whole and appends only the ids it does not have", () => {
  const a = [evidenceItem("ev-00000001", "transcript"), evidenceItem("ev-00000002", "transcript")];
  const b = [evidenceItem("ev-00000002", "persisted"), evidenceItem("ev-00000003", "persisted")];

  const merged = mergeEvidence(a, b);

  assert.deepEqual(
    merged.map((item) => item.id),
    ["ev-00000001", "ev-00000002", "ev-00000003"],
  );
  // A duplicate of an id already present keeps the source it arrived with in `a`.
  assert.deepEqual(
    merged.map((item) => item.source),
    ["transcript", "transcript", "persisted"],
  );
});

test("mergeEvidence: does not mutate the lists it merges", () => {
  const a = [evidenceItem("ev-00000001", "transcript")];
  const b = [evidenceItem("ev-00000002", "persisted")];

  mergeEvidence(a, b);

  assert.deepEqual(a, [evidenceItem("ev-00000001", "transcript")]);
  assert.deepEqual(b, [evidenceItem("ev-00000002", "persisted")]);
});

test("mergeEvidence: an empty second list leaves the first one as it was", () => {
  const a = [evidenceItem("ev-00000001", "persisted", "retry_loop")];

  assert.deepEqual(mergeEvidence(a, []), a);
});
