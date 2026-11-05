import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ATTEMPT_EVENTS,
  RESERVED_ATTEMPT_EVENTS,
  attemptHashes,
  attemptSignature,
  buildAttemptLine,
  isAttemptEvent,
  isKnownAttemptEvent,
  type ReservedAttemptEvent,
} from "../../src/attempts.ts";
import { ATTEMPTS_FILE } from "../../src/names.ts";
import { stateDir } from "../../src/write-base.ts";
import { appendAttemptLine } from "../../src/writer.ts";

// The index of attempts (Q14): the vocabulary it can emit, the vocabulary it recognizes without emitting,
// the hashes that group the runs of one attempt, and the line the two writers of the index -- the propose
// flow and the gate flow -- build from the same function. The last test of the suite appends two of those
// lines through the real writer, so the line and the file it lands in are proved together.

const NOW = new Date("2026-11-02T14:03:22.481Z");
const SIGNATURE = `sha256:${"c".repeat(64)}`;
const CANDIDATE_HASH = `sha256:${"a".repeat(64)}`;
const BODY_HASH = `sha256:${"b".repeat(64)}`;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const STAGING_PATH = "staging/20261102T140322481Z/pdf-tools";
const DECISION_PATH = `${STAGING_PATH}/decision.json`;
const HISTORY_PATH = "skills/pdf-tools/.history/20261103T090000000Z/decision.json";

// OA4: a line that has a failure names it. The gate events are the ones that reach this with a diagnosis;
// the refusal events of the propose flow carry null, and the test below proves the null is written.
test("buildAttemptLine: a line with a diagnosis carries its failureSignature", () => {
  const line = buildAttemptLine({
    now: NOW,
    event: "gate-rejected",
    targetSkill: "pdf-tools",
    hashes: { candidateHash: CANDIDATE_HASH, bodyHash: BODY_HASH },
    failureSignature: SIGNATURE,
    stagingPath: STAGING_PATH,
    decisionPath: DECISION_PATH,
  });

  assert.deepEqual(line, {
    ts: NOW.toISOString(),
    event: "gate-rejected",
    candidateHash: CANDIDATE_HASH,
    bodyHash: BODY_HASH,
    failureSignature: SIGNATURE,
    targetSkill: "pdf-tools",
    stagingPath: STAGING_PATH,
    decisionPath: DECISION_PATH,
  });
});

// The other half of OA4: an attempt that never reached a diagnosis says so with an explicit null, and the
// paths it never had are left out of the line instead of being written as undefined.
test("buildAttemptLine: a refusal without a diagnosis keeps failureSignature null and no paths", () => {
  const line = buildAttemptLine({
    now: NOW,
    event: "no-model",
    targetSkill: "pdf-tools",
    hashes: attemptHashes("no-model", "pdf-tools", undefined),
    failureSignature: null,
  });

  assert.equal(Object.hasOwn(line, "failureSignature"), true);
  assert.equal(line.failureSignature, null);
  assert.equal(Object.hasOwn(line, "stagingPath"), false);
  assert.equal(Object.hasOwn(line, "decisionPath"), false);
  assert.equal(Object.hasOwn(line, "historyPath"), false);
});

// The acceptance is the only event that wrote a skill, and it is the only one that points at the snapshot
// holding the authoritative record.
test("buildAttemptLine: the line of an accepted candidate carries the history path", () => {
  const line = buildAttemptLine({
    now: NOW,
    event: "accepted",
    targetSkill: "pdf-tools",
    hashes: { candidateHash: CANDIDATE_HASH, bodyHash: BODY_HASH },
    failureSignature: SIGNATURE,
    historyPath: HISTORY_PATH,
  });

  assert.equal(line.historyPath, HISTORY_PATH);
  assert.equal(Object.hasOwn(line, "stagingPath"), false);
});

