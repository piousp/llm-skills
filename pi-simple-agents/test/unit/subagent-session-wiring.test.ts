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
import { runSingleTask } from "../../src/task-runner.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../src/agents.ts";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-agents-subagent-session-wiring-"));
}

// Same shape as SESSION_MANAGER_FACTORY in src/task-runner.ts — the real
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

// --- runSingleTask + seedSessionFile (the /subagents continue run) ---

// Same AgentConfig shape the other suites' makeAgent builds; local copy so
// this file stays independent.
function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "scout",
    description: "wiring seed scout",
    systemPromptMode: "append",
    inheritProjectContext: true,
    defaultReads: [],
    source: "user",
    filePath: "/agents/scout.md",
    systemPrompt: "",
    ...overrides,
  };
}

// A real persisted session (create + one assistant message to trigger the
// flush, the same idiom the forked tests above use), for seeding from.
function persistedSessionOf(cwd: string, sessionDir: string): SessionManager {
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "from the interrupted attempt" }],
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
  return manager;
}

function fakeRunSession(): { session: unknown; promptArgs: string[] } {
  const promptArgs: string[] = [];
  const session = {
    getAllTools: () => [],
    bindExtensions: async () => {},
    extensionRunner: { hasHandlers: () => false, emit: async () => {} },
    subscribe: () => () => {},
    prompt: async (task: string) => { promptArgs.push(task); },
    getLastAssistantText: () => "done",
    getContextUsage: () => undefined,
    dispose: () => {},
    abort: () => {},
  };
  return { session, promptArgs };
}

const modelRuntimeStub = { isUsingSubscription: () => false } as unknown as ModelRuntime;

// A seeded run lands its session INSIDE the new runId's conventional dir
// (derived from the CALLER's session file, not the seed's), carrying the
// seed's conversation over — the fork, not the seed, is the new session.
test("runSingleTask: seedSessionFile forks the seed into the new runId dir and starts from its conversation", async () => {
  const callerCwd = makeTmpDir();
  const runCwd = makeTmpDir();
  try {
    // The caller's CURRENT session (persisted) and the seed (the interrupted
    // run's own child file) are two different files — `continue` forks the
    // SEED; the caller's file only names where the new run's dir nests.
    const caller = persistedSessionOf(callerCwd, path.join(callerCwd, "sessions"));
    const callerSessionFile = caller.getSessionFile()!;
    const seedSessionDir = path.join(callerCwd, "old-run");
    const seed = persistedSessionOf(callerCwd, seedSessionDir);
    seed.appendCustomEntry("persisted-marker", { note: "hello from the seed" });
    const seedFile = seed.getSessionFile()!;

    let capturedSessionManager: unknown;
    const { session, promptArgs } = fakeRunSession();
    const createSession = async (options: Record<string, unknown>) => {
      capturedSessionManager = options.sessionManager;
      return { session: session as never };
    };

    const result = await runSingleTask(
      { agent: "scout", task: "original task" },
      makeAgent(),
      undefined,
      {
        cwd: runCwd,
        signal: undefined,
        modelRuntime: modelRuntimeStub,
        callerSessionFile,
        runId: "continue-call-a-1",
        mode: "tui" as const,
        seedSessionFile: seedFile,
        createSession: createSession as never,
        homeDir: callerCwd,
      },
    );

    assert.equal(result.status, "success");
    assert.ok(capturedSessionManager instanceof SessionManager);
    const manager = capturedSessionManager as SessionManager;

    // The new file nests under the NEW runId's conventional child dir
    // (derived from the CALLER's file, never the seed's), and the fork
    // carries the seed's conversation over (marker entry included).
    const newFile = manager.getSessionFile()!;
    assert.notEqual(newFile, seedFile);
    assert.match(newFile, /continue-call-a-1.*run-0/);
    assert.equal(fs.existsSync(newFile), true);
    const marker = manager.getEntries().find((e) => e.type === "custom" && e.customType === "persisted-marker");
    assert.ok(marker, "the forked session must carry the seed's entries over");
    assert.equal(promptArgs.at(-1), "original task");
  } finally {
    fs.rmSync(callerCwd, { recursive: true, force: true });
    fs.rmSync(runCwd, { recursive: true, force: true });
  }
});

