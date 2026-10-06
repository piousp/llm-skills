import { test } from "node:test";
import assert from "node:assert/strict";
import {
  childSessionDir,
  createSubagentSessionManager,
  type SessionManagerFactory,
} from "../../src/subagent-session.ts";

test("childSessionDir: no caller session file yields no path", () => {
  assert.equal(childSessionDir(undefined, "abc123", 0), undefined);
});

test("childSessionDir: builds <parent-without-ext>/<runId>/run-<index>", () => {
  assert.equal(
    childSessionDir("/a/b/parent.jsonl", "abc123", 0),
    "/a/b/parent/abc123/run-0",
  );
});

test("childSessionDir: sanitizes runId characters outside [A-Za-z0-9._-]", () => {
  assert.equal(
    childSessionDir("/a/b/parent.jsonl", "tool:call/1", 2),
    "/a/b/parent/tool_call_1/run-2",
  );
});

test("childSessionDir: empty runId after sanitizing falls back to \"run\"", () => {
  assert.equal(
    childSessionDir("/a/b/parent.jsonl", "///", 0),
    "/a/b/parent/run/run-0",
  );
});

test("childSessionDir: a runId that sanitizes to only dots falls back to \"run\" instead of a path-traversal segment", () => {
  assert.equal(
    childSessionDir("/a/b/parent.jsonl", "..", 0),
    "/a/b/parent/run/run-0",
  );
});

test("childSessionDir: a runId at or under the length cap is left untouched", () => {
  const runId = "a".repeat(64);
  const result = childSessionDir("/a/b/parent.jsonl", runId, 0);
  assert.equal(result, `/a/b/parent/${runId}/run-0`);
});

test("childSessionDir: a runId over the length cap is truncated with a stable hash suffix, never exceeding the cap", () => {
  const longRunId = "toolu_" + "x".repeat(300);
  const result = childSessionDir("/a/b/parent.jsonl", longRunId, 0)!;
  const segment = result.split("/")[4];
  assert.ok(segment.length <= 64, `expected segment length <= 64, got ${segment.length}`);
  assert.match(segment, /^toolu_x+_[0-9a-f]{8}$/);
});

test("childSessionDir: two long runIds sharing a long common prefix produce different directories", () => {
  const prefix = "a".repeat(100);
  const resultA = childSessionDir("/a/b/parent.jsonl", `${prefix}-one`, 0);
  const resultB = childSessionDir("/a/b/parent.jsonl", `${prefix}-two`, 0);
  assert.notEqual(resultA, resultB);
});

test("childSessionDir: truncation is deterministic for the same runId", () => {
  const longRunId = "x".repeat(500);
  const resultA = childSessionDir("/a/b/parent.jsonl", longRunId, 0);
  const resultB = childSessionDir("/a/b/parent.jsonl", longRunId, 0);
  assert.equal(resultA, resultB);
});

// Builds a synthetic `callerSessionFile` path representing `depth` levels of
// subagent-calling-subagent nesting, the same shape childSessionDir itself
// produces (each hop appends "<runId>/run-<N>/session").
function nestedCallerSessionFile(depth: number): string {
  let path = "/root/2026-01-01_root";
  for (let i = 0; i < depth; i++) {
    path += `/toolu_level${i}/run-0/session`;
  }
  return `${path}.jsonl`;
}

test("childSessionDir: up to MAX_LITERAL_NESTING_DEPTH (4) levels of nesting still produce the full literal path", () => {
  const caller = nestedCallerSessionFile(3); // depth 3 < cap: still literal
  const result = childSessionDir(caller, "toolu_next", 0)!;
  assert.equal(result, `${nestedCallerSessionFile(3).replace(/\.jsonl$/, "")}/toolu_next/run-0`);
});

test("childSessionDir: beyond the nesting cap, the path collapses to a short hashed segment instead of growing further", () => {
  const caller = nestedCallerSessionFile(4); // depth 4 == cap: next hop collapses
  const result = childSessionDir(caller, "toolu_next", 0)!;
  assert.doesNotMatch(result, /toolu_next/, "the raw runId should not appear literally once collapsed");
  assert.match(result.split("/").at(-2)!, /^deep-[0-9a-f]{16}$/);
});

test("childSessionDir: path length stays bounded no matter how much deeper the real nesting goes", () => {
  const shallow = childSessionDir(nestedCallerSessionFile(5), "toolu_x", 0)!;
  const deep = childSessionDir(nestedCallerSessionFile(25), "toolu_x", 0)!;
  // Both are past the cap, so both collapse at the same anchor (depth-4
  // prefix is identical for every caller built by nestedCallerSessionFile);
  // length must not grow with the caller's own nesting depth.
  assert.equal(shallow.length, deep.length);
});

test("childSessionDir: collapsed dirs for different callers at the same depth are distinct (hash includes the full caller path)", () => {
  const callerA = nestedCallerSessionFile(6);
  const callerB = nestedCallerSessionFile(6).replace("level5", "level5alt");
  const resultA = childSessionDir(callerA, "toolu_x", 0);
  const resultB = childSessionDir(callerB, "toolu_x", 0);
  assert.notEqual(resultA, resultB);
});

