import fs from "node:fs";
import path from "node:path";
import type { Api, AssistantMessage, Model, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { hashOfArguments, modelIdentity } from "./evidence.ts";
import { sha256Hex } from "./hash.ts";
import { SIGNALS_FILE } from "./names.ts";
import { codePointLength, currentTime, cutCodePoints, isMissingPathError, isPlainObject, toErrorMessage } from "./values.ts";
import { appendSignalLine, writeTextAtomically } from "./writer.ts";
import { stateDir } from "./write-base.ts";

// The collector of silent signals (M3, Q25, OA1 and OA2). Two things a session does are worth a second look, and both are
// decided mechanically from what a turn already carries, with no model call, no process and no clock:
//
//   rewritten-draft   a call to `write` or `edit` names a file that an earlier turn already wrote, and the arguments
//                     differ. Two calls on the same file in the same turn are the model refining its own draft and raise
//                     nothing; the comparison is between the digests of the canonical arguments (hashOfArguments,
//                     src/evidence.ts) and never between texts, so no content is kept in memory.
//   repeated-request  the prompt of the user of this turn repeats, in substance, the one of an earlier turn: the
//                     significant tokens of the shorter prompt are a subset of the longer one's and at least three are
//                     shared. Tokens are what is left after splitting on everything that is not a letter or a digit,
//                     lowercased, and kept at MIN_TOKEN_CODE_POINTS or more. There is no stopword list: it would be a
//                     vocabulary with no owner.
//
// A signal is a suspicion and never a defect (Q25): the user may have rewritten the draft by choice or asked twice on
// purpose. So nothing here blocks the turn, edits a skill, or promises that anything was wrong: it raises a value, and
// only the confirmation of the user turns it into a measurable attempt (S6).
//
// Enmienda 1 of the author: the suspicion survives the session that raised it. state/signals.jsonl is append-only, one
// event per line -- `raised` opens a suspicion with everything it is, `consumed` closes it -- and the state of an id is
// its last event. The file is read once per session, when the session starts, and a line is appended only when a
// suspicion is new, so the write stays exceptional and the turn stays free of I/O in the ordinary case. Append-only
// avoids the read-modify-write race between two sessions of pi for the same reason the index of attempts does.
//
// This module runs on every turn of every session, so its memory has the three caps below and no fourth: they are what
// keeps the cost per turn flat whatever the session does.

export const SIGNAL_FORMAT = "pi-simple-sri/signal@1";

export const SIGNAL_KINDS = ["rewritten-draft", "repeated-request"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

// Open suspicions kept in memory. The collector runs in every session, and a session that raised two hundred of them
// would hold two hundred values until it ended: past this many, the oldest one is dropped and the file keeps it.
export const OPEN_CAP = 8;
// Files whose last write is remembered, for the rewrite above to have something to compare against. Same reason: the
// state of the collector grows with the session, and it is capped rather than unbounded.
export const TRACKED_PATHS = 32;
// Prompts remembered for the repeat above, for the same reason. A repeat is a fact about the prompt of this turn and one
// of the last few, and a session that asks the same thing twenty turns later is no longer the same request.
export const REMEMBERED_PROMPTS = 8;

// The cap of an excerpt, the same 200 code points an evidence excerpt uses (src/evidence.ts). It is a named constant
// because the schema of the file declares it and a reader has to be able to say what the limit is.
const MAX_EXCERPT_CODE_POINTS = 200;
// The floor of a repeat: below three shared tokens, two prompts that share a word are two different questions.
const MIN_SHARED_TOKENS = 3;
// What makes a token significant: shorter ones are articles, prepositions and pronouns in most languages.
const MIN_TOKEN_CODE_POINTS = 5;
// The ceiling of the file, in lines. Past it, a hydration folds it -- the last event per id, newest first -- so a file
// that a year of sessions grew stays a file a session can read in one go.
const MAX_SIGNAL_LINES = 128;

const ID_PREFIX = "sg-";
const ID_HEX_DIGITS = 8;
// The two tools a rewrite can happen through. Every other call of a turn is not a write of a file.
const WRITE_TOOL_NAMES: readonly string[] = ["write", "edit"];

// A suspicion the collector raised, with the id that names it in the whole package. It is a suspicion and not a defect:
// the user may have rewritten the draft by choice, and only the confirmation of the user turns it into an attempt (S6).
export interface Suspicion {
  id: string; // "sg-" + 8 hex of sha256([kind, sessionId, turnIndex, subject])
  kind: SignalKind;
  createdAt: string; // ISO date-time, stamped when the collector raised it
  sessionId: string;
  turnIndex: number;
  subject: string; // the rewritten path, or the normalized prompt that was repeated
  excerpt: string; // <= MAX_EXCERPT_CODE_POINTS code points
  prompt: string; // the prompt of the user of the turn it points at, as it was written; "" when the turn had none
  model?: string; // "provider/model", when the turn or the session names one
}

// One call to a file-writing tool inside a turn: the path it named and the digest of its canonical arguments.
export interface WriteCall {
  path: string;
  argsHash: string;
}

// What one turn tells the collector. It is built from the event of the turn and the branch of the session
// (turnObservationOf) and nothing else, so detectSignals stays a function of two values.
export interface TurnObservation {
  turnIndex: number;
  writes: readonly WriteCall[]; // only write and edit
  userPrompt: string | null;
  model?: string;
}

// The two facts an observation needs that a turn event does not carry: the directory a relative write path is resolved
// against, and the model of the session, for the turn whose message names none. extensions/index.ts declares the same
// two members in the context of the handler, so the context it receives is handed over as it is.
export interface TurnSources {
  readonly cwd: string;
  readonly model: Model<Api> | undefined;
}

// One file the collector follows: the turn of its last write and the digest of the arguments it was written with.
export interface TrackedPath {
  path: string;
  turnIndex: number;
  argsHash: string;
}

// One prompt the collector remembers, as the tokens the repeat is decided on. The text itself is not kept: the
// transcript already holds it, and the decision needs the tokens only.
export interface RememberedPrompt {
  readonly tokens: readonly string[];
}

// The memory of the collector between turns. It holds nothing of the file: what survives a session is the suspicion,
// and the detection starts each session from an empty state.
export interface SignalState {
  readonly paths: readonly TrackedPath[];
  readonly prompts: readonly RememberedPrompt[];
}

// What the detection answers: the suspicion without the identity the collector stamps on it (the id, the moment, the
// session). Three fields, because those three are what a turn can prove.
export interface DetectedSignal {
  kind: SignalKind;
  subject: string;
  excerpt: string;
}

// One line of state/signals.jsonl: `raised` with the whole suspicion, `consumed` with the id and the moment it was
// confirmed. The schema of the format is schemas/signal.schema.json, which is a document and the negative cases of
// test/unit/signal-schema.test.ts and not a validator of production: the reader below tolerates a line it cannot use.
export interface RaisedSignalLine {
  format: typeof SIGNAL_FORMAT;
  event: "raised";
  id: string;
  kind: SignalKind;
  createdAt: string;
  sessionId: string;
  turnIndex: number;
  subject: string;
  excerpt: string;
  prompt: string;
  model?: string;
}

// A suspicion someone confirmed. `skill` is the skill the attempt the confirmation opened belongs to (S6), and it is
// optional because a caller that consumes a suspicion without opening one -- the collector is also driven by hand -- has
// no name to give: a consumption with the moment alone still closes the id, which is why signal@1 declares the field
// optional.
export interface ConsumedSignalLine {
  format: typeof SIGNAL_FORMAT;
  event: "consumed";
  id: string;
  at: string;
  skill?: string;
}

export type SignalLine = RaisedSignalLine | ConsumedSignalLine;

// The collector of one session: the file it reads at the session start, the state it keeps between turns, and the
// suspicions it has open. It is an interface and not a class so a test can hold the value the wiring created.
export interface SignalCollector {
  hydrate(base: string, sessionId: string): Promise<void>;
  observe(observation: TurnObservation): Promise<readonly Suspicion[]>;
  pending(): readonly Suspicion[];
  // `skill`, when the caller knows it, travels to the `consumed` line: the confirmation of S6 is given for one skill, and
  // the record of the file says which one the attempt was opened for.
  take(id: string, skill?: string): Suspicion | undefined;
}

export function emptySignalState(): SignalState {
  return { paths: [], prompts: [] };
}

// The pure half of the collector: no fs, no clock, no randomness, and no mutation of the state it is given. It answers
// what the turn shows about the turns before it, and the collector is the one that decides what to do with it.
export function detectSignals(observation: TurnObservation, state: SignalState): readonly DetectedSignal[] {
  const detected: DetectedSignal[] = [];

  const rewritten = rewrittenDraftOf(observation, state);
  if (rewritten !== undefined) detected.push(rewritten);

  const repeated = repeatedRequestOf(observation, state);
  if (repeated !== undefined) detected.push(repeated);

  return detected;
}

// The other half of the memory: the turn folded into the state of the collector. It answers a new state instead of
// mutating the one it was given, which is what lets detectSignals be pure over the same value.
export function foldObservation(state: SignalState, observation: TurnObservation): SignalState {
  const paths = [...state.paths];
  for (const write of observation.writes) {
    const index = paths.findIndex((tracked) => tracked.path === write.path);
    if (index !== -1) paths.splice(index, 1);
    // The last write of a path inside one turn is the one that stands for the turn, and the newest path is first.
    paths.unshift({ path: write.path, turnIndex: observation.turnIndex, argsHash: write.argsHash });
  }

  const prompts = [...state.prompts];
  if (observation.userPrompt !== null) {
    const tokens = significantTokens(observation.userPrompt);
    // A turn whose prompt is the one the previous turn already carried is the same user message: the agent loop runs
    // several turns under one prompt, and remembering it twice would make the memory say nothing new.
    const newest = prompts[0];
    if (tokens.length > 0 && (newest === undefined || !sameTokens(newest.tokens, tokens))) {
      prompts.unshift({ tokens });
    }
  }

  return { paths: paths.slice(0, TRACKED_PATHS), prompts: prompts.slice(0, REMEMBERED_PROMPTS) };
}

// What one turn is, read from the event of the turn and the branch of the session. The wiring does this and nothing
// else: the tool calls of the turn live on the message the model answered with, and the prompt of the user is the last
// user message the branch carries.
export function turnObservationOf(
  event: Pick<TurnEndEvent, "turnIndex" | "message">,
  branch: readonly SessionEntry[],
  sources: TurnSources,
): TurnObservation {
  const message = event.message;
  const answered = message.role === "assistant" ? message : undefined;
  const writes = answered === undefined ? [] : writesOf(answered.content, sources.cwd);
  const userPrompt = userPromptOf(branch);

  // The turn names its model on the assistant reply it produced, which is the model a failure of that turn belongs to
  // (OA5 of M1). A turn whose message is not an assistant reply names none, and the model of the session stands in for
  // it: a turn is one reply of one model, and the session holds the one that just ran.
  const model =
    (answered === undefined ? undefined : modelIdentity(answered.provider, answered.model)) ??
    sessionModelIdentity(sources.model);

  return {
    turnIndex: event.turnIndex,
    writes,
    userPrompt,
    ...(model === undefined ? {} : { model }),
  };
}

// The collector of one session, over the base of the run. The base arrives as a function and not as a path because
// getAgentDir() is read when the call happens and never when the module is imported (dist/core/settings-manager.js:123):
// the wiring passes `() => writeBase(getAgentDir())`, and nothing is resolved before a session starts.
export function createSignalCollector(base: () => string): SignalCollector {
  // The session the collector is accumulating for. Without it the id would name no session and the file would carry a
  // suspicion nobody can trace, so a collector that was never hydrated keeps its state and raises nothing.
  let sessionId: string | null = null;
  let state: SignalState = emptySignalState();
  // Newest first, so the cap drops the oldest, and the same order the fold of the file answers.
  let open: Suspicion[] = [];
  // Every id the file carried at the session start plus every id raised in this session. It is what makes `observe`
  // answer only the new ones: the same turn observed twice yields the same id, and an id the file already holds is a
  // suspicion that was raised before.
  const known = new Set<string>();

  return {
    // Read once per session and fold it: the state of an id is its last event, `raised` opens and `consumed` closes.
    // The base of the run is an argument here because this is the read the session start does, for the session it is
    // starting; the write below resolves the base again from the function, which is the lazy read of getAgentDir().
    async hydrate(hydratedBase: string, hydratedSessionId: string): Promise<void> {
      // Named before the read: a file that cannot be read leaves the collector with nothing remembered, and that is a
      // collector that still works for the session instead of one that raises nothing at all.
      sessionId = hydratedSessionId;

      const signalPath = path.join(stateDir(hydratedBase), SIGNALS_FILE);
      const file = await readSignalFile(signalPath);
      const folded = foldSignalLines(file.lines);

      state = emptySignalState();
      open = folded.open;
      known.clear();
      for (const id of folded.known) known.add(id);

      // Outside the turn and once per session: a file over its ceiling is folded here, so the next session that hydrates
      // reads a file under it.
      if (file.total > MAX_SIGNAL_LINES) {
        await compactSignalFile(signalPath, hydratedBase, folded.last);
      }
    },

    // One turn: the detection over the state, the turn folded into it, and a line for every suspicion that is new. The
    // answer is only the new ones, which is what the wiring notifies.
    async observe(observation: TurnObservation): Promise<readonly Suspicion[]> {
      const currentSession = sessionId;
      if (currentSession === null) return [];

      const detected = detectSignals(observation, state);
      state = foldObservation(state, observation);

      const raised: Suspicion[] = [];
      for (const detection of detected) {
        const id = signalId(detection.kind, currentSession, observation.turnIndex, detection.subject);
        if (known.has(id)) continue;
        known.add(id);

        const suspicion: Suspicion = {
          id,
          kind: detection.kind,
          createdAt: currentTime().toISOString(),
          sessionId: currentSession,
          turnIndex: observation.turnIndex,
          subject: detection.subject,
          excerpt: detection.excerpt,
          // The prompt of the turn it points at, as it was written; a turn without a user message says so with "".
          prompt: observation.userPrompt ?? "",
          ...(observation.model === undefined ? {} : { model: observation.model }),
        };

        open.unshift(suspicion);
        open = open.slice(0, OPEN_CAP);
        raised.push(suspicion);

        await recordSignalLine(base, raisedLineOf(suspicion));
      }

      return raised;
    },

    pending(): readonly Suspicion[] {
      return [...open];
    },

    // Consume: the suspicion leaves the open set and the file is told, with the skill of the attempt it opened when the
    // caller names one (S6). The line is appended without making the caller wait, because this is the synchronous call of
    // a command and the file is the memory of the suspicion, not the confirmation itself; a file that cannot be written
    // leaves the `raised` line as the last event of the id, which means the next session sees the suspicion as still open
    // instead of losing it.
    take(id: string, skill?: string): Suspicion | undefined {
      const index = open.findIndex((suspicion) => suspicion.id === id);
      if (index === -1) return undefined;

      const [consumed] = open.splice(index, 1);
      void recordSignalLine(base, consumedLineOf(consumed.id, skill));
      return consumed;
    },
  };
}

// The id of a suspicion: "sg-" plus the first 8 hex of the hash over (kind, session, turn, subject). The session is part
// of the material on purpose -- the same rewrite in another session is a new occurrence with its own id, and it is
// reported again -- so the id names one occurrence and never one class of occurrence.
function signalId(kind: SignalKind, sessionId: string, turnIndex: number, subject: string): string {
  const material = JSON.stringify([kind, sessionId, turnIndex, subject]);
  return `${ID_PREFIX}${sha256Hex(material).slice(0, ID_HEX_DIGITS)}`;
}

// The first write of the turn that rewrites a file of an earlier turn with other arguments. The first one is enough: the
// notice names one occurrence per kind and turn, and the id carries the turn it was noticed in.
function rewrittenDraftOf(observation: TurnObservation, state: SignalState): DetectedSignal | undefined {
  for (const write of observation.writes) {
    const tracked = state.paths.find((entry) => entry.path === write.path);
    // A write of the same turn is the model refining its draft, and an identical digest is the same call repeated.
    if (tracked === undefined || tracked.turnIndex === observation.turnIndex) continue;
    if (tracked.argsHash === write.argsHash) continue;

    return {
      kind: "rewritten-draft",
      subject: write.path,
      excerpt: cutCodePoints(`turn ${tracked.turnIndex}: ${write.path}`, MAX_EXCERPT_CODE_POINTS),
    };
  }

  return undefined;
}

// The prompt of this turn repeating one of the prompts remembered. Two conditions and no third: one of the two token
// sets is contained in the other, and at least MIN_SHARED_TOKENS tokens are shared.
function repeatedRequestOf(observation: TurnObservation, state: SignalState): DetectedSignal | undefined {
  const prompt = observation.userPrompt;
  if (prompt === null) return undefined;

  const tokens = significantTokens(prompt);
  if (tokens.length < MIN_SHARED_TOKENS) return undefined;

  // The prompt of the previous turn is the same user message when the agent loop runs several turns under one prompt.
  // Asking the same text again later is not something the tokens can tell apart, so the message that continues is the
  // one case this detection lets go: a repeat that a new user message spells identically is read as the message it
  // repeats.
  const newest = state.prompts[0];
  if (newest !== undefined && sameTokens(newest.tokens, tokens)) return undefined;

  for (const remembered of state.prompts) {
    if (!isSubset(tokens, remembered.tokens) && !isSubset(remembered.tokens, tokens)) continue;
    if (sharedTokens(tokens, remembered.tokens) < MIN_SHARED_TOKENS) continue;

    return {
      kind: "repeated-request",
      subject: tokens.join(" "),
      excerpt: cutCodePoints(prompt, MAX_EXCERPT_CODE_POINTS),
    };
  }

  return undefined;
}

// Splitting on everything that is not a letter or a digit and keeping the long ones, lowercased. A set and not a list:
// a word said twice in one prompt is one token, and the subset test is about the words a prompt carries.
function significantTokens(text: string): readonly string[] {
  const tokens = new Set<string>();
  for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token !== "" && codePointLength(token) >= MIN_TOKEN_CODE_POINTS) tokens.add(token);
  }
  return [...tokens];
}

