import { assertNever } from "../types.ts";
import type { Expectation, ReplayItem } from "../types.ts";
import type { ReplayRun, RunOutcome, RunVerdict } from "./types.ts";

// The mechanical evaluator of the gate (M1, S7): one completed run and the expectation of its item in, one
// verdict out. Nothing here starts a process, reads a file or looks at a clock: a run is data the executor
// already produced, so a stored stream can be re-read and the verdict re-derived.
//
// Two decisions of the plan changed the table this module implements, and they are the two easiest to get
// wrong (tmp/plan-M1.md, "Decisiones por mayoría"):
//
//   OA2  a tool class has two ways to pass: the failing tool is invoked again and does not fail, or the turn
//        ends normally without repeating the failure. Not invoking the tool again is not invalid by itself,
//        so `tool-not-reinvoked` does not exist and no run is refused for it. The repetition stays readable
//        per call, because ReplayToolCall carries the digest of the arguments (Q1).
//   OA3  a tool result marked as an error is a `fail` of that run, never a discarded run: `invalid` is
//        reserved for infrastructure (a kill, a timeout, a non-zero exit, an unreadable stream, a missing
//        cwd, a skill that did not load). An incumbent reproduces its failure by design, so a run discarded
//        for showing it would abstain every gate there is.
//
// The reading is fail-closed in the one direction that matters: an invalid run wins over any other reading,
// because a run nobody can compare says nothing about the skill.

// The two stop reasons that say the turn did not end: pi reports `error` when the model call failed and
// `aborted` when something cut the turn. Any other reason -- or none, for a stream without a stop -- is a
// turn that ended on its own, which is the reading OA2 asks for.
const ABNORMAL_STOP_REASONS: ReadonlySet<string> = new Set(["error", "aborted"]);

// The stop a correction has to end with. Stricter than a tool class on purpose: the class is "the user does
// not correct the model again", and a turn that did not finish on its own did not answer. It is the same
// condition the proposer applies to the reply it accepts (src/proposer.ts).
const NORMAL_STOP_REASON = "stop";

// OA7: the closed list of failures that are intrinsic to the task and not to the skill. A `read` of a file
// that is not there fails the same way whatever the skill says, so replaying it measures the task. The
// markers are the whole rule and they match exactly: a failure whose excerpt says none of them is replayed,
// and a marker spelled otherwise is not an occasion to widen the rule from here.
const INTRINSIC_FAILURE_MARKERS: readonly string[] = [
  "ENOENT",
  "No such file or directory",
  "does not exist",
  "Path not found",
];

// Only the tools that read. A failed `edit` or `write` is a failure a lesson can address -- a wrong path is
// worth a lesson -- so excluding those would hide exactly the failures the gate exists to measure (OA7).
const READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

export function evaluateExpectation(expectation: Expectation, run: ReplayRun): RunVerdict {
  // The coordinates and the cost of the run, read once: they belong to the verdict whether it was judged or
  // discarded, and the scorer sums the cost of the arms from here.
  const identity = {
    item: run.request.item,
    rep: run.request.rep,
    arm: run.request.arm,
    usage: run.usage,
  };

  // OA3: the runner already decided this run proved nothing, and its reason is the one the record keeps.
  // Reading the content of a broken run again could turn a kill into a pass.
  if (run.outcome === "invalid") {
    return {
      ...identity,
      outcome: "invalid",
      ...(run.invalidReason === undefined ? {} : { invalidReason: run.invalidReason }),
    };
  }

  return { ...identity, outcome: outcomeOf(expectation, run) };
}

// Whether the failure of a replay item is intrinsic to the task (OA7). The tool is the one the expectation
// watches, which is the failing tool of the item: a class without a tool name is a correction, and a
// correction is never intrinsic.
export function isIntrinsicFailure(item: ReplayItem, excerpt: string | undefined): boolean {
  if (excerpt === undefined) return false;

  const tool = item.expectation.tool;
  if (tool === undefined || !READ_TOOLS.has(tool)) return false;

  return INTRINSIC_FAILURE_MARKERS.some((marker) => excerpt.includes(marker));
}

// The reading per class. The dispatch is exhaustive by typecheck: a class added to EvidenceKind loses a
// member here and stops compiling, and the parameter of assertNever keeps it closed at runtime.
function outcomeOf(expectation: Expectation, run: ReplayRun): RunOutcome {
  switch (expectation.class) {
    case "tool_error":
    case "retry_loop":
      return toolOutcome(expectation, run);
    case "user_correction":
      return correctionOutcome(run);
    default:
      return assertNever(expectation.class);
  }
}

// A tool class reads the calls of the one tool the expectation names (OA2): the run passes when none of them
// reported an error and the turn ended on its own, whether the tool was invoked once, several times or not
// at all. A turn that ends without repeating the failure is a pass, and not re-invoking is a reading of a
// completed run instead of a broken one.
//
// A retry loop is read the same way and does not need its repetitions grouped: "no invocation returned an
// error" is a property of the calls, not of their grouping. What the digest of the arguments buys is that
// the repetition is visible in the record -- the same call twice is two entries with one argsHash, and a
// call whose arguments are unknown carries an empty one, which never joins a real digest.
function toolOutcome(expectation: Expectation, run: ReplayRun): RunOutcome {
  const tool = expectation.tool;

  // A tool class without a tool name cannot say what must stop failing, and src/diagnosis.ts refuses to build
  // such an item. It cannot pass either: a pass would be a claim about no tool at all, and the closed
  // vocabulary of invalid reasons has no slot for a defect of the diagnosis.
  if (tool === undefined) return "fail";

  const calls = run.toolCalls.filter((call) => call.toolName === tool);
  if (calls.some((call) => call.isError)) return "fail";

  const stopReason = run.stopReason;
  if (stopReason !== null && ABNORMAL_STOP_REASONS.has(stopReason)) return "fail";

  return "pass";
}

// A correction has no tool to watch: what must stop is the user objecting, so the run passes when no tool
// call of the turn reported an error and the last answer stopped on its own.
function correctionOutcome(run: ReplayRun): RunOutcome {
  if (run.toolCalls.some((call) => call.isError)) return "fail";
  return run.stopReason === NORMAL_STOP_REASON ? "pass" : "fail";
}
