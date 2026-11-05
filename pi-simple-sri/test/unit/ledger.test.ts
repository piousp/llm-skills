import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLedger } from "../../src/ledger.ts";
import { ATTEMPTS_FILE } from "../../src/names.ts";
import { stateDir } from "../../src/write-base.ts";

// The reader of the index of attempts (Q14) and of the records its lines name. What this file fixes is the
// tolerance, which is the whole contract of the module: an unknown event is read and kept, a line nothing can
// interpret stops the reading at its own index, a record that is absent, of another version or without the spine its
// consumers read is a problem of its line and never an exception, and a read leaves the bytes of the fixture where they were.
//
// The fixtures are real files under a temporary base, because the module is arithmetic over paths and fs: a stub of
// fs would prove the shape of the code and not the answer to a directory that is not what the index says it is.

const INDEX_TS = "2026-11-04T09:00:00.000Z";
const CONTENT_HASH = `sha256:${"a".repeat(64)}`;
const BODY_HASH = `sha256:${"b".repeat(64)}`;
const DECISION_SCHEMA = "pi-simple-sri/decision@1";
const LESSON_SLUG = "use-the-lattice-strategy-for-merged-cells";
// The authoritative record of an accepted candidate: inside the skill, and published relative to the base.
const HISTORY_RELATIVE = "skills/pdf-tools/.history/20261104T090000000Z/decision.json";
const STAGING_DECISION_RELATIVE = "staging/20261104T090000000Z/pdf-tools/decision.json";

interface Fixture {
  base: string;
  indexPath: string;
}

// The base of a run as the first writer would leave it: state/ exists and the index does not, which is what a
// package just installed looks like.
function createFixture(t: TestContext): Fixture {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-ledger-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const base = path.join(root, "sri");
  fs.mkdirSync(stateDir(base), { recursive: true });

  return { base, indexPath: path.join(stateDir(base), ATTEMPTS_FILE) };
}

interface LinePaths {
  decisionPath?: string;
  historyPath?: string;
}

// One line of the index as the writers build it. `event` is a plain string here because the event this version
// cannot name is the case the reader exists for, and each test decides which paths its event names.
function lineOf(event: string, paths: LinePaths = {}): Record<string, unknown> {
  return {
    ts: INDEX_TS,
    event,
    candidateHash: CONTENT_HASH,
    bodyHash: BODY_HASH,
    failureSignature: null,
    targetSkill: "pdf-tools",
    ...paths,
  };
}

function writeIndex(fixture: Fixture, lines: readonly unknown[]): void {
  writeRawIndex(fixture, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
}

function writeRawIndex(fixture: Fixture, text: string): void {
  fs.writeFileSync(fixture.indexPath, text, "utf8");
}

// A decision.json with the spine whole, and the absolute path it landed at. The spine is what the reader checks -- the five
// blocks its three consumers dereference -- and `spine` is what a test adds or replaces on top of it, so the fixture of a
// broken record is the whole record a hand edit took one block out of. A key set to undefined is a key the record does not
// have: JSON.stringify drops it, which is how the two broken fixtures below write a record with no `candidate` at all.
// Nothing deeper is written, because the shape of the whole document is the business of the gate.
function decisionRecord(spine: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: DECISION_SCHEMA,
    createdAt: INDEX_TS,
    skill: { name: "pdf-tools", dir: "/skills/pdf-tools", realDir: "/skills/pdf-tools", wasSymlink: false, eligible: true },
    candidate: {
      kind: "new-lesson",
      slug: LESSON_SLUG,
      title: "Use the lattice strategy for merged cells",
      targetLesson: null,
      lessonPath: `lessons/${LESSON_SLUG}.md`,
      contentHash: CONTENT_HASH,
      bodyHash: BODY_HASH,
    },
    evidence: [],
    outcome: { status: "accepted", reason: null, decidedAt: INDEX_TS },
    gate: { basis: "replay", status: "not-run" },
    ...spine,
  };
}

