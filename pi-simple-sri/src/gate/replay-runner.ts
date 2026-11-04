import { spawn } from "node:child_process";
import { hashOfArguments } from "../evidence.ts";
import { REPLAY_ENV_VAR } from "../names.ts";
import { isDirectory, isPlainObject, toErrorMessage } from "../values.ts";
import type {
  InvalidReason,
  ParsedStream,
  ReplayInvocation,
  ReplayRun,
  ReplayRunFn,
  ReplayRunRequest,
  ReplayToolCall,
  RunOutcome,
} from "./types.ts";

// The replay executor (M1, S6): one `pi` child per run, the argv that starts it, the JSONL it writes
// back, and the caps that keep a stuck child from holding the gate.
//
// The shape is the one the plan measured against the real binary (tmp/plan-M1.md, S6 and §C), and it
// is deliberately the smallest one that produces a record:
//
//   argv      one command, one flag order, the prompt last; buildReplayArgs is pure so a test
//             asserts the invocation without a process.
//   stream    only `message_end` is read. The names of the tool events changed between pi 1.4.0
//             (`tool_execution_end`) and 1.5.0 (`tool_result_end`), and `message_end` carries the
//             whole message in both: assistant messages with usage, stop reason and tool calls, tool
//             results with isError, user messages with the injected skill block. An event of another
//             version is counted and skipped, never guessed (parseReplayStream).
//   proof     a run only counts if the skill was really loaded. pi expands `/skill:<name>` by
//             injecting a user message that opens with `<skill name="...">`, and when the name does
//             not resolve it passes the text through unchanged; the block in the stream is the only
//             evidence of loading a run carries.
//   caps      timeoutMs per run, SIGTERM at the deadline and SIGKILL five seconds later, an optional
//             AbortSignal that aborts the same way, and the raw stream truncated to 2 MiB with the
//             original length kept (OA9, OA10). A stream the cap cut is an invalid run: the bytes that were
//             lost can hold the error of the turn, so the prefix is read and never counted.
//   failures  a run the process could not start says why. The message of the `error` event, of the exception
//             spawn threw, or the tail of stderr travels as `invalidDetail`, so an ENOENT is not an EACCES.
//
// The seam is the spawn: `spawnFn` returns the narrow ReplayChild this module reads, so every test
// below drives a run with a fake and no test starts `pi`, touches the network or spends a token.
// `now` is the clock the duration is measured with, for the same reason.

// The binary the parent session is running. A run reproduces the failure in the same tool it was
// measured in, so the name is not a setting: a different `pi` would be a different environment.
const PI_COMMAND = "pi";

// pi's command expansion cuts the skill name at the first space (`_expandSkillCommand`,
// dist/core/agent-session.js:1727-1734), so the invocation is the prefix, the name, one space, and
// then the prompt as arguments. Never two spaces and never a newline: both would change the name.
const SKILL_INVOCATION = "/skill:";

// OA10: the raw stream is kept in the record the flow persists, so it has a cap. 2 MiB is far more
// than a turn of a few tool calls and small enough that twelve of them travel in one decision.
const MAX_REPLAY_STREAM_BYTES = 2 * 1024 * 1024;

// OA9: SIGTERM asks, SIGKILL insists. Five seconds is the grace the plan fixed, not a setting.
const SIGKILL_DELAY_MS = 5000;

// M1c: the cap of the answer a check reads. A check is a substring or a pattern, so a prefix of sixteen thousand code
// points carries every condition a case bank can express and keeps twelve answers of a budget inside one decision.
// Code points and never UTF-16 units: a surrogate pair cut in two is a character nobody can compare, which is the
// same reading src/checks.ts uses to count the characters a check may look for.
const MAX_FINAL_TEXT_CODE_POINTS = 16_000;

// Why a run nobody can read broke, when the process said it. 500 characters is far more than an errno
// message needs and small enough that the details of twelve runs travel in one decision next to their
// streams: the point is to tell one failure from another, not to keep a log.
const MAX_INVALID_DETAIL_CHARS = 500;

