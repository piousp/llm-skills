import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import { CASE_CHECK_KINDS } from "../../src/checks.ts";
import type { CaseCheck } from "../../src/checks.ts";
import { expectationViolation } from "../../src/diagnosis.ts";
import { proposeSkill, type ImproveFlowContext, type ImproveFlowDeps, type ProposeFn } from "../../src/improve-flow.ts";
import { serializeLesson } from "../../src/lesson-frontmatter.ts";
import { assertNever, GATE_STATUSES, outcomeStatusFor, toDecisionSkill } from "../../src/types.ts";
import type {
  DecisionRecord,
  DecisionSkill,
  EvidenceItem,
  Expectation,
  GateBlock,
  GateBudget,
  GateCaseBankResult,
  GatePreregistration,
  GateReplayResult,
  GateStatus,
  GateTokenTally,
  JudgeRecord,
  LessonDraft,
  ReplayRunRecord,
  SkillRef,
} from "../../src/types.ts";
import { isPlainObject } from "../../src/values.ts";
import { writeStagingCandidate } from "../../src/writer.ts";
import { loadDecisionSchema, validateAgainstSchema } from "./schema-reader.ts";

// G2, schema 1: the exit criterion is that the decision.json the writer publishes satisfies
// schemas/decision.schema.json. The reader that checks it lives in test/unit/schema-reader.ts because the
// suites of the gate and of the acceptance validate the records they produce too; this file keeps the
// negative cases, which fix what the reader catches, one injected fault per case.

const LESSON_SLUG = "extract-tables-with-merged-cells";
const LESSON_TITLE = "Extract tables with merged cells";
const CREATED_AT = "2026-11-02T14:03:22.481Z";
const EVIDENCE_ID = "ev-3f9a1c02";
const CONTENT_HASH = `sha256:${"a".repeat(64)}`;
const BODY_HASH = `sha256:${"b".repeat(64)}`;
const FAILURE_SIGNATURE = `sha256:${"c".repeat(64)}`;

const ZERO_TOKENS: GateTokenTally = {
  proposal: { input: 0, output: 0 },
  incumbent: { input: 0, output: 0 },
  candidate: { input: 0, output: 0 },
  total: { input: 0, output: 0 },
};

const PLANNED_BUDGET: GateBudget = { plannedRuns: 12, usedRuns: 0, interruptedAt: null };
const SPENT_BUDGET: GateBudget = { plannedRuns: 12, usedRuns: 12, interruptedAt: null };

// What a gate of three items and two reps per item registers before its first run: the rule it will be
// judged by, the design that rule pays for, and the floor of that design. The value of `mde.basis` is a
// placeholder of this fixture on purpose: the schema declares it as a string because the scorer that names
// its arithmetic is a later slice, and pinning a vocabulary here would be deciding that slice's wording.
//
// `skillContentHash` is the field M1c adds to the block (the hash of the SKILL.md the gate measured, the one
// neutral to the basis), and it is optional: the negative case below proves a preregistration without it still
// validates, which is every record written before it existed.
const PREREGISTRATION: GatePreregistration = {
  recordedAt: "2026-11-02T14:04:00.000Z",
  threshold: {
    rule: "unanimous-and-strictly-better",
    candidatePasses: 6,
    incumbentPassesMax: 5,
    version: 1,
  },
  design: { reps: 2, items: 3, plannedRuns: 12, arms: ["incumbent", "candidate"] },
  mde: { basis: "resolution-of-the-design", runsPerArm: 6, resolution: 0.1667, requiredDifference: 1 },
  skillContentHash: CONTENT_HASH,
};

// A concluded replay, in the shape schema 1 declares. It is typed, so the compiler proves this fixture and
// the schema describe the same block: the negative cases below are one field away from a valid record.
const REPLAY: GateReplayResult = {
  completedAt: "2026-11-02T14:20:00.000Z",
  verdict: "gate-accepted",
  reason: null,
  items: [
    {
      index: 0,
      failureSignature: FAILURE_SIGNATURE,
      expectation: { class: "tool_error", version: 1, tool: "bash" },
      model: "anthropic/claude-sonnet-4-5",
      reps: [
        {
          arm: "incumbent",
          rep: 1,
          outcome: "fail",
          stopReason: "stop",
          skillLoaded: true,
          usage: { input: 900, output: 120 },
          durationMs: 4200,
          exitCode: 0,
        },
        {
          arm: "candidate",
          rep: 1,
          outcome: "pass",
          stopReason: "stop",
          skillLoaded: true,
          usage: { input: 910, output: 110 },
          durationMs: 3900,
          exitCode: 0,
          stream: "staging/20261102T140322481Z/pdf-tools/gate/runs/0-1-candidate.jsonl",
        },
      ],
    },
  ],
  arms: {
    incumbent: { passes: 0, runs: 1, tokens: { input: 900, output: 120 } },
    candidate: { passes: 1, runs: 1, tokens: { input: 910, output: 110 } },
  },
  interval: {
    method: "wilson",
    alpha: 0.05,
    incumbent: { low: 0, high: 0.7935 },
    candidate: { low: 0.2065, high: 1 },
    difference: { low: -0.7935, high: 1 },
  },
  regressions: 0,
  excluded: [{ failureSignature: `sha256:${"d".repeat(64)}`, reason: "intrinsic-failure" }],
  overlays: {
    incumbent: "staging/20261102T140322481Z/pdf-tools/arms/incumbent/pdf-tools",
    candidate: "staging/20261102T140322481Z/pdf-tools/arms/candidate/pdf-tools",
    skillContentHash: CONTENT_HASH,
    manifestHash: `sha256:${"e".repeat(64)}`,
  },
};

