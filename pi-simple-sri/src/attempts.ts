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
//
// `no-baseline` was the one entry of the reserve below and M1c turned that permission on: a gate of the
// directional base that finds no bank to measure against writes the line, leaves the candidate staged and
// leaves the record in the state it was, so the attempt is retryable instead of a dead end (Q23, OA1).
export const ATTEMPT_EVENTS = [
  "proposed",
  "no-evidence",
  "not-eligible",
  "no-model",
  "accepted",
  "gate-rejected",
  "gate-abstained",
  "no-baseline",
] as const;

export type AttemptEvent = (typeof ATTEMPT_EVENTS)[number];

// The reserve: the vocabulary a later version is going to emit and no writer of this one may. It is empty
// today -- `no-baseline` was its only entry and it is now an event this version writes -- and the mechanism
// stays, because the rule it enforces is the reason both predicates below exist: recognizing an event and
// emitting it are two different permissions. The next name a reader has to classify before a writer may use
// it is declared here first, and the two types derive from this list instead of being edited by hand.
// `ReservedAttemptEvent` is `never` while the list is empty, which is what makes KnownAttemptEvent equal
// AttemptEvent without either of them being rewritten.
export const RESERVED_ATTEMPT_EVENTS = [] as const;

export type ReservedAttemptEvent = (typeof RESERVED_ATTEMPT_EVENTS)[number];

export type KnownAttemptEvent = AttemptEvent | ReservedAttemptEvent;

// What this version may write. The reserved vocabulary is refused on purpose, and today that refusal is a
// refusal of nothing: the list is empty, and it is the place the next event lands.
export function isAttemptEvent(value: string): value is AttemptEvent {
  return ATTEMPT_EVENTS.some((event) => event === value);
}

// What this version can read: the event it writes, and the ones it knows by name. The two predicates stay two
// functions even while they answer alike, because the day the reserve grows again they stop answering alike.
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
//
// "directional_improvement" is the third kind of name and is no event either (M1c): the attempt it names does
// write a line -- the `proposed` one every candidate writes -- and has no failure of the transcript to point
// at, because what it fixes is the ask itself. Its diagnosis signs this identity instead of a set of evidence
// ids (src/diagnosis.ts, buildBaselineDiagnosis), so the failure signature of a directional attempt and the
// hashes of the attempt are one value computed by one rule and not two spellings of the same name.
export type AttemptIdentity = KnownAttemptEvent | "error" | "directional_improvement";

// The digest of one identity of an attempt: sha256 over the JSON array [identity, skill, focus or ""]. This is
// the one rule of the module that computes it, and the two hashes below are two uses of it.
//
// The focus is the one the flow normalized, so the digest does not tell "no focus" from "focus empty": the run
// never carries the second one.
export function attemptSignature(
  identity: AttemptIdentity,
  skillName: string,
  focus: string | undefined,
): string {
  return sha256Digest(JSON.stringify([identity, skillName, focus ?? ""]));
}

// An event with no candidate and no body has nothing to tell apart, so both fields carry the digest of one
// documented identity of the attempt. They are equal on purpose -- it keeps the line the shape the index
// requires and groups the attempts that asked for the same thing on the same skill (D5) -- and both come from
// attemptSignature, which is where the rule lives.
export function attemptHashes(
  identity: AttemptIdentity,
  skillName: string,
  focus: string | undefined,
): AttemptHashes {
  return {
    candidateHash: attemptSignature(identity, skillName, focus),
    bodyHash: attemptSignature(identity, skillName, focus),
  };
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
//
// `reason` is what the attempt answered when it was not an event of the vocabulary alone: the reason of an
// abstention with its detail (the file an overlay could not copy, the skill that no longer resolves), the reason of
// an eligibility verdict (NotEligibleReason, which tells the settings apart from the name this package reserves), and
// the problem of the material of a defect (a bank or an artifact that could not be read). It is
// additive and optional, like every other field a line gains, so a line written before it existed still
// reads as the line it was.
export interface AttemptLineInput {
  now: Date;
  event: AttemptEvent;
  targetSkill: string;
  hashes: AttemptHashes;
  failureSignature: string | null;
  stagingPath?: string;
  decisionPath?: string;
  historyPath?: string;
  reason?: string;
}

// The one constructor of a line of the index. The absent paths and the absent reason are left out of the
// object instead of being written as undefined: a line is JSON, and a key with no value in it is a key no
// reader should have to interpret.
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
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}
