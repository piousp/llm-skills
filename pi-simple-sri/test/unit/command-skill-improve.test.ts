import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ToolCall,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import {
  ENTRY_TYPE,
  parseSkillImproveArgs,
  runSkillImprove,
  type ImprovementEntry,
  type NotifyType,
  type ProposeFn,
  type SkillImproveContext,
  type SkillImproveDeps,
  type SkillImproveModelRegistry,
} from "../../src/command-skill-improve.ts";
import { SriFailClosedError } from "../../src/errors.ts";
import { CASE_BANK_FORMAT } from "../../src/case-bank.ts";
import { acceptCandidate, type AcceptDeps, type AcceptRequest } from "../../src/gate/acceptance.ts";
import type {
  DirectionalGateDeps,
  DirectionalGateRequest,
  DirectionalGateResult,
} from "../../src/gate/directional-flow.ts";
import type { GateFlowResult, GateRequest } from "../../src/gate/flow.ts";
import type { ReadAttemptLine } from "../../src/ledger.ts";
import { serializeLesson } from "../../src/lesson-frontmatter.ts";
import { acceptedText, reloadFailedText, standingText, unknownSignalText } from "../../src/messages.ts";
import { ATTEMPTS_FILE, COMMAND_NAME, DECISION_FILE, HISTORY_DIR, LESSONS_DIR, PUBLISHED_SKILL_NAME, RETIREMENT_FILE, SKILL_FILE, SKILL_IMPROVE_TOOL_NAME } from "../../src/names.ts";
import { PROPOSAL_MAX_TOKENS, ProposerError } from "../../src/proposer.ts";
import {
  retireLesson,
  type RetireDeps,
  type RetireRequest,
} from "../../src/retirement.ts";
import { countReferenceLines, lessonReferencePath, upsertReferenceLine } from "../../src/skill-reference.ts";
import type { SignalCollector, Suspicion } from "../../src/signals.ts";
import { LESSON_GATE_ACCEPTED } from "../../src/types.ts";
import type { AttemptLine, DecisionOutcomeStatus, DecisionRecord, GateBlock, LessonDraft, SkillRef, SriConfig } from "../../src/types.ts";
import { sha256Digest } from "../../src/hash.ts";
import { stateDir } from "../../src/write-base.ts";
import { SriWriterError, lessonHashes, type StagingWriteInput, type StagingWriteResult } from "../../src/writer.ts";

// The command is exercised end to end with doubles: one fake context, one fake model registry and
// one fake per seam. Nothing here reads the settings file, walks a skill directory, reaches a
// provider or writes a byte: the writer, the index and the session entry are recorders, so every
// assertion below is about what the command decided, not about the disk.

const NOW = new Date("2026-11-02T14:03:22.481Z");
const NOW_ISO = "2026-11-02T14:03:22.481Z";
const CWD = "/work/reports";
// The agent directory the harness hands over: the gate request carries it, and it is where a run would read its
// settings from if the seams did not answer for it.
const AGENT_DIR = "/agent";
// The base of the run: the package root before the write-base slice, and now the base a test injects.
// The bytes land under <base>/staging; the records and the answers name them relative to the base.
const BASE = "/pkg";
const STAGING_PATH = "/pkg/staging/20261102T140322481Z/pdf-tools";
const STAGING_RELATIVE = "staging/20261102T140322481Z/pdf-tools";
const DECISION_RELATIVE = `${STAGING_RELATIVE}/decision.json`;
const CONTENT_HASH = `sha256:${"a".repeat(64)}`;
const BODY_HASH = `sha256:${"b".repeat(64)}`;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

const SKILL_TEXT = "# pdf-tools\n\nUse pdftotext for plain text.\n";

const LESSON_TITLE = "Use the lattice strategy for merged cells";
const LESSON_SLUG = "use-the-lattice-strategy-for-merged-cells";
const LESSON_BODY = "- Use pdfplumber with `lattice` for tables with merged cells.";
const REPLY = JSON.stringify({ title: LESSON_TITLE, body: LESSON_BODY });

const USAGE: Usage = {
  input: 412,
  output: 137,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 549,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// A chat model the command only forwards to the registry, so the fields are the ones a registry
// read would answer with.
const MODEL: Model<Api> = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  input: ["text"],
  cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  contextWindow: 200_000,
  maxTokens: 8_192,
};

const BASE_MS = Date.parse("2026-11-02T14:00:00.000Z");

// The identifier of the session the harness fakes: the model request has to carry it.
const SESSION_ID = "session-01a1a2ec-7c43-7417-903d-02543f0b9fab";

const SKILL: SkillRef = {
  name: "pdf-tools",
  description: "Extract tables from PDFs",
  dir: "/skills/pdf-tools",
  realDir: "/skills/pdf-tools",
  hasLessons: false,
  kind: "declared",
};

function makeSkill(overrides: Partial<SkillRef> = {}): SkillRef {
  return { ...SKILL, ...overrides };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: MODEL.id,
    usage: USAGE,
    stopReason: "stop",
    timestamp: NOW.getTime(),
  };
}

// Session entries are literals, as in test/unit/evidence.test.ts: the command only reads the
// message, its timestamp and its tool calls.
function messageEntry(seconds: number, message: SessionMessageEntry["message"]): SessionMessageEntry {
  const instant = new Date(BASE_MS + seconds * 1000);
  return {
    type: "message",
    id: `entry-${seconds}`,
    parentId: null,
    timestamp: instant.toISOString(),
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
    model: MODEL.id,
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

// One prompt, one bash call and its error, plus an entry of another kind: the branch of a real
// session carries several, and none of them is a message.
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

// The same failure with no user message before it: evidence exists, but no turn can be replayed.
function unpromptedBranch(): SessionEntry[] {
  return [toolCallEntry(1), toolErrorEntry(2)];
}

interface NotifyCall {
  message: string;
  type: NotifyType;
}

// A session message: the channel the wiring connects when the command has no UI.
interface SentMessage {
  customType: string;
  content: string;
  display: boolean;
}

interface EntryCall {
  customType: string;
  data: ImprovementEntry;
}

interface CompletedCall {
  model: Model<Api>;
  context: Context;
  maxTokens: number | undefined;
  sessionId: string | undefined;
}

interface HarnessOptions {
  branch?: readonly SessionEntry[];
  config?: SriConfig;
  skills?: readonly SkillRef[];
  hasUI?: boolean;
  withSendMessage?: boolean;
  withEntryChannel?: boolean;
  entryFailure?: Error;
  model?: Model<Api>;
  propose?: ProposeFn;
  useRealProposer?: boolean;
  writeFailure?: Error;
  reply?: string;
  // The base of the run, when a test needs the candidate and the skill to exist on disk. The default is a path
  // that names nothing, which is what a run driving the seams of staging needs.
  base?: string;
  // The directory the session runs in, for the test of the bank path: the default names nothing, and the process does not run
  // there either, which is what proves a relative bank is resolved against the session.
  cwd?: string;
  // The gate and the acceptance the chain runs. The gate defaults to an abstention that writes nothing; the
  // acceptance defaults to the real one, so a test that wants it records what it wrote instead of a double.
  gate?: (request: GateRequest) => Promise<GateFlowResult>;
  // The second flow of M1c, with the same default shape: an answer that spends nothing, so no test of this suite starts a
  // replay or reaches a provider.
  gateDirectional?: (request: DirectionalGateRequest, gateDeps: DirectionalGateDeps) => Promise<DirectionalGateResult>;
  accept?: typeof acceptCandidate;
  acceptDeps?: AcceptDeps;
  // The retirement of M3 (S4): recorded before it is delegated, and defaulting to the real one -- the way the acceptance
  // does -- so a test that reaches it gets the bytes of the skill as its proof.
  retire?: typeof retireLesson;
  retireDeps?: RetireDeps;
  // The collector of the silent signals (M3, S6), which the wiring connects and the confirmation reads. Absent is a session
  // without one, and that is what the run of `--signal` answers `unknown-signal` for.
  signals?: SignalCollector;
  // The reload of M2 that fails, with the runner already gone: the run has to report it and still resolve.
  reloadFailure?: Error;
}

interface Harness {
  ctx: SkillImproveContext;
  deps: SkillImproveDeps;
  notified: NotifyCall[];
  sent: SentMessage[];
  entries: EntryCall[];
  attempts: AttemptLine[];
  attemptBases: string[];
  writes: StagingWriteInput[];
  proposals: { input: Parameters<ProposeFn>[0] }[];
  completed: CompletedCall[];
  gateRequests: GateRequest[];
  directionalRequests: DirectionalGateRequest[];
  // The paths the run asked the settings reader for, in order (B4). The run reads the file once per run, so this array is
  // what "one reading" means here: a second entry is a second answer to "what do the settings say".
  configReads: string[];
  acceptRequests: AcceptRequest[];
  retireRequests: RetireRequest[];
  // The calls of one run in the order they happened (M2, S3): "notify" for every report of the context, "waitForIdle" and
  // "reload" for the two members of it. The protocol of the acceptance is an order, so the array is what proves it.
  calls: string[];
  idleCalls: number;
  reloadCalls: number;
  run: (args: string) => Promise<void>;
}

// The lesson a successful generation produces. It is built from the evidence the command handed
// over, so the draft's source-evidence follows the input instead of a hardcoded list.
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

function successfulProposer(): ProposeFn {
  return async (input) => {
    const draft = lessonDraftFor(input);
    const lesson = serializeLesson(draft);
    if (!lesson.ok) assert.fail(`the lesson of this test must serialize: ${lesson.error}`);
    return { ok: true, value: { draft, lessonText: lesson.value, usage: { input: 412, output: 137 } } };
  };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const base = options.base ?? BASE;
  const notified: NotifyCall[] = [];
  const sent: SentMessage[] = [];
  const entries: EntryCall[] = [];
  const attempts: AttemptLine[] = [];
  const attemptBases: string[] = [];
  const writes: StagingWriteInput[] = [];
  const proposals: Harness["proposals"] = [];
  const completed: CompletedCall[] = [];
  const gateRequests: GateRequest[] = [];
  const directionalRequests: DirectionalGateRequest[] = [];
  const configReads: string[] = [];
  const acceptRequests: AcceptRequest[] = [];
  const retireRequests: RetireRequest[] = [];
  const calls: string[] = [];
  let idleCalls = 0;
  let reloadCalls = 0;

  const modelRegistry: SkillImproveModelRegistry = {
    complete: async (model, context, request) => {
      completed.push({ model, context, maxTokens: request?.maxTokens, sessionId: request?.sessionId });
      return assistantMessage(options.reply ?? REPLY);
    },
  };

  const ctx: SkillImproveContext = {
    cwd: options.cwd ?? CWD,
    hasUI: options.hasUI ?? true,
    model: options.model,
    sessionManager: { getBranch: () => [...(options.branch ?? failingBranch())], getSessionId: () => SESSION_ID },
    modelRegistry,
    ui: {
      notify: (message, type) => {
        calls.push("notify");
        notified.push({ message, type: type ?? "info" });
      },
    },
    // The two members of the command context that M2 needs. Both resolve instead of acting, and each one is counted and
    // recorded in `calls` so a test can assert the order of the three calls without replacing the context. A reload of
    // `reloadFailure` is recorded before it rejects: the call happened, whatever it answered.
    waitForIdle: async () => {
      idleCalls += 1;
      calls.push("waitForIdle");
    },
    reload: async () => {
      reloadCalls += 1;
      calls.push("reload");
      if (options.reloadFailure !== undefined) throw options.reloadFailure;
    },
  };

  const write = async (input: StagingWriteInput): Promise<StagingWriteResult> => {
    if (options.writeFailure !== undefined) throw options.writeFailure;
    writes.push(input);
    return {
      stagingPath: path.join(base, STAGING_RELATIVE),
      lessonPath: path.join(base, STAGING_RELATIVE, LESSONS_DIR, `${LESSON_SLUG}.md`),
      decisionPath: path.join(base, STAGING_RELATIVE, DECISION_FILE),
      contentHash: CONTENT_HASH,
      bodyHash: BODY_HASH,
    };
  };

  // The two steps M1 chains after the loop, recorded before they are delegated. The gate defaults to an
  // abstention -- the verdict of a gate that spends nothing -- so no run of this suite ever starts a replay; the
  // acceptance defaults to the real one, so a test that reaches it gets the bytes on disk as its proof.
  const gate = async (request: GateRequest): Promise<GateFlowResult> => {
    gateRequests.push(request);
    if (options.gate !== undefined) return await options.gate(request);
    return {
      kind: "gate-abstained",
      reason: "insufficient-items",
      stagingPath: STAGING_RELATIVE,
      decisionPath: DECISION_RELATIVE,
      plannedRuns: 0,
      usedRuns: 0,
      overlays: null,
    };
  };

  // The gate of the bank base: recorded before it is delegated, and an answer that spends nothing when a test does not name
  // one -- the same shape as the abstention above, and the one the base answers with when its bank is not there.
  const gateDirectional = async (
    request: DirectionalGateRequest,
    gateDeps: DirectionalGateDeps,
  ): Promise<DirectionalGateResult> => {
    directionalRequests.push(request);
    if (options.gateDirectional !== undefined) return await options.gateDirectional(request, gateDeps);
    return {
      kind: "no-baseline",
      reason: `bank-absent: ${request.bankPath}`,
      stagingPath: request.stagingPath,
      decisionPath: path.join(request.stagingPath, DECISION_FILE),
      plannedRuns: 0,
      usedRuns: 0,
      overlays: null,
    };
  };

  const accept: typeof acceptCandidate = async (request, acceptDeps) => {
    acceptRequests.push(request);
    return await (options.accept ?? acceptCandidate)(request, acceptDeps);
  };

  // The retirement of M3 (S4), recorded the same way: a test replaces the whole protocol when it wants the answer without
  // the bytes, and the default is the real one so the report and the disk are proved together.
  const retire: typeof retireLesson = async (request, retireDeps) => {
    retireRequests.push(request);
    return await (options.retire ?? retireLesson)(request, retireDeps);
  };
  // The proposal of a run, recorded whatever answers it: `proposals` is what "the run proposed" means in this suite, so a test
  // that replaces the proposer still counts the call instead of emptying the array by construction. The default builds the
  // lesson the flow expects out of the input the run handed over.
  const propose: ProposeFn = async (input) => {
    proposals.push({ input });
    return await (options.propose ?? successfulProposer())(input);
  };

  const deps: SkillImproveDeps = {
    now: () => NOW,
    agentDir: AGENT_DIR,
    readConfig: (settingsPath) => {
      configReads.push(settingsPath);
      return options.config ?? { allow: [], deny: [] };
    },
    listSkills: async () => [...(options.skills ?? [SKILL])],
    readSkillText: async () => SKILL_TEXT,
    write,
    appendAttempt: async (base, line) => {
      attemptBases.push(base);
      attempts.push(line);
    },
    base,
    gate,
    gateDirectional,
    accept,
    ...(options.acceptDeps === undefined ? {} : { acceptDeps: options.acceptDeps }),
    retire,
    ...(options.retireDeps === undefined ? {} : { retireDeps: options.retireDeps }),
    // The collector of the silent signals (M3, S6): absent unless a test hands one over, which is the session of a host that
    // registered no collector -- the shape the confirmation answers `unknown-signal` for.
    ...(options.signals === undefined ? {} : { signals: options.signals }),
    // The message channel is a seam of the dependencies and not a member of the context: pi's command
    // context carries no sendMessage, so the wiring connects it here and a run without it degrades to
    // stderr.
    ...(options.withSendMessage === true
      ? {
          sendMessage: (message: SentMessage) => {
            sent.push(message);
          },
        }
      : {}),
    ...(options.withEntryChannel === false
      ? {}
      : {
          appendEntry: (customType: string, data: ImprovementEntry) => {
            if (options.entryFailure !== undefined) throw options.entryFailure;
            entries.push({ customType, data });
          },
        }),
    ...(options.useRealProposer === true ? {} : { propose }),
  };

  return {
    ctx,
    deps,
    notified,
    sent,
    entries,
    attempts,
    attemptBases,
    writes,
    proposals,
    completed,
    gateRequests,
    directionalRequests,
    configReads,
    acceptRequests,
    retireRequests,
    calls,
    // Read when the caller reads them: the run increments them after this object was built.
    get idleCalls() {
      return idleCalls;
    },
    get reloadCalls() {
      return reloadCalls;
    },
    run: (args: string) => runSkillImprove(args, ctx, deps),
  };
}

test("parseSkillImproveArgs: a single token is the skill and nothing else", () => {
  assert.deepEqual(parseSkillImproveArgs("pdf-tools"), { skill: "pdf-tools" });
});

test("parseSkillImproveArgs: everything after the skill is the focus", () => {
  assert.deepEqual(parseSkillImproveArgs("pdf-tools merged cells in tables"), {
    skill: "pdf-tools",
    focus: "merged cells in tables",
  });
});

test("parseSkillImproveArgs: surrounding and repeated whitespace is dropped", () => {
  assert.deepEqual(parseSkillImproveArgs("  pdf-tools    merged   cells  \n"), {
    skill: "pdf-tools",
    focus: "merged cells",
  });
});

test("parseSkillImproveArgs: an empty or blank argument string names no skill", () => {
  assert.deepEqual(parseSkillImproveArgs(""), {});
  assert.deepEqual(parseSkillImproveArgs("   \n\t "), {});
});

// M1c: --flag=<value> is one token, so a bank path with spaces in it is one argument and a focus of several words is never
// confused with a flag. The flag may come before or after the focus, and the focus keeps its own spaces.
test("parseSkillImproveArgs: --bank=<path> is one token and the focus keeps its spaces", () => {
  assert.deepEqual(parseSkillImproveArgs("pdf-tools merged cells --bank=/abs/x.json"), {
    skill: "pdf-tools",
    focus: "merged cells",
    bankPath: "/abs/x.json",
  });
  assert.deepEqual(parseSkillImproveArgs("--bank=/abs/x.json pdf-tools"), {
    skill: "pdf-tools",
    bankPath: "/abs/x.json",
  });
});

// The two flags of the bank base and the flag of the staged run, as themselves: the boolean one carries no value and the two
// that name a path carry it after the equals sign.
test("parseSkillImproveArgs: --defect and --staged are parsed as themselves", () => {
  assert.deepEqual(
    parseSkillImproveArgs("pdf-tools --bank=/abs/x.json --defect --staged=staging/20261102T140322481Z/pdf-tools"),
    {
      skill: "pdf-tools",
      bankPath: "/abs/x.json",
      defect: true,
      staged: "staging/20261102T140322481Z/pdf-tools",
    },
  );
});

// The terminator: everything after -- is the focus as written, which is the escape for a focus that starts with a flag of its
// own. It is the reason the parse can be strict about every other token that opens with --.
test("parseSkillImproveArgs: -- ends the flags, so a focus may start with --", () => {
  assert.deepEqual(parseSkillImproveArgs("pdf-tools -- --bank is not a flag here"), {
    skill: "pdf-tools",
    focus: "--bank is not a flag here",
  });
  assert.deepEqual(parseSkillImproveArgs("pdf-tools merged --"), { skill: "pdf-tools", focus: "merged" });
});

// A flag whose value is missing or empty is a usage error and not a focus: the value never arrives as the next word, so a
// token with no value after the equals sign names nothing.
test("parseSkillImproveArgs: a flag with no value in its token is a usage error", () => {
  assert.throws(() => parseSkillImproveArgs("pdf-tools --bank"), SriFailClosedError);
  assert.throws(() => parseSkillImproveArgs("pdf-tools --bank="), SriFailClosedError);
  assert.throws(() => parseSkillImproveArgs("pdf-tools --staged"), SriFailClosedError);
});

// A flag the command does not have, and a boolean flag given a value, are one answer: the sentence names the token and the
// three flags the command understands.
test("parseSkillImproveArgs: a flag the command does not have is a usage error", () => {
  assert.throws(() => parseSkillImproveArgs("pdf-tools --force"), SriFailClosedError);
  assert.throws(() => parseSkillImproveArgs("pdf-tools --defect=true"), SriFailClosedError);
});

// A defect is what a bank of the other profile describes, so the flag without the bank names no material at all: refused before
// anything is read, spent or recorded.
test("parseSkillImproveArgs: --defect without --bank is a usage error", () => {
  assert.throws(() => parseSkillImproveArgs("pdf-tools --defect"), SriFailClosedError);
  assert.throws(() => parseSkillImproveArgs("pdf-tools merged cells --defect"), SriFailClosedError);
});

test("runSkillImprove: without arguments it reports the usage and the eligible skills", async () => {
  const denied = makeSkill({ name: "system-config", description: "Guard system files" });
  const harness = createHarness({
    skills: [SKILL, denied],
    config: { allow: [], deny: ["system-config"] },
  });

  await harness.run("");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "info");
  assert.match(harness.notified[0].message, /Usage: \/skill-improve <skill> \[focus\]/);
  // The offer is one line of names and no descriptions: what the reader needs from the help is the name to
  // type, and the description stays in the inventory it belongs to.
  assert.equal(harness.notified[0].message.includes("Eligible skills: pdf-tools."), true);
  assert.equal(harness.notified[0].message.includes("Extract tables from PDFs"), false);
  // The list is the eligible one: the deny list removes a skill from the offer, not just from
  // generation.
  assert.equal(harness.notified[0].message.includes("system-config"), false);

  // M1c (S11, Q26): the help names the four ways feedback reaches this command -- the failures of the session, the two
  // profiles of a bank and the tool the model registers a correction with -- because a user who typed the command alone
  // is the reader the line exists for. Each one is the invocation that reaches it, and the gate's cost is in the help too.
  const help = harness.notified[0].message;
  assert.equal(help.includes("a tool failure of this session"), true);
  assert.equal(help.includes("a directional improvement"), true);
  // The third is asserted by the continuation the description line does not carry: the same words appear in the sentence
  // above it, and what proves the fourth way is listed is the clause of the line itself.
  assert.equal(help.includes("a defect an artifact shows, measured against the truth that bank declares"), true);
  assert.equal(help.includes("a correction or a rejection"), true);
  assert.equal(help.includes("--bank=<path> --defect"), true);
  assert.equal(help.includes(SKILL_IMPROVE_TOOL_NAME), true);
  assert.equal(help.includes("spends tokens"), true);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.completed, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// M2c, S2b: a skill whose name this package reserves is in the inventory as a declared skill -- that is how pi discovers a
// skill a package ships -- so the offer of the help is where the exclusion has to be visible: a name listed here is a
// name the user is invited to type, and typing this one reaches a refusal.
const PUBLISHED_MANUAL: SkillRef = {
  name: PUBLISHED_SKILL_NAME,
  description: "The loop this package teaches",
  dir: `/skills/${PUBLISHED_SKILL_NAME}`,
  realDir: `/skills/${PUBLISHED_SKILL_NAME}`,
  hasLessons: false,
  kind: "declared",
};

test("runSkillImprove: the help does not offer the manual this package publishes", async () => {
  const harness = createHarness({ skills: [SKILL, PUBLISHED_MANUAL] });

  await harness.run("");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "info");
  assert.equal(harness.notified[0].message.includes("Eligible skills: pdf-tools."), true);
  assert.equal(harness.notified[0].message.includes(PUBLISHED_SKILL_NAME), false);
});

// The refusal the user reads when the name is typed anyway: the sentence says which name the package reserves and why a
// lesson written in a skill of that name would be lost, which is the whole point of the reason being its own and not a wider
// `not-eligible`.
test("runSkillImprove: the manual this package publishes is refused with its own sentence", async () => {
  const harness = createHarness({ skills: [SKILL, PUBLISHED_MANUAL] });

  await harness.run(PUBLISHED_SKILL_NAME);

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "warning");
  assert.equal(
    harness.notified[0].message,
    `skill "${PUBLISHED_SKILL_NAME}" is not eligible (published-by-this-package): "${PUBLISHED_SKILL_NAME}" is the name this package reserves for the manual it publishes, and a lesson written in a skill of that name does not survive an update of the package, so no candidate was generated.`,
  );

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.completed, []);
  assert.deepEqual(harness.writes, []);
  // The refusal still leaves its line, and its reason travels in the session entry.
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.attempts[0].event, "not-eligible");
  assert.equal(harness.attempts[0].targetSkill, PUBLISHED_SKILL_NAME);
  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0].data.outcome, "not-eligible");
  assert.equal(harness.entries[0].data.reason, "published-by-this-package");
});

