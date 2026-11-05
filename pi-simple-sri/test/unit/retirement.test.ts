import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serializeLesson } from "../../src/lesson-frontmatter.ts";
import { ATTEMPTS_FILE, HISTORY_DIR, LESSONS_DIR, RETIREMENT_FILE, SKILL_FILE } from "../../src/names.ts";
import {
  RETIREMENT_REASONS,
  retireLesson,
  type RetireDeps,
  type RetireOutcome,
  type RetireRejection,
  type RetireRequest,
  type RetireResult,
} from "../../src/retirement.ts";
import { countReferenceLines } from "../../src/skill-reference.ts";
import type { LessonDraft, RetirementRecord } from "../../src/types.ts";
import { stateDir } from "../../src/write-base.ts";
import {
  appendAttemptLine,
  dropReferenceLine,
  lessonHashes,
  retireLessonFile,
  snapshotForHistory,
  SriWriterError,
  writeHistoryRetirement,
} from "../../src/writer.ts";

// The retirement of an accepted lesson (M3, S4) on a skill built in mkdtemp: the snapshot, the reference line that comes
// out, the tombstone, the record of the reason and the line of the index. No test names a real skill and nothing outside
// the temporary directory is read or written, and the acceptance itself is a fixture -- the protocol takes its pair of
// hashes and the path of its record as data and never opens it.
//
// The order of the writes is the contract of the slice, so the first test runs the five writes of src/writer.ts behind
// seams that record them; the rest replace only the step they are about, or the clock, so every other write is the real
// one and the bytes on disk are the proof.

const SKILL_NAME = "pdf-tools";
const SLUG = "extract-merged-cells";
const TITLE = "Extract merged cells with the lattice strategy";
const OTHER_SLUG = "open-the-pdf-first";
const OTHER_TITLE = "Open the PDF first";
const NOW = new Date("2026-11-06T09:04:05.123Z");
// 2026-11-06T09:04:05.123Z in the spelling src/writer.ts gives a history snapshot.
const TIMESTAMP = "20261106T090405123Z";
const LATER = new Date("2026-11-06T10:00:00.000Z");
const LATER_TIMESTAMP = "20261106T100000000Z";
// Where the acceptance left its record, inside the skill: the retirement names it and never reads it.
const ACCEPTED_HISTORY = path.join(HISTORY_DIR, "20261102T150405123Z", "decision.json");
const LESSON_BODY = "Use pdfplumber with the lattice strategy so merged cells stay apart.";
const REASON_DETAIL = "the appendix stopped carrying merged cells in November";

// The lesson the acceptance wrote: the frontmatter of a candidate, the body of the correction and nothing else. The two
// texts the suite compares are built from it, one with each state, because the lesson file format belongs to
// src/lesson-frontmatter.ts and a hand-written frontmatter here would agree with this file and disagree with the writer.
const DRAFT: LessonDraft = {
  slug: SLUG,
  title: TITLE,
  date: "2026-11-02",
  status: "accepted",
  sourceEvidence: ["ev-3f9a1c02"],
  gate: "accepted",
  body: LESSON_BODY,
};

const ACCEPTED_TEXT = lessonTextOf(DRAFT);

// The tombstone is the accepted file with one line rewritten, and this replacement is what the suite asserts: it is done
// here, by hand, and not with the serializer that produced the file, so "the retirement changes the state and the file"
// is proved against a second reading of the format.
const TOMBSTONE_TEXT = ACCEPTED_TEXT.replace('status: "accepted"', 'status: "retired"');

// The pair of the acceptance, computed here and not with src/writer.ts: what the retirement verifies has to agree with an
// independent computation of the same bytes. The body hash is the digest of the normalized body (D4), which for a body of
// one line is the body itself.
const ACCEPTED_CONTENT_HASH = digestOf(ACCEPTED_TEXT);
const BODY_HASH = digestOf(LESSON_BODY);

const REFERENCE = `- [lessons/${SLUG}.md](lessons/${SLUG}.md) - ${TITLE}`;
const OTHER_REFERENCE = "- [lessons/open-the-pdf-first.md](lessons/open-the-pdf-first.md) - Open the PDF first";

