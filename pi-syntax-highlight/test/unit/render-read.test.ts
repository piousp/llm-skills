import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, getPackageDir } from "@earendil-works/pi-coding-agent";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import type { HighlightFn } from "../../src/highlight.ts";
import {
  buildReadCallText,
  buildReadResultText,
  readLimit,
  readOffset,
  readPath,
  splitReadNotice,
  type ReadCallInput,
  type ReadResultInput,
} from "../../src/render-read.ts";
import { BOLD_OFF, BOLD_ON, TOKEN } from "../../src/tokens.ts";

const fakeTheme = {
  fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
  bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
  bold: (t: string) => `<b>${t}</b>`,
};

const EXPAND_HINT = "<hint>";
const FOOTER_2 = "<muted>\n... (2 more lines,</muted> <hint><muted>)</muted>";
// `keyText` reads the live keybinding table, which a test process has not
// registered, so the compact header falls back to the built-in default key.
const COMPACT_HINT = "<dim> (ctrl+o to expand)</dim>";

// The header always links unless the terminal is told it cannot; the gate is
// pinned here so the assertions read the styled text and the link is exercised
// in its own test.
setCapabilityOverrides({ hyperlinks: false });

interface HighlightCall {
  code: string;
  lang: string;
}

function makeHighlight(calls: HighlightCall[]): HighlightFn {
  return (code, lang) => {
    calls.push({ code, lang });
    return code.split("\n").map((line) => `<${lang}>${line}</${lang}>`);
  };
}

function readInput(overrides: Partial<ReadResultInput> = {}): ReadResultInput {
  return {
    output: "",
    path: "",
    offset: undefined,
    details: undefined,
    expanded: true,
    isError: false,
    hasImage: false,
    theme: fakeTheme,
    expandHint: EXPAND_HINT,
    highlight: makeHighlight([]),
    ...overrides,
  };
}

function callInput(overrides: Partial<ReadCallInput> = {}): ReadCallInput {
  return {
    path: "src/a.ts",
    offset: undefined,
    limit: undefined,
    compact: false,
    theme: fakeTheme,
    cwd: "/work",
    ...overrides,
  };
}

function plain(content: string): string {
  return `<toolOutput>${content}</toolOutput>`;
}

// The gutter every file body carries: the number right-aligned to the widest one
// on screen, then the separator, then the content one space away.
function gutter(number: number, width: number, content: string): string {
  const pad = String(number).padStart(width);
  return content === ""
    ? `<syntaxNumber>${pad}</syntaxNumber><dim> |</dim>`
    : `<syntaxNumber>${pad}</syntaxNumber><dim> |</dim> ${content}`;
}

function lines(rendered: string[]): string {
  return ["", ...rendered].join("\n");
}

test("buildReadResultText: a collapsed result with no failure renders nothing", () => {
  assert.equal(buildReadResultText(readInput({ output: "a\nb", expanded: false })), "");
});

test("buildReadResultText: the gutter counts from line 1 when the call carries no offset", () => {
  const text = buildReadResultText(readInput({ output: "a\nb\nc" }));
  assert.equal(text, lines([gutter(1, 1, plain("a")), gutter(2, 1, plain("b")), gutter(3, 1, plain("c"))]));
});

test("buildReadResultText: the first line number is the call's offset and the width follows the last one", () => {
  const text = buildReadResultText(readInput({ output: "a\nb\nc", offset: 98 }));
  assert.equal(
    text,
    lines([gutter(98, 3, plain("a")), gutter(99, 3, plain("b")), gutter(100, 3, plain("c"))]),
  );
});

test("buildReadResultText: a file with a grammar is highlighted in a single call", () => {
  const calls: HighlightCall[] = [];
  const output = "const a = 1;\nconst b = 2;";
  const text = buildReadResultText(readInput({ output, path: "a.ts", highlight: makeHighlight(calls) }));
  assert.deepEqual(calls, [{ code: output, lang: "typescript" }]);
  assert.equal(
    text,
    lines([
      gutter(1, 1, "<typescript>const a = 1;</typescript>"),
      gutter(2, 1, "<typescript>const b = 2;</typescript>"),
    ]),
  );
});

