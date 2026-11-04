// Data contracts shared by the M0 modules. Every field of DecisionRecord mirrors
// schemas/decision.schema.json (schema 0) field by field: same names, same
// optional/required split, no extra keys (the schema sets
// additionalProperties: false).

import { describe } from "./values.ts";

// Settings read from the `pi-simple-sri` key of settings.json (Q16). Both lists
// are always present and hold exact skill names, never globs (Q15).
export interface SriConfig {
  allow: string[];
  deny: string[];
}

// Q15: `deny` wins over `allow`; an empty `allow` admits everything.
export type Eligibility =
  | { eligible: true }
  | { eligible: false; reason: "not-eligible" };

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// The end of every dispatch over a closed union of this package. The parameter is `never` on purpose:
// a variant added to a union leaves the value of every dispatch that forgot it narrowed to that
// variant, so the call below stops compiling -- and a value that reaches it anyway, from a caller built
// against an older union, is refused with its own value instead of being swallowed by a fallthrough.
export function assertNever(value: never): never {
  throw new Error(`unhandled variant: ${describe(value)}`);
}

// Skill discovered by the inventory: "declared" is a directory that holds the
// skill's own SKILL.md, so lessons/ and .history/ live inside it. "standalone" is a
// single .md file with no directory of its own: its dir is the shared skills
// directory, which is not a valid write target.
//
// There is no `wasSymlink` field: it duplicated `dir !== realDir`, and a stored copy can
// disagree with the two paths it summarizes. src/skills-inventory.ts derives it with
// isSymlinkedSkill(); the serialization point derives it the same way in toDecisionSkill().
export type SkillKind = "declared" | "standalone";

export interface SkillRef {
  name: string;
  description: string;
  dir: string;
  realDir: string;
  hasLessons: boolean;
  kind: SkillKind;
}

// Q1: what counts as an observed failure.
export type EvidenceKind = "tool_error" | "user_correction" | "retry_loop";

export interface EvidenceItem {
  id: string; // "ev-" + 8 hex
  kind: EvidenceKind;
  timestamp: number; // epoch ms
  source: "transcript" | "persisted";
  toolName?: string;
  argsHash?: string;
  excerpt?: string;
}

// Q2, Q13: one replayable failing turn, re-run as-is in both arms.
export interface ReplayItem {
  prompt: string;
  cwd: string;
  predicate: string;
  // Q13, OA5: "provider/model" of the assistant turn the failure belongs to, never the bare id:
  // an id alone is ambiguous between providers that serve it. Absent when the transcript carries
  // no assistant message to name it, and then src/diagnosis.ts falls back to the model of the
  // session that runs the diagnosis, in the same spelling.
  model?: string;
  skills?: string[];
  // M1: 0-based index of the assistant turn the failure belongs to. It counts assistant turns,
  // not user turns: the replies the assistant sends after a tool result continue the turn
  // already open, so two assistant replies under the same prompt both carry 0, and two user
  // messages in a row do not advance it. Absent before the first assistant reply.
  assistantCycleIndex?: number;
  failingToolCall?: string;
  failureSignature?: string;
}

export interface Diagnosis {
  summary: string;
  failureSignature: string; // "sha256:" + 64 hex
  replayItems: ReplayItem[]; // at least 1
}

// The closed set of lesson states, declared once (M2, I4). The type is derived from the array
// and src/lesson-frontmatter.ts derives its validator from the same array, so a state cannot be
// added to the type without reaching the validator that accepts it.
export const LESSON_STATUSES = ["proposed", "accepted", "retired"] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];

// Frontmatter of a lessons/<slug>.md file.
export interface LessonDraft {
  slug: string; // [a-z0-9-], no consecutive or leading/trailing hyphens, <= 64
  title: string;
  date: string; // YYYY-MM-DD
  status: LessonStatus;
  sourceEvidence: string[]; // ids "ev-xxxxxxxx"
  gate: string; // e.g. "pending" | "accepted@<ts>" | "rejected@<ts>"
  body: string;
}

// Schema 0 is what M0 writes; M1 adds the full gate block under schema 1.
export type DecisionSchema = "pi-simple-sri/decision@0";

export type DecisionSurface = "command" | "tool";

export type DecisionOutcomeStatus = "proposed" | "not-eligible";

export interface DecisionTrigger {
  surface: DecisionSurface;
  focus: string | null;
}

// The skill block is not SkillRef: it records the eligibility verdict next to the
// paths and drops the inventory-only fields (description, hasLessons, kind).
export interface DecisionSkill {
  name: string;
  dir: string;
  realDir: string;
  wasSymlink: boolean;
  eligible: boolean;
}

// Converts an inventory skill into the skill block of a decision record (Q2). The schema sets
// additionalProperties: false on that block, and TypeScript does not enforce it: structural typing
// makes assigning a SkillRef to a field typed DecisionSkill legal, and the inventory-only fields
// (description, hasLessons, kind) would travel to decision.json without a compiler complaint. The
// literal is built field by field instead, so the record carries exactly what the schema declares,
// and the command must convert through this function rather than assigning the SkillRef.
//
// wasSymlink is derived here from the two paths instead of being stored (I13). isSymlinkedSkill()
// from src/skills-inventory.ts is not imported on purpose: this module is the record contract and
// does not depend on the inventory, and the derivation is one comparison.
export function toDecisionSkill(skill: SkillRef, eligible: boolean): DecisionSkill {
  return {
    name: skill.name,
    dir: skill.dir,
    realDir: skill.realDir,
    wasSymlink: skill.dir !== skill.realDir,
    eligible,
  };
}

export interface DecisionCandidate {
  kind: "new-lesson";
  slug: string;
  title: string;
  targetLesson?: string | null;
  lessonPath: string;
  contentHash: string; // "sha256:" + 64 hex
  bodyHash: string; // "sha256:" + 64 hex
}

export interface GateBudget {
  plannedRuns: number;
  usedRuns: number;
  interruptedAt: number | null;
}

export interface GateTokens {
  input: number;
  output: number;
}

// Schema 0 gate block: M0 never runs the gate, so every result field is null.
// `arms` and the per-item results arrive with schema 1.
export interface GateBlock {
  status: "not-run";
  threshold: null;
  reps: null;
  budget: GateBudget;
  tokens: GateTokens;
  mde: null;
}

export interface DecisionOutcome {
  status: DecisionOutcomeStatus;
  reason: string | null;
}

export interface DecisionRecord {
  schema: DecisionSchema;
  createdAt: string; // ISO date-time
  trigger: DecisionTrigger;
  skill: DecisionSkill;
  eligibility: SriConfig;
  evidence: EvidenceItem[];
  diagnosis: Diagnosis;
  candidate: DecisionCandidate;
  gate: GateBlock;
  outcome: DecisionOutcome;
}

// One line of state/attempts.jsonl. Append-only, one event per line, events
// joined by candidateHash (Q14).
//
// A refusal is an event too: a skill the settings exclude, a session with no failure and a run with no
// model leave their own line, with the hashes of the attempt (see attemptHashes in
// src/improve-flow.ts), so the index answers "why did nothing happen" for every refusal that cost no
// generation.
export interface AttemptLine {
  ts: string;
  event:
    | "proposed"
    | "no-evidence"
    | "not-eligible"
    | "no-model"
    | "accepted"
    | "gate-rejected"
    | "gate-abstained";
  candidateHash: string;
  bodyHash: string;
  targetSkill: string;
  stagingPath?: string;
  decisionPath?: string;
}