test("runSkillImprove: an unknown skill is reported and nothing is generated", async () => {
  const harness = createHarness();

  await harness.run("no-such-skill");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "warning");
  assert.match(harness.notified[0].message, /No skill named "no-such-skill"/);
  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.completed, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.entries, []);
});

// M4, D6: eligibility is checked before the model is called, and the refusal is recorded with its
// reason so a skill the settings exclude does not look like a run that simply found nothing.
test("runSkillImprove: an ineligible skill is refused before the model is called", async () => {
  const harness = createHarness({ config: { allow: [], deny: ["pdf-tools"] } });

  await harness.run("pdf-tools");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "warning");
  assert.equal(harness.notified[0].message.includes("not-eligible"), true);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.completed, []);
  assert.deepEqual(harness.writes, []);
  // No candidate was produced, and the refusal still leaves its line: the index is the audit trail of
  // every attempt, including the ones that cost no generation.
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.attempts[0].event, "not-eligible");
  assert.equal(harness.attempts[0].targetSkill, "pdf-tools");
  assert.match(harness.attempts[0].candidateHash, HASH_PATTERN);
  assert.equal(harness.attempts[0].bodyHash, harness.attempts[0].candidateHash);
  assert.equal(Object.hasOwn(harness.attempts[0], "stagingPath"), false);

  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0].customType, ENTRY_TYPE);
  assert.equal(harness.entries[0].data.surface, "command");
  assert.equal(harness.entries[0].data.skill, "pdf-tools");
  assert.equal(harness.entries[0].data.outcome, "not-eligible");
  assert.equal(harness.entries[0].data.reason, "not-eligible");
  assert.equal(harness.entries[0].data.focus, null);
  assert.deepEqual(harness.entries[0].data.staged, null);
  assert.match(harness.entries[0].data.candidateHash, HASH_PATTERN);
});

// D5: a run that finds nothing still leaves a trace, so "why did nothing happen" is answerable.
test("runSkillImprove: a session without failures records no-evidence and stages nothing", async () => {
  const harness = createHarness({ branch: [] });

  await harness.run("pdf-tools merged cells");

  assert.equal(harness.attempts.length, 1);
  const [line] = harness.attempts;
  assert.equal(line.event, "no-evidence");
  assert.equal(line.targetSkill, "pdf-tools");
  assert.equal(line.ts, NOW_ISO);
  assert.match(line.candidateHash, HASH_PATTERN);
  // Documented: with no candidate and no body, both hashes name the attempt itself.
  assert.equal(line.bodyHash, line.candidateHash);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.completed, []);
  assert.deepEqual(harness.writes, []);

  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0].data.outcome, "no-evidence");
  assert.equal(harness.entries[0].data.focus, "merged cells");
  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].message.includes("no-evidence"), true);
});

test("runSkillImprove: without a model it stops before the proposer is reached", async () => {
  const harness = createHarness({ useRealProposer: true });

  await harness.run("pdf-tools");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "error");
  assert.match(harness.notified[0].message, /no model is available/);

  assert.deepEqual(harness.completed, []);
  assert.deepEqual(harness.writes, []);
  // The run had no model to call, and the index still carries the attempt under its own event.
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.attempts[0].event, "no-model");
  assert.equal(harness.attempts[0].targetSkill, "pdf-tools");
  // No entry: a run with no model produced no outcome to record, and the entry vocabulary has none.
  assert.deepEqual(harness.entries, []);
});

test("runSkillImprove: a refused proposal is reported and nothing is staged", async () => {
  const reason = 'the model stopped with "length" instead of finishing the lesson';
  const harness = createHarness({
    propose: async () => ({ ok: false, error: new ProposerError(reason) }),
  });

  await harness.run("pdf-tools");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "error");
  assert.equal(harness.notified[0].message.includes(reason), true);

  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);

  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0].data.outcome, "error");
  assert.equal(harness.entries[0].data.reason, reason);
  assert.equal(harness.entries[0].data.evidenceCount, 1);
});

// The failure the diagnosis cannot replay is a refusal with its own message, and it is reported
// instead of thrown: nothing was written and the user is the one who has to act on it.
test("runSkillImprove: a diagnosis that cannot be replayed is reported and nothing is staged", async () => {
  const harness = createHarness({ branch: unpromptedBranch() });

  await harness.run("pdf-tools");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "error");
  assert.equal(harness.notified[0].message.includes("prompt"), true);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.writes, []);
});

test("runSkillImprove: the happy path stages the lesson, the record and the attempt", async () => {
  const harness = createHarness();

  await harness.run("pdf-tools   merged cells");

  // What the proposer received: the skill text read by the command, the evidence of the session and
  // the focus the user asked for.
  assert.equal(harness.proposals.length, 1);
  const { input } = harness.proposals[0];
  assert.equal(input.skill.name, "pdf-tools");
  assert.equal(input.skill.description, "Extract tables from PDFs");
  assert.equal(input.skill.skillText, SKILL_TEXT);
  assert.equal(input.focus, "merged cells");
  assert.equal(input.now, NOW);
  assert.equal(input.evidence.length, 1);
  assert.equal(input.diagnosis.replayItems.length, 1);
  assert.equal(input.diagnosis.replayItems[0].prompt, "extract the merged-cell table from report.pdf");

  // The staging write: the base of the run, the skill, and a lesson file the writer can parse.
  assert.equal(harness.writes.length, 1);
  const [write] = harness.writes;
  assert.equal(write.base, BASE);
  assert.deepEqual(write.skill, SKILL);
  assert.equal(write.slug, LESSON_SLUG);
  assert.equal(write.now, NOW);
  assert.equal(write.lessonText.includes(`title: "${LESSON_TITLE}"`), true);

  // decision.json as the command builds it, before the writer stamps the hashes.
  const decision = write.decision;
  assert.equal(decision.schema, "pi-simple-sri/decision@1");
  assert.equal(decision.createdAt, NOW_ISO);
  assert.deepEqual(decision.trigger, { surface: "command", focus: "merged cells" });
  assert.deepEqual(decision.skill, {
    name: "pdf-tools",
    dir: "/skills/pdf-tools",
    realDir: "/skills/pdf-tools",
    wasSymlink: false,
    eligible: true,
  });
  assert.deepEqual(decision.eligibility, { allow: [], deny: [] });
  assert.equal(decision.evidence.length, 1);
  assert.equal(decision.diagnosis.summary, input.diagnosis.summary);
  assert.deepEqual(decision.candidate, {
    kind: "new-lesson",
    slug: LESSON_SLUG,
    title: LESSON_TITLE,
    targetLesson: null,
    lessonPath: `lessons/${LESSON_SLUG}.md`,
    contentHash: sha256Digest(write.lessonText),
    bodyHash: sha256Digest(LESSON_BODY),
  });
  assert.deepEqual(decision.gate, {
    basis: "replay",
    status: "not-run",
    budget: { plannedRuns: 0, usedRuns: 0, interruptedAt: null },
    tokens: {
      proposal: { input: 412, output: 137 },
      incumbent: { input: 0, output: 0 },
      candidate: { input: 0, output: 0 },
      total: { input: 412, output: 137 },
    },
    preregistration: null,
    replay: null,
  });
  assert.deepEqual(decision.outcome, { status: "proposed", reason: null, decidedAt: null });

  // The index line carries the hashes the writer answered with, and names the candidate relative to
  // the base of the run.
  assert.deepEqual(harness.attemptBases, [BASE]);
  assert.deepEqual(harness.attempts, [
    {
      ts: NOW_ISO,
      event: "proposed",
      candidateHash: CONTENT_HASH,
      bodyHash: BODY_HASH,
      // OA4: the line names the failure the diagnosis of the record names.
      failureSignature: decision.diagnosis.failureSignature,
      targetSkill: "pdf-tools",
      stagingPath: STAGING_RELATIVE,
      decisionPath: DECISION_RELATIVE,
    },
  ]);

  // The session entry: the documented shape of a staged candidate.
  assert.deepEqual(harness.entries, [
    {
      customType: ENTRY_TYPE,
      data: {
        surface: "command",
        skill: "pdf-tools",
        focus: "merged cells",
        outcome: "proposed",
        reason: null,
        evidenceCount: 1,
        candidateHash: CONTENT_HASH,
        bodyHash: BODY_HASH,
        staged: { slug: LESSON_SLUG, stagingPath: STAGING_RELATIVE, decisionPath: DECISION_RELATIVE },
      },
    },
  ]);

  // Three reports: the candidate that was staged, the gate that is about to spend tokens, and the gate that
  // concluded nothing. The gate is a seam here, so its verdict is the abstention of a run that spends nothing.
  assert.equal(harness.notified.length, 3);
  assert.equal(harness.notified[0].type, "info");
  assert.equal(harness.notified[0].message.includes(STAGING_PATH), true);
  assert.equal(harness.notified[0].message.includes(LESSON_SLUG), true);
  assert.equal(harness.notified[1].type, "info");
  assert.equal(harness.notified[1].message.includes("spends tokens"), true);
  assert.equal(harness.notified[2].type, "warning");
  assert.equal(harness.notified[2].message.includes("abstained"), true);
  assert.equal(harness.notified[2].message.includes("the skill was not edited"), true);
});