function isSubset(of: readonly string[], superset: readonly string[]): boolean {
  return of.every((token) => superset.includes(token));
}

function sharedTokens(left: readonly string[], right: readonly string[]): number {
  return left.filter((token) => right.includes(token)).length;
}

function sameTokens(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && isSubset(left, right);
}

// The calls of the turn that write a file, with the path resolved against the working directory: a relative path is
// what the tool of pi accepts, and the same file named relatively in one turn and absolutely in another is one file.
function writesOf(content: AssistantMessage["content"], cwd: string): WriteCall[] {
  const writes: WriteCall[] = [];

  for (const part of content) {
    if (part.type !== "toolCall" || !WRITE_TOOL_NAMES.includes(part.name)) continue;

    const args = part.arguments;
    if (!isPlainObject(args)) continue;
    const target = args.path;
    if (typeof target !== "string" || target === "") continue;

    writes.push({ path: path.isAbsolute(target) ? target : path.resolve(cwd, target), argsHash: hashOfArguments(args) });
  }

  return writes;
}

// The prompt of the turn: the last user message the branch carries, which at the end of a turn is the message this turn
// answered. A message without text (images only) is not a prompt, and the branch of a session that has not spoken yet
// answers null.
function userPromptOf(branch: readonly SessionEntry[]): string | null {
  let prompt: string | null = null;

  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const text = textOf(entry.message.content);
    if (text.trim() !== "") prompt = text;
  }

  return prompt;
}

