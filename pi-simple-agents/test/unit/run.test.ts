import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { buildPiInvocation, runAgent, failureMessage } from "../../src/run.ts";
import type { AgentConfig } from "../../src/agents.ts";
import type { SpawnLike } from "../../src/run.ts";

// Minimal fake ChildProcess: an EventEmitter with EventEmitter stdout/stderr,
// enough to drive "data" on stdout and "close" on the process itself.
// Cast via `as unknown as SpawnLike` when injected — its kill()/on() shapes
// are looser than SpawnLike's, and node:child_process types are not checked
// at test-run time anyway (--experimental-strip-types only strips types).
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  killCalls: string[] = [];
  unref(): void {}
  kill(signal: string): void {
    this.killCalls.push(signal);
  }
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "scout",
    description: "finds things",
    systemPromptMode: "append",
    inheritProjectContext: true,
    defaultReads: [],
    source: "user",
    filePath: "/agents/scout.md",
    ...overrides,
  };
}

test("failureMessage: aborted takes priority over stderr, exit code, and signal", () => {
  const message = failureMessage(1, "SIGTERM", "boom", true);

  assert.equal(message, "run was aborted");
});

test("failureMessage: non-empty stderr wins over exit code and signal when not aborted", () => {
  const message = failureMessage(2, "SIGTERM", "boom", false);

  assert.equal(message, "boom");
});

test("failureMessage: a non-null exit code names the code when stderr is empty and not aborted", () => {
  const message = failureMessage(2, null, "", false);

  assert.equal(message, "process exited with code 2");
});

test("failureMessage: a null code with a signal names the signal", () => {
  const message = failureMessage(null, "SIGKILL", "", false);

  assert.equal(message, "killed by signal SIGKILL");
});

test("failureMessage: a null code with no signal falls back to the unknown-signal message", () => {
  const message = failureMessage(null, null, "", false);

  assert.equal(message, "process was killed (unknown signal)");
});

test("buildPiInvocation: non-empty systemPrompt writes a temp file and passes --append-system-prompt pointing at it", () => {
  const agent = makeAgent({ systemPrompt: "You are a helpful scout." });

  const { args } = buildPiInvocation(agent, "find things", "test-run-id");

  const flagIndex = args.indexOf("--append-system-prompt");
  assert.notEqual(flagIndex, -1);
  const promptPath = args[flagIndex + 1]!;
  const content = fs.readFileSync(promptPath, "utf8");
  assert.equal(content, agent.systemPrompt);
});

test("buildPiInvocation: agent.tools is passed through as --tools", () => {
  const agent = makeAgent({ tools: ["read", "grep"] });

  const { args } = buildPiInvocation(agent, "find things", "test-run-id");

  const flagIndex = args.indexOf("--tools");
  assert.notEqual(flagIndex, -1);
  assert.equal(args[flagIndex + 1], "read,grep");
});

test("buildPiInvocation: empty/absent agent.tools omits --tools entirely", () => {
  const agent = makeAgent({ tools: [] });

  const { args } = buildPiInvocation(agent, "find things", "test-run-id");

  assert.equal(args.includes("--tools"), false);
});

test("buildPiInvocation: systemPromptMode 'replace' uses --system-prompt instead of --append-system-prompt", () => {
  const agent = makeAgent({
    systemPromptMode: "replace",
    systemPrompt: "You are a helpful scout.",
  });

  const { args } = buildPiInvocation(agent, "find things", "test-run-id");

  assert.equal(args.includes("--append-system-prompt"), false);
  const flagIndex = args.indexOf("--system-prompt");
  assert.notEqual(flagIndex, -1);
  const promptPath = args[flagIndex + 1]!;
  assert.equal(fs.readFileSync(promptPath, "utf8"), agent.systemPrompt);
});

test("buildPiInvocation: inheritProjectContext false passes --no-context-files", () => {
  const agent = makeAgent({ inheritProjectContext: false });

  const { args } = buildPiInvocation(agent, "find things", "test-run-id");

  assert.ok(args.includes("--no-context-files"));
});

test("buildPiInvocation: inheritProjectContext true (default) omits --no-context-files", () => {
  const agent = makeAgent({ inheritProjectContext: true });

  const { args } = buildPiInvocation(agent, "find things", "test-run-id");

  assert.equal(args.includes("--no-context-files"), false);
});

