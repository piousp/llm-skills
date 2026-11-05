import { test } from "node:test";
import assert from "node:assert/strict";
import { RETIREMENT_REASONS } from "../../src/retirement.ts";
import type { RetirementRecord } from "../../src/types.ts";
import { isPlainObject } from "../../src/values.ts";
import { loadRetirementSchema, validateAgainstRetirementSchema } from "./schema-reader.ts";

// M3 (S4): schemas/retirement.schema.json describes .history/<timestamp>/retirement.json, the record of a retirement, and
// this suite fixes what the contract catches. It is a contract of the document and not a reader of production: the record
// is written by src/writer.ts from the value src/retirement.ts builds, so no surface parses it back -- what this file
// proves is that the value the retirement builds is one this schema accepts, and that a record of another shape is
// refused by name.
//
// The positive case is the record the retirement of this suite produces, with the values it writes. The negative cases are
// one injected fault per case, so a keyword the schema adds later and the reader of test/unit/schema-reader.ts does not
// know shows up here as a case nobody could make fail.

const CREATED_AT = "2026-11-06T09:04:05.123Z";
const CONTENT_HASH = `sha256:${"a".repeat(64)}`;
const BODY_HASH = `sha256:${"b".repeat(64)}`;
const RETIRED_CONTENT_HASH = `sha256:${"c".repeat(64)}`;

function retirementRecord(): Record<string, unknown> {
  return {
    schema: "pi-simple-sri/retirement@1",
    createdAt: CREATED_AT,
    skill: {
      name: "pdf-tools",
      dir: "/skills/pdf-tools",
      realDir: "/skills/pdf-tools",
      wasSymlink: false,
    },
    lesson: {
      slug: "extract-merged-cells",
      title: "Extract merged cells with the lattice strategy",
      lessonPath: "lessons/extract-merged-cells.md",
      contentHash: CONTENT_HASH,
      bodyHash: BODY_HASH,
      retiredContentHash: RETIRED_CONTENT_HASH,
    },
    retires: { historyPath: ".history/20261102T150405123Z/decision.json" },
    reason: { key: "stale", detail: "the appendix stopped carrying merged cells in November" },
  };
}

function violationsOf(record: Record<string, unknown>): string[] {
  return validateAgainstRetirementSchema(record);
}

interface NegativeCase {
  name: string;
  record: () => Record<string, unknown>;
  // The part of the violation this case is about: the reader names the JSON pointer and the keyword it refused with.
  messagePart: string;
}

const NEGATIVE_CASES: readonly NegativeCase[] = [
  {
    name: "a reason key outside the vocabulary",
    record: () => ({ ...retirementRecord(), reason: { key: "obsolete", detail: "the appendix moved" } }),
    messagePart: "obsolete",
  },
  {
    name: "a hash that is not a sha256 digest",
    record: () => ({
      ...retirementRecord(),
      lesson: { ...lessonOf(retirementRecord()), contentHash: "sha256:abc" },
    }),
    messagePart: "/^sha256:[0-9a-f]{64}$/",
  },
  {
    name: "a retiredContentHash that is not a sha256 digest",
    record: () => ({
      ...retirementRecord(),
      lesson: { ...lessonOf(retirementRecord()), retiredContentHash: `sha256:${"A".repeat(64)}` },
    }),
    messagePart: "/^sha256:[0-9a-f]{64}$/",
  },
  {
    name: "a key the format does not declare",
    record: () => ({ ...retirementRecord(), merit: "none" }),
    messagePart: '"merit"',
  },
  {
    name: "a key the lesson block does not declare",
    record: () => ({ ...retirementRecord(), lesson: { ...lessonOf(retirementRecord()), status: "retired" } }),
    messagePart: '"status"',
  },
  {
    name: "a createdAt that is not a date-time",
    record: () => ({ ...retirementRecord(), createdAt: "2026-11-06 09:04" }),
    messagePart: "is not a date-time",
  },
  {
    name: "a record of another format",
    record: () => ({ ...retirementRecord(), schema: "pi-simple-sri/retirement@2" }),
    messagePart: "pi-simple-sri/retirement@2",
  },
  {
    name: "a record without its reason",
    record: () => {
      const record = retirementRecord();
      delete record.reason;
      return record;
    },
    messagePart: 'the required property "reason" is missing',
  },
  {
    name: "an empty detail",
    record: () => ({ ...retirementRecord(), reason: { key: "wrong", detail: "" } }),
    messagePart: "shorter than 1",
  },
  {
    name: "a lesson path outside lessons/",
    record: () => ({ ...retirementRecord(), lesson: { ...lessonOf(retirementRecord()), lessonPath: "../SKILL.md" } }),
    messagePart: "/^lessons/[^/]+\\.md$/",
  },
];

