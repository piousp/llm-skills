import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acceptCandidate,
  type AcceptDeps,
  type AcceptOutcome,
  type AcceptRejection,
  type AcceptRequest,
  type AcceptResult,
} from "../../src/gate/acceptance.ts";
import { ATTEMPTS_FILE, HISTORY_DIR, LESSONS_DIR, SKILL_FILE } from "../../src/names.ts";
import { countReferenceLines } from "../../src/skill-reference.ts";
import type { DecisionRecord } from "../../src/types.ts";
import { stateDir } from "../../src/write-base.ts";
import { lessonHashes, SriWriterError } from "../../src/writer.ts";

// The acceptance (S9) on a skill built in mkdtemp: the snapshot, the lesson, the reference line, the record
// of the history and the line of the index. No test names a real skill and nothing outside the temporary
// directory is read or written.
//
// The seams are only used for the branches a real skill cannot be driven into on purpose -- a reference line
// that fails to land -- and the clock, so the snapshot directory of every case is known in advance.

const SKILL_NAME = "pdf-tools";
const SLUG = "merged-cells";
const TITLE = "Extract merged cells with the lattice strategy";
const REFERENCE = `- [lessons/${SLUG}.md](lessons/${SLUG}.md) - ${TITLE}`;
const EXISTING_REFERENCE = "- [lessons/pdf-first.md](lessons/pdf-first.md) - Open the PDF first";
const NOW = new Date("2026-11-02T15:04:05.123Z");
// 2026-11-02T15:04:05.123Z in the spelling writeStagingCandidate gives a staging directory.
const TIMESTAMP = "20261102T150405123Z";
const FAILURE_SIGNATURE = `sha256:${"c".repeat(64)}`;
const LESSON_BODY = "Use pdfplumber with the lattice strategy so merged cells stay apart.";

// The candidate as it was staged: frontmatter included, in the format src/lesson-frontmatter.ts writes, so
// src/writer.ts reads it back with the parser that owns the format.
const LESSON_TEXT = [
  "---",
  `title: ${JSON.stringify(TITLE)}`,
  'date: "2026-11-02"',
  'status: "accepted"',
  "source-evidence:",
  '  - "ev-3f9a1c02"',
  `gate: "accepted@${TIMESTAMP}"`,
  "---",
  "",
  LESSON_BODY,
  "",
].join("\n");

// The two hashes the record declares, computed here and not with src/writer.ts: what the acceptance publishes has
// to agree with an independent computation of the same bytes, and bodyHash is the one of the normalized body,
// which for this body is the body itself.
const BODY_HASH = digestOf(LESSON_BODY);

// A declared skill the way a user writes one: frontmatter, a body, and a `## Lessons` section that already
// lists a lesson. The section exists and its list is one bullet, so the candidate line has to become the
// first bullet of that same list.
function skillFile(references: readonly string[] = [EXISTING_REFERENCE]): string {
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
    ...references,
    "",
  ].join("\n");
}

// The skill as the gate saw it, which is what a record or an expected hash can name.
const GATED_SKILL_HASH = digestOf(skillFile());

interface Fixture {
  base: string; // the write base of the run: <base>/state holds the index
  skillsDir: string; // <base>/skills, where the skill lives
  skillDir: string; // <base>/skills/pdf-tools, the directory the acceptance writes into
  skillFilePath: string;
  lessonsDir: string;
}

interface FixtureOptions {
  references?: readonly string[];
}

function createFixture(t: TestContext, options: FixtureOptions = {}): Fixture {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-gate-acceptance-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const skillsDir = path.join(base, "skills");
  const skillDir = path.join(skillsDir, SKILL_NAME);
  const lessonsDir = path.join(skillDir, LESSONS_DIR);
  fs.mkdirSync(lessonsDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, SKILL_FILE), skillFile(options.references), "utf8");
  fs.writeFileSync(path.join(lessonsDir, "pdf-first.md"), "an older lesson\n", "utf8");

  return { base, skillsDir, skillDir, skillFilePath: path.join(skillDir, SKILL_FILE), lessonsDir };
}

