import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CASE_BANK_FORMAT,
  CASE_BANK_ORIGIN_KINDS,
  MAX_CASE_BANK_BYTES,
  MAX_CASES,
  MIN_CASES,
  caseBankDigest,
  caseBankReason,
  loadCaseBank,
} from "../../src/case-bank.ts";
import type { CaseBankError, CaseBankProfile } from "../../src/case-bank.ts";
import { CASE_CHECK_KINDS } from "../../src/checks.ts";
import { sha256Digest } from "../../src/hash.ts";
import { CASE_BANK_FILE } from "../../src/names.ts";
import { isPlainObject } from "../../src/values.ts";
import { loadBankSchema, loadDecisionSchema, validateAgainstBankSchema } from "./schema-reader.ts";

// M1c, S3: the neutral bank of cases. Every case of this suite writes a bank into a mkdtemp and reads it back through
// the real reader, because what the module does is read bytes: the profile the invocation declares goes in, and out
// comes the data or the first violation of the file. No test names a real skill or a path of the author's environment:
// the bank always lives in the temporary directory of the test that wrote it.
//
// The suite is a matrix where it can be -- one row per refusal, with the detail the reader answers pinned whole --
// and the first two tests are the two profiles, because the profile is the only thing that tells two readings of the
// same file apart (OA3). The last tests are the anti-drift proof: the same fixtures go through src/case-bank.ts and
// through schemas/case-bank.schema.json, and the rows the schema cannot express are asserted to be exactly the ones
// the format declared out of its reach.

const FLAGS_CASE = {
  id: "no-squash-all",
  prompt: "Which flags does `git rebase` accept?",
  checks: [
    { kind: "contains", value: "--interactive" },
    { kind: "not-contains", value: "--squash-all" },
    { kind: "not-regex", pattern: "no (existe|soportado)", flags: "i" },
    // An empty flags is the default of the two regex kinds, so the check that comes back carries none.
    { kind: "regex", pattern: "^git rebase", flags: "" },
  ],
};

const ONTO_CASE = {
  id: "onto-needs-a-base",
  prompt: "How do I move a branch onto another commit?",
  checks: [{ kind: "regex", pattern: "^git rebase --onto" }],
};

const TWO_CASES = [FLAGS_CASE, ONTO_CASE];

// The two profiles over the same cases: the baseline one may declare the rubric the judge applies, and the origin
// one carries the artifact the defect came from.
const BASELINE_BANK = {
  format: CASE_BANK_FORMAT,
  description: "Two questions about `git rebase`.",
  rubric: "PASS when the answer names --interactive and no flag that does not exist.",
  cases: TWO_CASES,
};

const ORIGIN_BANK = {
  format: CASE_BANK_FORMAT,
  origin: {
    kind: "review-finding",
    // The reader neither resolves this path nor reads the file: it is a fact the bank declares, and the flow that
    // reads a defect is the one that fails closed when the artifact is not there.
    path: "reports/review-2026-11-03.md",
    excerpt: "The finding that does not hold: --squash-all is not a flag of git rebase.",
  },
  cases: TWO_CASES,
};

interface Fixture {
  dir: string;
  file: string;
}

function createFixture(t: TestContext): Fixture {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-case-bank-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file: path.join(dir, CASE_BANK_FILE) };
}

