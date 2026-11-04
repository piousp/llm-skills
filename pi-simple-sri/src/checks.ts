import { assertNever, type Result } from "./types.ts";
import { describe, isPlainObject, quote, toErrorMessage } from "./values.ts";

// The mechanical predicate of the fourth evidence class (M1c): the final answer of a replayed turn and the
// checks of one case in, one verdict out. Nothing here reads a file, starts a process or looks at a clock, so a
// stored answer can be judged again and the verdict re-derived from the record alone.
//
// Q18 asked for a predicate the gate executes instead of prose it has to parse, and a check is the smallest one
// such a predicate has: a substring that must be there, one that must not, or a regular expression either way.
// The vocabulary is closed at four kinds, and it is the same four the case bank declares: a bank whose checks the
// runner read differently would measure something else than what the bank says. The two directions of each kind
// exist so that "the answer must not say X" is one assertion instead of the absence of one, which is what lets a
// failure name its own index and kind in the record.
//
// What this module does not do: it judges one text, expected to be the final answer of the replayed turn, and
// says nothing about the rest of the run. A turn whose tool calls failed is still a failed turn, and combining
// the two readings belongs to the evaluator of the gate.
//
// The empty answer is not special here: a `not-contains` over "" passes, because "" does not contain the needle.
// That is the vacuous pass the replay closes by refusing to judge a turn that produced no text; the test of this
// module keeps the hazard written down instead of closing it twice.

// The vocabulary, declared once: the type is derived from the array, so a kind cannot be added to the type without
// reaching the validator that accepts it, and schemas/decision.schema.json declares the same four values as an
// enum of its own (test/unit/decision-schema.test.ts is where the two files are read together).
export const CASE_CHECK_KINDS = ["contains", "not-contains", "regex", "not-regex"] as const;
export type CaseCheckKind = (typeof CASE_CHECK_KINDS)[number];

// One check, with the fields its kind reads and no others: the two substring kinds carry `value`, the two regex
// kinds carry `pattern` and an optional `flags`. `flags` is "" or "i" and nothing else, because those are the only
// two the record declares and a flag the schema does not know would make one bank mean two things. A substring
// match is literal and case-sensitive on purpose: a reader who wants the folded comparison writes a regex with
// `flags: "i"`, and the kind of the check says which of the two it is.
export type CaseCheck =
  | { kind: "contains" | "not-contains"; value: string }
  | { kind: "regex" | "not-regex"; pattern: string; flags?: "" | "i" };

// The verdict of a list of checks over one answer. Every check is an independent assertion and the case passes
// when all of them do (AND): an OR is expressed as two cases, and that is what keeps the unanimity rule of the
// gate meaningful. `failures` names each check that did not pass by its position in the list and its kind, which
// is the coordinate the case bank gave it, so a failure is traceable to the line that produced it.
export interface ChecksResult {
  passed: boolean;
  failures: readonly string[];
}

// The limit of the longest text a check may look for, the same 500 that schemas/decision.schema.json declares as
// maxLength for `value` and for `pattern`: a limit the validator did not enforce would be a promise the schema
// makes and the records of this package break.
const MAX_CHECK_TEXT = 500;

// The fields each kind reads. It is the whole shape of a check: an unknown key is refused instead of dropped,
// because a bank with a misspelled field is a mistake its reader has to see and a record that carried the key
// would not validate against the schema (additionalProperties: false).
const FIELDS_BY_KIND: Record<CaseCheckKind, readonly string[]> = {
  contains: ["kind", "value"],
  "not-contains": ["kind", "value"],
  regex: ["kind", "pattern", "flags"],
  "not-regex": ["kind", "pattern", "flags"],
};

// The two directions of the two kinds, over one answer. Pure by construction: the same checks and the same text
// always yield the same verdict.
export function evaluateChecks(checks: readonly CaseCheck[], text: string): ChecksResult {
  const failures: string[] = [];
  checks.forEach((check, index) => {
    if (!passes(check, text)) failures.push(`${index}:${check.kind}`);
  });
  // `passed` is the conjunction and it is answered, not left to the caller to derive: the gate records the one
  // value and never re-adds the list to know what happened.
  return { passed: failures.length === 0, failures };
}