// D5: with no candidate and no body, both hashes name the attempt itself, so an attempt is grouped by the
// event, the skill and the focus it asked for -- and by nothing else.
test("attemptHashes: an attempt with no candidate hashes to its own identity", () => {
  const hashes = attemptHashes("not-eligible", "pdf-tools", "merged cells");

  assert.match(hashes.candidateHash, HASH_PATTERN);
  assert.equal(hashes.bodyHash, hashes.candidateHash);
  assert.notEqual(attemptHashes("no-evidence", "pdf-tools", "merged cells").candidateHash, hashes.candidateHash);
  assert.notEqual(attemptHashes("not-eligible", "other-skill", "merged cells").candidateHash, hashes.candidateHash);
  assert.notEqual(attemptHashes("not-eligible", "pdf-tools", undefined).candidateHash, hashes.candidateHash);
  // "no focus" and "focus empty" are one identity: the flow normalizes the second one away before it asks.
  assert.equal(
    attemptHashes("not-eligible", "pdf-tools", "").candidateHash,
    attemptHashes("not-eligible", "pdf-tools", undefined).candidateHash,
  );
});

// One rule of the digest, two callers (M1c): the pair of a run with no candidate is two uses of attemptSignature, and the
// signature of a directional diagnosis is a third one, so the failure signature of an attempt and the hashes of the same
// attempt cannot be two spellings of the same name.
test("attemptSignature: the digest of an attempt is what both hashes and a directional diagnosis carry", () => {
  const signature = attemptSignature("not-eligible", "pdf-tools", "merged cells");
  const hashes = attemptHashes("not-eligible", "pdf-tools", "merged cells");

  assert.match(signature, HASH_PATTERN);
  assert.equal(hashes.candidateHash, signature);
  assert.equal(hashes.bodyHash, signature);

  // The third kind of identity: a directional attempt writes a line, so its name is no event of the index, and what the
  // digest names is the ask -- another focus or another skill is another name.
  const directional = attemptSignature("directional_improvement", "pdf-tools", "merged cells");
  assert.match(directional, HASH_PATTERN);
  assert.equal(directional, attemptSignature("directional_improvement", "pdf-tools", "merged cells"));
  assert.notEqual(directional, attemptSignature("directional_improvement", "pdf-tools", undefined));
  assert.notEqual(directional, attemptSignature("directional_improvement", "other-skill", "merged cells"));
});

test("ATTEMPT_EVENTS: the emitible vocabulary is the one of Q14 and every member is emitible", () => {
  assert.deepEqual([...ATTEMPT_EVENTS], [
    "proposed",
    "no-evidence",
    "not-eligible",
    "no-model",
    "accepted",
    "gate-rejected",
    "gate-abstained",
    "no-baseline",
    "retired",
  ]);

  for (const event of ATTEMPT_EVENTS) {
    assert.equal(isAttemptEvent(event), true);
    assert.equal(isKnownAttemptEvent(event), true);
  }
});

// The reserve of M1c had one name, `no-baseline`, and this slice turned that permission on: the event is on
// ATTEMPT_EVENTS now and the list is empty. What survives is the mechanism -- a list, a derived type and a predicate of
// its own -- because the next name a later version writes is declared there first.
//
// The empty tuple in the conditional is what keeps it from distributing over `never`: the constant is a compile-time
// proof that today's reserve derives to nothing, and a name added to the list turns it into a type error that forces
// this suite to be revisited.
const RESERVE_IS_EMPTY: [ReservedAttemptEvent] extends [never] ? true : false = true;

test("isAttemptEvent and isKnownAttemptEvent: the reserve is empty and the two predicates stay two", () => {
  assert.deepEqual([...RESERVED_ATTEMPT_EVENTS], []);
  assert.equal(RESERVE_IS_EMPTY, true);

  // M1c emits it: a gate of the directional base answers it when it finds no bank to measure against.
  assert.equal(isAttemptEvent("no-baseline"), true);
  assert.equal(isKnownAttemptEvent("no-baseline"), true);

  // M1 does not add gate-accepted to the index: a gate that passes writes no line, and the intermediate
  // state lives in decision.json until the acceptance writes the skill.
  assert.equal(isAttemptEvent("gate-accepted"), false);
  assert.equal(isKnownAttemptEvent("gate-accepted"), false);

  // The vocabulary of the session entry is not the vocabulary of the index either.
  assert.equal(isKnownAttemptEvent("error"), false);
});

