import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, AssistantMessage, Context, Model, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CASE_BANK_FORMAT } from "../../src/case-bank.ts";
import { ProposerError, SriPerimeterError, SriWriterError } from "../../src/errors.ts";
import { planDesign, planGate } from "../../src/gate/scorer.ts";
import {
  buildDecision,
  proposeSkill,
  type DecisionInput,
  type ImproveFlowContext,
  type ImproveFlowDeps,
  type ProposeFlowResult,
  type ProposeFn,
} from "../../src/improve-flow.ts";
import { createProposer, type CompleteFn } from "../../src/proposer.ts";
import { serializeLesson } from "../../src/lesson-frontmatter.ts";
import { ATTEMPTS_FILE, DECISION_FILE, LESSONS_DIR } from "../../src/names.ts";
import { stagingDir, stateDir } from "../../src/write-base.ts";
import { LESSON_GATE_ACCEPTED } from "../../src/types.ts";
import type {
  AttemptLine,
  DecisionRecord,
  Diagnosis,
  Eligibility,
  EvidenceItem,
  LessonDraft,
  SkillRef,
  SriConfig,
} from "../../src/types.ts";
import {
  lessonHashes,
  writeStagingCandidate,
  type StagingWriteInput,
  type StagingWriteResult,
} from "../../src/writer.ts";

// The loop is exercised on a real package root and a real index, with the proposer and the writer
// replaced: the two tests below are about the unit the candidate and its index line form (F1), and that
// unit is only visible when the directory exists and the line can fail.
//
// The writer double really writes, so "the candidate is gone" and "the candidate is still there" are
// answered by the filesystem and not by a recorder. The proposer is injected because the generation is
// not what this test is about, and readSkillText is injected because no skill directory is involved.

const NOW = new Date("2026-11-02T14:03:22.481Z");
const BASE_TIMESTAMP = "20261102T140322481Z";
const CWD = "/work/reports";
const BASE_MS = Date.parse("2026-11-02T14:00:00.000Z");

const CONTENT_HASH = `sha256:${"a".repeat(64)}`;
const BODY_HASH = `sha256:${"b".repeat(64)}`;

const SKILL_TEXT = "# pdf-tools\n\nUse pdftotext for plain text.\n";

const LESSON_TITLE = "Use the lattice strategy for merged cells";
const LESSON_SLUG = "use-the-lattice-strategy-for-merged-cells";
const LESSON_BODY = "- Use pdfplumber with `lattice` for tables with merged cells.";

const SKILL: SkillRef = {
  name: "pdf-tools",
  description: "Extract tables from PDFs",
  dir: "/skills/pdf-tools",
  realDir: "/skills/pdf-tools",
  hasLessons: false,
  kind: "declared",
};

// The evidence and the diagnosis the record carries, as literals: buildDecision is a pure function over
// them and the assertions below are about the fields a run calculates (the verdict) and the ones the
// writer stamps (the two hashes).
const EVIDENCE: EvidenceItem = {
  id: "ev-3f9a1c02",
  kind: "tool_error",
  timestamp: BASE_MS + 2000,
  source: "transcript",
  toolName: "bash",
  excerpt: "pdftotext: cannot open report.pdf",
};

const DIAGNOSIS: Diagnosis = {
  summary: "Observed 1 tool error in this session",
  failureSignature: `sha256:${"c".repeat(64)}`,
  replayItems: [
    {
      prompt: "extract the merged-cell table from report.pdf",
      cwd: CWD,
      expectation: { class: "tool_error", version: 1, tool: "bash" },
    },
  ],
};

const USAGE: Usage = {
  input: 412,
  output: 137,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 549,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface Fixture {
  pkg: string;
}

function createFixture(t: TestContext): Fixture {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-flow-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const pkg = path.join(base, "pi-simple-sri");
  fs.mkdirSync(pkg, { recursive: true });

  return { pkg };
}

// One prompt, one bash call and its error: the smallest branch that yields evidence and a turn a replay
// could test, which is what the flow needs before it reaches the generation.
function failingBranch(): SessionEntry[] {
  const instant = (seconds: number): string => new Date(BASE_MS + seconds * 1000).toISOString();
  const call: ToolCall = {
    type: "toolCall",
    id: "call-1",
    name: "bash",
    arguments: { command: "pdftotext report.pdf -" },
  };
  const reply: AssistantMessage = {
    role: "assistant",
    content: [call],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: USAGE,
    stopReason: "toolUse",
    timestamp: BASE_MS + 1000,
  };

  return [
    {
      type: "message",
      id: "entry-0",
      parentId: null,
      timestamp: instant(0),
      message: {
        role: "user",
        content: "extract the merged-cell table from report.pdf",
        timestamp: BASE_MS,
      },
    },
    { type: "message", id: "entry-1", parentId: "entry-0", timestamp: instant(1), message: reply },
    {
      type: "message",
      id: "entry-2",
      parentId: "entry-1",
      timestamp: instant(2),
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "pdftotext: cannot open report.pdf" }],
        isError: true,
        timestamp: BASE_MS + 2000,
      },
    },
  ];
}

// S6: the commands of a branch where the session ran the same task twice and then another one. The identity the equivalence
// reads is the digest of the arguments, which is what the transcript records, so a repeated command is one task failed twice.
const REPEATED_COMMAND = "pdftotext report.pdf -";
const OTHER_COMMAND = "pdftotext appendix.pdf -";