// The one place a CaseCheck of a kind becomes a boolean over a text. The dispatch is exhaustive by typecheck: a
// kind added to CASE_CHECK_KINDS loses a member here and stops compiling, and the parameter of assertNever keeps
// it closed at runtime.
function passes(check: CaseCheck, text: string): boolean {
  switch (check.kind) {
    case "contains":
      return text.includes(check.value);
    case "not-contains":
      return !text.includes(check.value);
    case "regex":
      return regexFor(check).test(text);
    case "not-regex":
      return !regexFor(check).test(text);
    default:
      return assertNever(check);
  }
}

// The one place a check's text becomes a regular expression, so validation and evaluation cannot disagree about
// the flags. No `g` or `y` flag exists in the vocabulary, which is why a RegExp can be built per evaluation
// without the state a global expression carries between calls.
function regexFor(check: { pattern: string; flags?: "" | "i" }): RegExp {
  return new RegExp(check.pattern, check.flags ?? "");
}

// The shape of one check, validated and normalized. A bank is JSON read from a file, so the value arrives as
// `unknown` and leaves as a CaseCheck or as the reason it is not one; the caller of the bank turns the reason
// into the detail of its own rejection.
//
// Compiling the regex is part of validating it: a pattern the package accepts is a pattern evaluation can run, so
// a broken pattern is refused here and never discovered mid-replay. The array the value arrives in is not
// validated here -- the caller owns that list -- and neither is the count of checks a defect needs, which is a
// relation between the expectation and its class and lives in src/diagnosis.ts.
export function validateCheck(raw: unknown): Result<CaseCheck, string> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: `a check must be an object, got ${describe(raw)}` };
  }

  const kind = raw.kind;
  if (!isCaseCheckKind(kind)) {
    return { ok: false, error: `"kind" must be one of ${CASE_CHECK_KINDS.join(", ")}, got ${describe(kind)}` };
  }

  const unknownField = Object.keys(raw).find((key) => !FIELDS_BY_KIND[kind].includes(key));
  if (unknownField !== undefined) {
    return { ok: false, error: `a ${quote(kind)} check has no ${quote(unknownField)} field` };
  }

  switch (kind) {
    case "contains":
    case "not-contains": {
      const value = raw.value;
      if (!isCheckText(value)) return { ok: false, error: textProblem(kind, "value", value) };
      return { ok: true, value: { kind, value } };
    }
    case "regex":
    case "not-regex": {
      const pattern = raw.pattern;
      if (!isCheckText(pattern)) return { ok: false, error: textProblem(kind, "pattern", pattern) };

      const declaredFlags = raw.flags;
      if (declaredFlags !== undefined && declaredFlags !== "" && declaredFlags !== "i") {
        return {
          ok: false,
          error: `"flags" of a ${quote(kind)} check must be "" or "i", got ${describe(declaredFlags)}`,
        };
      }
      // An empty flags is the default, so a check that declared it and one that did not are the same check and
      // the record keeps one spelling of it.
      const flags = declaredFlags === "i" ? "i" : "";

      try {
        // Compiling is the whole check: the expression itself is thrown away, and evaluation builds it again from
        // the pattern this call accepted.
        regexFor({ pattern, flags });
      } catch (error) {
        return { ok: false, error: `the pattern ${quote(pattern)} does not compile: ${toErrorMessage(error)}` };
      }

      return flags === "i" ? { ok: true, value: { kind, pattern, flags } } : { ok: true, value: { kind, pattern } };
    }
    default:
      return assertNever(kind);
  }
}

// Derived from the array, never from a second literal, in the same way src/lesson-frontmatter.ts derives its
// status validator from LESSON_STATUSES (I4).
function isCaseCheckKind(value: unknown): value is CaseCheckKind {
  return typeof value === "string" && CASE_CHECK_KINDS.some((kind) => kind === value);
}

// JSON Schema counts the characters of a string as code points, so the limit is counted the same way here: an
// emoji is one character for the schema and has to be one for the validator too, and Array.from walks code points
// instead of UTF-16 units (the same reading src/evidence.ts uses for its excerpt).
function isCheckText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = Array.from(value).length;
  return length >= 1 && length <= MAX_CHECK_TEXT;
}

function textProblem(kind: CaseCheckKind, field: "value" | "pattern", value: unknown): string {
  return `${quote(field)} of a ${quote(kind)} check must be a string of 1 to ${MAX_CHECK_TEXT} characters, got ${describe(value)}`;
}