const CASE_BANK_HASH = `sha256:${"f".repeat(64)}`;
const RUBRIC_HASH = `sha256:${"9".repeat(64)}`;

// The preregistration of the second base (M1c): the same neutral fields as the one above, the hash of the skill the two
// bases share, the materials of the bank under the key of their basis and the judge clause inside the rule -- it is the
// second condition and it is recorded with the rule, not after it.
const CASE_BANK_PREREGISTRATION: GatePreregistration = {
  recordedAt: "2026-11-02T14:04:00.000Z",
  threshold: {
    rule: "unanimous-and-strictly-better",
    candidatePasses: 4,
    incumbentPassesMax: 3,
    version: 1,
    judge: { required: "pass", rubricHash: RUBRIC_HASH },
  },
  design: { reps: 2, items: 2, plannedRuns: 8, arms: ["incumbent", "candidate"] },
  mde: { basis: "case-bank", runsPerArm: 4, resolution: 0.25, requiredDifference: 1 },
  skillContentHash: CONTENT_HASH,
  caseBank: {
    path: "/work/cases.json",
    contentHash: CASE_BANK_HASH,
    copy: "staging/20261102T140322481Z/pdf-tools/case-bank.json",
    cases: 2,
    rubricHash: RUBRIC_HASH,
  },
};

// The second condition as it answered: one call per case of the candidate arm, the verdict over the whole set and what
// it cost. `verdict` of the record separates the judge that spoke from the one that never had to (`not-run`).
const CASE_BANK_JUDGE: JudgeRecord = {
  model: "anthropic/claude-sonnet-4-5",
  rubricHash: RUBRIC_HASH,
  verdict: "pass",
  calls: [
    {
      caseId: "no-squash-all",
      verdict: "pass",
      reason: "the answer names --interactive and never --squash-all",
      usage: { input: 300, output: 20 },
    },
  ],
  tokens: { input: 300, output: 20 },
};

// The result of the second base, in the shape gate.caseBank declares: one entry per case with the runs of both arms -- the
// run that failed its checks carries them as "<index>:<kind>" -- the tallies, the interval, the judge and the overlays.
// It is typed, so the compiler proves this fixture and the schema describe the same block.
const CASE_BANK_RESULT: GateCaseBankResult = {
  completedAt: "2026-11-02T14:20:00.000Z",
  verdict: "gate-accepted",
  reason: null,
  cases: [
    {
      index: 0,
      id: "no-squash-all",
      model: "anthropic/claude-sonnet-4-5",
      checks: [{ kind: "not-contains", value: "--squash-all" }],
      reps: [
        {
          arm: "incumbent",
          rep: 1,
          outcome: "fail",
          stopReason: "stop",
          skillLoaded: true,
          usage: { input: 900, output: 120 },
          durationMs: 4200,
          exitCode: 0,
          checkFailures: ["0:not-contains"],
        },
        {
          arm: "candidate",
          rep: 1,
          outcome: "pass",
          stopReason: "stop",
          skillLoaded: true,
          usage: { input: 910, output: 110 },
          durationMs: 3900,
          exitCode: 0,
          stream: "staging/20261102T140322481Z/pdf-tools/gate/runs/0-1-candidate.jsonl",
        },
      ],
    },
  ],
  arms: {
    incumbent: { passes: 1, runs: 2, tokens: { input: 900, output: 120 } },
    candidate: { passes: 2, runs: 2, tokens: { input: 910, output: 110 } },
  },
  interval: REPLAY.interval,
  regressions: 0,
  judge: CASE_BANK_JUDGE,
  overlays: REPLAY.overlays,
};

const CASE_BANK_TOKENS: GateTokenTally = {
  proposal: { input: 412, output: 137 },
  incumbent: { input: 900, output: 120 },
  candidate: { input: 910, output: 110 },
  judge: { input: 300, output: 20 },
  total: { input: 2522, output: 387 },
};

// The block of a gate in a given status, field for field what the schema of that status requires: the
// preregistration exists once the gate was preregistered, and the result exists once it concluded. The
// switch is exhaustive over GATE_STATUSES, so a status added to the union loses its case here.
function gateWith(status: GateStatus): GateBlock {
  switch (status) {
    case "not-run":
      return {
        basis: "replay",
        status: "not-run",
        budget: { plannedRuns: 0, usedRuns: 0, interruptedAt: null },
        tokens: ZERO_TOKENS,
        preregistration: null,
        replay: null,
      };
    case "preregistered":
      return {
        basis: "replay",
        status: "preregistered",
        budget: PLANNED_BUDGET,
        tokens: ZERO_TOKENS,
        preregistration: PREREGISTRATION,
        replay: null,
      };
    case "gate-accepted":
    case "gate-rejected":
    case "gate-abstained":
      return {
        basis: "replay",
        status,
        budget: SPENT_BUDGET,
        tokens: ZERO_TOKENS,
        preregistration: PREREGISTRATION,
        // The verdict of the result and the status of the block are the same value here, as they are in a
        // record the flow writes: the schema cannot tie them either, so the fixture says it once.
        replay: { ...REPLAY, verdict: status },
      };
    default:
      return assertNever(status);
  }
}