// A declared skill the way a user writes one, with a `## Lessons` section that lists the lesson the retirement is about
// and one more, so the edit is proved to touch exactly one line of the list.
function skillFile(references: readonly string[] = [REFERENCE, OTHER_REFERENCE]): string {
  return [
    "---",
    `name: ${SKILL_NAME}`,
    "description: Extract tables from PDFs",
    "---",
    "",
    `# ${SKILL_NAME}`,
    "",
    "Use the scripts in this directory.",
    "",
    "## Lessons",
    "",
    ...references,
    "",
  ].join("\n");
}

interface Fixture {
  base: string; // the write base of the run: <base>/state holds the index
  skillDir: string;
  skillFilePath: string;
  lessonsDir: string;
  lessonPath: string;
  acceptedHistoryPath: string; // the record of the acceptance, absolute
  skillBefore: string;
}

interface FixtureOptions {
  // The bytes of the lesson on disk, when a test wants a file that is not the one the acceptance measured.
  lessonText?: string;
  references?: readonly string[];
}

function createFixture(t: TestContext, options: FixtureOptions = {}): Fixture {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-retirement-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const skillDir = path.join(base, "skills", SKILL_NAME);
  const lessonsDir = path.join(skillDir, LESSONS_DIR);
  const skillFilePath = path.join(skillDir, SKILL_FILE);
  const lessonPath = path.join(lessonsDir, `${SLUG}.md`);
  const skillBefore = skillFile(options.references);

  fs.mkdirSync(lessonsDir, { recursive: true });
  fs.writeFileSync(skillFilePath, skillBefore, "utf8");
  fs.writeFileSync(lessonPath, options.lessonText ?? ACCEPTED_TEXT, "utf8");

  return {
    base,
    skillDir,
    skillFilePath,
    lessonsDir,
    lessonPath,
    acceptedHistoryPath: path.join(skillDir, ACCEPTED_HISTORY),
    skillBefore,
  };
}

function requestFor(fixture: Fixture, overrides: Partial<RetireRequest> = {}): RetireRequest {
  return {
    base: fixture.base,
    // The skill block of the record of the acceptance: realDir is the path the acceptance wrote through, which is the
    // path the retirement reads the lesson and takes the snapshot from.
    skill: { name: SKILL_NAME, dir: fixture.skillDir, realDir: fixture.skillDir, wasSymlink: false },
    lesson: { slug: SLUG, title: TITLE, contentHash: ACCEPTED_CONTENT_HASH, bodyHash: BODY_HASH },
    acceptedHistoryPath: fixture.acceptedHistoryPath,
    reason: { key: "stale", detail: REASON_DETAIL },
    timestamp: TIMESTAMP,
    ...overrides,
  };
}

// One clock for every case, so the snapshot directory, the createdAt of the record and the ts of the line are known
// without reading them back.
function seams(overrides: RetireDeps = {}): RetireDeps {
  return { now: () => NOW, ...overrides };
}

function retired(outcome: RetireOutcome): RetireResult {
  if (!outcome.ok) assert.fail(`the lesson must be retired: ${outcome.error.reason} (${outcome.error.detail})`);
  return outcome.value;
}

function rejection(outcome: RetireOutcome): RetireRejection {
  if (outcome.ok) assert.fail("the lesson must not be retired");
  return outcome.error;
}

function lessonTextOf(draft: LessonDraft): string {
  const lesson = serializeLesson(draft);
  if (!lesson.ok) assert.fail(`the lesson of this test must serialize: ${lesson.error}`);
  return lesson.value;
}

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function attemptsPath(fixture: Fixture): string {
  return path.join(stateDir(fixture.base), ATTEMPTS_FILE);
}

function snapshotDirOf(fixture: Fixture, timestamp: string = TIMESTAMP): string {
  return path.join(fixture.skillDir, HISTORY_DIR, timestamp);
}

function recordOf(fixture: Fixture, timestamp: string = TIMESTAMP): RetirementRecord {
  return {
    schema: "pi-simple-sri/retirement@1",
    createdAt: NOW.toISOString(),
    skill: { name: SKILL_NAME, dir: fixture.skillDir, realDir: fixture.skillDir, wasSymlink: false },
    lesson: {
      slug: SLUG,
      title: TITLE,
      lessonPath: `${LESSONS_DIR}/${SLUG}.md`,
      contentHash: ACCEPTED_CONTENT_HASH,
      bodyHash: BODY_HASH,
      retiredContentHash: digestOf(TOMBSTONE_TEXT),
    },
    retires: { historyPath: fixture.acceptedHistoryPath },
    reason: { key: "stale", detail: REASON_DETAIL },
  };
}

