import { test } from "node:test";
import assert from "node:assert/strict";
import type { MarkdownTransformContext, MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { createMarkdownTransformer, transformFenceLanguages } from "../../src/markdown-fence-lang.ts";
import {
  DIM_OFF,
  DIM_ON,
  FG_DEFAULT,
  ITALIC_OFF,
  ITALIC_ON,
  UNDERLINE_OFF,
  UNDERLINE_ON,
  type AnsiTheme,
} from "../../src/tokens.ts";

const ACCENT = "\x1b[38;5;5m";
const NEXT_ACCENT = "\x1b[38;5;6m";
const ESCAPE = "\u001b";

// Same shape as the host's theme: the sequences live in a map that a theme switch
// rewrites under the same object, so the fake can show the memo reacting to a value
// change instead of a reference change.
function fakeTheme(): { theme: AnsiTheme; ansi: Record<string, string> } {
  const ansi: Record<string, string> = { accent: ACCENT, mdQuote: FG_DEFAULT + DIM_ON };
  return {
    ansi,
    theme: {
      getFgAnsi: (color) => ansi[color] ?? "",
      getBgAnsi: () => "",
    },
  };
}

function context(messageType: MarkdownTransformContext["messageType"]): MarkdownTransformContext {
  return { messageType, isStreaming: false, availableWidth: 80 };
}

function transformerFor(theme: AnsiTheme | undefined): MarkdownTransformer {
  return createMarkdownTransformer({ resolveTheme: () => theme });
}

// Every sequence the pass injects is opened and closed inside the same line, so a
// line wrapped by the renderer can never inherit a style from the one before it.
const SEQUENCE_PAIRS = [
  [ACCENT, FG_DEFAULT],
  [ITALIC_ON, ITALIC_OFF],
  [UNDERLINE_ON, UNDERLINE_OFF],
  [DIM_OFF, DIM_ON],
] as const;

function assertClosedPerLine(output: string): void {
  for (const line of output.split("\n")) {
    for (const [on, off] of SEQUENCE_PAIRS) {
      assert.equal(occurrences(line, on), occurrences(line, off), `unbalanced ${JSON.stringify(on)} in ${line}`);
    }
  }
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

test("the pipeline: an assistant message gets the heading and the quote styles", () => {
  const output = transformerFor(fakeTheme().theme)("# Title\n\n> quoted\n", context("assistant"));
  assert.ok(output.includes(`${ACCENT}${ITALIC_ON}Title${ITALIC_OFF}${FG_DEFAULT}`));
  assert.ok(output.includes(`> ${DIM_OFF}${ACCENT}quoted${FG_DEFAULT}${DIM_ON}`));
});

test("the pipeline: a user message is exactly what the fence labeling produced", () => {
  const markdown = "# Title\n\n```\n{\n  \"name\": \"pi\"\n}\n```\n\n- use `tsc`\n";
  const output = transformerFor(fakeTheme().theme)(markdown, context("user"));
  assert.equal(output, transformFenceLanguages(markdown));
  // The escape of the restored delimiters would be printed verbatim in a user
  // message (`preserveBackslashEscapes`), so nothing is styled there.
  assert.ok(!output.includes(ESCAPE));
});

test("the pipeline: thinking text is exactly what the fence labeling produced", () => {
  const markdown = "# Title\n\n> quoted\n";
  const output = transformerFor(fakeTheme().theme)(markdown, context("assistant-thinking"));
  assert.equal(output, transformFenceLanguages(markdown));
});

test("the pipeline: with no captured theme the message is only fence labeled", () => {
  const markdown = "# Title\n\n```\n{\n  \"name\": \"pi\"\n}\n```\n";
  const output = transformerFor(undefined)(markdown, context("assistant"));
  assert.equal(output, transformFenceLanguages(markdown));
  assert.ok(output.includes("```json"));
  assert.ok(!output.includes(ESCAPE));
});

test("the pipeline: a theme that throws keeps the fence labeling", () => {
  const markdown = "```\n{\n  \"name\": \"pi\"\n}\n```\n\n# Title\n";
  const transformer = createMarkdownTransformer({
    resolveTheme: () => {
      throw new Error("Theme not initialized. Call initTheme() first.");
    },
  });
  const output = transformer(markdown, context("assistant"));
  assert.equal(output, transformFenceLanguages(markdown));
  assert.ok(output.startsWith("```json"));
  assert.ok(!output.includes(ESCAPE));
});

test("the pipeline: no injected sequence stays open past its line", () => {
  const markdown = "# Title\n\n> quoted `code`\n\n#### Four\n\n- item `x`\n";
  const output = transformerFor(fakeTheme().theme)(markdown, context("assistant"));
  assertClosedPerLine(output);
});

test("the pipeline: an unclosed fence leaves the rest of the message alone", () => {
  const markdown = "```js\n# not a heading\n> not a quote\n";
  // Streaming: the fence has no closing line yet, so its body is only a prefix of
  // the final one and styling it would flicker as the stream grows.
  assert.equal(transformerFor(fakeTheme().theme)(markdown, context("assistant")), markdown);
});

test("the pipeline: a lone backtick leaves its line alone", () => {
  const markdown = "Run `npm test\n";
  assert.equal(transformerFor(fakeTheme().theme)(markdown, context("assistant")), markdown);
});

test("the pipeline: a heading still streaming keeps its style as the text grows", () => {
  const transformer = transformerFor(fakeTheme().theme);
  const closes = `${UNDERLINE_OFF}${FG_DEFAULT}`;
  assert.equal(transformer("## ", context("assistant")), "## ");
  const partial = transformer("## Tit", context("assistant"));
  assert.ok(partial.startsWith(`## ${ACCENT}${UNDERLINE_ON}Tit`));
  assert.ok(partial.endsWith(closes));
  assert.ok(transformer("## Titl", context("assistant")).endsWith(closes));
});

test("the pipeline: the memo is keyed by the palette signature", () => {
  const { theme, ansi } = fakeTheme();
  const transformer = transformerFor(theme);
  const markdown = "# Title\n";
  assert.ok(transformer(markdown, context("assistant")).includes(ACCENT));
  ansi.accent = NEXT_ACCENT;
  const restyled = transformer(markdown, context("assistant"));
  assert.ok(restyled.includes(NEXT_ACCENT));
  assert.ok(!restyled.includes(ACCENT));
});

test("the pipeline: a theme change the pass cannot see keeps the memoized render", () => {
  const { theme, ansi } = fakeTheme();
  const transformer = transformerFor(theme);
  const markdown = "# Title\n";
  const first = transformer(markdown, context("assistant"));
  // A token the pass never reads: the injected sequences are byte identical, so
  // there is nothing to recompute.
  ansi.warning = "\x1b[38;5;3m";
  assert.equal(transformer(markdown, context("assistant")), first);
});
