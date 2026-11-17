import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { attemptSignature, buildAttemptLine } from "../../src/attempts.ts";
import type { AttemptEvent } from "../../src/attempts.ts";
import { serializeLesson } from "../../src/lesson-frontmatter.ts";
import { readLedger } from "../../src/ledger.ts";
import { ATTEMPTS_FILE, CASE_BANK_FILE, DECISION_FILE, SIGNALS_FILE } from "../../src/names.ts";
import { standingOf } from "../../src/standing.ts";
import { LESSON_GATE_PROBATION } from "../../src/types.ts";
import type { DecisionRecord, LessonDraft, SkillRef } from "../../src/types.ts";
import { bankPathOf } from "../../src/observe/banks.ts";
import { discardSkillArtifacts, forgetSkill } from "../../src/observe/forget.ts";
import { withScanLock } from "../../src/observe/lock.ts";
import { foldObserveState, observeLogPath, readObserveLog } from "../../src/observe/store.ts";
import { OBSERVE_FORMAT } from "../../src/observe/types.ts";
import type { ObserveEvent } from "../../src/observe/types.ts";
import { relativeToBase, stagingDir, stateDir } from "../../src/write-base.ts";
import {
  appendAttemptLine,
  snapshotForHistory,
  upsertReferenceLine,
  writeHistoryDecision,
  writeLessonFile,
  writeStagingCandidate,
} from "../../src/writer.ts";
import { AFTER_OPT_IN_AT, FIXTURE_NOW, fixturePath, makeAgentDir, skillFixture } from "./observe-fixtures.ts";
import type { AgentDirFixture } from "./observe-fixtures.ts";

// `--forget <skill>`: what it erases (the skill's events, the signals consumed for it, the content of its candidates that
// were never accepted), what it keeps (the index of attempts, every decision.json, the accepted lessons' candidates and
// everything of other skills), that it runs under the lock and that it leaves a `forget` event behind. The missing staging
// directory and the append that lands while it rewrites are the two cases that went wrong first.

const NOW = new Date(FIXTURE_NOW);
const SKILL = "demo-skill";
const OTHER = "other-skill";
const OBSERVE_ID = (name: string): string => `${name}-id`;

function ev(fields: Record<string, unknown>): ObserveEvent {
  return { format: OBSERVE_FORMAT, at: AFTER_OPT_IN_AT, ...fields } as unknown as ObserveEvent;
}

function observeEvents(skill: string, tag: string): ObserveEvent[] {
  return [
    ev({ type: "episode", id: OBSERVE_ID(`ep-${tag}`), skill, sessionId: `s-${tag}`, startedAt: AFTER_OPT_IN_AT }),
    ev({ type: "judged", episodeId: OBSERVE_ID(`ep-${tag}`), model: "p/m", outcome: "clean" }),
    ev({ type: "observation", id: OBSERVE_ID(`ob-${tag}`), skill, sessionId: `s-${tag}`, episodeId: OBSERVE_ID(`ep-${tag}`) }),
    ev({ type: "proposal", id: OBSERVE_ID(`pr-${tag}`), skill, patternId: `pt-${tag}` }),
    ev({ type: "prepare-failed", skill, patternId: `pt-${tag}`, reason: `reason-${tag}` }),
    ev({ type: "prompt", proposalId: OBSERVE_ID(`pr-${tag}`), stage: "a", answer: "later" }),
    ev({ type: "gate-outcome", proposalId: OBSERVE_ID(`pr-${tag}`), class: "rejected", status: "gate-rejected", reason: null }),
    ev({ type: "tombstone", patternId: `pt-${tag}`, skill, reason: "user-rejected", candidateHash: null }),
  ];
}

function writeObserveLog(base: string, events: readonly ObserveEvent[]): void {
  fs.mkdirSync(stateDir(base), { recursive: true });
  fs.writeFileSync(observeLogPath(base), events.map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o644 });
}

function signalLine(event: "raised" | "consumed", id: string, skill?: string): string {
  const common = { format: "pi-simple-sri/signal@1", event, id };
  const line =
    event === "raised"
      ? { ...common, kind: "repeated-request", createdAt: AFTER_OPT_IN_AT, sessionId: "s", turnIndex: 1, subject: "x", excerpt: "x", prompt: "x" }
      : { ...common, at: AFTER_OPT_IN_AT, ...(skill === undefined ? {} : { skill }) };
  return `${JSON.stringify(line)}\n`;
}

interface Staged {
  // Relative to the base, the way the index names it.
  relative: string;
  lesson: string;
  bank: string;
  decision: string;
}

// A candidate of the skill on disk, with its lesson, its bank copy and its record.
function stage(fixture: AgentDirFixture, skill: string, stamp: string): Staged {
  const relative = path.join("staging", stamp, skill);
  const dir = path.join(fixture.base, relative);
  fs.mkdirSync(path.join(dir, "lessons"), { recursive: true });
  const staged = {
    relative,
    lesson: path.join(dir, "lessons", "a-lesson.md"),
    bank: path.join(dir, CASE_BANK_FILE),
    decision: path.join(dir, DECISION_FILE),
  };
  fs.writeFileSync(staged.lesson, "lesson text\n");
  fs.writeFileSync(staged.bank, "{}\n");
  fs.writeFileSync(staged.decision, '{"outcome":"kept"}\n');
  return staged;
}

async function index(fixture: AgentDirFixture, skill: string, event: AttemptEvent, candidate: string, relative?: string): Promise<void> {
  const hash = attemptSignature(event, skill, candidate);
  await appendAttemptLine(
    fixture.base,
    buildAttemptLine({
      now: NOW,
      event,
      targetSkill: skill,
      hashes: { candidateHash: hash, bodyHash: hash },
      failureSignature: null,
      ...(relative === undefined ? {} : { stagingPath: relative }),
    }),
  );
}

