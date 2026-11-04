import { sha256Digest } from "./hash.ts";
import type { AttemptLine } from "./types.ts";

// The vocabulary, the hashes and the shape of one line of state/attempts.jsonl (Q14).
//
// The index is the audit trail of every attempt, including the ones that cost no generation, so its lines
// outlive the version that wrote them: they are read by hand, by later versions of this package and by
// M1c. Two rules therefore live here and nowhere else:
//
//   1. A new event is an entry in a list, never a change to the shape of the line. No reader may fail on an
//      event it does not know: it groups by candidateHash and leaves the `event` it cannot name alone. Every
//      other field a line gains is additive and optional, `failureSignature` being the one field of the line
//      that is required and nullable (OA4).
//   2. Every line says which failure it is about, `null` when the attempt has no diagnosis to point at. A
//      field that is there and says "no failure" is an answer a reader can act on; an absent field is a
//      reader guessing.
//
// The hashes and the line are built in this module and only here, because there are two writers of the
// index -- the propose flow and the gate flow -- and a second copy of the digest rule would let them
// disagree about what an attempt is called.
//
// src/types.ts imports KnownAttemptEvent from here for the `event` of AttemptLine: the import is type-only,
// so the module graph keeps no cycle at run time, and the list keeps one home.

// The closed set of events an attempt can emit, derived to a type the way LESSON_STATUSES is: a value that is
// not on this list has no line, and adding one is a one-line change here.
//
// M1 does not emit `gate-accepted`: a gate that passes writes no line of the index, because the line of an
// accepted candidate is the `accepted` event the acceptance writes after it edits the skill. The
// intermediate state lives in decision.json, where it cannot be confused with the record of a write.
export const ATTEMPT_EVENTS = [
  "proposed",
  "no-evidence",
  "not-eligible",
  "no-model",
  "accepted",
  "gate-rejected",
  "gate-abstained",
] as const;

export type AttemptEvent = (typeof ATTEMPT_EVENTS)[number];

// The vocabulary a reader of M1c will meet and this version only recognizes: `no-baseline` (Q23) is the
// first extension the plan reserves, the answer of a gate that found no baseline to compare against. It is
// not on ATTEMPT_EVENTS, so no writer of this version can emit it, and it is known, so a line carrying it is
// a line this version classifies instead of one it trips over.
export const RESERVED_ATTEMPT_EVENTS = ["no-baseline"] as const;

export type ReservedAttemptEvent = (typeof RESERVED_ATTEMPT_EVENTS)[number];

export type KnownAttemptEvent = AttemptEvent | ReservedAttemptEvent;

// What this version may write. The reserved vocabulary is refused on purpose: recognizing an event and
// emitting it are two different permissions, and M1c is what turns the second one on.
export function isAttemptEvent(value: string): value is AttemptEvent {
  return ATTEMPT_EVENTS.some((event) => event === value);
}

// What this version can read: the event it writes, and the ones it knows by name.
export function isKnownAttemptEvent(value: string): value is KnownAttemptEvent {
  return isAttemptEvent(value) || RESERVED_ATTEMPT_EVENTS.some((event) => event === value);
}

export interface AttemptHashes {
  candidateHash: string;
  bodyHash: string;
}

// The name that identifies an attempt in its hashes: an event of the index, or -- for an attempt that
// produces no line -- the outcome its session entry records. The two vocabularies overlap on purpose;
// "error" exists only in the second one, because a generation that refused is not an event of the index.
export type AttemptIdentity = KnownAttemptEvent | "error";

// An event with no candidate and no body has nothing to tell apart, so both fields carry the digest of one
// documented identity of the attempt: the JSON array [event, skill, focus or ""]. They are equal on purpose
// -- it keeps the line the shape the index requires and groups the attempts that asked for the same thing on
// the same skill (D5). The focus is the one the flow normalized, so the digest does not tell "no focus" from
// "focus empty": the run never carries the second one.
export function attemptHashes(
  identity: AttemptIdentity,
  skillName: string,
  focus: string | undefined,
): AttemptHashes {
  const digest = sha256Digest(JSON.stringify([identity, skillName, focus ?? ""]));
  return { candidateHash: digest, bodyHash: digest };
}

// What a line is made of, before it is a line. The timestamp arrives as a Date and not as a string because
// every artifact of a run -- the createdAt of the record, the staging timestamp, the line -- names the same
// instant from one clock, and converting it here is what keeps them in one spelling.
//
// The hashes travel as a value and not as two strings: a caller that has a candidate passes its pair, and a
// caller that has none passes attemptHashes(...) of the attempt itself, so the decision of what the pair
// means stays with the function that defines it.
//
// The three paths are the places a line can point at and each is present exactly when the attempt reached
// that point: stagingPath and decisionPath for a staged candidate, historyPath for an accepted one. They are
// spelled the way the caller resolved them, which for the fields of a record is relative to the base of the
// run (src/write-base.ts).
export interface AttemptLineInput {
  now: Date;
  event: AttemptEvent;
  targetSkill: string;
  hashes: AttemptHashes;
  failureSignature: string | null;
  stagingPath?: string;
  decisionPath?: string;
  historyPath?: string;
}

// The one constructor of a line of the index. The absent paths are left out of the object instead of being
// written as undefined: a line is JSON, and a key with no value in it is a key no reader should have to
// interpret.
export function buildAttemptLine(input: AttemptLineInput): AttemptLine {
  return {
    ts: input.now.toISOString(),
    event: input.event,
    candidateHash: input.hashes.candidateHash,
    bodyHash: input.hashes.bodyHash,
    failureSignature: input.failureSignature,
    targetSkill: input.targetSkill,
    ...(input.stagingPath === undefined ? {} : { stagingPath: input.stagingPath }),
    ...(input.decisionPath === undefined ? {} : { decisionPath: input.decisionPath }),
    ...(input.historyPath === undefined ? {} : { historyPath: input.historyPath }),
  };
}