// The record the gate leaves in staging: schema @1, the candidate it measured and the verdict it wrote. The
// gate block is a concluded one, because that is the only status an acceptance can be looking at, and it declares
// a plan of the shape src/gate/scorer.ts produces -- two items, two repetitions each, eight runs -- because a
// design of one item is one that plan refuses to make.
function decisionRecord(contentHash: string): DecisionRecord {
  return {
    schema: "pi-simple-sri/decision@1",
    createdAt: "2026-11-02T14:03:22.481Z",
    trigger: { surface: "command", focus: "merged cells" },
    skill: {
      name: SKILL_NAME,
      dir: `/skills/${SKILL_NAME}`,
      realDir: `/skills/${SKILL_NAME}`,
      wasSymlink: false,
      eligible: true,
    },
    eligibility: { allow: [], deny: [] },
    evidence: [
      {
        id: "ev-3f9a1c02",
        kind: "tool_error",
        toolName: "bash",
        timestamp: 1762082602481,
        source: "transcript",
        excerpt: "pdftotext: cannot open report.pdf",
      },
    ],
    diagnosis: {
      summary: "Table extraction loses merged cells",
      failureSignature: FAILURE_SIGNATURE,
      replayItems: [
        {
          prompt: "extract the merged-cell table from report.pdf",
          cwd: "/work/reports",
          expectation: { class: "tool_error", version: 1, tool: "bash" },
        },
        {
          prompt: "extract the merged-cell table from appendix.pdf",
          cwd: "/work/reports",
          expectation: { class: "tool_error", version: 1, tool: "bash" },
        },
      ],
    },
    candidate: {
      kind: "new-lesson",
      slug: SLUG,
      title: TITLE,
      targetLesson: null,
      lessonPath: `lessons/${SLUG}.md`,
      contentHash,
      bodyHash: BODY_HASH,
    },
    gate: {
      basis: "replay",
      status: "gate-accepted",
      budget: { plannedRuns: 8, usedRuns: 8, interruptedAt: null },
      tokens: {
        proposal: { input: 412, output: 137 },
        incumbent: { input: 210, output: 64 },
        candidate: { input: 205, output: 71 },
        total: { input: 827, output: 272 },
      },
      preregistration: {
        recordedAt: "2026-11-02T14:03:23.000Z",
        threshold: { rule: "unanimous-and-strictly-better", candidatePasses: 4, incumbentPassesMax: 3, version: 1 },
        design: { reps: 2, items: 2, plannedRuns: 8, arms: ["incumbent", "candidate"] },
        mde: { basis: "replay", runsPerArm: 4, resolution: 0.25, requiredDifference: 1 },
      },
      replay: {
        completedAt: "2026-11-02T14:09:58.000Z",
        verdict: "gate-accepted",
        reason: null,
        items: [],
        arms: {
          incumbent: { passes: 3, runs: 4, tokens: { input: 210, output: 64 } },
          candidate: { passes: 4, runs: 4, tokens: { input: 205, output: 71 } },
        },
        interval: {
          method: "wilson",
          alpha: 0.05,
          incumbent: { low: 0.3006, high: 0.9544 },
          candidate: { low: 0.5101, high: 1 },
          difference: { low: 0.0456, high: 0.6994 },
        },
        regressions: 0,
        excluded: [],
        overlays: {
          incumbent: `staging/${TIMESTAMP}/${SKILL_NAME}/arms/incumbent/${SKILL_NAME}`,
          candidate: `staging/${TIMESTAMP}/${SKILL_NAME}/arms/candidate/${SKILL_NAME}`,
          skillContentHash: GATED_SKILL_HASH,
          manifestHash: `sha256:${"d".repeat(64)}`,
        },
      },
    },
    outcome: { status: "gate-accepted", reason: null, decidedAt: "2026-11-02T14:09:58.000Z" },
  };
}

function requestFor(fixture: Fixture, lessonText: string, overrides: Partial<AcceptRequest> = {}): AcceptRequest {
  const contentHash = digestOf(lessonText);

  return {
    base: fixture.base,
    skill: { name: SKILL_NAME, realDir: fixture.skillDir },
    candidate: { slug: SLUG, title: TITLE, lessonText, contentHash },
    decision: decisionRecord(contentHash),
    // The hash the gate preregistered: the SKILL.md of the skill as it stands when the acceptance is asked
    // for it, so a test that wants drift asks with the hash of an older text.
    expectedSkillContentHash: digestOf(readFile(fixture.skillFilePath)),
    // The verdict of a skill the settings admit, which is the one every other test of this file leaves in place: the
    // guard of the eligibility is the first step of the protocol and a test that wants it to fire passes its own.
    eligibility: { eligible: true },
    failureSignature: FAILURE_SIGNATURE,
    timestamp: TIMESTAMP,
    ...overrides,
  };
}

