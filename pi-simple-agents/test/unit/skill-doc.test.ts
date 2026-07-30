import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../../src/frontmatter.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const skillDir = path.join(repoRoot, "skills", "invoking-subagents");
const skillPath = path.join(skillDir, "SKILL.md");

test("skills/invoking-subagents/SKILL.md exists and its frontmatter parses without warnings", () => {
  assert.equal(fs.existsSync(skillPath), true);

  const content = fs.readFileSync(skillPath, "utf8");
  const { frontmatter, warnings } = parseFrontmatter(content);

  assert.deepEqual(warnings, []);
  assert.ok(frontmatter.name, "expected frontmatter.name to be set");
});

test("frontmatter.name matches the naming convention and the parent directory basename", () => {
  const content = fs.readFileSync(skillPath, "utf8");
  const { frontmatter } = parseFrontmatter(content);

  assert.equal(frontmatter.name, "invoking-subagents");
  assert.match(frontmatter.name as string, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok((frontmatter.name as string).length <= 64);
  assert.equal(frontmatter.name, path.basename(skillDir));
});

test("frontmatter.description is a non-empty string within the length limit", () => {
  const content = fs.readFileSync(skillPath, "utf8");
  const { frontmatter } = parseFrontmatter(content);

  assert.equal(typeof frontmatter.description, "string");
  const description = (frontmatter.description as string).trim();
  assert.ok(description.length > 0);
  assert.ok(description.length <= 1024);
});

test("SKILL.md body has fewer than 500 lines", () => {
  const content = fs.readFileSync(skillPath, "utf8");
  const { body } = parseFrontmatter(content);

  const lineCount = body.split(/\r?\n/).length;
  assert.ok(lineCount < 500, `expected body to have < 500 lines, got ${lineCount}`);
});

test("package.json declares pi.skills including ./skills", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  assert.ok(Array.isArray(pkg.pi?.skills));
  assert.ok(pkg.pi.skills.includes("./skills"));
});
