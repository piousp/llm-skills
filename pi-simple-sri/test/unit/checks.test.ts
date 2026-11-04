import { test } from "node:test";
import assert from "node:assert/strict";
import { CASE_CHECK_KINDS, evaluateChecks, validateCheck } from "../../src/checks.ts";
import type { CaseCheck, CaseCheckKind } from "../../src/checks.ts";

// M1c, S1: the mechanical predicate of the fourth evidence class, on its own. The suite is a matrix instead of a
// story, because what a check does is decide over one text and nothing else: the four kinds of the vocabulary over
// an answer that contains the needle and over one that does not.

const ANSWER =
  "git rebase accepts --interactive and --onto. The flag --squash-all does not exist: no existe.";

interface Row {
  name: string;
  check: CaseCheck;
  passed: boolean;
}

// One row per kind and per direction, with the needle present and absent, plus the two readings of the case: a
// substring match is literal, and only `flags: "i"` folds it.
const MATRIX: readonly Row[] = [
  { name: "contains, needle present", check: { kind: "contains", value: "--interactive" }, passed: true },
  { name: "contains, needle absent", check: { kind: "contains", value: "--no-verify" }, passed: false },
  { name: "not-contains, needle absent", check: { kind: "not-contains", value: "--no-verify" }, passed: true },
  { name: "not-contains, needle present", check: { kind: "not-contains", value: "--squash-all" }, passed: false },
  { name: "regex, pattern matches", check: { kind: "regex", pattern: "--(interactive|onto)" }, passed: true },
  { name: "regex, pattern does not match", check: { kind: "regex", pattern: "--no-verify" }, passed: false },
  { name: "not-regex, pattern does not match", check: { kind: "not-regex", pattern: "--no-verify" }, passed: true },
  { name: "not-regex, pattern matches", check: { kind: "not-regex", pattern: "--squash-all" }, passed: false },
  {
    name: "contains, the needle is literal and case-sensitive",
    check: { kind: "contains", value: "GIT" },
    passed: false,
  },
  { name: "regex, case-sensitive without flags", check: { kind: "regex", pattern: "NO EXISTE" }, passed: false },
  {
    name: 'regex, flags "i" folds the case',
    check: { kind: "regex", pattern: "NO EXISTE", flags: "i" },
    passed: true,
  },
  {
    name: 'not-regex, flags "i" folds the case too',
    check: { kind: "not-regex", pattern: "NO EXISTE", flags: "i" },
    passed: false,
  },
];

for (const row of MATRIX) {
  test(`evaluateChecks: ${row.name}`, () => {
    assert.deepEqual(evaluateChecks([row.check], ANSWER), {
      passed: row.passed,
      failures: row.passed ? [] : [`0:${row.check.kind}`],
    });
  });
}

// The list is an AND: a case passes when every check does, and a failure names the check by its position in the list
// and its kind, which is the coordinate the case bank gave it.
test("evaluateChecks: one failing check fails the case and names its index and kind", () => {
  const checks: readonly CaseCheck[] = [
    { kind: "contains", value: "--interactive" },
    { kind: "not-contains", value: "--squash-all" },
  ];

  assert.deepEqual(evaluateChecks(checks, "git rebase --interactive --squash-all"), {
    passed: false,
    failures: ["1:not-contains"],
  });
});

test("evaluateChecks: two failing checks are two entries, in the order of the list", () => {
  const checks: readonly CaseCheck[] = [
    { kind: "regex", pattern: "^git" },
    { kind: "contains", value: "--onto" },
    { kind: "not-regex", pattern: "squash", flags: "i" },
  ];

  assert.deepEqual(evaluateChecks(checks, "git rebase --squash-all"), {
    passed: false,
    failures: ["1:contains", "2:not-regex"],
  });
});

test("evaluateChecks: a case whose every check passes", () => {
  const checks: readonly CaseCheck[] = [
    { kind: "contains", value: "--interactive" },
    { kind: "not-contains", value: "--squash-all" },
    { kind: "regex", pattern: "^git rebase" },
  ];

  assert.deepEqual(evaluateChecks(checks, "git rebase --interactive"), { passed: true, failures: [] });
});

// An empty list passes: there is no assertion to fail. The rule that a defect carries at least one check is a
// relation between an expectation and its class, and src/diagnosis.ts owns it (expectationViolation), so this module
// does not keep a second copy of it.
test("evaluateChecks: an empty list passes, because the non-empty rule belongs to the expectation", () => {
  assert.deepEqual(evaluateChecks([], ANSWER), { passed: true, failures: [] });
});

