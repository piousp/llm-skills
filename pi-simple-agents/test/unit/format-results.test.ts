import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRunResult } from "../../src/format-results.ts";
import type { AgentRunResult } from "../../src/run.ts";

test("formatRunResult: success returns bare finalText, isError false", () => {
  const result: AgentRunResult = { agent: "scout", task: "do the thing", status: "success", finalText: "hi", durationMs: 100 };

  const { text, isError } = formatRunResult(result);

  assert.equal(text, "hi");
  assert.equal(isError, false);
});

test("formatRunResult: failure returns 'Agent \"<name>\" failed: <error>', isError true", () => {
  const result: AgentRunResult = { agent: "scout", task: "do the thing", status: "error", error: "boom", durationMs: 100 };

  const { text, isError } = formatRunResult(result);

  assert.equal(text, 'Agent "scout" failed: boom');
  assert.equal(isError, true);
});

test("formatRunResult: success without finalText uses literal fallback text", () => {
  const result: AgentRunResult = { agent: "scout", task: "do the thing", status: "success", durationMs: 100 };

  const { text, isError } = formatRunResult(result);

  assert.equal(text, "(agent produced no final answer)");
  assert.equal(isError, false);
});

test("formatRunResult: success with empty-string finalText returns the empty string, not the fallback", () => {
  const result: AgentRunResult = { agent: "scout", task: "do the thing", status: "success", finalText: "", durationMs: 100 };

  const { text } = formatRunResult(result);

  assert.equal(text, "");
});
