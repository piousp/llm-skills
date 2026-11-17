import type { FileEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { textOf } from "../evidence.ts";
import { splitSkillBlock } from "../skill-block.ts";
import { detectSignals, emptySignalState, foldObservation, turnObservationOf } from "../signals.ts";
import { redactSecrets } from "./redact.ts";
import type { Episode, PrefilterFlag, PrefilterFlagKind, PrefilterResult } from "./types.ts";

// The deterministic first pass over one episode: no model, no clock, no I/O. It answers which mechanical flags the
// episode raises and whether they justify spending a judge call. A tool error and a rewritten draft are suspicions the
// user may have caused on purpose (Q3: weight 0.3, never open a pattern alone), so they are recorded and do not send the
// episode to the judge; a correction in the user's own words or a repeated request do.

export const JUDGE_FLAG_KINDS: readonly PrefilterFlagKind[] = ["correction", "repeated-request"];

// English and Spanish. A term is a whole word or phrase (unicode-aware boundaries); `^` anchors it to the start of the
// message, where a bare "no" is a refusal and not a word inside a sentence. The lexicon only has to be cheap and to
// miss little: the judge decides what a flagged episode holds.
const CORRECTION_TERMS: readonly string[] = [
  "^no",
  "^nope",
  "wrong",
  "incorrect",
  "not what i",
  "that['’]?s not",
  "that is not",
  "isn['’]?t (?:right|correct)",
  "not (?:right|correct)",
  "i said",
  "i asked",
  "i meant",
  "instead",
  "undo",
  "revert",
  "redo",
  "you (?:forgot|missed)",
  "stop",
  "don['’]?t",
  "do not",
  "incorrecto",
  "equivocad[oa]",
  "est[aá] mal",
  "eso no",
  "te dije",
  "te ped[ií]",
  "en vez de",
  "en lugar de",
  "deshaz",
  "rehaz",
  "revierte",
  "olvidaste",
  "para de",
  "det[eé]n",
];

const CORRECTION_PATTERN = new RegExp(`(?<![\\p{L}\\p{N}])(?:${CORRECTION_TERMS.join("|")})(?![\\p{L}\\p{N}])`, "iu");

export function prefilterEpisode(episode: Episode, entries: readonly FileEntry[], cwd: string): PrefilterResult {
  const messages = messagesOf(episode, entries);
  const flags = uniqueFlags([
    ...toolErrorFlags(messages),
    ...correctionFlags(messages, episode.startEntryId),
    ...signalFlags(messages, cwd),
  ]).map((flag) => ({ ...flag, detail: redactSecrets(flag.detail).text }));

  return {
    episodeId: episode.id,
    flags,
    needsJudge: flags.some((flag) => JUDGE_FLAG_KINDS.includes(flag.kind)),
  };
}

// The message entries from the start to the end of the episode, both included. An episode whose pointers are not in the
// file raises nothing.
function messagesOf(episode: Episode, entries: readonly FileEntry[]): SessionMessageEntry[] {
  const start = entries.findIndex((entry) => entry.type !== "session" && entry.id === episode.startEntryId);
  const end = entries.findIndex((entry) => entry.type !== "session" && entry.id === episode.endEntryId);
  if (start === -1 || end === -1 || end < start) return [];

  const messages: SessionMessageEntry[] = [];
  for (const entry of entries.slice(start, end + 1)) {
    if (entry.type === "message") messages.push(entry);
  }
  return messages;
}

function toolErrorFlags(messages: readonly SessionMessageEntry[]): PrefilterFlag[] {
  const flags: PrefilterFlag[] = [];
  for (const entry of messages) {
    const message = entry.message;
    if (message.role === "toolResult" && message.isError) {
      flags.push({ kind: "tool-error", anchorEntryId: entry.id, detail: message.toolName });
    }
  }
  return flags;
}

// Only what the user typed: the skill block is the skill's own text, and the message that opens the episode is the
// request, not a reaction to it.
function correctionFlags(messages: readonly SessionMessageEntry[], startEntryId: string): PrefilterFlag[] {
  const flags: PrefilterFlag[] = [];
  for (const entry of messages) {
    if (entry.id === startEntryId) continue;
    const text = userTextOf(entry)?.trim();
    if (text === undefined || text === "") continue;

    const term = CORRECTION_PATTERN.exec(text)?.[0];
    if (term !== undefined) flags.push({ kind: "correction", anchorEntryId: entry.id, detail: term.toLowerCase() });
  }
  return flags;
}

// detectSignals over the assistant turns of the episode, with the user-prompt ordinal as turnIndex: pi resets its own
// turnIndex on every agent run, and a rewrite under the same prompt is the model refining its draft. The user messages
// handed to the collector are stripped of the skill block, so the repeat is judged on what the user typed.
function signalFlags(messages: readonly SessionMessageEntry[], cwd: string): PrefilterFlag[] {
  const branch = messages.map(withoutSkillBlock);
  const flags: PrefilterFlag[] = [];
  let state = emptySignalState();
  let ordinal = -1;
  let promptEntryId: string | undefined;

  branch.forEach((entry, index) => {
    const message = entry.message;
    if (message.role === "user") {
      if (textOf(message.content).trim() !== "") {
        ordinal += 1;
        promptEntryId = entry.id;
      }
      return;
    }
    if (message.role !== "assistant") return;

    const observation = turnObservationOf(
      { turnIndex: Math.max(ordinal, 0), message },
      branch.slice(0, index + 1),
      { cwd, model: undefined },
    );
    for (const detected of detectSignals(observation, state)) {
      flags.push({
        kind: detected.kind,
        anchorEntryId: promptEntryId ?? entry.id,
        detail: detected.kind === "rewritten-draft" ? detected.subject : "repeated user prompt",
      });
    }
    state = foldObservation(state, observation);
  });

  return flags;
}

function userTextOf(entry: SessionMessageEntry): string | undefined {
  const message = entry.message;
  return message.role === "user" ? splitSkillBlock(textOf(message.content)).userText : undefined;
}

function withoutSkillBlock(entry: SessionMessageEntry): SessionMessageEntry {
  const message = entry.message;
  return message.role === "user" ? { ...entry, message: { ...message, content: userTextOf(entry) ?? "" } } : entry;
}

function uniqueFlags(flags: readonly PrefilterFlag[]): PrefilterFlag[] {
  const seen = new Set<string>();
  const unique: PrefilterFlag[] = [];
  for (const flag of flags) {
    const key = `${flag.kind}\u0000${flag.anchorEntryId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(flag);
  }
  return unique;
}