// The same shape as the branch above with one bash call and its error per command, in order: a branch built from a repeated
// command carries two failures of one task, and one built from distinct commands carries two tasks. Two identical calls stay
// under the retry threshold, so the failures of this fixture are tool errors and not a retry loop.
function repeatedFailureBranch(commands: readonly string[]): SessionEntry[] {
  const instant = (seconds: number): string => new Date(BASE_MS + seconds * 1000).toISOString();
  const entries: SessionEntry[] = [
    {
      type: "message",
      id: "entry-0",
      parentId: null,
      timestamp: instant(0),
      message: {
        role: "user",
        content: "extract the merged-cell table from report.pdf",
        timestamp: BASE_MS,
      },
    },
  ];

  commands.forEach((command, index) => {
    const callId = `call-${index + 1}`;
    const reply: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command } }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: USAGE,
      stopReason: "toolUse",
      timestamp: BASE_MS + (2 * index + 1) * 1000,
    };

    entries.push({
      type: "message",
      id: `entry-${2 * index + 1}`,
      parentId: `entry-${2 * index}`,
      timestamp: instant(2 * index + 1),
      message: reply,
    });
    entries.push({
      type: "message",
      id: `entry-${2 * index + 2}`,
      parentId: `entry-${2 * index + 1}`,
      timestamp: instant(2 * index + 2),
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: "bash",
        content: [{ type: "text", text: "pdftotext: cannot open report.pdf" }],
        isError: true,
        timestamp: BASE_MS + (2 * index + 2) * 1000,
      },
    });
  });

  return entries;
}

function flowContext(branch: readonly SessionEntry[], model?: Model<Api>): ImproveFlowContext {
  return {
    cwd: CWD,
    model,
    modelRegistry: {
      complete: async () => {
        throw new Error("the flow must not reach the registry while a proposer is injected");
      },
    },
    sessionManager: { getBranch: () => [...branch], getSessionId: () => "session-test" },
  };
}

function successfulProposer(): ProposeFn {
  return async (input) => {
    const draft: LessonDraft = {
      slug: LESSON_SLUG,
      title: LESSON_TITLE,
      date: "2026-11-02",
      status: "accepted",
      sourceEvidence: input.evidence.map((item) => item.id),
      gate: LESSON_GATE_ACCEPTED,
      body: LESSON_BODY,
    };
    const lesson = serializeLesson(draft);
    if (!lesson.ok) assert.fail(`the lesson of this test must serialize: ${lesson.error}`);
    return { ok: true, value: { draft, lessonText: lesson.value, usage: { input: 412, output: 137 } } };
  };
}

// A writer that really writes: the same directory layout the production writer produces, without the
// frontmatter and perimeter work this module is not being tested for. It answers where the bytes went, so
// the assertions below read the filesystem and not a recorder.
function writingWriter(): (input: StagingWriteInput) => Promise<StagingWriteResult> {
  return async (input) => {
    const candidateDir = path.join(stagingDir(input.base), BASE_TIMESTAMP, input.skill.name);
    const lessonsDir = path.join(candidateDir, LESSONS_DIR);
    fs.mkdirSync(lessonsDir, { recursive: true });

    const lessonPath = path.join(lessonsDir, `${input.slug}.md`);
    const decisionPath = path.join(candidateDir, DECISION_FILE);
    fs.writeFileSync(lessonPath, input.lessonText, "utf8");
    fs.writeFileSync(decisionPath, `${JSON.stringify(input.decision)}\n`, "utf8");

    return { stagingPath: candidateDir, lessonPath, decisionPath, contentHash: CONTENT_HASH, bodyHash: BODY_HASH };
  };
}

// The only tests of this file that inject no proposer are the ones of the base of the bank, and they need one that is real:
// the guard which used to refuse an empty evidence list lives inside createProposer, so a double would answer a candidate the
// production code could have refused. The fake is the completer, which is the single boundary this package crosses.
interface FakeModel {
  complete: CompleteFn;
  calls: Context[];
}

function fakeModel(): FakeModel {
  const calls: Context[] = [];
  const complete: CompleteFn = async (context) => {
    calls.push(context);
    return {
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify({ title: LESSON_TITLE, body: LESSON_BODY }) }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: USAGE,
      stopReason: "stop",
      timestamp: NOW.getTime(),
    };
  };
  return { complete, calls };
}

// The proposer the flow builds in production, over that fake: one model call away from the real thing and no seam of its
// own in between.
function realProposer(model: FakeModel): ProposeFn {
  const proposer = createProposer(model.complete);
  return (input) => proposer.propose(input);
}

// The text of the one user message the proposer sends, so a test reads what the model was asked without a provider.
function promptOf(context: Context): string {
  const message = context.messages[0];
  if (message.role !== "user") assert.fail("expected the request to hold one user message");
  if (typeof message.content !== "string") assert.fail("expected the user message to carry text");
  return message.content;
}

function flowDeps(fixture: Fixture, appendAttempt?: (root: string, line: AttemptLine) => Promise<void>): ImproveFlowDeps {
  return {
    now: () => NOW,
    readConfig: () => ({ allow: [], deny: [] }),
    listSkills: async () => [SKILL],
    readSkillText: async () => SKILL_TEXT,
    propose: successfulProposer(),
    write: writingWriter(),
    base: fixture.pkg,
    ...(appendAttempt === undefined ? {} : { appendAttempt }),
  };
}

function candidatePath(pkg: string): string {
  return path.join(stagingDir(pkg), BASE_TIMESTAMP, SKILL.name);
}

// M1c, S8: the branch of the defect. The artifact lives in the temporary directory of the test and never in a skill, the
// bank declares it in profile `origin`, and its two cases are the predicate a replayed answer is judged by.
const ARTIFACT_FILE = "review.md";
const ARTIFACT_TEXT = "rebase with --squash-all to leave one commit\n";
const DEFECT_EXCERPT = "rebase with --squash-all";

// The model of the invocation, which is the one a defect pins on every item: it has no failing turn to name its own.
const DEFECT_MODEL: Model<Api> = {
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
const DEFECT_MODEL_ID = "anthropic/claude-sonnet-4-5";

// The digest of the bytes on disk, computed here and not with src/hash.ts: what the record keeps has to agree with an
// independent computation of the same bytes.
function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
}

// The bank of profile `origin`: the artifact the defect was read from and the two cases that measure it. The cases are the
// floor the format declares (MIN_CASES), so the reader accepts it.
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

// A proposer that fails the test if it is reached: the refusals of this branch happen before the generation, and a double
// that answered a candidate would hide a run that spent tokens on a defect it could not measure.
function neverCalledProposer(): ProposeFn {
  return async () => assert.fail("the run must refuse before the generation");
}

// Forward-slash relative paths, sorted: the shape of what is left under a directory.
function relativeFiles(rootDir: string): string[] {
  const entries: string[] = [];

  const walk = (currentDir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path.join(currentDir, entry.name), relative);
      } else {
        entries.push(relative);
      }
    }
  };

  walk(rootDir, "");
  return entries.sort();
}

