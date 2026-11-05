import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Ledger, LedgerLine, ReadAttemptLine } from "../../src/ledger.ts";
import { serializeLesson } from "../../src/lesson-frontmatter.ts";
import { DECISION_FILE, HISTORY_DIR, LESSONS_DIR, SKILL_FILE } from "../../src/names.ts";
import { lessonReferencePath } from "../../src/skill-reference.ts";
import { standingOf } from "../../src/standing.ts";
import { LESSON_GATE_ACCEPTED } from "../../src/types.ts";
import type { DecisionRecord, GateBlock, GateTokens, LessonDraft } from "../../src/types.ts";
import { lessonHashes } from "../../src/writer.ts";
import type { LessonHashes } from "../../src/writer.ts";

// The check of an accepted lesson against the record that accepted it (M3, S3; OA6 of the plan). What this file fixes
// is that the record decides and the frontmatter does not: the states are read off the bytes the record names, the
// reference line is a question of its own, and an acceptance nobody can compare against its record is counted instead of
// answered. The negative tie of M2 -- a file that says `proposed` and hashes to the record -- is the test that proves it.
//
// The skills are real directories under a temporary base, because the module is a read of lesson bytes and of a
// SKILL.md. The ledger, in contrast, is built by hand: the subject is a value the reader of src/ledger.ts hands over, and
// a fixture of the index would prove that reader a second time.

const SKILL = "pdf-tools";
const SLUG = "extract-tables-with-merged-cells";
const TITLE = "Extract tables with merged cells";
const BODY = "Use pdfplumber with the lattice strategy for merged cells.";
const SECOND_SLUG = "use-camelot-for-tables";
const SECOND_TITLE = "Use camelot for tables";
const SECOND_BODY = "Use camelot when the table has no ruling lines.";

const TS = "2026-11-04T09:00:00.000Z";
const LATER = "2026-11-05T09:00:00.000Z";
const SNAPSHOT = "20261104T090000000Z";
const HASH = `sha256:${"a".repeat(64)}`;
const SIGNATURE = `sha256:${"b".repeat(64)}`;
const SCHEMA = "pi-simple-sri/decision@1";

const TOKENS: GateTokens = { input: 0, output: 0 };
// The gate block of a record that was never measured. Nothing in this module reads it -- what is checked is the pair of
// hashes and the reference line -- so the fixture carries the smallest block the schema allows instead of inventing
// numbers of a run that did not happen.
const NOT_RUN_GATE: GateBlock = {
  basis: "replay",
  status: "not-run",
  budget: { plannedRuns: 0, usedRuns: 0, interruptedAt: null },
  tokens: { proposal: TOKENS, incumbent: TOKENS, candidate: TOKENS, total: TOKENS },
  preregistration: null,
  replay: null,
};

interface Fixture {
  root: string; // the base of the run: a history path of the index is relative to it
  skillDir: string; // <root>/skills/pdf-tools, with lessons/ already there
}

function createFixture(t: TestContext): Fixture {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-standing-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const skillDir = path.join(root, "skills", SKILL);
  fs.mkdirSync(path.join(skillDir, LESSONS_DIR), { recursive: true });

  return { root, skillDir };
}

// The draft of a lesson of this package, with the fields a test does not care about filled once. The bytes a test
// hashes are the ones src/lesson-frontmatter.ts emits, so the fixture is the file a real lesson is and not a text that
// happens to resemble one.
function draftOf(overrides: Partial<LessonDraft> = {}): LessonDraft {
  return {
    slug: SLUG,
    title: TITLE,
    date: "2026-11-04",
    status: "accepted",
    sourceEvidence: ["ev-3f9a1c02"],
    gate: LESSON_GATE_ACCEPTED,
    body: BODY,
    ...overrides,
  };
}

function lessonTextOf(draft: LessonDraft): string {
  const serialized = serializeLesson(draft);
  if (!serialized.ok) assert.fail(`the lesson of this test must serialize: ${serialized.error}`);
  return serialized.value;
}

// The pair of hashes the record carries, from the same function the writer stamps it with (D4).
function hashesOf(text: string): LessonHashes {
  const hashes = lessonHashes(text);
  if (!hashes.ok) assert.fail(`the lesson of this test must hash: ${hashes.error}`);
  return hashes.value;
}

function lessonPathOf(fixture: Fixture, slug: string): string {
  return path.join(fixture.skillDir, LESSONS_DIR, `${slug}.md`);
}

function writeLesson(fixture: Fixture, slug: string, text: string): string {
  const lessonPath = lessonPathOf(fixture, slug);
  fs.writeFileSync(lessonPath, text, "utf8");
  return lessonPath;
}

