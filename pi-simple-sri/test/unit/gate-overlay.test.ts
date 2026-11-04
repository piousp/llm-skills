import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildArmOverlays,
  type OverlayAbstention,
  type OverlayArms,
  type OverlayRequest,
  type OverlayResult,
} from "../../src/gate/overlay.ts";
import { ensureLessonsSection, upsertReferenceLine } from "../../src/skill-reference.ts";
import type { SkillRef } from "../../src/types.ts";
import { stagingDir } from "../../src/write-base.ts";

// The overlay of the two arms (Q9, Q13): everything here runs on a skill built in mkdtemp and on the
// staging tree the writer would have allocated next to it. No test names a real skill, and nothing outside
// the temporary directory is read or written.

const SKILL_NAME = "pdf-tools";
const SLUG = "merged-cells";
const TITLE = "Extract merged cells with the lattice strategy";
const REFERENCE = `- [lessons/${SLUG}.md](lessons/${SLUG}.md) - ${TITLE}`;
const EXISTING_REFERENCE = "- [lessons/pdf-first.md](lessons/pdf-first.md) - Open the PDF first";
const SECOND_REFERENCE = "- [lessons/pdf-second.md](lessons/pdf-second.md) - Split the table";
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const STAGING_TIMESTAMP = "20261102T140322481Z";

// The candidate lesson as the staging writer stores it, frontmatter included. It is written by hand and not
// with serializeLesson on purpose: the overlay moves these bytes and never parses them -- the format belongs
// to src/lesson-frontmatter.ts (P6) and was validated when the candidate was staged -- so this suite does not
// depend on that format nor on the decision schema.
const LESSON_TEXT = [
  "---",
  `slug: ${SLUG}`,
  `title: ${TITLE}`,
  "date: 2026-11-02",
  "status: proposed",
  "gate: pending",
  "---",
  "",
  "Use pdfplumber with the lattice strategy so merged cells stay apart.",
  "",
].join("\n");

// A declared skill the way a user writes one: frontmatter, a body that already lists two lessons, and a
// script next to them. The section exists, so the incumbent arm has to receive it untouched.
function skillFile(): string {
  return [
    "---",
    `name: ${SKILL_NAME}`,
    "description: Extract tables from PDFs",
    "---",
    "",
    "# pdf-tools",
    "",
    "Use the scripts in this directory.",
    "",
    "## Lessons",
    "",
    EXISTING_REFERENCE,
    SECOND_REFERENCE,
    "",
  ].join("\n");
}

// The same skill before anyone wrote a lesson: no section at all, which is the case the overlay has to
// complete so the two arms are comparable.
function skillFileWithoutLessonsSection(): string {
  return [
    "---",
    `name: ${SKILL_NAME}`,
    "description: Extract tables from PDFs",
    "---",
    "",
    "# pdf-tools",
    "",
    "Use the scripts in this directory.",
    "",
  ].join("\n");
}

interface Fixture {
  base: string; // the write base of the run: <base>/staging holds the arms
  stagingPath: string; // the candidate directory the staging writer allocates
  skill: SkillRef;
}

interface FixtureOptions {
  lessonsSection?: boolean;
}

