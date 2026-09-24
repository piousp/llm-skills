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