function writeRecord(fixture: Fixture, relative: string, record: Record<string, unknown>): string {
  const recordPath = path.join(fixture.base, relative);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return recordPath;
}

// What a read must not change: the two numbers a write moves, plus the bytes, read by the test and not by the module.
function snapshotOf(targets: readonly string[]): { path: string; mtimeMs: number; size: number }[] {
  return targets.map((target) => {
    const stats = fs.statSync(target);
    return { path: target, mtimeMs: stats.mtimeMs, size: stats.size };
  });
}

// A machine that never ran an attempt has no index, and the series of that machine is empty: the answer is an empty
// ledger and not an error, and nothing creates the file to make the question easier.
test("readLedger: an absent index is an empty ledger", async (t) => {
  const fixture = createFixture(t);

  const ledger = await readLedger(fixture.base);

  assert.deepEqual(ledger, { lines: [], damaged: null });
  assert.equal(fs.existsSync(fixture.indexPath), false);
});

test("readLedger: two lines are two entries, in the order of the file", async (t) => {
  const fixture = createFixture(t);
  writeIndex(fixture, [lineOf("proposed"), lineOf("no-evidence")]);

  const ledger = await readLedger(fixture.base);

  assert.equal(ledger.damaged, null);
  assert.deepEqual(
    ledger.lines.map((entry) => entry.index),
    [0, 1],
  );
  assert.deepEqual(
    ledger.lines.map((entry) => entry.line.event),
    ["proposed", "no-evidence"],
  );
  assert.equal(ledger.lines[0].line.targetSkill, "pdf-tools");
  assert.equal(ledger.lines[0].line.candidateHash, CONTENT_HASH);

  // Reading is not a privilege that has to be defended: the base is resolved and not required absolute, so a
  // relative spelling of the same base answers the same ledger.
  const relative = await readLedger(path.relative(process.cwd(), fixture.base));
  assert.deepEqual(
    relative.lines.map((entry) => entry.line.event),
    ["proposed", "no-evidence"],
  );
});

// Rule 1 of src/attempts.ts: no reader may fail on an event it does not know, and no reader may rewrite one either.
// The unknown event is the vocabulary of a later version, and it is counted exactly like the events this one names.
test("readLedger: an unknown event is kept verbatim between the known ones", async (t) => {
  const fixture = createFixture(t);
  writeIndex(fixture, [lineOf("proposed"), lineOf("gate-retired-later"), lineOf("gate-rejected")]);

  const ledger = await readLedger(fixture.base);

  assert.equal(ledger.damaged, null);
  assert.deepEqual(
    ledger.lines.map((entry) => entry.line.event),
    ["proposed", "gate-retired-later", "gate-rejected"],
  );
  // Kept as written, not normalized into a known event and not dropped from the count.
  assert.equal(ledger.lines[1].line.event, "gate-retired-later");
  assert.equal(ledger.lines[1].index, 1);
});

// The truncated tail of an interrupted append: the last line has no newline and is not JSON. The lines before it were
// written whole, so they are read; the file has no way back from the line that broke, so the reading stops there.
test("readLedger: a truncated last line stops the reading at its index", async (t) => {
  const fixture = createFixture(t);
  const truncated = JSON.stringify(lineOf("gate-rejected"));
  writeRawIndex(fixture, `${JSON.stringify(lineOf("proposed"))}\n${truncated.slice(0, truncated.length - 12)}`);

  const ledger = await readLedger(fixture.base);

  assert.equal(ledger.lines.length, 1);
  assert.equal(ledger.lines[0].index, 0);
  assert.equal(ledger.damaged?.index, 1);
  assert.equal(ledger.damaged?.problem.includes(fixture.indexPath), true);
  assert.notEqual(ledger.damaged?.problem, "");
  // The fixture is the shape an interrupted append leaves: no newline after the line that did not land.
  assert.equal(fs.readFileSync(fixture.indexPath, "utf8").endsWith("\n"), false);
});

