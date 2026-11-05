import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentToolResult,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall, Usage, UserMessage } from "@earendil-works/pi-ai";
import sriExtension, {
  registerSurfaces,
  type SkillImproveToolDefinition,
  type SriCommandRegistration,
  type SriExtensionApi,
  type SriNoticeContext,
  type SriSeams,
  type SriSessionStartEvent,
  type SriSessionStartHandler,
  type SriTurnEndContext,
  type SriTurnEndHandler,
} from "../../extensions/index.ts";
import {
  ENTRY_TYPE,
  type ImprovementEntry,
  type SkillImproveContext,
  type SkillImproveUi,
  type NotifyType,
} from "../../src/command-skill-improve.ts";
import { serializeLesson } from "../../src/lesson-frontmatter.ts";
import type { GateRequest } from "../../src/gate/flow.ts";
import { feedbackNoticeText, signalText } from "../../src/messages.ts";
import { COMMAND_NAME, REPLAY_ENV_VAR, SIGNALS_FILE } from "../../src/names.ts";
import type { ProposeFn } from "../../src/improve-flow.ts";
import { SIGNAL_FORMAT, type Suspicion } from "../../src/signals.ts";
import {
  SKILL_IMPROVE_TOOL_NAME,
  skillImproveParams,
  type ToolDetails,
} from "../../src/tool-skill-improve.ts";
import { LESSON_GATE_ACCEPTED } from "../../src/types.ts";
import type { AttemptLine, LessonDraft, SkillRef, SriConfig } from "../../src/types.ts";
import type { StagingWriteInput, StagingWriteResult } from "../../src/writer.ts";

// The wiring (P10) is exercised the way pi loads it: a fake extension API that records what the
// factory registers, plus every seam of the loop replaced, so no test here reads the settings file,
// walks the real skill inventory, reaches a provider or writes a byte. What the wiring itself adds
// -- the package root, the entry channel and the message channel -- is observed through those
// recorders, because that is exactly the part of the run this file owns.
//
// The fake API is typed as the slice the registrations declare (SriExtensionApi) instead of pi's whole
// ExtensionAPI: fifty members that no assertion here reads would prove nothing. registerSurfaces is the
// entry point that takes the slice, and the default export pi loads takes pi's own ExtensionAPI and
// narrows it, which is the compile-time proof that the slice still fits.
//
// The command handler and the tool's execute() are driven through the registrations the factory
// made, never through a direct call to src/: the wiring is what this test is about, and a
// registration the extension forgot is a failure here and not in a real session.

const COMMAND_USAGE = /Usage: \/skill-improve <skill> \[focus\]/;

const NOW = new Date("2026-11-02T14:03:22.481Z");
const NOW_ISO = "2026-11-02T14:03:22.481Z";
const CWD = "/work/reports";
// The base of the run: the bytes land under <base>/staging and every record names them relative to it.
const AGENT_DIR = "/agent";
const BASE = `${AGENT_DIR}/sri`;
const STAGING_PATH = `${BASE}/staging/20261102T140322481Z/pdf-tools`;
const DECISION_PATH = `${STAGING_PATH}/decision.json`;
const STAGING_RELATIVE = "staging/20261102T140322481Z/pdf-tools";
const DECISION_RELATIVE = `${STAGING_RELATIVE}/decision.json`;
const CONTENT_HASH = `sha256:${"a".repeat(64)}`;
const BODY_HASH = `sha256:${"b".repeat(64)}`;

const DEFAULT_CONFIG: SriConfig = { allow: [], deny: [] };

const SKILL_TEXT = "# pdf-tools\n\nUse pdftotext for plain text.\n";

const LESSON_TITLE = "Use the lattice strategy for merged cells";
const LESSON_SLUG = "use-the-lattice-strategy-for-merged-cells";
const LESSON_BODY = "- Use pdfplumber with `lattice` for tables with merged cells.";

