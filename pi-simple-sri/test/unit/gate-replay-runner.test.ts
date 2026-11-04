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
// M1c, spelled out for the same reason: the cap of the answer a check reads, counted in code points and not in UTF-16
// units.
const MAX_FINAL_TEXT_CODE_POINTS = 16_000;
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

// One text block of an answer: pi splits an answer into parts, and a test that wants two of them builds them.
function textPart(text: string): unknown {
  return { type: "text", text };
}

// One assistant message made of the parts a test names, for the shapes `assistantLine` does not cover: an answer of two
// text blocks, or a message that carries a thinking block and no answer at all.
function assistantWith(parts: readonly unknown[], stopReason = "stop"): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: parts,
      usage: { input: 10, output: 2 },
      stopReason,
      model: "deepseek-v4.1-flash",
      provider: "opencode-go",
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
  writeStderr(chunk: string): void;
  close(code: number | null): void;
  fail(error: Error): void;
}

// What the runner talks to, five lines per channel: a fake that records what was asked of it and lets
// the test decide when bytes, an exit or a failure arrive. The runner reaches the spawn synchronously,
// so a test writes and closes right after building the promise.
function createFakeChild(): FakeChild {
  const data: ((chunk: string | Buffer) => void)[] = [];
  const errData: ((chunk: string | Buffer) => void)[] = [];
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
      on: (_event: "data", listener: (chunk: string | Buffer) => void) => {
        errData.push(listener);
      },
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
    writeStderr: (chunk) => {
      for (const listener of errData) listener(chunk);
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

test("parseReplayStream takes the answer of the turn: the text of the last assistant message", () => {
  const parsed = parseReplayStream(fixture("turn-ok.jsonl"), SKILL_NAME);

  // The answer the recorded turn ended with, not the reasoning that produced it and not the tool call: a check of a
  // case reads what the user read.
  assert.equal(parsed.finalText.startsWith("El archivo no existe"), true);
  assert.equal(parsed.finalText.includes("PROBE-OK"), true);
  assert.equal(parsed.finalText.includes("The user asks"), false);
  assert.equal(parsed.finalText.includes("ls -la"), false);

  // The two fixtures recorded the same answer and differ in the result of the call, which is what makes their pair a
  // controlled comparison: the reading of the answer agrees while the reading of the run does not.
  assert.equal(parsed.finalText, parseReplayStream(fixture("turn-error.jsonl"), SKILL_NAME).finalText);
});

test("parseReplayStream takes the last assistant message, never the sum of the turn", () => {
  // A turn that answered twice answered with its second answer. Adding the two would let a check of a case match text
  // no single answer holds.
  const stream = lines(userLine(), assistantLine("PRIMERA-RESPUESTA"), assistantLine("SEGUNDA-RESPUESTA"));

  assert.equal(parseReplayStream(stream, SKILL_NAME).finalText, "SEGUNDA-RESPUESTA");
});

test("parseReplayStream joins the text blocks of one message and drops the ones that are not text", () => {
  const stream = lines(
    userLine(),
    assistantWith([
      { type: "thinking", thinking: "razonamiento que no es la respuesta" },
      textPart("PROBE-"),
      textPart("OK"),
      { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
    ]),
  );

  assert.equal(parseReplayStream(stream, SKILL_NAME).finalText, "PROBE-OK");
});

test("parseReplayStream answers with no text when the turn wrote none", () => {
  // The injected skill block and nothing else: no message answered.
  assert.equal(parseReplayStream(lines(userLine()), SKILL_NAME).finalText, "");
  // A turn cut in the middle of a round trip: a call and the reasoning that asked for it, no answer yet.
  const pending = lines(
    userLine(),
    callLine({ command: "ls" }),
    assistantWith([{ type: "thinking", thinking: "todavia no respondi" }]),
  );
  assert.equal(parseReplayStream(pending, SKILL_NAME).finalText, "");
  // And a stream nobody can parse: an answer is never invented from a line this parser does not read.
  assert.equal(parseReplayStream(lines("{not json"), SKILL_NAME).finalText, "");
});

test("parseReplayStream cuts the answer at 16000 code points without splitting one", () => {
  // Over the cap: the cut keeps the head, which is what a check reads, and the answer under it travels whole because a
  // cap is not a normal form.
  const long = parseReplayStream(lines(assistantLine("a".repeat(MAX_FINAL_TEXT_CODE_POINTS + 500))), SKILL_NAME).finalText;
  assert.equal(long, "a".repeat(MAX_FINAL_TEXT_CODE_POINTS));
  assert.equal(parseReplayStream(lines(assistantLine("PROBE-OK")), SKILL_NAME).finalText, "PROBE-OK");

  // An emoji is one code point and two UTF-16 units, and it straddles the boundary: a cut of sixteen thousand units
  // would leave half of it behind, which is a character nobody can compare and no check can match.
  const straddled = parseReplayStream(
    lines(assistantLine(`${"a".repeat(MAX_FINAL_TEXT_CODE_POINTS - 1)}😀${"b".repeat(10)}`)),
    SKILL_NAME,
  ).finalText;
  assert.equal(Array.from(straddled).length, MAX_FINAL_TEXT_CODE_POINTS);
  assert.equal(straddled, `${"a".repeat(MAX_FINAL_TEXT_CODE_POINTS - 1)}😀`);
  assert.equal(/[\uD800-\uDBFF]$/.test(straddled), false);
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
  // hand: a new field in ReplayRun breaks this test instead of passing unnoticed. The answer of the turn is taken out
  // with the calls because its text is long and it is asserted below against the bytes it came from.
  const { toolCalls, finalText, ...rest } = result;
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
  // M1c: the answer of the turn travels on the run, read from the same bytes the rest of the record came from.
  assert.equal(finalText, parseReplayStream(okStream, SKILL_NAME).finalText);
  assert.equal(finalText.startsWith("El archivo no existe"), true);
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
  // The answer too: a refused run keeps the text it answered with, and the evaluator is the one that refuses to judge it.
  assert.equal(result.finalText, "PROBE-OK");
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
  // M2: the message node reported is what tells ENOENT from EACCES, so it is on the record instead of
  // dropped with the listener that received it.
  assert.equal(result.invalidDetail, "spawn pi ENOENT");
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
  // M2: the exception is the whole cause of a spawn that never happened, and the record keeps it.
  assert.equal(result.invalidDetail, "EINVAL: the argv cannot be started");
});

test("a run whose child wrote to stderr keeps the last line of it, cut at 500 characters", async (t) => {
  const base = createFixture(t);
  const fake = createFakeChild();
  const run = runnerWith(fake)(request({ cwd: base }));

  // Two lines and a trailing newline: the tail is where a child that refuses says why.
  fake.writeStderr("warning: the model fell back to the default\n");
  fake.writeStderr(`${"x".repeat(600)}\n`);
  fake.write(fixture("turn-ok.jsonl"));
  fake.close(2);
  const result = await run;

  assert.equal(result.outcome, "invalid");
  assert.equal(result.invalidReason, "exit-code");
  assert.equal(result.invalidDetail, "x".repeat(500));
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

test("a stream over 2 MiB is truncated at a line boundary, says how long it was, and makes the run invalid", async (t) => {
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
  // M3 (OA10), fail-closed: a prefix that reads green is a prefix. The error of the turn can be past the cut,
  // so a truncated run never counts for the gate, whatever its head says.
  assert.equal(result.outcome, "invalid");
  assert.equal(result.invalidReason, "stream-truncated");
});