// The hashes of this suite are computed here and not with src/hash.ts: what the retirement verifies and what it writes has
// to agree with an independent computation of the same bytes.
function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
}

// Forward-slash relative paths, sorted: the same shape the writer, the overlay and the acceptance suites use, so a tree is
// compared as a list instead of by probing single paths.
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

  if (!fs.existsSync(rootDir)) return entries;
  walk(rootDir, "");
  return entries.sort();
}

// The five writes, in the order of the protocol. The seams record the step and then delegate to the real function, so the
// order and the bytes are proved together: the snapshot it takes is the skill as it was, the reference line comes out
// before the tombstone lands, and the record of the reason is written before the line of the index names it.
test("retireLesson: the five writes happen in the order of the protocol", async (t) => {
  const fixture = createFixture(t);
  const order: string[] = [];

  const deps: RetireDeps = {
    now: () => NOW,
    snapshot: async (skillRealDir, timestamp) => {
      order.push("snapshot");
      return await snapshotForHistory(skillRealDir, timestamp);
    },
    dropReference: async (skillRealDir, slug) => {
      order.push("reference");
      return await dropReferenceLine(skillRealDir, slug);
    },
    retireLesson: async (skillRealDir, slug, expectedContentHash) => {
      order.push("tombstone");
      return await retireLessonFile(skillRealDir, slug, expectedContentHash);
    },
    writeHistoryRetirement: async (skillRealDir, timestamp, record) => {
      order.push("record");
      return await writeHistoryRetirement(skillRealDir, timestamp, record);
    },
    appendAttempt: async (base, line) => {
      order.push("index");
      return await appendAttemptLine(base, line);
    },
  };

  const value = retired(await retireLesson(requestFor(fixture), deps));

  assert.deepEqual(order, ["snapshot", "reference", "tombstone", "record", "index"]);

  const snapshotDir = snapshotDirOf(fixture);
  assert.equal(value.lessonPath, fixture.lessonPath);
  assert.equal(value.retirementPath, path.join(snapshotDir, RETIREMENT_FILE));
  assert.equal(value.referenceRemoved, true);

  // The snapshot is the skill as it was, taken before anything of it changed: the SKILL.md with the line the retirement
  // is about to remove, and the lesson still saying accepted.
  assert.equal(readFile(path.join(snapshotDir, SKILL_FILE)), fixture.skillBefore);
  assert.equal(readFile(path.join(snapshotDir, LESSONS_DIR, `${SLUG}.md`)), ACCEPTED_TEXT);
  assert.deepEqual(relativeTree(snapshotDir), [SKILL_FILE, `lessons/${SLUG}.md`, RETIREMENT_FILE]);

  // The reference line left the section and the other lesson of the list stayed; the tombstone is the accepted file with
  // its status rewritten; the record of the reason is next to the snapshot of the skill.
  const skillAfter = readFile(fixture.skillFilePath);
  assert.equal(countReferenceLines(skillAfter, SLUG), 0);
  assert.equal(countReferenceLines(skillAfter, OTHER_SLUG), 1);
  assert.equal(readFile(fixture.lessonPath), TOMBSTONE_TEXT);
  assert.deepEqual(JSON.parse(readFile(value.retirementPath)), recordOf(fixture));

  // And one line of the index, with the event of the retirement.
  const lines = readFile(attemptsPath(fixture)).split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).event, "retired");
});

// The post-condition of the slice: a retirement changes the state and never the body. The file is the accepted text with
// its status line rewritten, the body hash of both sides is the same one, and the content hash of the tombstone is not the
// one of the acceptance -- which is what the record carries apart, so a reader can tell the two files apart.
test("retireLesson: the body does not change and the state does", async (t) => {
  const fixture = createFixture(t);

  const before = lessonHashes(ACCEPTED_TEXT);
  if (!before.ok) assert.fail(`the lesson of this test must hash: ${before.error}`);

  const value = retired(await retireLesson(requestFor(fixture), seams()));
  const text = readFile(fixture.lessonPath);
  const after = lessonHashes(text);
  if (!after.ok) assert.fail(`the retired lesson must hash: ${after.error}`);

  assert.equal(text, TOMBSTONE_TEXT);
  assert.equal(after.value.bodyHash, before.value.bodyHash);
  assert.equal(after.value.contentHash, digestOf(text));
  assert.notEqual(after.value.contentHash, before.value.contentHash);
  assert.equal(value.retiredContentHash, after.value.contentHash);

  // The record keeps the two hashes apart: the pair of the acceptance it retired and the digest of what the file became.
  const record = JSON.parse(readFile(value.retirementPath)) as RetirementRecord;
  assert.equal(record.lesson.contentHash, before.value.contentHash);
  assert.equal(record.lesson.bodyHash, before.value.bodyHash);
  assert.equal(record.lesson.retiredContentHash, after.value.contentHash);
});