// The rule the module writes down: the line is the shape, the event is a value in it. A line carrying an event
// of another version survives the format unchanged, which is what lets a reader of M1 read an index written by M1c.
//
// `no-baseline` is the event this version adds, and its line is written by the constructor: the reason of the missing
// baseline is the field that says why the attempt has to be retried, and it comes back unchanged.
test("a no-baseline line is built by the constructor and comes back unchanged", () => {
  const line = buildAttemptLine({
    now: NOW,
    event: "no-baseline",
    targetSkill: "pdf-tools",
    hashes: { candidateHash: CANDIDATE_HASH, bodyHash: BODY_HASH },
    failureSignature: SIGNATURE,
    stagingPath: STAGING_PATH,
    decisionPath: DECISION_PATH,
    reason: "bank-absent: /work/cases.json",
  });

  assert.deepEqual(line, {
    ts: NOW.toISOString(),
    event: "no-baseline",
    candidateHash: CANDIDATE_HASH,
    bodyHash: BODY_HASH,
    failureSignature: SIGNATURE,
    targetSkill: "pdf-tools",
    stagingPath: STAGING_PATH,
    decisionPath: DECISION_PATH,
    reason: "bank-absent: /work/cases.json",
  });

  // Through the format the index is: one JSON line, and the event on it is one this version both reads and writes.
  const parsed: unknown = JSON.parse(JSON.stringify(line));
  assert.deepEqual(parsed, line);
  assert.equal(isAttemptEvent(line.event), true);
  assert.equal(isKnownAttemptEvent(line.event), true);
});

// M3, S4: the retirement emits a line too, and it is a line of the same shape. Its pair of hashes is the one of the
// lesson the acceptance measured -- the tombstone keeps the same body and the line joins the acceptance by it -- and
// `failureSignature` is an explicit null, because a retirement decides nothing about a failure (OA4 of M1).
test("a retired line is built by the constructor, parses back and is an event of this version", () => {
  const line = buildAttemptLine({
    now: NOW,
    event: "retired",
    targetSkill: "pdf-tools",
    hashes: { candidateHash: CANDIDATE_HASH, bodyHash: BODY_HASH },
    failureSignature: null,
    historyPath: HISTORY_PATH,
    reason: "stale: the tables of the appendix moved",
  });

  assert.deepEqual(line, {
    ts: NOW.toISOString(),
    event: "retired",
    candidateHash: CANDIDATE_HASH,
    bodyHash: BODY_HASH,
    failureSignature: null,
    targetSkill: "pdf-tools",
    historyPath: HISTORY_PATH,
    reason: "stale: the tables of the appendix moved",
  });

  // Through the format the index is: one JSON line, and the event on it is one this version both reads and writes.
  const parsed: unknown = JSON.parse(JSON.stringify(line));
  assert.deepEqual(parsed, line);
  assert.equal(isAttemptEvent(line.event), true);
  assert.equal(isKnownAttemptEvent(line.event), true);
});

interface Fixture {
  pkg: string;
}

function createFixture(t: TestContext): Fixture {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-gate-attempts-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const pkg = path.join(base, "pi-simple-sri");
  fs.mkdirSync(pkg, { recursive: true });

  return { pkg };
}

// The two writers of the index, end to end: the lines come from buildAttemptLine and land in the file the
// writer owns, in the order they were written, each one complete.
test("appendAttemptLine: two lines of the index come back in order and neither is truncated", async (t) => {
  const fixture = createFixture(t);
  const proposed = buildAttemptLine({
    now: NOW,
    event: "proposed",
    targetSkill: "pdf-tools",
    hashes: { candidateHash: CANDIDATE_HASH, bodyHash: BODY_HASH },
    failureSignature: SIGNATURE,
    stagingPath: STAGING_PATH,
    decisionPath: DECISION_PATH,
  });
  const rejected = buildAttemptLine({
    now: new Date("2026-11-02T14:20:00.000Z"),
    event: "gate-rejected",
    targetSkill: "pdf-tools",
    hashes: { candidateHash: CANDIDATE_HASH, bodyHash: BODY_HASH },
    failureSignature: SIGNATURE,
    stagingPath: STAGING_PATH,
    decisionPath: DECISION_PATH,
  });

  await appendAttemptLine(fixture.pkg, proposed);
  await appendAttemptLine(fixture.pkg, rejected);

  const content = fs.readFileSync(path.join(stateDir(fixture.pkg), ATTEMPTS_FILE), "utf8");
  assert.equal(content.endsWith("\n"), true);

  const lines = content.split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), proposed);
  assert.deepEqual(JSON.parse(lines[1]), rejected);
});
