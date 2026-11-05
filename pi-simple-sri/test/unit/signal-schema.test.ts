import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_EXCERPT_CODE_POINTS } from "../../src/evidence.ts";
import { SIGNAL_FORMAT, SIGNAL_KINDS } from "../../src/signals.ts";
import { isPlainObject } from "../../src/values.ts";
import { loadSignalSchema, validateAgainstSignalSchema } from "./schema-reader.ts";

// M3 (S5): schemas/signal.schema.json describes one line of state/signals.jsonl, and this suite fixes what the contract
// catches. It is a contract of the document and not a validator of production: the reader of the file (src/signals.ts)
// tolerates and skips, because a line it cannot read must never interrupt the session of a user.
//
// The positive cases are the two lines the format has, with the values the collector writes. The negative cases are one
// injected fault per case, so a keyword the schema adds later and the reader of test/unit/schema-reader.ts does not know
// shows up here as a case nobody could make fail.

const CREATED_AT = "2026-11-02T14:03:22.481Z";
const AT = "2026-11-02T15:00:00.000Z";

function raisedLine(): Record<string, unknown> {
  return {
    format: SIGNAL_FORMAT,
    event: "raised",
    id: "sg-1a2b3c4d",
    kind: "rewritten-draft",
    createdAt: CREATED_AT,
    sessionId: "session-1",
    turnIndex: 3,
    subject: "/work/notes.md",
    excerpt: "turn 2: /work/notes.md",
    prompt: "write the notes of the meeting",
    model: "anthropic/claude-sonnet-4-5",
  };
}

function consumedLine(): Record<string, unknown> {
  return { format: SIGNAL_FORMAT, event: "consumed", id: "sg-1a2b3c4d", at: AT };
}

function violationsOf(line: Record<string, unknown>): string[] {
  return validateAgainstSignalSchema(line);
}

interface NegativeCase {
  name: string;
  line: () => Record<string, unknown>;
  // The part of the violation this case is about: the reader names the JSON pointer and the keyword it refused with.
  messagePart: string;
}

const NEGATIVE_CASES: readonly NegativeCase[] = [
  {
    name: "a key the format does not declare",
    line: () => ({ ...raisedLine(), confidence: 0.9 }),
    messagePart: '"confidence"',
  },
  {
    name: "a kind outside the enum",
    line: () => ({ ...raisedLine(), kind: "unclear-request" }),
    messagePart: "unclear-request",
  },
  {
    name: "an id with another prefix",
    line: () => ({ ...raisedLine(), id: "s-1a2b3c4d" }),
    messagePart: "/^sg-[0-9a-f]{8}$/",
  },
  {
    name: "an id with fewer than eight hex digits",
    line: () => ({ ...raisedLine(), id: "sg-1a2b3c" }),
    messagePart: "/^sg-[0-9a-f]{8}$/",
  },
  {
    name: "a createdAt that is not a date-time",
    line: () => ({ ...raisedLine(), createdAt: "2026-11-02 14:03" }),
    messagePart: "is not a date-time",
  },
  {
    name: "an excerpt over the 200 code points of an evidence excerpt",
    line: () => ({ ...raisedLine(), excerpt: "x".repeat(201) }),
    messagePart: "longer than 200",
  },
  {
    name: "a line that carries the payload of both events",
    line: () => ({ ...raisedLine(), at: AT, skill: "pdf-tools" }),
    messagePart: "branches of the oneOf matched",
  },
  {
    name: "a raised line without its kind",
    line: () => {
      const line = raisedLine();
      delete line.kind;
      return line;
    },
    messagePart: 'the required property "kind" is missing',
  },
  {
    name: "a consumed line without its moment",
    line: () => {
      const line = consumedLine();
      delete line.at;
      return line;
    },
    messagePart: 'the required property "at" is missing',
  },
  {
    name: "a line of another format",
    line: () => ({ ...raisedLine(), format: "pi-simple-sri/signal@2" }),
    messagePart: "pi-simple-sri/signal@2",
  },
];

test("the raised line the collector writes satisfies the schema", () => {
  assert.deepEqual(violationsOf(raisedLine()), []);
});

test("the consumed line the collector writes satisfies the schema", () => {
  assert.deepEqual(violationsOf(consumedLine()), []);
});

// The two optional fields: the model of a turn that names none, and the skill of a consumption whose confirmation has not
// named one yet.
test("the optional fields of both events are optional", () => {
  const withoutModel = raisedLine();
  delete withoutModel.model;

  assert.deepEqual(violationsOf(withoutModel), []);
  assert.deepEqual(violationsOf({ ...consumedLine(), skill: "pdf-tools" }), []);
});

for (const negative of NEGATIVE_CASES) {
  test(`the schema refuses ${negative.name}`, () => {
    const violations = violationsOf(negative.line());

    assert.notEqual(violations.length, 0, "the line had to be refused and it was not");
    assert.ok(
      violations.some((violation) => violation.includes(negative.messagePart)),
      `expected a violation naming ${JSON.stringify(negative.messagePart)}, got ${JSON.stringify(violations)}`,
    );
  });
}

// The one literal of the format has an owner (src/signals.ts), and the schema has to declare it as its `const`: a schema
// that drifted from the writer would document a file nobody writes.
//
// The cap of the excerpt is the other number the two files share, and its owner is src/evidence.ts: the collector cuts the
// excerpt at that constant and the schema states the limit in its own bytes, in the branch of the raised event. Nothing
// else ties the contract to the constant, so the two are compared here instead of described.
test("the schema declares the format and the kinds the collector writes", () => {
  const schema: unknown = loadSignalSchema();
  assert.ok(isPlainObject(schema), "the schema of the signals must be a JSON object");

  const text = JSON.stringify(schema);
  assert.ok(text.includes(SIGNAL_FORMAT), `expected the schema to declare ${SIGNAL_FORMAT}`);
  for (const kind of SIGNAL_KINDS) {
    assert.ok(text.includes(`"${kind}"`), `expected the schema to declare the kind ${kind}`);
  }
});

test("the schema cuts the excerpt at the cap src/evidence.ts owns", () => {
  const schema: unknown = loadSignalSchema();
  assert.ok(isPlainObject(schema), "the schema of the signals must be a JSON object");

  const branches = schema.oneOf;
  assert.ok(Array.isArray(branches), "the format of the signals is a oneOf of its two events");
  const raised: unknown = branches[0];
  assert.ok(isPlainObject(raised), "the branch of the raised event must be a schema node");
  const properties = raised.properties;
  assert.ok(isPlainObject(properties), "the raised event must declare the properties of its line");
  const excerpt: unknown = properties.excerpt;
  assert.ok(isPlainObject(excerpt), "the raised event must declare the excerpt");

  assert.equal(excerpt.maxLength, MAX_EXCERPT_CODE_POINTS);
});
