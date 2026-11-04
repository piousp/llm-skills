import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serializeLesson } from "../../src/lesson-frontmatter.ts";
import { stagingDir, stateDir } from "../../src/write-base.ts";
import { SriPerimeterError } from "../../src/perimeter.ts";
import {
  appendAttemptLine,
  copySkillTree,
  discardStagingCandidate,
  removeLessonFile,
  rewriteStagingDecision,
  snapshotForHistory,
  SriWriterError,
  upsertReferenceLine,
  writeHistoryDecision,
  writeLessonFile,
  writeStagingCandidate,
  writeTextAtomically,
  type StagingWriteInput,
} from "../../src/writer.ts";
import type { AttemptLine, DecisionRecord, LessonDraft, SkillRef } from "../../src/types.ts";

const FIXED_NOW = new Date("2026-11-02T14:03:22.481Z");
const BASE_TIMESTAMP = "20261102T140322481Z";
const LESSON_SLUG = "pdf-tables-merged-cells";
const LESSON_TITLE = "Extract tables with merged cells";
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HASH_PLACEHOLDER = `sha256:${"a".repeat(64)}`;

interface Fixture {
  base: string;
  pkg: string;
  skillsDir: string;
}

function createFixture(t: TestContext): Fixture {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-writer-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const pkg = path.join(base, "pi-simple-sri");
  const skillsDir = path.join(base, "skills");
  fs.mkdirSync(pkg, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });

  return { base, pkg, skillsDir };
}

function skillFile(): string {
  return [
    "---",
    "name: pdf-tools",
    "description: Extract tables from PDFs",
    "---",
    "",
    "# pdf-tools",
    "",
    "Use the scripts in this directory.",
    "",
  ].join("\n");
}

function makeSkill(fixture: Fixture, name = "pdf-tools"): SkillRef {
  const dir = path.join(fixture.skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), skillFile(), "utf8");

  return {
    name,
    description: "Extract tables from PDFs",
    dir,
    realDir: fs.realpathSync(dir),
    hasLessons: false,
    kind: "declared",
  };
}

function makeDraft(overrides: Partial<LessonDraft> = {}): LessonDraft {
  return {
    slug: LESSON_SLUG,
    title: LESSON_TITLE,
    date: "2026-11-02",
    status: "proposed",
    sourceEvidence: ["ev-3f9a1c02"],
    gate: "pending",
    body: "Use pdfplumber with the lattice strategy for merged cells.",
    ...overrides,
  };
}

// The writer never renders the lesson file: it stores the text it is given and reads it back,
// because src/lesson-frontmatter.ts (P6) owns the frontmatter format. The text is the real
// serialization of the draft, so a test that changes the draft changes the bytes the writer sees
// and the body it hashes.
function lessonTextFor(draft: LessonDraft): string {
  const serialized = serializeLesson(draft);
  if (!serialized.ok) {
    assert.fail(`the draft of a writer test must serialize: ${serialized.error}`);
  }
  return serialized.value;
}

function makeDecision(): DecisionRecord {
  return {
    schema: "pi-simple-sri/decision@1",
    createdAt: "2026-11-02T14:03:22.481Z",
    trigger: { surface: "command", focus: "merged cells" },
    skill: {
      name: "pdf-tools",
      dir: "/skills/pdf-tools",
      realDir: "/skills/pdf-tools",
      wasSymlink: false,
      eligible: true,
    },
    eligibility: { allow: [], deny: ["system-config"] },
    evidence: [
      {
        id: "ev-3f9a1c02",
        kind: "tool_error",
        toolName: "bash",
        argsHash: "sha256:deadbeef",
        excerpt: "pdftotext collapses merged cells",
        timestamp: 1762082602481,
        source: "transcript",
      },
    ],
    diagnosis: {
      summary: "Table extraction loses merged cells",
      failureSignature: HASH_PLACEHOLDER,
      replayItems: [
        { prompt: "extract the table", cwd: "/work", expectation: { class: "tool_error", version: 1, tool: "bash" } },
      ],
    },
    candidate: {
      kind: "new-lesson",
      slug: LESSON_SLUG,
      title: LESSON_TITLE,
      targetLesson: null,
      lessonPath: `lessons/${LESSON_SLUG}.md`,
      contentHash: HASH_PLACEHOLDER,
      bodyHash: HASH_PLACEHOLDER,
    },
    gate: {
      basis: "replay",
      status: "not-run",
      budget: { plannedRuns: 0, usedRuns: 0, interruptedAt: null },
      tokens: {
        proposal: { input: 0, output: 0 },
        incumbent: { input: 0, output: 0 },
        candidate: { input: 0, output: 0 },
        total: { input: 0, output: 0 },
      },
      preregistration: null,
      replay: null,
    },
    outcome: { status: "proposed", reason: null, decidedAt: null },
  };
}

interface InputOverrides {
  base?: string;
  now?: Date;
  draft?: LessonDraft;
  slug?: string;
  lessonText?: string;
  skill?: SkillRef;
  decision?: DecisionRecord;
}

function inputFor(fixture: Fixture, overrides: InputOverrides = {}): StagingWriteInput {
  const draft = overrides.draft ?? makeDraft();
  return {
    base: overrides.base ?? fixture.pkg,
    skill: overrides.skill ?? makeSkill(fixture),
    slug: overrides.slug ?? draft.slug,
    decision: overrides.decision ?? makeDecision(),
    now: overrides.now ?? FIXED_NOW,
    lessonText: overrides.lessonText ?? lessonTextFor(draft),
  };
}

function attemptLine(overrides: Partial<AttemptLine> = {}): AttemptLine {
  return {
    ts: "2026-11-02T14:03:22.490Z",
    event: "proposed",
    candidateHash: `sha256:${"b".repeat(64)}`,
    bodyHash: `sha256:${"c".repeat(64)}`,
    // OA4: every line carries the failure it is about, and one that has none says so with a null. A digest
    // here instead of the null proves the field travels through the append unchanged either way.
    failureSignature: `sha256:${"d".repeat(64)}`,
    targetSkill: "pdf-tools",
    stagingPath: `/pkg/staging/${BASE_TIMESTAMP}/pdf-tools`,
    decisionPath: `/pkg/staging/${BASE_TIMESTAMP}/pdf-tools/decision.json`,
    ...overrides,
  };
}

// Forward-slash relative paths, sorted: stable across the assertions below.
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