// One clock for every case: the snapshot directory, the decidedAt of the record and the ts of the index line
// are then known without reading them back.
function seams(overrides: AcceptDeps = {}): AcceptDeps {
  return { now: () => NOW, ...overrides };
}

function accepted(outcome: AcceptOutcome): AcceptResult {
  if (!outcome.ok) assert.fail(`the candidate must be accepted: ${outcome.error.reason} (${outcome.error.detail})`);
  return outcome.value;
}

function rejection(outcome: AcceptOutcome): AcceptRejection {
  if (outcome.ok) assert.fail("the candidate must be refused");
  return outcome.error;
}

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function attemptsPath(fixture: Fixture): string {
  return path.join(stateDir(fixture.base), ATTEMPTS_FILE);
}

// Forward-slash relative paths, sorted: the same shape the writer and the overlay suites use, so a tree is
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

  walk(rootDir, "");
  return entries.sort();
}

// The hashes of this suite are computed here and not with src/hash.ts: what the acceptance writes has to
// agree with an independent computation of the same bytes.
function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
}

// The outcome of a record read back, narrowed by hand: this file reads JSON, so the field is unknown until
// something says what it is, and the assertions below are the only thing that says it.
function outcomeOf(record: unknown): DecisionRecord["outcome"] {
  if (typeof record !== "object" || record === null) assert.fail("the history record is not a JSON object");
  const outcome: unknown = (record as Record<string, unknown>).outcome;
  if (typeof outcome !== "object" || outcome === null) assert.fail("the history record carries no outcome");
  return outcome as DecisionRecord["outcome"];
}

// The seams of the writes, each one failing the test if it is reached: a refusal that wrote anything would leave a trace
// here even though the tree of the skill already proves it did not. The guard of the eligibility is the first step of the
// protocol, so none of the six may be called.
function forbiddenWrites(): AcceptDeps {
  return {
    snapshot: async () => assert.fail("an ineligible skill must not be snapshotted"),
    writeLesson: async () => assert.fail("an ineligible skill must not receive a lesson"),
    removeLesson: async () => assert.fail("nothing may be removed"),
    upsertReference: async () => assert.fail("no reference line may be written"),
    writeHistoryDecision: async () => assert.fail("no record may be written"),
    appendAttempt: async () => assert.fail("no line of the index may be written"),
  };
}

test("acceptCandidate: the accepted candidate leaves its snapshot, its lesson and one reference line", async (t) => {
  const fixture = createFixture(t);
  const skillBefore = readFile(fixture.skillFilePath);
  const snapshotDir = path.join(fixture.skillDir, HISTORY_DIR, TIMESTAMP);

  // No timestamp in the request: the one the clock answers is the one the snapshot is named after.
  const request = requestFor(fixture, LESSON_TEXT, { timestamp: undefined });

  const value = accepted(await acceptCandidate(request, seams()));

  assert.equal(value.historyPath, path.join(snapshotDir, "decision.json"));
  assert.equal(value.lessonPath, path.join(fixture.lessonsDir, `${SLUG}.md`));
  assert.equal(value.referenceAdded, true);

  // The snapshot is the skill as it was, taken before anything of it was changed, and the record of the
  // acceptance lands inside it.
  assert.equal(readFile(path.join(snapshotDir, SKILL_FILE)), skillBefore);
  assert.deepEqual(relativeTree(snapshotDir), [SKILL_FILE, "decision.json", "lessons/pdf-first.md"]);

  // The lesson is in the skill and it is the text the gate measured. Read back from the skill it hashes to the
  // pair the record declares -- contentHash over the whole file and bodyHash over the normalized body -- which is
  // the join between the record, the disk and the index (M2).
  assert.equal(readFile(value.lessonPath), LESSON_TEXT);
  const hashes = lessonHashes(readFile(value.lessonPath));
  if (!hashes.ok) assert.fail(`the lesson the acceptance wrote must hash: ${hashes.error}`);
  assert.equal(hashes.value.contentHash, request.decision.candidate.contentHash);
  assert.equal(hashes.value.bodyHash, request.decision.candidate.bodyHash);
  assert.deepEqual(relativeTree(fixture.lessonsDir), [`${SLUG}.md`, "pdf-first.md"]);

  // One line, and it is the first bullet of the section that was already there: the reference the lesson
  // needs to be reachable (Q10).
  assert.equal(readFile(fixture.skillFilePath), skillFile([REFERENCE, EXISTING_REFERENCE]));
  assert.equal(countReferenceLines(readFile(fixture.skillFilePath), SLUG), 1);

  // Everything the acceptance wrote, and nothing else: one snapshot, one lesson, the rewritten SKILL.md.
  assert.deepEqual(relativeTree(fixture.skillDir), [
    `${HISTORY_DIR}/${TIMESTAMP}/${SKILL_FILE}`,
    `${HISTORY_DIR}/${TIMESTAMP}/decision.json`,
    `${HISTORY_DIR}/${TIMESTAMP}/lessons/pdf-first.md`,
    SKILL_FILE,
    `lessons/${SLUG}.md`,
    "lessons/pdf-first.md",
  ]);
});

