import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentOutput } from "../../src/parse-output.ts";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

test("parseAgentOutput: extracts the last assistant message_end as finalText from a real stream", () => {
  const stdout = loadFixture("oracle-stream.jsonl");

  const { finalText } = parseAgentOutput(stdout);

  assert.ok(finalText);
  assert.match(finalText!, /Prueba de humo/);
  assert.match(finalText!, /Suggested execution prompt/);
});

test("parseAgentOutput: lastProgress reflects the last assistant/tool text seen, not just the final one", () => {
  const stdout = loadFixture("oracle-stream.jsonl");

  const { lastProgress } = parseAgentOutput(stdout);

  assert.ok(lastProgress);
});

test("parseAgentOutput: ignores non-assistant message_end (user/toolResult roles)", () => {
  const stdout = [
    JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "the task" }] } }),
    JSON.stringify({
      type: "message_end",
      message: { role: "toolResult", content: [{ type: "text", text: "tool output noise" }] },
    }),
  ].join("\n");

  const { finalText } = parseAgentOutput(stdout);

  assert.equal(finalText, undefined);
});

test("parseAgentOutput: joins multiple text content parts in a single assistant message", () => {
  const stdout = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "part one" },
        { type: "text", text: "part two" },
      ],
    },
  });

  const { finalText } = parseAgentOutput(stdout);

  assert.equal(finalText, "part one\npart two");
});

test("parseAgentOutput: uses the LAST assistant message_end, not the first", () => {
  const stdout = [
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "final answer" }] },
    }),
  ].join("\n");

  const { finalText } = parseAgentOutput(stdout);

  assert.equal(finalText, "final answer");
});

test("parseAgentOutput: tool_execution_end contributes to lastProgress but not finalText", () => {
  const stdout = [
    JSON.stringify({
      type: "tool_execution_end",
      toolName: "read",
      result: { content: [{ type: "text", text: "file contents here" }] },
    }),
  ].join("\n");

  const { finalText, lastProgress } = parseAgentOutput(stdout);

  assert.equal(finalText, undefined);
  assert.equal(lastProgress, "file contents here");
});

test("parseAgentOutput: skips malformed JSON lines without throwing (handles chunk-split buffers)", () => {
  const stdout = [
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    }),
    "{not valid json",
    "",
  ].join("\n");

  const { finalText } = parseAgentOutput(stdout);

  assert.equal(finalText, "ok");
});

test("parseAgentOutput: empty stdout returns both fields undefined", () => {
  const { finalText, lastProgress } = parseAgentOutput("");

  assert.equal(finalText, undefined);
  assert.equal(lastProgress, undefined);
});