function sha256File(filePath: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

// The contentHash of a lesson text, computed here and not with the writer's own helper: the expected
// hash of the M1 tests is the one an independent computation produces.
function sha256Text(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

test("writeStagingCandidate: writes the lesson and decision.json under staging/<ts>/<skill>", async (t) => {
  const fixture = createFixture(t);
  const input = inputFor(fixture);

  const result = await writeStagingCandidate(input);

  const candidateDir = path.join(stagingDir(fixture.pkg), BASE_TIMESTAMP, "pdf-tools");
  assert.equal(result.stagingPath, candidateDir);
  assert.equal(result.lessonPath, path.join(candidateDir, "lessons", `${LESSON_SLUG}.md`));
  assert.equal(result.decisionPath, path.join(candidateDir, "decision.json"));
  assert.deepEqual(relativeTree(candidateDir), ["decision.json", `lessons/${LESSON_SLUG}.md`]);
  assert.equal(fs.readFileSync(result.lessonPath, "utf8"), input.lessonText);
  assert.equal(fs.existsSync(result.decisionPath), true);
});

test("writeStagingCandidate: the timestamp directory is UTC and holds no colons", async (t) => {
  const fixture = createFixture(t);

  await writeStagingCandidate(inputFor(fixture));

  assert.deepEqual(fs.readdirSync(stagingDir(fixture.pkg)), [BASE_TIMESTAMP]);
  assert.equal(BASE_TIMESTAMP, "20261102T140322481Z");
});

test("writeStagingCandidate: decision.json is the record carrying the hashes of the files on disk", async (t) => {
  const fixture = createFixture(t);
  const input = inputFor(fixture);

  const result = await writeStagingCandidate(input);

  const text = fs.readFileSync(result.decisionPath, "utf8");
  // Exactly one trailing newline, so appending to the file stays a line operation.
  assert.equal(text.endsWith("}\n"), true);
  const onDisk: unknown = JSON.parse(text);
  assert.deepEqual(onDisk, {
    ...input.decision,
    candidate: { ...input.decision.candidate, contentHash: result.contentHash, bodyHash: result.bodyHash },
  });
  assert.match(result.contentHash, HASH_PATTERN);
  assert.match(result.bodyHash, HASH_PATTERN);
  assert.equal(result.contentHash, sha256File(result.lessonPath));
});

test("writeStagingCandidate: no temporary file is left behind", async (t) => {
  const fixture = createFixture(t);
  const result = await writeStagingCandidate(inputFor(fixture));

  assert.deepEqual(fs.readdirSync(result.stagingPath).sort(), ["decision.json", "lessons"]);
  assert.deepEqual(fs.readdirSync(path.dirname(result.lessonPath)), [`${LESSON_SLUG}.md`]);
});

test("writeStagingCandidate: a repeated timestamp gets -2 and -3", async (t) => {
  const fixture = createFixture(t);

  const first = await writeStagingCandidate(inputFor(fixture));
  const second = await writeStagingCandidate(inputFor(fixture));
  const third = await writeStagingCandidate(inputFor(fixture));

  assert.deepEqual(fs.readdirSync(stagingDir(fixture.pkg)).sort(), [
    BASE_TIMESTAMP,
    `${BASE_TIMESTAMP}-2`,
    `${BASE_TIMESTAMP}-3`,
  ]);
  assert.notEqual(first.stagingPath, second.stagingPath);
  assert.notEqual(second.stagingPath, third.stagingPath);
  assert.equal(fs.readFileSync(second.lessonPath, "utf8"), lessonTextFor(makeDraft()));
  assert.equal(fs.existsSync(third.decisionPath), true);
});

// mkdir is the atomic test-and-set for the timestamp directory, so the second writer
// never shares (or overwrites) the first one's files.
test("writeStagingCandidate: two concurrent writes get separate directories", async (t) => {
  const fixture = createFixture(t);

  const [first, second] = await Promise.all([
    writeStagingCandidate(inputFor(fixture)),
    writeStagingCandidate(inputFor(fixture)),
  ]);

  assert.notEqual(first.stagingPath, second.stagingPath);
  assert.deepEqual(fs.readdirSync(stagingDir(fixture.pkg)).sort(), [BASE_TIMESTAMP, `${BASE_TIMESTAMP}-2`]);
  for (const result of [first, second]) {
    assert.equal(fs.readFileSync(result.lessonPath, "utf8"), lessonTextFor(makeDraft()));
    assert.equal(fs.existsSync(result.decisionPath), true);
  }
});

// D4: the same body on a different date keeps bodyHash so the attempts index can join
// the two candidates; contentHash changes because the whole file changed.
test("writeStagingCandidate: a different date keeps bodyHash and changes contentHash", async (t) => {
  const fixture = createFixture(t);
  const body = "Use pdfplumber with the lattice strategy.";

  const first = await writeStagingCandidate(
    inputFor(fixture, { draft: makeDraft({ date: "2026-11-02", body }), now: new Date("2026-11-02T14:03:22.481Z") }),
  );
  const second = await writeStagingCandidate(
    inputFor(fixture, { draft: makeDraft({ date: "2026-11-03", body }), now: new Date("2026-11-03T14:03:22.481Z") }),
  );

  assert.equal(first.bodyHash, second.bodyHash);
  assert.notEqual(first.contentHash, second.contentHash);
});

test("writeStagingCandidate: bodyHash ignores whitespace differences in the body", async (t) => {
  const fixture = createFixture(t);

  const first = await writeStagingCandidate(
    inputFor(fixture, { draft: makeDraft({ body: "  Use  pdfplumber\nfor   merged cells.  " }) }),
  );
  const second = await writeStagingCandidate(inputFor(fixture, { draft: makeDraft({ body: "Use pdfplumber for merged cells." }) }));

  assert.equal(first.bodyHash, second.bodyHash);
  assert.notEqual(first.contentHash, second.contentHash);
});

test("writeStagingCandidate: a skill name that leaves staging fails before writing", async (t) => {
  const fixture = createFixture(t);
  const escaping: SkillRef = { ...makeSkill(fixture), name: "../../escape" };

  await assert.rejects(
    () => writeStagingCandidate(inputFor(fixture, { skill: escaping })),
    (error: unknown) => error instanceof SriPerimeterError,
  );

  assert.deepEqual(fs.readdirSync(stagingDir(fixture.pkg)), []);
  assert.equal(fs.existsSync(path.join(fixture.base, "escape")), false);
});

// A slug carrying a path separator stays inside staging but leaves lessons/, which is
// outside the directory the lesson belongs to. Nothing is published.
test("writeStagingCandidate: a slug that leaves the lessons directory publishes no file", async (t) => {
  const fixture = createFixture(t);

  await assert.rejects(
    () => writeStagingCandidate(inputFor(fixture, { slug: "../escape" })),
    (error: unknown) => error instanceof SriPerimeterError,
  );

  const published = relativeTree(stagingDir(fixture.pkg));
  assert.deepEqual(published, []);
});

test("writeStagingCandidate: an invalid date is refused instead of naming a directory", async (t) => {
  const fixture = createFixture(t);

  await assert.rejects(
    () => writeStagingCandidate(inputFor(fixture, { now: new Date(Number.NaN) })),
    (error: unknown) =>
      error instanceof SriWriterError &&
      // There is no path to blame, so the field is absent instead of an empty string that a reader
      // would have to know how to read.
      error.target === undefined,
  );

  assert.deepEqual(fs.readdirSync(stagingDir(fixture.pkg)), []);
});

// I6: the writer does not trust the object it is handed. The lesson text is read back with the
// parser that owns the format, and a text that parser rejects publishes nothing at all.
interface InvalidLessonText {
  name: string;
  text: string;
  messagePart: string;
}

const VALID_FRONTMATTER: readonly string[] = [
  'title: "Extract tables with merged cells"',
  'date: "2026-11-02"',
  'status: "proposed"',
  'source-evidence: ["ev-3f9a1c02"]',
  'gate: "pending"',
];

function frontmatterLesson(frontmatter: readonly string[], body = "Use lattice mode."): string {
  return `---\n${frontmatter.join("\n")}\n---\n\n${body}\n`;
}

const INVALID_LESSON_TEXTS: readonly InvalidLessonText[] = [
  {
    name: "a text without a frontmatter block",
    text: "Use pdfplumber with the lattice strategy.\n",
    messagePart: "frontmatter",
  },
  {
    name: "a text whose body is empty",
    text: frontmatterLesson(VALID_FRONTMATTER, "   "),
    messagePart: "body",
  },
  {
    name: "a text whose status is outside the set",
    text: frontmatterLesson([...VALID_FRONTMATTER.slice(0, 2), 'status: "draft"', ...VALID_FRONTMATTER.slice(3)]),
    messagePart: '"status"',
  },
];

for (const invalid of INVALID_LESSON_TEXTS) {
  test(`writeStagingCandidate: refuses lesson text that does not parse (${invalid.name})`, async (t) => {
    const fixture = createFixture(t);

    await assert.rejects(
      () => writeStagingCandidate(inputFor(fixture, { lessonText: invalid.text })),
      (error: unknown) => error instanceof SriWriterError && error.message.includes(invalid.messagePart),
    );

    // Nothing exists afterwards: the text is refused before the staging tree is created.
    assert.equal(fs.existsSync(stagingDir(fixture.pkg)), false);
  });
}

// I12: a relative base resolves against the working directory of the process, so the staging tree
// would appear in whatever project pi was started in, before the perimeter ever ran. The base of
// the fixture is handed over as the relative path that reaches it, so a regression creates the
// tree where the assertions below look instead of anywhere else.
test("writeStagingCandidate: a relative base is refused before the staging directory exists", async (t) => {
  const fixture = createFixture(t);
  const relativeRoot = path.relative(process.cwd(), fixture.pkg);

  await assert.rejects(
    () => writeStagingCandidate(inputFor(fixture, { base: relativeRoot })),
    (error: unknown) => error instanceof SriWriterError && error.message.includes("not absolute"),
  );

  assert.equal(path.isAbsolute(relativeRoot), false);
  assert.equal(fs.existsSync(stagingDir(fixture.pkg)), false);
});

// The read-back comparison has no hook between the write and the read, so the tests below replace
// the fs method that produces the bytes read. The original property descriptor goes back in a
// t.after hook: the writer is not loosened for the benefit of a test, and no permission of the
// machine is touched.
function stubPromise(t: TestContext, name: "readFile" | "rm", stub: (target: unknown) => Promise<unknown>): void {
  const original = Object.getOwnPropertyDescriptor(fs.promises, name);
  t.after(() => {
    if (original) {
      Object.defineProperty(fs.promises, name, original);
    } else {
      Reflect.deleteProperty(fs.promises, name);
    }
  });

  Object.defineProperty(fs.promises, name, { configurable: true, writable: true, value: stub });
}

function candidateLessonPath(pkgRoot: string, slug: string): string {
  return path.join(stagingDir(pkgRoot), BASE_TIMESTAMP, "pdf-tools", "lessons", `${slug}.md`);
}

// G1: the bytes read back after the write disagree with the bytes written. The file was written by
// this call and just proven wrong, so it must not stay published.
test("writeStagingCandidate: a read-back that disagrees with the write removes the lesson and fails", async (t) => {
  const fixture = createFixture(t);
  const lessonPath = candidateLessonPath(fixture.pkg, LESSON_SLUG);
  stubPromise(t, "readFile", async (target: unknown) =>
    String(target) === lessonPath ? Buffer.from("bytes nobody wrote\n", "utf8") : fs.readFileSync(String(target)),
  );

  await assert.rejects(
    () => writeStagingCandidate(inputFor(fixture)),
    (error: unknown) => error instanceof SriWriterError && error.message.includes("(removed: true)"),
  );

  assert.equal(fs.existsSync(lessonPath), false);
  // The record never lands: decision.json is written only after the lesson it names is verified.
  assert.equal(fs.existsSync(path.join(path.dirname(lessonPath), "..", "decision.json")), false);
});

// I8: the message has to say whether the removal worked, so a corrupt file that survived a failed
// removal is never reported as cleaned up.
test("writeStagingCandidate: the read-back error reports a removal that failed", async (t) => {
  const fixture = createFixture(t);
  const lessonPath = candidateLessonPath(fixture.pkg, LESSON_SLUG);
  stubPromise(t, "readFile", async (target: unknown) =>
    String(target) === lessonPath ? Buffer.from("bytes nobody wrote\n", "utf8") : fs.readFileSync(String(target)),
  );
  stubPromise(t, "rm", async () => {
    throw new Error("EACCES: permission denied, unlink");
  });

  await assert.rejects(
    () => writeStagingCandidate(inputFor(fixture)),
    (error: unknown) => error instanceof SriWriterError && error.message.includes("(removed: false)"),
  );

  assert.equal(fs.existsSync(lessonPath), true);
});

test("appendAttemptLine: two events leave two JSON lines and keep the first intact", async (t) => {
  const fixture = createFixture(t);
  const attemptsPath = path.join(stateDir(fixture.pkg), "attempts.jsonl");
  const firstLine = attemptLine({ event: "proposed" });
  const secondLine = attemptLine({ event: "accepted" });
  assert.equal(fs.existsSync(stateDir(fixture.pkg)), false);

  await appendAttemptLine(fixture.pkg, firstLine);
  const afterFirst = fs.readFileSync(attemptsPath, "utf8");
  await appendAttemptLine(fixture.pkg, secondLine);

  const content = fs.readFileSync(attemptsPath, "utf8");
  // Append-only: the bytes of the previous write survive untouched.
  assert.equal(content.startsWith(afterFirst), true);
  assert.equal(content.endsWith("\n"), true);

  const lines = content.split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 2);
  const parsedFirst: unknown = JSON.parse(lines[0]);
  const parsedSecond: unknown = JSON.parse(lines[1]);
  assert.deepEqual(parsedFirst, firstLine);
  assert.deepEqual(parsedSecond, secondLine);
});

test("appendAttemptLine: refuses a relative path", async () => {
  await assert.rejects(
    () => appendAttemptLine("state", attemptLine()),
    (error: unknown) => error instanceof SriWriterError,
  );
});

// OA11: the line is appended in one write, so there is no window in which the previous lines were read back
// and are about to be written again. Two callers of the same process meet in the mutation queue and both
// lines land; two processes meet in the kernel, which is what O_APPEND buys.
test("appendAttemptLine: two appends of one process leave two lines and lose none", async (t) => {
  const fixture = createFixture(t);
  const attemptsPath = path.join(stateDir(fixture.pkg), "attempts.jsonl");
  const first = attemptLine({ event: "proposed" });
  const second = attemptLine({ event: "gate-rejected", candidateHash: `sha256:${"e".repeat(64)}` });

  await Promise.all([appendAttemptLine(fixture.pkg, first), appendAttemptLine(fixture.pkg, second)]);

  const lines = fs.readFileSync(attemptsPath, "utf8").split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 2);
  assert.deepEqual(new Set(lines), new Set([JSON.stringify(first), JSON.stringify(second)]));
});

