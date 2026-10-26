import { test } from "node:test";
import assert from "node:assert/strict";
import { styleMarkdown } from "../../src/markdown-style.ts";
import type { MarkdownPalette } from "../../src/markdown-theme.ts";
import {
  DIM_OFF,
  DIM_ON,
  FG_DEFAULT,
  ITALIC_OFF,
  ITALIC_ON,
  UNDERLINE_OFF,
  UNDERLINE_ON,
} from "../../src/tokens.ts";

const ACCENT = "\x1b[38;5;5m";
const QUOTE_OPEN = DIM_OFF + ACCENT;
const QUOTE_CLOSE = FG_DEFAULT + DIM_ON;

// The pass receives the palette as a value, so every case reads as arithmetic on
// the sequences instead of depending on a theme.
const palette: MarkdownPalette = {
  accent: ACCENT,
  quoteOpen: QUOTE_OPEN,
  quoteClose: QUOTE_CLOSE,
  signature: [ACCENT, QUOTE_OPEN, QUOTE_CLOSE].join("\u0000"),
};

// A monochrome theme: no color, so only the attributes are left to inject.
const COLORLESS: MarkdownPalette = { accent: "", quoteOpen: "", quoteClose: "", signature: "" };

function style(markdown: string, selected: MarkdownPalette = palette): string {
  return styleMarkdown(markdown, selected);
}

test("styleMarkdown: an inline code span gets its delimiters back as escaped text", () => {
  assert.equal(style("Run `npm test` first"), "Run \\`npm test\\` first");
});

test("styleMarkdown: every code span of a line is restored", () => {
  assert.equal(style("`a` and `b`"), "\\`a\\` and \\`b\\`");
});

test("styleMarkdown: a code span is restored inside a list item, a link and a table cell", () => {
  assert.equal(style("- use `tsc` here"), "- use \\`tsc\\` here");
  assert.equal(style("[the `--watch` flag](https://example.com)"), "[the \\`--watch\\` flag](https://example.com)");
  assert.equal(style("| `a` | b |"), "| \\`a\\` | b |");
});

test("styleMarkdown: a code span inside a quote keeps the quote pair around it", () => {
  assert.equal(style("> run `x` now"), `> ${QUOTE_OPEN}run \\\`x\\\` now${QUOTE_CLOSE}`);
});

test("styleMarkdown: a code span inside a heading keeps the heading style around it", () => {
  assert.equal(
    style("## Run `x`"),
    `## ${ACCENT}${UNDERLINE_ON}Run \\\`x\\\`${UNDERLINE_OFF}${FG_DEFAULT}`,
  );
});

test("styleMarkdown: an already escaped backtick leaves the line alone", () => {
  // The model wrote the delimiters itself: escaping them again would print the
  // backslashes and lose the span.
  assert.equal(style("Run \\`npm test\\` first"), "Run \\`npm test\\` first");
});

test("styleMarkdown: a span whose text ends in a backslash leaves the line alone", () => {
  assert.equal(style("Run `a\\` now"), "Run `a\\` now");
});

test("styleMarkdown: a lone backtick leaves the line alone until its pair arrives", () => {
  assert.equal(style("Run `npm test first"), "Run `npm test first");
});

test("styleMarkdown: a multi-backtick span is not touched", () => {
  assert.equal(style("Use ``a`b`` here"), "Use ``a`b`` here");
});

test("styleMarkdown: a code span inside a fence body is not touched", () => {
  const markdown = "```md\nRun `npm test` first\n```\n";
  assert.equal(style(markdown), markdown);
});

test("styleMarkdown: every heading level takes the accent and the level decides the attribute", () => {
  assert.equal(style("# Title"), `# ${ACCENT}${ITALIC_ON}Title${ITALIC_OFF}${FG_DEFAULT}`);
  assert.equal(style("## Title"), `## ${ACCENT}${UNDERLINE_ON}Title${UNDERLINE_OFF}${FG_DEFAULT}`);
  assert.equal(style("### Title"), `### ${ACCENT}${ITALIC_ON}Title${ITALIC_OFF}${FG_DEFAULT}`);
  // h4-h6 add no attribute: the host keeps them bold and the renderer prints their
  // `#` prefix, which is what tells them apart.
  assert.equal(style("#### Title"), `#### ${ACCENT}Title${FG_DEFAULT}`);
  assert.equal(style("##### Title"), `##### ${ACCENT}Title${FG_DEFAULT}`);
  assert.equal(style("###### Title"), `###### ${ACCENT}Title${FG_DEFAULT}`);
});

test("styleMarkdown: a heading takes the accent without re-injecting it after an inline span", () => {
  const styled = style("# **bold** tail");
  assert.equal(styled, `# ${ACCENT}${ITALIC_ON}**bold** tail${ITALIC_OFF}${FG_DEFAULT}`);
  // Accepted behaviour of the injected route: the host re-opens its own heading
  // color after the bold run, so the accent appears once, never after the inline.
  assert.equal(styled.split(ACCENT).length - 1, 1);
});

test("styleMarkdown: an empty heading is not touched", () => {
  assert.equal(style("## "), "## ");
  assert.equal(style("##"), "##");
});

test("styleMarkdown: a heading inside a fence body is not touched", () => {
  const markdown = "```md\n# Title\n```\n";
  assert.equal(style(markdown), markdown);
});

test("styleMarkdown: setext headings are not touched", () => {
  const markdown = "Title\n=====\n";
  assert.equal(style(markdown), markdown);
});

test("styleMarkdown: up to three spaces of indentation still open a heading", () => {
  assert.equal(style("   # Title"), `   # ${ACCENT}${ITALIC_ON}Title${ITALIC_OFF}${FG_DEFAULT}`);
  // Four spaces are an indented code block, so the line is body text.
  assert.equal(style("    # Title"), "    # Title");
});

test("styleMarkdown: a quote line wraps its text in the quote pair after every marker", () => {
  assert.equal(style("> quoted"), `> ${QUOTE_OPEN}quoted${QUOTE_CLOSE}`);
  assert.equal(style("> > nested"), `> > ${QUOTE_OPEN}nested${QUOTE_CLOSE}`);
});

test("styleMarkdown: each line of a multi-line quote gets its own pair", () => {
  assert.equal(style("> one\n> two"), `> ${QUOTE_OPEN}one${QUOTE_CLOSE}\n> ${QUOTE_OPEN}two${QUOTE_CLOSE}`);
});

test("styleMarkdown: a quote line with no text is not touched", () => {
  assert.equal(style(">"), ">");
  assert.equal(style("> "), "> ");
});

test("styleMarkdown: a monochrome theme keeps the heading attributes and drops the colors", () => {
  assert.equal(style("# Title", COLORLESS), `# ${ITALIC_ON}Title${ITALIC_OFF}`);
  assert.equal(style("## Title", COLORLESS), `## ${UNDERLINE_ON}Title${UNDERLINE_OFF}`);
  // Nothing left to inject at all, so the line is returned exactly as it came.
  assert.equal(style("#### Title", COLORLESS), "#### Title");
  assert.equal(style("> quoted", COLORLESS), "> quoted");
});

test("styleMarkdown: a second pass over the same text changes nothing", () => {
  const markdown = "# Title\n\n> quote with `code`\n\n- item `x`\n\n```js\nconst x = 1;\n```\n";
  const once = style(markdown);
  assert.notEqual(once, markdown);
  // The guard for lines that already carry a sequence is what makes this hold: a
  // restyle would nest the previous pair inside the new one.
  assert.equal(style(once), once);
});