test("buildReadResultText: a continuation notice leaves the highlighted block and is painted as a notice", () => {
  const notice = "3 more lines in file. Use offset=3 to continue.";
  const calls: HighlightCall[] = [];
  const text = buildReadResultText(
    readInput({ output: `a\nb\n\n[${notice}]`, path: "a.ts", highlight: makeHighlight(calls) }),
  );
  // Only the file's own lines reach the tokenizer: the notice is a message, not
  // code, and painting it as code is what this package fixes.
  assert.deepEqual(calls, [{ code: "a\nb", lang: "typescript" }]);
  assert.equal(
    text,
    lines([gutter(1, 1, "<typescript>a</typescript>"), gutter(2, 1, "<typescript>b</typescript>")]) +
      `\n<warning>[${notice}]</warning>`,
  );
});

test("buildReadResultText: the truncation continuation notice is recognized with and without the byte limit", () => {
  assert.equal(TOKEN.notice, "warning");
  for (const notice of [
    "Showing lines 1-1 of 5000. Use offset=2 to continue.",
    `Showing lines 1-1 of 5000 (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=2 to continue.`,
  ]) {
    const text = buildReadResultText(readInput({ output: `a\n\n[${notice}]` }));
    assert.equal(text, lines([gutter(1, 1, plain("a"))]) + `\n<warning>[${notice}]</warning>`);
  }
});

test("splitReadNotice: a bracket block that is not one of the tool's notices stays in the body", () => {
  for (const trailing of ["[not a notice]", "[3 more lines]", "[Showing lines 1-2 of 3]"]) {
    const output = `a\n\n${trailing}`;
    assert.deepEqual(splitReadNotice(output, false), { body: output, notice: undefined });
  }
});

test("splitReadNotice: a notice without the blank separator stays in the body", () => {
  // A file can end with a line that reads exactly like the notice, which is why
  // the separator the tool prints is part of what makes a notice a notice.
  const output = "a\n[3 more lines in file. Use offset=3 to continue.]";
  assert.deepEqual(splitReadNotice(output, false), { body: output, notice: undefined });
});

test("splitReadNotice: the oversized-first-line message is the whole output and loses its brackets", () => {
  const message = "[Line 1 is 8.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' a.ts | head -c 51200]";
  assert.deepEqual(splitReadNotice(message, true), {
    body: "",
    notice: message.slice(1, -1),
  });
  assert.deepEqual(splitReadNotice("", true), { body: "", notice: undefined });
});

test("buildReadResultText: an oversized first line has no gutter and reports both notices", () => {
  const message = `[Line 1 is 8.0KB, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '1p' a.ts | head -c 51200]`;
  const text = buildReadResultText(
    readInput({
      output: message,
      path: "a.ts",
      details: { truncation: { truncated: true, firstLineExceedsLimit: true, maxBytes: DEFAULT_MAX_BYTES } },
    }),
  );
  assert.equal(
    text,
    `\n<warning>${message}</warning>\n<warning>[First line exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit]</warning>`,
  );
});

test("buildReadResultText: line truncation keeps the built-in wording and its default limit", () => {
  const recorded = buildReadResultText(
    readInput({
      output: "a",
      details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 10, totalLines: 500, maxLines: 10 } },
    }),
  );
  assert.equal(recorded, lines([gutter(1, 1, plain("a"))]) + "\n<warning>[Truncated: showing 10 of 500 lines (10 line limit)]</warning>");

  const defaulted = buildReadResultText(
    readInput({ output: "a", details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 10, totalLines: 500 } } }),
  );
  assert.equal(
    defaulted,
    lines([gutter(1, 1, plain("a"))]) +
      `\n<warning>[Truncated: showing 10 of 500 lines (${DEFAULT_MAX_LINES} line limit)]</warning>`,
  );
});

