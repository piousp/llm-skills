import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Value } from "typebox/value";
import type { AgentToolResult, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ToolCall,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  ENTRY_TYPE,
  type ImproveFlowContext,
  type ImproveFlowModelRegistry,
  type ImprovementEntry,
  type ProposeFn,
} from "../../src/improve-flow.ts";
import type { GateDeps, GateFlowResult, GateRequest } from "../../src/gate/flow.ts";
import type { ReplayRunRequest } from "../../src/gate/types.ts";
import { serializeLesson } from "../../src/lesson-frontmatter.ts";
import { PROPOSAL_MAX_TOKENS, ProposerError } from "../../src/proposer.ts";
import {
  createSkillImproveTool,
  runSkillImproveTool,
  SKILL_IMPROVE_TOOL_NAME,
  skillImproveParams,
  type SkillImproveParams,
  type SkillImproveToolDeps,
  type ToolDetails,
} from "../../src/tool-skill-improve.ts";
import type { AttemptLine, LessonDraft, SkillRef, SriConfig } from "../../src/types.ts";
import { SriWriterError, type StagingWriteInput, type StagingWriteResult } from "../../src/writer.ts";

// The tool is exercised end to end with doubles: one fake flow context, one fake model registry and
// one fake per seam. Nothing here reads the settings file, walks a skill directory, reaches a
// provider or writes a byte: the writer, the index and the session entry are recorders, so every
// assertion below is about what the tool answered and what the flow decided, not about the disk.
//
// The body of execute is called through runSkillImproveTool, the exported seam, the same way the
// command test calls runSkillImprove: the alternative is a fake ExtensionToolContext with four
// dozen UI methods that would prove nothing about this module.

const NOW = new Date("2026-11-02T14:03:22.481Z");
const NOW_ISO = "2026-11-02T14:03:22.481Z";
const CWD = "/work/reports";
// The agent directory the harness hands over: the gate request carries it, so a constant keeps the expected
// object of the gate request stable.
const AGENT_DIR = "/agent";
// The base of the run: the bytes land under <base>/staging and every record names them relative to it.
const BASE = "/pkg";
const STAGING_PATH = "/pkg/staging/20261102T140322481Z/pdf-tools";
const DECISION_PATH = `${STAGING_PATH}/decision.json`;
const STAGING_RELATIVE = "staging/20261102T140322481Z/pdf-tools";
const DECISION_RELATIVE = `${STAGING_RELATIVE}/decision.json`;
const CONTENT_HASH = `sha256:${"a".repeat(64)}`;
const BODY_HASH = `sha256:${"b".repeat(64)}`;

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

// A chat model the tool only forwards to the registry, so the fields are the ones a registry read
// would answer with.
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

const SKILL: SkillRef = {
  name: "pdf-tools",
  description: "Extract tables from PDFs",
  dir: "/skills/pdf-tools",
  realDir: "/skills/pdf-tools",
  hasLessons: false,
  kind: "declared",
};

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

// Session entries are literals, as in test/unit/command-skill-improve.test.ts: the flow only reads
// the message, its timestamp and its tool calls.
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

interface EntryCall {
  customType: string;
  data: ImprovementEntry;
}

interface CompletedCall {
  model: Model<Api>;
  context: Context;
  maxTokens: number | undefined;
  signal: AbortSignal | undefined;
}

interface HarnessOptions {
  branch?: readonly SessionEntry[];
  config?: SriConfig;
  skills?: readonly SkillRef[];
  model?: Model<Api>;
  propose?: ProposeFn;
  useRealProposer?: boolean;
  writeFailure?: Error;
  entryFailure?: Error;
  // The gate the action runs, and the seams of the real one, which is what a test uses when it wants the
  // candidate resolution of src/gate/flow.ts instead of a verdict.
  gate?: (request: GateRequest) => Promise<GateFlowResult>;
  gateDeps?: GateDeps;
  useRealGate?: boolean;
}

interface Harness {
  deps: SkillImproveToolDeps;
  entries: EntryCall[];
  attempts: AttemptLine[];
  attemptBases: string[];
  writes: StagingWriteInput[];
  proposals: { input: Parameters<ProposeFn>[0] }[];
  completed: CompletedCall[];
  gateRequests: GateRequest[];
  run: (params: SkillImproveParams, signal?: AbortSignal) => Promise<AgentToolResult<ToolDetails>>;
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
  const entries: EntryCall[] = [];
  const attempts: AttemptLine[] = [];
  const attemptBases: string[] = [];
  const writes: StagingWriteInput[] = [];
  const proposals: Harness["proposals"] = [];
  const completed: CompletedCall[] = [];
  const gateRequests: GateRequest[] = [];