// The record of an accepted line is its historyPath -- the authoritative record inside the skill -- and not the
// decisionPath of the staged candidate it was measured in. The staged path of this fixture names nothing, so a
// reader that preferred it would answer a problem instead of a record.
test("readLedger: an accepted line resolves the record its historyPath names", async (t) => {
  const fixture = createFixture(t);
  const historyPath = writeRecord(fixture, HISTORY_RELATIVE, decisionRecord());
  writeIndex(fixture, [
    lineOf("accepted", { historyPath: HISTORY_RELATIVE, decisionPath: STAGING_DECISION_RELATIVE }),
  ]);

  const ledger = await readLedger(fixture.base);

  const [entry] = ledger.lines;
  assert.equal(entry.recordPath, historyPath);
  assert.equal(path.isAbsolute(entry.recordPath ?? ""), true);
  assert.equal(entry.record?.schema, DECISION_SCHEMA);
  assert.equal(entry.problem, undefined);
});

// A record that is no longer there is the ordinary consequence of a pruned staging directory: the line was written,
// the attempt happened, and what the reader owes its caller is the line and the reason the record is missing, with the
// reading of the next line unaffected.
test("readLedger: a record that is not there is a problem of its line, and the reading goes on", async (t) => {
  const fixture = createFixture(t);
  writeIndex(fixture, [
    lineOf("gate-rejected", { decisionPath: STAGING_DECISION_RELATIVE }),
    lineOf("proposed"),
  ]);

  const ledger = await readLedger(fixture.base);

  assert.equal(ledger.damaged, null);
  assert.equal(ledger.lines.length, 2);

  const [rejected, proposed] = ledger.lines;
  assert.equal(rejected.record, null);
  assert.equal(rejected.recordPath, path.join(fixture.base, STAGING_DECISION_RELATIVE));
  assert.equal(rejected.problem?.includes(rejected.recordPath ?? ""), true);
  assert.equal(rejected.problem?.endsWith("not a file"), true);

  assert.equal(proposed.line.event, "proposed");
  assert.equal(proposed.record, null);
  assert.equal(proposed.recordPath, null);
  assert.equal(proposed.problem, undefined);
});

// The version is the first guard of the module on a record: a record of a decision@2 is not one this version can
// count, and the line says so instead of throwing or of counting a record it does not understand.
test("readLedger: a record of another schema is a problem and not an exception", async (t) => {
  const fixture = createFixture(t);
  writeRecord(fixture, HISTORY_RELATIVE, decisionRecord({ schema: "pi-simple-sri/decision@2" }));
  writeIndex(fixture, [lineOf("accepted", { historyPath: HISTORY_RELATIVE })]);

  const ledger = await readLedger(fixture.base);

  const [entry] = ledger.lines;
  assert.equal(entry.record, null);
  assert.equal(entry.problem?.includes("unsupported schema"), true);
  assert.equal(entry.problem?.includes("pi-simple-sri/decision@2"), true);
  assert.equal(ledger.damaged, null);
});

// The shape, which is the second guard and the one B5 added: a record that declares the version this package reads and lost
// `candidate` entirely is a `problem` of its own line, not `damaged`. The line of the index was read and what is broken is the
// annex it names, so the reading goes on to the last line instead of stopping where the record broke.
test("readLedger: a record without a candidate is a problem of its line, and the reading goes on", async (t) => {
  const fixture = createFixture(t);
  const recordPath = writeRecord(fixture, HISTORY_RELATIVE, decisionRecord({ candidate: undefined }));
  writeIndex(fixture, [lineOf("accepted", { historyPath: HISTORY_RELATIVE }), lineOf("proposed")]);

  const ledger = await readLedger(fixture.base);

  assert.equal(ledger.damaged, null);
  assert.equal(ledger.lines.length, 2);

  const [accepted, proposed] = ledger.lines;
  assert.equal(accepted.record, null);
  assert.equal(accepted.recordPath, recordPath);
  // The sentence the line reports it with: the path it read, the refusal, and the field of the spine it asked for.
  assert.equal(accepted.problem?.startsWith(`${JSON.stringify(recordPath)}: not a decision record: `), true);
  assert.equal(accepted.problem?.endsWith("candidate is undefined"), true);

  assert.equal(proposed.index, 1);
  assert.equal(proposed.line.event, "proposed");
  assert.equal(proposed.problem, undefined);
});