// The block of a gate of the second base, in the state its status names. It is the counterpart of gateWith and it exists
// so the five records of this base -- two states without a result and three with one -- are one helper and not five
// literals that could disagree with each other. The switch is exhaustive over GATE_STATUSES, so a status added to the
// union loses its case here too.
function caseBankWith(status: GateStatus): GateBlock {
  switch (status) {
    case "not-run":
      return {
        basis: "case-bank",
        status: "not-run",
        budget: { plannedRuns: 0, usedRuns: 0, interruptedAt: null },
        tokens: ZERO_TOKENS,
        preregistration: null,
        replay: null,
        caseBank: null,
      };
    case "preregistered":
      return {
        basis: "case-bank",
        status: "preregistered",
        budget: { plannedRuns: 8, usedRuns: 0, interruptedAt: null },
        tokens: ZERO_TOKENS,
        preregistration: CASE_BANK_PREREGISTRATION,
        replay: null,
        caseBank: null,
      };
    case "gate-accepted":
    case "gate-rejected":
    case "gate-abstained":
      return {
        basis: "case-bank",
        status,
        budget: { plannedRuns: 8, usedRuns: 2, interruptedAt: null },
        tokens: CASE_BANK_TOKENS,
        preregistration: CASE_BANK_PREREGISTRATION,
        replay: null,
        // The verdict of the result and the status of the block are the same value here too, and the keyword that would
        // tie them is one schema 1 does not use.
        caseBank: { ...CASE_BANK_RESULT, verdict: status },
      };
    default:
      return assertNever(status);
  }
}

// One node of the schema on disk, named by the keys that lead to it. A node that is not there is a failure
// and never a silent pass, so a comparison below cannot agree with a node the file does not have.
function schemaNode(...keys: string[]): Record<string, unknown> {
  let current: unknown = loadDecisionSchema();
  for (const key of keys) {
    current = isPlainObject(current) ? current[key] : undefined;
  }
  if (!isPlainObject(current)) assert.fail(`the schema node ${keys.join(".")} is not an object`);
  return current;
}

interface Fixture {
  base: string;
  pkg: string;
  skillDir: string;
}

function createFixture(t: TestContext): Fixture {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-decision-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const pkg = path.join(base, "pi-simple-sri");
  const skillDir = path.join(base, "skills", "pdf-tools");
  fs.mkdirSync(pkg, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });

  return { base, pkg, skillDir };
}

// The branch and the dependencies of a run, as the flow tests build them: one prompt, one bash call and
// its error is the smallest branch that yields evidence and a turn a replay could test, and every seam
// but the writer and the index is replaced so this test reads the file the writer really published.
const WORK_DIR = "/work/reports";
const BASE_MS = Date.parse("2026-11-02T14:00:00.000Z");

const RUN_USAGE: Usage = {
  input: 412,
  output: 137,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 549,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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
    usage: RUN_USAGE,
    stopReason: "toolUse",
    timestamp: BASE_MS + 1000,
  };

  return [
    {
      type: "message",
      id: "entry-0",
      parentId: null,
      timestamp: instant(0),
      message: { role: "user", content: "extract the merged-cell table from report.pdf", timestamp: BASE_MS },
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
    cwd: WORK_DIR,
    model: undefined,
    modelRegistry: {
      complete: async () => {
        throw new Error("this test injects the proposer and never reaches the session model");
      },
    },
    sessionManager: { getBranch: () => [...branch], getSessionId: () => "session-test" },
  };
}

// A proposer that answers what a model would: one lesson for the evidence it was handed.
function proposerForTest(): ProposeFn {
  return async (input) => {
    const draft: LessonDraft = {
      slug: LESSON_SLUG,
      title: LESSON_TITLE,
      date: "2026-11-02",
      status: "proposed",
      sourceEvidence: input.evidence.map((item) => item.id),
      gate: "pending",
      body: "Use pdfplumber with the lattice strategy for merged cells.",
    };
    const lesson = serializeLesson(draft);
    if (!lesson.ok) assert.fail(`the lesson of this test must serialize: ${lesson.error}`);
    return { ok: true, value: { draft, lessonText: lesson.value, usage: { input: 412, output: 137 } } };
  };
}

function flowDeps(fixture: Fixture, skill: SkillRef): ImproveFlowDeps {
  return {
    base: fixture.pkg,
    now: () => new Date(CREATED_AT),
    readConfig: () => ({ allow: [], deny: [] }),
    listSkills: async () => [skill],
    readSkillText: async () => "# pdf-tools\n\nUse pdftotext for plain text.\n",
    propose: proposerForTest(),
    // The write and the index line are the real ones: the file this test validates is the file they
    // publish, produced by the writer that stamps the hashes.
  };
}

// A SkillRef with every inventory field populated: the block of the record is built from it, never
// assigned from it, and description, hasLessons and kind must not travel with the record.
function makeSkillRef(overrides: Partial<SkillRef> = {}): SkillRef {
  return {
    name: "pdf-tools",
    description: "Extract tables from PDFs",
    dir: "/skills/pdf-tools",
    realDir: "/skills/pdf-tools",
    hasLessons: true,
    kind: "declared",
    ...overrides,
  };
}

