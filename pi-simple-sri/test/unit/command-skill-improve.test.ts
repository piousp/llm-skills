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
import { acceptCandidate, type AcceptDeps, type AcceptRequest } from "../../src/gate/acceptance.ts";
import type { GateFlowResult, GateRequest } from "../../src/gate/flow.ts";
import { serializeLesson } from "../../src/lesson-frontmatter.ts";
import { ATTEMPTS_FILE, DECISION_FILE, HISTORY_DIR, LESSONS_DIR, SKILL_FILE } from "../../src/names.ts";
import { PROPOSAL_MAX_TOKENS, ProposerError } from "../../src/proposer.ts";
import { countReferenceLines } from "../../src/skill-reference.ts";
import type { AttemptLine, DecisionRecord, LessonDraft, SkillRef, SriConfig } from "../../src/types.ts";
import { sha256Digest } from "../../src/hash.ts";
import { stateDir } from "../../src/write-base.ts";
import { SriWriterError, type StagingWriteInput, type StagingWriteResult } from "../../src/writer.ts";

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
  // The gate and the acceptance the chain runs. The gate defaults to an abstention that writes nothing; the
  // acceptance defaults to the real one, so a test that wants it records what it wrote instead of a double.
  gate?: (request: GateRequest) => Promise<GateFlowResult>;
  accept?: typeof acceptCandidate;
  acceptDeps?: AcceptDeps;
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
  acceptRequests: AcceptRequest[];
  run: (args: string) => Promise<void>;
}

// The lesson a successful generation produces. It is built from the evidence the command handed
// over, so the draft's source-evidence follows the input instead of a hardcoded list.
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

function successfulProposer(proposals: Harness["proposals"]): ProposeFn {
  return async (input) => {
    proposals.push({ input });
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
  const acceptRequests: AcceptRequest[] = [];

  const modelRegistry: SkillImproveModelRegistry = {
    complete: async (model, context, request) => {
      completed.push({ model, context, maxTokens: request?.maxTokens, sessionId: request?.sessionId });
      return assistantMessage(options.reply ?? REPLY);
    },
  };

  const ctx: SkillImproveContext = {
    cwd: CWD,
    hasUI: options.hasUI ?? true,
    model: options.model,
    sessionManager: { getBranch: () => [...(options.branch ?? failingBranch())], getSessionId: () => SESSION_ID },
    modelRegistry,
    ui: {
      notify: (message, type) => {
        notified.push({ message, type: type ?? "info" });
      },
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

  const accept: typeof acceptCandidate = async (request, acceptDeps) => {
    acceptRequests.push(request);
    return await (options.accept ?? acceptCandidate)(request, acceptDeps);
  };

  const deps: SkillImproveDeps = {
    now: () => NOW,
    agentDir: AGENT_DIR,
    readConfig: () => options.config ?? { allow: [], deny: [] },
    listSkills: async () => [...(options.skills ?? [SKILL])],
    readSkillText: async () => SKILL_TEXT,
    write,
    appendAttempt: async (base, line) => {
      attemptBases.push(base);
      attempts.push(line);
    },
    base,
    gate,
    accept,
    ...(options.acceptDeps === undefined ? {} : { acceptDeps: options.acceptDeps }),
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
    ...(options.useRealProposer === true ? {} : { propose: options.propose ?? successfulProposer(proposals) }),
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
    acceptRequests,
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
  assert.equal(harness.notified[0].message.includes("pdf-tools: Extract tables from PDFs"), true);
  // The list is the eligible one: the deny list removes a skill from the offer, not just from
  // generation.
  assert.equal(harness.notified[0].message.includes("system-config"), false);

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.completed, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
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
  assert.equal(message.includes("pdf-tools: Extract tables from PDFs"), true);
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

// --- the chain of M1: propose, gate, accept ---

// The candidate of the accepting test: one fixed draft, so the lesson text and its hash are known before the run and
// the fixture can declare them in the record the gate would have written.
const FIXED_DRAFT: LessonDraft = {
  slug: LESSON_SLUG,
  title: LESSON_TITLE,
  date: "2026-11-02",
  status: "proposed",
  sourceEvidence: ["ev-3f9a1c02"],
  gate: "pending",
  body: LESSON_BODY,
};

const FAILURE_SIGNATURE = `sha256:${"c".repeat(64)}`;
// 2026-11-02T14:03:22.481Z in the spelling src/writer.ts gives a history snapshot: UTC, no separators.
const TIMESTAMP = "20261102T140322481Z";

function fixedLessonText(): string {
  const lesson = serializeLesson(FIXED_DRAFT);
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
