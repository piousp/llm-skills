import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReplayArgs,
  createReplayRunner,
  parseReplayStream,
} from "../../src/gate/replay-runner.ts";
import type {
  ReplayChild,
  ReplayRunnerOptions,
  ReplaySpawnOptions,
  SpawnReplayFn,
} from "../../src/gate/replay-runner.ts";
import type { ReplayRunRequest } from "../../src/gate/types.ts";
import { REPLAY_ENV_VAR } from "../../src/names.ts";

// The replay executor is exercised the way it runs: the argv without a process, the parser over the
// two streams pi 1.5.0 really wrote, and the runner over a fake child. No test here starts `pi`,
// reaches a provider or spends a token, and the two fixtures are data: the JSONL as the binary
// emitted it, read with node:fs, never rebuilt by a helper.

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
// OA10, spelled out here instead of imported: a test that read the cap from the module would agree
// with any cap, and the number is part of the contract.
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const SKILL_NAME = "demo-skill";
const PROMPT = "read the file missing-probe.txt and tell me what it says";
const INCUMBENT_DIR = "/staging/arms/incumbent/demo-skill";
const CANDIDATE_DIR = "/staging/arms/candidate/demo-skill";
const SHARED_DIR = "/skills/other-skill";
// The model the recorded failure used, in the spelling the runner passes through untouched (OA5).
const MODEL = "opencode-go/deepseek-v4.1-flash";

function fixture(name: string): string {
  return fs.readFileSync(fileURLToPath(new URL(`../fixtures/replay/${name}`, import.meta.url)), "utf8");
}

function request(overrides: Partial<ReplayRunRequest> = {}): ReplayRunRequest {
  return {
    item: 0,
    rep: 1,
    arm: "incumbent",
    prompt: PROMPT,
    skillName: SKILL_NAME,
    skillDirs: [INCUMBENT_DIR, SHARED_DIR],
    cwd: "/work/reports",
    model: MODEL,
    timeoutMs: 180_000,
    ...overrides,
  };
}

// One `message_end` of role user with pi's injected skill block, which is the only proof of loading a
// run carries.
function userLine(skillName: string = SKILL_NAME): string {
  const text = `<skill name="${skillName}" location="/tmp/skills/${skillName}/SKILL.md">\n\n# ${skillName}\n</skill>\n\n${PROMPT}`;
  return JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
}

function assistantLine(text: string, stopReason = "stop", usage = { input: 10, output: 2 }): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage,
      stopReason,
      model: "deepseek-v4.1-flash",
      provider: "opencode-go",
    },
  });
}

function callLine(args: unknown): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: args }],
      stopReason: "toolUse",
    },
  });
}

function lines(...entries: string[]): string {
  return `${entries.join("\n")}\n`;
}

interface SpawnRecord {
  command: string;
  args: readonly string[];
  options: ReplaySpawnOptions;
}

interface FakeChild {
  spawnFn: SpawnReplayFn;
  spawns: SpawnRecord[];
  kills: (NodeJS.Signals | number | undefined)[];
  write(chunk: string): void;
  close(code: number | null): void;
  fail(error: Error): void;
}

// What the runner talks to, five lines per channel: a fake that records what was asked of it and lets
// the test decide when bytes, an exit or a failure arrive. The runner reaches the spawn synchronously,
// so a test writes and closes right after building the promise.
function createFakeChild(): FakeChild {
  const data: ((chunk: string | Buffer) => void)[] = [];
  const closes: ((code: number | null) => void)[] = [];
  const errors: ((error: Error) => void)[] = [];
  const spawns: SpawnRecord[] = [];
  const kills: (NodeJS.Signals | number | undefined)[] = [];

  const child: ReplayChild = {
    stdout: {
      on: (_event: "data", listener: (chunk: string | Buffer) => void) => {
        data.push(listener);
      },
    },
    stderr: {
      on: (_event: "data", _listener: (chunk: string | Buffer) => void) => undefined,
    },
    kill: (signal) => {
      kills.push(signal);
      return true;
    },
    onClose: (listener) => {
      closes.push(listener);
    },
    onError: (listener) => {
      errors.push(listener);
    },
  };

  return {
    spawnFn: (command, args, options) => {
      spawns.push({ command, args, options });
      return child;
    },
    spawns,
    kills,
    write: (chunk) => {
      for (const listener of data) listener(chunk);
    },
    close: (code) => {
      for (const listener of closes) listener(code);
    },
    fail: (error) => {
      for (const listener of errors) listener(error);
    },
  };
}