test("buildReadResultText: byte truncation reports the shown lines and the limit", () => {
  const text = buildReadResultText(
    readInput({
      output: "a",
      details: { truncation: { truncated: true, truncatedBy: "bytes", outputLines: 7, maxBytes: 1024 } },
    }),
  );
  assert.equal(text, lines([gutter(1, 1, plain("a"))]) + `\n<warning>[Truncated: 7 lines shown (${formatSize(1024)} limit)]</warning>`);
});

test("buildReadResultText: an untruncated result carries no truncation line", () => {
  const text = buildReadResultText(readInput({ output: "a", details: { truncation: { truncated: false } } }));
  assert.equal(text, lines([gutter(1, 1, plain("a"))]));
});

test("buildReadResultText: an expanded error is painted flat, with no gutter and no grammar", () => {
  assert.equal(TOKEN.plain, "toolOutput");
  const calls: HighlightCall[] = [];
  const text = buildReadResultText(
    readInput({ output: "boom\nsecond", path: "a.ts", isError: true, highlight: makeHighlight(calls) }),
  );
  assert.equal(text, lines([plain("boom"), plain("second")]));
  assert.deepEqual(calls, []);
});

test("buildReadResultText: a collapsed error keeps ten lines and counts the rest", () => {
  const output = Array.from({ length: 12 }, (_, index) => `line${index + 1}`).join("\n");
  const visible = Array.from({ length: 10 }, (_, index) => plain(`line${index + 1}`));
  assert.equal(buildReadResultText(readInput({ output, isError: true, expanded: false })), lines(visible) + FOOTER_2);
});

test("buildReadResultText: an image result is not file text, so it loses the gutter", () => {
  const text = buildReadResultText(readInput({ output: "a screenshot", path: "a.png", hasImage: true }));
  assert.equal(text, lines([plain("a screenshot")]));
});

test("buildReadResultText: a path with no known grammar never reaches the highlighter", () => {
  const calls: HighlightCall[] = [];
  const text = buildReadResultText(readInput({ output: "plain text", path: "notes", highlight: makeHighlight(calls) }));
  assert.equal(text, lines([gutter(1, 1, plain("plain text"))]));
  assert.deepEqual(calls, []);
});

test("buildReadResultText: trailing empty lines are dropped from the body and the count", () => {
  const text = buildReadResultText(readInput({ output: "a\nb\n\n\n" }));
  assert.equal(text, lines([gutter(1, 1, plain("a")), gutter(2, 1, plain("b"))]));
});

test("buildReadResultText: a blank line in the middle is numbered and has no trailing space", () => {
  const text = buildReadResultText(readInput({ output: "a\n\nb" }));
  assert.equal(text, lines([gutter(1, 1, plain("a")), gutter(2, 1, ""), gutter(3, 1, plain("b"))]));
});

test("buildReadResultText: tabs are expanded before the line is painted", () => {
  const text = buildReadResultText(readInput({ output: "\tindented" }));
  assert.equal(text, lines([gutter(1, 1, plain("   indented"))]));
});

test("buildReadResultText: a highlighter that throws still renders the body", () => {
  const failing: HighlightFn = () => {
    throw new Error("no grammar");
  };
  const text = buildReadResultText(readInput({ output: "const a = 1;", path: "a.ts", highlight: failing }));
  assert.equal(text, lines([gutter(1, 1, plain("const a = 1;"))]));
});

test("readOffset: numbers and numeric strings are read, everything else is unset", () => {
  assert.equal(readOffset({ offset: 5 }), 5);
  assert.equal(readOffset({ offset: "5" }), 5);
  // The tool is 1-based, so anything below it is clamped instead of shifting the
  // gutter into line zero.
  assert.equal(readOffset({ offset: 0 }), 1);
  assert.equal(readOffset({ offset: -3 }), 1);
  assert.equal(readOffset({ offset: 2.7 }), 2);
  assert.equal(readOffset({ offset: Number.NaN }), undefined);
  assert.equal(readOffset({ offset: "abc" }), undefined);
  assert.equal(readOffset({}), undefined);
  assert.equal(readOffset(undefined), undefined);
});