// The one precondition of an append: the file ends where a line ends. A line glued onto a truncated one would
// make the index unparseable from that point on, so the append refuses and leaves the bytes as they were.
test("appendAttemptLine: refuses to append after a line that was truncated", async (t) => {
  const fixture = createFixture(t);
  const attemptsPath = path.join(stateDir(fixture.pkg), "attempts.jsonl");
  const truncated = '{"ts":"2026-11-02T14:03:22.490Z"';
  fs.mkdirSync(stateDir(fixture.pkg), { recursive: true });
  fs.writeFileSync(attemptsPath, truncated, "utf8");

  await assert.rejects(
    () => appendAttemptLine(fixture.pkg, attemptLine()),
    (error: unknown) => error instanceof SriWriterError && error.message.includes("does not end with a newline"),
  );

  assert.equal(fs.readFileSync(attemptsPath, "utf8"), truncated);
});

// The append opens the index through a handle instead of writing a temporary file and renaming it, so the
// perimeter is the one thing that keeps it from writing through a link into a file this package does not own.
test("appendAttemptLine: refuses an index that is a symlink out of the state directory", async (t) => {
  const fixture = createFixture(t);
  const attemptsPath = path.join(stateDir(fixture.pkg), "attempts.jsonl");
  fs.mkdirSync(stateDir(fixture.pkg), { recursive: true });
  const outsidePath = path.join(fixture.base, "elsewhere.jsonl");
  fs.writeFileSync(outsidePath, "", "utf8");
  fs.symlinkSync(outsidePath, attemptsPath);

  await assert.rejects(
    () => appendAttemptLine(fixture.pkg, attemptLine()),
    (error: unknown) => error instanceof SriPerimeterError,
  );

  assert.equal(fs.readFileSync(outsidePath, "utf8"), "");
});

