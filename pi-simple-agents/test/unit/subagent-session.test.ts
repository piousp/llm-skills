import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSubagentSessionManager,
  type SessionManagerFactory,
} from "../../src/subagent-session.ts";

interface FakeSession {
  id: string;
}

interface FakeFactory extends SessionManagerFactory<FakeSession> {
  calls: string[];
  inMemoryResult: FakeSession;
}

function createFakeFactory(options: {
  forkFromResult?: FakeSession | Error;
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
    inMemory(cwd) {
      calls.push(`inMemory:${cwd}`);
      return inMemoryResult;
    },
  };
}

const cwd = "/work/dir";
const sessionDir = "/home/user/.pi/agent/sessions/subagents";

test("createSubagentSessionManager: defaultContext undefined uses in-memory, no fork attempted", () => {
  const factory = createFakeFactory();

  const result = createSubagentSessionManager(
    { name: "scout", defaultContext: undefined },
    "/caller/session.jsonl",
    cwd,
    sessionDir,
    factory,
  );

  assert.equal(result.manager, factory.inMemoryResult);
  assert.deepEqual(result.warnings, []);
  assert.equal(factory.calls.some((c) => c.startsWith("forkFrom:")), false);
});

test("createSubagentSessionManager: defaultContext fresh uses in-memory, no fork attempted", () => {
  const factory = createFakeFactory();

  const result = createSubagentSessionManager(
    { name: "scout", defaultContext: "fresh" },
    "/caller/session.jsonl",
    cwd,
    sessionDir,
    factory,
  );

  assert.equal(result.manager, factory.inMemoryResult);
  assert.deepEqual(result.warnings, []);
  assert.equal(factory.calls.some((c) => c.startsWith("forkFrom:")), false);
});

test("createSubagentSessionManager: defaultContext forked with a caller session file forks from it", () => {
  const forkedResult: FakeSession = { id: "forked-session" };
  const factory = createFakeFactory({ forkFromResult: forkedResult });

  const result = createSubagentSessionManager(
    { name: "scout", defaultContext: "forked" },
    "/path/session.jsonl",
    cwd,
    sessionDir,
    factory,
  );

  assert.equal(result.manager, forkedResult);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(factory.calls, [`forkFrom:/path/session.jsonl:${cwd}:${sessionDir}`]);
});

test("createSubagentSessionManager: defaultContext forked without a persisted caller session falls back to in-memory with a warning", () => {
  const factory = createFakeFactory();

  const result = createSubagentSessionManager(
    { name: "scout", defaultContext: "forked" },
    undefined,
    cwd,
    sessionDir,
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
    sessionDir,
    factory,
  );

  assert.equal(result.manager, factory.inMemoryResult);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /scout/);
  assert.match(result.warnings[0], /Cannot fork: source session file is empty or invalid/);
});