test("readLimit: the limit is read the same way as the offset", () => {
  assert.equal(readLimit({ limit: 7 }), 7);
  assert.equal(readLimit({ limit: "7" }), 7);
  assert.equal(readLimit({ limit: 0 }), 1);
  assert.equal(readLimit({}), undefined);
  assert.equal(readLimit(undefined), undefined);
});

test("readPath: file_path wins over path and a non-string argument is no path at all", () => {
  assert.equal(readPath({ file_path: "a.ts" }), "a.ts");
  assert.equal(readPath({ path: "b.ts" }), "b.ts");
  assert.equal(readPath({ file_path: "a.ts", path: "b.ts" }), "a.ts");
  assert.equal(readPath({ path: 42 }), "");
  assert.equal(readPath({}), "");
  assert.equal(readPath(undefined), "");
});

test("buildReadCallText: the expanded header carries the title, the path and the range", () => {
  assert.equal(TOKEN.path, "accent");
  assert.equal(buildReadCallText(callInput()), "<toolTitle><b>read</b></toolTitle> <accent>src/a.ts</accent>");
  assert.equal(
    buildReadCallText(callInput({ offset: 10, limit: 5 })),
    "<toolTitle><b>read</b></toolTitle> <accent>src/a.ts</accent><warning>:10-14</warning>",
  );
  assert.equal(
    buildReadCallText(callInput({ offset: 10 })),
    "<toolTitle><b>read</b></toolTitle> <accent>src/a.ts</accent><warning>:10</warning>",
  );
});

test("buildReadCallText: a path under the home directory is shown with a tilde", () => {
  const path = join(homedir(), "notes.md");
  assert.equal(
    buildReadCallText(callInput({ path, cwd: undefined })),
    "<toolTitle><b>read</b></toolTitle> <accent>~/notes.md</accent>",
  );
});

test("buildReadCallText: the header links the shortened text to the absolute path", () => {
  setCapabilityOverrides({ hyperlinks: true });
  try {
    const href = pathToFileURL(join("/work", "src/a.ts")).href;
    const text = buildReadCallText(callInput());
    assert.equal(
      text,
      `<toolTitle><b>read</b></toolTitle> \x1b]8;;${href}\x1b\\<accent>src/a.ts</accent>\x1b]8;;\x1b\\`,
    );
  } finally {
    setCapabilityOverrides({ hyperlinks: false });
  }
});

test("buildReadCallText: a compact skill header names the directory instead of the path", () => {
  const text = buildReadCallText(callInput({ path: "skills/pdf/SKILL.md", compact: true }));
  assert.equal(
    text,
    `<customMessageLabel>${BOLD_ON}[skill]${BOLD_OFF} </customMessageLabel><customMessageText>pdf</customMessageText>${COMPACT_HINT}`,
  );
});

test("buildReadCallText: a compact resource header is the relative path of an agent file", () => {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const text = buildReadCallText(callInput({ path: name, cwd: "/work", compact: true }));
    assert.equal(text, `<toolTitle><b>read resource</b></toolTitle> <accent>${name}</accent>${COMPACT_HINT}`);
  }
});

test("buildReadCallText: a file of pi's own documentation is a compact resource", () => {
  const path = join(getPackageDir(), "docs", "tools.md");
  assert.equal(
    buildReadCallText(callInput({ path, cwd: "/work", compact: true })),
    `<toolTitle><b>read resource</b></toolTitle> <accent>docs/tools.md</accent>${COMPACT_HINT}`,
  );
});

test("buildReadCallText: the compact header keeps the line range and only collapses known files", () => {
  assert.equal(
    buildReadCallText(callInput({ path: "AGENTS.md", offset: 3, limit: 2, compact: true })),
    "<toolTitle><b>read resource</b></toolTitle> <accent>AGENTS.md</accent><warning>:3-4</warning>" + COMPACT_HINT,
  );
  // Every other file keeps the full header even when the transcript is collapsed.
  assert.equal(
    buildReadCallText(callInput({ path: "src/a.ts", compact: true })),
    "<toolTitle><b>read</b></toolTitle> <accent>src/a.ts</accent>",
  );
});