// The SKILL.md of the fixture skill: the `## Lessons` section and one canonical reference line per slug
// (src/skill-reference.ts), because that line is the only thing that makes a lesson reachable (Q10). An empty list is a
// section with no reference at all, which is the shape of a skill that lost its list.
function writeSkillFile(fixture: Fixture, slugs: readonly string[]): string {
  const skillFilePath = path.join(fixture.skillDir, SKILL_FILE);
  const lines = slugs.map((slug) => `- [${lessonReferencePath(slug)}](${lessonReferencePath(slug)}) - A lesson\n`);
  fs.writeFileSync(skillFilePath, `# ${SKILL}\n\n## Lessons\n\n${lines.join("")}`, "utf8");
  return skillFilePath;
}

// Where the acceptance leaves the authoritative record of a run: inside the skill, in the snapshot it took before
// touching it. The index names it relative to the base of the run and the ledger resolves it to this absolute path.
function historyPathOf(fixture: Fixture): string {
  return path.join(fixture.skillDir, HISTORY_DIR, SNAPSHOT, DECISION_FILE);
}

interface RecordOptions {
  realDir: string;
  draft: LessonDraft;
  hashes: LessonHashes;
}

// The history record of an acceptance. The candidate block names the lesson relative to the skill and carries the pair
// of hashes of the bytes that landed, which is the whole of what this module reads; the outcome is the one the
// acceptance writes.
function recordOf(options: RecordOptions): DecisionRecord {
  return {
    schema: SCHEMA,
    createdAt: TS,
    trigger: { surface: "command", focus: null },
    skill: { name: SKILL, dir: options.realDir, realDir: options.realDir, wasSymlink: false, eligible: true },
    eligibility: { allow: [], deny: [] },
    evidence: [],
    diagnosis: { summary: "", failureSignature: SIGNATURE, replayItems: [] },
    candidate: {
      kind: "new-lesson",
      slug: options.draft.slug,
      title: options.draft.title,
      targetLesson: null,
      lessonPath: lessonReferencePath(options.draft.slug),
      contentHash: options.hashes.contentHash,
      bodyHash: options.hashes.bodyHash,
    },
    gate: NOT_RUN_GATE,
    outcome: { status: "accepted", reason: null, decidedAt: TS },
  };
}

interface LineOptions {
  skill?: string;
  ts?: string;
  candidateHash?: string;
  historyPath?: string;
}

// One line of the index as the reader of src/ledger.ts hands it: `event` is a plain string, because the vocabulary of
// the writer is not the vocabulary of the reader.
function lineOf(event: string, options: LineOptions = {}): ReadAttemptLine {
  return {
    ts: options.ts ?? TS,
    event,
    candidateHash: options.candidateHash ?? HASH,
    bodyHash: HASH,
    failureSignature: null,
    targetSkill: options.skill ?? SKILL,
    ...(options.historyPath === undefined ? {} : { historyPath: options.historyPath }),
  };
}

interface EntryOptions {
  record?: DecisionRecord;
  recordPath?: string;
  problem?: string;
}

function entryOf(index: number, line: ReadAttemptLine, options: EntryOptions = {}): LedgerLine {
  return {
    index,
    line,
    record: options.record ?? null,
    recordPath: options.recordPath ?? null,
    ...(options.problem === undefined ? {} : { problem: options.problem }),
  };
}

// The entry of an acceptance: the line names the history path the acceptance wrote -- relative to the base of the run,
// the way src/writer.ts publishes it -- and the entry carries the record already resolved plus the absolute path it was
// resolved to.
function acceptedEntry(fixture: Fixture, record: DecisionRecord, index = 0): LedgerLine {
  const historyPath = historyPathOf(fixture);
  return entryOf(index, lineOf("accepted", { historyPath: path.relative(fixture.root, historyPath) }), {
    record,
    recordPath: historyPath,
  });
}

function ledgerOf(...lines: LedgerLine[]): Ledger {
  return { lines, damaged: null };
}

// The whole report of a lesson whose bytes are the ones the record names, which is the case every other test moves one
// field away from.
test("standingOf: a lesson whose bytes are the ones of the record is intact and referenced", async (t) => {
  const fixture = createFixture(t);
  const draft = draftOf();
  const text = lessonTextOf(draft);
  const hashes = hashesOf(text);
  const lessonPath = writeLesson(fixture, draft.slug, text);
  writeSkillFile(fixture, [draft.slug]);

  const report = await standingOf(ledgerOf(acceptedEntry(fixture, recordOf({ realDir: fixture.skillDir, draft, hashes }))));

  // The whole report, key by key: an intact and referenced lesson carries no detail, and the row of the skill names the
  // only state it has.
  assert.deepEqual(report, {
    checks: [
      {
        skill: SKILL,
        slug: draft.slug,
        lessonPath,
        standing: "intact",
        referenced: true,
        historyPath: historyPathOf(fixture),
      },
    ],
    skills: [{ skill: SKILL, worst: "intact", lessons: 1 }],
    missingRecords: 0,
  });
});

