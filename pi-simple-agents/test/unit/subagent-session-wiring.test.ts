// Integration test (no live model call): wires createSubagentSessionManager's
// `defaultContext: "forked"` path into the REAL SessionManager from the SDK —
// forking from an actual persisted session file on disk, and falling back to
// a real in-memory session when the real SessionManager.forkFrom() throws on
// an empty/invalid file. subagent-session.test.ts covers the branching logic
// against a fake factory; this file confirms the real factory wired in
// extensions/index.ts actually behaves as that logic assumes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { childSessionDir, createSubagentSessionManager } from "../../src/subagent-session.ts";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-agents-subagent-session-wiring-"));
}

// Same shape as SESSION_MANAGER_FACTORY in extensions/index.ts — the real
// factory, not a fake.
const REAL_FACTORY = {
  forkFrom: (s: string, t: string, d: string) => SessionManager.forkFrom(s, t, d),
  atPath: (f: string, c: string) => SessionManager.open(f, path.dirname(f), c),
  inMemory: (c: string) => SessionManager.inMemory(c),
};

test("createSubagentSessionManager + real SessionManager: forked context forks a real persisted session and carries over its entries", () => {
  const callerCwd = makeTmpDir();
  const callerSessionDir = path.join(callerCwd, "sessions");
  const targetCwd = makeTmpDir();
  const targetSessionDir = path.join(targetCwd, "subagent-sessions");
  try {
    const original = SessionManager.create(callerCwd, callerSessionDir);
    // Force a flush to disk: the SDK's internal _persist only writes the
    // session file once the entries contain at least one assistant message —
    // a plain appendCustomEntry alone does not trigger it.
    original.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    original.appendCustomEntry("test-marker", { note: "hello from original session" });
    const sourceFile = original.getSessionFile();
    assert.notEqual(sourceFile, undefined, "expected the original session to be persisted to a file");
    assert.equal(fs.existsSync(sourceFile!), true);

    const { manager, warnings } = createSubagentSessionManager(
      { name: "scout", defaultContext: "forked" },
      sourceFile,
      targetCwd,
      targetSessionDir,
      REAL_FACTORY,
    );

    assert.deepEqual(warnings, []);
    assert.ok(manager instanceof SessionManager);
    assert.equal(manager.isPersisted(), true);

    const forkedEntries = manager.getEntries();
    const marker = forkedEntries.find(
      (e) => e.type === "custom" && e.customType === "test-marker",
    );
    assert.notEqual(marker, undefined, "expected the forked session to carry over the original's custom entry");
    assert.deepEqual((marker as { data?: unknown }).data, { note: "hello from original session" });

    // The forked session file itself is a new file distinct from the source.
    assert.notEqual(manager.getSessionFile(), sourceFile);
  } finally {
    fs.rmSync(callerCwd, { recursive: true, force: true });
    fs.rmSync(targetCwd, { recursive: true, force: true });
  }
});

test("createSubagentSessionManager + real SessionManager: no forked context persists a real session at the conventional childDir path", () => {
  const callerCwd = makeTmpDir();
  const targetCwd = makeTmpDir();
  try {
    const callerSessionFile = path.join(callerCwd, "sessions", "parent.jsonl");
    const childDir = childSessionDir(callerSessionFile, "abc123", 0)!;

    const { manager, warnings } = createSubagentSessionManager(
      { name: "scout", defaultContext: undefined },
      callerSessionFile,
      targetCwd,
      childDir,
      REAL_FACTORY,
    );

    assert.deepEqual(warnings, []);
    assert.ok(manager instanceof SessionManager);
    assert.equal(manager.getSessionFile(), path.join(childDir, "session.jsonl"));
    assert.equal(manager.isPersisted(), true);
    // Opening a not-yet-existing path starts a fresh session, not a load
    // failure \u2014 no entries until something is actually appended.
    assert.deepEqual(manager.getEntries(), []);
  } finally {
    fs.rmSync(callerCwd, { recursive: true, force: true });
    fs.rmSync(targetCwd, { recursive: true, force: true });
  }
});

test("createSubagentSessionManager + real SessionManager: no forked context does not carry over the real parent session's entries (contrast with the forked path above)", () => {
  const callerCwd = makeTmpDir();
  const callerSessionDir = path.join(callerCwd, "sessions");
  const targetCwd = makeTmpDir();
  try {
    const parent = SessionManager.create(callerCwd, callerSessionDir);
    parent.appendCustomEntry("test-marker", { note: "hello from the parent session" });
    parent.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const callerSessionFile = parent.getSessionFile()!;
    const childDir = childSessionDir(callerSessionFile, "abc123", 0)!;

    const { manager } = createSubagentSessionManager(
      { name: "scout", defaultContext: undefined },
      callerSessionFile,
      targetCwd,
      childDir,
      REAL_FACTORY,
    );

    assert.deepEqual(manager.getEntries(), []);
    assert.notEqual(manager.getSessionFile(), callerSessionFile);
  } finally {
    fs.rmSync(callerCwd, { recursive: true, force: true });
    fs.rmSync(targetCwd, { recursive: true, force: true });
  }
});

test("createSubagentSessionManager + real SessionManager: no forked context flushes a real file to the conventional path once an assistant message is appended", () => {
  const callerCwd = makeTmpDir();
  const targetCwd = makeTmpDir();
  try {
    const callerSessionFile = path.join(callerCwd, "sessions", "parent.jsonl");
    const childDir = childSessionDir(callerSessionFile, "abc123", 0)!;

    const { manager } = createSubagentSessionManager(
      { name: "scout", defaultContext: undefined },
      callerSessionFile,
      targetCwd,
      childDir,
      REAL_FACTORY,
    );

    const expectedFile = path.join(childDir, "session.jsonl");
    assert.equal(fs.existsSync(expectedFile), false, "persistence should be lazy: no write before the first assistant message");

    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    assert.equal(fs.existsSync(expectedFile), true, "expected the run's session to flush to the conventional path");
  } finally {
    fs.rmSync(callerCwd, { recursive: true, force: true });
    fs.rmSync(targetCwd, { recursive: true, force: true });
  }
});

test("createSubagentSessionManager + real SessionManager: forked context falls back to a real in-memory session when the source file is empty/invalid", () => {
  const callerCwd = makeTmpDir();
  const targetCwd = makeTmpDir();
  const targetSessionDir = path.join(targetCwd, "subagent-sessions");
  try {
    const invalidSessionFile = path.join(callerCwd, "corrupt-session.jsonl");
    fs.writeFileSync(invalidSessionFile, "not valid json\n", "utf8");

    const { manager, warnings } = createSubagentSessionManager(
      { name: "scout", defaultContext: "forked" },
      invalidSessionFile,
      targetCwd,
      targetSessionDir,
      REAL_FACTORY,
    );

    assert.ok(manager instanceof SessionManager);
    assert.equal(manager.isPersisted(), false, "expected fallback to a real in-memory (non-persisted) SessionManager");
    assert.equal(manager.getCwd(), path.resolve(targetCwd));

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /scout/);
    assert.match(warnings[0], /Cannot fork: source session file is empty or invalid/);
  } finally {
    fs.rmSync(callerCwd, { recursive: true, force: true });
    fs.rmSync(targetCwd, { recursive: true, force: true });
  }
});
