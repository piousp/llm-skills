import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import type { HighlightFn } from "../../src/highlight.ts";
import {
  buildReadResultText,
  readPath,
  splitReadNotice,
  type ReadResultInput,
} from "../../src/render-read.ts";
import { TOKEN } from "../../src/tokens.ts";

const fakeTheme = {
  fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
  bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
  bold: (t: string) => `<b>${t}</b>`,
};

const EXPAND_HINT = "<hint>";
const FOOTER_2 = "<muted>\n... (2 more lines,</muted> <hint><muted>)</muted>";

interface HighlightCall {
  code: string;
  lang: string;
}

function makeHighlight(calls: HighlightCall[]): HighlightFn {
  return (code, lang) => {
    calls.push({ code, lang });
    return code.split("\n").map((line) => `<${lang}>${line}</${lang}>`);
  };
}

function readInput(overrides: Partial<ReadResultInput> = {}): ReadResultInput {
  return {
    output: "",
    path: "",
    details: undefined,
    expanded: true,
    isError: false,
    hasImage: false,
    theme: fakeTheme,
    expandHint: EXPAND_HINT,
    highlight: makeHighlight([]),
    ...overrides,
  };
}

function plain(content: string): string {
  return `<toolOutput>${content}</toolOutput>`;
}

function lines(rendered: string[]): string {
  return ["", ...rendered].join("\n");
}

test("buildReadResultText: a collapsed result with no failure renders nothing", () => {
  assert.equal(buildReadResultText(readInput({ output: "a\nb", expanded: false })), "");
});

test("buildReadResultText: a file with a grammar is highlighted in a single call", () => {
  const calls: HighlightCall[] = [];
  const output = "const a = 1;\nconst b = 2;";
  const text = buildReadResultText(readInput({ output, path: "a.ts", highlight: makeHighlight(calls) }));
  assert.deepEqual(calls, [{ code: output, lang: "typescript" }]);
  assert.equal(
    text,
    lines([
      "<typescript>const a = 1;</typescript>",
      "<typescript>const b = 2;</typescript>",
    ]),
  );
});

test("buildReadResultText: a continuation notice leaves the highlighted block and is painted as a notice", () => {
  const notice = "3 more lines in file. Use offset=3 to continue.";
  const calls: HighlightCall[] = [];
  const text = buildReadResultText(
    readInput({ output: `a\nb\n\n[${notice}]`, path: "a.ts", highlight: makeHighlight(calls) }),
  );
  // Only the file's own lines reach the tokenizer: the notice is a message, not
  // code, and painting it as code is what this package fixes.
  assert.deepEqual(calls, [{ code: "a\nb", lang: "typescript" }]);
  assert.equal(
    text,
    lines(["<typescript>a</typescript>", "<typescript>b</typescript>"]) +
      `\n<warning>[${notice}]</warning>`,
  );
});

test("buildReadResultText: the truncation continuation notice is recognized with and without the byte limit", () => {
  assert.equal(TOKEN.notice, "warning");
  for (const notice of [
    "Showing lines 1-1 of 5000. Use offset=2 to continue.",
    `Showing lines 1-1 of 5000 (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=2 to continue.`,
  ]) {
    const text = buildReadResultText(readInput({ output: `a\n\n[${notice}]` }));
    assert.equal(text, lines([plain("a")]) + `\n<warning>[${notice}]</warning>`);
  }
});

test("splitReadNotice: a bracket block that is not one of the tool's notices stays in the body", () => {
  for (const trailing of ["[not a notice]", "[3 more lines]", "[Showing lines 1-2 of 3]"]) {
    const output = `a\n\n${trailing}`;
    assert.deepEqual(splitReadNotice(output, false), { body: output, notice: undefined });
  }
});

test("splitReadNotice: a notice without the blank separator stays in the body", () => {
  // A file can end with a line that reads exactly like the notice, which is why
  // the separator the tool prints is part of what makes a notice a notice.
  const output = "a\n[3 more lines in file. Use offset=3 to continue.]";
  assert.deepEqual(splitReadNotice(output, false), { body: output, notice: undefined });
});

test("splitReadNotice: the oversized-first-line message is the whole output and loses its brackets", () => {
  const message = "[Line 1 is 8.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' a.ts | head -c 51200]";
  assert.deepEqual(splitReadNotice(message, true), {
    body: "",
    notice: message.slice(1, -1),
  });
  assert.deepEqual(splitReadNotice("", true), { body: "", notice: undefined });
});

test("buildReadResultText: an oversized first line reports both notices", () => {
  const message = `[Line 1 is 8.0KB, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '1p' a.ts | head -c 51200]`;
  const text = buildReadResultText(
    readInput({
      output: message,
      path: "a.ts",
      details: { truncation: { truncated: true, firstLineExceedsLimit: true, maxBytes: DEFAULT_MAX_BYTES } },
    }),
  );
  assert.equal(
    text,
    `\n<warning>${message}</warning>\n<warning>[First line exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit]</warning>`,
  );
});