// Rule 4: the single generation goes through the session model, with the token budget of the
// proposer, the model of the session pinned on the diagnosis (Q13) and the session identifier the
// provider routes by. A request without the identifier is refused by a session-affine provider
// before the model sees it, so the call has to carry it like the agent loop's own requests do.
test("runSkillImprove: the real proposer calls the session model with the token budget", async () => {
  const harness = createHarness({ model: MODEL, useRealProposer: true });

  await harness.run("pdf-tools");

  assert.equal(harness.completed.length, 1);
  assert.deepEqual(harness.completed[0].model, MODEL);
  assert.equal(harness.completed[0].maxTokens, PROPOSAL_MAX_TOKENS);
  assert.equal(harness.completed[0].sessionId, SESSION_ID);

  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].decision.diagnosis.replayItems[0].model, `${MODEL.provider}/${MODEL.id}`);
  assert.equal(harness.writes[0].decision.candidate.slug, LESSON_SLUG);
  assert.equal(harness.notified[0].type, "info");
});

// Rule 7: without UI the runner hands over a no-op ui context, so the result has to leave through
// another channel or the command answers with silence. The channel is the wiring's, and the test
// connects it the way the wiring does: as a seam of the dependencies.
test("runSkillImprove: without UI the result leaves through the session message channel", async () => {
  const harness = createHarness({ hasUI: false, withSendMessage: true });

  await harness.run("");

  assert.deepEqual(harness.notified, []);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].customType, ENTRY_TYPE);
  assert.equal(harness.sent[0].display, true);
  assert.match(harness.sent[0].content, /Usage: \/skill-improve <skill>/);
});

test("runSkillImprove: without UI and without a message channel the result still reaches stderr", async (t) => {
  const written: string[] = [];
  const original = console.error;
  console.error = (message: string) => {
    written.push(message);
  };
  t.after(() => {
    console.error = original;
  });

  const harness = createHarness({ hasUI: false });

  await harness.run("");

  assert.deepEqual(harness.notified, []);
  assert.equal(written.length, 1);
  assert.match(written[0], /Usage: \/skill-improve <skill>/);
});

// Fail-closed: a write the writer refuses is reported with its own message, and the attempt is not
// recorded because no candidate exists.
test("runSkillImprove: a writer refusal is reported and nothing is recorded", async () => {
  const harness = createHarness({
    writeFailure: new SriWriterError('refusing to write "/elsewhere": outside every root', "/elsewhere"),
  });

  await harness.run("pdf-tools");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "error");
  assert.equal(harness.notified[0].message.includes("outside every root"), true);

  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// The command context pi hands a handler has no appendEntry. The run still stages and still appends
// to the index; the entry is the one thing it cannot record, and it says so.
test("runSkillImprove: a run without an entry channel reports the entry was not recorded", async () => {
  const harness = createHarness({ withEntryChannel: false });

  await harness.run("pdf-tools");

  assert.equal(harness.writes.length, 1);
  assert.equal(harness.attempts.length, 1);
  assert.deepEqual(harness.entries, []);

  assert.equal(harness.notified.length, 4);
  // The degradation is reported where it happens, before the result line.
  assert.equal(harness.notified[0].type, "warning");
  assert.equal(harness.notified[0].message.includes("not recorded"), true);
  assert.equal(harness.notified[1].type, "info");
  assert.equal(harness.notified[1].message.includes(STAGING_PATH), true);
});

// F2: an entry channel that throws is the same degradation as an absent one. The candidate is staged,
// its index line is written, and the run reports the success it had -- a warning that the /tree view is
// missing never turns a staged candidate into a failed run.
test("runSkillImprove: an entry channel that throws does not degrade a staged candidate", async () => {
  const harness = createHarness({
    entryFailure: new Error('EACCES: permission denied, open "session.jsonl"'),
  });

  await harness.run("pdf-tools merged cells");

  assert.equal(harness.writes.length, 1);
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.attempts[0].event, "proposed");
  assert.deepEqual(harness.entries, []);

  assert.equal(harness.notified.length, 4);
  assert.equal(harness.notified[0].type, "warning");
  assert.equal(harness.notified[0].message.includes("not recorded"), true);
  assert.equal(harness.notified[0].message.includes("EACCES"), true);

  // The success notification is the real outcome, with the path of the candidate it staged.
  assert.equal(harness.notified[1].type, "info");
  assert.equal(harness.notified[1].message.includes(STAGING_PATH), true);
  assert.equal(harness.notified[1].message.includes(LESSON_SLUG), true);
});

// F5: findSkill resolves the frontmatter name and the directory basename, so the settings may name a
// skill with either one and the verdict must not depend on which.
const RENAMED_SKILL: SkillRef = {
  name: "syscfg",
  description: "Guard the system configuration",
  dir: "/skills/system-config",
  realDir: "/skills/system-config",
  hasLessons: false,
  kind: "declared",
};

test("runSkillImprove: a deny that names the directory removes the skill asked by its frontmatter name", async () => {
  const harness = createHarness({ skills: [RENAMED_SKILL], config: { allow: [], deny: ["system-config"] } });

  await harness.run("syscfg");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "warning");
  assert.equal(harness.notified[0].message.includes("not-eligible"), true);
  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.writes, []);
  assert.equal(harness.attempts[0].event, "not-eligible");
});

test("runSkillImprove: the same deny removes the skill asked by its directory name", async () => {
  const harness = createHarness({ skills: [RENAMED_SKILL], config: { allow: [], deny: ["system-config"] } });

  await harness.run("system-config");

  assert.equal(harness.notified[0].type, "warning");
  assert.equal(harness.notified[0].message.includes("not-eligible"), true);
  assert.deepEqual(harness.writes, []);
});

test("runSkillImprove: an allow that names the frontmatter name admits the skill asked by its directory", async () => {
  const harness = createHarness({ skills: [RENAMED_SKILL], config: { allow: ["syscfg"], deny: [] } });

  await harness.run("system-config");

  assert.equal(harness.writes.length, 1);
  assert.equal(harness.notified.length, 3);
  assert.equal(harness.notified[0].type, "info");
  assert.equal(harness.notified[0].message.includes(STAGING_PATH), true);
});

// F6: a standalone .md is a skill that exists and is not a directory of its own, so "no such skill"
// would be a false statement about a name the inventory knows.
const STANDALONE_SKILL: SkillRef = {
  name: "standalone-notes",
  description: "Loose notes",
  dir: "/skills",
  realDir: "/skills",
  hasLessons: false,
  kind: "standalone",
};

test("runSkillImprove: a standalone skill is reported as existing but not improvable", async () => {
  const harness = createHarness({ skills: [SKILL, STANDALONE_SKILL] });

  await harness.run("standalone-notes");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "warning");
  const { message } = harness.notified[0];
  assert.equal(message.includes("exists"), true);
  assert.equal(message.includes("standalone"), true);
  assert.equal(message.includes("cannot be improved"), true);
  // Not the message for a name nobody knows.
  assert.equal(message.includes("No skill named"), false);
  // The offer is still the eligible set, which never includes a standalone skill.
  assert.equal(message.includes("Eligible skills: pdf-tools."), true);
  assert.equal(message.includes("Extract tables from PDFs"), false);
  assert.equal(message.includes("standalone-notes: Loose notes"), false);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
});

test("runSkillImprove: a name nobody knows still gets the not-installed message", async () => {
  const harness = createHarness({ skills: [SKILL, STANDALONE_SKILL] });

  await harness.run("ghost-skill");

  assert.equal(harness.notified[0].type, "warning");
  assert.match(harness.notified[0].message, /No skill named "ghost-skill"/);
});

// The offer is the names in one comma-separated line, the same sentence the tool answers with: the reader types a
// name, and a description in the middle of the list would make the sentence the inventory it is not.
test("runSkillImprove: the offered skills are the names in one comma-separated line", async () => {
  const second = makeSkill({ name: "sri-second", description: "A second skill to offer" });
  const harness = createHarness({ skills: [SKILL, second] });

  await harness.run("ghost-skill");

  const { message } = harness.notified[0];
  assert.equal(message.includes("Eligible skills: pdf-tools, sri-second."), true);
  assert.equal(message.includes("A second skill to offer"), false);
  assert.equal(message.includes("Extract tables from PDFs"), false);
});

// --- the chain of M1: propose, gate, accept ---

// The candidate of the accepting test: one fixed draft, so the lesson text and its hash are known before the run and
// the fixture can declare them in the record the gate would have written.
const FIXED_DRAFT: LessonDraft = {
  slug: LESSON_SLUG,
  title: LESSON_TITLE,
  date: "2026-11-02",
  status: "accepted",
  sourceEvidence: ["ev-3f9a1c02"],
  gate: LESSON_GATE_ACCEPTED,
  body: LESSON_BODY,
};

const FAILURE_SIGNATURE = `sha256:${"c".repeat(64)}`;
// 2026-11-02T14:03:22.481Z in the spelling src/writer.ts gives a history snapshot: UTC, no separators.
const TIMESTAMP = "20261102T140322481Z";

function fixedLessonText(): string {
  return lessonTextOf(FIXED_DRAFT);
}

function lessonTextOf(draft: LessonDraft): string {
  const lesson = serializeLesson(draft);
  if (!lesson.ok) assert.fail(`the lesson of this test must serialize: ${lesson.error}`);
  return lesson.value;
}

// The skill of the accepting test, written the way a user writes one: frontmatter and a body, with no `## Lessons`
// section, so the acceptance creates it.
function skillFile(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: Extract tables from PDFs",
    "---",
    "",
    `# ${name}`,
    "",
    "Use the scripts in this directory.",
    "",
  ].join("\n");
}

// The record the gate leaves in staging when it passes: schema @1, the candidate it measured and the verdict it wrote.
// The gate block is a concluded one, because that is the only status an acceptance looks at, and it declares a plan of
// the shape src/gate/scorer.ts produces -- two items, two repetitions each, eight runs -- because a design of one item
// is one that plan refuses to make.
function gateAcceptedRecord(input: {
  skillName: string;
  skillDir: string;
  contentHash: string;
  skillContentHash: string;
}): DecisionRecord {
  return {
    schema: "pi-simple-sri/decision@1",
    createdAt: NOW_ISO,
    trigger: { surface: "command", focus: null },
    skill: {
      name: input.skillName,
      dir: input.skillDir,
      realDir: input.skillDir,
      wasSymlink: false,
      eligible: true,
    },
    eligibility: { allow: [], deny: [] },
    evidence: [
      {
        id: "ev-3f9a1c02",
        kind: "tool_error",
        toolName: "bash",
        timestamp: BASE_MS + 2000,
        source: "transcript",
        excerpt: "pdftotext: cannot open report.pdf",
      },
    ],
    diagnosis: {
      summary: "Table extraction loses merged cells",
      failureSignature: FAILURE_SIGNATURE,
      replayItems: [
        {
          prompt: "extract the merged-cell table from report.pdf",
          cwd: CWD,
          expectation: { class: "tool_error", version: 1, tool: "bash" },
        },
        {
          prompt: "extract the merged-cell table from appendix.pdf",
          cwd: CWD,
          expectation: { class: "tool_error", version: 1, tool: "bash" },
        },
      ],
    },
    candidate: {
      kind: "new-lesson",
      slug: LESSON_SLUG,
      title: LESSON_TITLE,
      targetLesson: null,
      lessonPath: `${LESSONS_DIR}/${LESSON_SLUG}.md`,
      contentHash: input.contentHash,
      bodyHash: sha256Digest(LESSON_BODY),
    },
    gate: {
      basis: "replay",
      status: "gate-accepted",
      budget: { plannedRuns: 8, usedRuns: 8, interruptedAt: null },
      tokens: {
        proposal: { input: 412, output: 137 },
        incumbent: { input: 210, output: 64 },
        candidate: { input: 205, output: 71 },
        total: { input: 827, output: 272 },
      },
      preregistration: {
        recordedAt: NOW_ISO,
        threshold: {
          rule: "unanimous-and-strictly-better",
          candidatePasses: 4,
          incumbentPassesMax: 3,
          version: 1,
        },
        design: { reps: 2, items: 2, plannedRuns: 8, arms: ["incumbent", "candidate"] },
        mde: { basis: "replay", runsPerArm: 4, resolution: 0.25, requiredDifference: 1 },
        // M1c: the hash the acceptance compares against the SKILL.md on disk is recorded in the preregistration, the
        // block both bases write, and not in the result of this one -- which is null in the record of the other.
        skillContentHash: input.skillContentHash,
      },
      replay: {
        completedAt: NOW_ISO,
        verdict: "gate-accepted",
        reason: null,
        items: [],
        arms: {
          incumbent: { passes: 3, runs: 4, tokens: { input: 210, output: 64 } },
          candidate: { passes: 4, runs: 4, tokens: { input: 205, output: 71 } },
        },
        interval: {
          method: "wilson",
          alpha: 0.05,
          incumbent: { low: 0.3006, high: 0.9544 },
          candidate: { low: 0.5101, high: 1 },
          difference: { low: 0.0456, high: 0.6994 },
        },
        regressions: 0,
        excluded: [],
        overlays: {
          incumbent: `${STAGING_RELATIVE}/arms/incumbent/${input.skillName}`,
          candidate: `${STAGING_RELATIVE}/arms/candidate/${input.skillName}`,
          skillContentHash: input.skillContentHash,
          manifestHash: sha256Digest("the manifest of the two copies"),
        },
      },
    },
    outcome: { status: "gate-accepted", reason: null, decidedAt: NOW_ISO },
  };
}

// The outcome of a record read back, narrowed by hand: the test reads JSON, so the field is unknown until something
// says what it is.
function outcomeOf(value: unknown): DecisionRecord["outcome"] {
  if (typeof value !== "object" || value === null) assert.fail("the history record is not a JSON object");
  const outcome: unknown = (value as Record<string, unknown>).outcome;
  if (typeof outcome !== "object" || outcome === null) assert.fail("the history record carries no outcome");
  return outcome as DecisionRecord["outcome"];
}

// The accepting path (M1), end to end: the loop stages a candidate, the gate answers that it passed, and the command
// writes it into the skill through the acceptance it owns. The gate is a seam here -- its own suite proves the verdicts
// -- and the acceptance is the real one, so the bytes in the skill and in its history are the proof of the write.
test("runSkillImprove: a gate that passes writes the candidate into the skill and reports the history", async (t: TestContext) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-command-gate-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const skillDir = path.join(base, "skills", SKILL.name);
  const skillText = skillFile(SKILL.name);
  fs.mkdirSync(path.join(skillDir, LESSONS_DIR), { recursive: true });
  fs.writeFileSync(path.join(skillDir, SKILL_FILE), skillText, "utf8");

  // The candidate the gate passes is the one the loop staged: the same lesson text, so the hash the record declares is
  // the hash of the bytes the acceptance writes into the skill.
  const lessonText = fixedLessonText();
  const stagingDirPath = path.join(base, STAGING_RELATIVE);
  fs.mkdirSync(path.join(stagingDirPath, LESSONS_DIR), { recursive: true });
  fs.writeFileSync(path.join(stagingDirPath, LESSONS_DIR, `${LESSON_SLUG}.md`), lessonText, "utf8");
  fs.writeFileSync(
    path.join(stagingDirPath, DECISION_FILE),
    JSON.stringify(
      gateAcceptedRecord({
        skillName: SKILL.name,
        skillDir,
        contentHash: sha256Digest(lessonText),
        skillContentHash: sha256Digest(skillText),
      }),
    ),
    "utf8",
  );

  const harness = createHarness({
    base,
    skills: [makeSkill({ dir: skillDir, realDir: skillDir })],
    propose: async () => ({
      ok: true,
      value: { draft: FIXED_DRAFT, lessonText, usage: { input: 412, output: 137 } },
    }),
    gate: async () => ({
      kind: "gate-accepted",
      reason: null,
      stagingPath: STAGING_RELATIVE,
      decisionPath: DECISION_RELATIVE,
      plannedRuns: 8,
      usedRuns: 8,
      overlays: null,
    }),
    acceptDeps: { now: () => NOW },
  });

  await harness.run("pdf-tools");

  // The gate saw the candidate the loop staged, under the base and the agent directory of the run.
  assert.equal(harness.gateRequests.length, 1);
  assert.equal(harness.gateRequests[0].stagingPath, STAGING_RELATIVE);
  assert.equal(harness.gateRequests[0].base, base);
  assert.equal(harness.gateRequests[0].agentDir, AGENT_DIR);

  // The lesson is in the skill, and SKILL.md references it exactly once.
  const lessonPath = path.join(skillDir, LESSONS_DIR, `${LESSON_SLUG}.md`);
  assert.equal(fs.readFileSync(lessonPath, "utf8"), lessonText);
  assert.equal(countReferenceLines(fs.readFileSync(path.join(skillDir, SKILL_FILE), "utf8"), LESSON_SLUG), 1);

  // The record of the acceptance is inside the history of the skill, named after the clock of the seam.
  const historyPath = path.join(skillDir, HISTORY_DIR, TIMESTAMP, DECISION_FILE);
  assert.deepEqual(outcomeOf(JSON.parse(fs.readFileSync(historyPath, "utf8"))), {
    status: "accepted",
    reason: null,
    decidedAt: NOW_ISO,
  });

  // The request the acceptance answered, built by the command from the record the gate wrote.
  assert.equal(harness.acceptRequests.length, 1);
  const [request] = harness.acceptRequests;
  assert.equal(request.skill.realDir, skillDir);
  assert.equal(request.candidate.slug, LESSON_SLUG);
  assert.equal(request.candidate.contentHash, sha256Digest(lessonText));
  assert.equal(request.expectedSkillContentHash, sha256Digest(skillText));
  assert.equal(request.failureSignature, FAILURE_SIGNATURE);

  // The answer names both absolute paths, and the index gained the one line the acceptance appends.
  const accepted = harness.notified.at(-1);
  assert.equal(accepted?.type, "info");
  assert.equal(accepted?.message.includes(lessonPath), true);
  assert.equal(accepted?.message.includes(historyPath), true);

  const lines = fs
    .readFileSync(path.join(stateDir(base), ATTEMPTS_FILE), "utf8")
    .split("\n")
    .filter((line) => line !== "");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes('"event":"accepted"'), true);
  assert.equal(lines[0].includes(historyPath), true);
});

