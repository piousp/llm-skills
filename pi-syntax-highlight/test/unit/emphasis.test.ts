import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEmphasis, findMatchRanges } from "../../src/emphasis.ts";
import { BOLD_OFF, BOLD_ON } from "../../src/tokens.ts";

// Literal mode off, because that is the flag combination the regex cases exercise.
const REGEX = { literal: false, ignoreCase: false } as const;
const LITERAL = { literal: true, ignoreCase: false } as const;

test("findMatchRanges: literal occurrences are returned in order", () => {
  assert.deepEqual(findMatchRanges("hello world hello", "hello", LITERAL), [
    { start: 0, end: 5 },
    { start: 12, end: 17 },
  ]);
});

test("findMatchRanges: metacharacters are regex unless literal mode escapes them", () => {
  assert.deepEqual(findMatchRanges("a.b axb", "a.b", REGEX), [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
  ]);
  assert.deepEqual(findMatchRanges("a.b axb", "a.b", LITERAL), [{ start: 0, end: 3 }]);
});

test("findMatchRanges: a pattern that is not a valid regex yields no ranges instead of throwing", () => {
  assert.deepEqual(findMatchRanges("a[b", "[", REGEX), []);
  assert.deepEqual(findMatchRanges("a[b", "[", LITERAL), [{ start: 1, end: 2 }]);
});

test("findMatchRanges: a unicode property escape addresses the letters it matches", () => {
  assert.deepEqual(findMatchRanges("ab 12", "\\p{L}+", REGEX), [{ start: 0, end: 2 }]);
  assert.deepEqual(findMatchRanges("12 ab", "\\p{L}+", REGEX), [{ start: 3, end: 5 }]);
});

test("findMatchRanges: the unicode flag rejects an escape only the loose parser accepts", () => {
  // `\-` compiles without `u` and is an invalid escape with it: the pattern falls
  // into the same fallback as any other broken one, so the render never throws.
  assert.deepEqual(findMatchRanges("a-b", "\\-", REGEX), []);
});

test("findMatchRanges: ignoreCase matches the other casing and still reports the real range", () => {
  assert.deepEqual(findMatchRanges("Function function", "FUNCTION", { literal: true, ignoreCase: true }), [
    { start: 0, end: 8 },
    { start: 9, end: 17 },
  ]);
  assert.deepEqual(findMatchRanges("Function function", "FUNCTION", LITERAL), []);
});

test("findMatchRanges: an empty pattern and zero-length matches produce no ranges and do not loop", () => {
  assert.deepEqual(findMatchRanges("anything", "", LITERAL), []);
  assert.deepEqual(findMatchRanges("bcd", "a*", REGEX), []);
  // The empty match at zero is dropped, the real one is kept.
  assert.deepEqual(findMatchRanges("baa", "a*", REGEX), [{ start: 1, end: 3 }]);
});

test("applyEmphasis: markers wrap the matched span of plain text", () => {
  assert.equal(applyEmphasis("hello world", [{ start: 0, end: 5 }], "<b>", "</b>"), "<b>hello</b> world");
  assert.equal(applyEmphasis("hello world", [{ start: 6, end: 11 }], "<b>", "</b>"), "hello <b>world</b>");
});

test("applyEmphasis: markers land on the visible column of a line carrying SGR colors", () => {
  // Visible text is `foobar`; the sequences must survive byte for byte.
  assert.equal(
    applyEmphasis("\x1b[36mfoo\x1b[39mbar", [{ start: 3, end: 6 }], "<b>", "</b>"),
    "\x1b[36mfoo<b>\x1b[39mbar</b>",
  );
  assert.equal(
    applyEmphasis("\x1b[36mfoo\x1b[39mbar", [{ start: 0, end: 6 }], "<b>", "</b>"),
    "<b>\x1b[36mfoo\x1b[39mbar</b>",
  );
});

test("applyEmphasis: an OSC sequence is copied whole and does not shift the visible columns", () => {
  assert.equal(
    applyEmphasis("\x1b]0;title\x07visible", [{ start: 0, end: 3 }], "<b>", "</b>"),
    "<b>\x1b]0;title\x07vis</b>ible",
  );
});

test("applyEmphasis: ranges running past either end are clipped to the text", () => {
  assert.equal(applyEmphasis("abc", [{ start: 1, end: 99 }], "<b>", "</b>"), "a<b>bc</b>");
  assert.equal(applyEmphasis("abc", [{ start: -5, end: 2 }], "<b>", "</b>"), "<b>ab</b>c");
  assert.equal(applyEmphasis("abc", [{ start: 9, end: 12 }], "<b>", "</b>"), "abc");
});

test("applyEmphasis: overlapping and touching ranges collapse into one pair of markers", () => {
  assert.equal(applyEmphasis("abcde", [{ start: 2, end: 5 }, { start: 0, end: 3 }], "<b>", "</b>"), "<b>abcde</b>");
  assert.equal(applyEmphasis("abcdef", [{ start: 0, end: 2 }, { start: 2, end: 4 }], "<b>", "</b>"), "<b>abcd</b>ef");
});

test("applyEmphasis: no usable range returns the text unchanged", () => {
  const styled = "\x1b[36mfoo\x1b[39m";
  assert.equal(applyEmphasis(styled, [], "<b>", "</b>"), styled);
  assert.equal(applyEmphasis("", [], "<b>", "</b>"), "");
  assert.equal(applyEmphasis("", [{ start: 0, end: 3 }], "<b>", "</b>"), "");
});

test("applyEmphasis: the match markers keep the weight only", () => {
  const ranges = findMatchRanges("hello world", "world", LITERAL);
  assert.equal(applyEmphasis("hello world", ranges, BOLD_ON, BOLD_OFF), `hello ${BOLD_ON}world${BOLD_OFF}`);
});

test("applyEmphasis: the bold markers bracket every occurrence found on the styled text", () => {
  // Pins the accepted trade-off: `off` resets the weight only, so the color the
  // line already had is not reopened.
  assert.equal(BOLD_ON, "\x1b[1m");
  assert.equal(BOLD_OFF, "\x1b[22m");
  const ranges = findMatchRanges("function f(", "function", LITERAL);
  assert.equal(
    applyEmphasis("\x1b[36mfunction f(\x1b[39m", ranges, BOLD_ON, BOLD_OFF),
    `${BOLD_ON}\x1b[36mfunction${BOLD_OFF} f(\x1b[39m`,
  );
});
