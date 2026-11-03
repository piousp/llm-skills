import { test } from "node:test";
import assert from "node:assert/strict";
import { isEligible, isEligibleUnderAnySpelling } from "../../src/eligibility.ts";
import type { Eligibility, SriConfig } from "../../src/types.ts";

const ELIGIBLE: Eligibility = { eligible: true };
const NOT_ELIGIBLE: Eligibility = { eligible: false, reason: "not-eligible" };

interface EligibilityCase {
  name: string;
  skill: string;
  config: SriConfig;
  expected: Eligibility;
}

const CASES: EligibilityCase[] = [
  {
    name: "empty allow and deny makes every skill eligible",
    skill: "pdf-tools",
    config: { allow: [], deny: [] },
    expected: ELIGIBLE,
  },
  {
    name: "a skill listed only in allow is eligible",
    skill: "pdf-tools",
    config: { allow: ["pdf-tools"], deny: [] },
    expected: ELIGIBLE,
  },
  {
    name: "a skill missing from a non-empty allow is not eligible",
    skill: "code-review",
    config: { allow: ["pdf-tools"], deny: [] },
    expected: NOT_ELIGIBLE,
  },
  {
    name: "a skill listed only in deny is not eligible",
    skill: "system-config",
    config: { allow: [], deny: ["system-config"] },
    expected: NOT_ELIGIBLE,
  },
  {
    name: "deny wins when a skill is in both lists",
    skill: "pdf-tools",
    config: { allow: ["pdf-tools"], deny: ["pdf-tools"] },
    expected: NOT_ELIGIBLE,
  },
  {
    name: "deny removes a skill that a non-empty allow would otherwise admit",
    skill: "system-config",
    config: { allow: ["pdf-tools", "system-config"], deny: ["system-config"] },
    expected: NOT_ELIGIBLE,
  },
  {
    name: "a skill in neither list with both lists set is not eligible",
    skill: "other-skill",
    config: { allow: ["pdf-tools"], deny: ["system-config"] },
    expected: NOT_ELIGIBLE,
  },
  {
    name: "a skill in neither list with an empty allow is eligible",
    skill: "pdf-tools",
    config: { allow: [], deny: ["system-config"] },
    expected: ELIGIBLE,
  },
  {
    name: "matching is case-sensitive, so another case misses allow",
    skill: "PDF-Tools",
    config: { allow: ["pdf-tools"], deny: [] },
    expected: NOT_ELIGIBLE,
  },
  {
    name: "matching is case-sensitive, so another case misses deny",
    skill: "PDF-Tools",
    config: { allow: [], deny: ["pdf-tools"] },
    expected: ELIGIBLE,
  },
  {
    name: "a glob-shaped allow entry does not match",
    skill: "pdf-tools",
    config: { allow: ["pdf-*"], deny: [] },
    expected: NOT_ELIGIBLE,
  },
  {
    name: "a glob-shaped deny entry does not match",
    skill: "pdf-tools",
    config: { allow: [], deny: ["pdf-*"] },
    expected: ELIGIBLE,
  },
  {
    name: "a guess-prefix entry does not match the full name",
    skill: "pdf-tools",
    config: { allow: ["pdf"], deny: [] },
    expected: NOT_ELIGIBLE,
  },
  {
    name: "names are not trimmed before comparing",
    skill: " pdf-tools",
    config: { allow: ["pdf-tools"], deny: [] },
    expected: NOT_ELIGIBLE,
  },
];

for (const testCase of CASES) {
  test(`isEligible: ${testCase.name}`, () => {
    assert.deepEqual(isEligible(testCase.skill, testCase.config), testCase.expected);
  });

  // The one-spelling form is the same rule: a skill with a single spelling has to answer exactly as
  // the table above says.
  test(`isEligibleUnderAnySpelling: one spelling answers as isEligible does (${testCase.name})`, () => {
    assert.deepEqual(
      isEligibleUnderAnySpelling([testCase.skill], testCase.config),
      isEligible(testCase.skill, testCase.config),
    );
  });
}

// F5: a skill answers to the frontmatter `name` and to the basename of its directory, and findSkill
// resolves a request written either way, so the settings may name it with either one. The settings of
// these tests are the ones a user writes for a skill whose directory is `system-config` and whose
// frontmatter says `syscfg`.
const SPELLINGS: readonly string[] = ["syscfg", "system-config"];

interface AnySpellingCase {
  name: string;
  config: SriConfig;
  expected: Eligibility;
}

const ANY_SPELLING_CASES: AnySpellingCase[] = [
  {
    name: "a deny on the directory spelling removes the skill asked by its name",
    config: { allow: [], deny: ["system-config"] },
    expected: NOT_ELIGIBLE,
  },
  {
    name: "a deny on the name spelling removes the skill asked by its directory",
    config: { allow: [], deny: ["syscfg"] },
    expected: NOT_ELIGIBLE,
  },
  {
    name: "an allow on the name spelling admits the skill asked by its directory",
    config: { allow: ["syscfg"], deny: [] },
    expected: ELIGIBLE,
  },
  {
    name: "an allow on the directory spelling admits the skill asked by its name",
    config: { allow: ["system-config"], deny: [] },
    expected: ELIGIBLE,
  },
  {
    name: "a deny on one spelling wins over an allow on the other",
    config: { allow: ["syscfg"], deny: ["system-config"] },
    expected: NOT_ELIGIBLE,
  },
  {
    name: "a non-empty allow that names neither spelling removes the skill",
    config: { allow: ["pdf-tools"], deny: [] },
    expected: NOT_ELIGIBLE,
  },
];

for (const testCase of ANY_SPELLING_CASES) {
  test(`isEligibleUnderAnySpelling: ${testCase.name}`, () => {
    assert.deepEqual(isEligibleUnderAnySpelling(SPELLINGS, testCase.config), testCase.expected);
  });
}

test("isEligible: the not-eligible result carries only the reason", () => {
  const result = isEligible("system-config", { allow: [], deny: ["system-config"] });

  assert.deepEqual(result, { eligible: false, reason: "not-eligible" });
});

test("isEligible: the eligible result carries no reason", () => {
  const result = isEligible("pdf-tools", { allow: [], deny: [] });

  assert.deepEqual(result, { eligible: true });
});

test("isEligible: does not mutate the config it reads", () => {
  const config: SriConfig = { allow: ["pdf-tools"], deny: ["system-config"] };

  isEligible("pdf-tools", config);
  isEligible("other-skill", config);

  assert.deepEqual(config, { allow: ["pdf-tools"], deny: ["system-config"] });
});