// F1: a candidate whose index line failed is retired, and the answer says whether the directory is
// gone. Nothing is left under the timestamp directory the candidate used.
test("discardStagingCandidate: removes the candidate directory and reports it", async (t) => {
  const fixture = createFixture(t);
  const result = await writeStagingCandidate(inputFor(fixture));
  assert.equal(fs.existsSync(result.stagingPath), true);

  const removed = await discardStagingCandidate(fixture.pkg, result.stagingPath);

  assert.equal(removed, true);
  assert.equal(fs.existsSync(result.stagingPath), false);
  assert.deepEqual(fs.readdirSync(path.dirname(result.stagingPath)), []);
});

// Removal is destructive, so it is guarded by the same perimeter as the writes: an absolute path that
// is not inside <root>/staging is refused and the directory it names survives.
test("discardStagingCandidate: a path outside staging is refused", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  // The staging root exists, so the refusal is about where the path points and not about a missing root.
  await writeStagingCandidate(inputFor(fixture));

  await assert.rejects(
    () => discardStagingCandidate(fixture.pkg, skill.realDir),
    (error: unknown) =>
      error instanceof SriPerimeterError && error.message.includes("outside every writable root"),
  );

  assert.equal(fs.existsSync(path.join(skill.realDir, "SKILL.md")), true);
});

test("snapshotForHistory: copies SKILL.md and lessons/ and refuses to overwrite", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const lessonsDir = path.join(skill.realDir, "lessons");
  fs.mkdirSync(path.join(lessonsDir, "nested"), { recursive: true });
  fs.writeFileSync(path.join(lessonsDir, "first.md"), "first lesson\n", "utf8");
  fs.writeFileSync(path.join(lessonsDir, "nested", "second.md"), "second lesson\n", "utf8");

  const snapshotPath = await snapshotForHistory(skill.realDir, BASE_TIMESTAMP);

  assert.equal(snapshotPath, path.join(skill.realDir, ".history", BASE_TIMESTAMP));
  assert.deepEqual(relativeTree(snapshotPath), ["SKILL.md", "lessons/first.md", "lessons/nested/second.md"]);
  assert.equal(fs.readFileSync(path.join(snapshotPath, "SKILL.md"), "utf8"), skillFile());
  assert.equal(fs.readFileSync(path.join(snapshotPath, "lessons", "nested", "second.md"), "utf8"), "second lesson\n");

  const before = fs.readFileSync(path.join(snapshotPath, "lessons", "first.md"), "utf8");
  await assert.rejects(
    () => snapshotForHistory(skill.realDir, BASE_TIMESTAMP),
    (error: unknown) => error instanceof SriWriterError,
  );
  assert.equal(fs.readFileSync(path.join(snapshotPath, "lessons", "first.md"), "utf8"), before);
});

