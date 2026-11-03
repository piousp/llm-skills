import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ProposerError, SriPerimeterError, SriWriterError } from "../../src/errors.ts";
import {
  buildDecision,
  proposeSkill,
  type DecisionInput,
  type ImproveFlowContext,
  type ImproveFlowDeps,
  type ProposeFlowResult,
  type ProposeFn,
} from "../../src/improve-flow.ts";
import { serializeLesson } from "../../src/lesson-frontmatter.ts";
import { ATTEMPTS_FILE, DECISION_FILE, LESSONS_DIR } from "../../src/names.ts";
import { stagingDir, stateDir } from "../../src/write-base.ts";
import type { AttemptLine, Diagnosis, Eligibility, EvidenceItem, LessonDraft, SkillRef, SriConfig } from "../../src/types.ts";
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
      predicate: "the tool bash does not return an error again",
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

function flowContext(branch: readonly SessionEntry[]): ImproveFlowContext {
  return {
    cwd: CWD,
    model: undefined,
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
      status: "proposed",
      sourceEvidence: input.evidence.map((item) => item.id),
      gate: "pending",
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
    targetSkill: "pdf-tools",
    stagingPath: result.staged.stagingPath,
    decisionPath: result.staged.decisionPath,
  });
});

// The input of one record, built the way proposeSkill builds it: the draft serialized by the module that
// owns the format, and the pair of hashes computed by the module that owns the hashing.
function decisionInput(verdict: Eligibility): DecisionInput {
  const draft: LessonDraft = {
    slug: LESSON_SLUG,
    title: LESSON_TITLE,
    date: "2026-11-02",
    status: "proposed",
    sourceEvidence: [EVIDENCE.id],
    gate: "pending",
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
