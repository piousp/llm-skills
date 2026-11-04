// The execution contracts of the gate (M1). They describe one replay run, the verdict it produced
// and the closed vocabulary of reasons; the decision record itself stays in src/types.ts, next to
// schemas/decision.schema.json, so nothing here can move the schema.
//
// Two contracts differ from the plan as first written, because the analyst majority changed them
// (tmp/plan-M1.md, "Decisiones por mayoría", which prevails):
//
//   OA2  a run's tool calls carry the hash of their arguments, so a retry loop is countable by
//        equality, and `tool-not-reinvoked` does not exist: not re-invoking a tool is a reading of
//        a completed run, never a broken run.
//   OA6  a replay loads a set of skills, one `--skill <dir>` per directory, and never a single one:
//        the transcript does not record which skills the session had, but the diagnosis does, so
//        the set travels with the request instead of being guessed.
//
// Nothing here reads a clock, a file or the environment: these are the shapes the runner and the
// scorer trade, and every module of src/gate/ that fills one of them is another file.

import type {
  GateArm,
  GateArmTally,
  GateBounds,
  GateDesign,
  GateInterval,
  GateMde,
  GateReplayExclusion,
  GateStatus,
  GateThreshold,
  ReplayItem,
} from "../types.ts";

// The blocks the scorer produces are the blocks a decision record holds, so they are the record's own
// contracts and not a second copy of them: src/types.ts declares them next to the schema that validates
// them, and this module re-exports them so every module of src/gate/ trades one import path. A second
// declaration here would be a contract that can disagree with the record it is written into.
export type {
  GateArm,
  GateArmTally,
  GateBounds,
  GateDesign,
  GateInterval,
  GateMde,
  GateReplayExclusion,
  GateThreshold,
};

// What one run proved. `pass` and `fail` are the reading of a completed run against the expectation
// of its item; `invalid` means the run proved nothing about the skill -- a kill, a timeout, a
// non-zero exit, a stream nobody can read -- and the gate abstains instead of counting it either way
// (OA3).
export type RunOutcome = "pass" | "fail" | "invalid";

// Why a run proved nothing. The list is closed and every member is infrastructure: a run that broke
// is never silently read as a pass, because an incumbent that passes by accident would make the
// comparison meaningless.
//
// `stream-truncated` is the cap of OA10 speaking: the bytes the run wrote did not fit, so everything the
// stream says is a reading of a prefix and what came after the cut -- the error of the turn among it -- is
// not in it. A prefix that reads green is a prefix, never a pass.
export type InvalidReason =
  | "interrupted"
  | "timeout"
  | "exit-code"
  | "spawn-error"
  | "stream-unparseable"
  | "stream-truncated"
  | "cwd-missing"
  | "skill-not-loaded";

// Why a gate answered nothing. It covers the plan (too few items, a broken run, an interrupted
// gate) and the materials (no model, a skill that no longer resolves, an overlay that could not be
// built, a candidate whose bytes moved since it was staged).
export type GateAbstentionReason =
  | "insufficient-items"
  | "no-improvement"
  | "invalid-run"
  | "interrupted"
  | "no-model"
  | "skill-unavailable"
  | "overlay-failed"
  | "candidate-mismatch";