// I7: a copy that fails halfway must not leave a snapshot on disk. History is never rewritten, so
// a partial copy would block its timestamp forever. A symlink inside lessons/ makes copyTree refuse
// without changing any permission of the machine.
test("snapshotForHistory: a copy that fails leaves no snapshot behind", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const lessonsDir = path.join(skill.realDir, "lessons");
  fs.mkdirSync(lessonsDir, { recursive: true });
  fs.writeFileSync(path.join(lessonsDir, "first.md"), "first lesson\n", "utf8");
  const linkPath = path.join(lessonsDir, "link");
  fs.symlinkSync(fixture.skillsDir, linkPath);

  await assert.rejects(
    () => snapshotForHistory(skill.realDir, BASE_TIMESTAMP),
    (error: unknown) => error instanceof SriWriterError && error.message.includes("regular files"),
  );

  assert.equal(fs.existsSync(path.join(skill.realDir, ".history", BASE_TIMESTAMP)), false);

  // The timestamp is usable again once the copy can succeed.
  fs.rmSync(linkPath);
  const snapshotPath = await snapshotForHistory(skill.realDir, BASE_TIMESTAMP);
  assert.deepEqual(relativeTree(snapshotPath), ["SKILL.md", "lessons/first.md"]);
});

test("snapshotForHistory: a skill without lessons/ snapshots SKILL.md only", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);

  const snapshotPath = await snapshotForHistory(skill.realDir, "20261102T140322482Z");

  assert.deepEqual(relativeTree(snapshotPath), ["SKILL.md"]);
});

test("snapshotForHistory: a timestamp that leaves the skill is rejected", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);

  await assert.rejects(
    () => snapshotForHistory(skill.realDir, "../../escape"),
    (error: unknown) => error instanceof SriPerimeterError,
  );
  assert.equal(fs.existsSync(path.join(fixture.skillsDir, "escape")), false);
});

// The perimeter check before the queue is not a duplicate of the one the write primitives run: the
// snapshot directory itself is created with mkdirSync, which no primitive sees. An escaping
// timestamp that lands on an existing directory is the case that separates the two -- the perimeter
// refuses it, while without the check the writer would answer "history already exists" (or create
// the directory and fail on the file it puts inside).
test("snapshotForHistory: an escaping timestamp that lands on an existing directory is refused by the perimeter", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);

  // <skill>/.history/../.. resolves to the shared skills directory, which exists.
  await assert.rejects(
    () => snapshotForHistory(skill.realDir, "../.."),
    (error: unknown) => error instanceof SriPerimeterError && error.message.includes("outside every writable root"),
  );

  assert.equal(fs.existsSync(fixture.skillsDir), true);
  assert.equal(fs.existsSync(path.join(skill.realDir, ".history")), false);
});

test("upsertReferenceLine: appends a Lessons section when SKILL.md has none", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const slug = "merged-cells";
  const title = "Extract merged cells";

  await upsertReferenceLine(skill.realDir, slug, title);

  const expected = `${skillFile()}\n## Lessons\n\n- [lessons/${slug}.md](lessons/${slug}.md) - ${title}\n`;
  assert.equal(fs.readFileSync(path.join(skill.realDir, "SKILL.md"), "utf8"), expected);
});

// I11: only the `## Lessons` section reaches a lesson for pi, so a line elsewhere is not the
// reference and must not stop the canonical line from being written.
test("upsertReferenceLine: a mention outside the Lessons section does not replace the reference", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const skillMdPath = path.join(skill.realDir, "SKILL.md");
  const slug = "merged-cells";
  const title = "Extract merged cells";
  const content = [
    "# pdf-tools",
    "",
    "The details live in lessons/merged-cells.md, read it before extracting.",
    "",
    "## Notes",
    "",
    "- [lessons/merged-cells.md](lessons/merged-cells.md) - Old title",
    "",
  ].join("\n");
  fs.writeFileSync(skillMdPath, content, "utf8");

  await upsertReferenceLine(skill.realDir, slug, title);

  const expected = `${content}\n## Lessons\n\n- [lessons/${slug}.md](lessons/${slug}.md) - ${title}\n`;
  assert.equal(fs.readFileSync(skillMdPath, "utf8"), expected);
});

// I11: the canonical line inside `## Lessons` is the reference, whatever else SKILL.md says.
test("upsertReferenceLine: a mention inside the Lessons section is the reference", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const skillMdPath = path.join(skill.realDir, "SKILL.md");
  const content = [
    "# pdf-tools",
    "",
    "See lessons/merged-cells.md in prose.",
    "",
    "## Lessons",
    "",
    "- [lessons/merged-cells.md](lessons/merged-cells.md) - Old title",
    "",
  ].join("\n");
  fs.writeFileSync(skillMdPath, content, "utf8");

  await upsertReferenceLine(skill.realDir, "merged-cells", "New title");

  assert.equal(fs.readFileSync(skillMdPath, "utf8"), content);
});

test("upsertReferenceLine: adds the line at the top of an existing Lessons section", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const skillMdPath = path.join(skill.realDir, "SKILL.md");
  const slug = "merged-cells";
  const title = "Extract merged cells";
  fs.writeFileSync(
    skillMdPath,
    [
      "# pdf-tools",
      "",
      "## Lessons",
      "",
      "- [lessons/existing.md](lessons/existing.md) - Existing lesson",
      "",
      "## Notes",
      "",
      "Keep the scripts small.",
      "",
    ].join("\n"),
    "utf8",
  );

  await upsertReferenceLine(skill.realDir, slug, title);

  const expected = [
    "# pdf-tools",
    "",
    "## Lessons",
    "",
    `- [lessons/${slug}.md](lessons/${slug}.md) - ${title}`,
    "- [lessons/existing.md](lessons/existing.md) - Existing lesson",
    "",
    "## Notes",
    "",
    "Keep the scripts small.",
    "",
  ].join("\n");
  assert.equal(fs.readFileSync(skillMdPath, "utf8"), expected);
});

test("upsertReferenceLine: fills an empty Lessons section", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const skillMdPath = path.join(skill.realDir, "SKILL.md");
  fs.writeFileSync(skillMdPath, "# pdf-tools\n\n## Lessons\n", "utf8");

  await upsertReferenceLine(skill.realDir, "merged-cells", "Merged cells");

  assert.equal(
    fs.readFileSync(skillMdPath, "utf8"),
    "# pdf-tools\n\n## Lessons\n\n- [lessons/merged-cells.md](lessons/merged-cells.md) - Merged cells\n",
  );
});