function writeBank(file: string, document: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

// A bank of `count` cases, all of them valid, so a test of the number of cases is a test of the number and of nothing
// else.
function bankWithCases(count: number): Record<string, unknown> {
  const cases = Array.from({ length: count }, (_entry, index) => ({
    id: `case-${index}`,
    prompt: `Question ${index}?`,
    checks: [{ kind: "contains", value: `-${index}` }],
  }));
  return { format: CASE_BANK_FORMAT, cases };
}

test("loadCaseBank: reads a baseline bank as data and normalizes the checks", async (t) => {
  const fixture = createFixture(t);
  writeBank(fixture.file, BASELINE_BANK);

  const loaded = await loadCaseBank(fixture.file, "baseline");

  assert.deepEqual(loaded, {
    ok: true,
    value: {
      format: CASE_BANK_FORMAT,
      description: BASELINE_BANK.description,
      rubric: BASELINE_BANK.rubric,
      cases: [
        {
          id: "no-squash-all",
          prompt: FLAGS_CASE.prompt,
          checks: [
            { kind: "contains", value: "--interactive" },
            { kind: "not-contains", value: "--squash-all" },
            { kind: "not-regex", pattern: "no (existe|soportado)", flags: "i" },
            { kind: "regex", pattern: "^git rebase" },
          ],
        },
        { id: "onto-needs-a-base", prompt: ONTO_CASE.prompt, checks: [{ kind: "regex", pattern: "^git rebase --onto" }] },
      ],
    },
  });
});

test("loadCaseBank: reads an origin bank and keeps its origin as it was written", async (t) => {
  const fixture = createFixture(t);
  writeBank(fixture.file, ORIGIN_BANK);

  const loaded = await loadCaseBank(fixture.file, "origin");

  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  // The path is not resolved: the reader touches no working directory, so a relative path stays relative.
  assert.deepEqual(loaded.value.origin, ORIGIN_BANK.origin);
  assert.equal(loaded.value.cases.length, TWO_CASES.length);
  // A bank of this profile has no rubric: the key is not written into the value when the file does not carry it.
  assert.equal(Object.hasOwn(loaded.value, "rubric"), false);
});

// OA9: absence is a value. A rejection here would fail the read inside a flow that has not decided anything yet, and
// the branch that declared the bank is the one that turns this into `no-baseline`.
test("loadCaseBank: a bank that is not there is absent and not an exception", async (t) => {
  const fixture = createFixture(t);

  const loaded = await loadCaseBank(fixture.file, "baseline");

  assert.deepEqual(loaded, { ok: false, error: { error: "absent", detail: fixture.file } });
  assert.equal(caseBankReason({ error: "absent", detail: fixture.file }), `bank-absent: ${fixture.file}`);
});

// ENOTDIR is the same absence one level down (src/values.ts): the parent of the path is a file, so the bank cannot be
// there.
test("loadCaseBank: a path whose parent is a file is the same absence", async (t) => {
  const fixture = createFixture(t);
  writeBank(fixture.file, BASELINE_BANK);

  const loaded = await loadCaseBank(path.join(fixture.file, CASE_BANK_FILE), "baseline");

  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.error.error, "absent");
});

// The other side of the same reading: a path that is there and cannot be read is a problem of the run and not an
// absence, and the reason says which of the two problems it was.
test("loadCaseBank: a directory is unreadable and the reason names the file it could not read", async (t) => {
  const fixture = createFixture(t);

  const loaded = await loadCaseBank(fixture.dir, "baseline");

  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.error.error, "unreadable");
  assert.equal(loaded.error.detail.startsWith(`${fixture.dir}: `), true);
  assert.equal(caseBankReason(loaded.error).startsWith("bank-unreadable: "), true);
});

test("loadCaseBank: a file that is not JSON is not-json with the message of the parser", async (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(fixture.file, '{"format": ', "utf8");

  const loaded = await loadCaseBank(fixture.file, "baseline");

  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.error.error, "not-json");
  assert.match(loaded.error.detail, /^Unexpected/);
  assert.match(caseBankReason(loaded.error), /^bank-not-json: Unexpected/);
});

// The cap is checked on the bytes and before the JSON parser, so a file that points at a database does not become a
// parsed database. The file below is a valid bank otherwise, which is what makes the order the thing under test.
test("loadCaseBank: a file over the cap is too-large before it is parsed", async (t) => {
  const fixture = createFixture(t);
  writeBank(fixture.file, { ...BASELINE_BANK, description: "d".repeat(MAX_CASE_BANK_BYTES) });
  const written = fs.readFileSync(fixture.file);
  assert.equal(written.length > MAX_CASE_BANK_BYTES, true);

  const loaded = await loadCaseBank(fixture.file, "baseline");

  assert.deepEqual(loaded, {
    ok: false,
    error: { error: "too-large", detail: `${written.length} bytes, over the ${MAX_CASE_BANK_BYTES} byte limit` },
  });
});