function makeDecision(skill: DecisionSkill = toDecisionSkill(makeSkillRef(), true)): DecisionRecord {
  return {
    schema: "pi-simple-sri/decision@1",
    createdAt: CREATED_AT,
    trigger: { surface: "command", focus: null },
    skill,
    eligibility: { allow: [], deny: [] },
    evidence: [
      {
        id: EVIDENCE_ID,
        kind: "tool_error",
        toolName: "bash",
        argsHash: CONTENT_HASH,
        excerpt: "pdftotext collapses merged cells",
        timestamp: 1_762_082_602_481,
        source: "transcript",
      },
    ],
    diagnosis: {
      summary: "Table extraction loses merged cells",
      failureSignature: FAILURE_SIGNATURE,
      replayItems: [
        { prompt: "extract the table", cwd: "/work", expectation: { class: "tool_error", version: 1, tool: "bash" } },
      ],
    },
    candidate: {
      kind: "new-lesson",
      slug: LESSON_SLUG,
      title: LESSON_TITLE,
      targetLesson: null,
      lessonPath: `lessons/${LESSON_SLUG}.md`,
      contentHash: CONTENT_HASH,
      bodyHash: BODY_HASH,
    },
    gate: gateWith("not-run"),
    outcome: { status: "proposed", reason: null, decidedAt: null },
  };
}

// The record the command builds, before the writer stamps the two hashes. It needs no disk, so the
// negative cases below derive from it.
const VALID_RECORD: DecisionRecord = makeDecision();

function lessonTextForTest(): string {
  const draft: LessonDraft = {
    slug: LESSON_SLUG,
    title: LESSON_TITLE,
    date: "2026-11-02",
    status: "proposed",
    sourceEvidence: [EVIDENCE_ID],
    gate: "pending",
    body: "Use pdfplumber with the lattice strategy for merged cells.",
  };
  const serialized = serializeLesson(draft);
  if (!serialized.ok) {
    assert.fail(`the lesson of this test must serialize: ${serialized.error}`);
  }
  return serialized.value;
}

test("decision.json: the record the writer publishes satisfies schemas/decision.schema.json", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkillRef({ dir: fixture.skillDir, realDir: fs.realpathSync(fixture.skillDir) });

  const result = await writeStagingCandidate({
    base: fixture.pkg,
    skill,
    slug: LESSON_SLUG,
    decision: makeDecision(toDecisionSkill(skill, true)),
    now: new Date(CREATED_AT),
    lessonText: lessonTextForTest(),
  });

  const document: unknown = JSON.parse(fs.readFileSync(result.decisionPath, "utf8"));

  // The reader is proven by the negative cases below; on the published record it must find nothing,
  // which is the exit criterion: every required field present, no field outside the schema, every
  // pattern matched, and the two hashes stamped by the writer in the documented form.
  assert.deepEqual(validateAgainstSchema(document), []);
});

test("validateAgainstSchema: the record the command builds has no violations", () => {
  assert.deepEqual(validateAgainstSchema(VALID_RECORD), []);
});

// G2 from the other end: the literal above is a fixture, and what the package has to satisfy is the file a
// run publishes. The same reader validates the decision.json a proposeSkill run leaves in staging, so a
// field the flow calculates -- the verdict of the skill block, the two hashes, the shape of the gate block
// -- is checked against the schema and not only against itself.
test("decision.json: the record a proposeSkill run publishes satisfies schemas/decision.schema.json", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkillRef({ dir: fixture.skillDir, realDir: fs.realpathSync(fixture.skillDir) });

  const result = await proposeSkill(
    { surface: "command", skillName: "pdf-tools", focus: "merged cells" },
    flowContext(failingBranch()),
    flowDeps(fixture, skill),
  );

  if (result.kind !== "proposed") assert.fail(`expected a candidate, got ${result.kind}`);
  // The record names the candidate relative to the base of the run, so the read joins the two.
  const document: unknown = JSON.parse(
    fs.readFileSync(path.join(fixture.pkg, result.staged.decisionPath), "utf8"),
  );

  assert.deepEqual(validateAgainstSchema(document), []);
});

// Q2: TypeScript is structural, so assigning a SkillRef to a field typed DecisionSkill compiles and
// the inventory-only fields travel to decision.json unseen; the schema is what rejects them. The
// command converts through toDecisionSkill instead.
test("toDecisionSkill: builds exactly the five fields the schema declares", () => {
  const skill = makeSkillRef({ dir: "/skills/pdf-tools", realDir: "/opt/skills/pdf-tools" });

  const block = toDecisionSkill(skill, false);

  assert.deepEqual(block, {
    name: "pdf-tools",
    dir: "/skills/pdf-tools",
    realDir: "/opt/skills/pdf-tools",
    wasSymlink: true,
    eligible: false,
  });
  assert.deepEqual(Object.keys(block).sort(), ["dir", "eligible", "name", "realDir", "wasSymlink"]);
  assert.equal(Object.hasOwn(block, "description"), false);
  assert.equal(Object.hasOwn(block, "hasLessons"), false);
  assert.equal(Object.hasOwn(block, "kind"), false);

  // The two paths that agree are a skill that is not symlinked.
  assert.equal(toDecisionSkill(makeSkillRef(), true).wasSymlink, false);

  // A record whose skill block comes from the conversion satisfies the schema; the first negative
  // case below is the same record with the SkillRef assigned instead.
  assert.deepEqual(validateAgainstSchema(makeDecision(block)), []);
});

// §TECHNICAL 3: gate.status and outcome.status are related by one mapping, and this is the proof that it is
// total over the statuses the schema declares and that every status it answers is one the schema accepts.
// The schema ties no two properties together, so the agreement of the two fields is a property of the code
// and of this test, and never of the validator.
test("outcomeStatusFor: every gate status maps to an outcome status the schema accepts", () => {
  for (const gateStatus of GATE_STATUSES) {
    const status = outcomeStatusFor(gateStatus);
    const record: DecisionRecord = {
      ...VALID_RECORD,
      gate: gateWith(gateStatus),
      // A candidate that was only proposed has no moment that decided it; every other status was decided
      // when the gate concluded, and the record says when.
      outcome: {
        status,
        reason: null,
        decidedAt: status === "proposed" ? null : "2026-11-02T14:20:00.000Z",
      },
    };

    assert.deepEqual(validateAgainstSchema(record), [], `the record of a gate in status ${gateStatus}`);
  }
});

