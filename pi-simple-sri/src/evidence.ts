import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { sha256Digest, sha256Hex } from "./hash.ts";
import type { EvidenceItem, EvidenceKind } from "./types.ts";
import { isPlainObject } from "./values.ts";

// Q1: the three failure classes this module can prove from a session transcript.
//
//   tool_error      a toolResult with isError: true.
//   user_correction the first user message after a tool_error, when it arrives before
//                   another tool result and carries text. A retry in between means the model
//                   corrected itself, not the user.
//   retry_loop      the same tool called with equivalent arguments three or more times in the
//                   session, consecutive or not. The threshold counts calls, not failures
//                   (Q1): three identical calls make a retry loop even when each one succeeded,
//                   because the contract says "3 or more retries of the same tool" and a silent
//                   repetition is the failure being measured. A fourth identical call adds no
//                   item: one (tool, arguments) pair yields one retry_loop.
//
// The index a failure carries is `assistantCycleIndex` (M1), and it counts assistant turns, not
// user turns: the first assistant reply after a user message opens the next turn, and the
// replies that continue after a tool result belong to the turn already open. The index starts at
// 0, so a failure inside the second assistant reply under the same prompt still belongs to turn
// 0, and two user messages in a row do not open a turn between them.
//
// Everything this module learns enters through `entries`: no file, no clock, no module state.
// The same transcript therefore always yields the same ids, which is what makes a signature
// computed elsewhere reproducible.
//
// A tool result does not carry the arguments it was called with; they live on the assistant's
// toolCall, so results are joined back through toolCallId. A result whose call is not in the
// transcript still yields a tool_error, without argsHash.
//
// The prompt of the turn that failed cannot travel on EvidenceItem: that type is part of
// decision.schema.json and this module must not widen it. It travels next to the items, keyed
// by evidence id (see DerivedEvidence).

const MAX_EXCERPT_CODE_POINTS = 200;
const RETRY_THRESHOLD = 3;
const TRANSCRIPT_SOURCE = "transcript";
const ID_PREFIX = "ev-";
const ID_HEX_DIGITS = 8;

type SessionMessage = SessionMessageEntry["message"];

interface PendingError {
  toolName: string;
  argsHash: string | undefined;
}

// What the diagnosis needs about a failure and EvidenceItem cannot carry.
export interface EvidenceContext {
  // Text of the last user message before the failure; absent when the session had none yet.
  prompt?: string;
  // 0-based index of the assistant turn the failure belongs to; absent before the first
  // assistant reply. Counts assistant turns, never user messages: see the module comment.
  assistantCycleIndex?: number;
  // "provider/model" of the assistant turn the failure belongs to (OA5): a replay pins the model
  // that produced the failure, never the one the session that runs the diagnosis happens to use
  // (Q13). Absent when the transcript carries no assistant reply to name it.
  model?: string;
}

export interface DerivedEvidence {
  items: EvidenceItem[];
  contextById: ReadonlyMap<string, EvidenceContext>;
}

// Everything one pass over the transcript carries: what it has collected, the context of every
// item, and what the next entry needs to know. One object is created per call and the handlers
// below mutate it, so the pass stays a single traversal with a single copy of the state.
interface Derivation {
  collected: EvidenceItem[];
  contextById: Map<string, EvidenceContext>;
  // One counter per (tool, canonical arguments) pair, session-wide: a retry loop is not
  // required to be consecutive, so the counter never resets.
  callCounts: Map<string, number>;
  // toolCallId -> argsHash: a tool result names the call it answers but not its arguments.
  callArgs: Map<string, string>;
  // Assistant turns opened so far, and the index of the one in progress. Undefined until the
  // first assistant reply: before it, a failure has no turn to name.
  turnsOpened: number;
  cycleIndex: number | undefined;
  // "provider/model" of the reply that opened or continued the turn in progress. Undefined until
  // the first assistant reply, for the same reason as cycleIndex.
  cycleModel: string | undefined;
  // A user message no assistant reply has answered yet: the next reply opens a new turn.
  unansweredPrompt: boolean;
  lastPrompt: string | undefined;
  pending: PendingError | undefined;
}

export function deriveEvidence(entries: readonly SessionMessageEntry[]): DerivedEvidence {
  const derivation: Derivation = {
    collected: [],
    contextById: new Map<string, EvidenceContext>(),
    callCounts: new Map<string, number>(),
    callArgs: new Map<string, string>(),
    turnsOpened: 0,
    cycleIndex: undefined,
    cycleModel: undefined,
    unansweredPrompt: false,
    lastPrompt: undefined,
    pending: undefined,
  };

  for (const entry of entries) {
    const timestamp = timestampOf(entry);
    const message = entry.message;

    if (isUserMessage(message)) {
      handleUserMessage(derivation, message, timestamp);
    } else if (isAssistantMessage(message)) {
      handleAssistantMessage(derivation, message, timestamp);
    } else if (isToolResultMessage(message)) {
      handleToolResult(derivation, message, timestamp);
    }
  }

  return { items: dedupeById(derivation.collected), contextById: derivation.contextById };
}