  const modelRegistry: ImproveFlowModelRegistry = {
    complete: async (model, context, request) => {
      completed.push({ model, context, maxTokens: request?.maxTokens, signal: request?.signal });
      return assistantMessage(REPLY);
    },
  };

  const ctx: ImproveFlowContext = {
    cwd: CWD,
    model: options.model,
    modelRegistry,
    sessionManager: {
      getBranch: () => [...(options.branch ?? failingBranch())],
      getSessionId: () => "session-test",
    },
  };

  const write = async (input: StagingWriteInput): Promise<StagingWriteResult> => {
    if (options.writeFailure !== undefined) throw options.writeFailure;
    writes.push(input);
    return {
      stagingPath: STAGING_PATH,
      lessonPath: `${STAGING_PATH}/lessons/${LESSON_SLUG}.md`,
      decisionPath: DECISION_PATH,
      contentHash: CONTENT_HASH,
      bodyHash: BODY_HASH,
    };
  };

  const deps: SkillImproveToolDeps = {
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
    base: BASE,
    // The gate of the run: the one a test names, or the real one when the test is about the candidate
    // resolution. The default concludes nothing, so a test that does not say which verdict it wants gets the
    // one that writes nothing.
    gate:
      options.useRealGate === true
        ? undefined
        : async (request: GateRequest): Promise<GateFlowResult> => {
            gateRequests.push(request);
            if (options.gate !== undefined) return await options.gate(request);
            return {
              kind: "gate-abstained",
              reason: "insufficient-items",
              stagingPath: request.stagingPath,
              decisionPath: path.join(request.stagingPath, "decision.json"),
              plannedRuns: 0,
              usedRuns: 0,
              overlays: null,
            };
          },
    appendEntry: (customType: string, data: ImprovementEntry) => {
      if (options.entryFailure !== undefined) throw options.entryFailure;
      entries.push({ customType, data });
    },
    ...(options.gateDeps === undefined ? {} : { gateDeps: options.gateDeps }),
    ...(options.useRealProposer === true
      ? {}
      : { propose: options.propose ?? successfulProposer(proposals) }),
  };

  return {
    deps,
    entries,
    attempts,
    attemptBases,
    writes,
    proposals,
    completed,
    gateRequests,
    run: (params, signal) => runSkillImproveTool(params, ctx, deps, signal),
  };
}

// The single text part of the answer, so the assertions below read as the sentence the model would
// read: a result with no text part is a bug in this module and fails here.
function textOf(result: AgentToolResult<ToolDetails>): string {
  const part = result.content.at(0);
  assert.ok(part !== undefined && part.type === "text", "the tool must answer with a text part");
  return part.text;
}

// Rule 1 of P9: the schema refuses an action the tool does not run and a call with no skill, and
// the focus stays optional.
test("skillImproveParams: an action outside the three the tool runs is rejected", () => {
  assert.equal(Value.Check(skillImproveParams, { action: "apply", skill: "pdf-tools" }), false);
  assert.equal(Value.Check(skillImproveParams, { action: "accept", skill: "pdf-tools" }), false);
});

// Amendment 3 of S10: gate identifies the candidate the call is about, and typebox has no conditional, so the
// schema accepts a gate with no stagingPath and the action refuses it in code.
test("skillImproveParams: gate is an action and its stagingPath is a string the schema keeps optional", () => {
  assert.equal(Value.Check(skillImproveParams, { action: "gate", skill: "pdf-tools" }), true);
  assert.equal(
    Value.Check(skillImproveParams, { action: "gate", skill: "pdf-tools", stagingPath: STAGING_RELATIVE }),
    true,
  );
  assert.equal(Value.Check(skillImproveParams, { action: "gate", skill: "pdf-tools", stagingPath: 7 }), false);
});

test("skillImproveParams: the skill name is required", () => {
  assert.equal(Value.Check(skillImproveParams, { action: "diagnose" }), false);
  assert.equal(Value.Check(skillImproveParams, { action: "propose", skill: 7 }), false);
});