// The block that is there and lost one field of the spine: a skill with no `realDir` is a path the check of src/standing.ts
// cannot resolve, and the sentence names the field and not only the block, because the field is what has to be repaired.
test("readLedger: a skill without its realDir is a problem that names the field", async (t) => {
  const fixture = createFixture(t);
  writeRecord(fixture, HISTORY_RELATIVE, decisionRecord({ skill: { name: "pdf-tools" } }));
  writeIndex(fixture, [lineOf("accepted", { historyPath: HISTORY_RELATIVE })]);

  const ledger = await readLedger(fixture.base);

  const [entry] = ledger.lines;
  assert.equal(entry.record, null);
  assert.equal(entry.problem?.endsWith("skill.realDir is undefined"), true);
  assert.equal(ledger.damaged, null);
});

// The other side of the guard, and the reason it can be narrow: a record with the whole spine resolves, so every field the
// report and the check read is one the reader handed over instead of one it refused.
test("readLedger: a record with the whole spine still resolves", async (t) => {
  const fixture = createFixture(t);
  writeRecord(fixture, HISTORY_RELATIVE, decisionRecord());
  writeIndex(fixture, [lineOf("accepted", { historyPath: HISTORY_RELATIVE })]);

  const ledger = await readLedger(fixture.base);

  const [entry] = ledger.lines;
  assert.equal(entry.problem, undefined);
  assert.equal(entry.record?.schema, DECISION_SCHEMA);
  assert.equal(entry.record?.skill.realDir, "/skills/pdf-tools");
  assert.equal(entry.record?.candidate.slug, LESSON_SLUG);
  assert.equal(entry.record?.outcome.status, "accepted");
  assert.deepEqual(entry.record?.gate, { basis: "replay", status: "not-run" });
});

// A line of a refusal that names no record is not a broken line: the attempt answered before a candidate existed, and
// the absence of a record is what the line says rather than something a reader has to explain.
test("readLedger: a line that names no record is not a problem", async (t) => {
  const fixture = createFixture(t);
  writeIndex(fixture, [lineOf("no-evidence")]);

  const ledger = await readLedger(fixture.base);

  const [entry] = ledger.lines;
  assert.equal(entry.record, null);
  assert.equal(entry.recordPath, null);
  assert.equal(entry.problem, undefined);
});

// The reader is a reader: no mkdir, no writeFile, no rename, no rm. The index and the record it names keep their
// bytes, their size and their modification time, and the state directory keeps the one file it had.
test("readLedger: the reader writes nothing", async (t) => {
  const fixture = createFixture(t);
  const historyPath = writeRecord(fixture, HISTORY_RELATIVE, decisionRecord());
  writeIndex(fixture, [lineOf("proposed"), lineOf("accepted", { historyPath: HISTORY_RELATIVE })]);

  const watched = [fixture.indexPath, historyPath];
  const before = snapshotOf(watched);
  const indexBytes = fs.readFileSync(fixture.indexPath);

  const ledger = await readLedger(fixture.base);

  assert.equal(ledger.lines.length, 2);
  assert.deepEqual(snapshotOf(watched), before);
  assert.deepEqual(fs.readFileSync(fixture.indexPath), indexBytes);
  assert.deepEqual(fs.readdirSync(stateDir(fixture.base)), [ATTEMPTS_FILE]);
});
