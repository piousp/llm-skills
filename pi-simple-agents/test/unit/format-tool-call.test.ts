import { test } from "node:test";
import assert from "node:assert/strict";
import { formatToolCall } from "../../src/format-tool-call.ts";

test("formatToolCall: read with offset and limit renders a closed range", () => {
  const result = formatToolCall("read", { path: "foo.ts", offset: 10, limit: 31 });
  assert.equal(result, "read foo.ts:10-40");
});

test("formatToolCall: read with offset only renders an open range", () => {
  const result = formatToolCall("read", { path: "foo.ts", offset: 10 });
  assert.equal(result, "read foo.ts:10+");
});

test("formatToolCall: read with limit only renders a range starting at 1", () => {
  const result = formatToolCall("read", { path: "foo.ts", limit: 31 });
  assert.equal(result, "read foo.ts:1-31");
});

test("formatToolCall: read with no offset/limit renders bare path", () => {
  const result = formatToolCall("read", { path: "foo.ts" });
  assert.equal(result, "read foo.ts");
});

test("formatToolCall: read with missing path renders the bare tool name", () => {
  const result = formatToolCall("read", {});
  assert.equal(result, "read");
});

test("formatToolCall: write renders only the path, never the content", () => {
  const bigContent = "x".repeat(1000);
  const result = formatToolCall("write", { path: "foo.ts", content: bigContent });
  assert.equal(result, "write foo.ts");
  assert.ok(!result.includes("x"));
});

test("formatToolCall: edit renders path and edit count, never oldText/newText", () => {
  const result = formatToolCall("edit", {
    path: "foo.ts",
    edits: [
      { oldText: "secret-old", newText: "secret-new" },
      { oldText: "secret-old-2", newText: "secret-new-2" },
      { oldText: "secret-old-3", newText: "secret-new-3" },
    ],
  });
  assert.equal(result, "edit foo.ts (3 edits)");
  assert.ok(!result.includes("secret"));
});

test("formatToolCall: edit with non-array edits omits the count suffix", () => {
  const result = formatToolCall("edit", { path: "foo.ts" });
  assert.equal(result, "edit foo.ts");
});

test("formatToolCall: bash renders only the first line of the command, prefixed with $", () => {
  const result = formatToolCall("bash", { command: "ls -la\necho done" });
  assert.equal(result, "$ ls -la");
});

test("formatToolCall: grep renders pattern, path and glob", () => {
  const result = formatToolCall("grep", { pattern: "foo", path: "src", glob: "*.ts" });
  assert.equal(result, "grep /foo/ in src (*.ts)");
});

test("formatToolCall: grep with only a pattern omits path and glob", () => {
  const result = formatToolCall("grep", { pattern: "foo" });
  assert.equal(result, "grep /foo/");
});

test("formatToolCall: find renders pattern and path", () => {
  const result = formatToolCall("find", { pattern: "*.md", path: "docs" });
  assert.equal(result, "find *.md in docs");
});

test("formatToolCall: find with only a pattern omits the path", () => {
  const result = formatToolCall("find", { pattern: "*.md" });
  assert.equal(result, "find *.md");
});

test("formatToolCall: ls renders the path", () => {
  const result = formatToolCall("ls", { path: "src" });
  assert.equal(result, "ls src");
});

test("formatToolCall: ls with no path defaults to .", () => {
  const result = formatToolCall("ls", {});
  assert.equal(result, "ls .");
});

test("formatToolCall: unknown tool falls back to name + JSON args", () => {
  const result = formatToolCall("mystery", { k: "v" });
  assert.equal(result, 'mystery {"k":"v"}');
});

test("formatToolCall: unknown tool with circular args does not throw, falls back to bare name", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const result = formatToolCall("mystery", circular);
  assert.equal(result, "mystery");
});

test("formatToolCall: non-object args (undefined/null/number) render the bare tool name", () => {
  assert.equal(formatToolCall("read", undefined), "read");
  assert.equal(formatToolCall("read", null), "read");
  assert.equal(formatToolCall("read", 42), "read");
});

test("formatToolCall: output is truncated to a max width", () => {
  const longPath = "a".repeat(200) + ".ts";
  const result = formatToolCall("read", { path: longPath });
  assert.ok(result.length <= 80);
  assert.ok(result.endsWith("\u2026"));
});
