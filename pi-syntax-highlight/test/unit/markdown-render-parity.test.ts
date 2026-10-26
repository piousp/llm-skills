import { test } from "node:test";
import assert from "node:assert/strict";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createMarkdownTransformer } from "../../src/markdown-fence-lang.ts";
import { markdownPalette } from "../../src/markdown-theme.ts";
import { ITALIC_OFF, ITALIC_ON, type AnsiTheme } from "../../src/tokens.ts";

// The theme the host renders with lives on `globalThis` under this symbol and is the
// same object an extension receives as `ctx.ui.theme`; reading it is the only way to
// hand the transformer the colors the renderer below actually uses.
const HOST_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

initTheme("system");
const hostTheme = (globalThis as unknown as Record<symbol, AnsiTheme>)[HOST_THEME_KEY];

const WIDTH = 100;

// One transformer for the whole file, like the extension registers: the memo is the
// only state it has and every render below goes through it.
const transformer = createMarkdownTransformer({ resolveTheme: () => hostTheme });

function transform(markdown: string): string {
  return transformer(markdown, { messageType: "assistant", isStreaming: false, availableWidth: WIDTH });
}

// The markdown component the assistant message builds: no padding, no default text
// style, and the transformer only on the styled side.
function renderLines(markdown: string, styled: boolean): string[] {
  const options = styled ? { transform } : undefined;
  return new Markdown(markdown, 0, 0, getMarkdownTheme(), undefined, options).render(WIDTH);
}

function withoutBackticks(line: string): string {
  return line.replace(/`/g, "");
}

function trimEnd(line: string): string {
  return line.trimEnd();
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

// The corpus covers every construct the pass touches plus the ones it must leave
// alone. Every fence is labeled on purpose: an unlabeled one is relabeled by the
// fence stage, which is a visible change that stage owns and this contract does not.
const CORPUS: ReadonlyArray<{ name: string; markdown: string }> = [
  {
    name: "headings",
    markdown: "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n",
  },
  { name: "quotes", markdown: "> quoted text\n>\n> > nested quote\n> second line\n" },
  { name: "lists", markdown: "- one\n- two with `code`\n  - nested\n\n1. first\n2. second\n" },
  { name: "table", markdown: "| key | value |\n| --- | --- |\n| a | b |\n" },
  { name: "inline styles", markdown: "Some **bold**, *italic*, ~~struck~~ and `code` in one line.\n" },
  { name: "links", markdown: "See [the docs](https://example.com) and the [other `one`](https://example.org).\n" },
  { name: "js fence", markdown: "```js\nconst x = 1;\n```\n" },
  { name: "mermaid fence", markdown: "```mermaid\ngraph TD;\n  A-->B;\n```\n" },
  { name: "math fence", markdown: "```math\nx^2 + y^2\n```\n" },
  { name: "inline math", markdown: "The value $x^2$ stays inline.\n" },
  {
    name: "code spans in every context",
    markdown: "# Heading with `code`\n\n> quote with `code`\n\n- item with `code`\n\nText with `code` and `--flag`.\n",
  },
];

test("the rendered transcript keeps every visible character of the untransformed one", () => {
  for (const item of CORPUS) {
    const plain = renderLines(item.markdown, false);
    const transformed = renderLines(item.markdown, true);
    assert.equal(transformed.length, plain.length, item.name);
    const stripped = transformed.map(stripTerminalSequences);
    const expected = plain.map(stripTerminalSequences);
    // The restored delimiters of the inline code spans are the only visible
    // difference the pass is allowed to make. Right padding is layout, not text:
    // a line carrying two extra visible characters keeps the same total width and
    // therefore two spaces less, so the comparison is over trimmed lines.
    assert.deepEqual(stripped.map(withoutBackticks).map(trimEnd), expected.map(withoutBackticks).map(trimEnd), item.name);
    stripped.forEach((line, index) => {
      const plainLine = expected[index] ?? "";
      // Sequences take no column: the width the renderer measures for the styled
      // line is the width of its text, which is the untouched line plus the ticks.
      assert.equal(visibleWidth(transformed[index] ?? ""), visibleWidth(line), item.name);
      const added = occurrences(line, "`") - occurrences(plainLine, "`");
      // Padding equalizes both widths, so the column difference the delimiters add
      // is only observable on the trimmed lines.
      assert.equal(visibleWidth(line.trimEnd()), visibleWidth(plainLine.trimEnd()) + added, item.name);
    });
  }
});

test("every code span of the corpus comes back with its delimiters", () => {
  const stripped = renderLines(CORPUS[CORPUS.length - 1]?.markdown ?? "", true)
    .map(stripTerminalSequences)
    .join("\n");
  assert.ok(stripped.includes("`code`"));
  assert.ok(stripped.includes("`--flag`"));
});

test("the transformer injects the palette the live theme yields", () => {
  const palette = markdownPalette(hostTheme);
  const transformed = transform("# Title\n\n> quoted\n");
  // The attributes travel whatever the theme resolves the colors to, so these hold
  // even in a monochrome terminal, where the token maps to the default color.
  assert.ok(transformed.includes(`${ITALIC_ON}Title`));
  assert.ok(transformed.includes(ITALIC_OFF));
  assert.ok(!transformed.includes("\u001b[0m"));
  if (palette.accent !== "") assert.ok(transformed.includes(palette.accent));
  if (palette.quoteOpen !== "") assert.ok(transformed.includes(palette.quoteOpen));
});

test("a table cell with a code span keeps its text and only moves its columns", () => {
  const markdown = "| key | value |\n| --- | --- |\n| a | `b` |\n";
  const plain = renderLines(markdown, false).map(stripTerminalSequences);
  const styled = renderLines(markdown, true).map(stripTerminalSequences);
  // The restored ticks make one cell two columns wider and the renderer measures the
  // cell to lay the table out, so the padding moves. The content does not: taking the
  // padding and the ticks out of both renders leaves the same characters, and this is
  // the only construct where the two renders differ by more than the delimiters.
  assert.equal(
    styled.join("\n").replace(/[` ]/g, ""),
    plain.join("\n").replace(/[` ]/g, ""),
  );
  assert.ok(styled.join("\n").includes("`b`"));
});