test("acceptCandidate: accepting the same slug twice adds no second line and rewrites no history", async (t) => {
  const fixture = createFixture(t);
  const snapshotDir = path.join(fixture.skillDir, HISTORY_DIR, TIMESTAMP);

  accepted(await acceptCandidate(requestFor(fixture, LESSON_TEXT), seams()));
  const skillAfterFirst = readFile(fixture.skillFilePath);
  const recordAfterFirst = readFile(path.join(snapshotDir, "decision.json"));

  // The second attempt asks with the hash of the SKILL.md as it is now, so the drift check would pass: what
  // stops it is the reference line the first acceptance added.
  const refused = rejection(await acceptCandidate(requestFor(fixture, LESSON_TEXT), seams()));

  assert.equal(refused.reason, "slug-already-referenced");
  assert.equal(refused.detail.includes(fixture.skillFilePath), true);
  assert.equal(refused.detail.includes(`lessons/${SLUG}.md`), true);

  // Nothing was written: the line is still one, SKILL.md is the text the first acceptance left, the snapshot
  // and its record are the ones it took, and the index has the one event.
  assert.equal(countReferenceLines(skillAfterFirst, SLUG), 1);
  assert.equal(readFile(fixture.skillFilePath), skillAfterFirst);
  assert.deepEqual(fs.readdirSync(path.join(fixture.skillDir, HISTORY_DIR)), [TIMESTAMP]);
  assert.equal(readFile(path.join(snapshotDir, "decision.json")), recordAfterFirst);
  assert.equal(readFile(attemptsPath(fixture)).split("\n").filter((line) => line !== "").length, 1);
});

test("acceptCandidate: a SKILL.md edited since the gate is refused as drift and nothing is written", async (t) => {
  const fixture = createFixture(t);
  const request = requestFor(fixture, LESSON_TEXT);

  // The user edited the skill between the gate and the acceptance.
  fs.appendFileSync(fixture.skillFilePath, "\nAlso read the appendix.\n", "utf8");

  const refused = rejection(await acceptCandidate(request, seams()));

  assert.equal(refused.reason, "skill-drift");
  // Both paths: the file that moved, and the skill directory whose verdict it invalidates, each named as a
  // path of its own and not as a fragment of the other.
  assert.equal(refused.detail.includes(fixture.skillFilePath), true);
  assert.equal(refused.detail.includes(`for ${JSON.stringify(fixture.skillDir)}`), true);
  assert.equal(refused.detail.includes(request.expectedSkillContentHash), true);

  // No snapshot, no lesson, no record and no index line: the refusal happened before the first write.
  assert.deepEqual(relativeTree(fixture.skillDir), [SKILL_FILE, "lessons/pdf-first.md"]);
  assert.equal(fs.existsSync(attemptsPath(fixture)), false);
});

test("acceptCandidate: a slug the SKILL.md already references is refused as the gate comparing the skill with itself", async (t) => {
  const fixture = createFixture(t, { references: [REFERENCE, EXISTING_REFERENCE] });
  const skillBefore = readFile(fixture.skillFilePath);

  const refused = rejection(await acceptCandidate(requestFor(fixture, LESSON_TEXT), seams()));

  assert.equal(refused.reason, "slug-already-referenced");
  assert.equal(refused.detail.includes(fixture.skillFilePath), true);
  assert.equal(refused.detail.includes(`lessons/${SLUG}.md`), true);

  assert.equal(readFile(fixture.skillFilePath), skillBefore);
  assert.deepEqual(relativeTree(fixture.skillDir), [SKILL_FILE, "lessons/pdf-first.md"]);
  assert.equal(fs.existsSync(attemptsPath(fixture)), false);
});