// Dangling toolCall pairs in the seed are closed with one synthetic
// toolResult each in the FORKED copy; the seed file on disk is never touched.
test("runSingleTask: seeding appends one synthetic toolResult per dangling toolCall, only into the forked file", async () => {
  const callerCwd = makeTmpDir();
  const runCwd = makeTmpDir();
  try {
    const caller = persistedSessionOf(callerCwd, path.join(callerCwd, "sessions"));
    const callerSessionFile = caller.getSessionFile()!;
    caller.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "toolu_dangle", name: "read", arguments: {} }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now() + 1,
    });
    const seedFile = caller.getSessionFile()!;
    const seedBefore = fs.readFileSync(seedFile, "utf8");

    let capturedSessionManager: SessionManager | undefined;
    const { session } = fakeRunSession();
    const createSession = async (options: Record<string, unknown>) => {
      capturedSessionManager = options.sessionManager as SessionManager;
      return { session: session as never };
    };

    await runSingleTask(
      { agent: "scout", task: "continue it" },
      makeAgent(),
      undefined,
      {
        cwd: runCwd,
        signal: undefined,
        modelRuntime: modelRuntimeStub,
        callerSessionFile,
        runId: "continue-call-b-1",
        mode: "tui" as const,
        seedSessionFile: seedFile,
        createSession: createSession as never,
        homeDir: callerCwd,
      },
    );

    const newEntries = (capturedSessionManager as SessionManager).getEntries();
    const synthetic = newEntries.filter((e) => e.type === "message" && (e.message as { role?: string }).role === "toolResult");
    assert.equal(synthetic.length, 1);
    const syntheticMessage = (synthetic[0] as { message: unknown }).message as {
      role: string;
      toolCallId: string;
      toolName?: string;
      content: Array<{ text?: string }>;
    };
    // toolName comes from the same assistant toolCall block that opened the
    // dangling pair (danglingToolCalls attaches it; no second scan).
    assert.equal(syntheticMessage.toolName, "read");
    assert.equal(syntheticMessage.toolCallId, "toolu_dangle");
    assert.equal(
      syntheticMessage.content.some((block) => block.text?.includes("[interrupted: the previous attempt ended before this tool call returned a result]")),
      true,
    );

    // The forked file on disk ends with the repair, and the seed file
    // carries none of it.
    const forkedText = fs.readFileSync(capturedSessionManager!.getSessionFile()!, "utf8");
    assert.match(forkedText, /\[interrupted: the previous attempt ended before this tool call returned a result\]/);
    assert.equal(fs.readFileSync(seedFile, "utf8"), seedBefore);
    assert.doesNotMatch(seedBefore, /\[interrupted:/);
  } finally {
    fs.rmSync(callerCwd, { recursive: true, force: true });
    fs.rmSync(runCwd, { recursive: true, force: true });
  }
});

// An empty/invalid seed: forkFrom throws inside createSubagentSessionManager,
// the run continues on a real in-memory session, and the fallback warning
// flows out of runSingleTask's emitWarnings — naming the agent and the error.
test("runSingleTask: an invalid seed file degrades to an in-memory session with a warning", async (t) => {
  const callerCwd = makeTmpDir();
  const runCwd = makeTmpDir();
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(String(args[0])); });
  try {
    const caller = persistedSessionOf(callerCwd, path.join(callerCwd, "sessions"));
    const callerSessionFile = caller.getSessionFile()!;
    const invalidSeed = path.join(callerCwd, "corrupt.jsonl");
    fs.writeFileSync(invalidSeed, "not valid json\n", "utf8");

    let capturedSessionManager: SessionManager | undefined;
    const { session } = fakeRunSession();
    const createSession = async (options: Record<string, unknown>) => {
      capturedSessionManager = options.sessionManager as SessionManager;
      return { session: session as never };
    };

    const result = await runSingleTask(
      { agent: "scout", task: "x" },
      makeAgent(),
      undefined,
      {
        cwd: runCwd,
        signal: undefined,
        modelRuntime: modelRuntimeStub,
        callerSessionFile,
        runId: "continue-call-c-1",
        mode: "tui" as const,
        seedSessionFile: invalidSeed,
        createSession: createSession as never,
        homeDir: callerCwd,
      },
    );

    assert.equal(result.status, "success");
    assert.ok(capturedSessionManager instanceof SessionManager);
    assert.equal(capturedSessionManager!.isPersisted(), false, "expected the in-memory fallback");
    assert.ok(warnings.some((w) => w.includes("scout") && w.includes("seed")));
  } finally {
    fs.rmSync(callerCwd, { recursive: true, force: true });
    fs.rmSync(runCwd, { recursive: true, force: true });
  }
});