// The text of a message, which is a bare string or parts of which only the text ones count: an image contributes
// nothing to a prompt.
function textOf(content: UserMessage["content"]): string {
  if (typeof content === "string") return content;

  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

function sessionModelIdentity(model: Model<Api> | undefined): string | undefined {
  return model === undefined ? undefined : modelIdentity(model.provider, model.id);
}

function raisedLineOf(suspicion: Suspicion): RaisedSignalLine {
  return { format: SIGNAL_FORMAT, event: "raised", ...suspicion };
}

function consumedLineOf(id: string, skill?: string): ConsumedSignalLine {
  const line: ConsumedSignalLine = { format: SIGNAL_FORMAT, event: "consumed", id, at: currentTime().toISOString() };
  return skill === undefined ? line : { ...line, skill };
}

// The one write of the collector, and it does not fail its caller: the notice is what the suspicion is for, so a file
// that cannot be written leaves the suspicion raised and reported while the file keeps what it had. The next session
// then reads a file that does not know this id, which is worse than an exception only if someone trusted the file to be
// a log of every notice, and nobody does: the file is the memory of the suspicions nobody consumed yet.
async function recordSignalLine(base: () => string, line: SignalLine): Promise<void> {
  try {
    await appendSignalLine(base(), line);
  } catch {
    // Swallowed on purpose: see the comment above.
  }
}

interface SignalFileRead {
  lines: SignalLine[];
  // Every line that ended with a newline, whether it could be read or not: the ceiling of the file is about what the
  // file holds and not about what this version understands of it.
  total: number;
}

// The reader of the file, tolerant by contract: a line that is not JSON, not an object, of another format or without the
// fields of its event is skipped and counted, never thrown. A file that is absent is the first session of a base and
// answers nothing.
async function readSignalFile(signalPath: string): Promise<SignalFileRead> {
  let text: string;
  try {
    text = await fs.promises.readFile(signalPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return { lines: [], total: 0 };
    throw new Error(`cannot read ${signalPath}: ${toErrorMessage(error)}`);
  }

  const rawLines = text.split("\n");
  // The text after the last newline is either the empty string the append leaves behind or a line that was never
  // finished: a truncated tail is discarded instead of read as the event it almost was.
  rawLines.pop();

  const lines: SignalLine[] = [];
  for (const raw of rawLines) {
    const line = signalLineOf(raw);
    if (line !== undefined) lines.push(line);
  }

  return { lines, total: rawLines.length };
}

function signalLineOf(raw: string): SignalLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!isPlainObject(parsed) || parsed.format !== SIGNAL_FORMAT) return undefined;
  if (typeof parsed.id !== "string") return undefined;

  if (parsed.event === "consumed") {
    if (typeof parsed.at !== "string") return undefined;
    return typeof parsed.skill === "string"
      ? { format: SIGNAL_FORMAT, event: "consumed", id: parsed.id, at: parsed.at, skill: parsed.skill }
      : { format: SIGNAL_FORMAT, event: "consumed", id: parsed.id, at: parsed.at };
  }

  if (parsed.event !== "raised") return undefined;
  if (!isSignalKind(parsed.kind)) return undefined;
  if (
    typeof parsed.createdAt !== "string" ||
    typeof parsed.sessionId !== "string" ||
    typeof parsed.turnIndex !== "number" ||
    typeof parsed.subject !== "string" ||
    typeof parsed.excerpt !== "string" ||
    typeof parsed.prompt !== "string"
  ) {
    return undefined;
  }

  const raised: RaisedSignalLine = {
    format: SIGNAL_FORMAT,
    event: "raised",
    id: parsed.id,
    kind: parsed.kind,
    createdAt: parsed.createdAt,
    sessionId: parsed.sessionId,
    turnIndex: parsed.turnIndex,
    subject: parsed.subject,
    excerpt: parsed.excerpt,
    prompt: parsed.prompt,
  };
  return typeof parsed.model === "string" ? { ...raised, model: parsed.model } : raised;
}