// Q23: the floor and the ceiling of the number of cases are both inside the format.
test("loadCaseBank: the floor and the ceiling of the number of cases are accepted", async (t) => {
  const fixture = createFixture(t);

  for (const count of [MIN_CASES, MAX_CASES]) {
    writeBank(fixture.file, bankWithCases(count));
    const loaded = await loadCaseBank(fixture.file, "baseline");
    assert.equal(loaded.ok, true, `a bank of ${count} cases`);
    if (!loaded.ok) return;
    assert.equal(loaded.value.cases.length, count);
  }
});

// JSON Schema counts the characters of a string as code points, so a limit counted in UTF-16 units would refuse a
// description the schema accepts.
test("loadCaseBank: the description limit is counted in code points", async (t) => {
  const fixture = createFixture(t);
  writeBank(fixture.file, { ...BASELINE_BANK, description: "😀".repeat(500) });

  const loaded = await loadCaseBank(fixture.file, "baseline");

  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(Array.from(loaded.value.description ?? "").length, 500);
});

// An empty description says nothing, which is what the absence of the key says too: the schema declares a ceiling and
// no floor for it, and the two readers agree.
test("loadCaseBank: an empty description is accepted", async (t) => {
  const fixture = createFixture(t);
  const bank = { ...BASELINE_BANK, description: "" };
  writeBank(fixture.file, bank);

  const loaded = await loadCaseBank(fixture.file, "baseline");

  assert.equal(loaded.ok, true);
  assert.deepEqual(validateAgainstBankSchema(bank), []);
});

interface Rejection {
  name: string;
  profile: CaseBankProfile;
  bank: unknown;
  // The detail the reader answers, pinned whole. A RegExp is for the two messages a runtime completes: the parser of
  // JSON and the compiler of a regular expression.
  detail: string | RegExp;
  // Whether schemas/case-bank.schema.json can express the same refusal. A row that says false is a document the
  // schema accepts and only the validator of the format refuses -- the limitation OA3 accepted -- and the anti-drift
  // test below asserts exactly that.
  schemaCatches: boolean;
}

