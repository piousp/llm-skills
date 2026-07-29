import { test } from "node:test";
import assert from "node:assert/strict";
import { filterSkillsByName } from "../../src/skills-filter.ts";

const base = [{ name: "a" }, { name: "b" }, { name: "c" }];

test("filterSkillsByName: keeps base order, not requested order", () => {
  const result = filterSkillsByName(base, ["a", "c"]);

  assert.deepEqual(result, {
    skills: [{ name: "a" }, { name: "c" }],
    missing: [],
  });
});

test("filterSkillsByName: unmatched requested name is reported as missing", () => {
  const result = filterSkillsByName(base, ["a", "zzz"]);

  assert.deepEqual(result, {
    skills: [{ name: "a" }],
    missing: ["zzz"],
  });
});

test("filterSkillsByName: empty requested yields empty skills and no missing", () => {
  const result = filterSkillsByName(base, []);

  assert.deepEqual(result, { skills: [], missing: [] });
});

test("filterSkillsByName: empty base reports every requested name as missing", () => {
  const result = filterSkillsByName([], ["a"]);

  assert.deepEqual(result, { skills: [], missing: ["a"] });
});

test("filterSkillsByName: matching is case-sensitive", () => {
  const result = filterSkillsByName([{ name: "Code-Review" }], ["code-review"]);

  assert.deepEqual(result, { skills: [], missing: ["code-review"] });
});

test("filterSkillsByName: duplicate requested names are deduplicated in both skills and missing", () => {
  const result = filterSkillsByName(base, ["a", "a"]);

  assert.deepEqual(result, { skills: [{ name: "a" }], missing: [] });
});
