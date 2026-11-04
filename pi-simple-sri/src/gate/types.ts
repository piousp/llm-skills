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

export type GateArm = "incumbent" | "candidate";

// What one run proved. `pass` and `fail` are the reading of a completed run against the expectation
// of its item; `invalid` means the run proved nothing about the skill -- a kill, a timeout, a
// non-zero exit, a stream nobody can read -- and the gate abstains instead of counting it either way
// (OA3).
export type RunOutcome = "pass" | "fail" | "invalid";

// Why a run proved nothing. The list is closed and every member is infrastructure: a run that broke
// is never silently read as a pass, because an incumbent that passes by accident would make the
// comparison meaningless.
export type InvalidReason =
  | "interrupted"
  | "timeout"
  | "exit-code"
  | "spawn-error"
  | "stream-unparseable"
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
// `rawStream` is the JSONL the child wrote, verbatim, truncated to MAX_REPLAY_STREAM_BYTES: prefix
// kept, cut at the last complete newline, and `truncatedAt` then holds the original byte length
// (OA10). The flow persists it under gate/runs/, which is why it travels on the run and not in a
// module-level map.
export interface ReplayRun {
  request: ReplayRunRequest;
  outcome: RunOutcome;
  invalidReason?: InvalidReason;
  stopReason: string | null;
  toolCalls: readonly ReplayToolCall[];
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
export interface ParsedStream {
  toolCalls: readonly ReplayToolCall[];
  lastStopReason: string | null;
  usage: { input: number; output: number };
  skillLoaded: boolean;
  assistantMessages: number;
  unparsedLines: number;
}
