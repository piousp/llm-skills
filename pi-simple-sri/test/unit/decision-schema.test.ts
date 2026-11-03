import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import { proposeSkill, type ImproveFlowContext, type ImproveFlowDeps, type ProposeFn } from "../../src/improve-flow.ts";
import { serializeLesson } from "../../src/lesson-frontmatter.ts";
import { toDecisionSkill } from "../../src/types.ts";
import type { DecisionRecord, DecisionSkill, LessonDraft, SkillRef } from "../../src/types.ts";
import { isPlainObject } from "../../src/values.ts";
import { writeStagingCandidate } from "../../src/writer.ts";

// G2: the exit criterion of M0 is that the decision.json the writer publishes satisfies
// schemas/decision.schema.json. No JSON Schema validator is a dependency (ajv is not installed), so
// the constraints the schema declares are checked by the small reader below, which lives in this
// file and is not exported.

const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "decision.schema.json");
const DECISION_SCHEMA: unknown = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));

const LESSON_SLUG = "extract-tables-with-merged-cells";
const LESSON_TITLE = "Extract tables with merged cells";
const CREATED_AT = "2026-11-02T14:03:22.481Z";
const EVIDENCE_ID = "ev-3f9a1c02";
const CONTENT_HASH = `sha256:${"a".repeat(64)}`;
const BODY_HASH = `sha256:${"b".repeat(64)}`;
const FAILURE_SIGNATURE = `sha256:${"c".repeat(64)}`;

// The schema declares createdAt as format: "date-time" and every date-time this package writes
// comes from Date#toISOString, so the accepted shape is the UTC one with milliseconds.
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// The keywords schemas/decision.schema.json uses, one function per family: type, const, enum,
// pattern, format date-time, minLength, maxLength, minimum, minItems, required, properties, items
// and additionalProperties: false. A keyword the schema adds later and this reader does not know is
// ignored, which is why the negative cases below pin what it does catch.
function validateAgainstSchema(document: unknown): string[] {
  const violations: string[] = [];
  collectViolations(document, DECISION_SCHEMA, "decision", violations);
  return violations;
}

function collectViolations(value: unknown, schemaNode: unknown, at: string, violations: string[]): void {
  if (!isPlainObject(schemaNode)) {
    violations.push(`${at}: the schema node is not an object`);
    return;
  }

  checkType(value, schemaNode.type, at, violations);
  checkConst(value, schemaNode, at, violations);
  checkEnum(value, schemaNode.enum, at, violations);
  checkString(value, schemaNode, at, violations);
  checkNumber(value, schemaNode, at, violations);
  checkArray(value, schemaNode, at, violations);
  checkObject(value, schemaNode, at, violations);
}

function checkType(value: unknown, declared: unknown, at: string, violations: string[]): void {
  const types = declaredTypes(declared);
  if (types.length === 0 || types.some((type) => matchesType(value, type))) {
    return;
  }
  violations.push(`${at}: expected ${types.join(" or ")}, got ${describe(value)}`);
}

