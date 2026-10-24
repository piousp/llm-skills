import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { buildGrepResultText, type GrepInput } from "../../src/render-grep.ts";
import { UNREADABLE_TEXT } from "../../src/grep-parse.ts";
import type { HighlightFn } from "../../src/highlight.ts";
import { BOLD_OFF, BOLD_ON, TOKEN } from "../../src/tokens.ts";

const fakeTheme = {
  fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
  bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
  bold: (t: string) => `<b>${t}</b>`,
};

const EXPAND_HINT = "<hint>";
const FOOTER_5 = "<muted>\n... (5 more lines,</muted> <hint><muted>)</muted>";

const NOTICE = "20 matches limit reached. Use limit=40 for more, or refine pattern";
// Eighteen matches, the blank separator grep prints, and the notice: twenty
// body lines in total.
const BODY_WITH_NOTICE = [
  ...Array.from({ length: 18 }, (_, index) => `a.ts:${index + 1}: line${index + 1}`),
  "",
  `[${NOTICE}]`,
].join("\n");

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

// Emphasis is inserted by visible column, so the fakes used with a pattern must
// not invent markup: `<typescript>` would count as characters on screen.
const plainHighlight: HighlightFn = (code) => code.split("\n");
const ansiHighlight: HighlightFn = (code) => code.split("\n").map((line) => `\x1b[36m${line}\x1b[39m`);

function plainPrefix(path: string, line: number): string {
  return `<accent>${path}</accent><dim>:</dim><syntaxNumber>${line}</syntaxNumber><dim>:</dim>`;
}

// A match line bolds the path; the unreadable line keeps the same prefix with
// the accent color alone, which is why both forms are spelled out here.
function matchLine(path: string, line: number, styledText: string): string {
  return `<b><accent>${path}</accent></b><dim>:</dim><syntaxNumber>${line}</syntaxNumber><dim>:</dim> ${styledText}`;
}

function contextLine(path: string, line: number, styledText: string): string {
  return `<dim>${path}</dim>-<dim>${line}</dim>- ${styledText}`;
}

function grepInput(overrides: Partial<GrepInput> = {}): GrepInput {
  return {
    output: "",
    expanded: false,
    pattern: {},
    details: undefined,
    theme: fakeTheme,
    expandHint: EXPAND_HINT,
    highlight: makeHighlight([]),
    ...overrides,
  };
}

test("buildGrepResultText: three matches render in full with no footer", () => {
  const calls: HighlightCall[] = [];
  const text = buildGrepResultText(
    grepInput({
      output: "a.ts:1: one\na.ts:2: two\na.ts:3: three",
      highlight: makeHighlight(calls),
    }),
  );
  assert.equal(
    text,
    [
      "",
      matchLine("a.ts", 1, "<typescript>one</typescript>"),
      matchLine("a.ts", 2, "<typescript>two</typescript>"),
      matchLine("a.ts", 3, "<typescript>three</typescript>"),
    ].join("\n"),
  );
  assert.deepEqual(calls, [{ code: "one\ntwo\nthree", lang: "typescript" }]);
});

test("buildGrepResultText: twenty lines collapse to fifteen plus a footer", () => {
  const output = Array.from({ length: 20 }, (_, index) => `a.ts:${index + 1}: line${index + 1}`).join("\n");
  const visible = Array.from({ length: 15 }, (_, index) =>
    matchLine("a.ts", index + 1, `<typescript>line${index + 1}</typescript>`),
  );
  assert.equal(buildGrepResultText(grepInput({ output })), ["", ...visible].join("\n") + FOOTER_5);
});

test("buildGrepResultText: expanded shows every line and no footer", () => {
  const output = Array.from({ length: 20 }, (_, index) => `a.ts:${index + 1}: line${index + 1}`).join("\n");
  const all = Array.from({ length: 20 }, (_, index) =>
    matchLine("a.ts", index + 1, `<typescript>line${index + 1}</typescript>`),
  );
  assert.equal(buildGrepResultText(grepInput({ output, expanded: true })), ["", ...all].join("\n"));
});

test("buildGrepResultText: the unreadable marker is painted in the error color and its path stays unbolded", () => {
  assert.equal(TOKEN.broken, "error");
  const text = buildGrepResultText(grepInput({ output: "a.ts:9: (unable to read file)" }));
  assert.equal(text, ["", `${plainPrefix("a.ts", 9)} <error>(unable to read file)</error>`].join("\n"));
});

test("buildGrepResultText: the tool's own notice is a body line, so the footer counts it", () => {
  assert.equal(TOKEN.notice, "warning");
  // grep appends its limit block after a blank line, so the notice is the last of
  // the body's twenty lines and the blank line before it is one more.
  const visible = Array.from({ length: 15 }, (_, index) =>
    matchLine("a.ts", index + 1, `<typescript>line${index + 1}</typescript>`),
  );
  assert.equal(buildGrepResultText(grepInput({ output: BODY_WITH_NOTICE })), ["", ...visible].join("\n") + FOOTER_5);
  // The five that stay hidden include the notice, which is why the count matches
  // stock pi: it never separates the block from the lines above it.
  assert.equal(BODY_WITH_NOTICE.split("\n").length, 20);
});