// F1: the candidate and its index line are one unit. A line that cannot be appended retires the
// candidate, and the error names both halves instead of reporting a run that wrote nothing while the
// bytes sit in staging.
test("proposeSkill: a candidate whose attempt line fails is retired and named in the error", async (t) => {
  const fixture = createFixture(t);
  const deps = flowDeps(fixture, async () => {
    throw new Error("ENOSPC: no space left on device, write");
  });

  await assert.rejects(
    () =>
      proposeSkill(
        { surface: "command", skillName: "pdf-tools", focus: "merged cells" },
        flowContext(failingBranch()),
        deps,
      ),
    (error: unknown) => {
      if (!(error instanceof SriWriterError)) return false;
      // The candidate that was retired, named the way the record names it, and the reason the index
      // refused are both in the message, and so is whether the removal worked.
      return (
        error.message.includes(path.relative(fixture.pkg, candidatePath(fixture.pkg))) &&
        // The relative spelling is a suffix of the absolute one, so the positive assertion alone passes
        // for both: the base has to be absent from the sentence for this to prove what it claims.
        !error.message.includes(fixture.pkg) &&
        error.message.includes("ENOSPC") &&
        error.message.includes("removed: true")
      );
    },
  );

  assert.equal(fs.existsSync(candidatePath(fixture.pkg)), false);
  assert.deepEqual(fs.readdirSync(path.join(stagingDir(fixture.pkg), BASE_TIMESTAMP)), []);
  // Nothing reached the index either.
  assert.equal(fs.existsSync(stateDir(fixture.pkg)), false);
});

// The other side of the same rule: a line that lands keeps the candidate exactly as the writer published
// it, so the two writes agree and nothing is removed on the happy path.
test("proposeSkill: the happy path keeps the candidate and joins the index", async (t) => {
  const fixture = createFixture(t);

  const result = await proposeSkill(
    { surface: "command", skillName: "pdf-tools" },
    flowContext(failingBranch()),
    flowDeps(fixture),
  );

  if (result.kind !== "proposed") assert.fail(`expected a candidate, got ${result.kind}`);

  // The candidate is named relative to the base of the run; the bytes are where that name says.
  assert.equal(result.staged.stagingPath, path.relative(fixture.pkg, candidatePath(fixture.pkg)));
  assert.equal(path.isAbsolute(result.staged.stagingPath), false);
  assert.deepEqual(relativeFiles(path.join(fixture.pkg, result.staged.stagingPath)), [
    DECISION_FILE,
    `${LESSONS_DIR}/${LESSON_SLUG}.md`,
  ]);

  const attemptsPath = path.join(stateDir(fixture.pkg), ATTEMPTS_FILE);
  const lines = fs
    .readFileSync(attemptsPath, "utf8")
    .split("\n")
    .filter((line) => line !== "");
  assert.equal(lines.length, 1);

  const parsed: unknown = JSON.parse(lines[0]);
  assert.deepEqual(parsed, {
    ts: NOW.toISOString(),
    event: "proposed",
    candidateHash: CONTENT_HASH,
    bodyHash: BODY_HASH,
    // OA4: the line names the failure of the diagnosis the record carries, not a second failure of its own.
    failureSignature: result.diagnosis.failureSignature,
    targetSkill: "pdf-tools",
    stagingPath: result.staged.stagingPath,
    decisionPath: result.staged.decisionPath,
  });
});

// S6, OA8: the plan of the gate is computed over the items the diagnosis carries, and two identical failures are one of them.
// One item is under the floor of the paired design, so the gate abstains with `insufficient-items` and the record stays
// `not-run`: the design over the item that survived is four runs, where the two items the transcript gave would have promised
// eight, and the honest answer to a single item is that a run has nothing to be compared against.
test("proposeSkill: two identical failures are one item, which the floor of the design refuses", async (t) => {
  const fixture = createFixture(t);

  const result = await proposeSkill(
    { surface: "command", skillName: SKILL.name },
    flowContext(repeatedFailureBranch([REPEATED_COMMAND, REPEATED_COMMAND])),
    flowDeps(fixture),
  );

  if (result.kind !== "proposed") assert.fail(`expected a candidate, got ${result.kind}`);

  // One task failed twice: the transcript gives two items and the diagnosis plans one.
  assert.equal(result.evidence.length, 2);
  assert.equal(result.diagnosis.replayItems.length, 1);

  // The arithmetic the dedupe buys, over the count that survived and over the count of the transcript: four runs and not
  // the eight the two items of the same command would have cost.
  assert.equal(planDesign(result.diagnosis.replayItems.length, "replay").design.plannedRuns, 4);
  assert.equal(planDesign(result.evidence.length, "replay").design.plannedRuns, 8);

  // The floor refuses the pair before anything is preregistered.
  assert.deepEqual(planGate(result.diagnosis.replayItems.map((item) => ({ item }))), {
    abstain: "insufficient-items",
    excluded: [],
  });

  // And the record the run wrote says the same: no gate ran, so the budget it promised is zero.
  const record: DecisionRecord = JSON.parse(
    fs.readFileSync(path.join(fixture.pkg, result.staged.decisionPath), "utf8"),
  );
  assert.equal(record.gate.status, "not-run");
  assert.deepEqual(record.gate.budget, { plannedRuns: 0, usedRuns: 0, interruptedAt: null });
});

// The other side of the same rule: a session that fails one task twice and another one once plans the two tasks. The design is
// computed over the items that survived -- eight runs, and not the twelve the three failures of the transcript would promise.
test("proposeSkill: the design of the run is computed over the deduplicated items", async (t) => {
  const fixture = createFixture(t);

  const result = await proposeSkill(
    { surface: "command", skillName: SKILL.name },
    flowContext(repeatedFailureBranch([REPEATED_COMMAND, REPEATED_COMMAND, OTHER_COMMAND])),
    flowDeps(fixture),
  );

  if (result.kind !== "proposed") assert.fail(`expected a candidate, got ${result.kind}`);

  assert.equal(result.evidence.length, 3);
  assert.equal(result.diagnosis.replayItems.length, 2);

  const plan = planGate(result.diagnosis.replayItems.map((item) => ({ item })));
  if ("abstain" in plan) assert.fail(`two items spend a design, and the plan abstained with ${plan.abstain}`);
  assert.deepEqual(plan.design, { reps: 2, items: 2, plannedRuns: 8, arms: ["incumbent", "candidate"] });
  assert.equal(planDesign(result.evidence.length, "replay").design.plannedRuns, 12);
});