// `type` is a string or a list of strings in JSON Schema. A type this reader does not know fails
// the check instead of passing silently, so a keyword added to the schema surfaces here.
function declaredTypes(declared: unknown): readonly string[] {
  if (typeof declared === "string") {
    return [declared];
  }
  if (!Array.isArray(declared)) {
    return [];
  }
  const entries: readonly unknown[] = declared;
  return entries.flatMap((entry) => (typeof entry === "string" ? [entry] : []));
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

function checkConst(value: unknown, schemaNode: Record<string, unknown>, at: string, violations: string[]): void {
  if (!Object.hasOwn(schemaNode, "const")) {
    return;
  }
  const expected = schemaNode.const;
  if (!isSameValue(value, expected)) {
    violations.push(`${at}: expected the constant ${describe(expected)}, got ${describe(value)}`);
  }
}

function checkEnum(value: unknown, options: unknown, at: string, violations: string[]): void {
  if (!Array.isArray(options)) {
    return;
  }
  const allowed: readonly unknown[] = options;
  if (allowed.some((option) => isSameValue(value, option))) {
    return;
  }
  violations.push(`${at}: expected one of ${allowed.map((option) => describe(option)).join(", ")}, got ${describe(value)}`);
}

function checkString(value: unknown, schemaNode: Record<string, unknown>, at: string, violations: string[]): void {
  if (typeof value !== "string") {
    return;
  }

  const pattern = schemaNode.pattern;
  if (typeof pattern === "string" && !new RegExp(pattern).test(value)) {
    violations.push(`${at}: ${describe(value)} does not match /${pattern}/`);
  }

  // Only the one format the schema declares is checked; an unknown format is an annotation.
  const format = schemaNode.format;
  if (format === "date-time" && !DATE_TIME_PATTERN.test(value)) {
    violations.push(`${at}: ${describe(value)} is not a date-time`);
  }

  const minLength = schemaNode.minLength;
  if (typeof minLength === "number" && value.length < minLength) {
    violations.push(`${at}: ${describe(value)} is shorter than ${minLength}`);
  }

  const maxLength = schemaNode.maxLength;
  if (typeof maxLength === "number" && value.length > maxLength) {
    violations.push(`${at}: ${describe(value)} is longer than ${maxLength}`);
  }
}

function checkNumber(value: unknown, schemaNode: Record<string, unknown>, at: string, violations: string[]): void {
  const minimum = schemaNode.minimum;
  if (typeof minimum !== "number" || typeof value !== "number") {
    return;
  }
  if (value < minimum) {
    violations.push(`${at}: ${value} is below the minimum ${minimum}`);
  }
}

function checkArray(value: unknown, schemaNode: Record<string, unknown>, at: string, violations: string[]): void {
  if (!Array.isArray(value)) {
    return;
  }
  const elements: readonly unknown[] = value;

  const minItems = schemaNode.minItems;
  if (typeof minItems === "number" && elements.length < minItems) {
    violations.push(`${at}: the array has ${elements.length} items, fewer than ${minItems}`);
  }

  const items = schemaNode.items;
  if (items === undefined) {
    return;
  }
  elements.forEach((element, index) => {
    collectViolations(element, items, `${at}[${index}]`, violations);
  });
}

function checkObject(value: unknown, schemaNode: Record<string, unknown>, at: string, violations: string[]): void {
  if (!isPlainObject(value)) {
    return;
  }

  const required = schemaNode.required;
  const requiredNames: readonly unknown[] = Array.isArray(required) ? required : [];
  for (const name of requiredNames) {
    if (typeof name === "string" && !Object.hasOwn(value, name)) {
      violations.push(`${at}: the required property "${name}" is missing`);
    }
  }

  const declaredProperties = schemaNode.properties;
  const properties: Record<string, unknown> = isPlainObject(declaredProperties) ? declaredProperties : {};
  for (const [key, childSchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, key)) {
      collectViolations(value[key], childSchema, `${at}.${key}`, violations);
    }
  }

  if (schemaNode.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        violations.push(`${at}: the property "${key}" is not declared by the schema (additionalProperties: false)`);
      }
    }
  }
}

// The schema only uses scalar const and enum values, so comparing their JSON form is enough.
function isSameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function describe(value: unknown): string {
  const json = JSON.stringify(value);
  return json ?? String(value);
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
    schema: "pi-simple-sri/decision@0",
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
      replayItems: [{ prompt: "extract the table", cwd: "/work", predicate: "cells 3 and 4 stay separate" }],
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
    gate: {
      status: "not-run",
      threshold: null,
      reps: null,
      budget: { plannedRuns: 0, usedRuns: 0, interruptedAt: null },
      tokens: { input: 0, output: 0 },
      mde: null,
    },
    outcome: { status: "proposed", reason: null },
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
  // which is the M0 exit criterion: every required field present, no field outside the schema, every
  // pattern matched, and the two hashes stamped by the writer in the documented form.
  assert.deepEqual(validateAgainstSchema(document), []);
});

test("validateAgainstSchema: the record the command builds has no violations", () => {
  assert.deepEqual(validateAgainstSchema(VALID_RECORD), []);
});

// G2 from the other end: the literal above is a fixture, and what M0 has to satisfy is the file a run
// publishes. The same reader validates the decision.json a proposeSkill run leaves in staging, so a
// field the flow calculates -- the verdict of the skill block, the two hashes -- is checked against the
// schema and not only against itself.
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
    build: () => ({ ...VALID_RECORD, outcome: { ...VALID_RECORD.outcome, status: "accepted" } }),
    expected: ['decision.outcome.status: expected one of "proposed", "not-eligible", got "accepted"'],
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
];

for (const entry of NEGATIVE_CASES) {
  test(`validateAgainstSchema: reports ${entry.name}`, () => {
    const violations = validateAgainstSchema(entry.build());

    // The whole list is compared: one violation per injected fault, no more, so the reader is not
    // reporting something else instead.
    assert.deepEqual(violations, [...entry.expected]);
  });
}