// A lesson whose bytes are not the ones the acceptance measured is not the lesson the user asked to retire, and nothing is
// written: no snapshot, no edit and no line.
test("retireLesson: a lesson whose bytes moved is refused as lesson-drift and nothing is written", async (t) => {
  const moved = `${ACCEPTED_TEXT}\nAlso drop the empty columns first.\n`;
  const fixture = createFixture(t, { lessonText: moved });

  const refused = rejection(await retireLesson(requestFor(fixture), seams()));

  assert.equal(refused.reason, "lesson-drift");
  assert.equal(refused.detail.includes(fixture.lessonPath), true);
  assert.equal(refused.detail.includes(ACCEPTED_CONTENT_HASH), true);
  assert.equal(refused.detail.includes(digestOf(moved)), true);

  assert.deepEqual(relativeTree(fixture.skillDir), [SKILL_FILE, `lessons/${SLUG}.md`]);
  assert.equal(fs.existsSync(path.join(fixture.skillDir, HISTORY_DIR)), false);
  assert.equal(readFile(fixture.lessonPath), moved);
  assert.equal(readFile(fixture.skillFilePath), fixture.skillBefore);
  assert.equal(fs.existsSync(attemptsPath(fixture)), false);
});

// The acceptance is in the index and the file it named is not in the skill: nothing to retire, and nothing written.
test("retireLesson: a lesson that is not there is refused as lesson-missing", async (t) => {
  const fixture = createFixture(t);
  fs.rmSync(fixture.lessonPath);

  const refused = rejection(await retireLesson(requestFor(fixture), seams()));

  assert.equal(refused.reason, "lesson-missing");
  assert.equal(refused.detail.includes(fixture.lessonPath), true);

  assert.equal(fs.existsSync(path.join(fixture.skillDir, HISTORY_DIR)), false);
  assert.equal(readFile(fixture.skillFilePath), fixture.skillBefore);
  assert.equal(fs.existsSync(attemptsPath(fixture)), false);
});

// A timestamp that is taken is its own answer and not an error: a history is never rewritten, so the retirement stops
// before the first edit and the snapshot that was there is left alone. The name of the snapshot comes from the clock seam,
// not from the request, which is the path the command takes.
test("retireLesson: an occupied timestamp is refused as history-exists and the snapshot is left alone", async (t) => {
  const fixture = createFixture(t);
  const snapshotDir = snapshotDirOf(fixture);
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, SKILL_FILE), "an older skill\n", "utf8");

  const refused = rejection(await retireLesson(requestFor(fixture, { timestamp: undefined }), seams()));

  assert.equal(refused.reason, "history-exists");
  assert.equal(refused.detail.includes(snapshotDir), true);

  assert.deepEqual(relativeTree(snapshotDir), [SKILL_FILE]);
  assert.equal(readFile(path.join(snapshotDir, SKILL_FILE)), "an older skill\n");
  assert.equal(readFile(fixture.lessonPath), ACCEPTED_TEXT);
  assert.equal(readFile(fixture.skillFilePath), fixture.skillBefore);
  assert.equal(fs.existsSync(attemptsPath(fixture)), false);
});

// The step the retirement stops at when the reference line cannot come out: the snapshot is kept -- it was taken before
// the edit and history is never rewritten -- and the tombstone, the record and the line of the index were not written.
test("retireLesson: a reference line that cannot come out leaves the snapshot and nothing else", async (t) => {
  const fixture = createFixture(t);
  const snapshotDir = snapshotDirOf(fixture);

  const failed = seams({
    dropReference: async () => {
      throw new SriWriterError("the reference line did not come out", fixture.skillFilePath);
    },
  });
  const refused = rejection(await retireLesson(requestFor(fixture), failed));

  assert.equal(refused.reason, "reference-failed");
  assert.equal(refused.detail.includes(snapshotDir), true);
  assert.equal(refused.detail.includes("the reference line did not come out"), true);
  assert.equal(refused.detail.includes("can be run again"), true);

  assert.deepEqual(relativeTree(snapshotDir), [SKILL_FILE, `lessons/${SLUG}.md`]);
  assert.equal(readFile(fixture.skillFilePath), fixture.skillBefore);
  assert.equal(readFile(fixture.lessonPath), ACCEPTED_TEXT);
  assert.equal(fs.existsSync(path.join(snapshotDir, RETIREMENT_FILE)), false);
  assert.equal(fs.existsSync(attemptsPath(fixture)), false);
});

