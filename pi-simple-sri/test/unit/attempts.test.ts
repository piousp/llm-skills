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
  buildAttemptLine,
  isAttemptEvent,
  isKnownAttemptEvent,
} from "../../src/attempts.ts";
import { ATTEMPTS_FILE } from "../../src/names.ts";
import type { AttemptLine } from "../../src/types.ts";
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

test("ATTEMPT_EVENTS: the emitible vocabulary is the one of Q14 and every member is emitible", () => {
  assert.deepEqual([...ATTEMPT_EVENTS], [
    "proposed",
    "no-evidence",
    "not-eligible",
    "no-model",
    "accepted",
    "gate-rejected",
    "gate-abstained",
  ]);

  for (const event of ATTEMPT_EVENTS) {
    assert.equal(isAttemptEvent(event), true);
    assert.equal(isKnownAttemptEvent(event), true);
  }
});

// The reserve of M1c (Q23): a reader of this version classifies a line it could not have written, and no
// writer of this version can emit it because buildAttemptLine takes AttemptEvent and not KnownAttemptEvent.
test("isAttemptEvent and isKnownAttemptEvent: the reserved vocabulary is recognized and not emitted", () => {
  assert.deepEqual([...RESERVED_ATTEMPT_EVENTS], ["no-baseline"]);

  assert.equal(isAttemptEvent("no-baseline"), false);
  assert.equal(isKnownAttemptEvent("no-baseline"), true);

  // M1 does not add gate-accepted to the index: a gate that passes writes no line, and the intermediate
  // state lives in decision.json until the acceptance writes the skill.
  assert.equal(isAttemptEvent("gate-accepted"), false);
  assert.equal(isKnownAttemptEvent("gate-accepted"), false);

  // The vocabulary of the session entry is not the vocabulary of the index either.
  assert.equal(isKnownAttemptEvent("error"), false);
});

// The rule the module writes down: the line is the shape, the event is a value in it. A line carrying an event
// of another version survives the format unchanged, which is what lets a reader of M1c read an index written
// by M1.
test("a line with a reserved event survives the round trip through the index format", () => {
  // buildAttemptLine does not emit this event -- that is the reserve -- so the line is written the way a
  // reader would find it.
  const line: AttemptLine = {
    ts: NOW.toISOString(),
    event: "no-baseline",
    candidateHash: CANDIDATE_HASH,
    bodyHash: BODY_HASH,
    failureSignature: null,
    targetSkill: "pdf-tools",
    stagingPath: STAGING_PATH,
  };

  const json = JSON.stringify(line);
  assert.equal(json.includes('"event":"no-baseline"'), true);

  const parsed: unknown = JSON.parse(json);
  assert.deepEqual(parsed, line);
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