// The hash a line carries, so an `accepted` line can name the candidate of an earlier `proposed` one.
async function indexAccepted(fixture: AgentDirFixture, skill: string, proposedEvent: AttemptEvent, candidate: string): Promise<void> {
  const hash = attemptSignature(proposedEvent, skill, candidate);
  await appendAttemptLine(
    fixture.base,
    buildAttemptLine({
      now: NOW,
      event: "accepted",
      targetSkill: skill,
      hashes: { candidateHash: hash, bodyHash: hash },
      failureSignature: null,
      historyPath: `skills/${skill}/.history/x/decision.json`,
    }),
  );
}

function ready(t: TestContext): AgentDirFixture {
  return makeAgentDir(t);
}

test("forgetSkill: removes the skill's events and what hangs from them, keeps other skills' and the forget events", async (t) => {
  const fixture = ready(t);
  const priorForget = ev({ type: "forget", skill: OTHER, at: "2026-11-01T00:00:00.000Z" });
  writeObserveLog(fixture.base, [ev({ type: "opt-in" }), ...observeEvents(SKILL, "mine"), ...observeEvents(OTHER, "theirs"), priorForget]);

  const report = await forgetSkill(fixture.base, SKILL, NOW);

  assert.equal(report.status, "forgotten");
  assert.equal(report.status === "forgotten" && report.observeRemoved, 8);
  const left = await readObserveLog(fixture.base);
  assert.deepEqual(left.slice(0, 10), [ev({ type: "opt-in" }), ...observeEvents(OTHER, "theirs"), priorForget]);
  assert.equal(JSON.stringify(left.slice(0, 10)).includes("mine"), false);
});

test("forgetSkill: erases the prepare-failed events of the skill and keeps those of other skills", async (t) => {
  const fixture = ready(t);
  const failed = (skill: string, patternId: string): ObserveEvent => ev({ type: "prepare-failed", skill, patternId, reason: "bank pending" });
  writeObserveLog(fixture.base, [failed(SKILL, "pt-a"), failed(OTHER, "pt-b"), failed(SKILL, "pt-c")]);

  const report = await forgetSkill(fixture.base, SKILL, NOW);

  assert.equal(report.status === "forgotten" && report.observeRemoved, 2);
  const left = await readObserveLog(fixture.base);
  assert.deepEqual(left.slice(0, 1), [failed(OTHER, "pt-b")]);
  assert.equal(left.some((event) => event.type === "prepare-failed" && event.skill === SKILL), false);
});

test("forgetSkill: appends a forget event at `now`, and the fold then drops an older session scanned again", async (t) => {
  const fixture = ready(t);
  writeObserveLog(fixture.base, [ev({ type: "opt-in", at: "2026-11-10T00:00:00.000Z" }), ...observeEvents(SKILL, "mine")]);

  await forgetSkill(fixture.base, SKILL, NOW);

  const events = await readObserveLog(fixture.base);
  assert.deepEqual(events[events.length - 1], ev({ type: "forget", skill: SKILL, at: NOW.toISOString() }));

  const rescanned = ev({ type: "episode", id: "ep-again", skill: SKILL, sessionId: "s-mine", startedAt: AFTER_OPT_IN_AT, at: NOW.toISOString() });
  assert.deepEqual(foldObserveState([...events, rescanned], NOW).episodes, []);
});

test("forgetSkill: with no log and nothing else it still writes the forget event and reports zeros", async (t) => {
  const fixture = ready(t);

  const report = await forgetSkill(fixture.base, SKILL, NOW);

  assert.deepEqual(report, { status: "forgotten", observeRemoved: 0, signalsRemoved: 0, stagingErased: [], stagingMissing: true, ...ZERO_EXTRAS });
  assert.deepEqual(await readObserveLog(fixture.base), [ev({ type: "forget", skill: SKILL, at: NOW.toISOString() })]);
  assert.equal(fs.statSync(observeLogPath(fixture.base)).mode & 0o777, 0o600);
});

test("forgetSkill: a log with nothing of the skill is not rewritten", async (t) => {
  const fixture = ready(t);
  const events = [ev({ type: "opt-in" }), ...observeEvents(OTHER, "theirs")];
  writeObserveLog(fixture.base, events);
  const before = fs.readFileSync(observeLogPath(fixture.base), "utf8");

  await forgetSkill(fixture.base, SKILL, NOW);

  const after = fs.readFileSync(observeLogPath(fixture.base), "utf8");
  assert.equal(after.startsWith(before), true);
  const appended = after.slice(before.length);
  assert.equal(appended.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(appended), ev({ type: "forget", skill: SKILL, at: NOW.toISOString() }));
});

test("forgetSkill: drops every line of the signals consumed for the skill, keeps the rest, and the file ends up 0600 in its order", async (t) => {
  const fixture = ready(t);
  const signalsPath = path.join(stateDir(fixture.base), SIGNALS_FILE);
  fs.mkdirSync(path.dirname(signalsPath), { recursive: true });
  fs.writeFileSync(
    signalsPath,
    [
      signalLine("raised", "sg-mine"),
      signalLine("raised", "sg-theirs"),
      signalLine("raised", "sg-open"),
      signalLine("consumed", "sg-mine", SKILL),
      signalLine("consumed", "sg-theirs", OTHER),
      signalLine("consumed", "sg-anon"),
    ].join(""),
    { mode: 0o644 },
  );

  const report = await forgetSkill(fixture.base, SKILL, NOW);

  assert.equal(report.status === "forgotten" && report.signalsRemoved, 2);
  assert.equal(
    fs.readFileSync(signalsPath, "utf8"),
    [signalLine("raised", "sg-theirs"), signalLine("raised", "sg-open"), signalLine("consumed", "sg-theirs", OTHER), signalLine("consumed", "sg-anon")].join(""),
  );
  assert.equal(fs.statSync(signalsPath).mode & 0o777, 0o600);
});