// The header of a lesson can move while the correction it describes stays the same: the frontmatter was edited after the
// acceptance -- the retirement of M3 writes exactly that -- and the body is the one the record measured.
test("standingOf: a moved frontmatter over the body of the record is frontmatter-moved", async (t) => {
  const fixture = createFixture(t);
  const accepted = draftOf();
  const hashes = hashesOf(lessonTextOf(accepted));
  const lessonPath = writeLesson(fixture, accepted.slug, lessonTextOf(draftOf({ status: "retired" })));
  writeSkillFile(fixture, [accepted.slug]);

  const report = await standingOf(
    ledgerOf(acceptedEntry(fixture, recordOf({ realDir: fixture.skillDir, draft: accepted, hashes }))),
  );

  const [check] = report.checks;
  assert.equal(check.standing, "frontmatter-moved");
  assert.equal(check.lessonPath, lessonPath);
  assert.equal(check.referenced, true);
  // The detail is the arithmetic: the body still matches the record and the bytes do not.
  assert.equal(check.detail?.includes(hashes.bodyHash), true);
  assert.equal(check.detail?.includes(hashes.contentHash), true);
  assert.deepEqual(report.skills, [{ skill: SKILL, worst: "frontmatter-moved", lessons: 1 }]);
});

// The correction itself was rewritten: neither hash of the record describes the file any more, and no state other than
// `body-moved` says it.
test("standingOf: a rewritten body is body-moved", async (t) => {
  const fixture = createFixture(t);
  const accepted = draftOf();
  const hashes = hashesOf(lessonTextOf(accepted));
  const lessonPath = writeLesson(fixture, accepted.slug, lessonTextOf(draftOf({ body: SECOND_BODY })));
  writeSkillFile(fixture, [accepted.slug]);

  const report = await standingOf(
    ledgerOf(acceptedEntry(fixture, recordOf({ realDir: fixture.skillDir, draft: accepted, hashes }))),
  );

  const [check] = report.checks;
  assert.equal(check.standing, "body-moved");
  assert.equal(check.detail?.includes(lessonPath), true);
  assert.equal(check.detail?.includes(hashes.contentHash), true);
  assert.equal(check.detail?.includes(hashes.bodyHash), true);
  assert.deepEqual(report.skills, [{ skill: SKILL, worst: "body-moved", lessons: 1 }]);
});

// The file the record names is gone. The report says which path it looked for, because that path is the answer a user has
// to act on, and the reference line it does not find there is a separate question with its own answer.
test("standingOf: a lesson that is not there is missing, and the detail names the path", async (t) => {
  const fixture = createFixture(t);
  const draft = draftOf();
  const hashes = hashesOf(lessonTextOf(draft));
  writeSkillFile(fixture, [draft.slug]);

  const report = await standingOf(
    ledgerOf(acceptedEntry(fixture, recordOf({ realDir: fixture.skillDir, draft, hashes }))),
  );

  const [check] = report.checks;
  assert.equal(check.standing, "missing");
  assert.equal(check.lessonPath, lessonPathOf(fixture, draft.slug));
  assert.equal(check.detail?.includes(check.lessonPath), true);
  // SKILL.md still carries the line that points at the absent file: the two halves of the check answer on their own.
  assert.equal(check.referenced, true);
  assert.deepEqual(report.skills, [{ skill: SKILL, worst: "missing", lessons: 1 }]);
});

// A lesson can be byte-identical to its record and still be inert: pi loads the skill through the reference line of
// `## Lessons` (Q10), so a skill that does not carry it loads the skill without the lesson.
test("standingOf: an intact lesson without a reference line is reported inert", async (t) => {
  const fixture = createFixture(t);
  const draft = draftOf();
  const text = lessonTextOf(draft);
  const hashes = hashesOf(text);
  writeLesson(fixture, draft.slug, text);
  // The section exists and carries no line for this slug.
  const skillFilePath = writeSkillFile(fixture, []);
  const ledger = ledgerOf(acceptedEntry(fixture, recordOf({ realDir: fixture.skillDir, draft, hashes })));

  const [unreferenced] = (await standingOf(ledger)).checks;
  assert.equal(unreferenced.standing, "intact");
  assert.equal(unreferenced.referenced, false);
  assert.equal(unreferenced.detail?.includes(lessonReferencePath(draft.slug)), true);

  // The same question asked of a skill whose SKILL.md nobody can read: the answer is the same one -- the lesson is not
  // reachable -- and the detail says which of the two happened, because a lost line and a lost file are different
  // repairs.
  fs.rmSync(skillFilePath);
  const [unreadable] = (await standingOf(ledger)).checks;
  assert.equal(unreadable.standing, "intact");
  assert.equal(unreadable.referenced, false);
  assert.equal(unreadable.detail?.includes(skillFilePath), true);
});

