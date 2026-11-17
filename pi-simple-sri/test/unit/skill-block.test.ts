import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSkillBlock } from "../../src/skill-block.ts";

const BLOCK = '<skill name="pdf-tables" location="/skills/pdf-tables/SKILL.md">\n# PDF tables\nUse pdftotext.\n</skill>';

test("splitSkillBlock: a block followed by user args yields the args and names the skill", () => {
  const result = splitSkillBlock(`${BLOCK}\n\nextract the table from report.pdf`);

  assert.deepEqual(result, {
    skill: { name: "pdf-tables", location: "/skills/pdf-tables/SKILL.md" },
    userText: "extract the table from report.pdf",
  });
});

test("splitSkillBlock: a block alone yields an empty user text", () => {
  const result = splitSkillBlock(BLOCK);

  assert.equal(result.skill?.name, "pdf-tables");
  assert.equal(result.userText, "");
});

test("splitSkillBlock: text without a block is returned unchanged and names no skill", () => {
  const text = "  plain prompt, mentions <skill> but is not one\n";

  assert.deepEqual(splitSkillBlock(text), { skill: null, userText: text });
});

test("splitSkillBlock: a malformed block (no closing tag) is plain text", () => {
  const text = '<skill name="pdf-tables" location="/x/SKILL.md">\nbody without end';

  assert.deepEqual(splitSkillBlock(text), { skill: null, userText: text });
});

test("splitSkillBlock: a block that does not open the text is plain text", () => {
  const text = `please run this: ${BLOCK}`;

  assert.deepEqual(splitSkillBlock(text), { skill: null, userText: text });
});

test("splitSkillBlock: the skill body never leaks into the user text", () => {
  const { userText } = splitSkillBlock(`${BLOCK}\n\ngo`);

  assert.equal(userText.includes("Use pdftotext."), false);
});