test("buildPiInvocation: non-empty defaultReads prefixes the task text with a read-these-first line", () => {
  const agent = makeAgent({ defaultReads: ["src/a.ts", "src/b.ts"] });

  const { args } = buildPiInvocation(agent, "find things", "test-run-id");

  const taskArg = args[args.length - 1]!;
  assert.equal(
    taskArg,
    "Task: Read these files first: src/a.ts, src/b.ts\n\nfind things",
  );
});

test("buildPiInvocation: empty defaultReads leaves task text unprefixed", () => {
  const agent = makeAgent({ defaultReads: [] });

  const { args } = buildPiInvocation(agent, "find things", "test-run-id");

  const taskArg = args[args.length - 1]!;
  assert.equal(taskArg, "Task: find things");
});

test("runAgent resolves success with finalText once the child emits a message_end chunk then closes with code 0", async () => {
  const fakeChild = new FakeChildProcess();
  const spawnFn = (() => fakeChild) as unknown as SpawnLike;

  const resultPromise = runAgent(makeAgent(), "find things", { cwd: "/cwd", spawnFn });

  fakeChild.stdout.emit(
    "data",
    Buffer.from(
      `${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "found the thing" }] },
      })}\n`,
    ),
  );
  fakeChild.emit("close", 0);

  const result = await resultPromise;

  assert.equal(result.status, "success");
  assert.equal(result.finalText, "found the thing");
  assert.equal(typeof result.durationMs, "number");
  assert.equal("error" in result, false);
});

test("runAgent resolves error with the accumulated stderr text once the child emits a stderr chunk then closes with a non-zero code", async () => {
  const fakeChild = new FakeChildProcess();
  const spawnFn = (() => fakeChild) as unknown as SpawnLike;

  const resultPromise = runAgent(makeAgent(), "find things", { cwd: "/cwd", spawnFn });

  fakeChild.stderr.emit("data", Buffer.from("boom"));
  fakeChild.emit("close", 2);

  const result = await resultPromise;

  assert.equal(result.status, "error");
  assert.equal(result.error, "boom");
});

test("runAgent resolves error naming the signal/unknown-exit case (not literally 'code null') when the child closes with a null code and no stderr", async () => {
  const fakeChild = new FakeChildProcess();
  const spawnFn = (() => fakeChild) as unknown as SpawnLike;

  const resultPromise = runAgent(makeAgent(), "find things", { cwd: "/cwd", spawnFn });

  fakeChild.emit("close", null);

  const result = await resultPromise;

  assert.equal(result.status, "error");
  assert.equal(typeof result.error, "string");
  assert.equal(/code null/.test(result.error ?? ""), false);
});

test("runAgent resolves exactly once from the error event when the child emits 'error' immediately followed by 'close', with the trailing close as a no-op", async () => {
  const fakeChild = new FakeChildProcess();
  const spawnFn = (() => fakeChild) as unknown as SpawnLike;

  const resultPromise = runAgent(makeAgent(), "find things", { cwd: "/cwd", spawnFn });

  fakeChild.emit("error", new Error("spawn ENOENT"));
  fakeChild.emit("close", 1);

  const result = await resultPromise;

  assert.equal(result.status, "error");
  assert.equal(result.error, "spawn ENOENT");
});

test("runAgent calls onProgress once per distinct progress text, deduping a repeated chunk", async () => {
  const fakeChild = new FakeChildProcess();
  const spawnFn = (() => fakeChild) as unknown as SpawnLike;
  const progressCalls: string[] = [];

  const resultPromise = runAgent(makeAgent(), "find things", {
    cwd: "/cwd",
    spawnFn,
    onProgress: (text) => progressCalls.push(text),
  });

  const toolExecutionEnd = (text: string) =>
    Buffer.from(
      `${JSON.stringify({
        type: "tool_execution_end",
        result: { content: [{ type: "text", text }] },
      })}\n`,
    );

  fakeChild.stdout.emit("data", toolExecutionEnd("reading files"));
  fakeChild.stdout.emit("data", toolExecutionEnd("reading files"));
  fakeChild.stdout.emit("data", toolExecutionEnd("writing output"));
  fakeChild.emit("close", 0);

  await resultPromise;

  assert.deepEqual(progressCalls, ["reading files", "writing output"]);
});