// The input of one record, built the way proposeSkill builds it: the draft serialized by the module that
// owns the format, and the pair of hashes computed by the module that owns the hashing.
function decisionInput(verdict: Eligibility): DecisionInput {
  const draft: LessonDraft = {
    slug: LESSON_SLUG,
    title: LESSON_TITLE,
    date: "2026-11-02",
    status: "accepted",
    sourceEvidence: [EVIDENCE.id],
    gate: LESSON_GATE_ACCEPTED,
    body: LESSON_BODY,
  };
  const lesson = serializeLesson(draft);
  if (!lesson.ok) assert.fail(`the lesson of this test must serialize: ${lesson.error}`);

  const hashes = lessonHashes(lesson.value);
  if (!hashes.ok) assert.fail(`the lesson of this test must hash: ${hashes.error}`);

  return {
    now: NOW,
    request: { surface: "command", skillName: "pdf-tools" },
    skill: SKILL,
    config: { allow: [], deny: [] },
    verdict,
    evidence: [EVIDENCE],
    diagnosis: DIAGNOSIS,
    draft,
    usage: { input: 412, output: 137 },
    hashes: hashes.value,
  };
}

// The skill block of the record is the verdict the run calculated, never an assumed true. A run
// refuses an ineligible skill before a record exists -- and writes nothing -- so the field can only be
// proven against a false verdict by building the record directly, which is why buildDecision is
// exported.
test("buildDecision: the skill block carries the verdict the record was built under", () => {
  assert.equal(buildDecision(decisionInput({ eligible: true })).skill.eligible, true);
  assert.equal(
    buildDecision(decisionInput({ eligible: false, reason: "not-eligible" })).skill.eligible,
    false,
  );
});

// One owner of the pair of hashes (D4). The record the flow builds already carries the values the
// writer computes, so the document in memory and the decision.json on disk are the same record: the
// stamp in the writer is a confirmation, not a repair.
test("proposeSkill: the record in memory is the record on disk", async (t) => {
  const fixture = createFixture(t);
  const captured: StagingWriteInput[] = [];
  const deps: ImproveFlowDeps = {
    ...flowDeps(fixture),
    write: async (input) => {
      captured.push(input);
      return await writeStagingCandidate(input);
    },
  };

  const result = await proposeSkill(
    { surface: "command", skillName: "pdf-tools", focus: "merged cells" },
    flowContext(failingBranch()),
    deps,
  );

  if (result.kind !== "proposed") assert.fail(`expected a candidate, got ${result.kind}`);
  assert.equal(captured.length, 1);
  const [input] = captured;

  const onDisk: unknown = JSON.parse(
    fs.readFileSync(path.join(fixture.pkg, result.staged.decisionPath), "utf8"),
  );
  assert.deepEqual(onDisk, input.decision);
  // And the two values the run reports are the two values the record carries.
  assert.equal(result.entry.candidateHash, input.decision.candidate.contentHash);
  assert.equal(result.entry.bodyHash, input.decision.candidate.bodyHash);
});

type ProposeKind = ProposeFlowResult["kind"];

// One row of the six outcomes of the run: what the run is arranged with, the kind it answers, and the
// index line it leaves behind. A refusal that cost no generation still has a line (D5); a generation
// that refused is recorded in the session entry alone, and a name nobody knows leaves nothing at all.
interface Outcome {
  name: string;
  skills: readonly SkillRef[];
  config: SriConfig;
  branch: readonly SessionEntry[];
  // null leaves the run without a proposer, which is how it reaches no-model.
  proposer: ProposeFn | null;
  kind: ProposeKind;
  event: AttemptLine["event"] | null;
}

const REFUSING_PROPOSER: ProposeFn = async () => ({
  ok: false,
  error: new ProposerError('the model stopped with "length" instead of finishing the lesson'),
});

const OUTCOMES: readonly Outcome[] = [
  {
    name: "an unknown name",
    skills: [],
    config: { allow: [], deny: [] },
    branch: failingBranch(),
    proposer: successfulProposer(),
    kind: "unknown-skill",
    event: null,
  },
  {
    name: "a skill the settings exclude",
    skills: [SKILL],
    config: { allow: [], deny: [SKILL.name] },
    branch: failingBranch(),
    proposer: successfulProposer(),
    kind: "not-eligible",
    event: "not-eligible",
  },
  {
    name: "a session with no failure",
    skills: [SKILL],
    config: { allow: [], deny: [] },
    branch: [],
    proposer: successfulProposer(),
    kind: "no-evidence",
    event: "no-evidence",
  },
  {
    name: "a run with no model",
    skills: [SKILL],
    config: { allow: [], deny: [] },
    branch: failingBranch(),
    proposer: null,
    kind: "no-model",
    event: "no-model",
  },
  {
    name: "a generation that refused",
    skills: [SKILL],
    config: { allow: [], deny: [] },
    branch: failingBranch(),
    proposer: REFUSING_PROPOSER,
    kind: "refused",
    event: null,
  },
  {
    name: "a candidate",
    skills: [SKILL],
    config: { allow: [], deny: [] },
    branch: failingBranch(),
    proposer: successfulProposer(),
    kind: "proposed",
    event: "proposed",
  },
];

// The dependencies of one row: every seam the outcome needs is replaced, so the run reads nothing and
// the index line lands in the recorder instead of on disk.
function outcomeDeps(fixture: Fixture, outcome: Outcome, attempts: AttemptLine[]): ImproveFlowDeps {
  return {
    now: () => NOW,
    base: fixture.pkg,
    readConfig: () => outcome.config,
    listSkills: async () => [...outcome.skills],
    readSkillText: async () => SKILL_TEXT,
    write: writingWriter(),
    appendAttempt: async (_root, line) => {
      attempts.push(line);
    },
    ...(outcome.proposer === null ? {} : { propose: outcome.proposer }),
  };
}