test("buildGrepResultText: expanded shows the notice painted in the warning color", () => {
  const text = buildGrepResultText(grepInput({ output: BODY_WITH_NOTICE, expanded: true }));
  assert.equal(text.includes("more lines,"), false);
  assert.ok(
    text.endsWith(`\n<text></text>\n<warning>[${NOTICE}]</warning>`),
    `expected the blank line and the notice at the end of: ${text}`,
  );
});

test("buildGrepResultText: empty and blank outputs render nothing", () => {
  assert.equal(buildGrepResultText(grepInput({ output: "" })), "");
  assert.equal(buildGrepResultText(grepInput({ output: "  \n  " })), "");
});

test("buildGrepResultText: a path with no known language falls back to the content color", () => {
  assert.equal(TOKEN.content, "text");
  const calls: HighlightCall[] = [];
  const text = buildGrepResultText(grepInput({ output: "notes:12: plain text", highlight: makeHighlight(calls) }));
  assert.equal(text, ["", matchLine("notes", 12, "<text>plain text</text>")].join("\n"));
  assert.deepEqual(calls, []);
});

test("buildGrepResultText: contiguous lines of the same language are highlighted in one call per run", () => {
  const calls: HighlightCall[] = [];
  const output = "a.ts:1: one\na.ts:2: two\nREADME.md:3: doc\na.ts:4: four";
  const text = buildGrepResultText(grepInput({ output, highlight: makeHighlight(calls) }));
  assert.deepEqual(calls, [
    { code: "one\ntwo", lang: "typescript" },
    { code: "doc", lang: "markdown" },
    { code: "four", lang: "typescript" },
  ]);
  assert.equal(
    text,
    [
      "",
      matchLine("a.ts", 1, "<typescript>one</typescript>"),
      matchLine("a.ts", 2, "<typescript>two</typescript>"),
      matchLine("README.md", 3, "<markdown>doc</markdown>"),
      matchLine("a.ts", 4, "<typescript>four</typescript>"),
    ].join("\n"),
  );
});

test("buildGrepResultText: two files of the same language are highlighted in separate calls", () => {
  const calls: HighlightCall[] = [];
  const output = "a.ts:1: one\nb.ts:2: two";
  const text = buildGrepResultText(grepInput({ output, highlight: makeHighlight(calls) }));
  assert.deepEqual(calls, [
    { code: "one", lang: "typescript" },
    { code: "two", lang: "typescript" },
  ]);
  assert.equal(
    text,
    [
      "",
      matchLine("a.ts", 1, "<typescript>one</typescript>"),
      matchLine("b.ts", 2, "<typescript>two</typescript>"),
    ].join("\n"),
  );
});

test("buildGrepResultText: the lines of one file are highlighted in a single call", () => {
  const calls: HighlightCall[] = [];
  const output = "a.ts:1: one\na.ts:2: two\na.ts:3: three";
  buildGrepResultText(grepInput({ output, highlight: makeHighlight(calls) }));
  assert.deepEqual(calls, [{ code: "one\ntwo\nthree", lang: "typescript" }]);
});

test("buildGrepResultText: the unreadable marker is the shared constant, painted in the error color", () => {
  assert.equal(UNREADABLE_TEXT, "(unable to read file)");
  assert.equal(TOKEN.broken, "error");
  const text = buildGrepResultText(grepInput({ output: `a.ts:9: ${UNREADABLE_TEXT}` }));
  assert.equal(text, ["", `${plainPrefix("a.ts", 9)} <error>${UNREADABLE_TEXT}</error>`].join("\n"));
});

test("buildGrepResultText: context lines keep their dash separators, dim colors and unbolded path", () => {
  const calls: HighlightCall[] = [];
  const output = "a.ts:1: one\na.ts-2- two";
  const text = buildGrepResultText(grepInput({ output, highlight: makeHighlight(calls) }));
  assert.equal(
    text,
    ["", matchLine("a.ts", 1, "<typescript>one</typescript>"), contextLine("a.ts", 2, "<typescript>two</typescript>")].join(
      "\n",
    ),
  );
  assert.deepEqual(calls, [{ code: "one\ntwo", lang: "typescript" }]);
});

test("buildGrepResultText: the truncation warning lists the limits that were hit, in order", () => {
  const text = buildGrepResultText(
    grepInput({
      output: "notes:1: x",
      details: { matchLimitReached: 100, truncation: { truncated: true, maxBytes: 1048576 }, linesTruncated: true },
    }),
  );
  assert.equal(
    text,
    [
      "",
      matchLine("notes", 1, "<text>x</text>"),
      `<warning>[Truncated: 100 matches limit, ${formatSize(1048576)} limit, some lines truncated]</warning>`,
    ].join("\n"),
  );
});