function isSignalKind(value: unknown): value is SignalKind {
  return typeof value === "string" && (SIGNAL_KINDS as readonly string[]).includes(value);
}

interface FoldedSignals {
  // Every id the file holds, newest event first.
  known: string[];
  // The suspicions whose last event is `raised`, newest first and capped.
  open: Suspicion[];
  // The last event of every id, newest first: what the file says if it has to be rewritten, and what the fold reads.
  last: SignalLine[];
}

function foldSignalLines(lines: readonly SignalLine[]): FoldedSignals {
  // Backwards, keeping the first id met: the order of the fold is the file from the newest event to the oldest, which is
  // the order a rewritten file keeps.
  const lastById = new Map<string, SignalLine>();
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!lastById.has(line.id)) lastById.set(line.id, line);
  }

  const open: Suspicion[] = [];
  for (const line of lastById.values()) {
    if (line.event === "raised") open.push(suspicionOf(line));
  }

  return { known: [...lastById.keys()], open: open.slice(0, OPEN_CAP), last: [...lastById.values()] };
}

function suspicionOf(line: RaisedSignalLine): Suspicion {
  return {
    id: line.id,
    kind: line.kind,
    createdAt: line.createdAt,
    sessionId: line.sessionId,
    turnIndex: line.turnIndex,
    subject: line.subject,
    excerpt: line.excerpt,
    prompt: line.prompt,
    ...(line.model === undefined ? {} : { model: line.model }),
  };
}

// The rewrite of a file over its ceiling: the last event of every id, from the newest to the oldest, up to
// MAX_SIGNAL_LINES. writeTextAtomically is the write of the chokepoint and the root is the state directory, which exists
// because the file this rewrites is in it.
async function compactSignalFile(signalPath: string, base: string, last: readonly SignalLine[]): Promise<void> {
  const text = last
    .slice(0, MAX_SIGNAL_LINES)
    .map((line) => `${JSON.stringify(line)}\n`)
    .join("");
  await writeTextAtomically(signalPath, text, stateDir(base));
}