function createFixture(t: TestContext, options: FixtureOptions = {}): Fixture {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-gate-overlay-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const skillDir = path.join(base, "skills", SKILL_NAME);
  fs.mkdirSync(path.join(skillDir, "lessons"), { recursive: true });
  fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(skillDir, ".history", STAGING_TIMESTAMP), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    options.lessonsSection === false ? skillFileWithoutLessonsSection() : skillFile(),
    "utf8",
  );
  fs.writeFileSync(path.join(skillDir, "lessons", "pdf-first.md"), "first lesson\n", "utf8");
  fs.writeFileSync(path.join(skillDir, "lessons", "pdf-second.md"), "second lesson\n", "utf8");
  fs.writeFileSync(path.join(skillDir, "scripts", "run.sh"), "#!/bin/sh\necho hi\n", "utf8");
  // A skill's own history: never part of an arm, because a copy that carried it would double a history that
  // is never rewritten.
  fs.writeFileSync(path.join(skillDir, ".history", STAGING_TIMESTAMP, "SKILL.md"), "an older skill\n", "utf8");

  // The candidate directory writeStagingCandidate allocates before the gate runs. The arms land inside it,
  // so the test builds it the way the writer does and lets the overlay place everything below it.
  const stagingPath = path.join(stagingDir(base), STAGING_TIMESTAMP, SKILL_NAME);
  fs.mkdirSync(stagingPath, { recursive: true });

  return {
    base,
    stagingPath,
    skill: {
      name: SKILL_NAME,
      description: "Extract tables from PDFs",
      dir: skillDir,
      realDir: fs.realpathSync(skillDir),
      hasLessons: true,
      kind: "declared",
    },
  };
}

function request(fixture: Fixture): OverlayRequest {
  return {
    base: fixture.base,
    stagingPath: fixture.stagingPath,
    skill: fixture.skill,
    slug: SLUG,
    title: TITLE,
    lessonText: LESSON_TEXT,
  };
}

function armsOf(result: OverlayResult): OverlayArms {
  if (!result.ok) {
    assert.fail(`the overlay must be built: ${result.error.detail}`);
  }
  return result.value;
}

function abstentionOf(result: OverlayResult): OverlayAbstention {
  if (result.ok) {
    assert.fail("the overlay must abstain");
  }
  return result.error;
}

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

// Forward-slash relative paths, sorted: the same shape the writer's own tests use, so a tree can be compared
// as a list instead of by probing single paths.
function relativeTree(rootDir: string): string[] {
  const entries: string[] = [];

  const walk = (currentDir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path.join(currentDir, entry.name), relative);
      } else {
        entries.push(relative);
      }
    }
  };

  walk(rootDir, "");
  return entries.sort();
}

// The hashes of this suite are computed here and not with src/hash.ts: what the overlay reports has to match
// what an independent computation of the same bytes produces.
function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// The manifest of the tree the two arms were copied from: the sorted relative paths, each with the digest of
// its bytes, and .history/ left out because no arm receives it.
function manifestHashOfSkill(skillDir: string): string {
  const manifest = relativeTree(skillDir)
    .filter((relative) => !relative.startsWith(".history/") && !relative.startsWith(".git/"))
    .map((relative) => `sha256:${sha256Hex(fs.readFileSync(path.join(skillDir, relative)))}  ${relative}`);
  return `sha256:${sha256Hex(Buffer.from(manifest.join("\n"), "utf8"))}`;
}

test("buildArmOverlays: both arms are copies of the skill inside staging, the candidate with one lesson more", async (t) => {
  const fixture = createFixture(t);
  const skillTreeBefore = relativeTree(fixture.skill.realDir);

  const arms = armsOf(await buildArmOverlays(request(fixture)));

  // <base>/staging/<ts>/<skill>/arms/{incumbent,candidate}/<name>: both arms next to the staged candidate,
  // and neither of them in the skill.
  assert.equal(arms.incumbentDir, path.join(fixture.stagingPath, "arms", "incumbent", SKILL_NAME));
  assert.equal(arms.candidateDir, path.join(fixture.stagingPath, "arms", "candidate", SKILL_NAME));
  assert.deepEqual(relativeTree(arms.incumbentDir), [
    "SKILL.md",
    "lessons/pdf-first.md",
    "lessons/pdf-second.md",
    "scripts/run.sh",
  ]);
  // The candidate is the same tree plus the one lesson the replay has to see.
  assert.deepEqual(relativeTree(arms.candidateDir), [
    "SKILL.md",
    `lessons/${SLUG}.md`,
    "lessons/pdf-first.md",
    "lessons/pdf-second.md",
    "scripts/run.sh",
  ]);
  assert.equal(readFile(path.join(arms.candidateDir, "lessons", `${SLUG}.md`)), LESSON_TEXT);

  // The skill's own history travels with neither arm, and the skill itself is exactly as it was: the overlay
  // only ever writes inside staging.
  assert.equal(fs.existsSync(path.join(arms.incumbentDir, ".history")), false);
  assert.equal(fs.existsSync(path.join(arms.candidateDir, ".history")), false);
  assert.deepEqual(relativeTree(fixture.skill.realDir), skillTreeBefore);
});

