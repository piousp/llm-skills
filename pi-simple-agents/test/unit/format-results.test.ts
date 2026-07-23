import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRunResults } from "../../src/format-results.ts";
import type { AgentRunResult } from "../../src/run.ts";

test("formatRunResults: single success returns bare finalText, isError false", () => {
  const results: AgentRunResult[] = [
    { agent: "scout", task: "do the thing", status: "success", finalText: "hi", durationMs: 100 },
  ];

  const { text, isError } = formatRunResults(results);

  assert.equal(text, "hi");
  assert.equal(isError, false);
});

test("formatRunResults: single failure returns 'Agent \"<name>\" failed: <error>', isError true", () => {
  const results: AgentRunResult[] = [
    { agent: "scout", task: "do the thing", status: "error", error: "boom", durationMs: 100 },
  ];

  const { text, isError } = formatRunResults(results);

  assert.equal(text, 'Agent "scout" failed: boom');
  assert.equal(isError, true);
});

test("formatRunResults: parallel mixed results produce numbered sections in input order, isError false", () => {
  const results: AgentRunResult[] = [
    { agent: "scout", task: "do the thing", status: "success", finalText: "found it", durationMs: 100 },
    { agent: "builder", task: "do the thing", status: "error", error: "boom", durationMs: 100 },
  ];

  const { text, isError } = formatRunResults(results);

  assert.equal(
    text,
    "## 1. scout — success\nfound it\n\n## 2. builder — FAILED\nboom",
  );
  assert.equal(isError, false);
});

test("formatRunResults: parallel all-failed results set isError true", () => {
  const results: AgentRunResult[] = [
    { agent: "scout", task: "do the thing", status: "error", error: "boom", durationMs: 100 },
    { agent: "builder", task: "do the thing", status: "error", error: "bang", durationMs: 100 },
  ];

  const { text, isError } = formatRunResults(results);

  assert.equal(
    text,
    "## 1. scout — FAILED\nboom\n\n## 2. builder — FAILED\nbang",
  );
  assert.equal(isError, true);
});

test("formatRunResults: success without finalText uses literal fallback text", () => {
  const results: AgentRunResult[] = [
    { agent: "scout", task: "do the thing", status: "success", durationMs: 100 },
  ];

  const { text, isError } = formatRunResults(results);

  assert.equal(text, "(agent produced no final answer)");
  assert.equal(isError, false);
});

test("formatRunResults: success with empty-string finalText returns the empty string, not the fallback", () => {
  const results: AgentRunResult[] = [
    { agent: "scout", task: "do the thing", status: "success", finalText: "", durationMs: 100 },
  ];

  const { text } = formatRunResults(results);

  assert.equal(text, "");
});