for (const outcome of OUTCOMES) {
  test(`proposeSkill: ${outcome.name} answers ${outcome.kind}`, async (t) => {
    const fixture = createFixture(t);
    const attempts: AttemptLine[] = [];

    const result = await proposeSkill(
      { surface: "command", skillName: SKILL.name },
      flowContext(outcome.branch),
      outcomeDeps(fixture, outcome, attempts),
    );

    assert.equal(result.kind, outcome.kind);
    // The line the outcome leaves in the index, and only the outcomes that cost no generation leave one.
    assert.deepEqual(attempts.map((line) => line.event), outcome.event === null ? [] : [outcome.event]);
    // Only a candidate reaches staging.
    assert.equal(fs.existsSync(candidatePath(fixture.pkg)), outcome.kind === "proposed");
  });
}

// The agent directory is a seam and not a constant: the settings file and the inventory are read under
// it, resolved once per run, so a run cannot read the settings of one directory and the skills of
// another.
test("proposeSkill: the agent directory of the run reaches the settings and the inventory", async (t) => {
  const fixture = createFixture(t);
  const settingsReads: string[] = [];
  const inventories: string[] = [];

  const deps: ImproveFlowDeps = {
    ...flowDeps(fixture),
    agentDir: "/agent",
    readConfig: (settingsPath) => {
      settingsReads.push(settingsPath);
      return { allow: [], deny: [] };
    },
    listSkills: async (options) => {
      inventories.push(options.agentDir);
      return [SKILL];
    },
  };

  const result = await proposeSkill(
    { surface: "command", skillName: SKILL.name },
    flowContext(failingBranch()),
    deps,
  );

  if (result.kind !== "proposed") assert.fail(`expected a candidate, got ${result.kind}`);
  assert.deepEqual(settingsReads, ["/agent/settings.json"]);
  assert.deepEqual(inventories, ["/agent"]);
});

// The wiring owns no path: without a base handed over, the run writes under the agent directory it
// resolved, which is the anchor that survives a reinstall of the package.
test("proposeSkill: without a base, the run writes under the agent directory", async (t) => {
  const fixture = createFixture(t);
  const { base: _unused, ...withoutBase } = flowDeps(fixture);
  const attemptBases: string[] = [];

  const deps: ImproveFlowDeps = {
    ...withoutBase,
    agentDir: fixture.pkg,
    appendAttempt: async (base, line) => {
      attemptBases.push(base);
      assert.equal(line.event, "proposed");
    },
  };

  const result = await proposeSkill(
    { surface: "command", skillName: SKILL.name },
    flowContext(failingBranch()),
    deps,
  );

  if (result.kind !== "proposed") assert.fail(`expected a candidate, got ${result.kind}`);
  // One base for both writes, and it is the package's directory under the agent directory.
  assert.deepEqual(attemptBases, [path.join(fixture.pkg, "sri")]);
  assert.equal(
    fs.existsSync(path.join(fixture.pkg, "sri", result.staged.stagingPath)),
    true,
  );
  // And nothing landed in the agent directory itself, where pi keeps its own files.
  assert.deepEqual(fs.readdirSync(fixture.pkg), ["sri"]);
});

// The environment variable pi documents for its agent directory moves the anchor with it, because the
// base is derived from the resolved directory and never from a constant of this package.
test("proposeSkill: PI_CODING_AGENT_DIR moves the base", async (t) => {
  const fixture = createFixture(t);
  const envAgentDir = path.join(fixture.pkg, "env-agent");
  fs.mkdirSync(envAgentDir, { recursive: true });

  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = envAgentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });

  const { base: _unused, agentDir: _agentDir, ...withoutPaths } = flowDeps(fixture);
  const attemptBases: string[] = [];

  await proposeSkill(
    { surface: "command", skillName: SKILL.name },
    flowContext(failingBranch()),
    {
      ...withoutPaths,
      appendAttempt: async (base) => {
        attemptBases.push(base);
      },
    },
  );

  assert.deepEqual(attemptBases, [path.join(envAgentDir, "sri")]);
});

// A base inside the skill it improves is refused before the model is called and before the index is
// touched, because both writes of the run land under the base.
test("proposeSkill: a base inside the skill is refused before the model and the index", async (t) => {
  const fixture = createFixture(t);
  let proposed = 0;
  const attempts: AttemptLine[] = [];

  const deps: ImproveFlowDeps = {
    ...flowDeps(fixture),
    base: path.join(SKILL.realDir, "staging"),
    propose: async (input) => {
      proposed += 1;
      return { ok: false, error: new ProposerError("the model must not be called") };
    },
    appendAttempt: async (_base, line) => {
      attempts.push(line);
    },
  };

  await assert.rejects(
    () =>
      proposeSkill({ surface: "command", skillName: SKILL.name }, flowContext(failingBranch()), deps),
    (error: unknown) =>
      error instanceof SriPerimeterError &&
      error.message.includes(path.join(SKILL.realDir, "staging")) &&
      error.message.includes(SKILL.realDir),
  );

  assert.equal(proposed, 0);
  assert.deepEqual(attempts, []);
  assert.equal(fs.existsSync(stagingDir(fixture.pkg)), false);
});

// The check covers every branch that writes, not only the generation: a run that only records the attempt
// also leaves a line under the base, so an ineligible skill is refused by the same rule.
test("proposeSkill: a base inside the skill refuses a run that would only record the attempt", async (t) => {
  const fixture = createFixture(t);
  const attempts: AttemptLine[] = [];

  const deps: ImproveFlowDeps = {
    ...flowDeps(fixture),
    base: path.join(SKILL.realDir, "state"),
    readConfig: () => ({ allow: [], deny: [SKILL.name] }),
    appendAttempt: async (_base, line) => {
      attempts.push(line);
    },
  };

  await assert.rejects(
    () =>
      proposeSkill({ surface: "command", skillName: SKILL.name }, flowContext(failingBranch()), deps),
    (error: unknown) => error instanceof SriPerimeterError,
  );

  assert.deepEqual(attempts, []);
});

