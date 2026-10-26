import { test } from "node:test";
import assert from "node:assert/strict";
import { clearHighlightCache, highlight, syncHighlightTheme } from "../../src/highlight.ts";

const fakeTheme = {
  fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
  bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
  bold: (t: string) => `<b>${t}</b>`,
};

// `highlightCode` paints through the host's module-global theme, which its proxy
// resolves from `globalThis` and throws without. Installing one here is what
// lets the real `highlight` run instead of failing before it reaches the cache.
const HOST_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
Object.assign(globalThis, { [HOST_THEME_KEY]: fakeTheme });

const THEME_A = { ...fakeTheme };
const THEME_B = { ...fakeTheme };

// A language the highlighter does not know makes `highlightCode` paint every
// line with one color, so the assertions do not depend on tokenizer output.
const UNKNOWN_LANG = "no-such-language";

// A theme that answers `getFgAnsi` behaves like the host's: one object whose
// colors change under it. The map keeps the colors mutable, so a theme switch is
// simulated without swapping the reference.
function valueTheme(): { theme: { getFgAnsi: (color: string) => string }; ansi: Map<string, string> } {
  const ansi = new Map<string, string>();
  return { ansi, theme: { getFgAnsi: (color: string) => ansi.get(color) ?? `<${color}>` } };
}

test("highlight: the same language and code come back from the cache", () => {
  clearHighlightCache();
  const first = highlight("plain text", UNKNOWN_LANG);
  const second = highlight("plain text", UNKNOWN_LANG);
  // A hit returns the cached array itself, not a repainted copy.
  assert.equal(first, second);
  assert.deepEqual(first, [`<mdCodeBlock>plain text</mdCodeBlock>`]);
});

test("highlight: a different language is a different cache entry", () => {
  clearHighlightCache();
  const first = highlight("plain text", UNKNOWN_LANG);
  const other = highlight("plain text", "another-missing-language");
  assert.notEqual(first, other);
});

test("syncHighlightTheme: a new theme reference invalidates the cache", () => {
  clearHighlightCache();
  syncHighlightTheme(THEME_A);
  const first = highlight("plain text", UNKNOWN_LANG);
  assert.equal(highlight("plain text", UNKNOWN_LANG), first);

  syncHighlightTheme(THEME_B);
  const recomputed = highlight("plain text", UNKNOWN_LANG);
  assert.notEqual(recomputed, first);
  // Only the paint was dropped: the content is what the source says.
  assert.deepEqual(recomputed, first);
});

test("syncHighlightTheme: the same theme reference keeps the cache", () => {
  clearHighlightCache();
  syncHighlightTheme(THEME_A);
  const first = highlight("plain text", UNKNOWN_LANG);
  syncHighlightTheme(THEME_A);
  assert.equal(highlight("plain text", UNKNOWN_LANG), first);
});

test("syncHighlightTheme: a theme with unchanged colors keeps the cache", () => {
  clearHighlightCache();
  const { theme } = valueTheme();
  syncHighlightTheme(theme);
  const first = highlight("plain text", UNKNOWN_LANG);
  // Every frame of a session renders with the same colors, so the second sync
  // must not throw away what the first one painted.
  syncHighlightTheme(theme);
  assert.equal(highlight("plain text", UNKNOWN_LANG), first);
});

test("syncHighlightTheme: a color that changed under the same reference invalidates the cache", () => {
  clearHighlightCache();
  const { theme, ansi } = valueTheme();
  syncHighlightTheme(theme);
  const first = highlight("plain text", UNKNOWN_LANG);
  ansi.set("syntaxKeyword", "\x1b[38;5;1m");
  syncHighlightTheme(theme);
  const repainted = highlight("plain text", UNKNOWN_LANG);
  assert.notEqual(repainted, first);
  // Only the paint was dropped: the content is what the source says.
  assert.deepEqual(repainted, first);
});

test("syncHighlightTheme: a theme whose getFgAnsi throws is compared by reference", () => {
  clearHighlightCache();
  const getFgAnsi = (): string => {
    throw new Error("Theme not initialized");
  };
  const throwing = { getFgAnsi };
  syncHighlightTheme(throwing);
  const first = highlight("plain text", UNKNOWN_LANG);
  // The reference is the only signal left, and it did not move.
  syncHighlightTheme(throwing);
  assert.equal(highlight("plain text", UNKNOWN_LANG), first);
  // A different reference is the one thing that still invalidates.
  syncHighlightTheme({ getFgAnsi });
  assert.notEqual(highlight("plain text", UNKNOWN_LANG), first);
});