test("buildGrepResultText: the matched span of a match line is bolded and inverted", () => {
  const text = buildGrepResultText(
    grepInput({
      output: "a.ts:1: export function foo",
      pattern: { pattern: "function", literal: true },
      highlight: plainHighlight,
    }),
  );
  assert.equal(text, ["", matchLine("a.ts", 1, `export ${BOLD_ON}function${BOLD_OFF} foo`)].join("\n"));
});

test("buildGrepResultText: ignoreCase emphasizes a differently cased occurrence", () => {
  const output = "a.ts:1: Function run";
  assert.equal(
    buildGrepResultText(
      grepInput({ output, pattern: { pattern: "function", ignoreCase: true }, highlight: plainHighlight }),
    ),
    ["", matchLine("a.ts", 1, `${BOLD_ON}Function${BOLD_OFF} run`)].join("\n"),
  );
  // Without the flag the same line stays plain.
  assert.equal(
    buildGrepResultText(grepInput({ output, pattern: { pattern: "function" }, highlight: plainHighlight })),
    ["", matchLine("a.ts", 1, "Function run")].join("\n"),
  );
});

test("buildGrepResultText: a literal pattern does not emphasize a regex lookalike", () => {
  const lookalike = "a.ts:1: aXb";
  assert.equal(
    buildGrepResultText(grepInput({ output: lookalike, pattern: { pattern: "a.b" }, highlight: plainHighlight })),
    ["", matchLine("a.ts", 1, `${BOLD_ON}aXb${BOLD_OFF}`)].join("\n"),
  );
  assert.equal(
    buildGrepResultText(
      grepInput({ output: lookalike, pattern: { pattern: "a.b", literal: true }, highlight: plainHighlight }),
    ),
    ["", matchLine("a.ts", 1, "aXb")].join("\n"),
  );
  // The literal pattern still matches itself.
  assert.equal(
    buildGrepResultText(
      grepInput({ output: "a.ts:2: x a.b y", pattern: { pattern: "a.b", literal: true }, highlight: plainHighlight }),
    ),
    ["", matchLine("a.ts", 2, `x ${BOLD_ON}a.b${BOLD_OFF} y`)].join("\n"),
  );
});

test("buildGrepResultText: every occurrence on a match line gets its own pair of markers", () => {
  assert.equal(
    buildGrepResultText(
      grepInput({
        output: "a.ts:1: function add, function sub",
        pattern: { pattern: "function", literal: true },
        highlight: plainHighlight,
      }),
    ),
    ["", matchLine("a.ts", 1, `${BOLD_ON}function${BOLD_OFF} add, ${BOLD_ON}function${BOLD_OFF} sub`)].join("\n"),
  );
});

test("buildGrepResultText: the emphasis lands on the visible column of an already colored line", () => {
  const text = buildGrepResultText(
    grepInput({
      output: "a.ts:1: const functionName = 1",
      pattern: { pattern: "function", literal: true },
      highlight: ansiHighlight,
    }),
  );
  assert.equal(
    text,
    ["", matchLine("a.ts", 1, `\x1b[36mconst ${BOLD_ON}function${BOLD_OFF}Name = 1\x1b[39m`)].join("\n"),
  );
});

test("buildGrepResultText: the path and the line number are never emphasized", () => {
  const text = buildGrepResultText(
    grepInput({ output: "a.ts:1: foo", pattern: { pattern: "ts" }, highlight: plainHighlight }),
  );
  // `ts` is in the path only, so no emphasis marker is inserted and the prefix
  // is exactly what it is without a pattern; the path's weight is the bold every
  // match line carries, not an emphasis span.
  assert.equal(text, ["", matchLine("a.ts", 1, "foo")].join("\n"));
  assert.equal(text.includes(BOLD_ON), false);
});

test("buildGrepResultText: context lines are not emphasized", () => {
  const text = buildGrepResultText(
    grepInput({
      output: "a.ts:1: function one\na.ts-2- function two",
      pattern: { pattern: "function", literal: true },
      highlight: plainHighlight,
    }),
  );
  assert.equal(
    text,
    ["", matchLine("a.ts", 1, `${BOLD_ON}function${BOLD_OFF} one`), contextLine("a.ts", 2, "function two")].join("\n"),
  );
});

test("buildGrepResultText: without a usable pattern the output is byte-identical to the previous render", () => {
  const calls: HighlightCall[] = [];
  const output = "a.ts:1: one";
  const expected = ["", matchLine("a.ts", 1, "<typescript>one</typescript>")].join("\n");
  for (const pattern of [{}, { pattern: "" }, { pattern: 42 }, { pattern: null }]) {
    assert.equal(buildGrepResultText(grepInput({ output, pattern, highlight: makeHighlight(calls) })), expected);
  }
  assert.equal(expected.includes(BOLD_ON), false);
});