// The tie of M2, and the reason this module exists: the frontmatter of a lesson can say `proposed` and the bytes can be
// the ones the record accepted -- a candidate that stays in staging/ carries the frontmatter of the lesson it would have
// been. The record is the authority, so the answer is `intact` and nothing in the check consults the header.
test("standingOf: a lesson whose frontmatter says proposed and whose bytes are the record is intact", async (t) => {
  const fixture = createFixture(t);
  const draft = draftOf({ status: "proposed" });
  const text = lessonTextOf(draft);
  const hashes = hashesOf(text);
  writeLesson(fixture, draft.slug, text);
  writeSkillFile(fixture, [draft.slug]);

  const record = recordOf({ realDir: fixture.skillDir, draft, hashes });
  // The record and the line say the candidate was accepted, and the file on disk says it was proposed.
  assert.equal(record.outcome.status, "accepted");
  assert.equal(fs.readFileSync(lessonPathOf(fixture, draft.slug), "utf8").includes('status: "proposed"'), true);

  const report = await standingOf(ledgerOf(acceptedEntry(fixture, record)));

  const [check] = report.checks;
  assert.equal(check.standing, "intact");
  assert.equal(check.referenced, true);
  assert.equal(check.detail, undefined);
  assert.deepEqual(report.skills, [{ skill: SKILL, worst: "intact", lessons: 1 }]);
});

// An acceptance a later retirement of the same candidate revoked is not a lesson the skill applies any more: it is left
// out of the checks instead of being reported as a drift of a file nobody is supposed to keep in force.
test("standingOf: an accepted lesson with a later retired line is not checked", async (t) => {
  const fixture = createFixture(t);
  const draft = draftOf();
  const text = lessonTextOf(draft);
  const hashes = hashesOf(text);
  writeLesson(fixture, draft.slug, text);
  writeSkillFile(fixture, [draft.slug]);

  const report = await standingOf(
    ledgerOf(
      acceptedEntry(fixture, recordOf({ realDir: fixture.skillDir, draft, hashes })),
      // The same candidate of the same skill, retired later: the retirement names no record of its own.
      entryOf(1, lineOf("retired", { ts: LATER })),
    ),
  );

  assert.deepEqual(report.checks, []);
  assert.deepEqual(report.skills, []);
  assert.equal(report.missingRecords, 0);
});

// `historyPath` points inside the skill and `staging/` and `.history/` may both be pruned: an acceptance whose record is
// gone cannot be compared against anything, so it is counted and never reported as intact.
test("standingOf: an accepted line whose record is unreadable is counted and not checked", async (t) => {
  const fixture = createFixture(t);
  const historyPath = historyPathOf(fixture);

  const report = await standingOf(
    ledgerOf(
      entryOf(0, lineOf("accepted", { historyPath: path.relative(fixture.root, historyPath) }), {
        recordPath: historyPath,
        problem: `the record ${historyPath} is not a file`,
      }),
    ),
  );

  assert.deepEqual(report.checks, []);
  assert.deepEqual(report.skills, []);
  assert.equal(report.missingRecords, 1);
});

// The row of a skill carries one state and it is the worst of its lessons: a single lesson that vanished is what a
// reader has to see, whatever the state of the other one is.
test("standingOf: the worst state of the lessons of a skill is what its row reports", async (t) => {
  const fixture = createFixture(t);
  const intact = draftOf();
  const intactHashes = hashesOf(lessonTextOf(intact));
  writeLesson(fixture, intact.slug, lessonTextOf(intact));

  // The second lesson of the same skill is never written: its record names a file the skill lost.
  const vanished = draftOf({ slug: SECOND_SLUG, title: SECOND_TITLE, body: SECOND_BODY });
  const vanishedHashes = hashesOf(lessonTextOf(vanished));
  writeSkillFile(fixture, [intact.slug, vanished.slug]);

  const report = await standingOf(
    ledgerOf(
      acceptedEntry(fixture, recordOf({ realDir: fixture.skillDir, draft: intact, hashes: intactHashes }), 0),
      acceptedEntry(fixture, recordOf({ realDir: fixture.skillDir, draft: vanished, hashes: vanishedHashes }), 1),
    ),
  );

  assert.deepEqual(
    report.checks.map((check) => [check.slug, check.standing]),
    [
      [intact.slug, "intact"],
      [vanished.slug, "missing"],
    ],
  );
  assert.deepEqual(report.skills, [{ skill: SKILL, worst: "missing", lessons: 2 }]);
  assert.equal(report.missingRecords, 0);
});