// The mapping itself, written out: a gate that decided is named by the outcome, and a gate that has not
// decided is not named by it -- a preregistered gate has no verdict to report, so the record goes on saying
// the candidate was proposed.
test("outcomeStatusFor: a gate that decided is the outcome, a gate that did not leaves it proposed", () => {
  assert.deepEqual(GATE_STATUSES.map(outcomeStatusFor), [
    "proposed",
    "proposed",
    "gate-accepted",
    "gate-rejected",
    "gate-abstained",
  ]);
  // An outcome the acceptance decides is not implied by any gate status, which is why the acceptance
  // writes it with the moment it decided.
  assert.equal(GATE_STATUSES.map(outcomeStatusFor).includes("accepted"), false);
});

// One list of statuses, two files: the type derives them from the array and the schema declares them as an
// enum, so a status this package can write but the schema refuses (or the other way round) fails here
// instead of in a record that silently does not validate.
test("decision.schema.json: the gate statuses of the schema are the ones src/types.ts declares", () => {
  assert.deepEqual(schemaNode("properties", "gate", "properties", "status").enum, [...GATE_STATUSES]);
});

// The block's discriminator is `basis`, and schema 1 declares two: widening it is what makes a second kind of gate a
// record of the same schema instead of a version of its own, and it is the only change of this slice that touches a
// keyword instead of adding a key.
test("decision.schema.json: the bases of the gate block are the two the variants declare", () => {
  assert.deepEqual(schemaNode("properties", "gate", "properties", "basis").enum, ["replay", "case-bank"]);
});

// M1c, the exit criterion of the slice from the other end: a record of the second base validates in every state it can be
// written in -- not-run, preregistered, and the three a concluded gate has. The five records are built by one helper, so
// the states the fixture names are the states GATE_STATUSES declares.
test("decision.schema.json: a case-bank gate validates in every status it can hold", () => {
  for (const gateStatus of GATE_STATUSES) {
    const record: DecisionRecord = {
      ...VALID_RECORD,
      gate: caseBankWith(gateStatus),
      outcome: {
        status: outcomeStatusFor(gateStatus),
        reason: null,
        // A gate that has not concluded decided no moment; the three verdicts did.
        decidedAt: gateStatus === "not-run" || gateStatus === "preregistered" ? null : "2026-11-02T14:20:00.000Z",
      },
    };

    assert.deepEqual(validateAgainstSchema(record), [], `the record of a case-bank gate in status ${gateStatus}`);
  }
});

// The two keys M1c adds are optional, and a record written before them keeps validating: this is the additive half of the
// slice stated by the record itself -- the block of the second base with neither of them, and the block of the replay
// base with no `caseBank` key at all.
test("decision.schema.json: skillContentHash and caseBank are optional, and their absence validates", () => {
  const { skillContentHash: _omitted, caseBank: _noBank, ...withoutMaterials } = CASE_BANK_PREREGISTRATION;
  const record: DecisionRecord = {
    ...VALID_RECORD,
    gate: {
      basis: "case-bank",
      status: "preregistered",
      budget: { plannedRuns: 8, usedRuns: 0, interruptedAt: null },
      tokens: ZERO_TOKENS,
      preregistration: withoutMaterials,
      replay: null,
      caseBank: null,
    },
    outcome: { status: "proposed", reason: null, decidedAt: null },
  };

  assert.deepEqual(validateAgainstSchema(record), []);
  // The block M1 writes keeps validating too, which is what "no record written before this slice stops validating" means
  // for the key the second base uses.
  assert.deepEqual(validateAgainstSchema(VALID_RECORD), []);
});

// M1c: the fourth class is judged on a list of failures, and the list is there when some check failed -- the negative
// case of an empty list below is what pins the other half, that a run which failed names what it failed.
test("decision.schema.json: a run that failed its checks carries the list of the checks it failed", () => {
  const [item] = REPLAY.items;
  const [first, ...rest] = item.reps;
  const record: DecisionRecord = {
    ...VALID_RECORD,
    gate: {
      basis: "replay",
      status: "gate-accepted",
      budget: SPENT_BUDGET,
      tokens: ZERO_TOKENS,
      preregistration: PREREGISTRATION,
      replay: {
        ...REPLAY,
        verdict: "gate-accepted",
        items: [{ ...item, reps: [{ ...first, outcome: "fail", checkFailures: ["1:not-contains"] }, ...rest] }],
      },
    },
    outcome: { status: "gate-accepted", reason: null, decidedAt: "2026-11-02T14:20:00.000Z" },
  };

  assert.deepEqual(validateAgainstSchema(record), []);
});