const USAGE: Usage = {
  input: 412,
  output: 137,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 549,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const BASE_MS = Date.parse("2026-11-02T14:00:00.000Z");
// The session both event handlers are driven with: the id of a suspicion carries it, so the seeded line of the hydration
// test and the id the collector computes have to name the same one.
const SESSION_ID = "session-test";

const SKILL: SkillRef = {
  name: "pdf-tools",
  description: "Extract tables from PDFs",
  dir: "/skills/pdf-tools",
  realDir: "/skills/pdf-tools",
  hasLessons: false,
  kind: "declared",
};

const STAGED: StagingWriteResult = {
  stagingPath: STAGING_PATH,
  lessonPath: `${STAGING_PATH}/lessons/${LESSON_SLUG}.md`,
  decisionPath: DECISION_PATH,
  contentHash: CONTENT_HASH,
  bodyHash: BODY_HASH,
};

// Session entries are literals, as in test/unit/command-skill-improve.test.ts: the flow only reads
// the message, its timestamp and its tool calls.
function messageEntry(seconds: number, message: SessionMessageEntry["message"]): SessionMessageEntry {
  return {
    type: "message",
    id: `entry-${seconds}`,
    parentId: null,
    timestamp: new Date(BASE_MS + seconds * 1000).toISOString(),
    message,
  };
}

function userEntry(seconds: number, text: string): SessionMessageEntry {
  const message: UserMessage = {
    role: "user",
    content: text,
    timestamp: BASE_MS + seconds * 1000,
  };
  return messageEntry(seconds, message);
}

function toolCallEntry(seconds: number): SessionMessageEntry {
  const call: ToolCall = {
    type: "toolCall",
    id: "call-1",
    name: "bash",
    arguments: { command: "pdftotext report.pdf -" },
  };
  const message: AssistantMessage = {
    role: "assistant",
    content: [call],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: USAGE,
    stopReason: "toolUse",
    timestamp: BASE_MS + seconds * 1000,
  };
  return messageEntry(seconds, message);
}

function toolErrorEntry(seconds: number): SessionMessageEntry {
  return messageEntry(seconds, {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: [{ type: "text", text: "pdftotext: cannot open report.pdf" }],
    isError: true,
    timestamp: BASE_MS + seconds * 1000,
  });
}

// One prompt, one bash call and its error: the branch a run needs to find evidence, and the entry
// of another kind a real branch also carries.
function failingBranch(): SessionEntry[] {
  return [
    userEntry(0, "extract the merged-cell table from report.pdf"),
    {
      type: "custom",
      id: "entry-custom",
      parentId: "entry-0",
      timestamp: new Date(BASE_MS + 500).toISOString(),
      customType: ENTRY_TYPE,
      data: {},
    },
    toolCallEntry(1),
    toolErrorEntry(2),
  ];
}

// A session without failures: the run has nothing to learn from and the wiring must still report it.
function emptyBranch(): SessionEntry[] {
  return [];
}

interface NotifiedCall {
  message: string;
  type: NotifyType;
}

interface EntryCall {
  customType: string;
  data: ImprovementEntry | undefined;
}

interface SentMessage {
  customType: string;
  content: string;
  display: boolean;
}

interface InventoryCall {
  cwd: string;
  agentDir: string;
}

// What the loop asked for, in the order it asked: every seam the factory injects records here, so a
// test can tell "the wiring ran the loop" from "the wiring only registered".
interface FlowLog {
  settingsReads: string[];
  inventories: InventoryCall[];
  skillReads: string[];
  proposals: Parameters<ProposeFn>[0][];
  writes: StagingWriteInput[];
  attempts: AttemptLine[];
  attemptRoots: string[];
}

interface HarnessOptions {
  branch?: readonly SessionEntry[];
  config?: SriConfig;
  skills?: readonly SkillRef[];
  hasUI?: boolean;
}

interface Harness {
  pi: SriExtensionApi;
  seams: SriSeams;
  log: FlowLog;
  commands: Map<string, SriCommandRegistration>;
  commandNames: string[];
  tools: Map<string, SkillImproveToolDefinition>;
  toolNames: string[];
  entries: EntryCall[];
  messages: SentMessage[];
  /** Every handler the factory registered, by event name: one per event, as pi holds them. */
  handlers: Map<string, unknown>;
  /** Every event name the factory listened to, in order: one handler per event and no others. */
  onEvents: string[];
  notified: NotifiedCall[];
  /** Every read of the context's `ui`, in order: a copied context reads it eagerly (see the test below). */
  uiReads: string[];
  modelCalls: string[];
  /** The context a command handler or a tool execute receives, with the fields both read. */
  ctx: SkillImproveContext;
  command(): SriCommandRegistration;
  tool(): SkillImproveToolDefinition;
}

// The lesson a successful generation produces, built from the evidence the flow handed over so the
// draft's source-evidence follows the input instead of a hardcoded list.
function lessonDraftFor(input: Parameters<ProposeFn>[0]): LessonDraft {
  return {
    slug: LESSON_SLUG,
    title: LESSON_TITLE,
    date: "2026-11-02",
    status: "accepted",
    sourceEvidence: input.evidence.map((item) => item.id),
    gate: LESSON_GATE_ACCEPTED,
    body: LESSON_BODY,
  };
}

function successfulPropose(log: FlowLog): ProposeFn {
  return async (input) => {
    log.proposals.push(input);
    const draft = lessonDraftFor(input);
    const lesson = serializeLesson(draft);
    if (!lesson.ok) assert.fail(`the lesson of this test must serialize: ${lesson.error}`);
    return { ok: true, value: { draft, lessonText: lesson.value, usage: { input: 412, output: 137 } } };
  };
}

function commandOf(commands: Map<string, SriCommandRegistration>): SriCommandRegistration {
  const command = commands.get(COMMAND_NAME);
  assert.ok(command !== undefined, `the factory must register the ${COMMAND_NAME} command`);
  return command;
}

function toolOf(tools: Map<string, SkillImproveToolDefinition>): SkillImproveToolDefinition {
  const tool = tools.get(SKILL_IMPROVE_TOOL_NAME);
  assert.ok(tool !== undefined, `the factory must register the ${SKILL_IMPROVE_TOOL_NAME} tool`);
  return tool;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const log: FlowLog = {
    settingsReads: [],
    inventories: [],
    skillReads: [],
    proposals: [],
    writes: [],
    attempts: [],
    attemptRoots: [],
  };
  const commands = new Map<string, SriCommandRegistration>();
  const commandNames: string[] = [];
  const tools = new Map<string, SkillImproveToolDefinition>();
  const toolNames: string[] = [];
  const entries: EntryCall[] = [];
  const messages: SentMessage[] = [];
  const handlers = new Map<string, unknown>();
  const onEvents: string[] = [];
  const notified: NotifiedCall[] = [];
  const uiReads: string[] = [];
  const modelCalls: string[] = [];

  const pi: SriExtensionApi = {
    registerCommand(name, registration) {
      commandNames.push(name);
      commands.set(name, registration);
    },
    registerTool(tool) {
      toolNames.push(tool.name);
      tools.set(tool.name, tool);
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
    sendMessage(message) {
      messages.push(message);
    },
    on(event, handler) {
      onEvents.push(event);
      // One handler per event name, which is what pi holds: a second registration for the same event is a second
      // subscription nothing below could tell apart from the first.
      assert.equal(handlers.has(event), false, `the factory registered two handlers for ${event}`);
      handlers.set(event, handler);
      // The unsubscribe pi hands back: no test here unregisters a handler, and a registration that a test
      // could drop would make the count of notices meaningless.
      return () => undefined;
    },
  };

  const seams: SriSeams = {
    // The base is not a dependency of the wiring: it follows the agent directory the loop resolves, so
    // the test hands over the agent directory and never a path of its own.
    agentDir: AGENT_DIR,
    now: () => NOW,
    readConfig: (settingsPath) => {
      log.settingsReads.push(settingsPath);
      return options.config ?? DEFAULT_CONFIG;
    },
    listSkills: async (listOptions) => {
      log.inventories.push(listOptions);
      return [...(options.skills ?? [SKILL])];
    },
    readSkillText: async (skill) => {
      log.skillReads.push(skill.name);
      return SKILL_TEXT;
    },
    propose: successfulPropose(log),
    write: async (input) => {
      log.writes.push(input);
      return STAGED;
    },
    appendAttempt: async (root, line) => {
      log.attemptRoots.push(root);
      log.attempts.push(line);
    },
  };

  const ctx: SkillImproveContext = {
    cwd: CWD,
    hasUI: options.hasUI ?? true,
    model: undefined,
    // Both are required by the contract and nothing in the wiring reaches them: the reload lives in the
    // command handler and this suite only records where the handler and the seams are connected.
    waitForIdle: async () => {},
    reload: async () => {},
    sessionManager: {
      getBranch: () => [...(options.branch ?? failingBranch())],
      getSessionId: () => "session-test",
    },
    // A model registry that fails loudly: the proposer is a seam in every test here, so a call
    // through the registry means the wiring lost the seam it injected.
    modelRegistry: {
      complete: async (model) => {
        modelCalls.push(model.id);
        throw new Error("the wiring test never reaches the session model");
      },
    },
    // A getter, as pi builds every member of the context it hands a handler (createContext() in
    // dist/core/extensions/runner.js), and one that records its reads: a wiring that copies the
    // context reads this eagerly, before the run needs it.
    get ui() {
      uiReads.push("ui");
      return {
        notify: (message: string, type?: NotifyType) => {
          notified.push({ message, type: type ?? "info" });
        },
      };
    },
  };

  return {
    pi,
    seams,
    log,
    commands,
    commandNames,
    tools,
    toolNames,
    entries,
    messages,
    handlers,
    onEvents,
    notified,
    uiReads,
    modelCalls,
    ctx,
    command: () => commandOf(commands),
    tool: () => toolOf(tools),
  };
}

// Seams that refuse to be used: every one of them records the call and throws, so a factory that
// resolves the settings, the inventory, the skill, the proposer, the writer or the index at
// registration time fails here instead of passing on a machine that happens to have the files.
function refusingSeams(): { seams: SriSeams; touched: string[] } {
  const touched: string[] = [];
  const refuse = (name: string): never => {
    touched.push(name);
    throw new Error(`the factory ran the ${name} seam: registration must run no part of the loop`);
  };

  const seams: SriSeams = {
    now: () => refuse("now"),
    readConfig: () => refuse("readConfig"),
    listSkills: async () => refuse("listSkills"),
    readSkillText: async () => refuse("readSkillText"),
    propose: async () => refuse("propose"),
    write: async () => refuse("write"),
    appendAttempt: async () => refuse("appendAttempt"),
  };

  return { seams, touched };
}

// The single text part of the answer, so the assertions read as the sentence the model would read.
function textOf(result: AgentToolResult<ToolDetails>): string {
  const part = result.content.at(0);
  assert.ok(part !== undefined && part.type === "text", "the tool must answer with a text part");
  return part.text;
}

// Puts the environment back the way a test found it: an unset variable stays unset, and assigning
// undefined would set the string "undefined" instead of removing it.
function restoreEnv(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[REPLAY_ENV_VAR];
    return;
  }
  process.env[REPLAY_ENV_VAR] = previous;
}

// The directory pi reports as its agent directory in the tests that drive an event handler. The collector of the extension
// resolves its base from there -- the wiring passes `() => writeBase(getAgentDir())` and never a path of its own -- so the
// variable points at a directory of the fixture and nothing of a real installation is read or written.
function useAgentDir(t: TestContext): string {
  const agentDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-wiring-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
  return agentDir;
}

function uiOf(harness: Harness): SkillImproveUi {
  return {
    notify: (message: string, type?: NotifyType) => {
      harness.notified.push({ message, type: type ?? "info" });
    },
  };
}

function handlerOf(harness: Harness, event: "session_start" | "turn_end"): unknown {
  const handler = harness.handlers.get(event);
  assert.ok(handler !== undefined, `the factory must register a ${event} handler`);
  return handler;
}

function sessionStartHandlerOf(harness: Harness): SriSessionStartHandler {
  return handlerOf(harness, "session_start") as SriSessionStartHandler;
}

function turnEndHandlerOf(harness: Harness): SriTurnEndHandler {
  return handlerOf(harness, "turn_end") as SriTurnEndHandler;
}

// Drives the one session_start handler the factory registered, with a context narrowed to the members the handler reads
// (SriNoticeContext) and one reason. The handler hydrates the collector and then reports or stays silent, so what it reports
// lands in the same recorder the command's own notices use.
async function startSession(harness: Harness, reason: SriSessionStartEvent["reason"]): Promise<void> {
  const ctx: SriNoticeContext = {
    ui: uiOf(harness),
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => SESSION_ID,
    },
  };
  await sessionStartHandlerOf(harness)({ type: "session_start", reason }, ctx);
}

