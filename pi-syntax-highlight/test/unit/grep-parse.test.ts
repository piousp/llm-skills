import { test } from "node:test";
import assert from "node:assert/strict";
import { GREP_LINE_PATTERN, parseGrepLine, parseGrepOutput } from "../../src/grep-parse.ts";

test("parseGrepLine: a plain match carries path, line number and text", () => {
  assert.deepEqual(parseGrepLine("src/a.ts:12: const x = 1;"), {
    kind: "match",
    path: "src/a.ts",
    line: 12,
    text: "const x = 1;",
  });
});

test("parseGrepLine: colons and separators inside the matched text stay in the text", () => {
  assert.deepEqual(parseGrepLine("a.ts:3: foo:: bar: baz"), {
    kind: "match",
    path: "a.ts",
    line: 3,
    text: "foo:: bar: baz",
  });
});

test("parseGrepLine: a repeated dash separator is a context line", () => {
  assert.deepEqual(parseGrepLine("a.ts-12- some text"), {
    kind: "context",
    path: "a.ts",
    line: 12,
    text: "some text",
  });
});

test("parseGrepLine: a path containing a colon is not split at the colon", () => {
  assert.deepEqual(parseGrepLine("weird:name.ts:42: some text"), {
    kind: "match",
    path: "weird:name.ts",
    line: 42,
    text: "some text",
  });
});

test("parseGrepLine: a path containing a colon and digits is not split early", () => {
  assert.deepEqual(parseGrepLine("dir/sub:3/file.ts:9: some text"), {
    kind: "match",
    path: "dir/sub:3/file.ts",
    line: 9,
    text: "some text",
  });
});

// pi always writes a space after the line number, so a digit directly after
// the second separator can only belong to the path (`foo:3` is the file name).
test("parseGrepLine: digits without the trailing space belong to the path", () => {
  assert.deepEqual(parseGrepLine("foo:3:9: text"), {
    kind: "match",
    path: "foo:3",
    line: 9,
    text: "text",
  });
});

test("parseGrepLine: numeric text after the line number is not mistaken for the line", () => {
  assert.deepEqual(parseGrepLine("a.ts:7: 12: looks numeric"), {
    kind: "match",
    path: "a.ts",
    line: 7,
    text: "12: looks numeric",
  });
});

test("parseGrepLine: the unreadable marker drops the text", () => {
  assert.deepEqual(parseGrepLine("a.ts:9: (unable to read file)"), {
    kind: "unreadable",
    path: "a.ts",
    line: 9,
  });
});

test("parseGrepLine: mismatched separators are plain text", () => {
  assert.deepEqual(parseGrepLine("a-5: x"), { kind: "plain", text: "a-5: x" });
});

test("parseGrepLine: sentinels and blank lines are plain text", () => {
  for (const line of [
    "No matches found",
    "No files found matching pattern",
    "(empty directory)",
    "",
    "   ",
  ]) {
    assert.deepEqual(parseGrepLine(line), { kind: "plain", text: line });
  }
});

test("parseGrepLine: a match with empty text is still a match", () => {
  assert.deepEqual(parseGrepLine("a.ts:5: "), { kind: "match", path: "a.ts", line: 5, text: "" });
});

test("parseGrepOutput: keeps the block order and distinguishes matches from context", () => {
  const parsed = parseGrepOutput("a.ts:1: one\na.ts-2- two\na.ts:3: three");
  assert.deepEqual(
    parsed.map((entry) => entry.kind),
    ["match", "context", "match"],
  );
  assert.deepEqual(
    parsed.map((entry) =>
      entry.kind === "match" || entry.kind === "context" || entry.kind === "unreadable" ? entry.line : undefined,
    ),
    [1, 2, 3],
  );
  assert.deepEqual(parseGrepOutput(""), []);
});

test("parseGrepLine: a notice line is not classified as a match", () => {
  for (const line of ["[2 matches limit]", "[Truncated: 100 matches limit, some lines truncated]"]) {
    assert.deepEqual(parseGrepLine(line), { kind: "notice", text: line });
  }
});

test("GREP_LINE_PATTERN: named groups are the ones the parser reads", () => {
  const groups = GREP_LINE_PATTERN.exec("a.ts-8- text")?.groups;
  assert.equal(groups?.path, "a.ts");
  assert.equal(groups?.sep, "-");
  assert.equal(groups?.line, "8");
  assert.equal(groups?.text, "text");
});