// One focus, three artifacts. The tool's schema accepts "focus": "   " and the command collapses its
// argument line, so a blank focus reaches the flow; the trigger of the record, the session entry and the
// identity of the attempt all spell it the way they spell an absent focus.
test("proposeSkill: a blank focus is no focus in the record, the entry and the hash of the attempt", async (t) => {
  const blankFixture = createFixture(t);
  const refusedFixture = createFixture(t);
  const absentFixture = createFixture(t);

  const captured: StagingWriteInput[] = [];
  const blank = await proposeSkill(
    { surface: "tool", skillName: SKILL.name, focus: "   " },
    flowContext(failingBranch()),
    {
      ...flowDeps(blankFixture),
      write: async (input) => {
        captured.push(input);
        return await writeStagingCandidate(input);
      },
    },
  );

  if (blank.kind !== "proposed") assert.fail(`expected a candidate, got ${blank.kind}`);
  assert.equal(blank.entry.focus, null);
  assert.deepEqual(captured[0].decision.trigger, { surface: "tool", focus: null });

  // Two runs with no evidence: the one that asked for spaces is the one that asked for nothing.
  const blankAttempts: AttemptLine[] = [];
  const blankRefusal = await proposeSkill(
    { surface: "tool", skillName: SKILL.name, focus: "   " },
    flowContext([]),
    flowDeps(refusedFixture, async (_root, line) => {
      blankAttempts.push(line);
    }),
  );

  const absentAttempts: AttemptLine[] = [];
  const absentRefusal = await proposeSkill(
    { surface: "tool", skillName: SKILL.name },
    flowContext([]),
    flowDeps(absentFixture, async (_root, line) => {
      absentAttempts.push(line);
    }),
  );

  if (blankRefusal.kind !== "no-evidence") assert.fail(`expected no-evidence, got ${blankRefusal.kind}`);
  if (absentRefusal.kind !== "no-evidence") assert.fail(`expected no-evidence, got ${absentRefusal.kind}`);
  assert.equal(blankRefusal.entry.focus, null);
  assert.equal(absentRefusal.entry.focus, null);
  assert.equal(blankAttempts[0].candidateHash, absentAttempts[0].candidateHash);
  assert.equal(blankAttempts[0].bodyHash, absentAttempts[0].bodyHash);
});

// The guard takes both spellings of the skill from the inventory (F5), so a skill reached through a
// symlink is refused on the linked path as well. Without this case, dropping `skill.dir` from the call
// leaves every other refusal test green.
test("proposeSkill: a base inside the linked path of a skill is refused", async (t) => {
  const fixture = createFixture(t);
  const linkedSkill: SkillRef = { ...SKILL, dir: "/skills/pdf-tools", realDir: "/home/me/skills/pdf-tools" };
  const attempts: AttemptLine[] = [];

  const deps: ImproveFlowDeps = {
    ...flowDeps(fixture),
    base: "/skills/pdf-tools/state",
    listSkills: async () => [linkedSkill],
    appendAttempt: async (_base, line) => {
      attempts.push(line);
    },
  };

  await assert.rejects(
    () =>
      proposeSkill({ surface: "command", skillName: SKILL.name }, flowContext(failingBranch()), deps),
    (error: unknown) =>
      error instanceof SriPerimeterError && error.message.includes("/skills/pdf-tools/state"),
  );

  assert.deepEqual(attempts, []);
});

// M1c, S7: a request that names a bank asks for a direction, and the bank is where that direction is measured. The
// session contributes nothing -- there is no failure of it to write from and none to replay -- so the run proposes from
// the ask, records the base of the bank and spends no gate. The proposer here is the real one over a fake completer,
// because the guard this slice relaxes lives inside it: with a seam the run would look green and the production call
// would still refuse the empty evidence list (OA2).
test("proposeSkill: a directional run proposes with no evidence and stamps the base of the bank", async (t) => {
  const fixture = createFixture(t);
  const model = fakeModel();

  const result = await proposeSkill(
    { surface: "command", skillName: SKILL.name, focus: "merged cells", bankPath: "/work/cases.json" },
    // A session with no failure at all: the base of the bank is asked, and nothing of the transcript is.
    flowContext([]),
    { ...flowDeps(fixture), propose: realProposer(model) },
  );

  if (result.kind !== "proposed") assert.fail(`expected a candidate, got ${result.kind}`);

  // The generation happened: an empty evidence list did not refuse the proposal.
  assert.equal(model.calls.length, 1);
  // And what the model read was the ask, with no excerpt and no turn to list.
  const prompt = promptOf(model.calls[0]);
  assert.equal(prompt.includes("summary:"), true);
  assert.equal(prompt.includes("merged cells"), true);
  assert.equal(prompt.includes("failure excerpts:"), false);
  assert.equal(prompt.includes("failing turns:"), false);

  const record: DecisionRecord = JSON.parse(
    fs.readFileSync(path.join(fixture.pkg, result.staged.decisionPath), "utf8"),
  );

  assert.equal(record.trigger.focus, "merged cells");
  // The whole block, field for field: the base of the run, the status of a gate that has not run, a budget of zero runs,
  // the tokens of the generation as the only number it can carry, no preregistration and no result of either base. The
  // deep comparison is also what proves the block carries no key outside the schema, `caseBank` included.
  assert.deepEqual(record.gate, {
    basis: "case-bank",
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
    caseBank: null,
  });

  // The diagnosis of the base: the ask and nothing to replay, and the empty list of evidence the lens asks for.
  assert.deepEqual(record.diagnosis.replayItems, []);
  assert.deepEqual(record.evidence, []);
  assert.equal(record.diagnosis.failureSignature, result.diagnosis.failureSignature);
  // The outcome is the one a gate that has not run implies, from the one mapping that relates the two fields.
  assert.equal(record.outcome.status, "proposed");
  assert.equal(record.outcome.decidedAt, null);

  // No gate was called. The flow has none to call, and the staging tree says the same: a gate leaves its runs under
  // <candidate>/gate/, which is not there.
  assert.equal(fs.existsSync(path.join(fixture.pkg, result.staged.stagingPath, "gate")), false);

  // The line of the index is the one every candidate writes, and it names the failure of the diagnosis it carries.
  const lines = fs
    .readFileSync(path.join(stateDir(fixture.pkg), ATTEMPTS_FILE), "utf8")
    .split("\n")
    .filter((line) => line !== "");
  assert.equal(lines.length, 1);
  const line: AttemptLine = JSON.parse(lines[0]);
  assert.equal(line.event, "proposed");
  assert.equal(line.failureSignature, record.diagnosis.failureSignature);
  assert.equal(line.stagingPath, result.staged.stagingPath);
});