test("buildReadResultText: line truncation keeps the built-in wording and its default limit", () => {
  const recorded = buildReadResultText(
    readInput({
      output: "a",
      details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 10, totalLines: 500, maxLines: 10 } },
    }),
  );
  assert.equal(recorded, lines([plain("a")]) + "\n<warning>[Truncated: showing 10 of 500 lines (10 line limit)]</warning>");

  const defaulted = buildReadResultText(
    readInput({ output: "a", details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 10, totalLines: 500 } } }),
  );
  assert.equal(
    defaulted,
    lines([plain("a")]) +
      `\n<warning>[Truncated: showing 10 of 500 lines (${DEFAULT_MAX_LINES} line limit)]</warning>`,
  );
});

test("buildReadResultText: byte truncation reports the shown lines and the limit", () => {
  const text = buildReadResultText(
    readInput({
      output: "a",
      details: { truncation: { truncated: true, truncatedBy: "bytes", outputLines: 7, maxBytes: 1024 } },
    }),
  );
  assert.equal(text, lines([plain("a")]) + `\n<warning>[Truncated: 7 lines shown (${formatSize(1024)} limit)]</warning>`);
});

test("buildReadResultText: an untruncated result carries no truncation line", () => {
  const text = buildReadResultText(readInput({ output: "a", details: { truncation: { truncated: false } } }));
  assert.equal(text, lines([plain("a")]));
});

test("buildReadResultText: an expanded error is painted flat, with no grammar", () => {
  assert.equal(TOKEN.content, "toolOutput");
  const calls: HighlightCall[] = [];
  const text = buildReadResultText(
    readInput({ output: "boom\nsecond", path: "a.ts", isError: true, highlight: makeHighlight(calls) }),
  );
  assert.equal(text, lines([plain("boom"), plain("second")]));
  assert.deepEqual(calls, []);
});

test("buildReadResultText: a collapsed error keeps ten lines and counts the rest", () => {
  const output = Array.from({ length: 12 }, (_, index) => `line${index + 1}`).join("\n");
  const visible = Array.from({ length: 10 }, (_, index) => plain(`line${index + 1}`));
  assert.equal(buildReadResultText(readInput({ output, isError: true, expanded: false })), lines(visible) + FOOTER_2);
});

test("buildReadResultText: an image result is not file text and gets no grammar", () => {
  const text = buildReadResultText(readInput({ output: "a screenshot", path: "a.png", hasImage: true }));
  assert.equal(text, lines([plain("a screenshot")]));
});

test("buildReadResultText: a path with no known grammar never reaches the highlighter", () => {
  const calls: HighlightCall[] = [];
  const text = buildReadResultText(readInput({ output: "plain text", path: "notes", highlight: makeHighlight(calls) }));
  assert.equal(text, lines([plain("plain text")]));
  assert.deepEqual(calls, []);
});

test("buildReadResultText: trailing empty lines are dropped from the body and the count", () => {
  const text = buildReadResultText(readInput({ output: "a\nb\n\n\n" }));
  assert.equal(text, lines([plain("a"), plain("b")]));
});

test("buildReadResultText: a blank line in the middle is painted like any other line", () => {
  const text = buildReadResultText(readInput({ output: "a\n\nb" }));
  assert.equal(text, lines([plain("a"), plain(""), plain("b")]));
});

test("buildReadResultText: tabs are expanded before the line is painted", () => {
  const text = buildReadResultText(readInput({ output: "\tindented" }));
  assert.equal(text, lines([plain("   indented")]));
});

test("buildReadResultText: a highlighter that throws still renders the body", () => {
  const failing: HighlightFn = () => {
    throw new Error("no grammar");
  };
  const text = buildReadResultText(readInput({ output: "const a = 1;", path: "a.ts", highlight: failing }));
  assert.equal(text, lines([plain("const a = 1;")]));
});

test("readPath: file_path wins over path and a non-string argument is no path at all", () => {
  assert.equal(readPath({ file_path: "a.ts" }), "a.ts");
  assert.equal(readPath({ path: "b.ts" }), "b.ts");
  assert.equal(readPath({ file_path: "a.ts", path: "b.ts" }), "a.ts");
  assert.equal(readPath({ path: 42 }), "");
  assert.equal(readPath({}), "");
  assert.equal(readPath(undefined), "");
});

test("buildReadResultText: an expanded body past four hundred lines is highlighted in one piece", () => {
  const calls: HighlightCall[] = [];
  const output = Array.from({ length: 500 }, (_, index) => `const v${index} = ${index};`).join("\n");
  const text = buildReadResultText(readInput({ output, path: "a.ts", highlight: makeHighlight(calls) }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].code.split("\n").length, 500);
  assert.match(text, /<typescript>const v499 = 499;<\/typescript>/);
});