// One injected fault per row, in the order the reader checks them. Every row is a whole bank, so the detail a reader
// answers is the one and only violation of that file.
const REJECTIONS: readonly Rejection[] = [
  {
    name: "a bank that is not an object",
    profile: "baseline",
    bank: "not a bank",
    detail: 'the bank must be a JSON object, got "not a bank"',
    schemaCatches: true,
  },
  {
    name: "a format of another version",
    profile: "baseline",
    bank: { ...BASELINE_BANK, format: "pi-simple-sri/case-bank@2" },
    detail: '"format" must be "pi-simple-sri/case-bank@1", got "pi-simple-sri/case-bank@2"',
    schemaCatches: true,
  },
  {
    // OA3: the file carries no discriminator, and a bank that declares one is refused by name instead of having the
    // key dropped on the floor.
    name: "a profile declared inside the file",
    profile: "baseline",
    bank: { ...BASELINE_BANK, kind: "baseline" },
    detail: 'the bank has no "kind" field',
    schemaCatches: true,
  },
  {
    name: "a description over 500 characters",
    profile: "baseline",
    bank: { ...BASELINE_BANK, description: "d".repeat(501) },
    detail: '"description" must be at most 500 characters, got 501',
    schemaCatches: true,
  },
  {
    name: "a rubric over 8000 characters",
    profile: "baseline",
    bank: { ...BASELINE_BANK, rubric: "r".repeat(8001) },
    detail: '"rubric" must be 1 to 8000 characters, got 8001',
    schemaCatches: true,
  },
  {
    name: "an empty rubric",
    profile: "baseline",
    bank: { ...BASELINE_BANK, rubric: "" },
    detail: '"rubric" must be 1 to 8000 characters, got 0',
    schemaCatches: true,
  },
  {
    name: "a rubric under the origin profile",
    profile: "origin",
    bank: { ...ORIGIN_BANK, rubric: BASELINE_BANK.rubric },
    detail: 'a bank of profile "origin" has no "rubric" field',
    schemaCatches: false,
  },
  {
    name: "an origin missing under the origin profile",
    profile: "origin",
    bank: { format: CASE_BANK_FORMAT, cases: TWO_CASES },
    detail: 'a bank of profile "origin" requires an "origin"',
    schemaCatches: false,
  },
  {
    name: "an origin under the baseline profile",
    profile: "baseline",
    bank: { ...BASELINE_BANK, origin: ORIGIN_BANK.origin },
    detail: 'a bank of profile "baseline" has no "origin" field',
    schemaCatches: false,
  },
  {
    name: "an origin with a field the format does not declare",
    profile: "origin",
    bank: { ...ORIGIN_BANK, origin: { ...ORIGIN_BANK.origin, line: 3 } },
    detail: '"origin" has no "line" field',
    schemaCatches: true,
  },
  {
    name: "an origin kind outside the two the format declares",
    profile: "origin",
    bank: { ...ORIGIN_BANK, origin: { ...ORIGIN_BANK.origin, kind: "reported" } },
    detail: '"origin.kind" must be one of "review-finding", "rejected-draft", got "reported"',
    schemaCatches: true,
  },
  {
    name: "an origin without a path",
    profile: "origin",
    bank: { ...ORIGIN_BANK, origin: { kind: "review-finding", excerpt: "the finding" } },
    detail: '"origin.path" must be a non-empty string, got undefined',
    schemaCatches: true,
  },
  {
    name: "an origin excerpt over 200 characters",
    profile: "origin",
    bank: { ...ORIGIN_BANK, origin: { ...ORIGIN_BANK.origin, excerpt: "e".repeat(201) } },
    detail: '"origin.excerpt" must be 1 to 200 characters, got 201',
    schemaCatches: true,
  },
  {
    name: "a cases field that is not an array",
    profile: "baseline",
    bank: { format: CASE_BANK_FORMAT, cases: TWO_CASES[0] },
    detail: `"cases" must be an array, got ${JSON.stringify(TWO_CASES[0])}`,
    schemaCatches: true,
  },
  {
    name: "a bank without cases",
    profile: "baseline",
    bank: { format: CASE_BANK_FORMAT },
    detail: '"cases" must be an array, got undefined',
    schemaCatches: true,
  },
  {
    name: "one case",
    profile: "baseline",
    bank: bankWithCases(1),
    detail: '"cases" must hold 2 to 50 cases, got 1',
    schemaCatches: true,
  },
  {
    name: "fifty-one cases",
    profile: "baseline",
    bank: bankWithCases(51),
    detail: '"cases" must hold 2 to 50 cases, got 51',
    schemaCatches: true,
  },
  {
    name: "a case that is not an object",
    profile: "baseline",
    bank: { format: CASE_BANK_FORMAT, cases: [FLAGS_CASE, "onto"] },
    detail: '"cases[1]" must be an object, got "onto"',
    schemaCatches: true,
  },
  {
    name: "a case with a field the format does not declare",
    profile: "baseline",
    bank: { format: CASE_BANK_FORMAT, cases: [{ ...FLAGS_CASE, expect: "pass" }, ONTO_CASE] },
    detail: '"cases[0]" has no "expect" field',
    schemaCatches: true,
  },
  {
    name: "two cases with the same id",
    profile: "baseline",
    bank: { format: CASE_BANK_FORMAT, cases: [FLAGS_CASE, { ...ONTO_CASE, id: FLAGS_CASE.id }] },
    detail: '"cases[1].id" repeats the id "no-squash-all"',
    schemaCatches: false,
  },
  {
    name: "an id outside the slug pattern",
    profile: "baseline",
    bank: { format: CASE_BANK_FORMAT, cases: [{ ...FLAGS_CASE, id: "No_Squash" }, ONTO_CASE] },
    detail: '"cases[0].id" must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be at most 64 characters, got "No_Squash"',
    schemaCatches: true,
  },
  {
    name: "an id over 64 characters",
    profile: "baseline",
    bank: { format: CASE_BANK_FORMAT, cases: [{ ...FLAGS_CASE, id: "a".repeat(65) }, ONTO_CASE] },
    detail: `"cases[0].id" must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be at most 64 characters, got "${"a".repeat(65)}"`,
    schemaCatches: true,
  },
  {
    name: "a prompt that is not a string",
    profile: "baseline",
    bank: { format: CASE_BANK_FORMAT, cases: [{ ...FLAGS_CASE, prompt: 7 }, ONTO_CASE] },
    detail: '"cases[0].prompt" must be a string, got 7',
    schemaCatches: true,
  },
  {
    name: "a prompt over 4000 characters",
    profile: "baseline",
    bank: { format: CASE_BANK_FORMAT, cases: [{ ...FLAGS_CASE, prompt: "p".repeat(4001) }, ONTO_CASE] },
    detail: '"cases[0].prompt" must be 1 to 4000 characters, got 4001',
    schemaCatches: true,
  },
  {
    name: "a case without checks",
    profile: "baseline",
    bank: { format: CASE_BANK_FORMAT, cases: [{ ...FLAGS_CASE, checks: [] }, ONTO_CASE] },
    detail: '"cases[0].checks" must hold at least one check, got 0',
    schemaCatches: true,
  },
  {
    // The message is the one src/checks.ts answers: the bank does not revalidate a check, it asks the module that
    // owns the vocabulary and prepends the coordinate of the case it belongs to.
    name: "a check whose kind is outside the vocabulary",
    profile: "baseline",
    bank: { format: CASE_BANK_FORMAT, cases: [{ ...FLAGS_CASE, checks: [{ kind: "equals", value: "x" }] }, ONTO_CASE] },
    detail:
      'the check at "cases[0].checks[0]": "kind" must be one of contains, not-contains, regex, not-regex, got "equals"',
    schemaCatches: true,
  },
  {
    name: "a check whose pattern does not compile",
    profile: "baseline",
    bank: {
      format: CASE_BANK_FORMAT,
      cases: [{ ...FLAGS_CASE, checks: [{ kind: "regex", pattern: "(unclosed" }] }, ONTO_CASE],
    },
    detail: /^the check at "cases\[0\]\.checks\[0\]": the pattern "\(unclosed" does not compile: /,
    schemaCatches: false,
  },
];