function runnerWith(fake: FakeChild, options: Omit<ReplayRunnerOptions, "spawnFn"> = {}) {
  return createReplayRunner({ spawnFn: fake.spawnFn, ...options });
}

// The directory the run is started in: it has to exist, and every test that spawns passes it as the
// cwd, so a fake child never reads anything the test did not create.
function createFixture(t: TestContext): string {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-gate-runner-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  return base;
}

test("buildReplayArgs: the measured argv, one --skill per directory, -ns and no -ne", () => {
  const invocation = buildReplayArgs(request());

  assert.equal(invocation.command, "pi");
  assert.deepEqual(invocation.args, [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--model",
    MODEL,
    "--skill",
    INCUMBENT_DIR,
    "--skill",
    SHARED_DIR,
    "-ns",
    `/skill:${SKILL_NAME} ${PROMPT}`,
  ]);

  // OA8: extensions stay loaded, so the child sees the environment the failure was measured in.
  assert.equal(invocation.args.includes("-ne"), false);
  assert.equal(invocation.args.includes("--no-extensions"), false);
  // One space after the skill name and not two: pi cuts the name at the first space.
  assert.equal(invocation.args.at(-1), `/skill:${SKILL_NAME} ${PROMPT}`);
});

test("buildReplayArgs: the two arms differ in the skill directory and in nothing else", () => {
  const incumbent = buildReplayArgs(request({ arm: "incumbent", skillDirs: [INCUMBENT_DIR, SHARED_DIR] }));
  const candidate = buildReplayArgs(request({ arm: "candidate", skillDirs: [CANDIDATE_DIR, SHARED_DIR] }));

  assert.equal(incumbent.args.length, candidate.args.length);
  const differences = incumbent.args.filter((arg, index) => arg !== candidate.args[index]);
  assert.deepEqual(differences, [INCUMBENT_DIR]);
});

test("parseReplayStream over the passing stream: skill loaded, one call, summed usage, the stop", () => {
  const parsed = parseReplayStream(fixture("turn-ok.jsonl"), SKILL_NAME);

  // The block pi injects when `/skill:demo-skill` resolves is the proof the skill was loaded.
  assert.equal(parsed.skillLoaded, true);
  // Two assistant replies under one prompt: the tool round trip continues the same turn.
  assert.equal(parsed.assistantMessages, 2);
  assert.equal(parsed.lastStopReason, "stop");
  // Every line of the recorded stream is a message_end this parser reads.
  assert.equal(parsed.unparsedLines, 0);
  assert.deepEqual(parsed.usage, { input: 8454 + 8712, output: 169 + 181 });

  assert.equal(parsed.toolCalls.length, 1);
  const [call] = parsed.toolCalls;
  assert.equal(call.toolName, "bash");
  assert.equal(call.isError, false);
  assert.match(call.argsHash, HASH_PATTERN);
});

test("parseReplayStream over the failing stream: the error result joins its call", () => {
  const parsed = parseReplayStream(fixture("turn-error.jsonl"), SKILL_NAME);

  assert.equal(parsed.toolCalls.length, 1);
  const [call] = parsed.toolCalls;
  assert.equal(call.toolName, "bash");
  assert.equal(call.isError, true);
  // The two fixtures record the same call with the same arguments, so the digest agrees; only the
  // result differs, which is what makes the pair a controlled comparison.
  assert.equal(call.argsHash, parseReplayStream(fixture("turn-ok.jsonl"), SKILL_NAME).toolCalls[0].argsHash);
});

test("parseReplayStream hashes arguments canonically: key order does not change the call", () => {
  const left = parseReplayStream(lines(callLine({ command: "ls", timeout: 20 })), SKILL_NAME).toolCalls[0];
  const right = parseReplayStream(lines(callLine({ timeout: 20, command: "ls" })), SKILL_NAME).toolCalls[0];
  const other = parseReplayStream(lines(callLine({ command: "ls", timeout: 21 })), SKILL_NAME).toolCalls[0];

  assert.equal(left.argsHash, right.argsHash);
  assert.notEqual(left.argsHash, other.argsHash);
  assert.match(left.argsHash, HASH_PATTERN);
});

