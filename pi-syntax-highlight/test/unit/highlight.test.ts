import { test } from "node:test";
import assert from "node:assert/strict";
import { clearHighlightCache, highlight, highlightLines, syncHighlightTheme } from "../../src/highlight.ts";

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
// line with the code-block color, which `highlight` refuses to cache.
const UNKNOWN_LANG = "no-such-language";
// A grammar the highlighter knows: its paint is cacheable.
const KNOWN_LANG = "json";
const CODE = '{"a": 1}';

// A theme that answers `getFgAnsi` behaves like the host's: one object whose
// colors change under it. The map keeps the colors mutable, so a theme switch is
// simulated without swapping the reference.
function valueTheme(): { theme: { getFgAnsi: (color: string) => string }; ansi: Map<string, string> } {
  const ansi = new Map<string, string>();
  return { ansi, theme: { getFgAnsi: (color: string) => ansi.get(color) ?? `<${color}>` } };
}

test("highlight: the same language and code come back from the cache", () => {
  clearHighlightCache();
  const first = highlight(CODE, KNOWN_LANG);
  const second = highlight(CODE, KNOWN_LANG);
  // A hit returns the cached array itself, not a repainted copy.
  assert.equal(first, second);
  assert.deepEqual(first, ['{<syntaxVariable>"a"</syntaxVariable>: <syntaxNumber>1</syntaxNumber>}']);
});

test("highlight: a different language is a different cache entry", () => {
  clearHighlightCache();
  const first = highlight(CODE, KNOWN_LANG);
  const other = highlight(CODE, "typescript");
  assert.notEqual(first, other);
});

test("syncHighlightTheme: a new theme reference invalidates the cache", () => {
  clearHighlightCache();
  syncHighlightTheme(THEME_A);
  const first = highlight(CODE, KNOWN_LANG);
  assert.equal(highlight(CODE, KNOWN_LANG), first);

  syncHighlightTheme(THEME_B);
  const recomputed = highlight(CODE, KNOWN_LANG);
  assert.notEqual(recomputed, first);
  // Only the paint was dropped: the content is what the source says.
  assert.deepEqual(recomputed, first);
});

test("syncHighlightTheme: the same theme reference keeps the cache", () => {
  clearHighlightCache();
  syncHighlightTheme(THEME_A);
  const first = highlight(CODE, KNOWN_LANG);
  syncHighlightTheme(THEME_A);
  assert.equal(highlight(CODE, KNOWN_LANG), first);
});

test("syncHighlightTheme: a theme with unchanged colors keeps the cache", () => {
  clearHighlightCache();
  const { theme } = valueTheme();
  syncHighlightTheme(theme);
  const first = highlight(CODE, KNOWN_LANG);
  // Every frame of a session renders with the same colors, so the second sync
  // must not throw away what the first one painted.
  syncHighlightTheme(theme);
  assert.equal(highlight(CODE, KNOWN_LANG), first);
});

test("syncHighlightTheme: a color that changed under the same reference invalidates the cache", () => {
  clearHighlightCache();
  const { theme, ansi } = valueTheme();
  syncHighlightTheme(theme);
  const first = highlight(CODE, KNOWN_LANG);
  ansi.set("syntaxKeyword", "\x1b[38;5;1m");
  syncHighlightTheme(theme);
  const repainted = highlight(CODE, KNOWN_LANG);
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
  const first = highlight(CODE, KNOWN_LANG);
  // The reference is the only signal left, and it did not move.
  syncHighlightTheme(throwing);
  assert.equal(highlight(CODE, KNOWN_LANG), first);
  // A different reference is the one thing that still invalidates.
  syncHighlightTheme({ getFgAnsi });
  assert.notEqual(highlight(CODE, KNOWN_LANG), first);
});

test("highlightLines: with no budget the whole body goes to the highlighter in one piece", () => {
  const code = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
  const calls: string[] = [];
  const painted = highlightLines(code, "ts", (line) => `flat:${line}`, (chunk) => {
    calls.push(chunk);
    return chunk.split("\n").map((line) => `hl:${line}`);
  });
  assert.deepEqual(calls, [code]);
  assert.equal(painted.length, 500);
  assert.equal(painted[499], "hl:line 499");
});

test("highlightLines: a budget cuts the highlighted head and paints the tail flat", () => {
  const code = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
  const calls: string[] = [];
  const painted = highlightLines(code, "ts", (line) => `flat:${line}`, (chunk) => {
    calls.push(chunk);
    return chunk.split("\n").map((line) => `hl:${line}`);
  }, 400);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].split("\n").length, 400);
  assert.equal(painted[399], "hl:line 399");
  assert.equal(painted[400], "flat:line 400");
});

test("highlight: a result painted entirely in the code-block color is returned empty and not cached", () => {
  clearHighlightCache();
  const first = highlight("plain text", UNKNOWN_LANG);
  assert.deepEqual(first, []);
  // A grammar that loads later must get another chance, so a repaint is a new array.
  assert.notEqual(highlight("plain text", UNKNOWN_LANG), first);
});

test("highlightLines: lines the highlighter painted only in the code-block color use the caller's fallback", () => {
  const painted = highlightLines("a\nb", UNKNOWN_LANG, (line) => `flat:${line}`, highlight);
  assert.deepEqual(painted, ["flat:a", "flat:b"]);
});

test("highlight: a hit refreshes the entry, so the least recently used one is evicted", () => {
  clearHighlightCache();
  const first = highlight(CODE, KNOWN_LANG);
  const second = highlight('{"b": 2}', KNOWN_LANG);
  for (let index = 0; index < 62; index += 1) highlight(`{"k": ${index + 10}}`, KNOWN_LANG);
  // The cache is full; touching the oldest entry makes the next one the oldest.
  assert.equal(highlight(CODE, KNOWN_LANG), first);
  highlight('{"overflow": 1}', KNOWN_LANG);
  assert.equal(highlight(CODE, KNOWN_LANG), first);
  assert.notEqual(highlight('{"b": 2}', KNOWN_LANG), second);
});

test("syncHighlightTheme: a change in a token the highlighter paints with invalidates the cache", () => {
  for (const token of ["syntaxOperator", "toolDiffAdded", "toolDiffRemoved", "mdCodeBlock"]) {
    clearHighlightCache();
    const { theme, ansi } = valueTheme();
    syncHighlightTheme(theme);
    const first = highlight(CODE, KNOWN_LANG);
    ansi.set(token, "\x1b[38;5;1m");
    syncHighlightTheme(theme);
    assert.notEqual(highlight(CODE, KNOWN_LANG), first, token);
  }
});