test("childSessionDir: collapsed dirs for the same caller+runId are deterministic", () => {
  const caller = nestedCallerSessionFile(10);
  const resultA = childSessionDir(caller, "toolu_x", 0);
  const resultB = childSessionDir(caller, "toolu_x", 0);
  assert.equal(resultA, resultB);
});

interface FakeSession {
  id: string;
}

interface FakeFactory extends SessionManagerFactory<FakeSession> {
  calls: string[];
  inMemoryResult: FakeSession;
}

function createFakeFactory(options: {
  forkFromResult?: FakeSession | Error;
  atPathResult?: FakeSession | Error;
  inMemoryResult?: FakeSession;
} = {}): FakeFactory {
  const calls: string[] = [];
  const inMemoryResult = options.inMemoryResult ?? { id: "in-memory" };

  return {
    calls,
    inMemoryResult,
    forkFrom(sourcePath, targetCwd, sessionDir) {
      calls.push(`forkFrom:${sourcePath}:${targetCwd}:${sessionDir}`);
      if (options.forkFromResult instanceof Error) {
        throw options.forkFromResult;
      }
      return options.forkFromResult ?? { id: "forked" };
    },
    atPath(sessionFile, cwd) {
      calls.push(`atPath:${sessionFile}:${cwd}`);
      if (options.atPathResult instanceof Error) {
        throw options.atPathResult;
      }
      return options.atPathResult ?? { id: "at-path" };
    },
    inMemory(cwd) {
      calls.push(`inMemory:${cwd}`);
      return inMemoryResult;
    },
  };
}

const cwd = "/work/dir";
const childDir = "/home/user/.pi/agent/sessions/--proj--/parent/abc123/run-0";

test("createSubagentSessionManager: defaultContext undefined with a childDir persists at the conventional path", () => {
  const atPathResult: FakeSession = { id: "persisted" };
  const factory = createFakeFactory({ atPathResult });

  const result = createSubagentSessionManager(
    { name: "scout", defaultContext: undefined },
    "/caller/session.jsonl",
    cwd,
    childDir,
    factory,
  );

  assert.equal(result.manager, atPathResult);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(factory.calls, [`atPath:${childDir}/session.jsonl:${cwd}`]);
});

test("createSubagentSessionManager: defaultContext fresh with a childDir persists at the conventional path", () => {
  const atPathResult: FakeSession = { id: "persisted" };
  const factory = createFakeFactory({ atPathResult });

  const result = createSubagentSessionManager(
    { name: "scout", defaultContext: "fresh" },
    "/caller/session.jsonl",
    cwd,
    childDir,
    factory,
  );

  assert.equal(result.manager, atPathResult);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(factory.calls, [`atPath:${childDir}/session.jsonl:${cwd}`]);
});

test("createSubagentSessionManager: defaultContext undefined without a childDir (caller not persisted) uses in-memory, no warning", () => {
  const factory = createFakeFactory();

  const result = createSubagentSessionManager(
    { name: "scout", defaultContext: undefined },
    undefined,
    cwd,
    undefined,
    factory,
  );

  assert.equal(result.manager, factory.inMemoryResult);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(factory.calls, [`inMemory:${cwd}`]);
});

test("createSubagentSessionManager: atPath throwing falls back to in-memory with a warning containing the error message", () => {
  const factory = createFakeFactory({
    atPathResult: new Error("EEXIST: session file already exists"),
  });

  const result = createSubagentSessionManager(
    { name: "scout", defaultContext: undefined },
    "/caller/session.jsonl",
    cwd,
    childDir,
    factory,
  );

  assert.equal(result.manager, factory.inMemoryResult);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /scout/);
  assert.match(result.warnings[0], /EEXIST: session file already exists/);
});

test("createSubagentSessionManager: defaultContext forked with a caller session file forks into the childDir", () => {
  const forkedResult: FakeSession = { id: "forked-session" };
  const factory = createFakeFactory({ forkFromResult: forkedResult });

  const result = createSubagentSessionManager(
    { name: "scout", defaultContext: "forked" },
    "/path/session.jsonl",
    cwd,
    childDir,
    factory,
  );

  assert.equal(result.manager, forkedResult);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(factory.calls, [`forkFrom:/path/session.jsonl:${cwd}:${childDir}`]);
});

test("createSubagentSessionManager: defaultContext forked without a persisted caller session falls back to in-memory with a warning", () => {
  const factory = createFakeFactory();

  const result = createSubagentSessionManager(
    { name: "scout", defaultContext: "forked" },
    undefined,
    cwd,
    undefined,
    factory,
  );

  assert.equal(result.manager, factory.inMemoryResult);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /scout/);
  assert.deepEqual(factory.calls, [`inMemory:${cwd}`]);
});

test("createSubagentSessionManager: forkFrom throwing falls back to in-memory with a warning containing the error message", () => {
  const factory = createFakeFactory({
    forkFromResult: new Error("Cannot fork: source session file is empty or invalid"),
  });

  const result = createSubagentSessionManager(
    { name: "scout", defaultContext: "forked" },
    "/path/session.jsonl",
    cwd,
    childDir,
    factory,
  );

  assert.equal(result.manager, factory.inMemoryResult);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /scout/);
  assert.match(result.warnings[0], /Cannot fork: source session file is empty or invalid/);
});
