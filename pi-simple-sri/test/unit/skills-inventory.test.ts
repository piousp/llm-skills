import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findSkill, isSymlinkedSkill, listSkills } from "../../src/skills-inventory.ts";
import type { SkillRef } from "../../src/types.ts";

interface SkillTree {
  root: string;
  cwd: string;
  agentDir: string;
  skillsDir: string;
}

interface FrontmatterInput {
  name?: string;
  description?: string;
}

// Every fixture lives under a canonical temp root: os.tmpdir() is a symlink on some
// platforms (macOS /var -> /private/var) and every entry would then report itself as
// symlinked. Resolving the temp root once leaves only the symlinks a test creates.
function createTree(t: TestContext): SkillTree {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-skills-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const cwd = path.join(root, "cwd");
  const agentDir = path.join(root, "agent");
  const skillsDir = path.join(agentDir, "skills");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });

  return { root, cwd, agentDir, skillsDir };
}

// listSkills builds its own loader, so the working directory stays empty: the only
// skills that can show up are the ones a test writes under <agentDir>/skills.
function inventory(tree: SkillTree): Promise<SkillRef[]> {
  return listSkills({ cwd: tree.cwd, agentDir: tree.agentDir });
}

function frontmatter(input: FrontmatterInput): string {
  const lines = ["---"];
  if (input.name !== undefined) lines.push(`name: ${input.name}`);
  if (input.description !== undefined) lines.push(`description: ${input.description}`);
  lines.push("---", "");
  return `${lines.join("\n")}\n`;
}

function writeSkillFile(filePath: string, input: FrontmatterInput): string {
  const body = `# ${path.basename(filePath)}\nBody of ${path.basename(filePath)}.\n`;
  fs.writeFileSync(filePath, `${frontmatter(input)}${body}`, "utf8");
  return filePath;
}