// One run of the budget: which item and repetition it is, which arm it belongs to, and everything
// the process needs to be started without reading anything else.
//
// `prompt` is the prompt of the failing turn as the transcript recorded it, without the skill
// invocation: the runner puts `/skill:<skillName>` in front of it, with one space after the name,
// because that is where the command expansion cuts the name.
//
// `skillDirs` are the directories the child loads (OA6): the arm's copy of the skill first, then
// the rest of the skills the session had, so the replay runs in the same set the failure ran in.
//
// `cwd` and `model` are the two things the failing turn pins: the directory the prompt was answered
// in and "provider/model" (OA5), never a bare id that two providers can serve.
export interface ReplayRunRequest {
  item: number;
  rep: number;
  arm: GateArm;
  prompt: string;
  skillName: string;
  skillDirs: readonly string[];
  cwd: string;
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

// One tool call of a run, as the stream reported it. The call and its result arrive in two different
// messages, so this is what joining them by toolCallId produces: the name and the hash of the
// arguments come from the assistant's toolCall, the error marks from the toolResult.
//
// `argsHash` is the canonical digest of the arguments (src/evidence.ts), the same rule the evidence
// of the session uses, which is what makes "the same call again" answerable (OA2, Q1). An empty
// string means the stream carried a result whose call is not in it, so the arguments are unknown:
// a real digest always starts with "sha256:", so the two can never be confused.
export interface ReplayToolCall {
  toolName: string;
  isError: boolean;
  argsHash: string;
}

// What one run cost and what it left behind.
//
// `outcome` of a run the runner completed is `pass`: "the process answered and the stream is
// usable", which is the only verdict the runner can prove without an expectation. A run that broke
// is `invalid` with `invalidReason`; `fail` is never produced here, because calling a completed run
// a failure is the expectation evaluator's job, and it needs the expectation to do it.
//
// `stopReason` is the last assistant message's stop reason, `null` when the stream has none.
// `usage` is the sum over every assistant message of the run.
//
// `finalText` is the answer of the turn (M1c): the text blocks of the last assistant message, joined in the order
// the stream wrote them and cut to MAX_FINAL_TEXT_CODE_POINTS. It is the one text the fourth class is judged on, and
// it travels on the run for the same reason the calls and the stream do: the record has to be re-readable without
// the process that produced it.
//
// `rawStream` is the JSONL the child wrote, verbatim, truncated to MAX_REPLAY_STREAM_BYTES: prefix
// kept, cut at the last complete newline, and `truncatedAt` then holds the original byte length
// (OA10). The flow persists it under gate/runs/, which is why it travels on the run and not in a
// module-level map. A run whose stream was cut is `invalid` with `stream-truncated`, whatever the
// prefix says.
//
// `invalidDetail` is why the run proved nothing when the process said it: the message of a spawn that
// failed (ENOENT, EACCES, an argv that does not start) or the tail of stderr. It is present exactly on a
// run that is invalid and had something to say, so an ENOENT stops looking like an EACCES.
export interface ReplayRun {
  request: ReplayRunRequest;
  outcome: RunOutcome;
  invalidReason?: InvalidReason;
  invalidDetail?: string;
  stopReason: string | null;
  toolCalls: readonly ReplayToolCall[];
  finalText: string;
  usage: { input: number; output: number };
  durationMs: number;
  exitCode: number | null;
  skillLoaded: boolean;
  rawStream: string;
  truncatedAt?: number;
}

export type ReplayRunFn = (request: ReplayRunRequest) => Promise<ReplayRun>;

// The argv of one run, apart from the process that runs it: what a test asserts without spawning
// anything, and what a record can show a reader.
export interface ReplayInvocation {
  command: string;
  args: readonly string[];
}

// What one stream said, without the process that produced it. `assistantMessages` is the count the
// runner needs to tell an empty stream from a stream whose turns are there but unreadable;
// `unparsedLines` counts the lines this parser could not use, which is how an event vocabulary of
// another version shows up as a number instead of as silence.
//
// `finalText` is the answer of the last assistant message and never the concatenation of the whole turn: a run that
// answered twice answered with its second answer, and adding the two would let a check match text no answer holds.
// A stream with no assistant message answers with "", which is the reading the evaluator refuses to judge.
export interface ParsedStream {
  toolCalls: readonly ReplayToolCall[];
  lastStopReason: string | null;
  usage: { input: number; output: number };
  skillLoaded: boolean;
  assistantMessages: number;
  unparsedLines: number;
  finalText: string;
}

// The reading of one run against the expectation of its item, and the unit the gate decides on
// (src/gate/expectation.ts).
//
// It carries the coordinates of the run and its cost because the scorer aggregates verdicts and never
// re-reads a stream: the item, the repetition and the arm are the request's own fields, and the usage is
// what the tally of the arms sums. A verdict is therefore enough to write a run into the record.
//
// `outcome` is `pass` or `fail` when the run was judged against its expectation, and `invalid` when the run
// broke: a broken run proved nothing about the skill, so the gate abstains instead of counting it either
// way (OA3). `invalidReason` is present exactly when the run is invalid, and it is the runner's reason,
// never a second reading of it.
//
// `checkFailures` is the reading of the fourth class and of no other (M1c): the checks of the item that did not pass,
// as "<index>:<kind>", plus the one coordinate the evaluator gives a turn that answered with no text. It is the
// evaluator's own field: the record of a run declares its own list and src/gate/budget.ts copies this one into it,
// which is why a verdict is never written into a record as it stands.
export interface RunVerdict {
  item: number;
  rep: number;
  arm: GateArm;
  outcome: RunOutcome;
  invalidReason?: InvalidReason;
  usage: { input: number; output: number };
  checkFailures?: readonly string[];
}

// One replay item of the diagnosis with the excerpt of the evidence it was built from, which is the only
// text the intrinsic-failure exclusion reads (OA7). ReplayItem cannot carry the excerpt -- the schema of
// decision@1 closes that block -- so the pairing travels as data and the record keeps only the exclusion it
// produces. An item the caller cannot pair keeps the field absent, and then nothing is excluded on its
// behalf.
export interface GatePlanItem {
  item: ReplayItem;
  excerpt?: string;
}

// The design of the plan is fixed by §8 and not by the caller. The one option can only lower the prefix of
// items, never raise it: the twelve runs are a hard ceiling of the budget, and an option that could lift it
// would be a way to spend without asking.
export interface GatePlanOptions {
  maxItems?: number;
}

// A gate that concluded answers with one of the three statuses GATE_STATUSES reserves for it: the two
// decisions and the abstention, without the two states of a gate that has not concluded yet.
export type GateVerdict = Exclude<GateStatus, "not-run" | "preregistered">;

// Why a concluded gate says what it says. `below-threshold` is the only reason the rule produces; the other
// three are the abstention vocabulary of the gate, shared with the reasons the flow abstains for without
// spending a run.
export type GateVerdictReason =
  | "below-threshold"
  | Extract<GateAbstentionReason, "no-improvement" | "invalid-run" | "interrupted">;

// What the gate will spend, recorded before the first run: the items it chose, the design, the rule it will be
// judged by and the floor of the design. The exclusions travel with it because a gate that ran fewer items than
// the diagnosis offered has to say which ones it dropped and why (OA7).
//
// `items` is read by the flow and `design.items` is its length: the plan is the one application of the eligibility
// predicate of OA7, so no caller re-derives the list with a second reading of it and the count cannot disagree
// with the items that are actually spent.
export interface GatePlan {
  items: readonly GatePlanItem[];
  design: GateDesign;
  threshold: GateThreshold;
  mde: GateMde;
  excluded: GateReplayExclusion[];
}

// Fewer eligible items than the paired design needs: the gate answers before spending anything. The
// exclusions still travel, because they are part of why so few items were left.
export interface GatePlanAbstained {
  abstain: "insufficient-items";
  excluded: GateReplayExclusion[];
}

export type GatePlanResult = GatePlan | GatePlanAbstained;

// What the budget proved, and nothing about how it was spent: the two arms, the interval that describes how
// little the design resolves, and the count of regressions. The flow adds the moment, the items with their
// runs, the overlays and the raw streams when it writes the record.
export interface GateEvaluation {
  verdict: GateVerdict;
  // null only on an acceptance: nothing stopped it.
  reason: GateVerdictReason | null;
  arms: { incumbent: GateArmTally; candidate: GateArmTally };
  interval: GateInterval;
  regressions: number;
}