// A candidate the gate rejects is reported with its reason and the skill is not touched: the acceptance is never
// reached, which the seam below fails the test for.
test("runSkillImprove: a gate that rejects the candidate reports the reason and leaves the skill alone", async () => {
  const harness = createHarness({
    gate: async () => ({
      kind: "gate-rejected",
      reason: "below-threshold",
      stagingPath: STAGING_RELATIVE,
      decisionPath: DECISION_RELATIVE,
      plannedRuns: 4,
      usedRuns: 4,
      overlays: null,
    }),
    accept: async () => assert.fail("a rejected candidate must not reach the acceptance"),
  });

  await harness.run("pdf-tools");

  assert.equal(harness.gateRequests.length, 1);
  assert.deepEqual(harness.acceptRequests, []);

  const rejection = harness.notified.at(-1);
  assert.equal(rejection?.type, "warning");
  assert.equal(rejection?.message.includes("below-threshold"), true);
  assert.equal(rejection?.message.includes("after 4 runs"), true);
  assert.equal(rejection?.message.includes("the skill was not edited"), true);
});

// M4: a rejection the judge produced is a rejection with a case and the judge's sentence, and the flow carries both in the
// detail of the result. The command prints it, so the user reads which case failed and why instead of the bare word of the
// vocabulary that stopped the gate.
test("runSkillImprove: a rejection of the judge prints the case and its sentence", async () => {
  const detail = "no-squash-all: the answer keeps the destructive command";
  const harness = createHarness({
    gate: async () => ({
      kind: "gate-rejected",
      reason: "judge-failed",
      stagingPath: STAGING_RELATIVE,
      decisionPath: DECISION_RELATIVE,
      plannedRuns: 8,
      usedRuns: 8,
      overlays: null,
      detail,
    }),
    accept: async () => assert.fail("a rejected candidate must not reach the acceptance"),
  });

  await harness.run("pdf-tools");

  assert.deepEqual(harness.acceptRequests, []);
  const rejection = harness.notified.at(-1);
  assert.equal(rejection?.type, "warning");
  assert.equal(rejection?.message.includes("judge-failed"), true);
  assert.equal(rejection?.message.includes("no-squash-all"), true);
  assert.equal(rejection?.message.includes("the answer keeps the destructive command"), true);
  assert.equal(rejection?.message.includes("the skill was not edited"), true);
});

// The same with an abstention: a verdict that concluded nothing is not a write either.
test("runSkillImprove: a gate that abstains reports the reason and leaves the skill alone", async () => {
  const harness = createHarness({
    gate: async () => ({
      kind: "gate-abstained",
      reason: "no-model",
      stagingPath: STAGING_RELATIVE,
      decisionPath: DECISION_RELATIVE,
      plannedRuns: 3,
      usedRuns: 0,
      overlays: null,
    }),
    accept: async () => assert.fail("an abstention must not reach the acceptance"),
  });

  await harness.run("pdf-tools");

  assert.deepEqual(harness.acceptRequests, []);
  // An abstention is not a reload either (M2, S3): nothing was written into the skill, so there is no new version of it for
  // the session to read, and the context is neither asked to go idle nor asked to reload.
  assert.equal(harness.idleCalls, 0);
  assert.equal(harness.reloadCalls, 0);
  const abstention = harness.notified.at(-1);
  assert.equal(abstention?.type, "warning");
  assert.equal(abstention?.message.includes("abstained"), true);
  assert.equal(abstention?.message.includes("no-model"), true);
  assert.equal(abstention?.message.includes("the skill was not edited"), true);
});

// A candidate the gate cannot even read is a refusal of the run and not a verdict: it is reported as the error it is,
// and nothing is accepted.
test("runSkillImprove: a candidate the gate refuses is reported as an error", async () => {
  const detail = 'cannot read "/pkg/staging/candidate/decision.json": it is not JSON';
  const harness = createHarness({
    gate: async () => ({ kind: "refused", rejection: { reason: "unreadable-record", detail } }),
    accept: async () => assert.fail("a refused candidate must not reach the acceptance"),
  });

  await harness.run("pdf-tools");

  assert.deepEqual(harness.acceptRequests, []);
  const report = harness.notified.at(-1);
  assert.equal(report?.type, "error");
  assert.equal(report?.message.includes("the gate refused the candidate"), true);
  assert.equal(report?.message.includes(detail), true);
});

// Steps 1 to 3 of the run are the whole chain's condition: a run with no evidence and a skill the settings exclude
// stage nothing, so there is no candidate to gate and no skill to write.
test("runSkillImprove: a run that stages nothing never reaches the gate", async () => {
  const withoutEvidence = createHarness({ branch: [] });
  await withoutEvidence.run("pdf-tools");
  assert.deepEqual(withoutEvidence.gateRequests, []);
  assert.deepEqual(withoutEvidence.acceptRequests, []);

  const denied = createHarness({ config: { allow: [], deny: ["pdf-tools"] } });
  await denied.run("pdf-tools");
  assert.deepEqual(denied.gateRequests, []);
  assert.deepEqual(denied.acceptRequests, []);
});

// ---------------------------------------------------------------------------------------------
// M1c: the two bases of the gate and the staged run
// ---------------------------------------------------------------------------------------------

// The bank the tests of this section name. It never reaches the disk: the gate of the bank base is a seam here, and its own
// suite proves what it does with a bank.
const BANK_PATH = "/work/reports/cases.json";

// The candidate a gate accepted leaves behind, on disk: the skill, the lesson the record names and the record itself. It is the
// fixture of the three tests that reach the acceptance, and it is written the way src/writer.ts and the gate write it -- the
// lesson inside the candidate, the record naming it relative to that candidate.
function stageAcceptedCandidate(base: string, skillDir: string): { lessonText: string; skillText: string } {
  const skillText = skillFile(SKILL.name);
  fs.mkdirSync(path.join(skillDir, LESSONS_DIR), { recursive: true });
  fs.writeFileSync(path.join(skillDir, SKILL_FILE), skillText, "utf8");

  const lessonText = fixedLessonText();
  const stagingDirPath = path.join(base, STAGING_RELATIVE);
  fs.mkdirSync(path.join(stagingDirPath, LESSONS_DIR), { recursive: true });
  fs.writeFileSync(path.join(stagingDirPath, LESSONS_DIR, `${LESSON_SLUG}.md`), lessonText, "utf8");
  // The record of a gate that passed. Its gate block is the one of the replay base, and the acceptance reads none of it: what
  // it compares against the skill is the preregistration, which is the block both bases write (the reason the two bases share
  // it), plus the candidate and its hashes. The gate itself is a seam in this suite.
  fs.writeFileSync(
    path.join(stagingDirPath, DECISION_FILE),
    JSON.stringify(
      gateAcceptedRecord({
        skillName: SKILL.name,
        skillDir,
        contentHash: sha256Digest(lessonText),
        skillContentHash: sha256Digest(skillText),
      }),
    ),
    "utf8",
  );

  return { lessonText, skillText };
}

// A usage error is reported before anything is read, so a run that asks for a defect and names no bank spends nothing and
// records nothing: the sentence names the flag and the bank it needs.
test("runSkillImprove: --defect without --bank is reported and nothing is spent", async () => {
  const harness = createHarness();

  await harness.run("pdf-tools --defect");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "error");
  assert.equal(harness.notified[0].message.includes("--bank"), true);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.directionalRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// OA7: --staged skips the proposal and enters the gate of the candidate the path names. The proof is the proposer that was never
// called and the lesson that reached the skill: it is the file the candidate held, verified against the record that declares it.
test("runSkillImprove: --staged gates the candidate of the path without calling the proposer", async (t: TestContext) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-command-staged-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const skillDir = path.join(base, "skills", SKILL.name);
  const { lessonText, skillText } = stageAcceptedCandidate(base, skillDir);

  const harness = createHarness({
    base,
    skills: [makeSkill({ dir: skillDir, realDir: skillDir })],
    gate: async () => ({
      kind: "gate-accepted",
      reason: null,
      stagingPath: STAGING_RELATIVE,
      decisionPath: DECISION_RELATIVE,
      plannedRuns: 8,
      usedRuns: 8,
      overlays: null,
    }),
    acceptDeps: { now: () => NOW },
  });

  await harness.run(`pdf-tools --staged=${STAGING_RELATIVE}`);

  // No proposal: no generation, no staging write and no attempt line of its own. The run only measures a candidate that exists.
  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);

  // The gate saw the candidate the path named, under the base and the agent directory of the run.
  assert.equal(harness.gateRequests.length, 1);
  assert.equal(harness.gateRequests[0].stagingPath, STAGING_RELATIVE);
  assert.equal(harness.gateRequests[0].base, base);
  assert.equal(harness.gateRequests[0].agentDir, AGENT_DIR);
  assert.equal(harness.gateRequests[0].skill.name, SKILL.name);

  // The acceptance wrote the bytes the candidate held, read from the lesson the record names and verified against its hashes.
  assert.equal(harness.acceptRequests.length, 1);
  const [request] = harness.acceptRequests;
  assert.equal(request.candidate.lessonText, lessonText);
  assert.equal(request.candidate.contentHash, sha256Digest(lessonText));
  assert.equal(request.expectedSkillContentHash, sha256Digest(skillText));

  const lessonPath = path.join(skillDir, LESSONS_DIR, `${LESSON_SLUG}.md`);
  assert.equal(fs.readFileSync(lessonPath, "utf8"), lessonText);
  const historyPath = path.join(skillDir, HISTORY_DIR, TIMESTAMP, DECISION_FILE);
  assert.equal(fs.existsSync(historyPath), true);

  const accepted = harness.notified.at(-1);
  assert.equal(accepted?.type, "info");
  assert.equal(accepted?.message.includes(lessonPath), true);
  assert.equal(accepted?.message.includes(historyPath), true);
});

// The base of the bank, end to end: a run that names a bank proposes as it always does and the gate of that base measures the
// candidate, and the command accepts it because the gate accepted it -- the same rule as the other base, and the same write.
test("runSkillImprove: --bank gates with the bank base and accepts what the gate accepted", async (t: TestContext) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-command-bank-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const skillDir = path.join(base, "skills", SKILL.name);
  const { lessonText } = stageAcceptedCandidate(base, skillDir);

  const harness = createHarness({
    base,
    model: MODEL,
    skills: [makeSkill({ dir: skillDir, realDir: skillDir })],
    propose: async () => ({
      ok: true,
      value: { draft: FIXED_DRAFT, lessonText, usage: { input: 412, output: 137 } },
    }),
    gateDirectional: async () => ({
      kind: "gate-accepted",
      reason: null,
      stagingPath: STAGING_RELATIVE,
      decisionPath: DECISION_RELATIVE,
      plannedRuns: 4,
      usedRuns: 4,
      overlays: null,
    }),
    acceptDeps: { now: () => NOW },
  });

  await harness.run(`pdf-tools --bank=${BANK_PATH}`);

  // The candidate was proposed and measured by the bank, and the replay flow of M1 was never asked.
  assert.equal(harness.proposals.length, 1);
  assert.equal(harness.writes.length, 1);
  assert.deepEqual(harness.gateRequests, []);
  assert.equal(harness.directionalRequests.length, 1);
  assert.equal(harness.directionalRequests[0].bankPath, BANK_PATH);
  assert.equal(harness.directionalRequests[0].model, `${MODEL.provider}/${MODEL.id}`);
  assert.equal(harness.directionalRequests[0].stagingPath, STAGING_RELATIVE);

  // And the acceptance wrote the candidate into the skill, reporting both paths of the write.
  const lessonPath = path.join(skillDir, LESSONS_DIR, `${LESSON_SLUG}.md`);
  const historyPath = path.join(skillDir, HISTORY_DIR, TIMESTAMP, DECISION_FILE);
  assert.equal(fs.readFileSync(lessonPath, "utf8"), lessonText);
  assert.equal(fs.existsSync(historyPath), true);

  const accepted = harness.notified.at(-1);
  assert.equal(accepted?.type, "info");
  assert.equal(accepted?.message.includes(historyPath), true);
});

// OA1, OA9: a bank that is not there is not a verdict of the gate and not a write. The command reports the reason of the reader
// and the path of the candidate, which is what the retry is pointed at, and the skill is left alone.
test("runSkillImprove: a gate with no baseline writes nothing and says what to fix", async () => {
  const reason = `bank-absent: ${BANK_PATH}`;
  const harness = createHarness({
    model: MODEL,
    gateDirectional: async () => ({
      kind: "no-baseline",
      reason,
      stagingPath: STAGING_RELATIVE,
      decisionPath: DECISION_RELATIVE,
      plannedRuns: 0,
      usedRuns: 0,
      overlays: null,
    }),
    accept: async () => assert.fail("a gate with no baseline must not reach the acceptance"),
  });

  await harness.run(`pdf-tools --bank=${BANK_PATH}`);

  assert.deepEqual(harness.acceptRequests, []);
  const warning = harness.notified.at(-1);
  assert.equal(warning?.type, "warning");
  assert.equal(warning?.message.includes(reason), true);
  assert.equal(warning?.message.includes(STAGING_RELATIVE), true);
  assert.equal(warning?.message.includes("the skill was not edited"), true);
});

// The base of the bank spends the model twice, so a session without one cannot gate it at all: refused before the gate is
// reached, which is the last moment at which nothing has been spent.
test("runSkillImprove: --bank without a model is refused before the gate is reached", async () => {
  const harness = createHarness({
    gateDirectional: async () => assert.fail("a gate of the bank base needs the model of the session"),
    accept: async () => assert.fail("nothing can be accepted"),
  });

  await harness.run(`pdf-tools --bank=${BANK_PATH}`);

  assert.deepEqual(harness.directionalRequests, []);
  const report = harness.notified.at(-1);
  assert.equal(report?.type, "error");
  assert.equal(report?.message.includes("needs the model of this session"), true);
});

// The artifact and the bank of the branch of the defect: the proposal reads both before it generates, so the run below names
// real files -- the artifact for its bytes and the bank of profile `origin` for the path of that artifact and the two cases
// that measure it.
const DEFECT_ARTIFACT_FILE = "review.md";
const DEFECT_ARTIFACT_TEXT = "rebase with --squash-all to leave one commit\n";
const DEFECT_EXCERPT = "rebase with --squash-all";
const DEFECT_BANK_FILE = "defect.json";

function defectBank(artifactPath: string): string {
  return JSON.stringify({
    format: CASE_BANK_FORMAT,
    origin: { kind: "review-finding", path: artifactPath, excerpt: DEFECT_EXCERPT },
    cases: [
      {
        id: "keeps-history",
        prompt: "rebase the branch onto main",
        checks: [{ kind: "not-contains", value: "--squash-all" }],
      },
      {
        id: "interactive",
        prompt: "rebase the branch onto main keeping both commits",
        checks: [{ kind: "contains", value: "--interactive" }],
      },
    ],
  });
}