test("forgetSkill: erases the lesson and the bank copy of a candidate nobody accepted and keeps its decision.json", async (t) => {
  const fixture = ready(t);
  const rejected = stage(fixture, SKILL, "20261101T000000000Z");
  const theirs = stage(fixture, OTHER, "20261102T000000000Z");
  await index(fixture, SKILL, "gate-rejected", "rejected", rejected.relative);
  await index(fixture, OTHER, "gate-rejected", "theirs", theirs.relative);

  const report = await forgetSkill(fixture.base, SKILL, NOW);

  assert.deepEqual(report.status === "forgotten" && report.stagingErased, [
    path.join(rejected.relative, CASE_BANK_FILE),
    path.join(rejected.relative, "lessons", "a-lesson.md"),
  ]);
  assert.equal(report.status === "forgotten" && report.stagingMissing, false);
  assert.equal(fs.existsSync(rejected.lesson), false);
  assert.equal(fs.existsSync(rejected.bank), false);
  assert.equal(fs.readFileSync(rejected.decision, "utf8"), '{"outcome":"kept"}\n');
  for (const file of [theirs.lesson, theirs.bank, theirs.decision]) assert.equal(fs.existsSync(file), true);
});

test("forgetSkill: a candidate that was accepted keeps its lesson and decision.json but loses its bank copy, the way its `accepted` line joins its `proposed` one", async (t) => {
  const fixture = ready(t);
  const accepted = stage(fixture, SKILL, "20261101T000000000Z");
  await index(fixture, SKILL, "proposed", "kept", accepted.relative);
  await indexAccepted(fixture, SKILL, "proposed", "kept");

  const report = await forgetSkill(fixture.base, SKILL, NOW);

  assert.deepEqual(report.status === "forgotten" && report.stagingErased, [path.join(accepted.relative, CASE_BANK_FILE)]);
  assert.equal(fs.existsSync(accepted.lesson), true);
  assert.equal(fs.existsSync(accepted.bank), false);
  assert.equal(fs.existsSync(accepted.decision), true);
});

test("forgetSkill: keeps attempts.jsonl byte for byte", async (t) => {
  const fixture = ready(t);
  const staged = stage(fixture, SKILL, "20261101T000000000Z");
  await index(fixture, SKILL, "gate-rejected", "rejected", staged.relative);
  const attemptsPath = path.join(stateDir(fixture.base), ATTEMPTS_FILE);
  const before = fs.readFileSync(attemptsPath);

  await forgetSkill(fixture.base, SKILL, NOW);

  assert.deepEqual(fs.readFileSync(attemptsPath), before);
});

test("forgetSkill: with no staging directory at all it does not throw, and says so", async (t) => {
  const fixture = ready(t);
  // The index names a candidate, but the base never had a staging directory (or it was cleaned by hand).
  await index(fixture, SKILL, "gate-rejected", "rejected", path.join("staging", "20261101T000000000Z", SKILL));
  writeObserveLog(fixture.base, observeEvents(SKILL, "mine"));
  assert.equal(fs.existsSync(stagingDir(fixture.base)), false);

  const report = await forgetSkill(fixture.base, SKILL, NOW);

  assert.deepEqual(report, { status: "forgotten", observeRemoved: 8, signalsRemoved: 0, stagingErased: [], stagingMissing: true, ...ZERO_EXTRAS });
  assert.equal(fs.existsSync(stagingDir(fixture.base)), false);
});

test("forgetSkill: a candidate the index names whose directory is gone is skipped, the staging directory exists", async (t) => {
  const fixture = ready(t);
  fs.mkdirSync(stagingDir(fixture.base), { recursive: true });
  await index(fixture, SKILL, "gate-rejected", "rejected", path.join("staging", "20261101T000000000Z", SKILL));

  const report = await forgetSkill(fixture.base, SKILL, NOW);

  assert.deepEqual(report.status === "forgotten" && report.stagingErased, []);
  assert.equal(report.status === "forgotten" && report.stagingMissing, false);
});

