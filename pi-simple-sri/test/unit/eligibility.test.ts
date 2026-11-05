import { test } from "node:test";
import assert from "node:assert/strict";
import { isEligible, isEligibleUnderAnySpelling, spellingsOfSkill } from "../../src/eligibility.ts";
import { PUBLISHED_SKILL_NAME } from "../../src/names.ts";
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

// M3 (S7): the spellings have one owner now, and it is the module the rule lives in. The loop, the gate and the acceptance
// decide with the list this function answers, so the shape and the order of the list are what the three sites share.
test("spellingsOfSkill: a directory named after the skill answers one spelling", () => {
  assert.deepEqual(spellingsOfSkill({ name: "pdf-tools", dir: "/skills/pdf-tools" }), ["pdf-tools"]);
});

test("spellingsOfSkill: another directory name adds its basename after the name", () => {
  assert.deepEqual(spellingsOfSkill({ name: "syscfg", dir: "/skills/system-config" }), [
    "syscfg",
    "system-config",
  ]);
});

// The order is the one the rule reads and the one the table above spells out: the name of the frontmatter first, the
// basename of the directory after it, whichever of the two the settings happen to name -- the deepEqual above fixes the
// order, so this test fixes the reason it is that one.
test("spellingsOfSkill: the list is the one the rule of the spellings reads", () => {
  const spellings = spellingsOfSkill({ name: "syscfg", dir: "/skills/system-config" });

  assert.equal(spellings.length, 2);
  assert.deepEqual(isEligibleUnderAnySpelling(spellings, { allow: ["system-config"], deny: [] }), ELIGIBLE);
  assert.deepEqual(isEligibleUnderAnySpelling(spellings, { allow: [], deny: ["syscfg"] }), NOT_ELIGIBLE);
});

test("isEligible: does not mutate the config it reads", () => {
  const config: SriConfig = { allow: ["pdf-tools"], deny: ["system-config"] };

  isEligible("pdf-tools", config);
  isEligible("other-skill", config);

  assert.deepEqual(config, { allow: ["pdf-tools"], deny: ["system-config"] });
});

// M2c (S2b): the manual this package publishes is not a write target, whatever the settings say. The rule sits
// before `allow` and before `deny` inside isEligibleUnderAnySpelling, which is the one place every consumer reads
// the verdict from, and the reason it answers is a fact about the file and not a decision of the user: the skill
// travels inside the installed package, so a lesson written into it does not survive an update.
const PUBLISHED: Eligibility = { eligible: false, reason: "published-by-this-package" };

test("isEligible: the published manual is refused with its own reason under empty settings", () => {
  assert.deepEqual(isEligible(PUBLISHED_SKILL_NAME, { allow: [], deny: [] }), PUBLISHED);
});

// An empty allow admits every skill, and a non-empty one admits the skill it names: neither is a way in, because
// the exclusion of the manual is not one of the two lists the user writes.
test("isEligible: an allow that names the published manual does not admit it", () => {
  assert.deepEqual(isEligible(PUBLISHED_SKILL_NAME, { allow: [PUBLISHED_SKILL_NAME], deny: [] }), PUBLISHED);
});

// The rule runs before `deny`, so a user who denies the manual reads the reason of the package and not the one of
// the settings: the two facts do not survive the same change, and only one of them is about the file.
test("isEligible: a deny that names the published manual answers the reason of the package", () => {
  assert.deepEqual(isEligible(PUBLISHED_SKILL_NAME, { allow: [], deny: [PUBLISHED_SKILL_NAME] }), PUBLISHED);
});

// And a deny about another skill is a verdict about that skill: it changes nothing for the manual, which was already
// refused by the rule before the list was read.
test("isEligible: a deny that names another skill leaves the published manual refused as it is", () => {
  assert.deepEqual(isEligible(PUBLISHED_SKILL_NAME, { allow: [], deny: ["system-config"] }), PUBLISHED);
});

// F5 over the published manual: the rule reads every spelling the inventory gives, so a copy whose frontmatter name
// is the published one is refused in either order, and an allow that names both spellings is not a way in either.
test("isEligibleUnderAnySpelling: the published manual answers its own reason under both spellings", () => {
  assert.deepEqual(isEligibleUnderAnySpelling([PUBLISHED_SKILL_NAME, "pi-manual"], { allow: [], deny: [] }), PUBLISHED);
  assert.deepEqual(isEligibleUnderAnySpelling(["pi-manual", PUBLISHED_SKILL_NAME], { allow: [], deny: [] }), PUBLISHED);
  assert.deepEqual(
    isEligibleUnderAnySpelling([PUBLISHED_SKILL_NAME, "pi-manual"], {
      allow: [PUBLISHED_SKILL_NAME, "pi-manual"],
      deny: [],
    }),
    PUBLISHED,
  );
});