test("acceptCandidate: a reference line that fails withdraws the lesson and the refusal names the snapshot", async (t) => {
  const fixture = createFixture(t);
  const snapshotDir = path.join(fixture.skillDir, HISTORY_DIR, TIMESTAMP);
  const lessonPath = path.join(fixture.lessonsDir, `${SLUG}.md`);

  const failed = seams({
    upsertReference: async () => {
      throw new SriWriterError("the reference line did not land", fixture.skillFilePath);
    },
  });
  const refused = rejection(await acceptCandidate(requestFor(fixture, LESSON_TEXT), failed));

  assert.equal(refused.reason, "reference-failed");
  // The refusal names the snapshot that was taken, what happened to the lesson, and the cause.
  assert.equal(refused.detail.includes(snapshotDir), true);
  assert.equal(refused.detail.includes(lessonPath), true);
  assert.equal(refused.detail.includes("removed: true"), true);
  assert.equal(refused.detail.includes("the reference line did not land"), true);

  // The lesson is gone, the skill keeps its text, and the snapshot stays: history is never rewritten, so the
  // timestamp the failed acceptance took is not given back.
  assert.equal(fs.existsSync(lessonPath), false);
  assert.equal(readFile(fixture.skillFilePath), skillFile());
  assert.deepEqual(relativeTree(snapshotDir), [SKILL_FILE, "lessons/pdf-first.md"]);
  // Nothing reached the authoritative record of the acceptance nor the index.
  assert.equal(fs.existsSync(path.join(snapshotDir, "decision.json")), false);
  assert.equal(fs.existsSync(attemptsPath(fixture)), false);
});

test("acceptCandidate: a skill reached through a symlink is written at its real directory", async (t) => {
  const fixture = createFixture(t);
  const linkPath = path.join(fixture.skillsDir, `${SKILL_NAME}-linked`);
  fs.symlinkSync(fixture.skillDir, linkPath);
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);

  // The inventory keeps the linked path and hands the real one over, which is the path the acceptance
  // writes through (Q11).
  const request = requestFor(fixture, LESSON_TEXT, {
    skill: { name: SKILL_NAME, realDir: fs.realpathSync(linkPath) },
  });
  const value = accepted(await acceptCandidate(request, seams()));

  // The link is still a link and points where it did.
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(linkPath), fixture.skillDir);

  // Everything landed in the directory it points at, and nothing appeared next to the link.
  assert.equal(readFile(path.join(fixture.lessonsDir, `${SLUG}.md`)), LESSON_TEXT);
  assert.equal(value.historyPath, path.join(fixture.skillDir, HISTORY_DIR, TIMESTAMP, "decision.json"));
  assert.equal(fs.existsSync(value.historyPath), true);
  assert.deepEqual(fs.readdirSync(fixture.skillsDir).sort(), [SKILL_NAME, `${SKILL_NAME}-linked`]);
});

test("acceptCandidate: a history snapshot whose timestamp is taken is refused and the snapshot is left alone", async (t) => {
  const fixture = createFixture(t);
  const snapshotDir = path.join(fixture.skillDir, HISTORY_DIR, TIMESTAMP);
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, SKILL_FILE), "an older skill\n", "utf8");

  const refused = rejection(await acceptCandidate(requestFor(fixture, LESSON_TEXT), seams()));

  assert.equal(refused.reason, "history-exists");
  assert.equal(refused.detail.includes(snapshotDir), true);

  // The occupied timestamp is untouched, and nothing of the candidate was written.
  assert.equal(readFile(path.join(snapshotDir, SKILL_FILE)), "an older skill\n");
  assert.deepEqual(relativeTree(snapshotDir), [SKILL_FILE]);
  assert.equal(fs.existsSync(path.join(fixture.lessonsDir, `${SLUG}.md`)), false);
  assert.equal(readFile(fixture.skillFilePath), skillFile());
  assert.equal(fs.existsSync(attemptsPath(fixture)), false);
});