test("parseReplayStream skips an event of another version and a line that is not JSON, and counts them", () => {
  const stream = lines(
    // A tool event of another pi version: the tool event names changed between 1.4.0 and 1.5.0, so a
    // line this parser does not read is counted, never guessed.
    JSON.stringify({ type: "tool_result_end", toolName: "bash", isError: true }),
    JSON.stringify({ type: "message_start", message: { role: "assistant" } }),
    "{not json",
    "",
    userLine(),
  );

  const parsed = parseReplayStream(stream, SKILL_NAME);

  // The blank line is not a line of the stream, so it is neither parsed nor counted.
  assert.equal(parsed.unparsedLines, 3);
  assert.equal(parsed.skillLoaded, true);
  // Nothing was invented from the lines this parser could not read: no call, no turn, no cost.
  assert.deepEqual(parsed.toolCalls, []);
  assert.equal(parsed.assistantMessages, 0);
  assert.equal(parsed.lastStopReason, null);
  assert.deepEqual(parsed.usage, { input: 0, output: 0 });
});

test("parseReplayStream counts only the block of the skill it was asked about", () => {
  // `demo-skill-2` starts with the name this call is about; the closing quote is what tells them
  // apart, and a skill that did not load must never read as loaded.
  assert.equal(parseReplayStream(lines(userLine("demo-skill-2")), SKILL_NAME).skillLoaded, false);
  assert.equal(parseReplayStream(lines(userLine("other-skill")), SKILL_NAME).skillLoaded, false);
  assert.equal(parseReplayStream(lines(userLine()), SKILL_NAME).skillLoaded, true);
});

test("the runner records a completed run: the stream, the cost, the exit and the child's options", async (t) => {
  const base = createFixture(t);
  const fake = createFakeChild();
  const okStream = fixture("turn-ok.jsonl");
  const run = runnerWith(fake, { now: () => 0 })(request({ cwd: base }));

  // The runner reaches the spawn before it awaits, so the fake can answer in the same tick; the
  // assertions wait for the record, so a failure cannot leave a paused run behind.
  fake.write(okStream);
  fake.close(0);
  const result = await run;

  assert.equal(fake.spawns.length, 1);
  const [spawned] = fake.spawns;
  assert.equal(spawned.command, "pi");
  assert.deepEqual(spawned.args, buildReplayArgs(request({ cwd: base })).args);
  assert.equal(spawned.options.cwd, base);
  assert.equal(spawned.options.shell, false);
  assert.deepEqual(spawned.options.stdio, ["ignore", "pipe", "pipe"]);
  // OA8: the child is told it is a replay, and the parent's environment travels whole.
  assert.equal(REPLAY_ENV_VAR, "PI_SIMPLE_SRI_REPLAY");
  assert.equal(spawned.options.env[REPLAY_ENV_VAR], "1");
  assert.equal(spawned.options.env["PATH"], process.env["PATH"]);

  // The whole record is asserted field by field, minus the digest, which no test can recompute by
  // hand: a new field in ReplayRun breaks this test instead of passing unnoticed.
  const { toolCalls, ...rest } = result;
  assert.deepEqual(rest, {
    request: request({ cwd: base }),
    outcome: "pass",
    stopReason: "stop",
    usage: { input: 17166, output: 350 },
    durationMs: 0,
    exitCode: 0,
    skillLoaded: true,
    rawStream: okStream,
  });
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].toolName, "bash");
  assert.equal(toolCalls[0].isError, false);
  assert.match(toolCalls[0].argsHash, HASH_PATTERN);
});

test("a stream with no assistant message is unreadable, even when the skill block is there", async (t) => {
  const base = createFixture(t);
  const fake = createFakeChild();
  const run = runnerWith(fake)(request({ cwd: base }));

  fake.write(lines(userLine()));
  fake.close(0);
  const result = await run;

  assert.equal(result.outcome, "invalid");
  assert.equal(result.invalidReason, "stream-unparseable");
  // The skill did load: the run is refused because nothing answered, not because the skill is absent.
  assert.equal(result.skillLoaded, true);
  assert.equal(result.stopReason, null);
});

test("a stream with no skill block did not load the skill, whatever the answer says", async (t) => {
  const base = createFixture(t);
  const fake = createFakeChild();
  const run = runnerWith(fake)(request({ cwd: base }));

  fake.write(lines(assistantLine("PROBE-OK")));
  fake.close(0);
  const result = await run;

  assert.equal(result.outcome, "invalid");
  assert.equal(result.invalidReason, "skill-not-loaded");
  // What the child did say is still recorded: the run is refused, not erased.
  assert.equal(result.skillLoaded, false);
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.usage, { input: 10, output: 2 });
});

