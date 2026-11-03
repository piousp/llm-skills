import { test } from "node:test";
import assert from "node:assert/strict";
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
  type SriSeams,
} from "../../extensions/index.ts";
import {
  ENTRY_TYPE,
  type ImprovementEntry,
  type SkillImproveContext,
  type NotifyType,
} from "../../src/command-skill-improve.ts";
import { serializeLesson } from "../../src/lesson-frontmatter.ts";
import { COMMAND_NAME } from "../../src/names.ts";
import { packageRoot } from "../../src/package-paths.ts";
import type { ProposeFn } from "../../src/improve-flow.ts";
import {
  SKILL_IMPROVE_TOOL_NAME,
  skillImproveParams,
  type ToolDetails,
} from "../../src/tool-skill-improve.ts";
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
const STAGING_PATH = "/pkg/staging/20261102T140322481Z/pdf-tools";
const DECISION_PATH = `${STAGING_PATH}/decision.json`;
const CONTENT_HASH = `sha256:${"a".repeat(64)}`;
const BODY_HASH = `sha256:${"b".repeat(64)}`;

// The root the factory must derive from its own module URL: <package>/extensions/index.ts walked two
// levels up. It is computed here from this file's URL, which sits in the same package, so the
// assertion is about the derivation and not about where the repository happens to live.
const PACKAGE_ROOT = packageRoot(new URL("../../extensions/index.ts", import.meta.url).href);

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
    status: "proposed",
    sourceEvidence: input.evidence.map((item) => item.id),
    gate: "pending",
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
  };

  const seams: SriSeams = {
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
    sessionManager: { getBranch: () => [...(options.branch ?? failingBranch())] },
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
  assert.equal(command.description?.includes("/skill-improve <skill> [focus]"), true);
  assert.equal(command.description?.includes("never accepts a candidate"), true);

  // The registered tool is the one src/tool-skill-improve.ts builds: the same schema object, so the
  // tool the model calls and the tool the P9 tests exercised cannot drift apart.
  const tool = harness.tool();
  assert.equal(tool.name, SKILL_IMPROVE_TOOL_NAME);
  assert.equal(tool.parameters, skillImproveParams);
  assert.equal(typeof tool.execute, "function");
  // Q7: the description travels in every session that loads the tool and says what it never does.
  assert.equal(tool.description.includes("never edits the skill"), true);
  assert.equal(tool.description.includes("never accepts a candidate"), true);
});

// The module is imported at the top of this file, before any test ran; a fake API that is never
// handed to the factory holds no registration, and importing again reuses the same module instance.
// So the module body registers nothing: only the factory call does.
test("importing the module registers nothing: only the factory call does", async () => {
  const harness = makeHarness();

  assert.deepEqual(harness.commandNames, []);
  assert.deepEqual(harness.toolNames, []);
  assert.deepEqual(harness.entries, []);

  // The default export is the entry point pi calls with its own ExtensionAPI; registerSurfaces is the
  // same registration over the slice a test can fake.
  const imported = await import("../../extensions/index.ts");
  assert.equal(imported.default, sriExtension);
  assert.equal(imported.registerSurfaces, registerSurfaces);
  assert.deepEqual(harness.commandNames, []);
  assert.deepEqual(harness.toolNames, []);
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
  assert.deepEqual(harness.entries, []);
  assert.deepEqual(harness.messages, []);
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
  assert.equal(harness.notified[0].message.includes("pdf-tools: Extract tables from PDFs"), true);
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

// The root is the one part of the run the wiring owns and no seam can replace, so it is asserted
// through the index line of a run that writes nothing else: the shortest path that reaches it.
test("the factory derives the package root from its own module URL", async () => {
  const harness = makeHarness({ branch: emptyBranch() });
  registerSurfaces(harness.pi, harness.seams);

  // No evidence: the run records the attempt and stages nothing, which is the shortest path that
  // reaches the index with no candidate.
  await harness.command().handler("pdf-tools", harness.ctx);

  assert.deepEqual(harness.log.attemptRoots, [PACKAGE_ROOT]);
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

test("the tool's execute stages a candidate under the package root", async () => {
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
  assert.equal(result.details.stagingPath, STAGING_PATH);
  assert.equal(result.details.decisionPath, DECISION_PATH);
  // Rule 5 of P9: the usage of the one generation travels in details.
  assert.deepEqual(result.details.usage, { input: 412, output: 137 });
  assert.equal(textOf(result).includes(STAGING_PATH), true);

  // Both writes of the run -- staging and the index -- land under the root the factory derived from
  // extensions/index.ts and nowhere else.
  assert.deepEqual(harness.log.writes.map((write) => write.root), [PACKAGE_ROOT]);
  assert.deepEqual(harness.log.attemptRoots, [PACKAGE_ROOT]);
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