test("forgetSkill: an append that lands while it rewrites survives if it is another skill's and goes if it is the skill's", async (t) => {
  const fixture = ready(t);
  writeObserveLog(fixture.base, [ev({ type: "opt-in" }), ...observeEvents(SKILL, "mine")]);
  const logPath = observeLogPath(fixture.base);
  const late = [ev({ type: "episode", id: "ep-late-theirs", skill: OTHER, sessionId: "s", startedAt: AFTER_OPT_IN_AT }), ev({ type: "episode", id: "ep-late-mine", skill: SKILL, sessionId: "s", startedAt: AFTER_OPT_IN_AT })];

  // The first read of the log is followed by the append of another process of pi.
  const original = fs.promises.readFile.bind(fs.promises);
  const descriptor = Object.getOwnPropertyDescriptor(fs.promises, "readFile");
  let injected = false;
  const stub = async (file: unknown, ...rest: unknown[]): Promise<unknown> => {
    const result = await (original as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    if (!injected && file === logPath) {
      injected = true;
      fs.appendFileSync(logPath, late.map((event) => `${JSON.stringify(event)}\n`).join(""));
    }
    return result;
  };
  t.after(() => {
    if (descriptor) Object.defineProperty(fs.promises, "readFile", descriptor);
  });
  Object.defineProperty(fs.promises, "readFile", { configurable: true, writable: true, value: stub });

  await forgetSkill(fixture.base, SKILL, NOW);

  assert.equal(injected, true);
  const ids = (await readObserveLog(fixture.base)).flatMap((event) => (event.type === "episode" ? [event.id] : []));
  assert.deepEqual(ids, ["ep-late-theirs"]);
});

test("forgetSkill: while the lock is held it answers `locked` and touches nothing", async (t) => {
  const fixture = ready(t);
  writeObserveLog(fixture.base, observeEvents(SKILL, "mine"));
  const before = fs.readFileSync(observeLogPath(fixture.base), "utf8");

  const held = await withScanLock(fixture.base, () => forgetSkill(fixture.base, SKILL, NOW));

  assert.deepEqual(held, { ok: true, value: { status: "locked" } });
  assert.equal(fs.readFileSync(observeLogPath(fixture.base), "utf8"), before);
});

test("forgetSkill: releases the lock when it is done", async (t) => {
  const fixture = ready(t);

  await forgetSkill(fixture.base, SKILL, NOW);

  assert.equal((await withScanLock(fixture.base, async () => "free")).ok, true);
});

const ZERO_EXTRAS = { banksRemoved: [], banksKept: [], draftsRemoved: 0, runsRemoved: 0, recordsCleared: 0, historySkipped: [] };

function putBank(fixture: AgentDirFixture, skill: string, name: string): string {
  const target = bankPathOf(fixture.base, skill);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(fixturePath("banks", name), target);
  return target;
}

function putDraft(fixture: AgentDirFixture, dirName: string): string {
  const dir = path.join(stagingDir(fixture.base), "observer-banks", dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, CASE_BANK_FILE), "{}\n");
  return dir;
}

function putRuns(staged: Staged, fixture: AgentDirFixture, names: string[]): string {
  const runs = path.join(fixture.base, staged.relative, "gate", "runs");
  fs.mkdirSync(runs, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(runs, name), "{}\n");
  return runs;
}

function decisionWithFocus(focus: string | null): string {
  return `${JSON.stringify({ format: "pi-simple-sri/decision@1", outcome: "kept", trigger: { surface: "observer", focus }, candidate: { slug: "a-lesson" } }, null, 2)}\n`;
}

test("forgetSkill: removes the generated-bank drafts of the skill and only its own, whole-name", async (t) => {
  const fixture = ready(t);
  const own = putDraft(fixture, `${SKILL}-0123456789ab`);
  const prefixed = putDraft(fixture, `${SKILL}-extra-0123456789ab`);
  const theirs = putDraft(fixture, `${OTHER}-0123456789ab`);

  const report = await forgetSkill(fixture.base, SKILL, NOW);

  assert.equal(report.status === "forgotten" && report.draftsRemoved, 1);
  assert.equal(fs.existsSync(own), false);
  assert.equal(fs.existsSync(prefixed), true);
  assert.equal(fs.existsSync(theirs), true);
});

test("forgetSkill: removes the raw runs of the candidates of the skill, accepted or not, and keeps those of other skills", async (t) => {
  const fixture = ready(t);
  const rejected = stage(fixture, SKILL, "20261101T000000000Z");
  const accepted = stage(fixture, SKILL, "20261102T000000000Z");
  const theirs = stage(fixture, OTHER, "20261103T000000000Z");
  const rejectedRuns = putRuns(rejected, fixture, ["1-1-base.jsonl", "1-1-candidate.jsonl"]);
  const acceptedRuns = putRuns(accepted, fixture, ["1-1-base.jsonl"]);
  const theirRuns = putRuns(theirs, fixture, ["1-1-base.jsonl"]);
  await index(fixture, SKILL, "gate-rejected", "rejected", rejected.relative);
  await index(fixture, SKILL, "proposed", "kept", accepted.relative);
  await indexAccepted(fixture, SKILL, "proposed", "kept");
  await index(fixture, OTHER, "gate-rejected", "theirs", theirs.relative);

  const report = await forgetSkill(fixture.base, SKILL, NOW);

  assert.equal(report.status === "forgotten" && report.runsRemoved, 3);
  assert.equal(fs.existsSync(rejectedRuns), false);
  assert.equal(fs.existsSync(acceptedRuns), false);
  assert.equal(fs.existsSync(theirRuns), true);
  assert.equal(fs.existsSync(rejected.decision), true);
});

test("forgetSkill: nulls trigger.focus in the decision.json of every candidate of the skill and touches nothing else, nor other skills", async (t) => {
  const fixture = ready(t);
  const rejected = stage(fixture, SKILL, "20261101T000000000Z");
  const accepted = stage(fixture, SKILL, "20261102T000000000Z");
  const theirs = stage(fixture, OTHER, "20261103T000000000Z");
  for (const staged of [rejected, accepted, theirs]) fs.writeFileSync(staged.decision, decisionWithFocus("the user keeps asking for headers"));
  await index(fixture, SKILL, "gate-rejected", "rejected", rejected.relative);
  await index(fixture, SKILL, "proposed", "kept", accepted.relative);
  await indexAccepted(fixture, SKILL, "proposed", "kept");
  await index(fixture, OTHER, "gate-rejected", "theirs", theirs.relative);

  const report = await forgetSkill(fixture.base, SKILL, NOW);

  assert.equal(report.status === "forgotten" && report.recordsCleared, 2);
  for (const staged of [rejected, accepted]) {
    assert.equal(fs.readFileSync(staged.decision, "utf8"), decisionWithFocus(null));
  }
  assert.equal(fs.readFileSync(theirs.decision, "utf8"), decisionWithFocus("the user keeps asking for headers"));
});