test("runAgent resolves { status: 'error', error: <thrown message> } (never rejects) when spawnFn throws synchronously, and deletes the temp prompt file buildPiInvocation wrote", async () => {
  const agent = makeAgent({ systemPrompt: "You are a helpful scout." });
  let capturedPromptPath: string | undefined;
  const spawnFn = ((_command: string, args: string[]) => {
    const flagIndex = args.indexOf("--append-system-prompt");
    capturedPromptPath = args[flagIndex + 1];
    throw new Error("spawn ENOENT");
  }) as unknown as SpawnLike;

  const result = await runAgent(agent, "find things", { cwd: "/cwd", spawnFn });

  assert.equal(result.status, "error");
  assert.equal(result.error, "spawn ENOENT");
  assert.ok(capturedPromptPath, "expected buildPiInvocation to have written a temp prompt file");
  assert.equal(fs.existsSync(capturedPromptPath!), false);
});

test("runAgent kills the child with SIGTERM on abort, escalates to SIGKILL after killGraceMs if still open, and resolves an abort-named error once close fires", async () => {
  const fakeChild = new FakeChildProcess();
  const spawnFn = (() => fakeChild) as unknown as SpawnLike;
  const controller = new AbortController();

  const resultPromise = runAgent(makeAgent(), "find things", {
    cwd: "/cwd",
    spawnFn,
    signal: controller.signal,
    killGraceMs: 10,
  });

  controller.abort();

  assert.deepEqual(fakeChild.killCalls, ["SIGTERM"]);

  // Real small delay past killGraceMs (10ms) so the escalation timer fires.
  await new Promise((r) => setTimeout(r, 30));

  assert.deepEqual(fakeChild.killCalls, ["SIGTERM", "SIGKILL"]);

  fakeChild.emit("close", null, "SIGKILL");
  const result = await resultPromise;

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /abort/i);
});

test("runAgent deletes the temp prompt file once the child closes with code 0, when agent.systemPrompt is set", async () => {
  const agent = makeAgent({ systemPrompt: "You are a helpful scout." });
  const fakeChild = new FakeChildProcess();
  let capturedPromptPath: string | undefined;
  const spawnFn = ((_command: string, args: string[]) => {
    const flagIndex = args.indexOf("--append-system-prompt");
    capturedPromptPath = args[flagIndex + 1];
    return fakeChild;
  }) as unknown as SpawnLike;

  const resultPromise = runAgent(agent, "find things", { cwd: "/cwd", spawnFn });

  fakeChild.emit("close", 0);

  const result = await resultPromise;

  assert.equal(result.status, "success");
  assert.ok(capturedPromptPath, "expected buildPiInvocation to have written a temp prompt file");
  assert.equal(fs.existsSync(capturedPromptPath!), false);
});

test("runAgent cleans up the temp prompt file on the child-'error' settle path when agent.systemPrompt is set", async () => {
  const agent = makeAgent({ systemPrompt: "You are a helpful scout." });
  const fakeChild = new FakeChildProcess();
  let capturedPromptPath: string | undefined;
  const spawnFn = ((_command: string, args: string[]) => {
    const flagIndex = args.indexOf("--append-system-prompt");
    capturedPromptPath = args[flagIndex + 1];
    return fakeChild;
  }) as unknown as SpawnLike;

  const resultPromise = runAgent(agent, "find things", { cwd: "/cwd", spawnFn });

  fakeChild.emit("error", new Error("spawn ENOENT"));

  const result = await resultPromise;

  assert.equal(result.status, "error");
  assert.ok(capturedPromptPath, "expected buildPiInvocation to have written a temp prompt file");
  assert.equal(fs.existsSync(capturedPromptPath!), false);
});

test("runAgent resolves an abort-named error immediately without calling spawnFn when options.signal is already aborted", async () => {
  let spawnCalls = 0;
  const spawnFn = (() => {
    spawnCalls += 1;
    return new FakeChildProcess();
  }) as unknown as SpawnLike;
  const controller = new AbortController();
  controller.abort();

  const result = await runAgent(makeAgent(), "find things", {
    cwd: "/cwd",
    spawnFn,
    signal: controller.signal,
  });

  assert.equal(spawnCalls, 0);
  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /abort/i);
});