// A turn whose assistant message calls `write` once: the collector reads the tool calls of the turn from this message, and
// the arguments it hashes are the ones the two turns of a rewrite differ in.
function writeTurn(callId: string, target: string, content: string): AssistantMessage {
  const call: ToolCall = { type: "toolCall", id: callId, name: "write", arguments: { path: target, content } };
  return {
    role: "assistant",
    content: [call],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: USAGE,
    stopReason: "toolUse",
    timestamp: BASE_MS,
  };
}

// Drives the one turn_end handler the factory registered. The answer is asserted here and not at every call site: the
// handler adds nothing to the turn, so every call has to answer undefined.
async function endTurn(harness: Harness, turnIndex: number, message: AssistantMessage): Promise<void> {
  const ctx: SriTurnEndContext = {
    ui: uiOf(harness),
    cwd: CWD,
    model: undefined,
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => SESSION_ID,
    },
  };
  const answer = await turnEndHandlerOf(harness)({ type: "turn_end", turnIndex, message }, ctx);
  assert.equal(answer, undefined, "the turn_end handler adds nothing to the turn and answers undefined");
}

// The line the collector would write for the rewrite below, as the seeded file carries it: the id is computed here and not
// with the collector's own function, so the file is the input of the hydration and not a copy of its output.
function raisedSignalLine(turnIndex: number, subject: string): string {
  const material = JSON.stringify(["rewritten-draft", SESSION_ID, turnIndex, subject]);
  const id = `sg-${createHash("sha256").update(material).digest("hex").slice(0, 8)}`;
  return `${JSON.stringify({
    format: SIGNAL_FORMAT,
    event: "raised",
    id,
    kind: "rewritten-draft",
    createdAt: "2026-11-02T14:03:22.481Z",
    sessionId: SESSION_ID,
    turnIndex,
    subject,
    excerpt: `turn ${turnIndex - 1}: ${subject}`,
    prompt: "",
  })}\n`;
}