// Idempotent by slug: repeating the accept step cannot grow SKILL.md, and the second call
// does not even rewrite the file.
test("upsertReferenceLine: three calls with the same slug leave one line", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const skillMdPath = path.join(skill.realDir, "SKILL.md");

  await upsertReferenceLine(skill.realDir, "merged-cells", "Merged cells");
  const afterFirst = fs.readFileSync(skillMdPath, "utf8");
  await upsertReferenceLine(skill.realDir, "merged-cells", "Merged cells");
  await upsertReferenceLine(skill.realDir, "merged-cells", "Another title for the same file");

  const content = fs.readFileSync(skillMdPath, "utf8");
  assert.equal(content, afterFirst);
  const references = content.split("\n").filter((line) => line.includes("lessons/merged-cells.md"));
  assert.equal(references.length, 1);
});

test("upsertReferenceLine: different slugs accumulate with the most recent first", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const skillMdPath = path.join(skill.realDir, "SKILL.md");

  await upsertReferenceLine(skill.realDir, "alpha", "Alpha");
  await upsertReferenceLine(skill.realDir, "beta", "Beta");
  await upsertReferenceLine(skill.realDir, "gamma", "Gamma");

  const expected = [
    "---",
    "name: pdf-tools",
    "description: Extract tables from PDFs",
    "---",
    "",
    "# pdf-tools",
    "",
    "Use the scripts in this directory.",
    "",
    "## Lessons",
    "",
    "- [lessons/gamma.md](lessons/gamma.md) - Gamma",
    "- [lessons/beta.md](lessons/beta.md) - Beta",
    "- [lessons/alpha.md](lessons/alpha.md) - Alpha",
    "",
  ].join("\n");
  assert.equal(fs.readFileSync(skillMdPath, "utf8"), expected);
});

test("upsertReferenceLine: an existing reference with another title is left alone", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const skillMdPath = path.join(skill.realDir, "SKILL.md");
  const content = "# pdf-tools\n\n## Lessons\n\n- [lessons/merged-cells.md](lessons/merged-cells.md) - Old title\n";
  fs.writeFileSync(skillMdPath, content, "utf8");

  await upsertReferenceLine(skill.realDir, "merged-cells", "New title");

  assert.equal(fs.readFileSync(skillMdPath, "utf8"), content);
});

// Q11: a SKILL.md that is a symlink is written through. A rename over the link would leave a regular
// file in its place, and a skill whose SKILL.md lives elsewhere would lose the link on the first write.
test("upsertReferenceLine: a SKILL.md that is a symlink is written through, not replaced", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const skillMdPath = path.join(skill.realDir, "SKILL.md");
  const targetPath = path.join(skill.realDir, "skill-body.md");

  fs.renameSync(skillMdPath, targetPath);
  fs.symlinkSync(targetPath, skillMdPath);
  assert.equal(fs.lstatSync(skillMdPath).isSymbolicLink(), true);

  await upsertReferenceLine(skill.realDir, "merged-cells", "Merged cells");

  // The link is still a link, and the new bytes are in the file it points at.
  assert.equal(fs.lstatSync(skillMdPath).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(skillMdPath), targetPath);
  const content = fs.readFileSync(targetPath, "utf8");
  assert.equal(content.includes("- [lessons/merged-cells.md](lessons/merged-cells.md) - Merged cells"), true);
  assert.equal(content.startsWith("---\nname: pdf-tools"), true);
  // No temporary file survives next to the real file.
  assert.deepEqual(
    fs.readdirSync(skill.realDir).filter((entry) => entry.startsWith(".sri-write-")),
    [],
  );
});

// ---------------------------------------------------------------------------------------------
// M1 primitives. Each of them is exercised on a skill built in mkdtemp: no test names a real skill and
// none reads or writes ~/.pi/agent/sri/.
// ---------------------------------------------------------------------------------------------

// A skill with two files, a sub-directory, its own history and a git directory: the tree the two arms of
// the gate are copied from (S5), and the one a snapshot of it never receives whole.
function populatedSkill(fixture: Fixture): SkillRef {
  const skill = makeSkill(fixture);
  fs.mkdirSync(path.join(skill.realDir, "lessons"), { recursive: true });
  fs.mkdirSync(path.join(skill.realDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(skill.realDir, ".history", BASE_TIMESTAMP), { recursive: true });
  fs.mkdirSync(path.join(skill.realDir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(skill.realDir, "lessons", "first.md"), "first lesson\n", "utf8");
  fs.writeFileSync(path.join(skill.realDir, "scripts", "run.sh"), "#!/bin/sh\necho hi\n", "utf8");
  fs.writeFileSync(path.join(skill.realDir, ".history", BASE_TIMESTAMP, "SKILL.md"), "an older skill\n", "utf8");
  fs.writeFileSync(path.join(skill.realDir, ".git", "config"), "[core]\n", "utf8");
  return skill;
}

test("writeLessonFile: writes the lesson inside the skill and returns its path", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const text = lessonTextFor(makeDraft());

  const lessonPath = await writeLessonFile(skill.realDir, LESSON_SLUG, text, sha256Text(text));

  assert.equal(lessonPath, path.join(skill.realDir, "lessons", `${LESSON_SLUG}.md`));
  assert.equal(fs.readFileSync(lessonPath, "utf8"), text);
  assert.deepEqual(fs.readdirSync(path.join(skill.realDir, "lessons")), [`${LESSON_SLUG}.md`]);
  assert.deepEqual(
    fs.readdirSync(skill.realDir).filter((entry) => entry.startsWith(".sri-write-")),
    [],
  );
});

// Q11: a lesson path that is a symlink is written through, not replaced. A rename over the link would
// leave a regular file where the link was, and a skill that links its lessons to a shared directory would
// lose the link on the first acceptance.
test("writeLessonFile: a lessons/<slug>.md that is a symlink is written through, not replaced", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const lessonsDir = path.join(skill.realDir, "lessons");
  const targetPath = path.join(lessonsDir, "shared.md");
  const lessonPath = path.join(lessonsDir, `${LESSON_SLUG}.md`);
  fs.mkdirSync(lessonsDir, { recursive: true });
  fs.writeFileSync(targetPath, "an older lesson\n", "utf8");
  fs.symlinkSync(targetPath, lessonPath);
  assert.equal(fs.lstatSync(lessonPath).isSymbolicLink(), true);

  const text = lessonTextFor(makeDraft());
  await writeLessonFile(skill.realDir, LESSON_SLUG, text, sha256Text(text));

  assert.equal(fs.lstatSync(lessonPath).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(lessonPath), targetPath);
  assert.equal(fs.readFileSync(targetPath, "utf8"), text);
  assert.deepEqual(
    fs.readdirSync(lessonsDir).filter((entry) => entry.startsWith(".sri-write-")),
    [],
  );
});