test("skillImproveParams: the focus is optional and every action is accepted", () => {
  assert.equal(Value.Check(skillImproveParams, { action: "diagnose", skill: "pdf-tools" }), true);
  assert.equal(
    Value.Check(skillImproveParams, { action: "propose", skill: "pdf-tools", focus: "merged cells" }),
    true,
  );
  assert.equal(Value.Check(skillImproveParams, { action: "propose", skill: "pdf-tools", focus: 7 }), false);
});

// Rule 3: the description travels in every session that loads the tool, so it has to say that the
// tool neither edits the skill nor accepts a candidate.
test("createSkillImproveTool: the definition carries the schema and the promise of not editing the skill", () => {
  const tool = createSkillImproveTool({ base: BASE });

  assert.equal(tool.name, SKILL_IMPROVE_TOOL_NAME);
  assert.equal(SKILL_IMPROVE_TOOL_NAME, "skill_improve");
  assert.equal(tool.parameters, skillImproveParams);
  assert.equal(typeof tool.execute, "function");
  assert.equal(tool.description.includes("never edits the skill"), true);
  assert.equal(tool.description.includes("never accepts a candidate"), true);
  assert.equal(tool.description.includes("/skill-improve"), true);
  // M1: the third action is declared where the model reads it, together with the tokens it spends.
  assert.equal(tool.description.includes("gate"), true);
  assert.equal(tool.description.includes("spends tokens"), true);
});