// The suspicion the two turns below raise, as the sentence of src/messages.ts renders it: the notice is asserted whole,
// because a notice that named another file or another kind would still be a notice.
function rewrittenDraftSuspicion(turnIndex: number, subject: string): Suspicion {
  const material = JSON.stringify(["rewritten-draft", SESSION_ID, turnIndex, subject]);
  return {
    id: `sg-${createHash("sha256").update(material).digest("hex").slice(0, 8)}`,
    kind: "rewritten-draft",
    createdAt: "2026-11-02T14:03:22.481Z",
    sessionId: SESSION_ID,
    turnIndex,
    subject,
    excerpt: `turn ${turnIndex - 1}: ${subject}`,
    prompt: "",
  };
}

test("the factory registers the command and the tool, exactly once each", () => {
  const harness = makeHarness();

  assert.equal(registerSurfaces(harness.pi, harness.seams), undefined);

  // The user-facing names are the contract of the package: /skill-improve and skill_improve.
  assert.deepEqual(harness.commandNames, [COMMAND_NAME]);
  assert.deepEqual(harness.toolNames, [SKILL_IMPROVE_TOOL_NAME]);
  assert.equal(COMMAND_NAME, "skill-improve");
  assert.equal(SKILL_IMPROVE_TOOL_NAME, "skill_improve");

  const command = harness.command();
  assert.equal(typeof command.handler, "function");
  // M1: the description no longer promises that nothing is ever edited -- this command is the one surface that
  // accepts -- and it says where the acceptance happens and what the gate costs.
  assert.equal(command.description?.includes("/skill-improve <skill> [focus]"), true);
  assert.equal(command.description?.includes("only when the gate passes"), true);
  assert.equal(command.description?.includes("spends tokens"), true);
  assert.equal(command.description?.includes("never accepts"), false);
  // M1c: the two branches of the gate and the staged run are named, and so is the one state that spends nothing and can be
  // retried -- a description that promised a verdict for a bank that is not there would be a promise the flow does not keep.
  assert.equal(command.description?.includes("--bank=<path>"), true);
  assert.equal(command.description?.includes("--defect"), true);
  assert.equal(command.description?.includes("--staged=<stagingPath>"), true);
  assert.equal(command.description?.includes("retryable"), true);
  // M2 (S4): the description names the floor of the design as well as its cost -- two distinct items, and the word the
  // answer carries when the budget has nothing to compare.
  assert.equal(command.description?.includes("at least two distinct items"), true);
  assert.equal(command.description?.includes("insufficient-items"), true);

  // The registered tool is the one src/tool-skill-improve.ts builds: the same schema object, so the
  // tool the model calls and the tool the P9 tests exercised cannot drift apart.
  const tool = harness.tool();
  assert.equal(tool.name, SKILL_IMPROVE_TOOL_NAME);
  assert.equal(tool.parameters, skillImproveParams);
  assert.equal(typeof tool.execute, "function");
  // Q7: the description travels in every session that loads the tool and says what it never does.
  assert.equal(tool.description.includes("never edits the skill"), true);
  assert.equal(tool.description.includes("never accepts a candidate"), true);
  // The same two branches from the side of the model, which is the only reader of this description, plus the state that
  // spends nothing.
  assert.equal(tool.description.includes("bankPath"), true);
  assert.equal(tool.description.includes("defect"), true);
  assert.equal(tool.description.includes("retryable"), true);
  // M1c (S11, Q26): the model is told, before it spends anything, that this tool is also where a correction or a
  // rejection is recorded -- the other channel, the notice at the start of a session, is one a model may never read.
  assert.equal(tool.description.includes("Before any of that is spent"), true);
  assert.equal(tool.description.includes("a correction or a rejection"), true);
});