// The argsHash of a tool result whose call is not in the stream: the arguments are unknown, and a
// real digest always starts with "sha256:", so "" can never be confused with one or join a retry
// group built from real calls.
const UNKNOWN_ARGS_HASH = "";

// The bytes the child writes, narrowed to the one event this module reads.
export interface ReplayOutput {
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
}

// What the runner needs from a child process, and nothing else: the two output channels, the kill,
// and the two events that end a run. Narrowing the seam to this is what lets a test drive a run with
// a five-line fake instead of a whole ChildProcess; spawnWithChildProcess below is the one adapter
// onto node's real object, and it is the only place that knows the difference.
export interface ReplayChild {
  readonly stdout: ReplayOutput | null;
  readonly stderr: ReplayOutput | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  onClose(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

// The options the runner fixes for every child: the directory the failing turn ran in, no shell
// (a prompt is arbitrary text and this package never hands one to a shell), one pipe per output
// channel, and the environment below.
export interface ReplaySpawnOptions {
  cwd: string;
  shell: false;
  stdio: ["ignore", "pipe", "pipe"];
  env: NodeJS.ProcessEnv;
}

export type SpawnReplayFn = (
  command: string,
  args: readonly string[],
  options: ReplaySpawnOptions,
) => ReplayChild;

export interface ReplayRunnerOptions {
  spawnFn?: SpawnReplayFn;
  now?: () => number;
}

// The argv of one run, pure and in the order the plan fixes (OA6, OA8):
//
//   pi --mode json -p --no-session --model <provider/model> --skill <dir>... -ns /skill:<name> <prompt>
//
// `--mode json` makes the child write one JSON object per session event, which is the only channel
// this module reads; `-p` keeps it from asking for input a run has nobody to answer; `--no-session`
// keeps the replay out of the user's session history, because a replay is not a conversation.
//
// One `--skill` per directory and `-ns`: discovery stays off, so the effective set of skills is
// exactly the set the request named and a skill installed on the machine afterwards cannot change
// what the run measures (OA6).
//
// No `-ne`: cutting extensions would change the environment the failure was measured in (OA8). The
// child is guarded from the other side instead, by PI_SIMPLE_SRI_REPLAY in its environment.
export function buildReplayArgs(request: ReplayRunRequest): ReplayInvocation {
  const args: string[] = ["--mode", "json", "-p", "--no-session", "--model", request.model];

  for (const dir of request.skillDirs) {
    args.push("--skill", dir);
  }

  args.push("-ns", `${SKILL_INVOCATION}${request.skillName} ${request.prompt}`);

  return { command: PI_COMMAND, args };
}

// What one stream said, without the process that produced it. Pure: the same bytes always yield the
// same reading, so a stored stream can be re-read and the record re-checked.
//
// Only `message_end` is read (see the module comment). Everything else is counted in `unparsedLines`
// -- an event of another version, a line that is not JSON, a role this parser does not read -- which
// is a number a reader can see instead of silence. `unparsedLines` is not a verdict: a run is
// unreadable when it has no assistant message at all, and that is what `assistantMessages` says.
//
// `finalText` is the answer of the turn and not of the stream (M1c): each assistant message replaces it, so a run
// that answered twice answers with its second answer, and the text of the turn before it never joins the reading.
export function parseReplayStream(stream: string, skillName: string): ParsedStream {
  const toolCalls: ReplayToolCall[] = [];
  const indexByCallId = new Map<string, number>();
  let usage = { input: 0, output: 0 };
  let lastStopReason: string | null = null;
  let skillLoaded = false;
  let assistantMessages = 0;
  let unparsedLines = 0;
  let finalText = "";

  for (const line of stream.split("\n")) {
    const text = line.trim();
    if (text === "") continue;

    const event = parseJsonLine(text);
    if (event === undefined) {
      unparsedLines += 1;
      continue;
    }

    const message = event["type"] === "message_end" ? event["message"] : undefined;
    if (!isPlainObject(message)) {
      unparsedLines += 1;
      continue;
    }

    const role = message["role"];
    if (role === "user") {
      if (carriesSkillBlock(message["content"], skillName)) skillLoaded = true;
    } else if (role === "assistant") {
      assistantMessages += 1;
      usage = addUsage(usage, usageOf(message["usage"]));
      const stopReason = message["stopReason"];
      if (typeof stopReason === "string") lastStopReason = stopReason;
      // The answer of this message, which replaces the answer of the one before it: the turn is over when the last
      // assistant message ends, and that message is what the user reads.
      finalText = finalTextOf(message["content"]);
      unparsedLines += takeToolCalls(message["content"], toolCalls, indexByCallId);
    } else if (role === "toolResult") {
      unparsedLines += markToolResult(message, toolCalls, indexByCallId);
    } else {
      // The system message is the one role this parser meets and cannot use: it is enormous and
      // carries none of the four facts a run reports.
      unparsedLines += 1;
    }
  }

  return { toolCalls, lastStopReason, usage, skillLoaded, assistantMessages, unparsedLines, finalText };
}

// The runner the gate injects: `spawnFn` and `now` are the only things a test replaces, and in
// production both are the defaults below.
export function createReplayRunner(options: ReplayRunnerOptions = {}): ReplayRunFn {
  const spawnChild = options.spawnFn ?? spawnWithChildProcess;
  const now = options.now ?? Date.now;

  return (request) => runReplay(request, spawnChild, now);
}

async function runReplay(
  request: ReplayRunRequest,
  spawnChild: SpawnReplayFn,
  now: () => number,
): Promise<ReplayRun> {
  const startedAt = now();

  // The directory is checked before anything is spawned: a run in a directory that does not exist is
  // a fact about the request, and a child would only turn it into an exit code after a spawn.
  if (!isDirectory(request.cwd)) {
    return finish({ request, known: "cwd-missing", exitCode: null, stream: "", elapsed: now() - startedAt });
  }

  // A caller that already gave up starts no process: the run is interrupted before it costs anything.
  if (request.signal?.aborted === true) {
    return finish({ request, known: "interrupted", exitCode: null, stream: "", elapsed: now() - startedAt });
  }

  const invocation = buildReplayArgs(request);

  return await new Promise<ReplayRun>((resolve) => {
    // Bytes, not text: a multi-byte character split across two reads is only a character once the
    // whole stream is joined. stderr is joined the same way and kept apart: it is not the record, it is
    // where a child that refused says why.
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    let child: ReplayChild | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    // The message of the `error` event or of the exception spawn threw, kept until the record is built:
    // `settle` is reached from four paths and only one field explains a spawn that never happened.
    let spawnFailure: string | undefined;

    // The deadline is the hard cap of the run, so it holds the event loop while it is pending: a child
    // that says nothing still has to be stopped, and clearTimeout in settle() releases it as soon as
    // the run resolves.
    const deadline = setTimeout(() => {
      stopChild();
      settle("timeout", null);
    }, request.timeoutMs);

    function settle(known: InvalidReason | undefined, exitCode: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request.signal?.removeEventListener("abort", onAbort);
      resolve(
        finish({
          request,
          known,
          exitCode,
          stream: Buffer.concat(chunks).toString("utf8"),
          stderr: Buffer.concat(errChunks).toString("utf8"),
          ...(spawnFailure === undefined ? {} : { spawnFailure }),
          elapsed: now() - startedAt,
        }),
      );
    }

    // SIGTERM asks the child to stop; the SIGKILL that follows is not awaited, because the verdict is
    // already decided and the budget counts wall clock, not a child that refuses to die. Both are
    // sent to the child alone: this module never kills a process group it did not start.
    function stopChild(): void {
      if (child === undefined) return;
      const running = child;
      running.kill("SIGTERM");
      escalation = setTimeout(() => {
        running.kill("SIGKILL");
      }, SIGKILL_DELAY_MS);
      // A pending escalation must not keep the host process alive: nothing waits for it.
      escalation.unref();
    }

    function onAbort(): void {
      stopChild();
      settle("interrupted", null);
    }

    const spawned = trySpawn();
    if (spawned === undefined) {
      settle("spawn-error", null);
      return;
    }
    child = spawned;

    spawned.stdout?.on("data", (chunk) => {
      chunks.push(toBuffer(chunk));
    });
    // stdout is the record; stderr is not, but it is where a binary that starts and then refuses says why,
    // so it is drained into the detail of the record instead of dropped. It is drained whether or not the
    // line below keeps anything: a pipe nobody reads blocks a child that writes more than its buffer.
    spawned.stderr?.on("data", (chunk) => {
      errChunks.push(toBuffer(chunk));
    });
    spawned.onError((error) => {
      // A child that never started (ENOENT) reports here and may also report a close with a null
      // code; settle keeps the first verdict, and the message is what tells ENOENT from EACCES.
      spawnFailure = error.message;
      settle("spawn-error", null);
    });
    spawned.onClose((code) => {
      settle(undefined, code);
    });

    request.signal?.addEventListener("abort", onAbort, { once: true });

    // spawn throws for an argv it cannot even start (an unusable binary path, an option that does
    // not parse). That is a run nobody started, not an exception the gate would have to catch
    // somewhere else.
    function trySpawn(): ReplayChild | undefined {
      try {
        return spawnChild(invocation.command, invocation.args, {
          cwd: request.cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: replayEnv(),
        });
      } catch (error) {
        // The exception is the only thing that says an argv could not be started, so it is the only thing
        // that tells a bad binary path from a bad option.
        spawnFailure = toErrorMessage(error);
        return undefined;
      }
    }
  });
}

// The one production adapter onto node's child process. What it adds is the two spelled-out events:
// a child process reports its exit as "close" and its failure as "error", and the runner reads both
// through the narrow seam rather than through the emitter's overloads.
function spawnWithChildProcess(
  command: string,
  args: readonly string[],
  options: ReplaySpawnOptions,
): ReplayChild {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env,
  });