// M2 and M3: the two fields a run gained are optional, so the schema of schema 1 accepts a run that carries
// them and a run written before they existed. `truncatedAt` is the byte length the cap cut and `invalidDetail`
// is what the process said, and neither is required by the record of a run nobody can read.
test("decision.schema.json: truncatedAt and invalidDetail are optional and validate when they are there", () => {
  const [item] = REPLAY.items;
  const [first, ...rest] = item.reps;
  // A run the cap cut and whose process said why: the two fields this version added, with the reason the
  // runner gives for a truncated stream.
  const broken: ReplayRunRecord = {
    ...first,
    outcome: "invalid",
    invalidReason: "stream-truncated",
    truncatedAt: 3 * 1024 * 1024,
    invalidDetail: "spawn pi ENOENT",
  };
  const withTheFields: GateReplayResult = {
    ...REPLAY,
    // A truncated run is invalid, so the verdict of the block follows the reading: the schema ties no run to a
    // verdict, and the records the flow writes are the ones the suites of the gate validate.
    verdict: "gate-abstained",
    items: [{ ...item, reps: [broken, ...rest] }],
  };
  const record: DecisionRecord = {
    ...VALID_RECORD,
    gate: {
      basis: "replay",
      status: "gate-abstained",
      budget: SPENT_BUDGET,
      tokens: ZERO_TOKENS,
      preregistration: PREREGISTRATION,
      replay: withTheFields,
    },
    outcome: { status: "gate-abstained", reason: "invalid-run", decidedAt: "2026-11-02T14:20:00.000Z" },
  };

  assert.deepEqual(validateAgainstSchema(record), []);
  // The same record without them, which every version wrote before these two fields existed.
  assert.deepEqual(validateAgainstSchema({ ...VALID_RECORD, gate: gateWith("gate-abstained") }), []);
});

// M1c: the fourth class exists as data, and so does the artifact that originated it. `kind` and `origin` are
// independent keys of the schema -- tying them would be a condition on another property -- so each is pinned on its
// own here, and a record written before the class existed keeps validating: both changes are additive.
test("decision.schema.json: an evidence item of the fourth class carries the origin of its artifact", () => {
  const [item] = VALID_RECORD.evidence;
  const defect: EvidenceItem = {
    ...item,
    kind: "quality_defect",
    excerpt: "the skill says git rebase --squash-all is how an interactive rebase is done",
    origin: { kind: "review-finding", path: "/work/reports/review.md", contentHash: CONTENT_HASH },
  };

  assert.deepEqual(validateAgainstSchema({ ...VALID_RECORD, evidence: [defect] }), []);
  // `origin` is optional for every class, including the new one: the relation between the two keys is a property of
  // the code and not of the validator, which is why the negative cases below inject one key at a time.
  assert.deepEqual(validateAgainstSchema({ ...VALID_RECORD, evidence: [{ ...item, kind: "quality_defect" }] }), []);
});

// The predicate of the class travels with the evidence and not with the class: an expectation of a defect carries the
// checks its case bank declared.
test("decision.schema.json: a quality_defect expectation validates with and without its checks", () => {
  const checks: readonly CaseCheck[] = [
    { kind: "contains", value: "--interactive" },
    { kind: "not-contains", value: "--squash-all" },
    { kind: "not-regex", pattern: "no (existe|soportado)", flags: "i" },
  ];
  const recordWith = (expectation: Expectation): DecisionRecord => ({
    ...VALID_RECORD,
    diagnosis: {
      ...VALID_RECORD.diagnosis,
      replayItems: [{ prompt: "which flags does git rebase accept", cwd: "/work", expectation }],
    },
  });

  assert.deepEqual(validateAgainstSchema(recordWith({ class: "quality_defect", version: 1, checks })), []);
  // An expectation of the class without checks validates too: the keyword that would relate the two is a condition on
  // `class`, and schema 1 stays additive. The relation has one owner in the code, and the two assertions below are the
  // proof that it is closed there and not here.
  assert.deepEqual(validateAgainstSchema(recordWith({ class: "quality_defect", version: 1 })), []);

  assert.equal(expectationViolation({ class: "quality_defect", version: 1, checks }), undefined);
  assert.notEqual(expectationViolation({ class: "quality_defect", version: 1 }), undefined);
});

// One vocabulary of a check, two files: the array src/checks.ts exports and the enum of the schema. Both appearances of
// the expectation carry it, and the comparison runs over both, for the same reason the statuses are compared above.
test("decision.schema.json: the check kinds of the schema are the ones src/checks.ts declares", () => {
  const inDiagnosis = schemaNode(
    "properties",
    "diagnosis",
    "properties",
    "replayItems",
    "items",
    "properties",
    "expectation",
    "properties",
    "checks",
    "items",
    "properties",
    "kind",
  );
  const inReplay = schemaNode(
    "properties",
    "gate",
    "properties",
    "replay",
    "properties",
    "items",
    "items",
    "properties",
    "expectation",
    "properties",
    "checks",
    "items",
    "properties",
    "kind",
  );

  assert.deepEqual(inDiagnosis.enum, [...CASE_CHECK_KINDS]);
  assert.deepEqual(inReplay.enum, [...CASE_CHECK_KINDS]);
});

// M1c, S7 (OA2): the diagnosis of a directional attempt replays nothing, so the schema stops requiring an item and the
// guard moves to the constructor of the base that needs one (src/diagnosis.ts, buildDiagnosis). Relaxing minItems is the
// one change of this slice that touches a keyword already written, and it invalidates no record: everything written
// before it has an item, and an item is still an item.
test("decision.schema.json: a diagnosis with no replay item validates in the base of the bank", () => {
  const record: DecisionRecord = {
    ...VALID_RECORD,
    // The other half of the same base: no evidence item either, because the failures of the run are the cases of the
    // bank and the gate reads them when it runs.
    evidence: [],
    diagnosis: { ...VALID_RECORD.diagnosis, replayItems: [] },
    gate: caseBankWith("not-run"),
  };

  assert.deepEqual(validateAgainstSchema(record), []);
  // The keyword itself, read from the file: zero is the floor the schema states now.
  assert.equal(schemaNode("properties", "diagnosis", "properties", "replayItems").minItems, 0);
  // The schema ties the number of items to no basis, which is why the same empty diagnosis validates under the other
  // one too: the guard that refuses it there is the constructor of that base and not the validator.
  assert.deepEqual(
    validateAgainstSchema({ ...VALID_RECORD, diagnosis: { ...VALID_RECORD.diagnosis, replayItems: [] } }),
    [],
  );
});

