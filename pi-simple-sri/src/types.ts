// Data contracts shared by the modules of the loop. Every field of DecisionRecord mirrors
// schemas/decision.schema.json (schema 1) field by field: same names, same
// optional/required split, no extra keys (the schema sets
// additionalProperties: false).

// The event vocabulary of the index lives in src/attempts.ts, next to the hashes and the constructor of the
// line it names. The import is type-only, so this module -- the contract root of the package -- keeps no run
// time dependency on the module that reads and writes the lines.
import type { KnownAttemptEvent } from "./attempts.ts";
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

// Q18: what a replayed turn has to stop doing, as data the gate executes instead of prose it would have
// to parse. `class` names the failure and with it the check a replayed turn is judged by; `tool` is the
// tool that check watches, present exactly when the class needs one -- a tool class without a tool name
// cannot say what must stop failing, so such an item is not replayable (src/diagnosis.ts).
//
// `version` is the version of the check and not of the record: a gate that meets a version it does not
// implement refuses the item instead of guessing what the class meant one version ago. src/diagnosis.ts
// derives the text a human reads from this descriptor (describeExpectation), so the prose never becomes
// the contract again.
export interface Expectation {
  class: EvidenceKind;
  version: 1;
  tool?: string;
}

// Q2, Q13: one replayable failing turn, re-run as-is in both arms.
export interface ReplayItem {
  prompt: string;
  cwd: string;
  expectation: Expectation;
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

// One schema at a time (OA12): schema 1 is the only one this package writes and the only one
// test/unit/schema-reader.ts validates. A decision.json of schema 0 is a historical artifact the package
// never revalidates, so there is no dispatcher between the two.
export type DecisionSchema = "pi-simple-sri/decision@1";

export type DecisionSurface = "command" | "tool";

// The closed set of gate statuses, declared once and derived to a type the way LESSON_STATUSES is: the
// schema declares the same list as an enum, so a status added here without reaching the schema is a
// drift the suites catch (test/unit/decision-schema.test.ts).
export const GATE_STATUSES = [
  "not-run",
  "preregistered",
  "gate-accepted",
  "gate-rejected",
  "gate-abstained",
] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

// "accepted" is not implied by a gate status: the acceptance decides it after the gate ran, and the record
// carries that moment in outcome.decidedAt. A failed acceptance is not a status of the record: it writes
// nothing, the staged record keeps the "gate-accepted" the gate decided, and the reason it refused is
// reported to the caller and left out of decision.json -- which is why no member names it.
export type DecisionOutcomeStatus =
  | "proposed"
  | "not-eligible"
  | "gate-accepted"
  | "gate-rejected"
  | "gate-abstained"
  | "accepted";

// The one mapping from what the gate decided to what the record's outcome says. The record is built
// through it, so `outcome.status` and `gate.status` cannot disagree while this table is the only place
// that relates the two. The schema ties no two properties together, so the table is the owner of the
// relation and test/unit/decision-schema.test.ts proves it is total over GATE_STATUSES and that every
// status it answers is one the schema accepts.
//
// A preregistered gate has not decided anything yet: the candidate was proposed and the gate is running,
// which is what "proposed" already says, and inventing a verdict for it is what this mapping refuses.
const OUTCOME_STATUS_OF_GATE: Record<GateStatus, DecisionOutcomeStatus> = {
  "not-run": "proposed",
  preregistered: "proposed",
  "gate-accepted": "gate-accepted",
  "gate-rejected": "gate-rejected",
  "gate-abstained": "gate-abstained",
};

export function outcomeStatusFor(gateStatus: GateStatus): DecisionOutcomeStatus {
  return OUTCOME_STATUS_OF_GATE[gateStatus];
}

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

// The token pair of one thing that spent tokens: the generation that produced the candidate, one arm of
// the gate, or the whole run.
export interface GateTokens {
  input: number;
  output: number;
}

// What the whole decision spent, split by where it went. `total` is the sum of the other three and is
// recorded so a reader never adds them again: it is the cost of the decision, gate included.
export interface GateTokenTally {
  proposal: GateTokens;
  incumbent: GateTokens;
  candidate: GateTokens;
  total: GateTokens;
}

// The two arms of a paired replay: the skill as it stands, and the skill with the candidate lesson.
export type GateArm = "incumbent" | "candidate";

// The rule the gate is judged by, recorded before the first run so it cannot be chosen once the result is
// known. `version` is the version of the rule: a reader that does not implement it refuses the record
// instead of interpreting the numbers of an older rule.
export interface GateThreshold {
  rule: "unanimous-and-strictly-better";
  candidatePasses: number;
  incumbentPassesMax: number;
  version: 1;
}

// The design the budget pays for: reps per item, items replayed, runs planned in total, and the arms every
// run is measured in.
export interface GateDesign {
  reps: number;
  items: number;
  plannedRuns: number;
  arms: GateArm[];
}

// The floor of the design and not the threshold: `resolution` is the smallest difference this many runs
// can tell apart and `requiredDifference` is the difference the rule demands. The two travel together
// because a rule that asks for less than the floor is measuring noise. `basis` names what the numbers were
// computed from, so a reader knows the arithmetic behind them before trusting the floor.
export interface GateMde {
  basis: string;
  runsPerArm: number;
  resolution: number;
  requiredDifference: number;
}

// What was recorded before the first run of the gate: the moment, the rule, the design and the floor.
export interface GatePreregistration {
  recordedAt: string;
  threshold: GateThreshold;
  design: GateDesign;
  mde: GateMde;
}

// One run of one item in one arm, which is the unit the gate decides on.
export type RunOutcome = "pass" | "fail" | "invalid";

export interface ReplayRunRecord {
  arm: GateArm;
  rep: number;
  outcome: RunOutcome;
  // Why a run was discarded instead of judged. The vocabulary belongs to the executor of the replay
  // (src/gate/replay-runner.ts), so this field is a string and not an enum of the record contract: a reader
  // that does not know a reason still knows the run was discarded.
  invalidReason?: string;
  // Why the run proved nothing, when the process said it: the message of a spawn that failed or the tail of
  // stderr, cut at 500 characters. Present on an invalid run that had something to say, so an ENOENT stops
  // looking like an EACCES.
  invalidDetail?: string;
  stopReason: string | null;
  skillLoaded: boolean;
  usage: GateTokens;
  durationMs: number;
  exitCode: number | null;
  // Path of the raw JSONL of the run, when the flow persists it: the audit trail of a verdict, which is
  // what makes an abstention explainable after the fact.
  stream?: string;
  // OA10: the byte length of the stream before the cap cut it, present exactly when it was cut. The run is
  // then invalid with `stream-truncated`, and this is how much of it nobody read.
  truncatedAt?: number;
}

// One replay item of the diagnosis and every run of it, with the expectation it was judged by. The
// expectation is copied from the replay item on purpose: the record of the gate has to stand alone, and a
// reader must not have to join it against the diagnosis to know what was tested.
export interface ReplayItemRecord {
  index: number;
  failureSignature: string;
  expectation: Expectation;
  model: string;
  reps: ReplayRunRecord[];
}

export interface GateArmTally {
  passes: number;
  runs: number;
  tokens: GateTokens;
}

export interface GateBounds {
  low: number;
  high: number;
}

// Descriptive and not decisive: the rule decides, the interval says how little the design resolves.
export interface GateInterval {
  method: "wilson";
  alpha: number;
  incumbent: GateBounds;
  candidate: GateBounds;
  difference: GateBounds;
}

// A replay item the gate did not run, with the failure it names and why it cannot be replayed (OA7): a
// failure intrinsic to the task says nothing about the skill, and dropping the item silently would leave a
// gate that ran fewer items than the diagnosis offered with no record of the difference.
export interface GateReplayExclusion {
  failureSignature: string;
  reason: "intrinsic-failure";
}

// The two skill trees the replay ran against, with the hashes that let a reader prove the candidate was
// measured against the skill it was written for.
export interface GateOverlays {
  incumbent: string;
  candidate: string;
  skillContentHash: string;
  manifestHash: string;
}

export interface GateReplayResult {
  completedAt: string;
  verdict: "gate-accepted" | "gate-rejected" | "gate-abstained";
  reason: string | null;
  items: ReplayItemRecord[];
  arms: { incumbent: GateArmTally; candidate: GateArmTally };
  interval: GateInterval;
  regressions: number;
  excluded: GateReplayExclusion[];
  overlays: GateOverlays;
}

// The gate block, discriminated by `basis`: every field that depends on how the gate decides lives under a
// key named after the basis (`replay` today), and the fields of the top level -- basis, status, budget,
// tokens, preregistration -- are neutral to it. M1 has one basis, so this union has one member and its
// variants are told apart by `status`; a second basis is one more member here, and every `assertNever`
// over the block then lists what has to learn about it.
export interface GateNotRun {
  basis: "replay";
  status: "not-run";
  budget: GateBudget;
  tokens: GateTokenTally;
  preregistration: null;
  replay: null;
}

// Preregistered and not yet run: the rule, the design and the floor exist, the runs do not.
export interface GatePreregistered {
  basis: "replay";
  status: "preregistered";
  budget: GateBudget;
  tokens: GateTokenTally;
  preregistration: GatePreregistration;
  replay: null;
}

// Concluded: the preregistration it was judged by and the result it produced are both recorded, so a reader
// can check the rule against the numbers it decided.
export interface GateConcluded {
  basis: "replay";
  status: "gate-accepted" | "gate-rejected" | "gate-abstained";
  budget: GateBudget;
  tokens: GateTokenTally;
  preregistration: GatePreregistration;
  replay: GateReplayResult;
}

export type GateBlock = GateNotRun | GatePreregistered | GateConcluded;

export interface DecisionOutcome {
  status: DecisionOutcomeStatus;
  reason: string | null;
  // The moment the status was decided, when it was: null while the candidate is only proposed, and a
  // date-time once the gate or the acceptance decided. It is the field that makes "decided before or after
  // the runs" answerable from the record alone.
  decidedAt: string | null;
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
// model leave their own line, with the hashes of the attempt (see attemptHashes in src/attempts.ts), so the
// index answers "why did nothing happen" for every refusal that cost no generation.
//
// `event` is the vocabulary ATTEMPT_EVENTS declares (src/attempts.ts) plus the events this version only
// recognizes: a line written by M1c is still a line this version reads, and no reader fails on an event it
// cannot name. Only the constructor of that module, buildAttemptLine, decides which events are emitted, so
// the wider type here never becomes a wider writer.
//
// `failureSignature` is required and nullable (OA4): the line of a refusal that has no diagnosis carries an
// explicit null, so the field is always there and a reader never guesses whether its absence meant "no
// failure" or "an older writer".
export interface AttemptLine {
  ts: string;
  event: KnownAttemptEvent;
  candidateHash: string;
  bodyHash: string;
  failureSignature: string | null;
  targetSkill: string;
  stagingPath?: string;
  decisionPath?: string;
  // Where the acceptance left the authoritative record of the run: .history/<timestamp>/decision.json
  // inside the skill, present exactly on the line of an accepted candidate, which is the one event that
  // wrote a skill.
  historyPath?: string;
  // Why the attempt answered nothing, when the flow knows it: the reason of the abstention with its detail --
  // the file an overlay could not copy, the skill that no longer resolves. Additive and optional, so every
  // line written before this field existed is still a line of this index.
  reason?: string;
}