test("buildArmOverlays: the two SKILL.md differ in exactly the line of the candidate reference", async (t) => {
  const fixture = createFixture(t);
  const arms = armsOf(await buildArmOverlays(request(fixture)));

  const incumbentLines = readFile(path.join(arms.incumbentDir, "SKILL.md")).split("\n");
  const candidateLines = readFile(path.join(arms.candidateDir, "SKILL.md")).split("\n");

  // The incumbent is the skill as written: the section already existed, so nothing was added to it.
  assert.equal(readFile(path.join(arms.incumbentDir, "SKILL.md")), skillFile());

  // The candidate is one line longer and that line is the reference, inserted where the section starts.
  assert.equal(candidateLines.length, incumbentLines.length + 1);
  const insertedAt = incumbentLines.findIndex((line, index) => line !== candidateLines[index]);
  assert.notEqual(insertedAt, -1);
  assert.equal(candidateLines[insertedAt], REFERENCE);
  assert.deepEqual(candidateLines.slice(insertedAt + 1), incumbentLines.slice(insertedAt));
});

test("buildArmOverlays: a skill with no Lessons section gets the empty section in both arms", async (t) => {
  const fixture = createFixture(t, { lessonsSection: false });
  const arms = armsOf(await buildArmOverlays(request(fixture)));

  // The incumbent is the skill with the section present and no line of this candidate in it: empty, because
  // the skill had none. Without it the incumbent would be a different scenario and not a control.
  const incumbentText = readFile(path.join(arms.incumbentDir, "SKILL.md"));
  assert.equal(incumbentText, `${skillFileWithoutLessonsSection()}\n## Lessons\n`);

  // The candidate reaches the same text plus the reference, which is the single line the replay must be
  // reading: the section and its list are the same in both arms.
  const candidateText = readFile(path.join(arms.candidateDir, "SKILL.md"));
  assert.equal(candidateText, `${skillFileWithoutLessonsSection()}\n## Lessons\n\n${REFERENCE}\n`);
});

test("buildArmOverlays: skillContentHash is the sha256 of the SKILL.md before any copy", async (t) => {
  const fixture = createFixture(t);
  const originalBytes = fs.readFileSync(path.join(fixture.skill.realDir, "SKILL.md"));

  const arms = armsOf(await buildArmOverlays(request(fixture)));

  assert.equal(arms.skillContentHash, `sha256:${sha256Hex(originalBytes)}`);
  assert.match(arms.skillContentHash, HASH_PATTERN);
  // It is the original and not an arm: the candidate's SKILL.md carries one more line, so its hash is a
  // different value and a drift check against this one cannot pass by accident.
  const candidateBytes = fs.readFileSync(path.join(arms.candidateDir, "SKILL.md"));
  assert.notEqual(arms.skillContentHash, `sha256:${sha256Hex(candidateBytes)}`);

  // The manifest describes the tree both arms were copied from: the skill without its history, which is
  // what makes the two arms a pair and lets a later reader notice an arm that diverged.
  assert.match(arms.manifestHash, HASH_PATTERN);
  assert.equal(arms.manifestHash, manifestHashOfSkill(fixture.skill.realDir));
});