// S2 closes this hazard by refusing to judge a turn that produced no text. Until then the honest reading of this
// module is that "" does not contain the needle, and the test leaves it written down instead of letting the next
// reader discover it: a `not-contains` over an empty answer is a pass with nothing behind it.
test("evaluateChecks: not-contains over empty text passes, which is the hazard S2 closes", () => {
  assert.deepEqual(evaluateChecks([{ kind: "not-contains", value: "--squash-all" }], ""), {
    passed: true,
    failures: [],
  });
  // The other direction does not pass, so the empty answer is not a free pass for both kinds.
  assert.deepEqual(evaluateChecks([{ kind: "contains", value: "--squash-all" }], ""), {
    passed: false,
    failures: ["0:contains"],
  });
});

// One row per kind, and the record type makes the list exhaustive by typecheck: a kind added to the vocabulary loses
// a member here and this suite stops compiling.
const VALID_BY_KIND: Record<CaseCheckKind, CaseCheck> = {
  contains: { kind: "contains", value: "--interactive" },
  "not-contains": { kind: "not-contains", value: "--squash-all" },
  regex: { kind: "regex", pattern: "^git rebase" },
  "not-regex": { kind: "not-regex", pattern: "no (existe|soportado)", flags: "i" },
};

test("validateCheck: every kind of the vocabulary is accepted as itself", () => {
  assert.deepEqual(Object.keys(VALID_BY_KIND), [...CASE_CHECK_KINDS]);

  for (const kind of CASE_CHECK_KINDS) {
    assert.deepEqual(validateCheck(VALID_BY_KIND[kind]), { ok: true, value: VALID_BY_KIND[kind] }, `the ${kind} check`);
  }
});

// The check the validator answers is a fresh object with the fields of its kind and no others, so an unknown key can
// never travel into a record that the schema would then refuse.
test("validateCheck: answers a fresh check with only the fields of its kind", () => {
  const raw = { kind: "contains", value: "--interactive" };
  const accepted = validateCheck(raw);
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;

  assert.notEqual(accepted.value, raw);
  assert.deepEqual(Object.keys(accepted.value).sort(), ["kind", "value"]);
});

// An empty flags is the default of the two regex kinds, so a check that declared it and one that did not are the
// same check and the record keeps one spelling of it.
test("validateCheck: an empty flags is the default and the check it answers carries none", () => {
  assert.deepEqual(validateCheck({ kind: "regex", pattern: "^git", flags: "" }), {
    ok: true,
    value: { kind: "regex", pattern: "^git" },
  });
});

interface Rejection {
  name: string;
  raw: unknown;
  error: string;
}

// One injected fault per case, with the message the reader of a bank reports as the detail of `bank-invalid`: the
// first violation and nothing else, so the message is part of the contract and not a log line.
const REJECTIONS: readonly Rejection[] = [
  { name: "a check that is not an object", raw: "contains", error: 'a check must be an object, got "contains"' },
  { name: "a check that is null", raw: null, error: "a check must be an object, got null" },
  {
    name: "a check that is an array",
    raw: [{ kind: "contains", value: "--interactive" }],
    error: 'a check must be an object, got [{"kind":"contains","value":"--interactive"}]',
  },
  {
    name: "a kind outside the vocabulary",
    raw: { kind: "equals", value: "--interactive" },
    error: '"kind" must be one of contains, not-contains, regex, not-regex, got "equals"',
  },
  {
    name: "a check without a kind",
    raw: { value: "--interactive" },
    error: '"kind" must be one of contains, not-contains, regex, not-regex, got undefined',
  },
  {
    name: "a substring check carrying the field of a regex",
    raw: { kind: "contains", value: "--interactive", pattern: "^git" },
    error: 'a "contains" check has no "pattern" field',
  },
  {
    name: "a regex check carrying the field of a substring",
    raw: { kind: "regex", pattern: "^git", value: "--interactive" },
    error: 'a "regex" check has no "value" field',
  },
  {
    name: "a substring check without a value",
    raw: { kind: "not-contains" },
    error: '"value" of a "not-contains" check must be a string of 1 to 500 characters, got undefined',
  },
  {
    name: "an empty value",
    raw: { kind: "contains", value: "" },
    error: '"value" of a "contains" check must be a string of 1 to 500 characters, got ""',
  },
  {
    name: "a regex check without a pattern",
    raw: { kind: "not-regex" },
    error: '"pattern" of a "not-regex" check must be a string of 1 to 500 characters, got undefined',
  },
  {
    name: "a flags outside the two the record declares",
    raw: { kind: "regex", pattern: "^git", flags: "g" },
    error: '"flags" of a "regex" check must be "" or "i", got "g"',
  },
];

for (const rejection of REJECTIONS) {
  test(`validateCheck: refuses ${rejection.name}`, () => {
    assert.deepEqual(validateCheck(rejection.raw), { ok: false, error: rejection.error });
  });
}