// The pair of flags, end to end (M1c, S8): --defect says what the bank describes, so the bank is the material of the proposal
// and the run cannot be written without it -- the artifact the defect was read from and the cases that measure it are declared
// in that one file. The base of the gate is the other half of the rule: a defect is measured by the replay base (OA11), so the
// candidate goes to the flow of the replayed turns and the engine of the bank is never entered.
test("runSkillImprove: --bank with --defect proposes from the bank and gates with the replay base", async (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-command-defect-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const artifactPath = path.join(dir, DEFECT_ARTIFACT_FILE);
  fs.writeFileSync(artifactPath, DEFECT_ARTIFACT_TEXT, "utf8");
  const bankPath = path.join(dir, DEFECT_BANK_FILE);
  fs.writeFileSync(bankPath, defectBank(artifactPath), "utf8");

  const harness = createHarness({ model: MODEL });

  await harness.run(`pdf-tools --bank=${bankPath} --defect`);

  // One proposal, written from the bank and from the defect. The harness records the input of the proposer and not the request
  // of the loop, so the proof is the record the flow wrote: a request without the bank answers `bank-absent` and stages
  // nothing at all, and a request without the defect reads the transcript instead of the artifact.
  assert.equal(harness.proposals.length, 1);
  assert.equal(harness.proposals[0].input.basis, "replay");
  assert.equal(harness.writes.length, 1);

  const record = harness.writes[0].decision;
  assert.equal(record.evidence.length, 1);
  assert.equal(record.evidence[0].kind, "quality_defect");
  assert.equal(record.evidence[0].excerpt, DEFECT_EXCERPT);
  assert.equal(record.evidence[0].origin?.path, artifactPath);
  // The two cases of the bank are the items the gate of the replay base will measure, which is the material the bank carried
  // into the run.
  assert.deepEqual(
    record.diagnosis.replayItems.map((item) => item.prompt),
    ["rebase the branch onto main", "rebase the branch onto main keeping both commits"],
  );
  // The base the record declares: a defect is measured by the replayed turns and not by the bank (OA11).
  assert.equal(record.gate.basis, "replay");
  assert.equal(record.gate.status, "not-run");

  // And one gate, the replay one: the bank is the material and not the base, so the flow of the bank was never asked.
  assert.equal(harness.gateRequests.length, 1);
  assert.equal(harness.gateRequests[0].stagingPath, STAGING_RELATIVE);
  assert.equal(harness.gateRequests[0].skill.name, SKILL.name);
  assert.deepEqual(harness.directionalRequests, []);

  // The reported outcome is the answer of that gate, and a gate that concluded nothing accepts nothing.
  assert.deepEqual(harness.acceptRequests, []);
  const abstention = harness.notified.at(-1);
  assert.equal(abstention?.type, "warning");
  assert.equal(abstention?.message.includes("insufficient-items"), true);
});

// M2c, review of the slice: the bank a run names is resolved against the cwd of the session and not against the cwd of the
// process -- the reader of src/case-bank.ts stats the path as it arrives, and the path a user types is the one a shell would
// resolve in the directory the session runs in. The directory below is a temporary one this test created, so the two differ by
// construction: the process runs from the repository, and `cases.json` is a relative name that only the session directory
// answers.
test("runSkillImprove: --bank is resolved against the cwd of the session", async (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-command-cwd-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const harness = createHarness({ cwd: dir, model: MODEL });

  await harness.run("pdf-tools --bank=cases.json");

  // The gate of the bank received the resolved path, and the report of the run names the same one.
  const bankPath = path.join(dir, "cases.json");
  assert.equal(harness.directionalRequests.length, 1);
  assert.equal(harness.directionalRequests[0].bankPath, bankPath);
  assert.equal(harness.notified.at(-1)?.message.includes(bankPath), true);
  assert.deepEqual(harness.gateRequests, []);
});

// The same resolution on the other consumer of the flag: the proposal of a defect reads the bank the run named, so a run that
// gives it as a relative path proposes from it -- a request the flow reads as it arrived would answer `bank-absent` and stage
// nothing -- and the record keeps the artifact the bank declares, read from the same directory.
test("runSkillImprove: a relative --bank is read by the proposal against the cwd of the session", async (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-command-cwd-defect-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const artifactPath = path.join(dir, DEFECT_ARTIFACT_FILE);
  fs.writeFileSync(artifactPath, DEFECT_ARTIFACT_TEXT, "utf8");
  fs.writeFileSync(path.join(dir, DEFECT_BANK_FILE), defectBank(artifactPath), "utf8");

  const harness = createHarness({ cwd: dir, model: MODEL });

  await harness.run(`pdf-tools --bank=${DEFECT_BANK_FILE} --defect`);

  assert.equal(harness.proposals.length, 1);
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].decision.evidence[0].origin?.path, artifactPath);
});

// ---------------------------------------------------------------------------------------------
// M2: the reload of the session
// ---------------------------------------------------------------------------------------------

// The harness of the tests below: a candidate the gate accepted is on disk, the gate answers that it passed, and the real
// acceptance writes it into the skill, so the run reaches the point where the session reloads. The reports and the two
// calls of the context land in `calls`, in the order they happened, which is what the protocol is asserted on.
function createAcceptingHarness(t: TestContext, options: HarnessOptions = {}): { harness: Harness; skillDir: string } {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-command-reload-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const skillDir = path.join(base, "skills", SKILL.name);
  const { lessonText } = stageAcceptedCandidate(base, skillDir);

  const harness = createHarness({
    base,
    skills: [makeSkill({ dir: skillDir, realDir: skillDir })],
    propose: async () => ({
      ok: true,
      value: { draft: FIXED_DRAFT, lessonText, usage: { input: 412, output: 137 } },
    }),
    gate: async () => ({
      kind: "gate-accepted",
      reason: null,
      stagingPath: STAGING_RELATIVE,
      decisionPath: DECISION_RELATIVE,
      plannedRuns: 8,
      usedRuns: 8,
      overlays: null,
    }),
    acceptDeps: { now: () => NOW },
    ...options,
  });

  return { harness, skillDir };
}

// The protocol of the accepting run, in order (M2, S3): the acceptance is reported, then the session is asked to go idle, and
// only then does it reload. The notice comes first because it is the last line the frame that still has a context can write,
// and waitForIdle before the reload because pi warns and returns without reloading while the agent is streaming -- a reload
// lost in silence is exactly the defect this step closes.
test("runSkillImprove: an accepting run notifies the acceptance, waits for idle and reloads, in that order", async (t: TestContext) => {
  const { harness, skillDir } = createAcceptingHarness(t);

  await harness.run("pdf-tools");

  // The three last calls of the run are the three of the protocol and nothing else, and everything before them is a report.
  assert.deepEqual(harness.calls.slice(-3), ["notify", "waitForIdle", "reload"]);
  assert.equal(harness.calls.slice(0, -3).every((call) => call === "notify"), true);
  assert.equal(harness.idleCalls, 1);
  assert.equal(harness.reloadCalls, 1);

  // The report that precedes the reload is the acceptance itself, with the two paths the acceptance wrote.
  const accepted = harness.notified.at(-1);
  assert.equal(accepted?.type, "info");
  assert.equal(
    accepted?.message,
    acceptedText(
      SKILL,
      LESSON_SLUG,
      path.join(skillDir, LESSONS_DIR, `${LESSON_SLUG}.md`),
      path.join(skillDir, HISTORY_DIR, TIMESTAMP, DECISION_FILE),
    ),
  );
  // M2 (S4): the sentence names the reload as the step this run takes next and not as something already done -- the
  // clause is the one that stops a reader from believing the old skill is still the loaded one.
  assert.equal(accepted?.message.includes("The session reloads next"), true);
  assert.equal(accepted?.message.includes("a reload that fails leaves this acceptance standing"), true);
});

// Nothing runs after the reload (M2, S3): the code that followed would land in the frame the reload invalidated, where every
// getter of the context throws. The fake records every report and the two calls of the reload, so a report or one of those
// two calls after it would leave a trace at the end of one of the two lists; a context read that is none of the three is out
// of its reach, and the invariant written at the site is what covers it.
test("runSkillImprove: nothing is called and nothing is reported after the reload", async (t: TestContext) => {
  const { harness } = createAcceptingHarness(t);

  await harness.run("pdf-tools");

  assert.equal(harness.calls.at(-1), "reload");
  assert.equal(harness.calls.filter((call) => call === "reload").length, 1);
  // The last report of the run is the acceptance and the last session entry is the one of the proposal: nothing was said or
  // recorded after the reload.
  assert.equal(harness.notified.at(-1)?.type, "info");
  assert.equal(harness.notified.at(-1)?.message.includes("accepted"), true);
  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries.at(-1)?.data.outcome, "proposed");
});

// A rejected acceptance is not a reload either (M2, S3, OA5): the protocol refused the candidate and wrote nothing, so there
// is no new version of the skill to read, and the detail the acceptance named is the whole answer.
test("runSkillImprove: an acceptance that rejects with skill-drift does not reload the session", async (t: TestContext) => {
  const detail = `"/tmp/skills/pdf-tools/SKILL.md" hashes to sha256:${"d".repeat(64)}, not to the ${CONTENT_HASH} the gate preregistered for "/tmp/skills/pdf-tools": the candidate describes a skill that no longer exists`;
  const { harness } = createAcceptingHarness(t, {
    accept: async () => ({ ok: false, error: { reason: "skill-drift", detail } }),
  });

  await harness.run("pdf-tools");

  // Neither of the two calls, and no report of a reload that did not happen.
  assert.equal(harness.idleCalls, 0);
  assert.equal(harness.reloadCalls, 0);
  assert.deepEqual(
    harness.calls.filter((call) => call !== "notify"),
    [],
  );

  // The detail of the rejection is reported as the error it is, and it is the last thing the run says.
  const rejection = harness.notified.at(-1);
  assert.equal(rejection?.type, "error");
  assert.equal(rejection?.message, detail);
});

// A reload that fails does not undo the acceptance and does not fail the run (M2, S3): no operation reverts a publication,
// so the run keeps the skill it wrote and reports the one thing that did not happen. The warning reads no member of the
// context -- after a reload the runner is gone and ctx.ui and ctx.hasUI throw -- which is why it reaches the harness through
// the last channel of the chain, the one the report of the run does not use here.
test("runSkillImprove: a reload that fails leaves the acceptance standing and reports one warning", async (t: TestContext) => {
  const written: string[] = [];
  const original = console.error;
  console.error = (message: string) => {
    written.push(message);
  };
  t.after(() => {
    console.error = original;
  });

  const failure = new Error("the runner is not there to reload");
  const { harness, skillDir } = createAcceptingHarness(t, { reloadFailure: failure });

  // The run resolves: a reload that failed is a warning, not the outcome of the run.
  await harness.run("pdf-tools");

  assert.equal(harness.idleCalls, 1);
  assert.equal(harness.reloadCalls, 1);
  // The reload is still the last call of the context: the warning did not go through it, because that is the branch that
  // needs the runner the reload invalidated.
  assert.equal(harness.calls.at(-1), "reload");

  // Exactly one warning, and the reason it carries is the one the reload failed with.
  assert.equal(written.length, 1);
  assert.equal(written[0], `${COMMAND_NAME}: ${reloadFailedText(failure.message)}`);

  // And the acceptance stands: the lesson is where the acceptance put it and the last report is its own.
  assert.equal(fs.existsSync(path.join(skillDir, LESSONS_DIR, `${LESSON_SLUG}.md`)), true);
  assert.equal(harness.notified.at(-1)?.message.includes("accepted"), true);
});

// ---------------------------------------------------------------------------------------------
// M3, S7 (D-C): the eligibility the acceptance re-checks
// ---------------------------------------------------------------------------------------------

// The acceptance does not read settings -- that is its written invariant -- so the verdict travels from here as data. The
// command resolves it with the rule and the reader the loop uses, and the request carries it: the field is present and it
// is the verdict of the skill of the run, not a constant of the surface.
test("runSkillImprove: the acceptance receives the eligibility verdict of the skill", async (t: TestContext) => {
  const { harness } = createAcceptingHarness(t);

  await harness.run("pdf-tools");

  assert.equal(harness.acceptRequests.length, 1);
  assert.deepEqual(harness.acceptRequests[0].eligibility, { eligible: true });
});

// B4: the settings of a run are read once, in the branch that runs, and they travel as data -- so the proposal, the gate and
// the acceptance of one run decide on the same SriConfig. The count is the whole assertion: a second read would be a second
// answer to "what do the settings say", and a settings file edited in the middle of a long gate would reach half of one run.
test("runSkillImprove: a propose, gate and accept run reads the settings once", async (t: TestContext) => {
  const { harness } = createAcceptingHarness(t);

  await harness.run("pdf-tools");

  // The three steps of the chain happened: the candidate was proposed, the gate answered it and the acceptance received it.
  assert.equal(harness.proposals.length, 1);
  assert.equal(harness.gateRequests.length, 1);
  assert.equal(harness.acceptRequests.length, 1);
  // And the run asked for the settings of its agent directory exactly once, with the path src/config.ts builds.
  assert.deepEqual(harness.configReads, [path.join(AGENT_DIR, "settings.json")]);
});

// The candidate can exist by another way than the loop of this command: --staged takes one that is already in staging and
// never asks the flow whether its skill is eligible. The verdict still reaches the acceptance, and it is the one of the
// settings of this run -- so the last negative fires here, before the snapshot, and the skill keeps the text the gate saw.
test("runSkillImprove: a staged run passes the verdict of a denied skill, and the acceptance refuses it", async (t: TestContext) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-command-ineligible-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const skillDir = path.join(base, "skills", SKILL.name);
  const { skillText } = stageAcceptedCandidate(base, skillDir);

  const harness = createHarness({
    base,
    config: { allow: [], deny: [SKILL.name] },
    skills: [makeSkill({ dir: skillDir, realDir: skillDir })],
    gate: async () => ({
      kind: "gate-accepted",
      reason: null,
      stagingPath: STAGING_RELATIVE,
      decisionPath: DECISION_RELATIVE,
      plannedRuns: 8,
      usedRuns: 8,
      overlays: null,
    }),
    acceptDeps: { now: () => NOW },
  });

  await harness.run(`pdf-tools --staged=${STAGING_RELATIVE}`);

  // The verdict the command resolved is the one of the settings, and it is what the acceptance was handed.
  assert.equal(harness.acceptRequests.length, 1);
  assert.deepEqual(harness.acceptRequests[0].eligibility, { eligible: false, reason: "not-eligible" });

  // The refusal is reported as the error it is, the skill keeps the text the gate measured, and the session does not
  // reload: there is no new version of the skill to read.
  const refusal = harness.notified.at(-1);
  assert.equal(refusal?.type, "error");
  assert.equal(refusal?.message.includes("is no longer eligible: not-eligible"), true);
  assert.equal(fs.readFileSync(path.join(skillDir, SKILL_FILE), "utf8"), skillText);
  assert.equal(fs.existsSync(path.join(skillDir, HISTORY_DIR)), false);
  assert.equal(harness.reloadCalls, 0);
});

// ---------------------------------------------------------------------------------------------
// M3, S2: the report of the series (--metrics)
// ---------------------------------------------------------------------------------------------

const LATER_ISO = "2026-11-05T14:03:22.481Z";

// The block of a candidate the gate never ran, which is what a proposed record carries: the report reads no pair out of it
// because a gate that did not conclude replayed nothing to count a regression over.
const NOT_RUN_GATE: GateBlock = {
  basis: "replay",
  status: "not-run",
  budget: { plannedRuns: 0, usedRuns: 0, interruptedAt: null },
  tokens: {
    proposal: { input: 0, output: 0 },
    incumbent: { input: 0, output: 0 },
    candidate: { input: 0, output: 0 },
    total: { input: 0, output: 0 },
  },
  preregistration: null,
  replay: null,
};

// The record of an attempt as the index names it: the one the gate of M1 wrote, with the outcome and the gate the test needs
// on top of it. Its evidence is the tool error of the lesson, which is the class of failure a later attempt of the same skill
// has to name to be a recurrence of it.
function reportRecord(options: { outcome?: DecisionOutcomeStatus; gate?: GateBlock } = {}): DecisionRecord {
  const record = gateAcceptedRecord({
    skillName: SKILL.name,
    skillDir: SKILL.dir,
    contentHash: CONTENT_HASH,
    skillContentHash: sha256Digest(SKILL_TEXT),
  });

  return {
    ...record,
    gate: options.gate ?? record.gate,
    outcome: { status: options.outcome ?? "accepted", reason: null, decidedAt: NOW_ISO },
  };
}

// One line of the index, as src/ledger.ts reads it back from the file: the event, the hashes of the attempt, the skill, and
// the path its record is resolved through -- `historyPath` for an acceptance and `decisionPath` for every other event.
function attemptLineOf(
  event: string,
  options: { ts?: string; historyPath?: string; decisionPath?: string } = {},
): ReadAttemptLine {
  return {
    ts: options.ts ?? NOW_ISO,
    event,
    candidateHash: CONTENT_HASH,
    bodyHash: BODY_HASH,
    failureSignature: FAILURE_SIGNATURE,
    targetSkill: SKILL.name,
    ...(options.historyPath === undefined ? {} : { historyPath: options.historyPath }),
    ...(options.decisionPath === undefined ? {} : { decisionPath: options.decisionPath }),
  };
}