// Rule 1: diagnose is read-only. No model, no staging, no index line, no session entry.
test("diagnose: a diagnosis writes nothing and records no session entry", async () => {
  const harness = createHarness();

  const result = await harness.run({ action: "diagnose", skill: "pdf-tools" });

  assert.equal(result.isError, undefined);
  assert.equal(harness.completed.length, 0);
  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

test("diagnose: the answer names the failure, its signature and the expectation of every replay item", async () => {
  const harness = createHarness();

  const result = await harness.run({ action: "diagnose", skill: "pdf-tools" });

  const text = textOf(result);
  assert.equal(text.includes('skill "pdf-tools" is eligible'), true);
  assert.equal(text.includes("diagnosis: Observed 1 tool error in this session"), true);
  assert.match(text, /failure signature: sha256:[0-9a-f]{64}/);
  assert.equal(text.includes("replay items: 1"), true);
  assert.equal(text.includes("- the tool bash does not return an error again"), true);
  // The proposal did not run, and the answer says so: diagnose reports, it does not stage.
  assert.equal(text.includes("No candidate was proposed"), true);

  // Rule 6: the documented shape, and no usage because no model was called (rule 5).
  assert.deepEqual(result.details, { action: "diagnose", skill: "pdf-tools", outcome: "diagnosed" });
  assert.equal(Object.hasOwn(result.details, "usage"), false);
});

test("diagnose: a session without failures is an error with its reason and its sentence", async () => {
  const harness = createHarness({ branch: [] });

  const result = await harness.run({ action: "diagnose", skill: "pdf-tools" });

  assert.equal(result.isError, true);
  assert.deepEqual(result.details, {
    action: "diagnose",
    skill: "pdf-tools",
    outcome: "no-evidence",
    reason: "no-evidence",
  });
  // Rule 1 of P9: the refusal says that nothing was written, and not only that the call failed: the
  // model reads this sentence, so it is the reason it acts on.
  assert.equal(
    textOf(result),
    'skill "pdf-tools": this session shows no failure to diagnose, and nothing was written.',
  );
  assert.equal(harness.completed.length, 0);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

test("diagnose: an unknown skill is an error and nothing is read", async () => {
  const harness = createHarness();

  const result = await harness.run({ action: "diagnose", skill: "no-such-skill" });

  assert.equal(result.isError, true);
  assert.deepEqual(result.details, {
    action: "diagnose",
    skill: "no-such-skill",
    outcome: "unknown-skill",
    reason: "unknown-skill",
  });
  assert.equal(textOf(result).includes('No skill named "no-such-skill"'), true);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.entries, []);
});

test("propose: the happy path stages the lesson, the entry and the index line", async () => {
  const harness = createHarness();

  const result = await harness.run({ action: "propose", skill: "pdf-tools", focus: "merged cells" });

  assert.equal(result.isError, undefined);

  assert.equal(harness.writes.length, 1);
  const [write] = harness.writes;
  assert.equal(write.base, BASE);
  assert.equal(write.slug, LESSON_SLUG);
  // The record says which surface asked: a candidate the tool staged never claims to be a command.
  assert.deepEqual(write.decision.trigger, { surface: "tool", focus: "merged cells" });

  assert.deepEqual(harness.attemptBases, [BASE]);
  assert.deepEqual(harness.attempts, [
    {
      ts: NOW_ISO,
      event: "proposed",
      candidateHash: CONTENT_HASH,
      bodyHash: BODY_HASH,
      // OA4: the line names the failure the diagnosis of the record names.
      failureSignature: write.decision.diagnosis.failureSignature,
      targetSkill: "pdf-tools",
      stagingPath: STAGING_RELATIVE,
      decisionPath: DECISION_RELATIVE,
    },
  ]);

  assert.deepEqual(harness.entries, [
    {
      customType: ENTRY_TYPE,
      data: {
        surface: "tool",
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

  // Rule 5: the usage of the generation is visible where the call was made.
  assert.deepEqual(result.details, {
    action: "propose",
    skill: "pdf-tools",
    outcome: "proposed",
    base: BASE,
    stagingPath: STAGING_RELATIVE,
    decisionPath: DECISION_RELATIVE,
    usage: { input: 412, output: 137 },
  });
  assert.equal(textOf(result).includes(STAGING_PATH), true);
});

// Q17: eligibility is checked before the model is called, so an ineligible skill spends no
// generation; the attempt is still recorded, as the command records it.
test("propose: an ineligible skill is refused before the model is called", async () => {
  const harness = createHarness({ config: { allow: [], deny: ["pdf-tools"] } });

  const result = await harness.run({ action: "propose", skill: "pdf-tools" });

  assert.equal(result.isError, true);
  assert.deepEqual(result.details, {
    action: "propose",
    skill: "pdf-tools",
    outcome: "not-eligible",
    reason: "not-eligible",
  });

  assert.deepEqual(harness.proposals, []);
  assert.equal(harness.completed.length, 0);
  assert.deepEqual(harness.writes, []);
  // The refusal leaves its own line: an ineligible skill spent no generation, and the index still says
  // the run happened.
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.attempts[0].event, "not-eligible");
  assert.equal(harness.attempts[0].targetSkill, "pdf-tools");
  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0].data.outcome, "not-eligible");
});

test("propose: an unknown skill is refused before anything is read from disk", async () => {
  const harness = createHarness();

  const result = await harness.run({ action: "propose", skill: "no-such-skill" });

  assert.equal(result.isError, true);
  assert.deepEqual(result.details, {
    action: "propose",
    skill: "no-such-skill",
    outcome: "unknown-skill",
    reason: "unknown-skill",
  });

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

test("propose: a refused proposal is an error with the reason and nothing is staged", async () => {
  const reason = 'the model stopped with "length" instead of finishing the lesson';
  const harness = createHarness({
    propose: async () => ({ ok: false, error: new ProposerError(reason) }),
  });

  const result = await harness.run({ action: "propose", skill: "pdf-tools" });

  assert.equal(result.isError, true);
  assert.equal(result.details.outcome, "error");
  assert.equal(result.details.reason, reason);
  assert.equal(textOf(result).includes(reason), true);

  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0].data.outcome, "error");
  assert.equal(harness.entries[0].data.reason, reason);
});

// Rule 4: a write the perimeter refuses is a tool result, not an exception.
test("propose: a writer refusal is an error result and not an exception", async () => {
  const harness = createHarness({
    writeFailure: new SriWriterError('refusing to write "/elsewhere": outside every root', "/elsewhere"),
  });

  const result = await harness.run({ action: "propose", skill: "pdf-tools" });

  assert.equal(result.isError, true);
  assert.equal(result.details.outcome, "error");
  assert.equal(result.details.reason?.includes("outside every root"), true);
  assert.equal(textOf(result).includes("outside every root"), true);

  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

// Rule 4 is unconditional: a bug in the flow is answered too, because a thrown error would lose the
// details and leave the model without a reason.
test("propose: a bug in the flow is answered with isError instead of throwing", async () => {
  const harness = createHarness({ writeFailure: new TypeError("boom") });

  const result = await harness.run({ action: "propose", skill: "pdf-tools" });

  assert.equal(result.isError, true);
  assert.equal(result.details.outcome, "error");
  assert.equal(result.details.reason, "boom");
});

test("propose: without a model it stops before anything is staged", async () => {
  const harness = createHarness({ useRealProposer: true });

  const result = await harness.run({ action: "propose", skill: "pdf-tools" });

  assert.equal(result.isError, true);
  assert.deepEqual(result.details, {
    action: "propose",
    skill: "pdf-tools",
    outcome: "no-model",
    reason: "no-model",
  });

  assert.equal(harness.completed.length, 0);
  assert.deepEqual(harness.writes, []);
  // Nothing was staged, and the attempt is in the index under its own event.
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.attempts[0].event, "no-model");
  assert.deepEqual(harness.entries, []);
});

// Rule 5 again, from the other side: with a model the real proposer calls it once, with the budget
// of the proposer and the model of the session pinned on the diagnosis (Q13).
test("propose: the real proposer calls the session model with the token budget", async () => {
  const harness = createHarness({ model: MODEL, useRealProposer: true });

  const result = await harness.run({ action: "propose", skill: "pdf-tools" });

  assert.equal(result.isError, undefined);
  assert.equal(harness.completed.length, 1);
  assert.deepEqual(harness.completed[0].model, MODEL);
  assert.equal(harness.completed[0].maxTokens, PROPOSAL_MAX_TOKENS);

  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].decision.diagnosis.replayItems[0].model, `${MODEL.provider}/${MODEL.id}`);
  assert.equal(harness.writes[0].decision.candidate.slug, LESSON_SLUG);
  assert.deepEqual(result.details.usage, { input: 412, output: 137 });
});

// F2: the session entry is the /tree view of an attempt whose record is the candidate and its index
// line. A channel that throws costs the view and nothing else: the outcome stays the candidate's, with
// its paths and its usage, and the answer says in words that the entry is missing.
test("propose: an entry channel that throws does not turn a staged candidate into an error", async () => {
  const harness = createHarness({
    entryFailure: new Error('EACCES: permission denied, open "session.jsonl"'),
  });

  const result = await harness.run({ action: "propose", skill: "pdf-tools", focus: "merged cells" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details, {
    action: "propose",
    skill: "pdf-tools",
    outcome: "proposed",
    base: BASE,
    stagingPath: STAGING_RELATIVE,
    decisionPath: DECISION_RELATIVE,
    usage: { input: 412, output: 137 },
  });

  const text = textOf(result);
  assert.equal(text.includes(STAGING_PATH), true);
  assert.equal(text.includes("the session entry was not recorded"), true);
  assert.equal(text.includes("EACCES"), true);

  assert.equal(harness.writes.length, 1);
  assert.equal(harness.attempts.length, 1);
  assert.deepEqual(harness.entries, []);
});

// F6: a standalone .md is a skill the inventory knows and a directory it does not have, so the answer
// has to say that instead of claiming the name is unknown.
const STANDALONE_SKILL: SkillRef = {
  name: "standalone-notes",
  description: "Loose notes",
  dir: "/skills",
  realDir: "/skills",
  hasLessons: false,
  kind: "standalone",
};

for (const action of ["diagnose", "propose"] as const) {
  test(`${action}: a standalone skill is reported as existing but not improvable`, async () => {
    const harness = createHarness({ skills: [SKILL, STANDALONE_SKILL] });

    const result = await harness.run({ action, skill: "standalone-notes" });

    assert.equal(result.isError, true);
    assert.equal(result.details.outcome, "unknown-skill");
    const text = textOf(result);
    assert.equal(text.includes("exists"), true);
    assert.equal(text.includes("standalone"), true);
    assert.equal(text.includes("No skill named"), false);
    // The offer is the eligible set, which never includes a standalone skill.
    assert.equal(text.includes("Eligible skills: pdf-tools."), true);

    assert.deepEqual(harness.writes, []);
    assert.deepEqual(harness.attempts, []);
  });
}

// F7: the signal pi aborts a tool call with travels to the one model call of the run, so a cancellation
// reaches the provider instead of being dropped at the edge of the tool.
test("propose: the abort signal of the call reaches the model", async () => {
  const harness = createHarness({ model: MODEL, useRealProposer: true });
  const controller = new AbortController();

  const result = await harness.run({ action: "propose", skill: "pdf-tools" }, controller.signal);

  assert.equal(result.isError, undefined);
  assert.equal(harness.completed.length, 1);
  assert.equal(harness.completed[0].signal, controller.signal);
});

// A signal aborted before the call is a generation nobody waits for: no staging, no index line, and the
// refusal the proposer raised is the outcome.
test("propose: an already aborted signal stages nothing and records no index line", async () => {
  const harness = createHarness({ model: MODEL, useRealProposer: true });
  const controller = new AbortController();
  controller.abort();

  const result = await harness.run({ action: "propose", skill: "pdf-tools" }, controller.signal);

  assert.equal(result.isError, true);
  assert.equal(result.details.outcome, "error");
  assert.equal(result.details.reason?.includes("aborted"), true);
  assert.equal(textOf(result).includes("aborted"), true);

  assert.equal(harness.completed.length, 0);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  // The attempt happened and its reason is part of the audit trail of the session.
  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0].data.outcome, "error");
});

// The flow answers no-evidence before a generation is reachable, and the tool reports it as a refusal
// with the sentence of a session that showed nothing; the attempt is recorded as the command records it.
test("propose: a session without failures is an error with its reason and its sentence", async () => {
  const harness = createHarness({ branch: [] });

  const result = await harness.run({ action: "propose", skill: "pdf-tools" });

  assert.equal(result.isError, true);
  assert.deepEqual(result.details, {
    action: "propose",
    skill: "pdf-tools",
    outcome: "no-evidence",
    reason: "no-evidence",
  });
  assert.equal(
    textOf(result),
    'skill "pdf-tools": this session shows no failure to learn from, so no candidate was generated.',
  );

  assert.deepEqual(harness.proposals, []);
  assert.deepEqual(harness.writes, []);
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.attempts[0].event, "no-evidence");
  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0].data.outcome, "no-evidence");
});

