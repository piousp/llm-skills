import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownPalette } from "../../src/markdown-theme.ts";
import { DIM_OFF, DIM_ON, FG_DEFAULT, type AnsiTheme } from "../../src/tokens.ts";

const ACCENT = "\x1b[38;5;5m";
const QUOTE_COLOR = "\x1b[38;5;8m";
const OTHER_QUOTE_COLOR = "\x1b[38;5;1m";

// A theme whose sequences live in a mutable map, like the host's: a theme switch
// changes the values under the same object, so a fake that returned fixed literals
// could not show the signature moving.
function fakeTheme(overrides: Record<string, string> = {}): { theme: AnsiTheme; ansi: Record<string, string> } {
  const ansi: Record<string, string> = { accent: ACCENT, mdQuote: FG_DEFAULT + DIM_ON, ...overrides };
  return {
    ansi,
    theme: {
      getFgAnsi: (color) => ansi[color] ?? "",
      getBgAnsi: () => "",
    },
  };
}

test("markdownPalette: the heading accent is the theme's foreground for the accent token", () => {
  assert.equal(markdownPalette(fakeTheme().theme).accent, ACCENT);
});

test("markdownPalette: a faint quote turns dim off while it opens and restores it when it closes", () => {
  const palette = markdownPalette(fakeTheme().theme);
  assert.equal(palette.quoteOpen, DIM_OFF + ACCENT);
  // `\x1b[22m` closes bold along with dim, which is why the close puts the theme's
  // own faint back instead of leaving the line brighter than the host painted it.
  assert.equal(palette.quoteClose, FG_DEFAULT + DIM_ON);
});

test("markdownPalette: a quote that is not faint opens with the color alone", () => {
  const palette = markdownPalette(fakeTheme({ mdQuote: QUOTE_COLOR }).theme);
  assert.equal(palette.quoteOpen, ACCENT);
  assert.equal(palette.quoteClose, FG_DEFAULT);
});

test("markdownPalette: a token that resolves to the terminal default adds no color", () => {
  // The host maps a token with no color of its own to 39, and wrapping text in that
  // sequence only cancels the style the surrounding line already has.
  assert.equal(markdownPalette(fakeTheme({ accent: "" }).theme).accent, "");
  assert.equal(markdownPalette(fakeTheme({ accent: FG_DEFAULT }).theme).accent, "");
});

test("markdownPalette: a colorless quote injects no pair at all", () => {
  const palette = markdownPalette(fakeTheme({ accent: FG_DEFAULT }).theme);
  assert.equal(palette.quoteOpen, "");
  assert.equal(palette.quoteClose, "");
});

test("markdownPalette: the signature is stable while the sequences are", () => {
  const { theme } = fakeTheme();
  const first = markdownPalette(theme);
  assert.equal(markdownPalette(theme).signature, first.signature);
  // The signature is the concatenation of what the pass injects, so two palettes
  // with the same one cannot produce different bytes.
  assert.equal(first.signature, [first.accent, first.quoteOpen, first.quoteClose].join("\u0000"));
});

test("markdownPalette: the signature follows the accent when the theme changes", () => {
  const { theme, ansi } = fakeTheme();
  const before = markdownPalette(theme).signature;
  ansi.accent = "\x1b[38;5;6m";
  assert.notEqual(markdownPalette(theme).signature, before);
});

test("markdownPalette: the signature follows the faint flag of the quote", () => {
  const { theme, ansi } = fakeTheme();
  const before = markdownPalette(theme).signature;
  ansi.mdQuote = QUOTE_COLOR;
  assert.notEqual(markdownPalette(theme).signature, before);
});

test("markdownPalette: a change the pass cannot see leaves the signature alone", () => {
  const { theme, ansi } = fakeTheme({ mdQuote: QUOTE_COLOR });
  const before = markdownPalette(theme).signature;
  // Another color, same faint flag: the injected sequences are byte identical, so
  // invalidating a memoized render over it would be wasted work.
  ansi.mdQuote = OTHER_QUOTE_COLOR;
  ansi.warning = "\x1b[38;5;3m";
  assert.equal(markdownPalette(theme).signature, before);
});
