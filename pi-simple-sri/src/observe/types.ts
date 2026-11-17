import { sha256Hex } from "../hash.ts";
import type { FileEntry, SessionHeader } from "@earendil-works/pi-coding-agent";

// The contracts of the observer: the constants every package of it reads, the closed union of the events of
// state/observe.jsonl, and the shapes the packages hand to each other. Nothing here does I/O.
// schemas/observe-event.schema.json mirrors the union, and test/unit/observe-event-schema.test.ts keeps the two
// from drifting.

export const OBSERVE_FORMAT = "pi-simple-sri/observe@1";

// ---------------------------------------------------------------------------------------------
// Constants. Values fixed by the plan; the threshold is adjustable after the measurement (WP16).
// ---------------------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// Decay is applied at read time from the timestamp of the episode, never stored.
export const HALF_LIFE_DAYS = 90;
export const CUTOFF_DAYS = 365;
// A pattern that cannot be measured offers probation after this long.
export const PENDING_TO_PROBATION_DAYS = 14;
export const SNOOZE_MS = DAY_MS;
// In total, not per skill.
export const MAX_PROPOSALS_PER_WINDOW = 1;
export const PROPOSAL_WINDOW_MS = DAY_MS;
// A prompt nobody answers counts as `later`.
export const PROMPT_TIMEOUT_MS = 60 * 1000;
// A session file modified more recently than this is skipped until the next start.
export const MIN_IDLE_MS = 30 * MINUTE_MS;
export const LOCK_HEARTBEAT_MS = 60 * 1000;
export const LOCK_STALE_MS = 5 * MINUTE_MS;
// User messages an episode spans at most.
export const EPISODE_USER_MESSAGE_CAP = 8;
export const DEFAULT_JUDGE_CALLS_PER_DAY = 20;
export const MAX_SUMMARY_CHARS = 300;
export const MAX_PREPARE_FAILED_REASON_CHARS = 200;
// Wait before a pattern whose proposal could not be prepared is tried again: after the 1st, 2nd and 3rd-or-later failure.
export const PREPARE_BACKOFF_MS = [DAY_MS, 3 * DAY_MS, 7 * DAY_MS] as const;
// A retryable gate stages a fresh candidate at most this many times per pattern; then the lesson goes to probation.
export const MAX_GATE_RESTAGINGS = 2;

export const OBSERVATION_SOURCES = ["user-note", "judge", "self-report", "mechanical"] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

// The weight of one observation by source. The judge's is a factor: the weight is 0.6 times its confidence.
export const SOURCE_WEIGHTS: Readonly<Record<ObservationSource, number>> = {
  "user-note": 1.0,
  judge: 0.6,
  "self-report": 0.4,
  mechanical: 0.3,
};

// A pattern is proposable when every clause holds: sessions, UTC days, decayed weight, and the posterior
// P(rate > RATE_FLOOR) under Beta(1 + f, 1 + s); a pattern backed by mechanical observations alone never is.
export const THRESHOLD = {
  minSessions: 2,
  minDays: 2,
  minWeight: 1.6,
  rateFloor: 0.15,
  minPosterior: 0.8,
} as const;

// ---------------------------------------------------------------------------------------------
// Ids: "<prefix>-" plus the first 12 hex of sha256(JSON.stringify(parts)).
//   episode    ep  [skill, startEntryId]
//   observation ob [source, episodeId ?? sessionId, anchorEntryId, kind]
//   pattern    pt  [skill, firstObservationId]
//   proposal   pr  [patternId, candidateHash]
// ---------------------------------------------------------------------------------------------

export type ObserveIdPrefix = "ep" | "ob" | "pt" | "pr";

const ID_HEX_LENGTH = 12;

export function observeId(prefix: ObserveIdPrefix, parts: readonly unknown[]): string {
  return `${prefix}-${sha256Hex(JSON.stringify(parts)).slice(0, ID_HEX_LENGTH)}`;
}

// ---------------------------------------------------------------------------------------------
// Settings under `pi-simple-sri.observe` (read by src/config.ts).
// ---------------------------------------------------------------------------------------------

export interface ObserveModelRef {
  provider: string;
  id: string;
}