// M1c (S11, Q26, OA8): the package tells the reader that the feedback of a session can be recorded, from two channels
// that cover the failure of the other. The first one is the session_start handler: one line, once per session, and never on
// a reload. M3 (S5) adds the second one, the collector of signals, which is registered on turn_end.
test("the factory registers one handler per event, and registering them reports nothing", () => {
  const harness = makeHarness();

  registerSurfaces(harness.pi, harness.seams);

  // One handler per event: a second session_start handler would be the second notice OA8 accepted the risk of only once,
  // and a second turn_end handler would raise every suspicion twice.
  assert.deepEqual(harness.onEvents, ["session_start", "turn_end"]);
  assert.equal(harness.handlers.size, 2);
  // The registration is not the notice: a session that never starts reports nothing, and nothing of the loop ran.
  assert.deepEqual(harness.notified, []);
});

test("the session_start handler reports the feedback notice once, as info", async (t) => {
  const harness = makeHarness();
  useAgentDir(t);
  registerSurfaces(harness.pi, harness.seams);

  await startSession(harness, "startup");

  assert.deepEqual(harness.notified, [{ message: feedbackNoticeText(), type: "info" }]);
  // The notice names both surfaces of the package and the two costs of the gate, and promises nothing else: the tokens a
  // run spends and the floor of two distinct failures below which the replay base has nothing to measure.
  const notice = harness.notified[0].message;
  assert.equal(notice.includes("/skill-improve"), true);
  assert.equal(notice.includes(SKILL_IMPROVE_TOOL_NAME), true);
  assert.equal(notice.includes("--bank=<path>"), true);
  assert.equal(notice.includes("spends tokens"), true);
  assert.equal(notice.includes("at least two distinct tool failures"), true);
  // It is one line, and it reports and returns: no file, no model and no candidate behind it.
  assert.equal(notice.includes("\n"), false);
  assert.deepEqual(harness.log.settingsReads, []);
  assert.deepEqual(harness.log.inventories, []);
  assert.deepEqual(harness.log.writes, []);
  assert.deepEqual(harness.log.attempts, []);
  assert.deepEqual(harness.entries, []);
  assert.deepEqual(harness.modelCalls, []);
});

// The value a reload carries is the one that is not news: pi reloads a session after an acceptance (M2), and the notice
// of the reloaded session is the line the reader has just read.
test("the session_start handler does not report the notice on a reload", async (t) => {
  const harness = makeHarness();
  useAgentDir(t);
  registerSurfaces(harness.pi, harness.seams);

  await startSession(harness, "reload");

  assert.deepEqual(harness.notified, []);
  // Every other reason is a session with something to say, so the silence is the reload's and not the handler's.
  for (const reason of ["startup", "new", "resume", "fork"] as const) {
    const other = makeHarness();
    registerSurfaces(other.pi, other.seams);
    await startSession(other, reason);
    assert.equal(other.notified.length, 1, `the notice must be reported for the reason ${reason}`);
  }
});

// M3 (S5): the collector is hydrated on every session start, and a reload is exactly the early return above. The proof is
// the silence of the turn below: the file already carries the line the two turns would raise, so a hydration that happened
// leaves nothing to report, while a hydration that the reload skipped would report a suspicion twice over two sessions.
test("the session_start handler hydrates the collector on a reload, and reports nothing", async (t) => {
  const agentDir = useAgentDir(t);
  const harness = makeHarness();
  const subject = "/work/notes.md";
  fs.mkdirSync(path.join(agentDir, "sri", "state"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "sri", "state", SIGNALS_FILE), raisedSignalLine(2, subject), "utf8");
  registerSurfaces(harness.pi, harness.seams);

  await startSession(harness, "reload");
  await endTurn(harness, 1, writeTurn("call-1", subject, "the first draft"));
  await endTurn(harness, 2, writeTurn("call-2", subject, "the second draft"));

  assert.deepEqual(harness.notified, []);
  // The hydrated line is still the only one: an id the file already carries is not raised a second time.
  assert.equal(fs.readFileSync(path.join(agentDir, "sri", "state", SIGNALS_FILE), "utf8").split("\n").filter((line) => line !== "").length, 1);
});