// A message without text (whitespace, images only) is neither a correction nor a turn. One with
// text corrects the error still pending, if there is one, and then becomes the prompt of the
// turn the next assistant reply opens.
function handleUserMessage(derivation: Derivation, message: UserMessage, timestamp: number): void {
  const text = textOf(message.content).trim();
  if (text === "") return;

  const { pending } = derivation;
  if (pending !== undefined) {
    const correction: EvidenceItem = {
      id: evidenceId("user_correction", pending.toolName, pending.argsHash, timestamp),
      kind: "user_correction",
      timestamp,
      source: TRANSCRIPT_SOURCE,
      toolName: pending.toolName,
      ...(pending.argsHash === undefined ? {} : { argsHash: pending.argsHash }),
      excerpt: truncate(text),
    };
    derivation.collected.push(correction);
    rememberFailure(derivation, correction.id);
    // One correction per error: a later user message belongs to the next turn.
    derivation.pending = undefined;
  }

  derivation.lastPrompt = text;
  derivation.unansweredPrompt = true;
}

// A reply to a prompt opens the next turn; a reply that continues after a tool result stays in the
// turn already open. So several assistant replies under one prompt share the index, and several
// user messages in a row advance it at most once. The turn is opened, and its model read, before
// its tool calls are read, so the failures inside it carry both.
function handleAssistantMessage(
  derivation: Derivation,
  message: AssistantMessage,
  timestamp: number,
): void {
  if (derivation.unansweredPrompt || derivation.cycleIndex === undefined) {
    derivation.cycleIndex = derivation.turnsOpened;
    derivation.turnsOpened += 1;
    derivation.unansweredPrompt = false;
  }

  // The model travels with the turn, and it is set before the tool calls are read, so every
  // failure this reply can produce -- the retry loop below, the tool error of its results, the
  // correction that follows -- names the model that produced it and not the one a later reply
  // switches to (Q13, OA5).
  derivation.cycleModel = modelOf(message);

  for (const part of message.content) {
    if (part.type !== "toolCall") continue;

    const argsHash = hashOfArguments(part.arguments);
    derivation.callArgs.set(part.id, argsHash);

    const key = callCountsKey(part.name, argsHash);
    const count = (derivation.callCounts.get(key) ?? 0) + 1;
    derivation.callCounts.set(key, count);
    // Emitted exactly when the threshold is crossed, so one pair yields one item and a fourth or
    // fifth identical call does not add another.
    if (count !== RETRY_THRESHOLD) continue;

    const retryLoop: EvidenceItem = {
      id: evidenceId("retry_loop", part.name, argsHash, timestamp),
      kind: "retry_loop",
      timestamp,
      source: TRANSCRIPT_SOURCE,
      toolName: part.name,
      argsHash,
    };
    derivation.collected.push(retryLoop);
    rememberFailure(derivation, retryLoop.id);
  }
}

// Any result after an error means the failure was not corrected by the user: the pending error is
// dropped whether this result is the error itself or a later retry. A failing result becomes the
// pending error a following user message would correct.
function handleToolResult(
  derivation: Derivation,
  message: ToolResultMessage,
  timestamp: number,
): void {
  derivation.pending = undefined;
  if (!message.isError) return;

  const argsHash = derivation.callArgs.get(message.toolCallId);
  const excerpt = excerptOf(textOf(message.content));
  const toolError: EvidenceItem = {
    id: evidenceId("tool_error", message.toolName, argsHash, timestamp),
    kind: "tool_error",
    timestamp,
    source: TRANSCRIPT_SOURCE,
    toolName: message.toolName,
    ...(argsHash === undefined ? {} : { argsHash }),
    ...(excerpt === undefined ? {} : { excerpt }),
  };
  derivation.collected.push(toolError);
  rememberFailure(derivation, toolError.id);
  derivation.pending = { toolName: message.toolName, argsHash };
}

// Merges evidence derived now with evidence persisted earlier (M3). Order is `a` then the new
// ids of `b`; an id already present keeps the item from `a`, source included, because the two
// describe the same failure and the earlier record is the one the transcript agrees with.
export function mergeEvidence(a: readonly EvidenceItem[], b: readonly EvidenceItem[]): EvidenceItem[] {
  return dedupeById([...a, ...b]);
}