// The failure of a directional attempt is the ask itself, so the signature of two runs that ask for the same thing on the
// same skill is one value -- a reader of the index groups them -- while another focus is another failure.
test("proposeSkill: the failureSignature of a directional run is stable per skill and focus", async (t) => {
  const first = createFixture(t);
  const second = createFixture(t);
  const other = createFixture(t);

  const signatureFor = async (fixture: Fixture, focus: string): Promise<string> => {
    const result = await proposeSkill(
      { surface: "command", skillName: SKILL.name, focus, bankPath: "/work/cases.json" },
      flowContext([]),
      { ...flowDeps(fixture), propose: realProposer(fakeModel()) },
    );
    if (result.kind !== "proposed") assert.fail(`expected a candidate, got ${result.kind}`);
    return result.diagnosis.failureSignature;
  };

  const merged = await signatureFor(first, "merged cells");
  assert.match(merged, /^sha256:[0-9a-f]{64}$/);
  assert.equal(await signatureFor(second, "merged cells"), merged);
  assert.notEqual(await signatureFor(other, "another focus"), merged);
});

// The other side of the branch: without a bankPath the run is the run of M1, field for field. A record's base is what its
// request asked for and never a default of this version.
test("proposeSkill: without a bank the record is the one M1 writes", async (t) => {
  const fixture = createFixture(t);

  const result = await proposeSkill(
    { surface: "command", skillName: SKILL.name, focus: "merged cells" },
    flowContext(failingBranch()),
    flowDeps(fixture),
  );

  if (result.kind !== "proposed") assert.fail(`expected a candidate, got ${result.kind}`);

  const record: DecisionRecord = JSON.parse(
    fs.readFileSync(path.join(fixture.pkg, result.staged.decisionPath), "utf8"),
  );
  assert.equal(record.gate.basis, "replay");
  assert.equal(record.gate.status, "not-run");
  // The key of the other base is not written at all, and the materials of the transcript are the ones of M1.
  assert.equal("caseBank" in record.gate, false);
  assert.equal(record.evidence.length, 1);
  assert.equal(record.diagnosis.replayItems.length, 1);
});

// A bank names the failures of the run, so a session that also carries failures contributes none of them: the record of a
// directional run holds no evidence item even when the transcript has one, which is what keeps the two bases from mixing
// their materials in one record.
test("proposeSkill: a directional run does not read the transcript", async (t) => {
  const fixture = createFixture(t);
  const model = fakeModel();

  const result = await proposeSkill(
    { surface: "tool", skillName: SKILL.name, bankPath: "/work/cases.json" },
    flowContext(failingBranch()),
    { ...flowDeps(fixture), propose: realProposer(model) },
  );

  if (result.kind !== "proposed") assert.fail(`expected a candidate, got ${result.kind}`);

  assert.deepEqual(result.evidence, []);
  assert.deepEqual(result.diagnosis.replayItems, []);
  assert.equal(result.entry.evidenceCount, 0);
  // The draft lists no evidence id, which is what the frontmatter of the lesson carries too.
  assert.deepEqual(result.draft.sourceEvidence, []);
  assert.equal(model.calls.length, 1);
});

// M1c, S8: the branch of the defect. A defect with an observable truth enters as one evidence item of the fourth class that
// keeps the artifact it was read from and its entry, and the cases of the bank are what the gate of M1 replays -- one item
// per case, judged by the checks of that case. The session contributes nothing: the evidence comes from a file.
test("proposeSkill: a defect enters as evidence that keeps its artifact and replays the cases of its bank", async (t) => {
  const fixture = createFixture(t);
  const artifactPath = path.join(fixture.pkg, ARTIFACT_FILE);
  fs.writeFileSync(artifactPath, ARTIFACT_TEXT, "utf8");
  const bankPath = path.join(fixture.pkg, "defect.json");
  fs.writeFileSync(bankPath, defectBank(artifactPath), "utf8");

  const result = await proposeSkill(
    { surface: "command", skillName: SKILL.name, bankPath, defect: true },
    // A session that also carries a failed tool call: this branch reads the artifact and never the transcript, so the
    // evidence below is the one item the defect gives and not the one the session would have given.
    flowContext(failingBranch(), DEFECT_MODEL),
    flowDeps(fixture),
  );

  if (result.kind !== "proposed") assert.fail(`expected a candidate, got ${result.kind}`);

  const record: DecisionRecord = JSON.parse(
    fs.readFileSync(path.join(fixture.pkg, result.staged.decisionPath), "utf8"),
  );

  assert.equal(record.evidence.length, 1);
  const [evidence] = record.evidence;
  assert.equal(evidence.kind, "quality_defect");
  // The value `source` already had: the evidence was read from a file and not from a turn of this session.
  assert.equal(evidence.source, "persisted");
  assert.match(evidence.id, /^ev-[0-9a-f]{8}$/);
  assert.equal(evidence.excerpt, DEFECT_EXCERPT);
  assert.deepEqual(evidence.origin, {
    kind: "review-finding",
    path: artifactPath,
    contentHash: digestOf(ARTIFACT_TEXT),
  });
  assert.equal(result.entry.evidenceCount, 1);

  // One item per case, and the predicate of each is the one its case declares. The list is read through the branch of the class:
  // since M2 the union states which class carries `checks`.
  assert.deepEqual(
    record.diagnosis.replayItems.map((item) => item.prompt),
    ["rebase the branch onto main", "rebase the branch onto main keeping both commits"],
  );
  assert.deepEqual(
    record.diagnosis.replayItems.map((item) =>
      item.expectation.class === "quality_defect" ? item.expectation.checks : null,
    ),
    [
      [{ kind: "not-contains", value: "--squash-all" }],
      [{ kind: "contains", value: "--interactive" }],
    ],
  );
  for (const item of record.diagnosis.replayItems) {
    assert.equal(item.expectation.class, "quality_defect");
    assert.equal(item.expectation.version, 1);
    assert.equal(item.cwd, CWD);
    // The model of the invocation, which is the only one a defect can name: it has no failing turn of its own.
    assert.equal(item.model, DEFECT_MODEL_ID);
    assert.deepEqual(item.skills, [SKILL.name]);
    // Every case measures the same defect, so every item names the one failure of the evidence.
    assert.equal(item.failureSignature, digestOf(evidence.id));
  }
  assert.equal(record.diagnosis.failureSignature, digestOf(evidence.id));

  // The branch adds no base to the gate: the candidate is measured by the paired replay of M1 (OA11).
  assert.equal(record.gate.basis, "replay");
  assert.equal(record.gate.status, "not-run");
});