// Writes <parentDir>/<dirName>/SKILL.md and returns the skill directory.
function writeDeclaredSkill(parentDir: string, dirName: string, input: FrontmatterInput): string {
  const dir = path.join(parentDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  writeSkillFile(path.join(dir, "SKILL.md"), input);
  return dir;
}

// The skills that came from this test's tree. The loader also reads other locations
// (~/.agents/skills among them), so the assertions ignore anything that was not written
// by the test.
function skillsFromTree(skills: readonly SkillRef[], tree: SkillTree): SkillRef[] {
  const prefix = `${tree.root}${path.sep}`;
  return skills.filter((skill) => skill.dir.startsWith(prefix));
}

function namesFromTree(skills: readonly SkillRef[], tree: SkillTree): string[] {
  return skillsFromTree(skills, tree).map((skill) => skill.name);
}

// Deliberately no await on a reload() first: without a fresh loader plus reload()
// the inventory comes back empty (DefaultResourceLoader starts with skills = [] and
// only reload() fills the list), so a populated result here is what catches a
// loader that is cached at module scope or never reloaded.
test("listSkills: a directory with SKILL.md and a description is a declared skill", async (t) => {
  const tree = createTree(t);
  const dir = writeDeclaredSkill(tree.skillsDir, "pdf-tools", { description: "Extract tables from PDFs" });

  const skills = await inventory(tree);

  const skill = findSkill(skills, "pdf-tools");
  assert.ok(skill, `expected pdf-tools in ${JSON.stringify(namesFromTree(skills, tree))}`);
  assert.equal(skill.name, "pdf-tools");
  assert.equal(skill.description, "Extract tables from PDFs");
  assert.equal(skill.dir, dir);
  assert.equal(skill.realDir, fs.realpathSync(dir));
  assert.equal(isSymlinkedSkill(skill), false);
  assert.equal(skill.hasLessons, false);
  assert.equal(skill.kind, "declared");
});

test("listSkills: a skill without a description is left out, since pi cannot route it", async (t) => {
  const tree = createTree(t);
  writeDeclaredSkill(tree.skillsDir, "pdf-tools", { description: "Extract tables from PDFs" });
  writeDeclaredSkill(tree.skillsDir, "no-description", {});

  const skills = await inventory(tree);

  assert.deepEqual(namesFromTree(skills, tree).sort(), ["pdf-tools"]);
  assert.equal(findSkill(skills, "no-description"), undefined);
});

test("listSkills: a symlinked skill reports the real directory and isSymlinkedSkill", async (t) => {
  const tree = createTree(t);
  const externalDir = writeDeclaredSkill(path.join(tree.root, "external"), "pdf-tools", {
    description: "Extract tables from PDFs",
  });
  const linkPath = path.join(tree.skillsDir, "pdf-tools");
  fs.symlinkSync(externalDir, linkPath, "dir");

  const skills = await inventory(tree);

  const skill = findSkill(skills, "pdf-tools");
  assert.ok(skill, `expected pdf-tools in ${JSON.stringify(namesFromTree(skills, tree))}`);
  assert.equal(skill.dir, linkPath);
  assert.equal(skill.realDir, fs.realpathSync(externalDir));
  assert.notEqual(skill.dir, skill.realDir);
  assert.equal(isSymlinkedSkill(skill), true);
  assert.equal(skill.kind, "declared");
});

test("listSkills: hasLessons is true only when lessons/ is a directory inside the skill", async (t) => {
  const tree = createTree(t);
  const withLessons = writeDeclaredSkill(tree.skillsDir, "with-lessons", { description: "Skill with lessons" });
  fs.mkdirSync(path.join(withLessons, "lessons"), { recursive: true });
  const lessonsAsFile = writeDeclaredSkill(tree.skillsDir, "lessons-as-file", {
    description: "Skill whose lessons path is a file",
  });
  fs.writeFileSync(path.join(lessonsAsFile, "lessons"), "not a directory\n", "utf8");

  const skills = await inventory(tree);

  const lessonsSkill = findSkill(skills, "with-lessons");
  assert.ok(lessonsSkill);
  assert.equal(lessonsSkill.hasLessons, true);
  const fileSkill = findSkill(skills, "lessons-as-file");
  assert.ok(fileSkill);
  assert.equal(fileSkill.hasLessons, false);
});

test("listSkills: a name collision keeps the first skill pi discovers", async (t) => {
  const sharedName = "shared-name";
  const tree = createTree(t);
  writeDeclaredSkill(tree.skillsDir, "dup-a", { name: sharedName, description: "First duplicate" });
  writeDeclaredSkill(tree.skillsDir, "dup-b", { name: sharedName, description: "Second duplicate" });

  // Discovery order is readdir order, so the winner is the first directory the
  // loader visits; it is read here instead of assumed to be alphabetical.
  const firstVisited = fs
    .readdirSync(tree.skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .at(0);
  assert.ok(firstVisited, "expected at least one skill directory in the fixture");

  const skills = await inventory(tree);

  const matches = skills.filter((skill) => skill.name === sharedName);
  assert.deepEqual(
    matches.map((skill) => skill.dir),
    [path.join(tree.skillsDir, firstVisited)],
  );
});

test("listSkills: a loose .md file is a standalone skill inside the shared skills directory", async (t) => {
  const tree = createTree(t);
  fs.mkdirSync(path.join(tree.skillsDir, "lessons"), { recursive: true });
  writeSkillFile(path.join(tree.skillsDir, "notes.md"), { name: "standalone-notes", description: "Loose notes" });

  const skills = await inventory(tree);

  // findSkill answers for declared skills only, so the standalone is read from the
  // inventory itself.
  const skill = skillsFromTree(skills, tree).find((candidate) => candidate.name === "standalone-notes");
  assert.ok(skill, `expected standalone-notes in ${JSON.stringify(namesFromTree(skills, tree))}`);
  assert.equal(skill.kind, "standalone");
  // No directory of its own: the shared skills directory is not a write target and
  // a lessons/ directory sitting there is not this skill's lessons.
  assert.equal(skill.dir, tree.skillsDir);
  assert.equal(skill.hasLessons, false);
});

test("listSkills: dot-directories and .md files inside a skill are not separate skills", async (t) => {
  const tree = createTree(t);
  const dir = writeDeclaredSkill(tree.skillsDir, "with-history", { description: "Skill with history" });
  const snapshot = path.join(dir, ".history", "20260101T000000000Z");
  fs.mkdirSync(snapshot, { recursive: true });
  writeSkillFile(path.join(snapshot, "SKILL.md"), { name: "history-ghost", description: "Snapshot of a skill" });
  fs.mkdirSync(path.join(dir, "lessons"), { recursive: true });
  writeSkillFile(path.join(dir, "lessons", "first.md"), { name: "lesson-ghost", description: "A lesson, not a skill" });

  const skills = await inventory(tree);

  assert.deepEqual(namesFromTree(skills, tree), ["with-history"]);
});

test("listSkills: every call reflects the skills added after the previous call", async (t) => {
  const tree = createTree(t);
  writeDeclaredSkill(tree.skillsDir, "pdf-tools", { description: "Extract tables from PDFs" });

  assert.deepEqual(namesFromTree(await inventory(tree), tree), ["pdf-tools"]);

  writeDeclaredSkill(tree.skillsDir, "code-review", { description: "Review code changes" });

  assert.deepEqual(namesFromTree(await inventory(tree), tree).sort(), ["code-review", "pdf-tools"]);
});

test("findSkill: matches the frontmatter name and the directory name", async (t) => {
  const tree = createTree(t);
  const dir = writeDeclaredSkill(tree.skillsDir, "pdf-tools-dir", {
    name: "pdf-tools",
    description: "Extract tables from PDFs",
  });

  const skills = await inventory(tree);

  const byName = findSkill(skills, "pdf-tools");
  assert.ok(byName);
  assert.equal(byName.dir, dir);

  const byDirName = findSkill(skills, "pdf-tools-dir");
  assert.ok(byDirName);
  assert.equal(byDirName.dir, dir);

  assert.equal(findSkill(skills, "no-such-skill"), undefined);
});

test("findSkill: a frontmatter name match wins over a directory name match", async (t) => {
  const tree = createTree(t);
  const namedDir = writeDeclaredSkill(tree.skillsDir, "alpha", { name: "code-review", description: "Named code-review" });
  writeDeclaredSkill(tree.skillsDir, "code-review", { name: "zed-review", description: "Sits in a code-review directory" });

  const skills = await inventory(tree);

  const found = findSkill(skills, "code-review");
  assert.ok(found);
  assert.equal(found.dir, namedDir);
});

// G4: the standalone skill's dir is the shared skills directory, so matching it by that
// directory name would answer a request for "skills" with an unrelated skill and hand the
// caller the root every standalone skill shares as the write target.
test("findSkill: a standalone skill is never returned, not even by the shared directory name", async (t) => {
  const tree = createTree(t);
  writeDeclaredSkill(tree.skillsDir, "pdf-tools", { description: "Extract tables from PDFs" });
  writeSkillFile(path.join(tree.skillsDir, "notes.md"), { name: "standalone-notes", description: "Loose notes" });

  const skills = skillsFromTree(await inventory(tree), tree);
  assert.deepEqual(namesFromTree(skills, tree).sort(), ["pdf-tools", "standalone-notes"]);

  const sharedDirName = path.basename(tree.skillsDir);
  assert.equal(sharedDirName, "skills");
  assert.equal(findSkill(skills, sharedDirName), undefined);
  assert.equal(findSkill(skills, "standalone-notes"), undefined);
});

// G4: the kind filter must not cost the directory-name fallback for a declared skill whose
// frontmatter name differs from its directory, which is the case pi allows.
test("findSkill: a declared skill whose frontmatter name differs from its directory still resolves", async (t) => {
  const tree = createTree(t);
  const dir = writeDeclaredSkill(tree.skillsDir, "pdf-tools-dir", {
    name: "pdf-tools",
    description: "Extract tables from PDFs",
  });
  writeSkillFile(path.join(tree.skillsDir, "notes.md"), { name: "standalone-notes", description: "Loose notes" });

  const skills = skillsFromTree(await inventory(tree), tree);

  const byName = findSkill(skills, "pdf-tools");
  assert.ok(byName);
  assert.equal(byName.dir, dir);
  assert.equal(byName.kind, "declared");

  const byDirName = findSkill(skills, "pdf-tools-dir");
  assert.ok(byDirName);
  assert.equal(byDirName.dir, dir);
});
