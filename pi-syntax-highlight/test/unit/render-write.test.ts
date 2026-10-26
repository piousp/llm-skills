import { test } from "node:test";
import assert from "node:assert/strict";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import type { HighlightFn } from "../../src/highlight.ts";
import { buildWriteCallText, buildWriteResultText, type WriteCallInput } from "../../src/render-write.ts";
import { TOKEN } from "../../src/tokens.ts";

const fakeTheme = {
  fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
  bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
  bold: (t: string) => `<b>${t}</b>`,
};

const EXPAND_HINT = "<hint>";
const HEADER = "<toolTitle><b>write</b></toolTitle> <accent>a.ts</accent>";
const FOOTER_2 = "<muted>\n... (2 more lines, 12 total,</muted> <hint><muted>)</muted>";

// The header links the path unless the terminal says it cannot; the gate is
// pinned so the assertions read the styled text alone.
setCapabilityOverrides({ hyperlinks: false });

interface HighlightCall {
  code: string;
  lang: string;
}

function makeHighlight(calls: HighlightCall[]): HighlightFn {
  return (code, lang) => {
    calls.push({ code, lang });
    // The tokenizer emits nothing for an empty line, so the fake must not invent
    // markup there either: the trailing-line trim compares against "".
    return code.split("\n").map((line) => (line === "" ? "" : `<${lang}>${line}</${lang}>`));
  };
}

function callInput(overrides: Partial<WriteCallInput> = {}): WriteCallInput {
  return {
    path: "a.ts",
    content: "",
    argsComplete: true,
    expanded: false,
    theme: fakeTheme,
    expandHint: EXPAND_HINT,
    highlight: makeHighlight([]),
    cwd: "/work",
    ...overrides,
  };
}

function numbered(from: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line${from + index}`);
}

test("buildWriteResultText: a failure is painted in the error color with the built-in prefix", () => {
  assert.equal(TOKEN.broken, "error");
  assert.equal(buildWriteResultText({ output: "denied", isError: true, theme: fakeTheme }), "\n<error>denied</error>");
});

test("buildWriteResultText: several text blocks stay inside the one color wrapper", () => {
  assert.equal(
    buildWriteResultText({ output: "first\nsecond", isError: true, theme: fakeTheme }),
    "\n<error>first\nsecond</error>",
  );
});

test("buildWriteResultText: a success and an empty failure render nothing", () => {
  assert.equal(buildWriteResultText({ output: "written 3 lines", isError: false, theme: fakeTheme }), "");
  assert.equal(buildWriteResultText({ output: "", isError: true, theme: fakeTheme }), "");
});

test("buildWriteCallText: the header alone while the content argument has not arrived", () => {
  assert.equal(buildWriteCallText(callInput()), HEADER);
});

test("buildWriteCallText: a content argument that is not a string is reported like the built-in", () => {
  assert.equal(
    buildWriteCallText(callInput({ content: null })),
    `${HEADER}\n\n<error>[invalid content arg - expected string]</error>`,
  );
});

test("buildWriteCallText: the preview is highlighted as one block after the blank line", () => {
  const calls: HighlightCall[] = [];
  const text = buildWriteCallText(callInput({ content: "const a = 1;\nconst b = 2;", highlight: makeHighlight(calls) }));
  assert.deepEqual(calls, [{ code: "const a = 1;\nconst b = 2;", lang: "typescript" }]);
  assert.equal(text, `${HEADER}\n\n<typescript>const a = 1;</typescript>\n<typescript>const b = 2;</typescript>`);
});

test("buildWriteCallText: twelve lines collapse to ten plus the footer with the total", () => {
  const content = numbered(1, 12).join("\n");
  const visible = Array.from({ length: 10 }, (_, index) => `<typescript>line${index + 1}</typescript>`);
  assert.equal(buildWriteCallText(callInput({ content })), `${HEADER}\n\n${visible.join("\n")}${FOOTER_2}`);
});

test("buildWriteCallText: expanded shows every line and no footer", () => {
  const content = numbered(1, 12).join("\n");
  const all = Array.from({ length: 12 }, (_, index) => `<typescript>line${index + 1}</typescript>`);
  assert.equal(buildWriteCallText(callInput({ content, expanded: true })), `${HEADER}\n\n${all.join("\n")}`);
});

test("buildWriteCallText: a path with no known grammar keeps every line in the plain color", () => {
  assert.equal(TOKEN.plain, "toolOutput");
  const calls: HighlightCall[] = [];
  const text = buildWriteCallText(
    callInput({ path: "notes", content: "plain\nmore", highlight: makeHighlight(calls) }),
  );
  assert.deepEqual(calls, []);
  assert.equal(
    text,
    "<toolTitle><b>write</b></toolTitle> <accent>notes</accent>\n\n<toolOutput>plain</toolOutput>\n<toolOutput>more</toolOutput>",
  );
});

test("buildWriteCallText: the total in the footer does not count trailing empty lines", () => {
  const content = `${numbered(1, 11).join("\n")}\n\n\n`;
  const visible = Array.from({ length: 10 }, (_, index) => `<typescript>line${index + 1}</typescript>`);
  assert.equal(
    buildWriteCallText(callInput({ content })),
    `${HEADER}\n\n${visible.join("\n")}<muted>\n... (1 more lines, 11 total,</muted> <hint><muted>)</muted>`,
  );
});

test("buildWriteCallText: while the argument streams only the first sixty lines are tokenized", () => {
  const calls: HighlightCall[] = [];
  const content = numbered(1, 70).join("\n");
  const text = buildWriteCallText(callInput({ content, argsComplete: false, expanded: true, highlight: makeHighlight(calls) }));
  assert.deepEqual(calls, [{ code: numbered(1, 60).join("\n"), lang: "typescript" }]);
  // The tail past the prefix stays plain, and it is still part of the preview.
  assert.equal(text.includes("<toolOutput>line61</toolOutput>"), true);
  assert.equal(text.includes("<typescript>line70</typescript>"), false);
});

test("buildWriteCallText: tabs are expanded and carriage returns dropped before the preview", () => {
  const text = buildWriteCallText(callInput({ content: "\tindented\r\nsecond\r" }));
  assert.equal(text, `${HEADER}\n\n<typescript>   indented</typescript>\n<typescript>second</typescript>`);
});

test("buildWriteCallText: a missing path shows the placeholder instead of an empty slot", () => {
  assert.equal(
    buildWriteCallText(callInput({ path: "" })),
    "<toolTitle><b>write</b></toolTitle> <toolOutput>...</toolOutput>",
  );
});