// The text is not the candidate the gate ran against, so nothing is written: the directory that would
// hold the lesson does not even exist afterwards.
test("writeLessonFile: a text that does not hash to the expected candidate writes nothing", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const text = lessonTextFor(makeDraft());

  await assert.rejects(
    () => writeLessonFile(skill.realDir, LESSON_SLUG, text, HASH_PLACEHOLDER),
    (error: unknown) => error instanceof SriWriterError && error.message.includes("hashes to"),
  );

  assert.equal(fs.existsSync(path.join(skill.realDir, "lessons")), false);
});

test("writeLessonFile: a slug that leaves lessons/ is refused", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const text = lessonTextFor(makeDraft());

  await assert.rejects(
    () => writeLessonFile(skill.realDir, "../../escape", text, sha256Text(text)),
    (error: unknown) => error instanceof SriPerimeterError,
  );

  assert.equal(fs.existsSync(path.join(fixture.skillsDir, "escape.md")), false);
  assert.deepEqual(relativeTree(skill.realDir), ["SKILL.md"]);
});

test("removeLessonFile: removes the lesson and answers that it is gone", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const text = lessonTextFor(makeDraft());
  const lessonPath = await writeLessonFile(skill.realDir, LESSON_SLUG, text, sha256Text(text));

  assert.equal(await removeLessonFile(skill.realDir, LESSON_SLUG), true);
  assert.equal(fs.existsSync(lessonPath), false);
  // The answer is "is it gone", not "did it exist": compensating a failed acceptance twice is not an
  // error for the caller that is withdrawing a lesson.
  assert.equal(await removeLessonFile(skill.realDir, LESSON_SLUG), true);
});

// Removal deletes, so it is guarded like the writes: a slug that reaches SKILL.md leaves the lessons
// directory and is refused, and SKILL.md survives.
test("removeLessonFile: a slug that leaves lessons/ is refused", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const skillMdPath = path.join(skill.realDir, "SKILL.md");
  fs.mkdirSync(path.join(skill.realDir, "lessons"), { recursive: true });

  await assert.rejects(
    () => removeLessonFile(skill.realDir, "../SKILL"),
    (error: unknown) => error instanceof SriPerimeterError,
  );

  assert.equal(fs.readFileSync(skillMdPath, "utf8"), skillFile());
});

test("rewriteStagingDecision: replaces the record of a candidate whose lesson is unchanged", async (t) => {
  const fixture = createFixture(t);
  const staged = await writeStagingCandidate(inputFor(fixture));
  const next: DecisionRecord = { ...makeDecision(), outcome: { status: "proposed", reason: "gate-accepted", decidedAt: null } };

  const result = await rewriteStagingDecision(fixture.pkg, staged.stagingPath, next);

  assert.equal(result.decisionPath, staged.decisionPath);
  // The hashes answered are the ones on disk, and the record carries them instead of the placeholders it
  // was built with.
  assert.equal(result.contentHash, staged.contentHash);
  assert.equal(result.bodyHash, staged.bodyHash);
  const onDisk: unknown = JSON.parse(fs.readFileSync(staged.decisionPath, "utf8"));
  assert.deepEqual(onDisk, {
    ...next,
    candidate: { ...next.candidate, contentHash: staged.contentHash, bodyHash: staged.bodyHash },
  });
  assert.equal(fs.readFileSync(staged.lessonPath, "utf8"), lessonTextFor(makeDraft()));
});

// The record declares the candidate the gate ran against. A lesson that changed after staging means the
// record and the bytes on disk disagree, so the record is not replaced and the previous one stays.
test("rewriteStagingDecision: a lesson altered after staging is refused and the record is left alone", async (t) => {
  const fixture = createFixture(t);
  const staged = await writeStagingCandidate(inputFor(fixture));
  const before = fs.readFileSync(staged.decisionPath, "utf8");
  fs.appendFileSync(staged.lessonPath, "\nOne more step.\n", "utf8");

  await assert.rejects(
    () => rewriteStagingDecision(fixture.pkg, staged.stagingPath, makeDecision()),
    (error: unknown) => error instanceof SriWriterError && error.message.includes("no longer hashes"),
  );

  assert.equal(fs.readFileSync(staged.decisionPath, "utf8"), before);
});

test("rewriteStagingDecision: a candidate outside staging is refused", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  // staging/ exists, so the refusal is about where the path points and not about a missing root.
  await writeStagingCandidate(inputFor(fixture));

  await assert.rejects(
    () => rewriteStagingDecision(fixture.pkg, skill.realDir, makeDecision()),
    (error: unknown) => error instanceof SriPerimeterError && error.message.includes("outside every writable root"),
  );

  assert.deepEqual(relativeTree(skill.realDir), ["SKILL.md"]);
});