// The one focus rule from the surface that can send a blank one: the schema accepts "focus": "   ", and
// a blank focus is no focus, so the record and the entry spell it the way an absent one is spelled.
test("propose: a blank focus is no focus in the record and in the entry", async () => {
  const harness = createHarness();

  const result = await harness.run({ action: "propose", skill: "pdf-tools", focus: "   " });

  assert.equal(result.isError, undefined);
  assert.equal(harness.writes.length, 1);
  assert.deepEqual(harness.writes[0].decision.trigger, { surface: "tool", focus: null });
  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0].data.focus, null);
});

// The gate over a staged candidate (M1): the verdict the gate answered, the budget it cost and the two paths of the
// candidate travel in details, and nothing of the run touches the skill -- the tool never accepts (Q12). The gate is
// a double here, because the verdicts and the guards of a candidate belong to src/gate/flow.ts; the real one is
// driven by the two tests below.
test("gate: a staged candidate is gated and the answer carries the verdict and the budget", async () => {
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
  });

  const result = await harness.run({ action: "gate", skill: "pdf-tools", stagingPath: STAGING_RELATIVE });

  assert.equal(result.isError, true);
  assert.deepEqual(result.details, {
    action: "gate",
    skill: "pdf-tools",
    outcome: "gate-rejected",
    verdict: "gate-rejected",
    reason: "below-threshold",
    base: BASE,
    stagingPath: STAGING_RELATIVE,
    decisionPath: DECISION_RELATIVE,
    gatePath: path.join(STAGING_RELATIVE, "gate"),
    plannedRuns: 4,
    usedRuns: 4,
  });

  const text = textOf(result);
  assert.equal(text.includes("below-threshold"), true);
  assert.equal(text.includes("the skill is untouched"), true);

  // The request names the candidate of the call and the skill the inventory resolved, under the base and the
  // agent directory of the run, in the directory of the session.
  assert.equal(harness.gateRequests.length, 1);
  assert.deepEqual(harness.gateRequests[0], {
    base: BASE,
    agentDir: AGENT_DIR,
    cwd: CWD,
    stagingPath: STAGING_RELATIVE,
    skill: SKILL,
  });

  // Nothing of this action writes: no candidate, no index line, no entry.
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.entries, []);
});