  return {
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal) => child.kill(signal),
    onClose: (listener) => {
      child.on("close", (code) => {
        listener(code);
      });
    },
    onError: (listener) => {
      child.on("error", listener);
    },
  };
}

// OA8: the child runs with this package's extension loaded -- it is not started with
// --no-extensions, because cutting extensions would change the environment the failure was measured
// in. The mitigation is the variable below: extensions/index.ts registers nothing when it is "1", so
// the child cannot start another propose or gate over itself. The parent's environment is kept whole,
// because it is part of the environment being reproduced.
function replayEnv(): NodeJS.ProcessEnv {
  return { ...process.env, [REPLAY_ENV_VAR]: "1" };
}

// What one run left behind, and the one place its verdict is decided. `known` is what the process
// already proved (a kill, a timeout, a spawn that never happened); everything else is read from the
// stream. The order is fail-closed: the first reason that holds is the verdict.
//
// The parse runs over the truncated prefix and not over the whole stream, so the facts in the record
// and the bytes the record keeps always describe the same input: a stored run can be re-read and it
// says what it said. What the truncation does change is the verdict: a run whose stream the cap cut lost
// bytes nobody read, so it is invalid and names `stream-truncated` (OA10).
function finish(record: {
  request: ReplayRunRequest;
  known: InvalidReason | undefined;
  exitCode: number | null;
  stream: string;
  stderr?: string;
  spawnFailure?: string;
  elapsed: number;
}): ReplayRun {
  const { rawStream, truncatedAt } = truncateStream(record.stream);
  const parsed = parseReplayStream(rawStream, record.request.skillName);
  const verdict = verdictOf(record.known, record.exitCode, parsed, truncatedAt);
  // Only a run that proved nothing explains itself: a completed run that wrote a warning to stderr is still
  // a run that answered, and its record says nothing it does not need to say.
  const invalidDetail =
    verdict.outcome === "invalid" ? invalidDetailOf(record.spawnFailure, record.stderr ?? "") : undefined;

  return {
    request: record.request,
    outcome: verdict.outcome,
    ...(verdict.invalidReason === undefined ? {} : { invalidReason: verdict.invalidReason }),
    ...(invalidDetail === undefined ? {} : { invalidDetail }),
    stopReason: parsed.lastStopReason,
    toolCalls: parsed.toolCalls,
    finalText: parsed.finalText,
    usage: parsed.usage,
    durationMs: record.elapsed,
    exitCode: record.exitCode,
    skillLoaded: parsed.skillLoaded,
    rawStream,
    ...(truncatedAt === undefined ? {} : { truncatedAt }),
  };
}