export interface ObserveConfig {
  enabled: boolean;
  // null: the session model judges.
  judgeModel: ObserveModelRef | null;
  judgeCallsPerDay: number;
  // Exact skill names the user allowed the gate to replay with real runs.
  replayAllow: string[];
}

// ---------------------------------------------------------------------------------------------
// The events of state/observe.jsonl: a closed union, one JSON line each.
// ---------------------------------------------------------------------------------------------

// Mechanical flags of the prefilter. Only a flag outside the mechanical ones sends an episode to the judge.
export const PREFILTER_FLAG_KINDS = ["tool-error", "correction", "rewritten-draft", "repeated-request"] as const;
export type PrefilterFlagKind = (typeof PREFILTER_FLAG_KINDS)[number];

export const EPISODE_ATTRIBUTIONS = ["explicit", "implicit"] as const;
export type EpisodeAttribution = (typeof EPISODE_ATTRIBUTIONS)[number];

// What segmentation finds: pointers into a session file, no content.
export interface Episode {
  id: string;
  skill: string;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  startEntryId: string;
  endEntryId: string;
  anchorEntryIds: string[];
  startedAt: string;
  attribution: EpisodeAttribution;
  // `provider` of the assistant messages of the episode.
  providers: string[];
}

export const JUDGED_OUTCOMES = ["findings", "clean", "failed", "skipped"] as const;
export type JudgedOutcome = (typeof JUDGED_OUTCOMES)[number];

export const GATE_KINDS = ["bank", "probation"] as const;
export type GateKind = (typeof GATE_KINDS)[number];

export const PROVENANCES = ["user", "skill-shipped", "auto"] as const;
export type Provenance = (typeof PROVENANCES)[number];

export const PROMPT_STAGES = ["a", "b"] as const;
export type PromptStage = (typeof PROMPT_STAGES)[number];

export const PROMPT_ANSWERS = ["approve", "reject", "later", "timeout", "accept"] as const;
export type PromptAnswer = (typeof PROMPT_ANSWERS)[number];

export const GATE_OUTCOME_CLASSES = ["accepted", "rejected", "retryable", "not-measurable"] as const;
export type GateOutcomeClass = (typeof GATE_OUTCOME_CLASSES)[number];

// `accepted`: the lesson is in the skill; the pattern stays closed until an observation arrives after it. `stale`: the
// proposal can no longer be accepted (the skill changed since it was staged, or it carries no hash of the skill); it
// closes that proposal and, like any tombstone, the pattern reopens on a newer observation.
export const TOMBSTONE_REASONS = ["user-rejected", "gate-rejected", "accepted", "stale"] as const;
export type TombstoneReason = (typeof TOMBSTONE_REASONS)[number];

interface ObserveEventBase {
  format: typeof OBSERVE_FORMAT;
  // UTC, from Date#toISOString.
  at: string;
}

// Written once, by the first enabled cycle; its `at` is optInAt.
export interface OptInEvent extends ObserveEventBase {
  type: "opt-in";
}

// Clean episodes are persisted too: they count as successes of the pattern.
export interface EpisodeEvent extends ObserveEventBase, Episode {
  type: "episode";
  flags: PrefilterFlagKind[];
  clean: boolean;
}

export interface JudgedEvent extends ObserveEventBase {
  type: "judged";
  episodeId: string;
  model: string;
  outcome: JudgedOutcome;
  reason?: string;
}

export interface ObservationEvent extends ObserveEventBase {
  type: "observation";
  id: string;
  episodeId: string | null;
  sessionId: string;
  skill: string;
  source: ObservationSource;
  kind: string;
  // Redacted, at most MAX_SUMMARY_CHARS.
  summary: string;
  confidence: number | null;
  weight: number;
  anchorEntryId: string;
  patternId: string;
}

export interface ProposalEvent extends ObserveEventBase {
  type: "proposal";
  id: string;
  patternId: string;
  skill: string;
  // Relative to the write base.
  stagingPath: string;
  candidateHash: string;
  gate: GateKind;
  bankPath: string | null;
  provenance: Provenance | null;
  cwd: string;
  // SHA-256 digest ("sha256:<hex>") of SKILL.md when the lesson was staged; acceptance checks against it, never against a recomputed one.
  skillContentHash: string;
}