test("forgetSkill: a decision.json that is not JSON or has no focus is left as it is", async (t) => {
  const fixture = ready(t);
  const broken = stage(fixture, SKILL, "20261101T000000000Z");
  const unfocused = stage(fixture, SKILL, "20261102T000000000Z");
  fs.writeFileSync(broken.decision, "{ not json");
  fs.writeFileSync(unfocused.decision, decisionWithFocus(null));
  await index(fixture, SKILL, "gate-rejected", "broken", broken.relative);
  await index(fixture, SKILL, "gate-rejected", "unfocused", unfocused.relative);

  await forgetSkill(fixture.base, SKILL, NOW);

  assert.equal(fs.readFileSync(broken.decision, "utf8"), "{ not json");
  assert.equal(fs.readFileSync(unfocused.decision, "utf8"), decisionWithFocus(null));
});

test("forgetSkill: removes the bank the observer generated, keeps the one the user wrote, and reports both", async (t) => {
  const generated = ready(t);
  const auto = putBank(generated, SKILL, "auto.json");
  const report = await forgetSkill(generated.base, SKILL, NOW);
  assert.deepEqual(report.status === "forgotten" && report.banksRemoved, [path.join("banks", `${SKILL}.json`)]);
  assert.deepEqual(report.status === "forgotten" && report.banksKept, []);
  assert.equal(fs.existsSync(auto), false);

  const own = ready(t);
  const user = putBank(own, SKILL, "user.json");
  const kept = await forgetSkill(own.base, SKILL, NOW);
  assert.deepEqual(kept.status === "forgotten" && kept.banksRemoved, []);
  assert.deepEqual(kept.status === "forgotten" && kept.banksKept, [path.join("banks", `${SKILL}.json`)]);
  assert.equal(fs.existsSync(user), true);
});

test("forgetSkill: a bank that cannot be read is kept and reported, never removed", async (t) => {
  const fixture = ready(t);
  const bank = bankPathOf(fixture.base, SKILL);
  fs.mkdirSync(path.dirname(bank), { recursive: true });
  fs.writeFileSync(bank, "{ not json");

  const report = await forgetSkill(fixture.base, SKILL, NOW);

  assert.deepEqual(report.status === "forgotten" && report.banksKept, [path.join("banks", `${SKILL}.json`)]);
  assert.equal(fs.readFileSync(bank, "utf8"), "{ not json");
});

test("forgetSkill: the auto bank of another skill stays", async (t) => {
  const fixture = ready(t);
  const theirs = putBank(fixture, OTHER, "auto.json");

  await forgetSkill(fixture.base, SKILL, NOW);

  assert.equal(fs.existsSync(theirs), true);
});

test("forgetSkill: with staging but no observer-banks, no banks directory and no runs it reports zeros and does not create them", async (t) => {
  const fixture = ready(t);
  fs.mkdirSync(stagingDir(fixture.base), { recursive: true });
  const rejected = stage(fixture, SKILL, "20261101T000000000Z");
  await index(fixture, SKILL, "gate-rejected", "rejected", rejected.relative);

  const report = await forgetSkill(fixture.base, SKILL, NOW);

  assert.equal(report.status === "forgotten" && report.draftsRemoved, 0);
  assert.equal(report.status === "forgotten" && report.runsRemoved, 0);
  assert.deepEqual(report.status === "forgotten" && report.banksRemoved, []);
  assert.equal(fs.existsSync(path.join(stagingDir(fixture.base), "observer-banks")), false);
  assert.equal(fs.existsSync(path.join(fixture.base, "banks")), false);
});

test("discardSkillArtifacts: erases drafts, unaccepted content, runs and the auto bank, and reports them, without touching the logs", async (t) => {
  const fixture = ready(t);
  writeObserveLog(fixture.base, [ev({ type: "opt-in" }), ...observeEvents(SKILL, "mine")]);
  const signalsPath = path.join(stateDir(fixture.base), SIGNALS_FILE);
  fs.writeFileSync(signalsPath, [signalLine("raised", "sg-mine"), signalLine("consumed", "sg-mine", SKILL)].join(""));
  const logBefore = fs.readFileSync(observeLogPath(fixture.base));
  const signalsBefore = fs.readFileSync(signalsPath);
  const draft = putDraft(fixture, `${SKILL}-0123456789ab`);
  const rejected = stage(fixture, SKILL, "20261101T000000000Z");
  const runs = putRuns(rejected, fixture, ["1-1-base.jsonl"]);
  fs.writeFileSync(rejected.decision, decisionWithFocus("focus"));
  await index(fixture, SKILL, "gate-rejected", "rejected", rejected.relative);
  const auto = putBank(fixture, SKILL, "auto.json");

  const report = await discardSkillArtifacts(fixture.base, SKILL);

  assert.deepEqual(report, {
    draftsRemoved: 1,
    runsRemoved: 1,
    stagingErased: [path.join(rejected.relative, CASE_BANK_FILE), path.join(rejected.relative, "lessons", "a-lesson.md")],
    banksRemoved: [path.join("banks", `${SKILL}.json`)],
    banksKept: [],
    recordsCleared: 1,
    historySkipped: [],
  });
  for (const gone of [draft, runs, rejected.lesson, rejected.bank, auto]) assert.equal(fs.existsSync(gone), false, gone);
  assert.equal(fs.readFileSync(rejected.decision, "utf8"), decisionWithFocus(null));
  assert.deepEqual(fs.readFileSync(observeLogPath(fixture.base)), logBefore, "no event is rewritten or appended");
  assert.deepEqual(fs.readFileSync(signalsPath), signalsBefore);
});

