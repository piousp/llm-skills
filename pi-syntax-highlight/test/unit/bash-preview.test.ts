import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createBashPreview } from "../../src/render-bash.ts";

const fakeTheme = {
  fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
  bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
  bold: (t: string) => `<b>${t}</b>`,
};

const EXPAND_HINT = "<hint>";
// Byte-identical to the built-in preview hint for five hidden visual lines.
const HINT_5 = "<muted>... (5 earlier lines,</muted> <hint><muted>)</muted>";

const WIDE = 200;

function styledLine(index: number): string {
  return `<toolOutput>line${index}</toolOutput>`;
}

function body(count: number): string {
  return Array.from({ length: count }, (_, index) => styledLine(index + 1)).join("\n");
}

test("createBashPreview: ten lines collapse to the last five plus the hint", () => {
  const lines = createBashPreview(body(10), EXPAND_HINT, fakeTheme).render(WIDE).map((line) => line.trimEnd());
  assert.equal(lines.length, 6);
  assert.equal(lines[0], HINT_5);
  assert.deepEqual(lines.slice(1), [6, 7, 8, 9, 10].map(styledLine));
});

test("createBashPreview: fewer lines than the limit render without a hint", () => {
  const lines = createBashPreview(body(3), EXPAND_HINT, fakeTheme).render(WIDE).map((line) => line.trimEnd());
  assert.deepEqual(lines, [1, 2, 3].map(styledLine));
});

test("createBashPreview: a narrow width keeps five visual lines and truncates each to the width", () => {
  const long = "0123456789".repeat(10);
  const lines = createBashPreview(long, EXPAND_HINT, fakeTheme).render(10);
  assert.equal(lines.length, 6);
  for (const line of lines) assert.ok(visibleWidth(line) <= 10, `${line} is wider than 10`);
  // The tail of the wrapped line is kept, and the hint sits above it.
  assert.deepEqual(lines.slice(1), Array.from({ length: 5 }, () => "0123456789"));
  assert.ok(lines[0].startsWith("<muted>"), `${lines[0]} is not the hint`);
});

test("createBashPreview: lines are cached per width and dropped by invalidate", () => {
  const preview = createBashPreview(body(10), EXPAND_HINT, fakeTheme);
  const first = preview.render(WIDE);
  assert.equal(preview.render(WIDE), first);

  preview.invalidate();
  const afterInvalidate = preview.render(WIDE);
  assert.notEqual(afterInvalidate, first);
  assert.deepEqual(afterInvalidate, first);
});