// `pass` here means "the process answered and the stream is usable", the only verdict the runner can
// prove on its own: whether that answer is a pass or a fail for the item is the expectation
// evaluator's reading (src/gate/expectation.ts), and it needs the expectation to make it.
function verdictOf(
  known: InvalidReason | undefined,
  exitCode: number | null,
  parsed: ParsedStream,
  truncatedAt: number | undefined,
): { outcome: RunOutcome; invalidReason?: InvalidReason } {
  if (known !== undefined) return { outcome: "invalid", invalidReason: known };

  // Any exit that is not a clean zero is a run nobody can read, and that includes a child killed by a
  // signal this module did not send: a null code with no timeout and no abort has still ended in a
  // way the run cannot account for.
  if (exitCode !== 0) return { outcome: "invalid", invalidReason: "exit-code" };

  // OA10, fail-closed: the cap of the stream cut the bytes of the run, so every reading below is a reading of
  // a prefix. The turn that re-read a file of more than 2 MiB carries its error past the cut, and a prefix
  // that reads green would count a run nobody read whole towards the unanimity of the gate.
  if (truncatedAt !== undefined) return { outcome: "invalid", invalidReason: "stream-truncated" };

  // The guard against a stream this module cannot read, which is what an event vocabulary of another
  // pi version would look like if it ever stopped emitting message_end: no assistant message means
  // the run said nothing, and a green suite over a stream nobody read is the risk the plan names.
  if (parsed.assistantMessages === 0) return { outcome: "invalid", invalidReason: "stream-unparseable" };

  // The last guard: `<skill name="...">` is pi's own evidence that the invocation resolved. Without
  // it the child answered the prompt with no skill at all, and the two arms would be the same run.
  if (!parsed.skillLoaded) return { outcome: "invalid", invalidReason: "skill-not-loaded" };

  return { outcome: "pass" };
}