// M3 (S5): a file written twice in two turns with other arguments is the one signal the collector raises here, and the
// wiring does three things with it and nothing else: it observes, it reports one line per new suspicion, and it answers
// undefined. Nothing is added to the session, nothing is sent and no gate runs.
test("the turn_end handler reports one notice for a rewritten draft and answers undefined", async (t) => {
  useAgentDir(t);
  const harness = makeHarness();
  const subject = "/work/notes.md";
  registerSurfaces(harness.pi, harness.seams);

  await startSession(harness, "startup");
  harness.notified.splice(0);

  await endTurn(harness, 1, writeTurn("call-1", subject, "the first draft"));
  assert.equal(harness.notified.length, 0);

  await endTurn(harness, 2, writeTurn("call-2", subject, "the second draft"));
  // One notice, whole: the sentence of src/messages.ts for the suspicion the two turns raise, as info.
  const expected = signalText(rewrittenDraftSuspicion(2, subject));
  assert.deepEqual(
    harness.notified.map((notice) => ({ message: notice.message, type: notice.type })),
    [{ message: expected, type: "info" }],
  );
  // The sentence names the subject and calls the occurrence a suspicion: it never claims a defect, because the user may
  // have rewritten the draft by choice.
  assert.equal(expected.includes(subject), true);
  assert.equal(expected.includes("suspicion"), true);
  // S12: the notice prints the id a confirmation names and the command it is typed with, because the id is the one part of a
  // suspicion the user can type and the file it lives in is not where the user should have to look for it.
  const id = rewrittenDraftSuspicion(2, subject).id;
  assert.equal(expected.includes(id), true);
  assert.equal(expected.includes(`--signal=${id}`), true);
  assert.equal(expected.includes(`/${COMMAND_NAME}`), true);

  // The turn is pi's: no entry, no message, no candidate and no gate.
  assert.deepEqual(harness.entries, []);
  assert.deepEqual(harness.messages, []);
  assert.deepEqual(harness.log.writes, []);
  assert.deepEqual(harness.log.attempts, []);
  assert.deepEqual(harness.modelCalls, []);
});

// The other half of the rule: a turn that rewrites nothing reports nothing, so the notice is the suspicion's and not the
// handler's.
test("the turn_end handler reports nothing when the turn shows nothing", async (t) => {
  useAgentDir(t);
  const harness = makeHarness();
  registerSurfaces(harness.pi, harness.seams);

  await startSession(harness, "startup");
  harness.notified.splice(0);

  await endTurn(harness, 1, writeTurn("call-1", "/work/notes.md", "the first draft"));
  await endTurn(harness, 2, writeTurn("call-2", "/work/other.md", "another file"));

  assert.deepEqual(harness.notified, []);
});

// M3 (S6): the collector the wiring hydrates for the turn is the one the command confirms a suspicion with -- one object,
// passed as a dependency of the command -- so a suspicion a turn raised is the one a `/skill-improve --signal=<id>` of the
// same session reads. The proof is the answer: the id the command names is the id the handler raised, so a command holding
// another collector, or none, would answer that no suspicion of that id is open.
test("the collector of the wiring is the one the command confirms a suspicion with", async (t) => {
  useAgentDir(t);
  const harness = makeHarness();
  const subject = "/work/notes.md";
  registerSurfaces(harness.pi, harness.seams);

  await startSession(harness, "startup");
  harness.notified.splice(0);
  await endTurn(harness, 1, writeTurn("call-1", subject, "the first draft"));
  await endTurn(harness, 2, writeTurn("call-2", subject, "the second draft"));

  // The suspicion the second turn raised, by the id the notice of src/messages.ts cannot be read for.
  const id = rewrittenDraftSuspicion(2, subject).id;
  await harness.command().handler(`pdf-tools --signal=${id}`, harness.ctx);

  const report = harness.notified.at(-1);
  assert.equal(report?.type, "warning");
  // The run found the suspicion and answered the state of an attempt with no bank to measure it against; a command holding
  // another collector would have answered that the suspicion is not open.
  assert.equal(report?.message.includes(id), true);
  assert.equal(report?.message.includes("--bank=<path>"), true);
  assert.equal(report?.message.includes("No suspicion"), false);

  // Nothing was spent and nothing of the loop ran: no generation, no candidate, no line of the index and no model call.
  assert.deepEqual(harness.log.proposals, []);
  assert.deepEqual(harness.log.writes, []);
  assert.deepEqual(harness.log.attempts, []);
  assert.deepEqual(harness.modelCalls, []);
});

// The module is imported at the top of this file, before any test ran; a fake API that is never
// handed to the factory holds no registration, and importing again reuses the same module instance.
// So the module body registers nothing: only the factory call does.
test("importing the module registers nothing: only the factory call does", async () => {
  const harness = makeHarness();

  assert.deepEqual(harness.commandNames, []);
  assert.deepEqual(harness.toolNames, []);
  assert.deepEqual(harness.onEvents, []);
  assert.deepEqual(harness.entries, []);

  // The default export is the entry point pi calls with its own ExtensionAPI; registerSurfaces is the
  // same registration over the slice a test can fake.
  const imported = await import("../../extensions/index.ts");
  assert.equal(imported.default, sriExtension);
  assert.equal(imported.registerSurfaces, registerSurfaces);
  assert.deepEqual(harness.commandNames, []);
  assert.deepEqual(harness.toolNames, []);
  assert.deepEqual(harness.onEvents, []);
});

// Rule 3 of the slice: no process, no socket, no timer, no file read at registration. Every seam of
// the loop refuses to be used here, and the root the factory derives is path arithmetic, so the
// factory only registers: nothing is looked up, nothing is written and nothing is reported.
test("registering runs no part of the loop", () => {
  const harness = makeHarness();
  const refusing = refusingSeams();

  registerSurfaces(harness.pi, refusing.seams);

  assert.deepEqual(refusing.touched, []);
  // The registration did happen; only the loop was left untouched.
  assert.deepEqual(harness.commandNames, [COMMAND_NAME]);
  assert.deepEqual(harness.toolNames, [SKILL_IMPROVE_TOOL_NAME]);
  assert.deepEqual(harness.onEvents, ["session_start", "turn_end"]);
  assert.deepEqual(harness.entries, []);
  assert.deepEqual(harness.messages, []);
  // Registering the handlers reports nothing by itself: the notice is the event's, not the wiring's.
  assert.deepEqual(harness.notified, []);
});