test("discardSkillArtifacts: keeps an accepted candidate's lesson and a user bank, erases its bank copy, and runs while the scan lock is held", async (t) => {
  const fixture = ready(t);
  const accepted = stage(fixture, SKILL, "20261102T000000000Z");
  await index(fixture, SKILL, "proposed", "kept", accepted.relative);
  await indexAccepted(fixture, SKILL, "proposed", "kept");
  const rejected = stage(fixture, SKILL, "20261101T000000000Z");
  await index(fixture, SKILL, "gate-rejected", "rejected", rejected.relative);
  const user = putBank(fixture, SKILL, "user.json");

  const held = await withScanLock(fixture.base, () => discardSkillArtifacts(fixture.base, SKILL));

  assert.equal(held.ok, true);
  assert.deepEqual(held.ok && held.value.banksKept, [path.join("banks", `${SKILL}.json`)]);
  assert.equal(fs.existsSync(rejected.lesson), false);
  assert.equal(fs.existsSync(accepted.lesson), true);
  assert.equal(fs.existsSync(accepted.bank), false);
  assert.equal(fs.existsSync(user), true);
});

test("forgetSkill: a signal consumed for the skill that lands while the file is rewritten is erased with the rest", async (t) => {
  const fixture = ready(t);
  const signalsPath = path.join(stateDir(fixture.base), SIGNALS_FILE);
  fs.mkdirSync(path.dirname(signalsPath), { recursive: true });
  fs.writeFileSync(signalsPath, [signalLine("raised", "sg-late"), signalLine("raised", "sg-kept")].join(""), { mode: 0o644 });

  const original = fs.promises.readFile.bind(fs.promises);
  const descriptor = Object.getOwnPropertyDescriptor(fs.promises, "readFile");
  let injected = false;
  const stub = async (file: unknown, ...rest: unknown[]): Promise<unknown> => {
    const result = await (original as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    if (!injected && file === signalsPath) {
      injected = true;
      fs.appendFileSync(signalsPath, signalLine("consumed", "sg-late", SKILL));
    }
    return result;
  };
  t.after(() => {
    if (descriptor) Object.defineProperty(fs.promises, "readFile", descriptor);
  });
  Object.defineProperty(fs.promises, "readFile", { configurable: true, writable: true, value: stub });

  const report = await forgetSkill(fixture.base, SKILL, NOW);

  assert.equal(injected, true);
  assert.equal(report.status === "forgotten" && report.signalsRemoved, 2);
  assert.equal(fs.readFileSync(signalsPath, "utf8"), signalLine("raised", "sg-kept"));
});

// The pattern leaks through every copy of the focus: trigger.focus, the diagnosis that quotes it, in the staged record and in the
// record of the acceptance inside the skill. The real writer builds the tree and the real ledger and standing read it back.
const SENTINEL = "zq7-sentinel-handwriting";
const FOCUS = `the user keeps asking for ${SENTINEL} notes`;
const LESSON_SLUG = "answer-in-prose";
const HISTORY_TS = "20261116T181135226Z";

interface AcceptedLesson {
  realDir: string;
  staged: { stagingPath: string; decisionPath: string };
  historyRecord: string;
}

// An accepted probation lesson of `skill`: staged candidate, snapshot, lesson in the skill with its reference line, the record of the
// acceptance, the two lines of the index and an observation of the observer that quotes the focus. `historyAt` places the record
// of the acceptance somewhere else than <skill>/.history, where the index then names it.
async function acceptLesson(fixture: AgentDirFixture, skill: string, historyAt?: (realDir: string) => string): Promise<AcceptedLesson> {
  const dir = skillFixture(fixture.skillsDir, skill, { "SKILL.md": `---\nname: ${skill}\ndescription: d\n---\n\n# ${skill}\n` });
  const realDir = fs.realpathSync(dir);
  const ref: SkillRef = { name: skill, description: "d", dir, realDir, hasLessons: false, kind: "declared" };
  const draft: LessonDraft = {
    slug: LESSON_SLUG,
    title: "Answer in prose",
    date: "2026-11-16",
    status: "accepted",
    sourceEvidence: [],
    gate: LESSON_GATE_PROBATION,
    body: "Answer in prose only.",
  };
  const serialized = serializeLesson(draft);
  assert.equal(serialized.ok, true);
  const lessonText = serialized.ok ? serialized.value : "";

  const decision: DecisionRecord = {
    schema: "pi-simple-sri/decision@1",
    createdAt: NOW.toISOString(),
    trigger: { surface: "observer", focus: FOCUS },
    skill: { name: skill, dir, realDir, wasSymlink: false, eligible: true },
    eligibility: { allow: [], deny: ["system-config"] },
    evidence: [],
    diagnosis: {
      summary: `Directional improvement of skill "${skill}": the focus asked for was "${FOCUS}".`,
      failureSignature: `sha256:${"a".repeat(64)}`,
      replayItems: [],
    },
    candidate: {
      kind: "new-lesson",
      slug: LESSON_SLUG,
      title: draft.title,
      targetLesson: null,
      lessonPath: `lessons/${LESSON_SLUG}.md`,
      contentHash: `sha256:${"b".repeat(64)}`,
      bodyHash: `sha256:${"c".repeat(64)}`,
    },
    gate: {
      basis: "replay",
      status: "probation",
      budget: { plannedRuns: 0, usedRuns: 0, interruptedAt: null },
      tokens: {
        proposal: { input: 0, output: 0 },
        incumbent: { input: 0, output: 0 },
        candidate: { input: 0, output: 0 },
        total: { input: 0, output: 0 },
      },
      preregistration: null,
      replay: null,
      probation: { recordedAt: NOW.toISOString(), skillContentHash: `sha256:${"d".repeat(64)}` },
    },
    outcome: { status: "probation", reason: null, decidedAt: null },
  };

  const staged = await writeStagingCandidate({ base: fixture.base, skill: ref, slug: LESSON_SLUG, decision, now: NOW, lessonText });
  const hashes = { candidateHash: staged.contentHash, bodyHash: staged.bodyHash };

  await snapshotForHistory(realDir, HISTORY_TS);
  await writeLessonFile(realDir, LESSON_SLUG, lessonText, staged.contentHash);
  await upsertReferenceLine(realDir, LESSON_SLUG, draft.title);
  const accepted: DecisionRecord = {
    ...decision,
    candidate: { ...decision.candidate, contentHash: staged.contentHash, bodyHash: staged.bodyHash },
    outcome: { status: "accepted", reason: null, decidedAt: NOW.toISOString() },
  };
  let historyRecord = await writeHistoryDecision(realDir, HISTORY_TS, accepted);
  if (historyAt !== undefined) {
    const elsewhere = historyAt(realDir);
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.copyFileSync(historyRecord, elsewhere);
    historyRecord = elsewhere;
  }

  await appendAttemptLine(
    fixture.base,
    buildAttemptLine({
      now: NOW,
      event: "proposed",
      targetSkill: skill,
      hashes,
      failureSignature: null,
      stagingPath: relativeToBase(fixture.base, staged.stagingPath),
      decisionPath: relativeToBase(fixture.base, staged.decisionPath),
    }),
  );
  await appendAttemptLine(
    fixture.base,
    buildAttemptLine({ now: NOW, event: "accepted", targetSkill: skill, hashes, failureSignature: null, historyPath: relativeToBase(fixture.base, historyRecord) }),
  );
  writeObserveLog(fixture.base, [
    ev({ type: "opt-in" }),
    ev({ type: "observation", id: "ob-1", skill, sessionId: "s-1", episodeId: "ep-1", summary: FOCUS }),
  ]);

  return { realDir, staged, historyRecord };
}

function filesContaining(root: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && fs.readFileSync(full, "utf8").includes(needle)) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

test("forgetSkill: an accepted probation lesson stays intact for --verify and no file of the tree keeps the focus", async (t) => {
  const fixture = ready(t);
  const lesson = await acceptLesson(fixture, SKILL);
  const intact = [{ skill: SKILL, worst: "intact", lessons: 1 }];
  const before = await standingOf(await readLedger(fixture.base));
  assert.deepEqual(before.skills, intact);
  assert.equal(before.missingRecords, 0);
  assert.deepEqual(
    filesContaining(fixture.root, SENTINEL),
    [lesson.historyRecord, lesson.staged.decisionPath, observeLogPath(fixture.base)].sort(),
    "the sentinel is in every copy of the focus before the forget",
  );
  const historyBefore = JSON.parse(fs.readFileSync(lesson.historyRecord, "utf8")) as DecisionRecord;

  const report = await forgetSkill(fixture.base, SKILL, NOW);

  assert.equal(report.status, "forgotten");
  assert.deepEqual(filesContaining(fixture.root, SENTINEL), []);
  const after = await standingOf(await readLedger(fixture.base));
  assert.deepEqual(after.skills, intact);
  assert.equal(after.missingRecords, 0);
  assert.equal(after.checks[0]?.referenced, true);
  assert.equal(after.checks[0]?.standing, "intact");
  const historyAfter: unknown = JSON.parse(fs.readFileSync(lesson.historyRecord, "utf8"));
  assert.deepEqual(historyAfter, {
    ...historyBefore,
    trigger: { ...historyBefore.trigger, focus: null },
    diagnosis: { ...historyBefore.diagnosis, summary: null },
  });
});

test("forgetSkill: the record of the acceptance is cleared even when staging is gone", async (t) => {
  const fixture = ready(t);
  const lesson = await acceptLesson(fixture, SKILL);
  fs.rmSync(stagingDir(fixture.base), { recursive: true, force: true });

  await forgetSkill(fixture.base, SKILL, NOW);

  assert.deepEqual(filesContaining(fixture.root, SENTINEL), []);
  assert.equal((await standingOf(await readLedger(fixture.base))).skills[0]?.worst, "intact");
  assert.equal(fs.existsSync(lesson.historyRecord), true);
});

test("forgetSkill: the accepted record of another skill keeps its focus", async (t) => {
  const fixture = ready(t);
  const mine = await acceptLesson(fixture, SKILL);
  const theirs = await acceptLesson(fixture, OTHER);

  await forgetSkill(fixture.base, SKILL, NOW);

  // The log written last is the other skill's: its observation is theirs and stays.
  assert.deepEqual(filesContaining(fixture.root, SENTINEL), [theirs.historyRecord, theirs.staged.decisionPath, observeLogPath(fixture.base)].sort());
  assert.equal(fs.readFileSync(theirs.historyRecord, "utf8").includes(FOCUS), true);
  assert.equal(fs.readFileSync(mine.historyRecord, "utf8").includes(SENTINEL), false);
});

// A record that cannot be cleared is reported and never thrown: the forget event, the logs and the staging still go.
async function assertForgottenWithSkipped(fixture: AgentDirFixture, skipped: string[], recordsCleared: number): Promise<void> {
  const report = await forgetSkill(fixture.base, SKILL, NOW);
  assert.equal(report.status, "forgotten");
  assert.deepEqual(report.status === "forgotten" && report.historySkipped, skipped);
  assert.equal(report.status === "forgotten" && report.recordsCleared, recordsCleared);

  const events = await readObserveLog(fixture.base);
  assert.deepEqual(events[events.length - 1], ev({ type: "forget", skill: SKILL, at: NOW.toISOString() }));
  assert.equal(JSON.stringify(events).includes(SENTINEL), false, "the observe log is rewritten");

  const rescanned = ev({ type: "episode", id: "ep-again", skill: SKILL, sessionId: "s-1", startedAt: AFTER_OPT_IN_AT, at: NOW.toISOString() });
  assert.deepEqual(foldObserveState([...events, rescanned], NOW).episodes, [], "a rescanned older session does not bring the skill back");

  assert.equal((await withScanLock(fixture.base, async () => "free")).ok, true, "the lock is released");
}

test("forgetSkill: an acceptance whose record the index places outside the history of the skill is reported, not thrown, and the file is untouched", async (t) => {
  const fixture = ready(t);
  const lesson = await acceptLesson(fixture, SKILL, (realDir) => path.join(realDir, "lessons", DECISION_FILE));
  const before = fs.readFileSync(lesson.historyRecord, "utf8");

  await assertForgottenWithSkipped(fixture, [lesson.historyRecord], 1);

  assert.equal(fs.readFileSync(lesson.historyRecord, "utf8"), before, "a path outside .history is never followed");
  assert.equal(fs.readFileSync(lesson.staged.decisionPath, "utf8").includes(SENTINEL), false);

  await assertForgottenWithSkipped(fixture, [lesson.historyRecord], 0);
});

test("forgetSkill: an acceptance whose skill directory moved is reported, and the rest of the forget completes twice", async (t) => {
  const fixture = ready(t);
  const lesson = await acceptLesson(fixture, SKILL);
  fs.renameSync(lesson.realDir, path.join(fixture.root, "moved-skill"));

  await assertForgottenWithSkipped(fixture, [lesson.historyRecord], 1);
  await assertForgottenWithSkipped(fixture, [lesson.historyRecord], 0);
});

test("forgetSkill: an acceptance whose .history is gone is reported as skipped", async (t) => {
  const fixture = ready(t);
  const lesson = await acceptLesson(fixture, SKILL);
  fs.rmSync(path.join(lesson.realDir, ".history"), { recursive: true, force: true });

  await assertForgottenWithSkipped(fixture, [lesson.historyRecord], 1);
});

test("forgetSkill: a bank-gated accepted candidate keeps no file with the prompts: bank copy, gate runs, logs and records are clean", async (t) => {
  const fixture = ready(t);
  const lesson = await acceptLesson(fixture, SKILL);
  const candidateDir = path.dirname(lesson.staged.decisionPath);
  const bankCopy = path.join(candidateDir, CASE_BANK_FILE);
  const runs = path.join(candidateDir, "gate", "runs");
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(bankCopy, JSON.stringify({ items: [{ prompt: `please write ${SENTINEL}` }] }));
  fs.writeFileSync(path.join(runs, "1-1-base.jsonl"), `${JSON.stringify({ transcript: SENTINEL })}\n`);
  const signalsPath = path.join(stateDir(fixture.base), SIGNALS_FILE);
  fs.writeFileSync(
    signalsPath,
    [
      JSON.stringify({ format: "pi-simple-sri/signal@1", event: "raised", id: "sg-1", kind: "repeated-request", createdAt: AFTER_OPT_IN_AT, sessionId: "s", turnIndex: 1, subject: "x", excerpt: SENTINEL, prompt: SENTINEL }),
      JSON.stringify({ format: "pi-simple-sri/signal@1", event: "consumed", id: "sg-1", at: AFTER_OPT_IN_AT, skill: SKILL }),
    ].join("\n") + "\n",
  );
  assert.deepEqual(
    filesContaining(fixture.root, SENTINEL),
    [bankCopy, path.join(runs, "1-1-base.jsonl"), lesson.historyRecord, lesson.staged.decisionPath, observeLogPath(fixture.base), signalsPath].sort(),
  );

  const report = await forgetSkill(fixture.base, SKILL, NOW);

  assert.equal(report.status === "forgotten" && report.runsRemoved, 1);
  assert.deepEqual(filesContaining(fixture.root, SENTINEL), []);
  assert.equal(fs.existsSync(lesson.staged.decisionPath), true);
  assert.equal(fs.existsSync(path.join(candidateDir, "lessons", `${LESSON_SLUG}.md`)), true);
  assert.equal((await standingOf(await readLedger(fixture.base))).skills[0]?.worst, "intact");
});

test("forgetSkill: writes the forget event before it touches anything else", async (t) => {
  const fixture = ready(t);
  const lesson = await acceptLesson(fixture, SKILL);
  const logPath = observeLogPath(fixture.base);

  // The first read of the log (the rewrite) already finds the forget event: it was appended before.
  const original = fs.promises.readFile.bind(fs.promises);
  const descriptor = Object.getOwnPropertyDescriptor(fs.promises, "readFile");
  let seenAtFirstRead = null as string | null;
  const stub = async (file: unknown, ...rest: unknown[]): Promise<unknown> => {
    if (seenAtFirstRead === null && file === logPath) seenAtFirstRead = fs.readFileSync(logPath, "utf8");
    return await (original as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
  };
  t.after(() => {
    if (descriptor) Object.defineProperty(fs.promises, "readFile", descriptor);
  });
  Object.defineProperty(fs.promises, "readFile", { configurable: true, writable: true, value: stub });

  await forgetSkill(fixture.base, SKILL, NOW);

  assert.equal((seenAtFirstRead ?? "").includes('"type":"forget"'), true);
  assert.equal(fs.readFileSync(lesson.staged.decisionPath, "utf8").includes(SENTINEL), false);
});