for (const row of REJECTIONS) {
  test(`loadCaseBank: refuses ${row.name}`, async (t) => {
    const fixture = createFixture(t);
    writeBank(fixture.file, row.bank);

    const loaded = await loadCaseBank(fixture.file, row.profile);

    assert.equal(loaded.ok, false);
    if (loaded.ok) return;

    assert.equal(loaded.error.error, "invalid");
    if (typeof row.detail === "string") assert.equal(loaded.error.detail, row.detail);
    else assert.match(loaded.error.detail, row.detail);

    // The reason is the stable text a line of the index carries: the prefix of the kind and the detail of the file.
    assert.equal(caseBankReason(loaded.error), `bank-invalid: ${loaded.error.detail}`);
  });
}

// The digest is the one of the bytes, so a copy of the file has the same digest and a bank written again with other
// whitespace is another bank. The second assertion is the one a preregistration depends on: the bytes read from the
// path are the bytes the record pins.
test("caseBankDigest: the digest is the one of the bytes on disk and a byte copy keeps it", (t) => {
  const fixture = createFixture(t);
  const bytes = Buffer.from(`${JSON.stringify(BASELINE_BANK, null, 2)}\n`, "utf8");
  fs.writeFileSync(fixture.file, bytes);
  const copy = path.join(fixture.dir, "copy.json");
  fs.copyFileSync(fixture.file, copy);

  assert.equal(caseBankDigest(bytes), sha256Digest(bytes));
  assert.equal(caseBankDigest(fs.readFileSync(fixture.file)), caseBankDigest(fs.readFileSync(copy)));
  // The same data written again is not the same file.
  assert.notEqual(caseBankDigest(Buffer.from(JSON.stringify(BASELINE_BANK), "utf8")), caseBankDigest(bytes));
  // A string is hashed as UTF-8, the way src/hash.ts hashes it, so the two forms of the same bank agree.
  assert.equal(caseBankDigest(bytes.toString("utf8")), caseBankDigest(bytes));
});