// The handler the extension registers is the command: it parses, it asks the flow, and it reports.
test("the command handler delegates to the loop: no arguments report the usage and call no model", async () => {
  const denied: SkillRef = { ...SKILL, name: "system-config", description: "Guard system files" };
  const harness = makeHarness({
    skills: [SKILL, denied],
    config: { allow: [], deny: ["system-config"] },
  });
  registerSurfaces(harness.pi, harness.seams);

  await harness.command().handler("", harness.ctx);

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "info");
  assert.match(harness.notified[0].message, COMMAND_USAGE);
  assert.equal(harness.notified[0].message.includes("Eligible skills: pdf-tools."), true);
  assert.equal(harness.notified[0].message.includes("Extract tables from PDFs"), false);
  // The offer is the eligible set, which is a settings decision the flow made behind the wiring.
  assert.equal(harness.notified[0].message.includes("system-config"), false);

  assert.deepEqual(harness.modelCalls, []);
  assert.deepEqual(harness.log.proposals, []);
  assert.deepEqual(harness.log.writes, []);
  assert.deepEqual(harness.log.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// The entry channel lives on the extension API, so the wiring is the only place that can connect it:
// the entry the flow returns arrives at pi.appendEntry with the documented custom type.
test("the command handler records the attempt through the extension API", async () => {
  const harness = makeHarness({ config: { allow: [], deny: ["pdf-tools"] } });
  registerSurfaces(harness.pi, harness.seams);

  await harness.command().handler("pdf-tools", harness.ctx);

  assert.equal(harness.entries.length, 1);
  const [entry] = harness.entries;
  assert.equal(entry.customType, ENTRY_TYPE);
  assert.equal(entry.data?.surface, "command");
  assert.equal(entry.data?.skill, "pdf-tools");
  assert.equal(entry.data?.outcome, "not-eligible");
  assert.equal(entry.data?.reason, "not-eligible");
  assert.deepEqual(entry.data?.staged, null);

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "warning");
});

// Without UI pi hands the handler a no-op ui context, so the result has to leave through the
// session: the wiring turns pi.sendMessage into the channel the command reports through.
test("without UI the command reports through the extension API's message channel", async () => {
  const harness = makeHarness({ hasUI: false });
  registerSurfaces(harness.pi, harness.seams);

  await harness.command().handler("", harness.ctx);

  assert.deepEqual(harness.notified, []);
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].customType, ENTRY_TYPE);
  assert.equal(harness.messages[0].display, true);
  assert.match(harness.messages[0].content, COMMAND_USAGE);
});

// The context is passed to the loop untouched, not copied. pi builds the context a handler receives
// out of getters and documents that a spread freezes them and skips its active-instance check
// (dist/core/extensions/runner.js:724-728), so a wiring that copied it -- to add a message channel,
// for instance -- would read every property of the context eagerly, once, before the run asked for
// any of them. The ui below is a getter that records its reads: a run with no UI and a message
// channel never touches ctx.ui, and that is what a context that reached the loop as it was looks like.
test("the context reaches the loop untouched: a run without UI never reads its ui", async () => {
  const harness = makeHarness({ hasUI: false });
  registerSurfaces(harness.pi, harness.seams);

  await harness.command().handler("", harness.ctx);

  assert.equal(harness.messages.length, 1);
  assert.deepEqual(harness.uiReads, []);
});

// The other half of the same rule: with a UI the notification is the result, so the ui is read --
// once, when the run reports, and not once per copy of the context.
test("the context reaches the loop untouched: a run with UI reads its ui when it reports", async () => {
  const harness = makeHarness();
  registerSurfaces(harness.pi, harness.seams);

  await harness.command().handler("", harness.ctx);

  assert.equal(harness.notified.length, 1);
  assert.deepEqual(harness.uiReads, ["ui"]);
});

// M1: the wiring passes the gate's seam to both surfaces, so a candidate the command staged is gated under the base
// the loop derived and not under one of the factory's own. The gate is a double here: the verdicts belong to its own
// suite, and this test is about the chain the wiring connects.
test("the command handler gates the candidate it staged, under the base of the run", async () => {
  const harness = makeHarness();
  const requests: GateRequest[] = [];
  registerSurfaces(harness.pi, {
    ...harness.seams,
    gate: async (request) => {
      requests.push(request);
      return {
        kind: "gate-abstained",
        reason: "insufficient-items",
        stagingPath: request.stagingPath,
        decisionPath: DECISION_RELATIVE,
        plannedRuns: 0,
        usedRuns: 0,
        overlays: null,
      };
    },
  });

  await harness.command().handler("pdf-tools", harness.ctx);

  assert.equal(harness.log.writes.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].stagingPath, STAGING_RELATIVE);
  assert.equal(requests[0].base, BASE);
  assert.equal(requests[0].cwd, CWD);
  assert.equal(requests[0].skill.name, SKILL.name);

  // And the run ended reporting the abstention instead of a candidate the wiring accepted on its own.
  const report = harness.notified.at(-1);
  assert.equal(report?.type, "warning");
  assert.equal(report?.message.includes("abstained"), true);
});

// The wiring owns no path: the base of a run follows the agent directory, so it is asserted through the
// index line of a run that writes nothing else, and never through a constant of the factory.
test("the factory passes no base of its own: the run writes under the agent directory", async () => {
  const harness = makeHarness({ branch: emptyBranch() });
  registerSurfaces(harness.pi, harness.seams);

  // No evidence: the run records the attempt and stages nothing, which is the shortest path that
  // reaches the index with no candidate.
  await harness.command().handler("pdf-tools", harness.ctx);

  assert.deepEqual(harness.log.attemptRoots, [BASE]);
  assert.equal(harness.log.attempts.length, 1);
  assert.equal(harness.log.attempts[0].event, "no-evidence");
  assert.equal(harness.log.attempts[0].ts, NOW_ISO);
});