// The lesson block of the record, so a case can replace one field of it without repeating the other five. The parameter is
// the object a case built, which is the document under validation and not a trusted record.
function lessonOf(record: Record<string, unknown>): Record<string, unknown> {
  const lesson = record.lesson;
  if (!isPlainObject(lesson)) assert.fail("the fixture of this suite must carry a lesson block");
  return lesson;
}

test("the record the retirement writes satisfies the schema", () => {
  assert.deepEqual(violationsOf(retirementRecord()), []);
});

// The field that is a path when there is one and an explicit null when the line of the index named no record: the record
// says so instead of dropping the field, and the schema accepts both.
test("the schema accepts a retirement that names no record of an acceptance", () => {
  assert.deepEqual(violationsOf({ ...retirementRecord(), retires: { historyPath: null } }), []);
});

for (const negative of NEGATIVE_CASES) {
  test(`the schema refuses ${negative.name}`, () => {
    const violations = violationsOf(negative.record());

    assert.notEqual(violations.length, 0, "the record had to be refused and it was not");
    assert.ok(
      violations.some((violation) => violation.includes(negative.messagePart)),
      `expected a violation naming ${JSON.stringify(negative.messagePart)}, got ${JSON.stringify(violations)}`,
    );
  });
}

// The one literal of the format and the closed vocabulary of the reasons have owners (src/types.ts and src/retirement.ts),
// and the schema has to declare them as its `const` and as its enum: a schema that drifted from the writer would document
// a file nobody writes.
test("the schema declares the format and the reasons the retirement writes", () => {
  const schema: unknown = loadRetirementSchema();
  assert.ok(isPlainObject(schema), "the schema of the retirement must be a JSON object");

  const text = JSON.stringify(schema);
  assert.ok(text.includes("pi-simple-sri/retirement@1"), "expected the schema to declare the format of the record");
  for (const reason of RETIREMENT_REASONS) {
    assert.ok(text.includes(`"${reason}"`), `expected the schema to declare the reason ${reason}`);
  }
});

// The record the type declares and the document this suite validates are the same one: a field the interface gains without
// reaching the schema is a field the schema refuses as additional, and the suite would fail here instead of in a reader of
// the file. The assertion is of the compile time and of the runtime in one place, because the value below is typed.
test("the record of src/types.ts is the document the schema accepts", () => {
  const record: RetirementRecord = {
    schema: "pi-simple-sri/retirement@1",
    createdAt: CREATED_AT,
    skill: { name: "pdf-tools", dir: "/skills/pdf-tools", realDir: "/skills/pdf-tools", wasSymlink: true },
    lesson: {
      slug: "extract-merged-cells",
      title: "Extract merged cells with the lattice strategy",
      lessonPath: "lessons/extract-merged-cells.md",
      contentHash: CONTENT_HASH,
      bodyHash: BODY_HASH,
      retiredContentHash: RETIRED_CONTENT_HASH,
    },
    retires: { historyPath: null },
    reason: { key: "unreferenced", detail: "SKILL.md stopped referencing it" },
  };

  assert.deepEqual(validateAgainstRetirementSchema(record), []);
});
