import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_BYTES, formatSize } from "@earendil-works/pi-coding-agent";
import { buildLsResultText, type LsInput } from "../../src/render-ls.ts";
import { TOKEN } from "../../src/tokens.ts";

const fakeTheme = {
  fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
  bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
  bold: (t: string) => `<b>${t}</b>`,
};

const EXPAND_HINT = "<hint>";
const FOOTER_1 = "<muted>\n... (1 more lines,</muted> <hint><muted>)</muted>";
const FOOTER_3 = "<muted>\n... (3 more lines,</muted> <hint><muted>)</muted>";

const ENTRIES = Array.from({ length: 21 }, (_, index) => `f${index}.ts`);
const NOTICE = "50 entries limit reached. Use limit=100 for more";
// Twenty-one entries, the blank separator ls prints, and the notice: twenty-three
// body lines in total.
const ENTRIES_WITH_NOTICE = `${ENTRIES.join("\n")}\n\n[${NOTICE}]`;

function styledEntry(entry: string): string {
  return `<b><syntaxType>${entry}</syntaxType></b>`;
}

function lsInput(overrides: Partial<LsInput> = {}): LsInput {
  return {
    output: "",
    expanded: false,
    isError: false,
    details: undefined,
    theme: fakeTheme,
    expandHint: EXPAND_HINT,
    ...overrides,
  };
}

test("buildLsResultText: three entries render in full with no footer", () => {
  const text = buildLsResultText(lsInput({ output: "a.ts\nb.ts\nc.ts" }));
  assert.equal(text, ["", styledEntry("a.ts"), styledEntry("b.ts"), styledEntry("c.ts")].join("\n"));
});

test("buildLsResultText: twenty-one entries collapse to twenty plus a footer", () => {
  const text = buildLsResultText(lsInput({ output: ENTRIES.join("\n") }));
  assert.equal(text, ["", ...ENTRIES.slice(0, 20).map(styledEntry)].join("\n") + FOOTER_1);
});

test("buildLsResultText: expanded shows every entry and no footer", () => {
  const text = buildLsResultText(lsInput({ output: ENTRIES.join("\n"), expanded: true }));
  assert.equal(text, ["", ...ENTRIES.map(styledEntry)].join("\n"));
});

test("buildLsResultText: entry names are not split into path segments", () => {
  const text = buildLsResultText(lsInput({ output: "src" }));
  assert.equal(text, ["", "<b><toolOutput>src</toolOutput></b>"].join("\n"));
});

test("buildLsResultText: a directory keeps its trailing slash and is dimmed", () => {
  const text = buildLsResultText(lsInput({ output: "src/" }));
  assert.equal(text, ["", "<b><dim>src</dim></b>/"].join("\n"));
});

test("buildLsResultText: the entries limit warning sits after the footer", () => {
  const text = buildLsResultText(lsInput({ output: ENTRIES.join("\n"), details: { entryLimitReached: 50 } }));
  const footerAt = text.indexOf("more lines,");
  const warningAt = text.indexOf("[Truncated:");
  assert.ok(footerAt !== -1, `expected the footer in: ${text}`);
  assert.ok(warningAt > footerAt, `expected the warning after the footer in: ${text}`);
  assert.ok(
    text.endsWith("\n<warning>[Truncated: 50 entries limit]</warning>"),
    `expected the entries limit warning at the end of: ${text}`,
  );
});

test("buildLsResultText: the size limit is formatted through formatSize, with the default when absent", () => {
  const explicit = buildLsResultText(
    lsInput({ output: "a.ts", details: { truncation: { truncated: true, maxBytes: 1048576 } } }),
  );
  assert.equal(
    explicit,
    ["", styledEntry("a.ts"), `<warning>[Truncated: ${formatSize(1048576)} limit]</warning>`].join("\n"),
  );

  const defaulted = buildLsResultText(lsInput({ output: "a.ts", details: { truncation: { truncated: true } } }));
  assert.equal(
    defaulted,
    ["", styledEntry("a.ts"), `<warning>[Truncated: ${formatSize(DEFAULT_MAX_BYTES)} limit]</warning>`].join("\n"),
  );
});

test("buildLsResultText: the size warning is absent when the output was not truncated", () => {
  const text = buildLsResultText(lsInput({ output: "a.ts", details: { truncation: { truncated: false } } }));
  assert.equal(text, ["", styledEntry("a.ts")].join("\n"));
});

test("buildLsResultText: the tool's own entries notice is a body line, so the footer counts it", () => {
  assert.equal(TOKEN.notice, "warning");
  assert.equal(
    buildLsResultText(lsInput({ output: ENTRIES_WITH_NOTICE })),
    ["", ...ENTRIES.slice(0, 20).map(styledEntry)].join("\n") + FOOTER_3,
  );

  const expanded = buildLsResultText(lsInput({ output: ENTRIES_WITH_NOTICE, expanded: true }));
  assert.equal(expanded.includes("more lines,"), false);
  assert.ok(
    expanded.endsWith(`\n<warning>[${NOTICE}]</warning>`),
    `expected the notice at the end of: ${expanded}`,
  );
});

test("buildLsResultText: an error result is painted flat in the content color", () => {
  assert.equal(TOKEN.content, "text");
  const text = buildLsResultText(lsInput({ output: "src/a.ts\nsrc/\n(empty directory)", isError: true }));
  // No bold, no file-family color, and no sentinel dimming: the failure is the
  // whole message, so every line keeps the one weight.
  assert.equal(
    text,
    ["", "<text>src/a.ts</text>", "<text>src/</text>", "<text>(empty directory)</text>"].join("\n"),
  );
});

test("buildLsResultText: an empty directory is dimmed as a sentinel, not styled as an entry", () => {
  assert.equal(TOKEN.empty, "dim");
  const text = buildLsResultText(lsInput({ output: "(empty directory)" }));
  assert.equal(text, ["", "<dim>(empty directory)</dim>"].join("\n"));
});

test("buildLsResultText: empty and blank outputs render nothing", () => {
  assert.equal(buildLsResultText(lsInput({ output: "" })), "");
  assert.equal(buildLsResultText(lsInput({ output: "  \n  " })), "");
});