// The artifact is a file the proposal reads, and one that is not there is a state of the attempt: the refusal costs no
// generation and leaves its line in the index, with the problem in the reason instead of in an event of its own.
test("proposeSkill: a defect whose artifact is not there answers no-evidence and spends no generation", async (t) => {
  const fixture = createFixture(t);
  const artifactPath = path.join(fixture.pkg, "missing-review.md");
  const bankPath = path.join(fixture.pkg, "defect.json");
  fs.writeFileSync(bankPath, defectBank(artifactPath), "utf8");
  const attempts: AttemptLine[] = [];

  const result = await proposeSkill(
    { surface: "tool", skillName: SKILL.name, bankPath, defect: true },
    flowContext([], DEFECT_MODEL),
    {
      ...flowDeps(fixture, async (_root, line) => {
        attempts.push(line);
      }),
      propose: neverCalledProposer(),
    },
  );

  if (result.kind !== "no-evidence") assert.fail(`expected no-evidence, got ${result.kind}`);
  const reason = result.entry.reason;
  if (reason === null) assert.fail("the refusal of the artifact kept no reason");
  assert.equal(reason.startsWith("artifact-absent: "), true);
  assert.equal(reason.includes(artifactPath), true);
  assert.equal(result.entry.evidenceCount, 0);

  // The line a refusal that cost nothing already writes, and no candidate anywhere.
  assert.deepEqual(
    attempts.map((line) => line.event),
    ["no-evidence"],
  );
  assert.equal(fs.existsSync(candidatePath(fixture.pkg)), false);
});

// A defect with no bank has nothing to replay, and the request is the only place that says where the cases are: the refusal
// is the same `no-evidence` of the branch, before the generation and before any file is read.
test("proposeSkill: a defect without a bank answers no-evidence", async (t) => {
  const fixture = createFixture(t);

  const result = await proposeSkill(
    { surface: "tool", skillName: SKILL.name, defect: true },
    flowContext([], DEFECT_MODEL),
    { ...flowDeps(fixture), propose: neverCalledProposer() },
  );

  if (result.kind !== "no-evidence") assert.fail(`expected no-evidence, got ${result.kind}`);
  const reason = result.entry.reason;
  if (reason === null) assert.fail("the refusal of the bank kept no reason");
  assert.equal(reason.startsWith("bank-absent: "), true);
  assert.equal(reason.includes(SKILL.name), true);
  assert.equal(fs.existsSync(candidatePath(fixture.pkg)), false);
});

// The bank of the other profile is read by the one reader of the format and refused as the bank it is: a rubric is what a
// directional bank declares, and a defect has an observable truth instead. The refusal is the `no-evidence` of the branch,
// with the reason of the reader in it.
test("proposeSkill: a bank of the other profile is refused as the bank it is", async (t) => {
  const fixture = createFixture(t);
  const bankPath = path.join(fixture.pkg, "cases.json");
  fs.writeFileSync(
    bankPath,
    JSON.stringify({
      format: CASE_BANK_FORMAT,
      description: "the cases of a directional run",
      rubric: "the answer names the tool it used",
      cases: [
        { id: "names-the-tool", prompt: "extract the table", checks: [{ kind: "contains", value: "pdftotext" }] },
        { id: "keeps-the-flag", prompt: "list the flags", checks: [{ kind: "contains", value: "--interactive" }] },
      ],
    }),
    "utf8",
  );

  const result = await proposeSkill(
    { surface: "command", skillName: SKILL.name, bankPath, defect: true },
    flowContext([], DEFECT_MODEL),
    { ...flowDeps(fixture), propose: neverCalledProposer() },
  );

  if (result.kind !== "no-evidence") assert.fail(`expected no-evidence, got ${result.kind}`);
  const reason = result.entry.reason;
  if (reason === null) assert.fail("the refusal of the bank kept no reason");
  assert.equal(reason.startsWith("bank-invalid: "), true);
  assert.equal(reason.includes("rubric"), true);
  assert.equal(fs.existsSync(candidatePath(fixture.pkg)), false);
});

// The bank declares the artifact, so a relative path in it is resolved against the directory the run was asked from -- and
// what the record keeps is the resolved path, which is the file the gate re-reads from wherever it runs.
test("proposeSkill: a relative artifact is resolved against the directory of the invocation", async (t) => {
  const fixture = createFixture(t);
  const artifactPath = path.join(fixture.pkg, ARTIFACT_FILE);
  fs.writeFileSync(artifactPath, ARTIFACT_TEXT, "utf8");
  const bankPath = path.join(fixture.pkg, "defect.json");
  fs.writeFileSync(bankPath, defectBank(ARTIFACT_FILE), "utf8");

  const result = await proposeSkill(
    { surface: "command", skillName: SKILL.name, bankPath, defect: true },
    { ...flowContext([], DEFECT_MODEL), cwd: fixture.pkg },
    flowDeps(fixture),
  );

  if (result.kind !== "proposed") assert.fail(`expected a candidate, got ${result.kind}`);
  assert.equal(result.evidence[0].origin?.path, artifactPath);
  assert.equal(result.evidence[0].origin?.contentHash, digestOf(ARTIFACT_TEXT));
});