test("copySkillTree: copies the skill without .history/ or .git/ and answers a stable manifest hash", async (t) => {
  const fixture = createFixture(t);
  const skill = populatedSkill(fixture);
  const stagingRoot = stagingDir(fixture.pkg);
  fs.mkdirSync(stagingRoot, { recursive: true });
  const incumbent = path.join(stagingRoot, BASE_TIMESTAMP, "pdf-tools", "arms", "incumbent", "pdf-tools");
  const candidate = path.join(stagingRoot, BASE_TIMESTAMP, "pdf-tools", "arms", "candidate", "pdf-tools");

  const first = await copySkillTree(skill.realDir, incumbent, stagingRoot);
  const second = await copySkillTree(skill.realDir, candidate, stagingRoot);

  assert.deepEqual(relativeTree(incumbent), ["SKILL.md", "lessons/first.md", "scripts/run.sh"]);
  assert.deepEqual(relativeTree(candidate), ["SKILL.md", "lessons/first.md", "scripts/run.sh"]);
  assert.equal(first.files, 3);
  // The manifest is the content of the copy: two copies of the same tree answer the same hash.
  assert.match(first.manifestHash, HASH_PATTERN);
  assert.equal(first.manifestHash, second.manifestHash);
  // The skill keeps its own history and its git directory: only the copy leaves them behind.
  assert.equal(fs.existsSync(path.join(skill.realDir, ".history", BASE_TIMESTAMP, "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(skill.realDir, ".git", "config")), true);
});

test("copySkillTree: one more lesson changes the manifest hash", async (t) => {
  const fixture = createFixture(t);
  const skill = populatedSkill(fixture);
  const stagingRoot = stagingDir(fixture.pkg);
  fs.mkdirSync(stagingRoot, { recursive: true });

  const first = await copySkillTree(skill.realDir, path.join(stagingRoot, "incumbent"), stagingRoot);
  // The candidate arm carries one lesson more than the incumbent: that difference is what the two hashes
  // have to report.
  fs.writeFileSync(path.join(skill.realDir, "lessons", "second.md"), "second lesson\n", "utf8");
  const second = await copySkillTree(skill.realDir, path.join(stagingRoot, "candidate"), stagingRoot);

  assert.equal(second.files, first.files + 1);
  assert.notEqual(second.manifestHash, first.manifestHash);
});

// A symlink inside the skill can point anywhere, including out of the root the copy is guarded by, so the
// copy refuses it instead of following it, and the destination is discarded instead of published.
test("copySkillTree: a symlink inside the skill is refused and no copy is left behind", async (t) => {
  const fixture = createFixture(t);
  const skill = populatedSkill(fixture);
  const stagingRoot = stagingDir(fixture.pkg);
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.symlinkSync(fixture.skillsDir, path.join(skill.realDir, "lessons", "linked"));
  const destinationDir = path.join(stagingRoot, BASE_TIMESTAMP, "pdf-tools");

  await assert.rejects(
    () => copySkillTree(skill.realDir, destinationDir, stagingRoot),
    (error: unknown) => error instanceof SriWriterError && error.message.includes("regular files"),
  );

  assert.equal(fs.existsSync(destinationDir), false);
});

test("copySkillTree: a destination outside the root is refused", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const stagingRoot = stagingDir(fixture.pkg);
  fs.mkdirSync(stagingRoot, { recursive: true });
  const outside = path.join(fixture.base, "escape");

  await assert.rejects(
    () => copySkillTree(skill.realDir, outside, stagingRoot),
    (error: unknown) => error instanceof SriPerimeterError && error.message.includes("outside every writable root"),
  );

  assert.equal(fs.existsSync(outside), false);
});

test("writeTextAtomically: writes the text, reads it back and leaves no temporary file", async (t) => {
  const fixture = createFixture(t);
  const root = path.join(fixture.base, "runs");
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, "run-1.jsonl");
  const text = '{"type":"message_end"}\n';

  await writeTextAtomically(target, text, root);

  assert.equal(fs.readFileSync(target, "utf8"), text);
  assert.deepEqual(fs.readdirSync(root), ["run-1.jsonl"]);
});

// No primitive creates a directory it has not validated, and this one creates none at all: the caller
// names a directory that exists and gets a refusal instead of an implicit mkdir.
test("writeTextAtomically: a target whose directory does not exist is refused", async (t) => {
  const fixture = createFixture(t);
  const root = path.join(fixture.base, "runs");
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, "gate", "runs", "run-1.jsonl");

  await assert.rejects(
    () => writeTextAtomically(target, "x\n", root),
    (error: unknown) => error instanceof SriWriterError,
  );

  assert.equal(fs.existsSync(path.join(root, "gate")), false);
});

// Both spellings of an escape: a relative one that walks out of the root and an absolute one that names a
// directory somewhere else.
test("writeTextAtomically: a target outside the root is refused, relative escape or absolute", async (t) => {
  const fixture = createFixture(t);
  const root = path.join(fixture.base, "runs");
  fs.mkdirSync(root, { recursive: true });

  for (const target of [path.join(root, "..", "escape.txt"), path.join(fixture.base, "elsewhere", "escape.txt")]) {
    await assert.rejects(
      () => writeTextAtomically(target, "text\n", root),
      (error: unknown) => error instanceof SriPerimeterError,
    );
  }

  assert.equal(fs.existsSync(path.join(fixture.base, "escape.txt")), false);
  assert.equal(fs.existsSync(path.join(fixture.base, "elsewhere")), false);
});

// The record of an acceptance lands in the snapshot the acceptance took before touching the skill, which
// is what makes "accepted" mean the bytes were written. History is never rewritten.
test("writeHistoryDecision: writes the record into the snapshot that exists", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  const snapshotPath = await snapshotForHistory(skill.realDir, BASE_TIMESTAMP);
  const record: DecisionRecord = { ...makeDecision(), outcome: { status: "proposed", reason: "accepted", decidedAt: null } };

  const decisionPath = await writeHistoryDecision(skill.realDir, BASE_TIMESTAMP, record);

  assert.equal(decisionPath, path.join(snapshotPath, "decision.json"));
  assert.equal(fs.readFileSync(decisionPath, "utf8").endsWith("}\n"), true);
  const onDisk: unknown = JSON.parse(fs.readFileSync(decisionPath, "utf8"));
  assert.deepEqual(onDisk, record);
  await assert.rejects(
    () => writeHistoryDecision(skill.realDir, BASE_TIMESTAMP, record),
    (error: unknown) => error instanceof SriWriterError && error.message.includes("already exists"),
  );
});

test("writeHistoryDecision: a timestamp with no snapshot is refused", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  // .history/ exists and holds no snapshot for this timestamp: what is missing is the copy, which the
  // acceptance has to take before it can record one.
  fs.mkdirSync(path.join(skill.realDir, ".history"), { recursive: true });

  await assert.rejects(
    () => writeHistoryDecision(skill.realDir, BASE_TIMESTAMP, makeDecision()),
    (error: unknown) => error instanceof SriWriterError && error.message.includes("history snapshot"),
  );

  assert.deepEqual(fs.readdirSync(path.join(skill.realDir, ".history")), []);
});

// <skill>/.history/../lessons exists, so the escape is caught by the perimeter and not by the check that
// the snapshot exists: that is why the root of this primitive is .history/ and not the timestamp
// directory, which would move together with the timestamp.
test("writeHistoryDecision: a timestamp that leaves .history/ is refused", async (t) => {
  const fixture = createFixture(t);
  const skill = makeSkill(fixture);
  await snapshotForHistory(skill.realDir, BASE_TIMESTAMP);
  fs.mkdirSync(path.join(skill.realDir, "lessons"), { recursive: true });

  await assert.rejects(
    () => writeHistoryDecision(skill.realDir, "../lessons", makeDecision()),
    (error: unknown) => error instanceof SriPerimeterError && error.message.includes("outside every writable root"),
  );

  assert.deepEqual(fs.readdirSync(path.join(skill.realDir, "lessons")), []);
});