// JSON Schema counts the characters of a string as code points, so the limit is counted that way here too: a limit
// counted in UTF-16 units would refuse a value the schema accepts.
test("validateCheck: the 500 character limit is enforced and counted in code points", () => {
  assert.equal(validateCheck({ kind: "contains", value: "a".repeat(500) }).ok, true);
  assert.equal(validateCheck({ kind: "contains", value: "😀".repeat(500) }).ok, true);

  const overLimit = validateCheck({ kind: "contains", value: "a".repeat(501) });
  assert.equal(overLimit.ok, false);
  if (overLimit.ok) return;
  assert.match(overLimit.error, /^"value" of a "contains" check must be a string of 1 to 500 characters, got "a{10}/);
});

// M2, S7: a pattern of a bank cannot hang the process that replays it. The shape the validator refuses is a group
// whose body already repeats something with an unbounded repetition applied to it, which is what makes the
// backtracking engine try every split of the same text before it answers.
const NESTED_QUANTIFIERS: readonly string[] = ["(a+)+$", "(a*)*$", "(a+)*$", "(a*)+$", "(?:a+)+$", "(a{2,})+$"];

for (const pattern of NESTED_QUANTIFIERS) {
  test(`validateCheck: refuses the nested quantifier of ${pattern}`, () => {
    assert.deepEqual(validateCheck({ kind: "regex", pattern }), {
      ok: false,
      error: `the pattern "${pattern}" nests a quantifier: a quantified group followed by another quantifier makes the engine backtrack exponentially`,
    });
  });
}

// The rule is read once, on the pattern, so it cannot hold for one direction of the regex kinds and not for the other.
test("validateCheck: the nested quantifier is refused for both regex kinds", () => {
  const accepted = validateCheck({ kind: "not-regex", pattern: "(a+)+$" });
  assert.equal(accepted.ok, false);
  if (accepted.ok) return;
  assert.match(accepted.error, /nests a quantifier/);
});

// The other direction, and the reason the rule is one shape and not any parenthesis: a quantified group with no
// repetition in its body, a repetition over a character class, a bounded repetition, and the two escaped spellings
// that are text and not syntax all keep validating.
const VALID_QUANTIFIERS: readonly { pattern: string; flags?: "" | "i" }[] = [
  { pattern: "^SRI-OK$", flags: "i" },
  { pattern: "(foo|bar)+" },
  { pattern: "a+b*" },
  { pattern: "(?:\\d{2,4})-" },
  { pattern: "[a-z]+-[a-z]+" },
  { pattern: "\\(a+\\)\\+" },
  { pattern: "[(+)]+" },
];

for (const row of VALID_QUANTIFIERS) {
  const check: CaseCheck = { kind: "regex", ...row };

  test(`validateCheck: accepts the pattern ${row.pattern}`, () => {
    assert.deepEqual(validateCheck(check), { ok: true, value: check });
  });
}

// The cap of MAX_CHECK_TEXT covers `pattern` as it covers `value`, and it is the first half of the bound: a pattern
// over the cap is refused before the shape of the expression is read at all.
test("validateCheck: a pattern over the 500 character limit is refused with the length reason", () => {
  assert.equal(validateCheck({ kind: "regex", pattern: "a".repeat(500) }).ok, true);

  const overLimit = validateCheck({ kind: "regex", pattern: "a".repeat(600) });
  assert.equal(overLimit.ok, false);
  if (overLimit.ok) return;
  assert.match(overLimit.error, /^"pattern" of a "regex" check must be a string of 1 to 500 characters, got "a{10}/);
});

// The two substring kinds carry no pattern, so a value that spells the refused shape is an ordinary needle: the rule
// is read on the field of the regex kinds and nowhere else.
test("validateCheck: the quantifier shape is not read for the two substring kinds", () => {
  assert.deepEqual(validateCheck({ kind: "contains", value: "(a+)+$" }), {
    ok: true,
    value: { kind: "contains", value: "(a+)+$" },
  });
  assert.deepEqual(validateCheck({ kind: "not-contains", value: "(a*)*$" }), {
    ok: true,
    value: { kind: "not-contains", value: "(a*)*$" },
  });
});

// A regex that does not compile is refused when the check is validated, never when an answer is judged. The second
// half of the test is the other direction of the same rule: every check the validator accepts is a check evaluation
// can run, so a pattern that reaches a CaseCheck is a pattern that compiles.
test("validateCheck: a pattern that does not compile is refused at validation, not at evaluation", () => {
  const broken = validateCheck({ kind: "regex", pattern: "(unclosed" });
  assert.equal(broken.ok, false);
  if (broken.ok) return;
  assert.match(broken.error, /^the pattern "\(unclosed" does not compile: /);

  for (const kind of CASE_CHECK_KINDS) {
    const accepted = validateCheck(VALID_BY_KIND[kind]);
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;
    // Bound to its own constant so the closure below reads a value and not a narrowed binding.
    const check = accepted.value;
    assert.doesNotThrow(() => evaluateChecks([check], ANSWER), `the ${kind} check the validator accepted`);
  }
});
