import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OBSERVE_LOCK_FILE } from "../../src/names.ts";
import { LOCK_STALE_MS } from "../../src/observe/types.ts";
import { withScanLock } from "../../src/observe/lock.ts";
import { stateDir } from "../../src/write-base.ts";
import { makeAgentDir } from "./observe-fixtures.ts";

// The lock of the scan and the forget: one holder at a time, a stale lock is taken over, the holder keeps it alive with a
// heartbeat, and a holder that was taken over is told (its signal aborts) and never removes the lock of the new one.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function lockPathOf(base: string): string {
  return path.join(stateDir(base), OBSERVE_LOCK_FILE);
}

function beatsOf(file: string): number {
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { beats: number }).beats;
}

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail("condition not reached in time");
    await sleep(5);
  }
}

test("withScanLock: answers the value of fn, holds a private lock file while it runs and removes it after", async (t) => {
  const fixture = makeAgentDir(t);
  const lockPath = lockPathOf(fixture.base);

  const result = await withScanLock(fixture.base, async (signal) => {
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);
    assert.equal(signal.aborted, false);
    return 42;
  });

  assert.deepEqual(result, { ok: true, value: 42 });
  assert.equal(fs.existsSync(lockPath), false);
});

test("withScanLock: a second caller while the first holds it is `locked` and fn does not run; the first keeps its lock", async (t) => {
  const fixture = makeAgentDir(t);
  let inner: unknown = "not run";
  let ran = false;

  const outer = await withScanLock(fixture.base, async () => {
    inner = await withScanLock(fixture.base, async () => {
      ran = true;
    });
    assert.equal(fs.existsSync(lockPathOf(fixture.base)), true);
    return "outer";
  });

  assert.deepEqual(inner, { ok: false, error: "locked" });
  assert.equal(ran, false);
  assert.deepEqual(outer, { ok: true, value: "outer" });
});

test("withScanLock: the lock is released when fn throws, and the error travels", async (t) => {
  const fixture = makeAgentDir(t);

  await assert.rejects(
    () =>
      withScanLock(fixture.base, async () => {
        throw new Error("scan failed");
      }),
    /scan failed/,
  );

  assert.equal(fs.existsSync(lockPathOf(fixture.base)), false);
  assert.equal((await withScanLock(fixture.base, async () => 1)).ok, true);
});

test("withScanLock: a lock younger than the stale window is respected", async (t) => {
  const fixture = makeAgentDir(t);
  const lockPath = lockPathOf(fixture.base);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ token: "other", pid: 1, beats: 0 }));

  const almost = await withScanLock(fixture.base, async () => "x", { now: () => Date.now() + LOCK_STALE_MS - 5000 });

  assert.deepEqual(almost, { ok: false, error: "locked" });
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, "other");
});

test("withScanLock: a stale lock is taken over and released afterwards", async (t) => {
  const fixture = makeAgentDir(t);
  const lockPath = lockPathOf(fixture.base);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ token: "dead-process", pid: 1, beats: 3 }));

  const result = await withScanLock(
    fixture.base,
    async () => {
      assert.notEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, "dead-process");
      return "took over";
    },
    { now: () => Date.now() + LOCK_STALE_MS + 1000 },
  );

  assert.deepEqual(result, { ok: true, value: "took over" });
  assert.equal(fs.existsSync(lockPath), false);
});

test("withScanLock: a lock file nobody can parse is held until it is stale, then taken over", async (t) => {
  const fixture = makeAgentDir(t);
  const lockPath = lockPathOf(fixture.base);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "garbage");

  assert.deepEqual(await withScanLock(fixture.base, async () => 1), { ok: false, error: "locked" });
  assert.deepEqual(await withScanLock(fixture.base, async () => 1, { now: () => Date.now() + LOCK_STALE_MS + 1000 }), {
    ok: true,
    value: 1,
  });
});

test("withScanLock: the heartbeat rewrites the lock while fn runs, and stops after", async (t) => {
  const fixture = makeAgentDir(t);
  const lockPath = lockPathOf(fixture.base);
  let beats = 0;

  await withScanLock(
    fixture.base,
    async () => {
      await until(() => beatsOf(lockPath) >= 2);
      beats = beatsOf(lockPath);
    },
    { heartbeatMs: 10 },
  );

  assert.ok(beats >= 2);
  assert.equal(fs.existsSync(lockPath), false);
  await sleep(40);
  assert.equal(fs.existsSync(lockPath), false);
});

test("withScanLock: a holder that was taken over is aborted and leaves the lock of the new holder alone", async (t) => {
  const fixture = makeAgentDir(t);
  const lockPath = lockPathOf(fixture.base);
  let aborted = false;

  const result = await withScanLock(
    fixture.base,
    async (signal) => {
      fs.writeFileSync(lockPath, JSON.stringify({ token: "new-holder", pid: 2, beats: 0 }));
      await until(() => signal.aborted);
      aborted = signal.aborted;
      return "done";
    },
    { heartbeatMs: 10 },
  );

  assert.equal(result.ok, true);
  assert.equal(aborted, true);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, "new-holder");
});

test("withScanLock: of two callers racing for a free lock exactly one runs", async (t) => {
  const fixture = makeAgentDir(t);
  let running = 0;
  let peak = 0;
  const work = async (): Promise<string> => {
    running += 1;
    peak = Math.max(peak, running);
    await sleep(30);
    running -= 1;
    return "ran";
  };

  const results = await Promise.all([withScanLock(fixture.base, work), withScanLock(fixture.base, work)]);

  assert.equal(peak, 1);
  assert.deepEqual(results.map((result) => result.ok).sort(), [false, true]);
});