// A symlink inside the skill can point anywhere, so the copy refuses it and the overlay answers an
// abstention instead of throwing: the gate records it and abstains, and no half-built arm is published.
test("buildArmOverlays: a symlink inside the skill is a typed abstention, not a raw exception", async (t) => {
  const fixture = createFixture(t);
  fs.symlinkSync(path.join(fixture.skill.realDir, "scripts"), path.join(fixture.skill.realDir, "linked"));

  const abstention = abstentionOf(await buildArmOverlays(request(fixture)));

  assert.equal(abstention.reason, "overlay-failed");
  assert.equal(abstention.detail.includes("linked"), true);
  assert.equal(abstention.detail.includes("only regular files and directories are copied"), true);
  // Neither destination survives: an arm without its pair is not an overlay.
  for (const arm of ["incumbent", "candidate"]) {
    assert.equal(fs.existsSync(path.join(fixture.stagingPath, "arms", arm, SKILL_NAME)), false);
  }
  // The refusal is about the copy and not about the source: the skill keeps the bytes it had.
  assert.equal(readFile(path.join(fixture.skill.realDir, "SKILL.md")), skillFile());
});

// ---------------------------------------------------------------------------------------------
// ensureLessonsSection: the text half of Q13. The rules of the section are text -> text, so both halves are
// pinned here without a disk: the arm that must already have it, and the fact that the candidate reaches the
// same text whether the section is ensured first or the line is added to the bare skill.
// ---------------------------------------------------------------------------------------------

// A skill that already has the section is returned byte for byte: not re-rendered, not moved, and the
// sub-sections the author wrote below the list stay where they are.
interface SectionPresentCase {
  name: string;
  text: string;
}

const SECTION_PRESENT_CASES: readonly SectionPresentCase[] = [
  { name: "an empty section at the end of the file", text: "# pdf-tools\n\n## Lessons\n" },
  { name: "a section that lists a lesson", text: `# pdf-tools\n\n## Lessons\n\n${EXISTING_REFERENCE}\n` },
  {
    name: "a section closed by another section",
    text: "# pdf-tools\n\n## Lessons\n\n## Notes\n\nKeep it short.\n",
  },
  {
    name: "a section with a sub-section below the list",
    text: `# pdf-tools\n\n## Lessons\n\n${EXISTING_REFERENCE}\n\n### Detalle\n\nNotes.\n`,
  },
];

for (const entry of SECTION_PRESENT_CASES) {
  test(`ensureLessonsSection: a skill that already has the section is returned unchanged (${entry.name})`, () => {
    assert.equal(ensureLessonsSection(entry.text), entry.text);
    // Idempotent by construction: the second call sees the section and answers the same text.
    assert.equal(ensureLessonsSection(ensureLessonsSection(entry.text)), entry.text);
  });
}

// A skill without the section gains it at the end of the file, one blank line below what was there, and the
// text it already held is not touched: only the heading is added, with no bullet and no separator of its own.
interface SectionMissingCase {
  name: string;
  before: string;
  expected: string;
}

const SECTION_MISSING_CASES: readonly SectionMissingCase[] = [
  { name: "an empty file", before: "", expected: "## Lessons\n" },
  {
    name: "a file that ends with a newline",
    before: "# pdf-tools\n\nUse the scripts.\n",
    expected: "# pdf-tools\n\nUse the scripts.\n\n## Lessons\n",
  },
  { name: "a file that ends with a blank line", before: "# pdf-tools\n\n", expected: "# pdf-tools\n\n## Lessons\n" },
  { name: "a file without a trailing newline", before: "# pdf-tools", expected: "# pdf-tools\n\n## Lessons\n" },
];

for (const entry of SECTION_MISSING_CASES) {
  test(`ensureLessonsSection: a skill without the section keeps its text and gains the empty heading (${entry.name})`, () => {
    const ensured = ensureLessonsSection(entry.before);

    assert.equal(ensured, entry.expected);
    // What was already written is a prefix of the answer: the section is appended, never woven into the body.
    assert.equal(ensured.startsWith(entry.before), true);
    assert.equal(ensureLessonsSection(ensured), ensured);
    // And it is the same section the reference line would have created, which is what makes the two arms of
    // the gate differ in exactly one line: ensuring the section first and adding the line to the bare skill
    // reach the same text.
    assert.equal(upsertReferenceLine(ensured, SLUG, TITLE), upsertReferenceLine(entry.before, SLUG, TITLE));
  });
}
