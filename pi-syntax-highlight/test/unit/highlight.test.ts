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