// The base of the three consumers of B5: one `accepted` line of the index whose `.history/` record is the file a hand edit
// left broken -- the version this reader checks, and no `candidate` at all. It is one fixture for the three of them because
// the defect was one: the reader handed that object over as a `DecisionRecord` and the consumer threw where it read it. The
// skill directory is the one the record and the inventory name, so each branch reaches its own first dereference.
function brokenRecordFixture(t: TestContext, prefix: string): { base: string; skillDir: string; historyPath: string } {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const skillDir = path.join(base, "skills", SKILL.name);
  const historyPath = path.join(skillDir, HISTORY_DIR, TIMESTAMP, DECISION_FILE);
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify({ schema: "pi-simple-sri/decision@1", createdAt: NOW_ISO }), "utf8");

  fs.mkdirSync(stateDir(base), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir(base), ATTEMPTS_FILE),
    `${JSON.stringify(attemptLineOf("accepted", { historyPath: path.relative(base, historyPath) }))}\n`,
    "utf8",
  );

  return { base, skillDir, historyPath };
}

// --metrics is a boolean flag like --defect, so it carries no value, and it takes no other flag: a report of what the index
// already holds and a run that spends a generation or a gate are two different requests.
test("parseSkillImproveArgs: --metrics is parsed as itself and refuses the flags of a run", () => {
  assert.deepEqual(parseSkillImproveArgs("--metrics"), { metrics: true });

  for (const args of ["--metrics --bank=/abs/x.json", "--metrics --defect --bank=/abs/x.json", "--metrics --staged=x"]) {
    assert.throws(() => parseSkillImproveArgs(args), SriFailClosedError);
  }

  // The value every boolean flag of this parser gets: the token is one the command does not understand.
  assert.throws(() => parseSkillImproveArgs("--metrics=yes"), SriFailClosedError);
});

// M3, S2: --metrics reads the index of the base of the run and answers with the numbers of the series, through the channel
// the command uses for everything that is not a refusal. The fixture is on disk and the reader is the real one, so every
// number of the sentence below is the one the index and the records produce -- and the run spends nothing: no generation, no
// gate of either base, no acceptance, no write, no line of the index and no session entry.
test("runSkillImprove: --metrics reports the series of the index and spends nothing", async (t: TestContext) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-command-metrics-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  // The history record of the acceptance and the record of a later proposal of the same skill, which names the class of
  // failure the lesson had corrected.
  const history = path.join(base, "skills", SKILL.name, HISTORY_DIR, TIMESTAMP, DECISION_FILE);
  const proposal = path.join(base, STAGING_RELATIVE, DECISION_FILE);
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.writeFileSync(history, JSON.stringify(reportRecord()), "utf8");
  fs.mkdirSync(path.dirname(proposal), { recursive: true });
  fs.writeFileSync(proposal, JSON.stringify(reportRecord({ outcome: "proposed", gate: NOT_RUN_GATE })), "utf8");

  // Two gated attempts -- the acceptance and an abstention that named no record at all -- and the later proposal.
  const lines = [
    attemptLineOf("accepted", { historyPath: history }),
    attemptLineOf("gate-abstained"),
    attemptLineOf("proposed", { ts: LATER_ISO, decisionPath: proposal }),
  ];
  fs.mkdirSync(stateDir(base), { recursive: true });
  fs.writeFileSync(path.join(stateDir(base), ATTEMPTS_FILE), lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");

  const harness = createHarness({ base });

  await harness.run("--metrics");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "info");
  const report = harness.notified[0].message;
  // The rate over the two attempts that reached a gate, the recurrence of the one lesson in force whose class came back, the
  // four runs of the incumbent arm of the one gate that concluded and its zero regressions, and the split of D-B, which over
  // this record counts no failed run of the fourth class at all.
  assert.equal(report.includes("acceptance rate 0.50 (1 of 2 gated attempts)."), true);
  assert.equal(report.includes("recurrence rate 1.00 (1 of 1 accepted lesson that saw its failure class return)."), true);
  assert.equal(report.includes("gate regressions 0 of 4 incumbent passes."), true);
  assert.equal(report.includes("quality defects that failed: 0 by a tool error, 0 by the text."), true);
  // The coverage line is the one that is printed only when it has something to say, and this index has nothing missing.
  assert.equal(report.includes("coverage is partial"), false);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.completed, []);
  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.directionalRequests, []);
  assert.deepEqual(harness.acceptRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// A report and a measurement are two requests, so a run that names both is refused before the index is opened: the answer is
// the usage error and never a report, and nothing is read, spent or recorded.
test("runSkillImprove: --metrics with another flag is a usage error and reads nothing", async () => {
  const harness = createHarness();

  await harness.run(`--metrics --staged=${STAGING_RELATIVE}`);

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "error");
  assert.equal(harness.notified[0].message.includes("--metrics"), true);
  assert.equal(harness.notified[0].message.includes("takes no other flag"), true);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.directionalRequests, []);
  assert.deepEqual(harness.acceptRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// An index that is not there is not an error (src/ledger.ts): a machine that never ran an attempt deserves the sentence that
// says there is nothing to measure yet, and no number that could be read as the measurement of nothing.
test("runSkillImprove: --metrics over a base with no attempt says there is nothing to measure", async (t: TestContext) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-command-metrics-empty-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const harness = createHarness({ base });

  await harness.run("--metrics");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "info");
  const report = harness.notified[0].message;
  assert.equal(report.includes("acceptance rate: no gated attempt yet."), true);
  assert.equal(report.includes("recurrence rate: no accepted lesson yet."), true);
  assert.equal(report.includes("gate regressions: no pair replayed by a gate yet."), true);
  // No rate over an empty denominator: "0.00" would be a measurement of nothing.
  assert.equal(report.includes("0.00"), false);

  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
});

// B5: the report over a record the reader now refuses. The line is an acceptance the report cannot count as a gated attempt --
// the verdict of an acceptance is its record, and this record is not one -- so the rate says there is none, and the coverage
// line says why. Before the guard of src/ledger.ts this run threw a TypeError out of verdictOf instead of printing anything.
test("runSkillImprove: --metrics over a broken record reports partial coverage and does not throw", async (t: TestContext) => {
  const { base } = brokenRecordFixture(t, "sri-command-metrics-broken-");
  const harness = createHarness({ base });

  await harness.run("--metrics");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "info");
  const report = harness.notified[0].message;
  assert.equal(report.includes("acceptance rate: no gated attempt yet."), true);
  assert.equal(report.includes("recurrence rate: no accepted lesson yet."), true);
  assert.equal(report.includes("gate regressions: no pair replayed by a gate yet."), true);
  // The one record the index names is not readable, and the sentence counts it instead of letting the lines above pass for the
  // series.
  assert.equal(report.includes("coverage is partial: of the 1 record this index names, 1 could not be read"), true);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.directionalRequests, []);
  assert.deepEqual(harness.acceptRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// ---------------------------------------------------------------------------------------------
// M3, S10: the index that stops at a cut line, and the two reports that say so
// ---------------------------------------------------------------------------------------------

// The index an interrupted append left behind: one line that reads and the tail of a second one that does not. src/ledger.ts
// answers the lines before the cut and names the position and the problem, and a report built over those lines is shorter --
// and therefore more reassuring -- than the index is, which is the reading the two branches below refuse to leave.
function truncatedIndexFixture(t: TestContext, prefix: string): { base: string; indexPath: string } {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const indexPath = path.join(stateDir(base), ATTEMPTS_FILE);
  fs.mkdirSync(stateDir(base), { recursive: true });
  fs.writeFileSync(
    indexPath,
    `${JSON.stringify(attemptLineOf("gate-abstained"))}\n{"ts":"2026-11-05T09:00:00.000Z","event":"proposed"`,
    "utf8",
  );

  return { base, indexPath };
}

// M3, S10: the report of the index and, under it, the sentence of the cut -- the position where the reading stopped, the path of
// the file and the problem. Without it a truncated index passes for a short series, which is the one reading a report must not
// allow.
test("runSkillImprove: --metrics over a truncated index appends the sentence of the cut", async (t: TestContext) => {
  const { base, indexPath } = truncatedIndexFixture(t, "sri-command-metrics-damaged-");
  const harness = createHarness({ base });

  await harness.run("--metrics");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "info");
  const report = harness.notified[0].message;
  const lines = report.split("\n");
  const last = lines[lines.length - 1];

  // The numbers of the one line that could be read are still the answer...
  assert.equal(report.includes("acceptance rate 0.00 (0 of 1 gated attempt)."), true);
  assert.equal(report.includes("quality defects that failed: 0 by a tool error, 0 by the text."), true);
  // ...and the cut comes last, with the line the file shows and not the position the reader counted. src/ledger.ts answers the
  // position of the line inside the file, which is 0-based, and the sentence counts lines a human opens: the cut here is on the
  // second line of the file, so the answer says line 2 (M3, S11).
  assert.equal(last.includes(`the index "${indexPath}" stops at line 2`), true);
  assert.equal(last.includes("was not read"), true);
  assert.equal(report.indexOf(`the index "${indexPath}"`) > report.indexOf("quality defects that failed"), true);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.directionalRequests, []);
  assert.deepEqual(harness.acceptRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// A report of the series answers for the whole index, so a skill name typed next to the flag is a request no answer of this
// command honours: the run would print the series while the user read it as the row of that skill. The refusal is the usage
// error and it comes before anything is read, which is what the base below proves -- a directory sits where its index should be,
// so a run that opened it would fail with the error of the runtime instead of answering the usage error.
test("runSkillImprove: --metrics with a skill name is a usage error and reads nothing", async (t: TestContext) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-command-metrics-skill-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(stateDir(base), ATTEMPTS_FILE), { recursive: true });

  const harness = createHarness({ base });

  await harness.run("--metrics pdf-tools");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "error");
  const refusal = harness.notified[0].message;
  assert.equal(refusal.includes("--metrics"), true);
  assert.equal(refusal.includes('"pdf-tools"'), true);
  assert.equal(refusal.includes("the whole index"), true);
  assert.equal(refusal.includes("Nothing was read."), true);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.directionalRequests, []);
  assert.deepEqual(harness.acceptRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// ---------------------------------------------------------------------------------------------
// M3, S3: the check of the accepted lessons (--verify)
// ---------------------------------------------------------------------------------------------

// The second lesson of the check and the snapshot its acceptance took: one acceptance the skill still holds and one whose
// file it lost, so the report has a row with a worst state of its own and a lesson line to print.
const SECOND_SLUG = "use-camelot-for-tables";
const SECOND_TITLE = "Use camelot for tables";
const SECOND_TIMESTAMP = "20261102T140500000Z";
// An acceptance whose record nobody can read: it is the count the report cannot check and never a lesson it calls intact.
const GONE_TIMESTAMP = "20261102T140900000Z";
// The lesson the skill holds and does not load: its bytes are the ones of its record and SKILL.md never gained its
// reference line, which is the state a report of intact files with no line would hide (Q10).
const INERT_SLUG = "drop-empty-columns-first";
const INERT_TITLE = "Drop empty columns first";
const INERT_TIMESTAMP = "20261102T140700000Z";

// The history record of an acceptance of the check. standingOf resolves the lesson from the realDir the record carries and
// hashes the bytes on disk against the pair of hashes the record declares, so the record is the whole fixture: the index is
// only the line that names it. The pair comes from lessonHashes, the function src/writer.ts stamps the record with (D4).
function standingRecordOf(options: { skillDir: string; draft: LessonDraft }): DecisionRecord {
  const hashes = lessonHashes(lessonTextOf(options.draft));
  if (!hashes.ok) assert.fail(`the lesson of this test must hash: ${hashes.error}`);

  const record = gateAcceptedRecord({
    skillName: SKILL.name,
    skillDir: options.skillDir,
    contentHash: hashes.value.contentHash,
    skillContentHash: sha256Digest(SKILL_TEXT),
  });

  return {
    ...record,
    candidate: {
      kind: "new-lesson",
      slug: options.draft.slug,
      title: options.draft.title,
      targetLesson: null,
      lessonPath: `${LESSONS_DIR}/${options.draft.slug}.md`,
      contentHash: hashes.value.contentHash,
      bodyHash: hashes.value.bodyHash,
    },
  };
}

// The SKILL.md of the fixture: the skill as a user writes it plus one reference line per lesson, in the canonical spelling
// src/skill-reference.ts owns -- that line is the only thing that makes a lesson reachable (Q10).
function referencedSkillText(lessons: readonly LessonDraft[]): string {
  return lessons.reduce((text, draft) => upsertReferenceLine(text, draft.slug, draft.title), skillFile(SKILL.name));
}

function writeHistory(historyPath: string, record: DecisionRecord): void {
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify(record), "utf8");
}

// --verify is a boolean flag like --metrics, and it takes no other flag either: a check of the bytes on disk and a run that
// proposes or measures a candidate are two different requests, and one invocation does one job.
test("parseSkillImproveArgs: --verify is parsed as itself and refuses the flags of a run", () => {
  assert.deepEqual(parseSkillImproveArgs("--verify"), { verify: true });

  for (const args of [
    "--verify --bank=/abs/x.json",
    "--verify --defect --bank=/abs/x.json",
    "--verify --staged=x",
    "--verify --metrics",
  ]) {
    assert.throws(() => parseSkillImproveArgs(args), SriFailClosedError);
  }

  // The value every boolean flag of this parser gets: the token is one the command does not understand.
  assert.throws(() => parseSkillImproveArgs("--verify=yes"), SriFailClosedError);
});

// M3, S3: --verify reads the index of the base of the run, checks every accepted lesson still in force against the record
// that accepted it, and answers with the report -- through the channel the command uses for everything that is not a
// refusal. The fixture is on disk and both readers are the real ones, so every line below is the one the bytes and the
// records produce, and the run spends nothing: no generation, no model, no gate of either base, no acceptance, no write, no
// line of the index and no session entry.
test("runSkillImprove: --verify reports the state of the accepted lessons and spends nothing", async (t: TestContext) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-command-verify-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const skillDir = path.join(base, "skills", SKILL.name);
  fs.mkdirSync(path.join(skillDir, LESSONS_DIR), { recursive: true });

  // The three acceptances the skill answers for: the lesson it holds with the bytes of its record and the line that loads
  // it, the one nobody wrote, and the one whose bytes are intact and whose line SKILL.md never gained. Every record is a
  // real file where the index names it.
  const kept: LessonDraft = FIXED_DRAFT;
  const lost: LessonDraft = { ...FIXED_DRAFT, slug: SECOND_SLUG, title: SECOND_TITLE };
  const inert: LessonDraft = { ...FIXED_DRAFT, slug: INERT_SLUG, title: INERT_TITLE };
  fs.writeFileSync(path.join(skillDir, LESSONS_DIR, `${kept.slug}.md`), lessonTextOf(kept), "utf8");
  fs.writeFileSync(path.join(skillDir, LESSONS_DIR, `${inert.slug}.md`), lessonTextOf(inert), "utf8");
  fs.writeFileSync(path.join(skillDir, SKILL_FILE), referencedSkillText([kept, lost]), "utf8");

  const keptHistory = path.join(skillDir, HISTORY_DIR, TIMESTAMP, DECISION_FILE);
  const lostHistory = path.join(skillDir, HISTORY_DIR, SECOND_TIMESTAMP, DECISION_FILE);
  const inertHistory = path.join(skillDir, HISTORY_DIR, INERT_TIMESTAMP, DECISION_FILE);
  const goneHistory = path.join(skillDir, HISTORY_DIR, GONE_TIMESTAMP, DECISION_FILE);
  writeHistory(keptHistory, standingRecordOf({ skillDir, draft: kept }));
  writeHistory(lostHistory, standingRecordOf({ skillDir, draft: lost }));
  writeHistory(inertHistory, standingRecordOf({ skillDir, draft: inert }));

  const lines = [
    attemptLineOf("accepted", { historyPath: path.relative(base, keptHistory) }),
    attemptLineOf("accepted", { ts: LATER_ISO, historyPath: path.relative(base, lostHistory) }),
    attemptLineOf("accepted", { ts: LATER_ISO, historyPath: path.relative(base, inertHistory) }),
    attemptLineOf("accepted", { ts: LATER_ISO, historyPath: path.relative(base, goneHistory) }),
  ];
  fs.mkdirSync(stateDir(base), { recursive: true });
  fs.writeFileSync(path.join(stateDir(base), ATTEMPTS_FILE), lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");

  const harness = createHarness({ base });

  await harness.run("--verify");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "info");
  const report = harness.notified[0].message;

  // The row of the skill names the worst state of its three lessons: the one the skill lost.
  assert.equal(report.includes(`${SKILL.name}: missing (3 lessons, worst: missing)`), true);
  // The lesson nobody wrote is printed with its state and with the path the record names, which is what a user repairs.
  assert.equal(report.includes(`  - ${lost.slug}: missing (`), true);
  assert.equal(report.includes(path.join(skillDir, LESSONS_DIR, `${lost.slug}.md`)), true);
  // The lesson whose bytes are the ones of its record and whose line SKILL.md never gained is not called fine: the line
  // says the file is there and that the skill does not reach it (Q10).
  assert.equal(report.includes(`  - ${inert.slug}: intact (the lesson file is in the skill,`), true);
  assert.equal(report.includes(path.join(skillDir, SKILL_FILE)), true);
  assert.equal(report.includes(`"${lessonReferencePath(inert.slug)}"`), true);
  // The lesson that is intact and referenced is not printed at all: it is the answer the report exists to earn.
  assert.equal(report.includes(`  - ${kept.slug}:`), false);
  // The acceptance whose record is not there cannot be compared against anything, and the last line says so instead of
  // letting the rows above pass for the whole coverage.
  assert.equal(report.includes("1 accepted lesson could not be checked"), true);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.completed, []);
  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.directionalRequests, []);
  assert.deepEqual(harness.acceptRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
  assert.equal(harness.idleCalls, 0);
  assert.equal(harness.reloadCalls, 0);
});