// OA10: the prefix is what matters -- the head of a run says what the model did -- and the cut is
// moved back to the last complete newline, so a truncated stream is still a stream of whole JSONL
// lines and never ends in half an object. `truncatedAt` is the byte length of what the child wrote,
// which is what a reader needs to know how much is missing.
function truncateStream(stream: string): { rawStream: string; truncatedAt?: number } {
  const bytes = Buffer.byteLength(stream, "utf8");
  if (bytes <= MAX_REPLAY_STREAM_BYTES) return { rawStream: stream };

  const head = Buffer.from(stream, "utf8").subarray(0, MAX_REPLAY_STREAM_BYTES).toString("utf8");
  const lastBreak = head.lastIndexOf("\n");
  return { rawStream: lastBreak < 0 ? "" : head.slice(0, lastBreak + 1), truncatedAt: bytes };
}

// Why a run nobody can read broke, when the process said it: the message of the `error` event or of the
// exception spawn threw, and otherwise the last line the child wrote to stderr -- where a binary that starts
// and then refuses says why. Cut at MAX_INVALID_DETAIL_CHARS, and an empty answer is no field at all.
function invalidDetailOf(spawnFailure: string | undefined, stderr: string): string | undefined {
  const message = spawnFailure !== undefined && spawnFailure.trim() !== "" ? spawnFailure : undefined;
  const text = message ?? lastNonEmptyLine(stderr);
  if (text === undefined) return undefined;
  return text.length > MAX_INVALID_DETAIL_CHARS ? text.slice(0, MAX_INVALID_DETAIL_CHARS) : text;
}

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.at(-1);
}

function toBuffer(chunk: string | Buffer): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
}