test("a child that never closes times out and is killed", async (t) => {
  const base = createFixture(t);
  const fake = createFakeChild();
  const run = runnerWith(fake)(request({ cwd: base, timeoutMs: 5 }));

  fake.write(userLine());
  const result = await run;

  assert.equal(result.outcome, "invalid");
  assert.equal(result.invalidReason, "timeout");
  // SIGTERM first; the SIGKILL that follows five seconds later is armed, not awaited.
  assert.deepEqual(fake.kills, ["SIGTERM"]);
  // The bytes written before the deadline are still in the record.
  assert.equal(result.rawStream, userLine());
  assert.equal(result.exitCode, null);
});

test("a non-zero exit is invalid with exit-code, and its stream is no verdict", async (t) => {
  const base = createFixture(t);
  const fake = createFakeChild();
  const run = runnerWith(fake)(request({ cwd: base }));

  fake.write(fixture("turn-ok.jsonl"));
  fake.close(2);
  const result = await run;

  assert.equal(result.outcome, "invalid");
  assert.equal(result.invalidReason, "exit-code");
  assert.equal(result.exitCode, 2);
  // A readable stream does not upgrade a broken run: infrastructure wins over content (OA3).
  assert.equal(result.skillLoaded, true);
});

test("a child that never started is a spawn error, not an exception", async (t) => {
  const base = createFixture(t);
  const fake = createFakeChild();
  const run = runnerWith(fake)(request({ cwd: base }));

  fake.fail(new Error("spawn pi ENOENT"));
  const result = await run;

  assert.equal(result.outcome, "invalid");
  assert.equal(result.invalidReason, "spawn-error");
  assert.equal(result.exitCode, null);
});

test("a spawn that throws is a spawn error, not an exception", async (t) => {
  const base = createFixture(t);
  const runner = createReplayRunner({
    spawnFn: () => {
      throw new Error("EINVAL: the argv cannot be started");
    },
  });

  const result = await runner(request({ cwd: base }));

  assert.equal(result.outcome, "invalid");
  assert.equal(result.invalidReason, "spawn-error");
});

test("an abort kills the child and the run is interrupted", async (t) => {
  const base = createFixture(t);
  const fake = createFakeChild();
  const controller = new AbortController();
  const run = runnerWith(fake)(request({ cwd: base, signal: controller.signal }));

  fake.write(fixture("turn-ok.jsonl"));
  controller.abort();
  const result = await run;

  assert.equal(result.outcome, "invalid");
  assert.equal(result.invalidReason, "interrupted");
  assert.deepEqual(fake.kills, ["SIGTERM"]);
});

test("a signal aborted before the run starts no child", async (t) => {
  const base = createFixture(t);
  const fake = createFakeChild();
  const controller = new AbortController();
  controller.abort();

  const result = await runnerWith(fake)(request({ cwd: base, signal: controller.signal }));

  assert.equal(result.outcome, "invalid");
  assert.equal(result.invalidReason, "interrupted");
  assert.deepEqual(fake.spawns, []);
  assert.deepEqual(fake.kills, []);
});

test("a cwd that does not exist is refused before anything is spawned", async (t) => {
  const base = createFixture(t);
  const fake = createFakeChild();
  const missing = path.join(base, "does-not-exist");

  const result = await runnerWith(fake)(request({ cwd: missing }));

  assert.equal(result.outcome, "invalid");
  assert.equal(result.invalidReason, "cwd-missing");
  assert.deepEqual(fake.spawns, []);
  assert.deepEqual(fake.kills, []);
});

test("a stream over 2 MiB is truncated at a line boundary and says how long it was", async (t) => {
  const base = createFixture(t);
  const fake = createFakeChild();
  const run = runnerWith(fake)(request({ cwd: base }));

  // 2500 lines of about 1 KiB: over the cap, and every line a whole JSON object.
  const stream = lines(userLine(), ...Array.from({ length: 2500 }, () => assistantLine("x".repeat(900))));
  fake.write(stream);
  fake.close(0);
  const result = await run;

  assert.equal(Buffer.byteLength(stream, "utf8") > MAX_STREAM_BYTES, true);
  assert.equal(result.truncatedAt, Buffer.byteLength(stream, "utf8"));
  assert.equal(Buffer.byteLength(result.rawStream, "utf8") <= MAX_STREAM_BYTES, true);
  // The cut moved back to the last complete line: the head is kept and nothing ends in half an object.
  assert.equal(result.rawStream.startsWith(userLine()), true);
  assert.equal(result.rawStream.endsWith("\n"), true);
  for (const line of result.rawStream.split("\n")) {
    if (line === "") continue;
    assert.doesNotThrow(() => JSON.parse(line));
  }
  // What the truncated prefix holds is still read: the skill block is in the head.
  assert.equal(result.skillLoaded, true);
  assert.equal(result.outcome, "pass");
});