// The vocabulary of the reasons, with the prefix every kind answers. The table is typed by the union, so a kind added
// to CaseBankError without a prefix stops compiling in the module and shows up here as a missing row.
const REASON_PREFIXES: Record<CaseBankError, string> = {
  absent: "bank-absent",
  unreadable: "bank-unreadable",
  "too-large": "bank-too-large",
  "not-json": "bank-not-json",
  invalid: "bank-invalid",
};

test("caseBankReason: every kind of refusal has its own prefix", () => {
  const pairs = Object.entries(REASON_PREFIXES) as [CaseBankError, string][];
  for (const [error, prefix] of pairs) {
    assert.equal(caseBankReason({ error, detail: "the detail" }), `${prefix}: the detail`);
  }
});

// One node of a schema on disk, named by the keys that lead to it. A node that is not there is a failure and never a
// silent pass, so a comparison below cannot agree with a node the file does not have.
function schemaNode(schema: unknown, ...keys: string[]): Record<string, unknown> {
  let current: unknown = schema;
  for (const key of keys) {
    current = isPlainObject(current) ? current[key] : undefined;
  }
  if (!isPlainObject(current)) assert.fail(`the schema node ${keys.join(".")} is not an object`);
  return current;
}

test("case-bank.schema.json: the format of the schema is the constant the reader compares against", () => {
  assert.equal(schemaNode(loadBankSchema(), "properties", "format").const, CASE_BANK_FORMAT);
});

// One vocabulary, two files: the array src/case-bank.ts declares and the enum of the schema.
test("case-bank.schema.json: the origin kinds of the schema are the ones src/case-bank.ts declares", () => {
  assert.deepEqual(schemaNode(loadBankSchema(), "properties", "origin", "properties", "kind").enum, [
    ...CASE_BANK_ORIGIN_KINDS,
  ]);
});

// The checks of a bank and the checks of an expectation are one vocabulary in two schemas: the reader of the format
// and the gate that replays it must not disagree about what a check is, so the two nodes are compared whole.
test("case-bank.schema.json: the check of the bank is the check of decision@1", () => {
  const inBank = schemaNode(loadBankSchema(), "properties", "cases", "items", "properties", "checks", "items");
  const inDecision = schemaNode(
    loadDecisionSchema(),
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
  );

  assert.deepEqual(inBank, inDecision);
  assert.deepEqual(schemaNode(inBank, "properties", "kind").enum, [...CASE_CHECK_KINDS]);
});

// The anti-drift proof, from both ends. Every fixture the schema can express is accepted by both readers, and every
// row the schema cannot express is a document the schema accepts -- which is the limitation OA3 accepted, asserted
// instead of described: the relation profile <-> fields has one owner, and it is src/case-bank.ts.
test("case-bank.schema.json: the fixtures the schema can express validate the same way as the reader", () => {
  assert.deepEqual(validateAgainstBankSchema(BASELINE_BANK), []);
  assert.deepEqual(validateAgainstBankSchema(ORIGIN_BANK), []);
  assert.deepEqual(validateAgainstBankSchema(bankWithCases(MIN_CASES)), []);
  assert.deepEqual(validateAgainstBankSchema(bankWithCases(MAX_CASES)), []);
  // The description of exactly the limit, which the code accepts and the schema must accept too.
  assert.deepEqual(validateAgainstBankSchema({ ...BASELINE_BANK, description: "d".repeat(500) }), []);

  for (const row of REJECTIONS) {
    const violations = validateAgainstBankSchema(row.bank);
    if (row.schemaCatches) assert.notDeepEqual(violations, [], `the schema reports ${row.name} too`);
    else assert.deepEqual(violations, [], `the schema cannot express ${row.name}`);
  }
});