function parseJsonLine(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// pi injects a user message whose first text part opens with `<skill name="..." location="...">` when
// `/skill:<name>` resolves; when the name does not resolve the text arrives unchanged and the block
// is absent. The closing quote is part of the match so a skill named `demo` cannot match `demo-2`.
function carriesSkillBlock(content: unknown, skillName: string): boolean {
  if (skillName === "") return false;
  const opening = `<skill name="${skillName}"`;
  return textsOf(content).some((text) => text.includes(opening));
}

// The answer of one assistant message: its text blocks, joined in the order the stream wrote them, cut to the cap.
// A thinking block is not part of it -- the reasoning of the model is not what the user reads -- and neither is a
// tool call: an answer split into parts is one text, so the parts are joined without a separator of their own.
function finalTextOf(content: unknown): string {
  return truncateCodePoints(textsOf(content).join(""));
}

// The cap, counted in code points: Array.from walks code points instead of UTF-16 units, so an answer of emoji is cut
// between characters and never inside one.
function truncateCodePoints(text: string): string {
  const points = Array.from(text);
  return points.length <= MAX_FINAL_TEXT_CODE_POINTS ? text : points.slice(0, MAX_FINAL_TEXT_CODE_POINTS).join("");
}

// A message holds either a bare string or parts; only text parts carry the injected block, and an
// image contributes nothing to it.
function textsOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  const texts: string[] = [];
  for (const part of content) {
    if (!isPlainObject(part)) continue;
    const text = part["text"];
    if (part["type"] === "text" && typeof text === "string") texts.push(text);
  }
  return texts;
}

// The calls of one assistant message. The name and the hash of the arguments come from here, because
// a tool result carries no arguments (plan §C): the two messages are joined later by toolCallId. The
// return value counts the toolCall parts that cannot be read, which is the caller's unparsedLines.
function takeToolCalls(
  content: unknown,
  toolCalls: ReplayToolCall[],
  indexByCallId: Map<string, number>,
): number {
  if (!Array.isArray(content)) return 0;

  let unreadable = 0;
  for (const part of content) {
    if (!isPlainObject(part) || part["type"] !== "toolCall") continue;

    const id = part["id"];
    const name = part["name"];
    if (typeof id !== "string" || typeof name !== "string") {
      unreadable += 1;
      continue;
    }

    // One entry per call id: a second entry for the same id would make the join with the result
    // depend on order, which is the one thing the id exists to avoid.
    if (indexByCallId.has(id)) continue;

    indexByCallId.set(id, toolCalls.length);
    toolCalls.push({ toolName: name, isError: false, argsHash: hashOfArguments(part["arguments"]) });
  }
  return unreadable;
}

// The result closes the entry its call opened: `isError` is the only fact a result contributes, and
// the arguments are already on the call. A result whose call is not in the stream cannot be joined
// and its arguments are unknown; it still enters the list, with an empty argsHash, so an error the
// stream reported is never dropped on the floor.
function markToolResult(
  message: Record<string, unknown>,
  toolCalls: ReplayToolCall[],
  indexByCallId: Map<string, number>,
): number {
  const toolCallId = message["toolCallId"];
  const toolName = message["toolName"];
  if (typeof toolCallId !== "string" || typeof toolName !== "string") return 1;

  const index = indexByCallId.get(toolCallId);
  if (index === undefined) {
    indexByCallId.set(toolCallId, toolCalls.length);
    toolCalls.push({ toolName, isError: message["isError"] === true, argsHash: UNKNOWN_ARGS_HASH });
    return 0;
  }

  if (message["isError"] === true) toolCalls[index].isError = true;
  return 0;
}

// Usage is summed across the assistant messages of a run: one turn can produce several replies, one
// per tool round trip, and the cost of the run is all of them.
function usageOf(value: unknown): { input: number; output: number } {
  if (!isPlainObject(value)) return { input: 0, output: 0 };
  return { input: tokenCount(value["input"]), output: tokenCount(value["output"]) };
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function addUsage(
  left: { input: number; output: number },
  right: { input: number; output: number },
): { input: number; output: number } {
  return { input: left.input + right.input, output: left.output + right.output };
}