test("gate: a gate that passes is not an error and says the candidate was not accepted", async () => {
  const harness = createHarness({
    gate: async () => ({
      kind: "gate-accepted",
      reason: null,
      stagingPath: STAGING_RELATIVE,
      decisionPath: DECISION_RELATIVE,
      plannedRuns: 2,
      usedRuns: 2,
      overlays: null,
    }),
  });

  const result = await harness.run({ action: "gate", skill: "pdf-tools", stagingPath: STAGING_RELATIVE });

  // A verdict is an answer: the call succeeded and the candidate stays in staging.
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details, {
    action: "gate",
    skill: "pdf-tools",
    outcome: "gate-accepted",
    verdict: "gate-accepted",
    base: BASE,
    stagingPath: STAGING_RELATIVE,
    decisionPath: DECISION_RELATIVE,
    gatePath: path.join(STAGING_RELATIVE, "gate"),
    plannedRuns: 2,
    usedRuns: 2,
  });
  assert.equal(Object.hasOwn(result.details, "reason"), false);

  const text = textOf(result);
  assert.equal(text.includes("passed after 2 runs of the 2 it planned"), true);
  assert.equal(text.includes("the candidate is not accepted"), true);

  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.entries, []);
});

// Amendment 3 of S10: the one rule the schema cannot express. The refusal happens before the first read, so the
// gate is never asked for anything and the details keep the keys of every other error of this action.
test("gate: without a stagingPath the call is refused before the gate is reached", async () => {
  const harness = createHarness();

  const result = await harness.run({ action: "gate", skill: "pdf-tools" });

  assert.equal(result.isError, true);
  assert.deepEqual(result.details, {
    action: "gate",
    skill: "pdf-tools",
    outcome: "error",
    reason: "missing-staging-path",
  });
  assert.equal(textOf(result).includes("stagingPath"), true);
  assert.equal(textOf(result).includes("no run was spent"), true);

  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.entries, []);
});

