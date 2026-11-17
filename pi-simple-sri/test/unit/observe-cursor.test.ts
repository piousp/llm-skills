import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../../src/hash.ts";
import { OBSERVE_CURSOR_FILE } from "../../src/names.ts";
import { cursorEntryOf, emptyCursor, planScan, readCursor, writeCursor } from "../../src/observe/cursor.ts";
import { MIN_IDLE_MS } from "../../src/observe/types.ts";
import type { ObserveCursor, SessionFileRef } from "../../src/observe/types.ts";
import { stateDir } from "../../src/write-base.ts";
import { FIXTURE_NOW, makeAgentDir } from "./observe-fixtures.ts";

// The cursor only decides whether a session file is read again. What is pinned here: it round-trips privately, a cursor
// nobody can read is an empty one, and planScan skips the current session and the files touched too recently, reads
// what is new, grown, shrunk or moved, and skips what is unchanged.

const NOW = new Date(FIXTURE_NOW);
const IDLE_MTIME = NOW.getTime() - MIN_IDLE_MS - 60_000;

function ref(headerId: string, overrides: Partial<SessionFileRef> = {}): SessionFileRef {
  return { path: `/sessions/${headerId}.jsonl`, headerId, size: 1000, mtimeMs: IDLE_MTIME, ...overrides };
}

function cursorOf(...files: SessionFileRef[]): ObserveCursor {
  return { files: Object.fromEntries(files.map((file) => [file.headerId, cursorEntryOf(file, `{"id":"${file.headerId}"}`)])) };
}

const options = { now: NOW, currentSessionFile: null };

test("readCursor: an absent cursor is empty", async (t) => {
  assert.deepEqual(await readCursor(makeAgentDir(t).base), emptyCursor());
});

test("writeCursor then readCursor: round-trips, the file is 0600 in state/", async (t) => {
  const fixture = makeAgentDir(t);
  const cursor = cursorOf(ref("h1"), ref("h2", { size: 5 }));

  await writeCursor(fixture.base, cursor);

  assert.deepEqual(await readCursor(fixture.base), cursor);
  const file = path.join(stateDir(fixture.base), OBSERVE_CURSOR_FILE);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(stateDir(fixture.base)), [OBSERVE_CURSOR_FILE]);
});

test("readCursor: a cursor nobody can read is an empty one; a damaged entry is dropped alone", async (t) => {
  const fixture = makeAgentDir(t);
  const file = path.join(stateDir(fixture.base), OBSERVE_CURSOR_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  for (const text of ["not json", "[]", '{"files":[]}', '{"nope":1}']) {
    fs.writeFileSync(file, text);
    assert.deepEqual(await readCursor(fixture.base), emptyCursor(), text);
  }

  const good = cursorEntryOf(ref("h1"), "first");
  fs.writeFileSync(file, JSON.stringify({ files: { h1: good, h2: { path: "/x", size: "big" } } }));
  assert.deepEqual(await readCursor(fixture.base), { files: { h1: good } });
});

test("cursorEntryOf: keeps the path, size and mtime and hashes the first line", () => {
  const file = ref("h1", { size: 42, mtimeMs: 7 });
  assert.deepEqual(cursorEntryOf(file, "header"), { path: file.path, size: 42, mtimeMs: 7, firstLineHash: sha256Hex("header") });
});

test("planScan: a file the cursor does not know is read", () => {
  const file = ref("h1");
  assert.deepEqual(planScan([file], emptyCursor(), options), { read: [file], skipped: [] });
});

test("planScan: an unchanged file is skipped", () => {
  const file = ref("h1");
  assert.deepEqual(planScan([file], cursorOf(file), options), { read: [], skipped: [{ file, reason: "unchanged" }] });
});

test("planScan: a file that grew, was touched, or moved is read again", () => {
  const known = ref("h1");
  const cursor = cursorOf(known);
  const grown = ref("h1", { size: 2000 });
  const touched = ref("h1", { mtimeMs: IDLE_MTIME - 1000 });
  const moved = ref("h1", { path: "/sessions/elsewhere/h1.jsonl" });

  for (const changed of [grown, touched, moved]) {
    assert.deepEqual(planScan([changed], cursor, options).read, [changed]);
  }
});

test("planScan: a rewrite -- the size shrank under the same header -- is read again, in full", () => {
  const cursor = cursorOf(ref("h1", { size: 5000 }));
  const shrunk = ref("h1", { size: 1200 });
  assert.deepEqual(planScan([shrunk], cursor, options), { read: [shrunk], skipped: [] });
});

test("planScan: the current session is skipped, however the path is spelled, even when the cursor knows nothing of it", () => {
  const current = ref("h-current", { path: "/sessions/a/../current.jsonl" });
  const plan = planScan([current], emptyCursor(), { now: NOW, currentSessionFile: "/sessions/current.jsonl" });
  assert.deepEqual(plan, { read: [], skipped: [{ file: current, reason: "current" }] });
});

test("planScan: a file touched less than the idle window ago is skipped; exactly at the window it is read", () => {
  const recent = ref("h-recent", { mtimeMs: NOW.getTime() - MIN_IDLE_MS + 1 });
  const atWindow = ref("h-window", { mtimeMs: NOW.getTime() - MIN_IDLE_MS });
  const plan = planScan([recent, atWindow], emptyCursor(), options);
  assert.deepEqual(plan.skipped, [{ file: recent, reason: "recent" }]);
  assert.deepEqual(plan.read, [atWindow]);
});

test("planScan: recent beats unchanged, and the idle window is a parameter", () => {
  const file = ref("h1", { mtimeMs: NOW.getTime() - 1000 });
  assert.equal(planScan([file], cursorOf(file), options).skipped[0].reason, "recent");
  assert.deepEqual(planScan([file], emptyCursor(), { ...options, minIdleMs: 500 }).read, [file]);
});

test("planScan: keeps the order of the files", () => {
  const files = [ref("h3"), ref("h1"), ref("h2")];
  assert.deepEqual(planScan(files, emptyCursor(), options).read.map((file) => file.headerId), ["h3", "h1", "h2"]);
});