// A check and a report are two requests, so a run that names both flags is refused before the index is opened. The proof that
// nothing was read is the base below: a directory sits where its index should be, so a run that opened it would fail with
// the error of the runtime instead of answering the usage error.
test("runSkillImprove: --verify with another flag is a usage error and reads nothing", async (t: TestContext) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-command-verify-usage-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(stateDir(base), ATTEMPTS_FILE), { recursive: true });

  const harness = createHarness({ base });

  await harness.run("--verify --metrics");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "error");
  assert.equal(harness.notified[0].message.includes("--verify"), true);
  assert.equal(harness.notified[0].message.includes("takes no other flag"), true);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.directionalRequests, []);
  assert.deepEqual(harness.acceptRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// An index with no acceptance in force is not an error: the check answers the sentence that says there is nothing to check,
// with words and not with a table whose rows would read as the measurement of nothing.
test("runSkillImprove: --verify over a base with no acceptance says there is nothing to check", async (t: TestContext) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-command-verify-empty-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const harness = createHarness({ base });

  await harness.run("--verify");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "info");
  // The whole sentence, from the builder the command prints, and no row of a report under it.
  assert.equal(harness.notified[0].message, standingText({ checks: [], skills: [], missingRecords: 0 }));
  assert.equal(harness.notified[0].message.includes("nothing to check"), true);
  assert.equal(harness.notified[0].message.includes("worst:"), false);
  assert.equal(harness.notified[0].message.includes("\n"), false);

  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// B5: the check over a record the reader now refuses. The acceptance is in force -- the line says so -- and the record that
// accepted it cannot be read, so the lesson is a hole in the coverage and not an intact one: it is counted in `missingRecords`
// and left out of the rows. Before the guard of src/ledger.ts this run threw a TypeError out of record.skill.realDir.
test("runSkillImprove: --verify counts a broken record in missingRecords and does not throw", async (t: TestContext) => {
  const { base } = brokenRecordFixture(t, "sri-command-verify-broken-");
  const harness = createHarness({ base });

  await harness.run("--verify");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "info");
  // The answer of the check is the sentence of the count, with no row invented for a lesson nobody could compare against a
  // record: the whole report is the one src/messages.ts builds for one missing record.
  assert.equal(harness.notified[0].message, standingText({ checks: [], skills: [], missingRecords: 1 }));
  assert.equal(harness.notified[0].message.includes("1 accepted lesson could not be checked"), true);
  assert.equal(harness.notified[0].message.includes("worst:"), false);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.completed, []);
  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.directionalRequests, []);
  assert.deepEqual(harness.acceptRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
  assert.equal(harness.idleCalls, 0);
  assert.equal(harness.reloadCalls, 0);
});

// M3, S10: the check over the index that stops at a cut line answers the report it can build and, under it, the sentence of the
// cut. A check that read a truncated index would describe a shorter -- and quieter -- series than the one on disk.
test("runSkillImprove: --verify over a truncated index appends the sentence of the cut", async (t: TestContext) => {
  const { base, indexPath } = truncatedIndexFixture(t, "sri-command-verify-damaged-");
  const harness = createHarness({ base });

  await harness.run("--verify");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "info");
  const report = harness.notified[0].message;
  const lines = report.split("\n");

  // The answer of the check over the one line that could be read...
  assert.equal(lines[0], standingText({ checks: [], skills: [], missingRecords: 0 }));
  // ...and the cut under it, with the line of the file it broke on -- the second one, counted the way a reader counts -- and the
  // path of the index the user repairs.
  const last = lines[lines.length - 1];
  assert.equal(lines.length, 2);
  assert.equal(last.includes(`the index "${indexPath}" stops at line 2`), true);
  assert.equal(last.includes("was not read"), true);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.completed, []);
  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// The check answers for the whole index too, so a skill name next to --verify is the same usage error as next to --metrics, and it
// is asked before the index is opened: the base below holds a directory where its index should be.
test("runSkillImprove: --verify with a skill name is a usage error and reads nothing", async (t: TestContext) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-command-verify-skill-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(stateDir(base), ATTEMPTS_FILE), { recursive: true });

  const harness = createHarness({ base });

  await harness.run("--verify pdf-tools");

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "error");
  const refusal = harness.notified[0].message;
  assert.equal(refusal.includes("--verify"), true);
  assert.equal(refusal.includes('"pdf-tools"'), true);
  assert.equal(refusal.includes("the whole index"), true);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.directionalRequests, []);
  assert.deepEqual(harness.acceptRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// ---------------------------------------------------------------------------------------------
// M3, S4: the retirement of an accepted lesson (--retire)
// ---------------------------------------------------------------------------------------------

// The clock and the snapshot of the retirement: a different moment from the one the acceptance of the same fixture took, so
// the two histories of the skill do not collide.
const RETIRE_NOW = new Date("2026-11-06T09:00:00.000Z");
const RETIRE_TIMESTAMP = "20261106T090000000Z";

// The pair of flags of S4: one names the lesson, one names the reason, and the detail of the reason is the focus. Every
// combination that would be two jobs under one invocation is a usage error, and so is a reason outside the vocabulary and a
// retirement that names no detail -- a closed key with no sentence is a reason the record cannot carry.
test("parseSkillImproveArgs: --retire and --reason are parsed as themselves and refuse what they cannot do", () => {
  assert.deepEqual(parseSkillImproveArgs("pdf-tools --retire=merged-cells --reason=stale the appendix moved"), {
    skill: "pdf-tools",
    focus: "the appendix moved",
    retire: "merged-cells",
    reason: "stale",
  });

  // A retirement without its reason, without its skill, without its detail, and a reason without the retirement it
  // explains.
  for (const args of [
    "pdf-tools --retire=merged-cells the appendix moved",
    "--retire=merged-cells --reason=stale",
    "pdf-tools --retire=merged-cells --reason=stale",
    "pdf-tools --reason=stale moved",
  ]) {
    assert.throws(() => parseSkillImproveArgs(args), SriFailClosedError);
  }

  // A key outside the five, and a retirement that names another flag of the command: the second is refused with the
  // sentence of the retirement and not with the generic one of a token the command does not understand, which would
  // misdescribe what happened -- both flags exist and they do not compose.
  for (const args of [
    "pdf-tools --retire=merged-cells --reason=obsolete moved",
    "pdf-tools --retire=merged-cells --reason=stale --bank=/abs/x.json moved",
    "pdf-tools --retire=merged-cells --reason=stale --staged=x moved",
    "pdf-tools --retire=merged-cells --reason=stale --metrics moved",
    "pdf-tools --retire=merged-cells --reason=stale --verify moved",
    "--retire=merged-cells --reason=stale --metrics moved",
  ]) {
    assert.throws(() => parseSkillImproveArgs(args), SriFailClosedError);
  }

  // The refusal of a combination names the flag the run is about -- a report and a check lead their own sentence, and the
  // retirement's sentence names the material of a run -- and the refusal of a key names all five, because the vocabulary is
  // what the user has to type.
  assert.throws(
    () => parseSkillImproveArgs("pdf-tools --retire=merged-cells --reason=stale --verify moved"),
    (error: unknown) =>
      error instanceof SriFailClosedError && error.message.includes("--verify") && error.message.includes("--retire"),
  );
  assert.throws(
    () => parseSkillImproveArgs("pdf-tools --retire=merged-cells --reason=stale --bank=/abs/x.json moved"),
    (error: unknown) => error instanceof SriFailClosedError && error.message.includes("--retire=<slug>"),
  );
  assert.throws(
    () => parseSkillImproveArgs("pdf-tools --retire=merged-cells --reason=obsolete moved"),
    (error: unknown) =>
      error instanceof SriFailClosedError &&
      error.message.includes("stale, superseded, ineffective, wrong, unreferenced"),
  );
});

// The fixture of the retirement: a skill that references one accepted lesson, the record the acceptance left in `.history/`
// and the one line of the index that names it. It is the state the acceptance of M1 leaves behind, written the way both
// writers write it -- the lesson hashing to the pair its record declares, the record where the line points.
function createRetirementFixture(t: TestContext): { base: string; skillDir: string; historyPath: string; skillBefore: string } {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-command-retire-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const skillDir = path.join(base, "skills", SKILL.name);
  const skillBefore = referencedSkillText([FIXED_DRAFT]);
  fs.mkdirSync(path.join(skillDir, LESSONS_DIR), { recursive: true });
  fs.writeFileSync(path.join(skillDir, LESSONS_DIR, `${LESSON_SLUG}.md`), lessonTextOf(FIXED_DRAFT), "utf8");
  fs.writeFileSync(path.join(skillDir, SKILL_FILE), skillBefore, "utf8");

  const historyPath = path.join(skillDir, HISTORY_DIR, TIMESTAMP, DECISION_FILE);
  writeHistory(historyPath, standingRecordOf({ skillDir, draft: FIXED_DRAFT }));

  fs.mkdirSync(stateDir(base), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir(base), ATTEMPTS_FILE),
    `${JSON.stringify(attemptLineOf("accepted", { historyPath: path.relative(base, historyPath) }))}\n`,
    "utf8",
  );

  return { base, skillDir, historyPath, skillBefore };
}

// The retirement end to end: the request carries the material of the acceptance, the protocol writes its files, and the run
// closes the way an acceptance does -- notice, wait for idle, reload -- with nothing of the loop touched.
test("runSkillImprove: --retire retires the lesson, reports it, waits for idle and reloads", async (t: TestContext) => {
  const fixture = createRetirementFixture(t);
  const hashes = lessonHashes(lessonTextOf(FIXED_DRAFT));
  if (!hashes.ok) assert.fail(`the lesson of this test must hash: ${hashes.error}`);

  const harness = createHarness({
    base: fixture.base,
    skills: [makeSkill({ dir: fixture.skillDir, realDir: fixture.skillDir })],
    retireDeps: { now: () => RETIRE_NOW },
    accept: async () => assert.fail("a retirement must not reach the acceptance"),
    gate: async () => assert.fail("a retirement must not gate anything"),
  });

  await harness.run(`pdf-tools --retire=${LESSON_SLUG} --reason=stale the appendix moved`);

  // The request the protocol answered: the skill of the acceptance, its pair of hashes, the path of its record and the
  // reason of the run, with the free text in the detail.
  assert.equal(harness.retireRequests.length, 1);
  const [request] = harness.retireRequests;
  assert.equal(request.skill.realDir, fixture.skillDir);
  assert.equal(request.lesson.slug, LESSON_SLUG);
  assert.equal(request.lesson.title, FIXED_DRAFT.title);
  assert.equal(request.lesson.contentHash, hashes.value.contentHash);
  assert.equal(request.lesson.bodyHash, hashes.value.bodyHash);
  assert.equal(request.acceptedHistoryPath, fixture.historyPath);
  assert.deepEqual(request.reason, { key: "stale", detail: "the appendix moved" });

  // The chain of the command is the acceptance's: the notice, then the wait for idle and the reload, and nothing after it.
  assert.deepEqual(harness.calls.slice(-3), ["notify", "waitForIdle", "reload"]);
  assert.equal(harness.idleCalls, 1);
  assert.equal(harness.reloadCalls, 1);

  // Nothing of the loop was touched: no proposal, no model call, no gate of either base, no acceptance and no staging write.
  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.completed, []);
  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.directionalRequests, []);
  assert.deepEqual(harness.acceptRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.entries, []);

  // The bytes: the reference line left the section, the file says retired with the body of the acceptance, the reason is in
  // the snapshot of the clock the run injected, and the index gained the one line of the event.
  const skillAfter = fs.readFileSync(path.join(fixture.skillDir, SKILL_FILE), "utf8");
  assert.equal(countReferenceLines(skillAfter, LESSON_SLUG), 0);
  const retired = fs.readFileSync(path.join(fixture.skillDir, LESSONS_DIR, `${LESSON_SLUG}.md`), "utf8");
  assert.equal(retired.includes('status: "retired"'), true);
  assert.equal(retired.includes(LESSON_BODY), true);

  const retirementPath = path.join(fixture.skillDir, HISTORY_DIR, RETIRE_TIMESTAMP, RETIREMENT_FILE);
  assert.equal(fs.existsSync(retirementPath), true);

  const lines = fs
    .readFileSync(path.join(stateDir(fixture.base), ATTEMPTS_FILE), "utf8")
    .split("\n")
    .filter((line) => line !== "");
  assert.equal(lines.length, 2);
  assert.equal(lines[1].includes('"event":"retired"'), true);
  assert.equal(lines[1].includes('"reason":"stale: the appendix moved"'), true);

  // The last report is the retirement, with the path of its record among the two it names.
  const report = harness.notified.at(-1);
  assert.equal(report?.type, "info");
  assert.equal(report?.message.includes("retired"), true);
  assert.equal(report?.message.includes(retirementPath), true);
  assert.equal(report?.message.includes("There is no unretire"), true);
});

// A slug the index holds no acceptance of is not retired and nothing is written: `never-accepted` is the statement that the
// index does not hold an accepted lesson of that slug whose hashes can be verified, which is the precondition of the whole
// protocol.
test("runSkillImprove: --retire without an accepted line answers never-accepted and writes nothing", async (t: TestContext) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-command-retire-never-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const skillDir = path.join(base, "skills", SKILL.name);
  const skillBefore = referencedSkillText([FIXED_DRAFT]);
  fs.mkdirSync(path.join(skillDir, LESSONS_DIR), { recursive: true });
  fs.writeFileSync(path.join(skillDir, SKILL_FILE), skillBefore, "utf8");
  fs.writeFileSync(path.join(skillDir, LESSONS_DIR, `${LESSON_SLUG}.md`), lessonTextOf(FIXED_DRAFT), "utf8");

  const harness = createHarness({
    base,
    skills: [makeSkill({ dir: skillDir, realDir: skillDir })],
    retire: async () => assert.fail("a slug with no acceptance must not reach the protocol"),
  });

  await harness.run(`pdf-tools --retire=${LESSON_SLUG} --reason=stale the appendix moved`);

  assert.deepEqual(harness.retireRequests, []);
  const refusal = harness.notified.at(-1);
  assert.equal(refusal?.type, "error");
  assert.equal(refusal?.message.includes("(never-accepted)"), true);
  assert.equal(refusal?.message.includes("nothing was retired"), true);
  assert.equal(refusal?.message.includes(`lessons/${LESSON_SLUG}.md`), true);

  // Nothing was written: no snapshot, no edit of SKILL.md, no index.
  assert.equal(fs.existsSync(path.join(skillDir, HISTORY_DIR)), false);
  assert.equal(fs.readFileSync(path.join(skillDir, SKILL_FILE), "utf8"), skillBefore);
  assert.equal(fs.existsSync(path.join(stateDir(base), ATTEMPTS_FILE)), false);
  assert.equal(harness.idleCalls, 0);
  assert.equal(harness.reloadCalls, 0);
});

// B5: the retirement over a record the reader now refuses. A retirement is a protocol over the pair of hashes of the
// acceptance, and a record nobody can read establishes no pair, so the answer is `never-accepted` -- the same statement the
// index makes when it holds no acceptance of the slug at all -- and nothing is written. Before the guard of src/ledger.ts this
// run threw a TypeError out of record.candidate.slug inside acceptedLessonOf.
test("runSkillImprove: --retire over a broken record answers never-accepted and writes nothing", async (t: TestContext) => {
  const { base, skillDir } = brokenRecordFixture(t, "sri-command-retire-broken-");
  const harness = createHarness({
    base,
    skills: [makeSkill({ dir: skillDir, realDir: skillDir })],
    retire: async () => assert.fail("a record nobody can read must not reach the protocol"),
  });

  await harness.run(`pdf-tools --retire=${LESSON_SLUG} --reason=stale the appendix moved`);

  assert.deepEqual(harness.retireRequests, []);
  const refusal = harness.notified.at(-1);
  assert.equal(refusal?.type, "error");
  assert.equal(refusal?.message.includes("(never-accepted)"), true);
  assert.equal(refusal?.message.includes("nothing was retired"), true);
  assert.equal(refusal?.message.includes(`lessons/${LESSON_SLUG}.md`), true);
  // Nothing was written, and the session is not reloaded for a retirement that did not happen.
  assert.equal(fs.existsSync(path.join(skillDir, HISTORY_DIR, RETIRE_TIMESTAMP)), false);
  assert.equal(harness.idleCalls, 0);
  assert.equal(harness.reloadCalls, 0);
});