test("acceptCandidate: an invalid clock names no snapshot, fails closed and writes nothing", async (t) => {
  const fixture = createFixture(t);

  // No timestamp in the request, so the name of the snapshot comes from the clock: an invalid date has no name
  // to give and the refusal is thrown instead of becoming a rejection of the candidate.
  await assert.rejects(
    () =>
      acceptCandidate(
        requestFor(fixture, LESSON_TEXT, { timestamp: undefined }),
        seams({ now: () => new Date(Number.NaN) }),
      ),
    (error: unknown) =>
      error instanceof SriWriterError &&
      error.message.includes("cannot name a history snapshot after an invalid date"),
  );

  // The refusal happens before the first write: no snapshot, no lesson, no index line, and the skill keeps the
  // text the gate saw.
  assert.deepEqual(relativeTree(fixture.skillDir), [SKILL_FILE, "lessons/pdf-first.md"]);
  assert.equal(readFile(fixture.skillFilePath), skillFile());
  assert.equal(fs.existsSync(attemptsPath(fixture)), false);
});

test("acceptCandidate: the history record says accepted and the index line joins it to the gate", async (t) => {
  const fixture = createFixture(t);
  const request = requestFor(fixture, LESSON_TEXT);

  const value = accepted(await acceptCandidate(request, seams()));

  // The record is the staged one with the outcome of the write, byte for byte: the gate block keeps the
  // "gate-accepted" the gate decided, and the acceptance never rewrites it to "accepted".
  const record: unknown = JSON.parse(readFile(value.historyPath));
  assert.deepEqual(record, {
    ...request.decision,
    outcome: { status: "accepted", reason: null, decidedAt: NOW.toISOString() },
  });

  const outcome = outcomeOf(record);
  assert.equal(outcome.status, "accepted");
  assert.equal(outcome.reason, null);
  assert.equal(outcome.decidedAt, NOW.toISOString());

  // The caller's own record is not mutated by the acceptance.
  assert.equal(request.decision.outcome.status, "gate-accepted");

  // One line of the index, with the failure it is about and the path of the record it belongs to, which is
  // what joins the "gate-accepted" of staging with the "accepted" of the write by candidateHash.
  const lines = readFile(attemptsPath(fixture)).split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    ts: NOW.toISOString(),
    event: "accepted",
    candidateHash: digestOf(LESSON_TEXT),
    bodyHash: BODY_HASH,
    failureSignature: FAILURE_SIGNATURE,
    targetSkill: SKILL_NAME,
    historyPath: value.historyPath,
  });
});

// M3, S7 (D-C): the last negative, and the only one this protocol cannot read for itself -- it reads no settings, on
// purpose. The verdict arrives as data, so a caller that learned the skill is no longer eligible after the gate spent its
// budget stops here: before the snapshot, before the lesson and before the SKILL.md is even read.
test("acceptCandidate: a skill that is no longer eligible is refused before the snapshot", async (t) => {
  const fixture = createFixture(t);
  const skillBefore = readFile(fixture.skillFilePath);
  const request = requestFor(fixture, LESSON_TEXT, {
    eligibility: { eligible: false, reason: "not-eligible" },
  });

  const refused = rejection(await acceptCandidate(request, seams(forbiddenWrites())));

  assert.equal(refused.reason, "no-longer-eligible");
  // The reason of the verdict is in the detail: the settings and the name this package reserves are two facts, and the
  // sentence says which one refused the write.
  assert.equal(refused.detail.includes(SKILL_NAME), true);
  assert.equal(refused.detail.includes("is no longer eligible: not-eligible"), true);

  // Nothing was created, nothing was written and the index has no line: the refusal is the first step of the protocol.
  assert.deepEqual(relativeTree(fixture.skillDir), [SKILL_FILE, "lessons/pdf-first.md"]);
  assert.equal(readFile(fixture.skillFilePath), skillBefore);
  assert.equal(fs.existsSync(attemptsPath(fixture)), false);
});

// The other side of the guard: an eligible verdict is not a second refusal, and the protocol runs as it did before the
// guard existed -- which is what the rest of this file proves with the same default.
test("acceptCandidate: an eligible skill follows the protocol of the slice", async (t) => {
  const fixture = createFixture(t);
  const request = requestFor(fixture, LESSON_TEXT, { eligibility: { eligible: true } });

  const value = accepted(await acceptCandidate(request, seams()));

  assert.equal(value.referenceAdded, true);
  assert.equal(readFile(path.join(fixture.lessonsDir, `${SLUG}.md`)), LESSON_TEXT);
  assert.equal(countReferenceLines(readFile(fixture.skillFilePath), SLUG), 1);
});
