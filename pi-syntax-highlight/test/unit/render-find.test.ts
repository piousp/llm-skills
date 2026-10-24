import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_BYTES, formatSize } from "@earendil-works/pi-coding-agent";
import { buildFindResultText, type PathListInput } from "../../src/render-find.ts";
import { TOKEN } from "../../src/tokens.ts";

const fakeTheme = {
  fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
  bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
  bold: (t: string) => `<b>${t}</b>`,
};

const EXPAND_HINT = "<hint>";
const FOOTER_1 = "<muted>\n... (1 more lines,</muted> <hint><muted>)</muted>";
const FOOTER_3 = "<muted>\n... (3 more lines,</muted> <hint><muted>)</muted>";

const PATHS = Array.from({ length: 21 }, (_, index) => `f${index}.ts`);
const NOTICE = "100 results limit reached. Use limit=200 for more, or refine pattern";
// Twenty-one paths, the blank separator find prints, and the notice: twenty-three
// body lines in total.
const PATHS_WITH_NOTICE = `${PATHS.join("\n")}\n\n[${NOTICE}]`;

function styledPath(path: string): string {
  return `<b><syntaxType>${path}</syntaxType></b>`;
}

function findInput(overrides: Partial<PathListInput> = {}): PathListInput {
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

test("buildFindResultText: three paths render in full with no footer", () => {
  const text = buildFindResultText(findInput({ output: "a.ts\nb.ts\nc.ts" }));
  assert.equal(text, ["", styledPath("a.ts"), styledPath("b.ts"), styledPath("c.ts")].join("\n"));
});

test("buildFindResultText: twenty-one paths collapse to twenty plus a footer", () => {
  const text = buildFindResultText(findInput({ output: PATHS.join("\n") }));
  assert.equal(text, ["", ...PATHS.slice(0, 20).map(styledPath)].join("\n") + FOOTER_1);
});

test("buildFindResultText: expanded shows every path and no footer", () => {
  const text = buildFindResultText(findInput({ output: PATHS.join("\n"), expanded: true }));
  assert.equal(text, ["", ...PATHS.map(styledPath)].join("\n"));
});

test("buildFindResultText: a nested path dims the directories and colors the file", () => {
  const text = buildFindResultText(findInput({ output: "src/deep/a.ts" }));
  assert.equal(text, ["", "<muted>src</muted>/<muted>deep</muted>/<b><syntaxType>a.ts</syntaxType></b>"].join("\n"));
});

test("buildFindResultText: a directory keeps its trailing slash and is dimmed", () => {
  const text = buildFindResultText(findInput({ output: "dir/" }));
  assert.equal(text, ["", "<b><dim>dir</dim></b>/"].join("\n"));
});

test("buildFindResultText: a document is colored like tool output", () => {
  const text = buildFindResultText(findInput({ output: "README.md" }));
  assert.equal(text, ["", "<b><toolOutput>README.md</toolOutput></b>"].join("\n"));
});

test("buildFindResultText: the results limit warning sits after the footer", () => {
  const text = buildFindResultText(findInput({ output: PATHS.join("\n"), details: { resultLimitReached: 100 } }));
  const footerAt = text.indexOf("more lines,");
  const warningAt = text.indexOf("[Truncated:");
  assert.ok(footerAt !== -1, `expected the footer in: ${text}`);
  assert.ok(warningAt > footerAt, `expected the warning after the footer in: ${text}`);
  assert.ok(
    text.endsWith("\n<warning>[Truncated: 100 results limit]</warning>"),
    `expected the results limit warning at the end of: ${text}`,
  );
});

test("buildFindResultText: the size limit is formatted through formatSize, with the default when absent", () => {
  const explicit = buildFindResultText(
    findInput({ output: "a.ts", details: { truncation: { truncated: true, maxBytes: 1048576 } } }),
  );
  assert.equal(
    explicit,
    ["", styledPath("a.ts"), `<warning>[Truncated: ${formatSize(1048576)} limit]</warning>`].join("\n"),
  );

  const defaulted = buildFindResultText(findInput({ output: "a.ts", details: { truncation: { truncated: true } } }));
  assert.equal(
    defaulted,
    ["", styledPath("a.ts"), `<warning>[Truncated: ${formatSize(DEFAULT_MAX_BYTES)} limit]</warning>`].join("\n"),
  );
});

test("buildFindResultText: the size warning is absent when the output was not truncated", () => {
  const text = buildFindResultText(findInput({ output: "a.ts", details: { truncation: { truncated: false } } }));
  assert.equal(text, ["", styledPath("a.ts")].join("\n"));
});

test("buildFindResultText: the tool's own results notice is a body line, so the footer counts it", () => {
  assert.equal(TOKEN.notice, "warning");
  assert.equal(
    buildFindResultText(findInput({ output: PATHS_WITH_NOTICE })),
    ["", ...PATHS.slice(0, 20).map(styledPath)].join("\n") + FOOTER_3,
  );

  const expanded = buildFindResultText(findInput({ output: PATHS_WITH_NOTICE, expanded: true }));
  assert.equal(expanded.includes("more lines,"), false);
  assert.ok(
    expanded.endsWith(`\n<warning>[${NOTICE}]</warning>`),
    `expected the notice at the end of: ${expanded}`,
  );
});

test("buildFindResultText: an error result is painted flat in the content color", () => {
  assert.equal(TOKEN.content, "text");
  const text = buildFindResultText(
    findInput({ output: "src/a.ts\ndir/\nNo files found matching pattern", isError: true }),
  );
  // No bold, no file-family color, and no sentinel dimming: the failure is the
  // whole message, so every line keeps the one weight.
  assert.equal(
    text,
    ["", "<text>src/a.ts</text>", "<text>dir/</text>", "<text>No files found matching pattern</text>"].join("\n"),
  );
});

test("buildFindResultText: an empty search is dimmed as a sentinel, not styled as a path", () => {
  assert.equal(TOKEN.empty, "dim");
  const text = buildFindResultText(findInput({ output: "No files found matching pattern" }));
  assert.equal(text, ["", "<dim>No files found matching pattern</dim>"].join("\n"));
});

test("buildFindResultText: empty and blank outputs render nothing", () => {
  assert.equal(buildFindResultText(findInput({ output: "" })), "");
  assert.equal(buildFindResultText(findInput({ output: "  \n  " })), "");
});