// An index that stops at a truncated line cannot say what it accepted: the line an interrupted append cut may be the
// acceptance of this lesson, so the answer is `unreadable-index` and not a claim that nothing was accepted, and nothing is
// written.
test("runSkillImprove: --retire over a truncated index answers unreadable-index and writes nothing", async (t: TestContext) => {
  const fixture = createRetirementFixture(t);
  const indexPath = path.join(stateDir(fixture.base), ATTEMPTS_FILE);
  // The tail of an append an interruption cut: a JSON line that never ended.
  fs.appendFileSync(indexPath, '{"ts":"2026-11-05T09:00:00.000Z","event":"proposed"', "utf8");
  const indexBefore = fs.readFileSync(indexPath, "utf8");

  const harness = createHarness({
    base: fixture.base,
    skills: [makeSkill({ dir: fixture.skillDir, realDir: fixture.skillDir })],
    retire: async () => assert.fail("an index that cannot be read must not reach the protocol"),
  });

  await harness.run(`pdf-tools --retire=${LESSON_SLUG} --reason=stale the appendix moved`);

  assert.deepEqual(harness.retireRequests, []);
  const refusal = harness.notified.at(-1);
  assert.equal(refusal?.type, "error");
  assert.equal(refusal?.message.includes("(unreadable-index)"), true);
  assert.equal(refusal?.message.includes(indexPath), true);
  // The line of the refusal is the physical one (M3, S11): the truncated append is the second line of the index, and the
  // position src/ledger.ts answers for it is 1.
  assert.equal(refusal?.message.includes("line 2"), true);

  // Nothing was written: the index is the bytes it was, and the skill kept its line and its lesson.
  assert.equal(fs.readFileSync(indexPath, "utf8"), indexBefore);
  assert.equal(fs.readFileSync(path.join(fixture.skillDir, SKILL_FILE), "utf8"), fixture.skillBefore);
  assert.equal(fs.existsSync(path.join(fixture.skillDir, HISTORY_DIR, RETIRE_TIMESTAMP)), false);
  assert.equal(harness.idleCalls, 0);
  assert.equal(harness.reloadCalls, 0);
});

// A retirement the protocol refuses is reported with the sentence of its reason and does not reload: no new version of the
// skill was written for the session to read.
test("runSkillImprove: a retirement the protocol refuses does not reload the session", async (t: TestContext) => {
  const fixture = createRetirementFixture(t);
  const detail = `"${path.join(fixture.skillDir, LESSONS_DIR, `${LESSON_SLUG}.md`)}" is not the lesson the acceptance measured`;

  const harness = createHarness({
    base: fixture.base,
    skills: [makeSkill({ dir: fixture.skillDir, realDir: fixture.skillDir })],
    retire: async () => ({ ok: false, error: { reason: "lesson-drift", detail } }),
  });

  await harness.run(`pdf-tools --retire=${LESSON_SLUG} --reason=stale the appendix moved`);

  assert.equal(harness.retireRequests.length, 1);
  assert.equal(harness.idleCalls, 0);
  assert.equal(harness.reloadCalls, 0);

  const refusal = harness.notified.at(-1);
  assert.equal(refusal?.type, "error");
  assert.equal(refusal?.message.includes("(lesson-drift)"), true);
  assert.equal(refusal?.message.includes(detail), true);
  assert.equal(refusal?.message.includes("nothing was retired"), true);
});

// A retirement is not a repair of a skill nobody installed: a name nobody knows is answered the way every other branch of
// the command answers it, and the protocol is never reached.
test("runSkillImprove: --retire over an unknown skill answers the offer and reads nothing", async (t: TestContext) => {
  const fixture = createRetirementFixture(t);
  const harness = createHarness({ base: fixture.base, skills: [makeSkill({ dir: fixture.skillDir, realDir: fixture.skillDir })] });

  await harness.run(`ghost-skill --retire=${LESSON_SLUG} --reason=stale the appendix moved`);

  assert.deepEqual(harness.retireRequests, []);
  const refusal = harness.notified.at(-1);
  assert.equal(refusal?.type, "warning");
  assert.equal(refusal?.message.includes("No skill named"), true);
  assert.equal(fs.readFileSync(path.join(fixture.skillDir, SKILL_FILE), "utf8"), fixture.skillBefore);
});

// ---------------------------------------------------------------------------------------------
// M3, S6: the confirmation of a suspicion (--signal)
// ---------------------------------------------------------------------------------------------

// The id of the suspicion the tests below confirm, and the occurrence it names: a file of the reports directory written in
// two turns with other arguments, which is the first kind the collector raises.
const SIGNAL_ID = "sg-3f9a1c02";
const SIGNAL_SUBJECT = "/work/reports/report.md";
// The focus a confirmation gives the attempt: the kind and the excerpt of the suspicion, which is what the record of the
// attempt carries instead of a key of its own.
const SIGNAL_FOCUS = `signal:rewritten-draft: turn 1: ${SIGNAL_SUBJECT}`;

// One suspicion as src/signals.ts raises it. The moment is fixed and not the clock of the run: what a confirmation does with
// the value is the subject here, and the identity of a suspicion is the subject of test/unit/signals.test.ts.
function openSuspicion(overrides: Partial<Suspicion> = {}): Suspicion {
  return {
    id: SIGNAL_ID,
    kind: "rewritten-draft",
    createdAt: "2026-11-02T13:00:00.000Z",
    sessionId: SESSION_ID,
    turnIndex: 2,
    subject: SIGNAL_SUBJECT,
    excerpt: `turn 1: ${SIGNAL_SUBJECT}`,
    prompt: "extract the merged-cell table from report.pdf",
    ...overrides,
  };
}

// The collector the confirmation reads, over the list of open suspicions a test declares. `take` records the call instead of
// writing the line, because the line is the subject of test/unit/signals.test.ts: what the command owes here is the id it
// consumes and the skill it names, and `pending` is how a test proves that a run measured nothing consumed nothing.
interface SignalDouble extends SignalCollector {
  taken: { id: string; skill?: string }[];
}

function signalDouble(open: readonly Suspicion[]): SignalDouble {
  const suspicions = [...open];
  const taken: { id: string; skill?: string }[] = [];

  return {
    taken,
    hydrate: async () => {},
    observe: async () => [],
    pending: () => [...suspicions],
    take: (id: string, skill?: string) => {
      const index = suspicions.findIndex((suspicion) => suspicion.id === id);
      if (index === -1) return undefined;

      const [consumed] = suspicions.splice(index, 1);
      taken.push(skill === undefined ? { id } : { id, skill });
      return consumed;
    },
  };
}

// The flag composes with --bank and with nothing else -- not even with the focus, because the focus of a confirmed suspicion is
// the suspicion itself --: every combination that would be two jobs under one invocation is a usage error, and both flags exist
// and do not compose, which the generic sentence of a token the command does not understand would misdescribe.
test("parseSkillImproveArgs: --signal is parsed as itself and refuses every flag it does not compose with", () => {
  assert.deepEqual(parseSkillImproveArgs("pdf-tools --signal=sg-3f9a1c02 --bank=/abs/x.json"), {
    skill: "pdf-tools",
    bankPath: "/abs/x.json",
    signal: "sg-3f9a1c02",
  });
  // The focus of a confirmed suspicion is the suspicion itself (signalFocusOf), so a focus spelled next to the flag would be
  // text the run drops in silence: the parser refuses it and says where a focus of its own belongs instead.
  assert.throws(
    () => parseSkillImproveArgs("pdf-tools merged cells --signal=sg-3f9a1c02"),
    (error: unknown) =>
      error instanceof SriFailClosedError &&
      error.message.includes("--signal=<id>") &&
      error.message.includes("takes no focus"),
  );

  for (const args of [
    "pdf-tools --signal=sg-3f9a1c02 --staged=staging/20261102T140322481Z/pdf-tools",
    "pdf-tools --signal=sg-3f9a1c02 --bank=/abs/x.json --defect",
    "pdf-tools --signal=sg-3f9a1c02 --metrics",
    "pdf-tools --signal=sg-3f9a1c02 --verify",
    "pdf-tools --signal=sg-3f9a1c02 --retire=merged-cells --reason=stale moved",
  ]) {
    assert.throws(() => parseSkillImproveArgs(args), SriFailClosedError);
  }

  // The refusal names the two flags: a confirmation that also retires is two jobs, and the sentence says so instead of
  // naming a missing detail of the retirement.
  assert.throws(
    () => parseSkillImproveArgs("pdf-tools --signal=sg-3f9a1c02 --retire=merged-cells --reason=stale moved"),
    (error: unknown) =>
      error instanceof SriFailClosedError &&
      error.message.includes("--signal=<id>") &&
      error.message.includes("--retire"),
  );

  // A flag whose value is missing or empty names no suspicion, as every other flag of this parser.
  assert.throws(() => parseSkillImproveArgs("pdf-tools --signal"), SriFailClosedError);
  assert.throws(() => parseSkillImproveArgs("pdf-tools --signal="), SriFailClosedError);
});

// The two flags do not compose, so the refusal comes before anything is read: the index is not opened, the inventory and the
// settings are not read, and the suspicion is left exactly as it was.
test("runSkillImprove: --signal with --staged is a usage error and reads nothing", async () => {
  const signals = signalDouble([openSuspicion()]);
  const harness = createHarness({ signals });

  await harness.run(`pdf-tools --signal=${SIGNAL_ID} --staged=${STAGING_RELATIVE}`);

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "error");
  assert.equal(harness.notified[0].message.includes("--signal=<id>"), true);
  assert.equal(harness.notified[0].message.includes("--staged"), true);

  assert.deepEqual(signals.taken, []);
  assert.deepEqual(
    signals.pending().map((suspicion) => suspicion.id),
    [SIGNAL_ID],
  );
  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.directionalRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// The focus of a confirmed suspicion is the suspicion itself, so a text typed after the id would be lost in silence. The parser
// refuses it instead, and the run spends nothing: no generation, no gate of either base, no write, no line of the index and no
// entry -- and the suspicion stays open, because nothing was confirmed.
test("runSkillImprove: --signal with a focus is a usage error and spends nothing", async () => {
  const signals = signalDouble([openSuspicion()]);
  const harness = createHarness({ signals });

  await harness.run(`pdf-tools --signal=${SIGNAL_ID} the appendix moved`);

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "error");
  const refusal = harness.notified[0].message;
  assert.equal(refusal.includes("--signal=<id>"), true);
  assert.equal(refusal.includes("the focus of a confirmed suspicion is the suspicion itself"), true);
  assert.equal(refusal.includes("an attempt without --signal"), true);

  assert.deepEqual(signals.taken, []);
  assert.deepEqual(
    signals.pending().map((suspicion) => suspicion.id),
    [SIGNAL_ID],
  );
  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.completed, []);
  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.directionalRequests, []);
  assert.deepEqual(harness.acceptRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// A usage text is the first answer a user gets to an invocation that is not understood, so it may not publish two things the
// parser refuses together: the syntax line shows the focus and --signal on the same line, and the description says that a run
// cannot have both (M3, S11b). Without the clause, the refusal of the focus reads as a defect of the text that invited it.
test("runSkillImprove: the help names the exclusion between the focus and --signal", async () => {
  const harness = createHarness();

  await harness.run("");

  assert.equal(harness.notified.length, 1);
  const help = harness.notified[0].message;
  // The syntax line still shows the two, and the description of the same answer is what states that they do not compose and
  // why: the focus of a confirmed suspicion is the suspicion itself.
  assert.equal(help.includes("[focus]"), true);
  assert.equal(help.includes("--signal=<id>"), true);
  assert.equal(help.includes("a focus next to --signal is refused instead of dropped"), true);
  assert.equal(help.includes("the focus of a confirmed suspicion is the suspicion itself"), true);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// A suspicion of another session, or one a confirmation already consumed, is not one this run can open an attempt from: the
// answer is the one of src/messages.ts, and it comes before the proposer, the gate of either base and any write.
test("runSkillImprove: --signal with an id no collector holds answers unknown-signal and spends nothing", async () => {
  const signals = signalDouble([]);
  const harness = createHarness({ signals });

  await harness.run(`pdf-tools --signal=${SIGNAL_ID} --bank=${BANK_PATH}`);

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "warning");
  assert.equal(harness.notified[0].message, unknownSignalText(SIGNAL_ID));
  // The sentence says both places a suspicion lives and where the open ones are named, and never that a skill was improved.
  assert.equal(harness.notified[0].message.includes(SIGNAL_ID), true);
  assert.equal(harness.notified[0].message.includes("nothing was spent"), true);

  assert.deepEqual(signals.taken, []);
  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.completed, []);
  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.directionalRequests, []);
  assert.deepEqual(harness.acceptRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// A confirmation without a bank has nothing to measure the attempt against, which is the state of an attempt with no
// baseline: nothing is spent and the suspicion is not consumed. An `--signal` that swallowed the suspicion without measuring
// anything would be worse than no flag at all, which is what this test holds the run to.
test("runSkillImprove: a confirmation that names no bank spends nothing and leaves the suspicion open", async () => {
  const signals = signalDouble([openSuspicion()]);
  const harness = createHarness({ signals });

  await harness.run(`pdf-tools --signal=${SIGNAL_ID}`);

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "warning");
  const report = harness.notified[0].message;
  assert.equal(report.includes(SIGNAL_ID), true);
  assert.equal(report.includes("--bank=<path>"), true);
  assert.equal(report.includes("nothing was spent"), true);
  assert.equal(report.includes("stays open"), true);

  // The suspicion was resolved and not consumed, so the same confirmation can be given again with a bank.
  assert.deepEqual(signals.taken, []);
  assert.deepEqual(
    signals.pending().map((suspicion) => suspicion.id),
    [SIGNAL_ID],
  );
  // And nothing of the loop ran: no generation, no gate of either base, no candidate, no line of the index, no entry.
  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.completed, []);
  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.directionalRequests, []);
  assert.deepEqual(harness.acceptRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// The confirmation with a bank is the directional attempt the package already had: the suspicion contributes the focus, the
// bank the expectation, and the gate that measures the candidate is the one of the bank base. The record keeps the suspicion
// in the field it already carries, and the id is consumed with the skill the attempt was opened for.
test("runSkillImprove: --signal --bank opens the directional attempt with the suspicion as its focus", async () => {
  const signals = signalDouble([openSuspicion()]);
  const harness = createHarness({ signals, model: MODEL });

  await harness.run(`pdf-tools --signal=${SIGNAL_ID} --bank=${BANK_PATH}`);

  // The proposal is written from the bank and carries the focus of the suspicion, which is what the record of the attempt
  // and its line of the index describe.
  assert.equal(harness.proposals.length, 1);
  assert.equal(harness.proposals[0].input.focus, SIGNAL_FOCUS);
  assert.equal(harness.proposals[0].input.basis, "case-bank");
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].decision.trigger.focus, SIGNAL_FOCUS);

  // The gate of the run is the one of the bank base, pointed at the same bank, and the replay flow of M1 was never asked.
  assert.deepEqual(harness.gateRequests, []);
  assert.equal(harness.directionalRequests.length, 1);
  assert.equal(harness.directionalRequests[0].bankPath, BANK_PATH);
  assert.equal(harness.directionalRequests[0].stagingPath, STAGING_RELATIVE);

  // The suspicion was consumed with the skill of the attempt, and it is closed: a second confirmation of the same id is the
  // `unknown-signal` above.
  assert.deepEqual(signals.taken, [{ id: SIGNAL_ID, skill: "pdf-tools" }]);
  assert.deepEqual(signals.pending(), []);

  // The candidate is in staging and the bank this fixture names is not there, so the last report is that state of the
  // attempt: it spent nothing and left the candidate retryable.
  const answer = harness.notified.at(-1);
  assert.equal(answer?.type, "warning");
  assert.equal(answer?.message.includes("no baseline"), true);
  assert.equal(answer?.message.includes(STAGING_RELATIVE), true);
});

// A session without a collector is a session with no suspicion to confirm, and the answer says so with the id: the run was
// handed no memory of the suspicions, so nothing of it can be opened and nothing is spent.
test("runSkillImprove: a session without a collector answers unknown-signal and spends nothing", async () => {
  const harness = createHarness();

  await harness.run(`pdf-tools --signal=${SIGNAL_ID} --bank=${BANK_PATH}`);

  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "warning");
  assert.equal(harness.notified[0].message, unknownSignalText(SIGNAL_ID));

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.completed, []);
  assert.deepEqual(harness.directionalRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});