// First occurrence wins, so a merged list never carries the same failure twice.
function dedupeById(items: readonly EvidenceItem[]): EvidenceItem[] {
  const unique: EvidenceItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

// The context of one failure, copied from the state the pass has when the failure is recorded: a
// later reply that switches prompt or model must not rewrite what the failure already said.
function rememberFailure(derivation: Derivation, id: string): void {
  const { contextById, lastPrompt, cycleIndex, cycleModel } = derivation;
  if (contextById.has(id)) return;
  if (lastPrompt === undefined && cycleIndex === undefined && cycleModel === undefined) return;

  const context: EvidenceContext = {};
  if (lastPrompt !== undefined) context.prompt = lastPrompt;
  if (cycleIndex !== undefined) context.assistantCycleIndex = cycleIndex;
  if (cycleModel !== undefined) context.model = cycleModel;
  contextById.set(id, context);
}

// OA5: the identity a replay pins is "provider/model" and never the bare id, because --model
// accepts both spellings and an id alone is ambiguous between two providers that serve it. The
// prefix comes from the reply that produced the turn; a legacy message, written before the fields
// were required, keeps the id it has and invents no prefix.
function modelOf(message: AssistantMessage): string | undefined {
  const { model } = message;
  if (typeof model !== "string" || model === "") return undefined;

  const { provider } = message;
  return typeof provider !== "string" || provider === "" ? model : `${provider}/${model}`;
}

// "ev-" plus the first 8 hex digits of the hash over (kind, tool, arguments, timestamp), fed as
// the JSON array JSON.stringify([kind, toolName ?? "", argsHash ?? "", timestamp]): the id names
// one failure and nothing else, so two runs over the same transcript agree.
function evidenceId(
  kind: EvidenceKind,
  toolName: string | undefined,
  argsHash: string | undefined,
  timestamp: number,
): string {
  const material = JSON.stringify([kind, toolName ?? "", argsHash ?? "", timestamp]);
  return `${ID_PREFIX}${sha256Hex(material).slice(0, ID_HEX_DIGITS)}`;
}

// Canonical JSON: object keys sorted at every level, no whitespace between tokens, values
// unchanged. `{ b: 1, a: { d: 2, c: 3 } }` and `{ a: { c: 3, d: 2 }, b: 1 }` hash the same.
// Undefined values are dropped, as JSON.stringify does, so an explicit undefined does not
// change the hash of the arguments.
function canonicalJson(value: unknown): string {
  if (value === null) return "null";

  if (Array.isArray(value)) {
    return `[${value.map((entry: unknown) => canonicalJson(entry)).join(",")}]`;
  }

  if (isPlainObject(value)) {
    const members = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
    return `{${members.join(",")}}`;
  }

  const json = JSON.stringify(value);
  return json ?? "null";
}

// Exported because it is the package's one rule for "the same call": the evidence of a session and
// the tool calls of a replay (src/gate/replay-runner.ts, OA2) hash arguments the same way, so a
// retry loop counted over a replay and one counted over a transcript mean the same thing.
export function hashOfArguments(args: unknown): string {
  return sha256Digest(canonicalJson(args));
}

function callCountsKey(toolName: string, argsHash: string): string {
  // NUL cannot appear in a tool name, so the two halves never run together.
  return `${toolName}\u0000${argsHash}`;
}

// A message holds either a bare string or text and image parts; images contribute nothing to
// an excerpt or a prompt.
function textOf(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;

  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") parts.push(part.text);
  }
  return parts.join("\n");
}

function excerptOf(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed === "" ? undefined : truncate(trimmed);
}

// Array.from walks code points, so a surrogate pair (an emoji, a rare CJK character) is never
// cut in half: a lone surrogate is not valid UTF-8 and would corrupt the record.
function truncate(text: string): string {
  return Array.from(text).slice(0, MAX_EXCERPT_CODE_POINTS).join("");
}

// The entry timestamp is the record of when the transcript recorded the failure; the message
// timestamp is the same instant and only used when the entry carries no usable one. A missing
// timestamp becomes 0, which is still deterministic.
function timestampOf(entry: SessionMessageEntry): number {
  const fromEntry = Date.parse(entry.timestamp);
  if (Number.isFinite(fromEntry)) return fromEntry;

  const fromMessage = entry.message.timestamp;
  return Number.isFinite(fromMessage) ? fromMessage : 0;
}

function isUserMessage(message: SessionMessage): message is UserMessage {
  return message.role === "user";
}

function isAssistantMessage(message: SessionMessage): message is AssistantMessage {
  return message.role === "assistant";
}

function isToolResultMessage(message: SessionMessage): message is ToolResultMessage {
  return message.role === "toolResult";
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