// The reason the reference line leaves before the tombstone (M3, S4): a retirement that fails at the tombstone leaves a
// skill that is inert and unchanged -- the file still says accepted, the section no longer references it -- and a second
// run finds its own pre-image intact and finishes. In the other order the second run would trip over the tombstone it
// wrote and no invocation would repair the skill.
test("retireLesson: a retirement that failed at the tombstone finishes on a second run", async (t) => {
  const fixture = createFixture(t);
  const firstSnapshot = snapshotDirOf(fixture);

  const failing = seams({
    retireLesson: async () => {
      throw new SriWriterError("the tombstone could not be written", fixture.lessonPath);
    },
  });
  await assert.rejects(
    () => retireLesson(requestFor(fixture), failing),
    (error: unknown) => error instanceof SriWriterError && error.message.includes("the tombstone could not be written"),
  );

  // The intermediate state: the snapshot is there, the reference line is gone, and the file is the lesson the acceptance
  // measured, so the pre-image of the second run is the same one the first run verified.
  assert.deepEqual(relativeTree(firstSnapshot), [SKILL_FILE, `lessons/${SLUG}.md`]);
  assert.equal(countReferenceLines(readFile(fixture.skillFilePath), SLUG), 0);
  assert.equal(readFile(fixture.lessonPath), ACCEPTED_TEXT);
  assert.equal(fs.existsSync(path.join(firstSnapshot, RETIREMENT_FILE)), false);
  assert.equal(fs.existsSync(attemptsPath(fixture)), false);

  // The second run, a moment later and with the real tombstone: the clock names a free timestamp, so it takes its own
  // snapshot of the skill as the first run left it, removes no line -- there is none -- and finishes.
  const second = retired(await retireLesson(requestFor(fixture, { timestamp: undefined }), seams({ now: () => LATER })));

  assert.equal(second.referenceRemoved, false);
  assert.equal(second.retirementPath, path.join(snapshotDirOf(fixture, LATER_TIMESTAMP), RETIREMENT_FILE));
  assert.equal(readFile(fixture.lessonPath), TOMBSTONE_TEXT);
  assert.equal(fs.existsSync(path.join(snapshotDirOf(fixture, LATER_TIMESTAMP), RETIREMENT_FILE)), true);
  // The first snapshot stays where it was: history is never rewritten, not even the history of a run that failed.
  assert.deepEqual(relativeTree(firstSnapshot), [SKILL_FILE, `lessons/${SLUG}.md`]);

  const lines = readFile(attemptsPath(fixture)).split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).event, "retired");
});

// The line of the index is the join with the acceptance: the pair of hashes is the one of the lesson the acceptance
// measured, the record of the acceptance travels as `historyPath`, and `failureSignature` is an explicit null because a
// retirement decides nothing about a failure.
test("retireLesson: the line of the index carries the hashes of the acceptance and no failure", async (t) => {
  const fixture = createFixture(t);

  retired(await retireLesson(requestFor(fixture), seams()));

  const lines = readFile(attemptsPath(fixture)).split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    ts: NOW.toISOString(),
    event: "retired",
    candidateHash: ACCEPTED_CONTENT_HASH,
    bodyHash: BODY_HASH,
    failureSignature: null,
    targetSkill: SKILL_NAME,
    historyPath: fixture.acceptedHistoryPath,
    reason: `stale: ${REASON_DETAIL}`,
  });
});

// The vocabulary of the reasons is the closed list the schema declares as its enum and the manual teaches as five keys.
// The assertion pins the list against a key that disappears from it.
test("RETIREMENT_REASONS: the vocabulary is the five keys the manual teaches", () => {
  assert.deepEqual([...RETIREMENT_REASONS], ["stale", "superseded", "ineffective", "wrong", "unreferenced"]);
});