interface NegativeCase {
  name: string;
  build: () => unknown;
  expected: readonly string[];
}

const NEGATIVE_CASES: readonly NegativeCase[] = [
  {
    name: "a skill block carrying the inventory fields",
    // What a command that spreads the inventory skill and adds the verdict would write: the five
    // fields the schema declares are all there, plus the three that belong to the inventory.
    build: () => ({ ...VALID_RECORD, skill: { ...makeSkillRef(), wasSymlink: false, eligible: true } }),
    expected: [
      'decision.skill: the property "description" is not declared by the schema (additionalProperties: false)',
      'decision.skill: the property "hasLessons" is not declared by the schema (additionalProperties: false)',
      'decision.skill: the property "kind" is not declared by the schema (additionalProperties: false)',
    ],
  },
  {
    name: "an outcome status outside the enum",
    // "gate-passed" is the spelling a caller would reach for and the one no status of this package uses:
    // the enum is what decides which statuses exist, and the negative has to stay outside it.
    build: () => ({ ...VALID_RECORD, outcome: { ...VALID_RECORD.outcome, status: "gate-passed" } }),
    expected: [
      'decision.outcome.status: expected one of "proposed", "not-eligible", "gate-accepted", "gate-rejected", "gate-abstained", "accepted", got "gate-passed"',
    ],
  },
  {
    name: "an outcome status the vocabulary no longer declares",
    // "accept-failed" was declared and never written: an acceptance that fails writes nothing, so the staged
    // record keeps "gate-accepted" and the reason reaches the caller. The status is gone from both files, and
    // this case is what keeps a writer from reintroducing it on one side only.
    build: () => ({ ...VALID_RECORD, outcome: { ...VALID_RECORD.outcome, status: "accept-failed" } }),
    expected: [
      'decision.outcome.status: expected one of "proposed", "not-eligible", "gate-accepted", "gate-rejected", "gate-abstained", "accepted", got "accept-failed"',
    ],
  },
  {
    name: "a negative assistant cycle index",
    build: () => ({
      ...VALID_RECORD,
      diagnosis: {
        ...VALID_RECORD.diagnosis,
        replayItems: VALID_RECORD.diagnosis.replayItems.map((item) => ({ ...item, assistantCycleIndex: -1 })),
      },
    }),
    expected: ["decision.diagnosis.replayItems[0].assistantCycleIndex: -1 is below the minimum 0"],
  },
  {
    name: "a required property of the candidate that is missing",
    build: () => {
      // Destructured away instead of deleted: the rest of the block stays exactly as the command
      // builds it, and a missing field is what the schema's required list is for.
      const { bodyHash: _omitted, ...withoutBodyHash } = VALID_RECORD.candidate;
      return { ...VALID_RECORD, candidate: withoutBodyHash };
    },
    expected: ['decision.candidate: the required property "bodyHash" is missing'],
  },
  {
    name: "a basis of the gate that schema 1 does not know",
    // §TECHNICAL 5: `basis` is the discriminator, so a block of a basis this schema does not declare is
    // refused whole instead of being read as a replay block with fields missing. M1c widened the keyword to the two
    // bases the package writes, and the negative has to stay outside both of them.
    build: () => ({ ...VALID_RECORD, gate: { ...VALID_RECORD.gate, basis: "manual" } }),
    expected: ['decision.gate.basis: expected one of "replay", "case-bank", got "manual"'],
  },
  {
    name: "an expectation class outside the enum",
    // The classes are the closed set the gate knows how to verify (Q18): a class outside it would be an
    // expectation no checker can run, which is worse than no expectation at all.
    build: () => ({
      ...VALID_RECORD,
      diagnosis: {
        ...VALID_RECORD.diagnosis,
        replayItems: VALID_RECORD.diagnosis.replayItems.map((item) => ({
          ...item,
          expectation: { class: "latency", version: 1 },
        })),
      },
    }),
    expected: [
      'decision.diagnosis.replayItems[0].expectation.class: expected one of "tool_error", "retry_loop", "user_correction", "quality_defect", got "latency"',
    ],
  },
  {
    name: "an origin kind outside the enum",
    // The two kinds of an origin are the closed vocabulary of how a defect was found, and the one negative case that
    // pins it: a value outside the enum is a record nobody can classify.
    build: () => ({
      ...VALID_RECORD,
      evidence: [
        {
          ...VALID_RECORD.evidence[0],
          kind: "quality_defect",
          origin: { kind: "reported", path: "/work/reports/review.md", contentHash: CONTENT_HASH },
        },
      ],
    }),
    expected: [
      'decision.evidence[0].origin.kind: expected one of "review-finding", "rejected-draft", got "reported"',
    ],
  },
  {
    name: "an origin with a property the schema does not declare",
    // additionalProperties: false is what keeps the origin a three-field record instead of an open bag of metadata, and
    // the keyword needs its own case like any other.
    build: () => ({
      ...VALID_RECORD,
      evidence: [
        {
          ...VALID_RECORD.evidence[0],
          origin: { kind: "review-finding", path: "/work/reports/review.md", contentHash: CONTENT_HASH, line: 12 },
        },
      ],
    }),
    expected: [
      'decision.evidence[0].origin: the property "line" is not declared by the schema (additionalProperties: false)',
    ],
  },
  {
    name: "a check whose kind is outside the vocabulary",
    // The four kinds are the whole predicate the gate can execute (M1c): a fifth name here would be a check nobody can
    // run, which is worse than a case with no check at all.
    build: () => ({
      ...VALID_RECORD,
      diagnosis: {
        ...VALID_RECORD.diagnosis,
        replayItems: VALID_RECORD.diagnosis.replayItems.map((item) => ({
          ...item,
          expectation: { class: "quality_defect", version: 1, checks: [{ kind: "equals", value: "--interactive" }] },
        })),
      },
    }),
    expected: [
      'decision.diagnosis.replayItems[0].expectation.checks[0].kind: expected one of "contains", "not-contains", "regex", "not-regex", got "equals"',
    ],
  },
  {
    name: "an empty list of checks",
    // A defect with no check is a defect with no condition: minItems is the only part of the rule the schema can state,
    // because which field a check needs depends on its kind and that relation is src/checks.ts's.
    build: () => ({
      ...VALID_RECORD,
      diagnosis: {
        ...VALID_RECORD.diagnosis,
        replayItems: VALID_RECORD.diagnosis.replayItems.map((item) => ({
          ...item,
          expectation: { class: "quality_defect", version: 1, checks: [] },
        })),
      },
    }),
    expected: ["decision.diagnosis.replayItems[0].expectation.checks: the array has 0 items, fewer than 1"],
  },
  {
    name: "a replay result with a negative number of regressions",
    build: () => ({ ...VALID_RECORD, gate: { ...VALID_RECORD.gate, replay: { ...REPLAY, regressions: -1 } } }),
    expected: ["decision.gate.replay.regressions: -1 is below the minimum 0"],
  },
  {
    name: "a property the schema does not declare under the gate",
    // §TECHNICAL 5: a second basis is a branch of this block and a decision, not a hole. additionalProperties:
    // false is what makes that true, so the keyword is pinned by a case of its own -- with a key that still
    // belongs nowhere, because `caseBank` is declared now.
    build: () => ({ ...VALID_RECORD, gate: { ...VALID_RECORD.gate, judge: { required: "pass" } } }),
    expected: ['decision.gate: the property "judge" is not declared by the schema (additionalProperties: false)'],
  },
  {
    name: "a property the schema does not declare under caseBank",
    // M1c extends the block with a branch of its own and closes it the same way: the result of the second base is a
    // shape and not an open bag of metadata, which is what keeps a field the package does not write from travelling
    // in a record nobody re-reads.
    build: () => ({
      ...VALID_RECORD,
      gate: { ...caseBankWith("gate-accepted"), caseBank: { ...CASE_BANK_RESULT, notes: ["the bank was fine"] } },
    }),
    expected: ['decision.gate.caseBank: the property "notes" is not declared by the schema (additionalProperties: false)'],
  },
  {
    name: "a judge clause without the hash of the rubric it applies",
    // The clause is a pair: `required` says what the judge has to answer and `rubricHash` pins the text it applied, so a
    // clause that carries only the first announces a condition nobody can re-read.
    build: () => ({
      ...VALID_RECORD,
      gate: {
        ...gateWith("gate-accepted"),
        preregistration: {
          ...PREREGISTRATION,
          threshold: { ...PREREGISTRATION.threshold, judge: { required: "pass" } },
        },
      },
    }),
    expected: ['decision.gate.preregistration.threshold.judge: the required property "rubricHash" is missing'],
  },
  {
    name: "a judge call with a verdict outside the enum",
    // A call answers pass or fail and nothing else: `not-run` is the verdict of the whole set when the judge was never
    // asked, and it is not something one of its calls can say.
    build: () => ({
      ...VALID_RECORD,
      gate: {
        ...caseBankWith("gate-accepted"),
        caseBank: {
          ...CASE_BANK_RESULT,
          judge: { ...CASE_BANK_JUDGE, calls: [{ ...CASE_BANK_JUDGE.calls[0], verdict: "maybe" }] },
        },
      },
    }),
    expected: ['decision.gate.caseBank.judge.calls[0].verdict: expected one of "pass", "fail", got "maybe"'],
  },
  {
    name: "an empty list of check failures",
    // The list is a reading of a run that failed some check: empty, it would say a run failed and name nothing, which is
    // why the schema declares minItems 1 (S2) and this case pins it.
    build: () => {
      const [item] = REPLAY.items;
      const [first, ...rest] = item.reps;
      return {
        ...VALID_RECORD,
        gate: {
          ...gateWith("gate-accepted"),
          replay: { ...REPLAY, items: [{ ...item, reps: [{ ...first, outcome: "fail", checkFailures: [] }, ...rest] }] },
        },
      };
    },
    expected: ["decision.gate.replay.items[0].reps[0].checkFailures: the array has 0 items, fewer than 1"],
  },
];

for (const entry of NEGATIVE_CASES) {
  test(`validateAgainstSchema: reports ${entry.name}`, () => {
    const violations = validateAgainstSchema(entry.build());

    // The whole list is compared: one violation per injected fault, no more, so the reader is not
    // reporting something else instead.
    assert.deepEqual(violations, [...entry.expected]);
  });
}