// A name the inventory does not know is refused before the gate is asked for anything, with the same sentence the
// other two actions answer with.
test("gate: a name the inventory does not know is refused before the gate is asked", async () => {
  const harness = createHarness({ skills: [SKILL, STANDALONE_SKILL] });

  const result = await harness.run({ action: "gate", skill: "ghost-skill", stagingPath: STAGING_RELATIVE });

  assert.equal(result.isError, true);
  assert.deepEqual(result.details, {
    action: "gate",
    skill: "ghost-skill",
    outcome: "unknown-skill",
    reason: "unknown-skill",
  });
  assert.equal(textOf(result).includes('No skill named "ghost-skill"'), true);
  assert.equal(textOf(result).includes("Eligible skills: pdf-tools."), true);

  assert.deepEqual(harness.gateRequests, []);
  assert.deepEqual(harness.writes, []);
});

// The guard of src/gate/flow.ts, reached through the real gate and not a double: a candidate this package did
// not stage is refused before a byte is read and before a run is spent.
test("gate: a stagingPath outside staging/ is refused before a run is spent", async () => {
  const runs: ReplayRunRequest[] = [];
  const harness = createHarness({
    useRealGate: true,
    gateDeps: {
      runReplay: async (request) => {
        runs.push(request);
        throw new Error("the gate must not start a run over a candidate outside staging/");
      },
    },
  });

  const result = await harness.run({ action: "gate", skill: "pdf-tools", stagingPath: "/elsewhere/pdf-tools" });

  assert.equal(result.isError, true);
  assert.deepEqual(result.details, {
    action: "gate",
    skill: "pdf-tools",
    outcome: "error",
    reason: "outside-staging",
  });
  assert.equal(textOf(result).includes("/elsewhere/pdf-tools"), true);

  assert.deepEqual(runs, []);
  assert.deepEqual(harness.attempts, []);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.entries, []);
});

// Q12, from the side of the seams: no action of this tool can accept, because the dependencies it receives hold
// no seam that writes a skill and the module exports no entry point that would.
test("gate: no action of the tool accepts a candidate", async () => {
  const harness = createHarness({
    gate: async () => ({
      kind: "gate-accepted",
      reason: null,
      stagingPath: STAGING_RELATIVE,
      decisionPath: DECISION_RELATIVE,
      plannedRuns: 2,
      usedRuns: 2,
      overlays: null,
    }),
  });

  const result = await harness.run({ action: "gate", skill: "pdf-tools", stagingPath: STAGING_RELATIVE });

  assert.equal(result.isError, undefined);
  assert.equal(Object.hasOwn(harness.deps, "accept"), false);

  // The runtime exports of the module, in full: the schema, the factory, the body of execute and the name.
  const toolModule = await import("../../src/tool-skill-improve.ts");
  assert.deepEqual(Object.keys(toolModule).sort(), [
    "SKILL_IMPROVE_TOOL_NAME",
    "createSkillImproveTool",
    "runSkillImproveTool",
    "skillImproveParams",
  ]);

  // And a gate that passed left the skill alone: no write of any kind happened.
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.attempts, []);
});