// A proposal that could not be prepared (bank pending, generation or proposal refused, promotion conflict). The pattern
// waits PREPARE_BACKOFF_MS before the cycle tries it again.
export interface PrepareFailedEvent extends ObserveEventBase {
  type: "prepare-failed";
  skill: string;
  patternId: string;
  // At most MAX_PREPARE_FAILED_REASON_CHARS.
  reason: string;
}

export interface PromptEvent extends ObserveEventBase {
  type: "prompt";
  proposalId: string;
  stage: PromptStage;
  answer: PromptAnswer;
}

export interface GateOutcomeEvent extends ObserveEventBase {
  type: "gate-outcome";
  proposalId: string;
  class: GateOutcomeClass;
  // The status of the record outcome (src/types.ts DecisionOutcomeStatus).
  status: string;
  reason: string | null;
}

export interface TombstoneEvent extends ObserveEventBase {
  type: "tombstone";
  patternId: string;
  skill: string;
  reason: TombstoneReason;
  candidateHash: string | null;
}

export interface ForgetEvent extends ObserveEventBase {
  type: "forget";
  skill: string;
}

export type ObserveEvent =
  | OptInEvent
  | EpisodeEvent
  | JudgedEvent
  | ObservationEvent
  | ProposalEvent
  | PrepareFailedEvent
  | PromptEvent
  | GateOutcomeEvent
  | TombstoneEvent
  | ForgetEvent;

export const OBSERVE_EVENT_TYPES = [
  "opt-in",
  "episode",
  "judged",
  "observation",
  "proposal",
  "prepare-failed",
  "prompt",
  "gate-outcome",
  "tombstone",
  "forget",
] as const satisfies readonly ObserveEvent["type"][];

// What foldObserveState answers: ids deduped (the latest episode event of an id wins, the first of any other), and every
// event before optInAt (notes and self-reports excepted), at or before the `forget` of its skill, or older than
// CUTOFF_DAYS already dropped. Events keep their own `at`; decay is the reader's job.
export interface ObserveState {
  optInAt: string | null;
  episodes: EpisodeEvent[];
  judged: JudgedEvent[];
  observations: ObservationEvent[];
  proposals: ProposalEvent[];
  prepareFailures: PrepareFailedEvent[];
  prompts: PromptEvent[];
  gateOutcomes: GateOutcomeEvent[];
  tombstones: TombstoneEvent[];
  // skill -> `at` of its latest forget.
  forgets: Record<string, string>;
}

// ---------------------------------------------------------------------------------------------
// Shapes the packages hand to each other.
// ---------------------------------------------------------------------------------------------

export interface SessionsRoot {
  root: string;
  layout: "grouped" | "flat";
}

export interface SessionFileRef {
  path: string;
  headerId: string;
  size: number;
  mtimeMs: number;
}

export interface SessionRead {
  header: SessionHeader;
  entries: FileEntry[];
  // Bytes parsed: up to the last newline.
  endOffset: number;
}

export interface PrefilterFlag {
  kind: PrefilterFlagKind;
  anchorEntryId: string;
  detail: string;
}

export interface PrefilterResult {
  episodeId: string;
  flags: PrefilterFlag[];
  needsJudge: boolean;
}

export interface JudgeFinding {
  kind: string;
  summary: string;
  confidence: number;
  anchorEntryId: string;
  // An existing pattern id, or "new".
  patternRef: string;
  typeTokens: string[];
}

export interface PatternView {
  id: string;
  skill: string;
  observationIds: string[];
  sessions: number;
  days: number;
  weight: number;
  alpha: number;
  beta: number;
  pAbove: number;
  mechanicalOnly: boolean;
  proposable: boolean;
  blockedBy?: string;
}

export interface CursorEntry {
  path: string;
  size: number;
  mtimeMs: number;
  firstLineHash: string;
}

// state/observe-cursor.json: it only decides whether a file is read again.
export interface ObserveCursor {
  files: Record<string, CursorEntry>;
}

export type ReviewDispatch = "command" | "deferred-command" | "notice";