test("the tool's execute answers a diagnosis with the wired dependencies", async () => {
  const harness = makeHarness();
  registerSurfaces(harness.pi, harness.seams);

  const result = await harness.tool().execute(
    "call-diagnose",
    { action: "diagnose", skill: "pdf-tools" },
    undefined,
    undefined,
    harness.ctx,
  );

  assert.equal(result.isError, undefined);
  // Rule 6 of P9: the documented shape of details and nothing else.
  assert.deepEqual(result.details, {
    action: "diagnose",
    skill: "pdf-tools",
    outcome: "diagnosed",
  });
  assert.equal(textOf(result).includes("replay items: 1"), true);

  // A diagnosis writes nothing and records no entry, and it never reaches the model.
  assert.deepEqual(harness.log.writes, []);
  assert.deepEqual(harness.log.attempts, []);
  assert.deepEqual(harness.entries, []);
  assert.deepEqual(harness.modelCalls, []);
});

test("the tool's execute stages a candidate under the base of the run", async () => {
  const harness = makeHarness();
  registerSurfaces(harness.pi, harness.seams);

  const result = await harness.tool().execute(
    "call-propose",
    { action: "propose", skill: "pdf-tools", focus: "merged cells" },
    undefined,
    undefined,
    harness.ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(result.details.action, "propose");
  assert.equal(result.details.skill, "pdf-tools");
  assert.equal(result.details.outcome, "proposed");
  // The machine fields name the candidate relative to the base, and the base travels with them: joined,
  // they are the path a consumer opens.
  assert.equal(result.details.base, BASE);
  assert.equal(result.details.stagingPath, STAGING_RELATIVE);
  assert.equal(result.details.decisionPath, DECISION_RELATIVE);
  // Rule 5 of P9: the usage of the one generation travels in details.
  assert.deepEqual(result.details.usage, { input: 412, output: 137 });
  assert.equal(textOf(result).includes(STAGING_PATH), true);

  // Both writes of the run -- staging and the index -- land under the base the loop derived from the
  // agent directory, and nowhere else.
  assert.deepEqual(harness.log.writes.map((write) => write.base), [BASE]);
  assert.deepEqual(harness.log.attemptRoots, [BASE]);
  assert.equal(harness.log.writes[0].skill.name, "pdf-tools");
  assert.equal(harness.log.writes[0].slug, LESSON_SLUG);
  assert.equal(harness.log.attempts.length, 1);
  assert.equal(harness.log.attempts[0].event, "proposed");
  assert.equal(harness.log.attempts[0].targetSkill, "pdf-tools");

  // The entry the tool surface records goes through the same channel as the command's.
  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0].customType, ENTRY_TYPE);
  assert.equal(harness.entries[0].data?.surface, "tool");
  assert.equal(harness.entries[0].data?.outcome, "proposed");
  assert.equal(harness.entries[0].data?.focus, "merged cells");
  assert.equal(harness.notified.length, 0);

  // The inventory was resolved once, for the caller's directory, as the loop documents.
  assert.equal(harness.log.inventories.length, 1);
  assert.equal(harness.log.inventories[0].cwd, CWD);
  // The proposer was the injected seam, so the session model was never asked for anything.
  assert.deepEqual(harness.modelCalls, []);
});

// OA8: the child of a replay runs with this extension loaded -- it is not started with
// --no-extensions, because cutting extensions would change the environment the failure was measured
// in -- so the factory has to register nothing there. A replay that could start another propose or
// gate over itself would spend the gate's budget on a loop nobody asked for. The variable is read when
// the factory is called and not when the module is imported, so the guard costs the import nothing.
test("inside a replay the factory registers neither the command nor the tool", () => {
  const harness = makeHarness();
  const refusing = refusingSeams();
  const previous = process.env[REPLAY_ENV_VAR];

  assert.equal(REPLAY_ENV_VAR, "PI_SIMPLE_SRI_REPLAY");
  process.env[REPLAY_ENV_VAR] = "1";
  try {
    assert.equal(registerSurfaces(harness.pi, refusing.seams), undefined);
  } finally {
    restoreEnv(previous);
  }

  assert.deepEqual(harness.commandNames, []);
  assert.deepEqual(harness.toolNames, []);
  // The notice of the session is a surface of the loop too: a replay child that reported it would print a line of this
  // package in a transcript nobody is reading, so the guard covers the event along with the two registrations.
  assert.deepEqual(harness.onEvents, []);
  assert.deepEqual(harness.entries, []);
  assert.deepEqual(harness.messages, []);
  // No seam of the loop was touched either: the guard is the registration's first statement.
  assert.deepEqual(refusing.touched, []);
});

// The value that disables the two surfaces is exactly "1": anything else leaves them registered,
// because an environment a caller did not mean to set must not remove them.
test("the replay guard answers only to the value \"1\"", () => {
  const harness = makeHarness();
  const previous = process.env[REPLAY_ENV_VAR];

  process.env[REPLAY_ENV_VAR] = "0";
  try {
    registerSurfaces(harness.pi, harness.seams);
  } finally {
    restoreEnv(previous);
  }

  assert.deepEqual(harness.commandNames, [COMMAND_NAME]);
  assert.deepEqual(harness.toolNames, [SKILL_IMPROVE_TOOL_NAME]);
  assert.deepEqual(harness.onEvents, ["session_start", "turn_end"]);
});
