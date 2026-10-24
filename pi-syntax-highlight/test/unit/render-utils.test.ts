import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_BYTES, formatSize } from "@earendil-works/pi-coding-agent";
import { Text, imageFallback } from "@earendil-works/pi-tui";
import {
  buildListBody,
  diffChangeLine,
  isJsonDocument,
  moreLinesFooter,
  reuseText,
  splitTrailingNotice,
  styleDiffLine,
  textOutput,
  truncatedNotice,
  truncationWarnings,
  type RenderContext,
  type TruncationParts,
} from "../../src/render-utils.ts";

const fakeTheme = {
  fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
  bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
  bold: (t: string) => `<b>${t}</b>`,
};

function renderContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    args: undefined,
    lastComponent: undefined,
    state: {},
    showImages: false,
    durationMs: undefined,
    ...overrides,
  };
}

test("textOutput: no result renders nothing", () => {
  assert.equal(textOutput(undefined), "");
});

test("textOutput: text blocks are joined by a newline", () => {
  const result = { content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] };
  assert.equal(textOutput(result), "first\nsecond");
});

test("textOutput: SGR colors and carriage returns are stripped and the text is kept", () => {
  const result = { content: [{ type: "text", text: "\x1b[31mred\x1b[39m\r\nnext" }] };
  assert.equal(textOutput(result), "red\nnext");
});

test("textOutput: an OSC sequence is stripped and the text around it is kept", () => {
  const result = { content: [{ type: "text", text: "\x1b]0;title\x07visible" }] };
  assert.equal(textOutput(result), "visible");
});

test("textOutput: binary control characters are stripped", () => {
  const result = { content: [{ type: "text", text: "a\x01b\x08c" }] };
  assert.equal(textOutput(result), "abc");
});

test("textOutput: text without image blocks gets no fallback line", () => {
  const result = { content: [{ type: "text", text: "only text" }] };
  assert.equal(textOutput(result), "only text");
  assert.equal(textOutput(result, false), "only text");
});

test("textOutput: image blocks become the built-in fallback when images are hidden", () => {
  const result = {
    content: [
      { type: "text", text: "first" },
      { type: "image", mimeType: "image/png", data: "not-an-image" },
      { type: "text", text: "second" },
    ],
  };
  // The exact wording belongs to the package; comparing against its own
  // formatter keeps this test from pinning a format the host may change.
  assert.equal(textOutput(result, false), `first\nsecond\n${imageFallback("image/png")}`);
});

test("textOutput: an image without a mime type falls back to the placeholder one", () => {
  const result = { content: [{ type: "image" }] };
  assert.equal(textOutput(result, false), imageFallback("image/unknown"));
});

test("splitTrailingNotice: a blank-line-separated bracket block becomes the notice", () => {
  assert.deepEqual(splitTrailingNotice("a.ts:1: x  \n\n[3 matches limit]"), {
    body: "a.ts:1: x",
    notice: "3 matches limit",
  });
});

test("splitTrailingNotice: a trailing bracket with no blank line before it stays in the body", () => {
  assert.deepEqual(splitTrailingNotice("const x = a[0]"), { body: "const x = a[0]" });
});

test("splitTrailingNotice: a block containing a newline is not a notice", () => {
  const output = "a.ts:1: x\n\n[first line,\nsecond line]";
  assert.deepEqual(splitTrailingNotice(output), { body: output });
});

test("splitTrailingNotice: an output that is only a notice has an empty body", () => {
  assert.deepEqual(splitTrailingNotice("\n\n[12 matches limit]"), {
    body: "",
    notice: "12 matches limit",
  });
});

test("moreLinesFooter: byte-identical to the built-in footer", () => {
  assert.equal(
    moreLinesFooter(5, fakeTheme, "<hint>"),
    "<muted>\n... (5 more lines,</muted> <hint><muted>)</muted>",
  );
});

test("truncationWarnings: nothing to report yields an empty list", () => {
  assert.deepEqual(truncationWarnings({}), []);
  assert.deepEqual(truncationWarnings({ extra: [] }), []);
});

test("truncationWarnings: the limit alone carries its label, and the bare word without one", () => {
  assert.deepEqual(truncationWarnings({ limitCount: 100, limitLabel: "matches limit" }), ["100 matches limit"]);
  assert.deepEqual(truncationWarnings({ limitCount: 50 }), ["50 limit"]);
});

test("truncationWarnings: line truncation reports the shown and total counts without the prefix", () => {
  assert.deepEqual(truncationWarnings({ truncatedBy: "lines", outputLines: 10, totalLines: 500 }), [
    "showing 10 of 500 lines",
  ]);
});

test("truncationWarnings: byte truncation reports the shown lines and the limit", () => {
  assert.deepEqual(truncationWarnings({ truncatedBy: "bytes", outputLines: 7, maxBytes: 1024 }), [
    `7 lines shown (${formatSize(1024)} limit)`,
  ]);
  // Without a recorded limit the built-in default stands in for it.
  assert.deepEqual(truncationWarnings({ truncatedBy: "bytes", outputLines: 7 }), [
    `7 lines shown (${formatSize(DEFAULT_MAX_BYTES)} limit)`,
  ]);
  // A caller that records only the limit still gets the byte wording.
  assert.deepEqual(truncationWarnings({ maxBytes: 2048 }), [`0 lines shown (${formatSize(2048)} limit)`]);
});

test("truncationWarnings: the limit-only byte style drops the line count", () => {
  const parts: TruncationParts = { truncatedBy: "bytes", maxBytes: 1024, byteStyle: "limit-only" };
  assert.deepEqual(truncationWarnings(parts), [`${formatSize(1024)} limit`]);
  assert.deepEqual(truncationWarnings({ ...parts, maxBytes: undefined }), [`${formatSize(DEFAULT_MAX_BYTES)} limit`]);
});

test("truncationWarnings: both warnings keep the built-in order, then the caller's own", () => {
  assert.deepEqual(
    truncationWarnings({
      limitCount: 100,
      limitLabel: "matches limit",
      truncatedBy: "bytes",
      maxBytes: 1048576,
      byteStyle: "limit-only",
      extra: ["some lines truncated"],
    }),
    ["100 matches limit", `${formatSize(1048576)} limit`, "some lines truncated"],
  );
});

test("truncatedNotice: nothing to report yields no line at all", () => {
  assert.equal(truncatedNotice({ limitLabel: "matches limit" }, fakeTheme), "");
  // An untruncated result carries the block but not its byte limit.
  assert.equal(
    truncatedNotice({ limitLabel: "matches limit", truncation: { truncated: false, maxBytes: 1024 } }, fakeTheme),
    "",
  );
});

test("truncatedNotice: the limit alone is prefixed and painted in the notice token", () => {
  assert.equal(
    truncatedNotice({ limitCount: 100, limitLabel: "matches limit" }, fakeTheme),
    "\n<warning>[Truncated: 100 matches limit]</warning>",
  );
});

test("truncatedNotice: the byte limit follows the count and uses the limit-only wording", () => {
  assert.equal(
    truncatedNotice(
      { limitCount: 100, limitLabel: "matches limit", truncation: { truncated: true, maxBytes: 1048576 } },
      fakeTheme,
    ),
    `\n<warning>[Truncated: 100 matches limit, ${formatSize(1048576)} limit]</warning>`,
  );
});

test("truncatedNotice: the caller's own notices come last", () => {
  assert.equal(
    truncatedNotice(
      {
        limitCount: 20,
        limitLabel: "results limit",
        truncation: { truncated: true, maxBytes: 1024 },
        extra: ["some lines truncated"],
      },
      fakeTheme,
    ),
    `\n<warning>[Truncated: 20 results limit, ${formatSize(1024)} limit, some lines truncated]</warning>`,
  );
  // An empty list adds nothing, which is what the callers pass when the tool
  // did not truncate any line.
  assert.equal(
    truncatedNotice({ limitCount: 20, limitLabel: "results limit", extra: [] }, fakeTheme),
    "\n<warning>[Truncated: 20 results limit]</warning>",
  );
});

test("diffChangeLine: added and removed lines carry their foreground over their own background", () => {
  assert.equal(
    diffChangeLine("+const b = 2;", fakeTheme),
    "<bg:toolSuccessBg><toolDiffAdded>+const b = 2;</toolDiffAdded></bg:toolSuccessBg>",
  );
  assert.equal(
    diffChangeLine("-const c = 3;", fakeTheme),
    "<bg:toolErrorBg><toolDiffRemoved>-const c = 3;</toolDiffRemoved></bg:toolErrorBg>",
  );
});

test("styleDiffLine: the three header forms share the function color", () => {
  for (const line of ["@@ -1,2 +1,3 @@", "+++ b/x.ts", "--- a/x.ts"]) {
    assert.equal(styleDiffLine(line, fakeTheme), `<syntaxFunction>${line}</syntaxFunction>`);
  }
});

test("styleDiffLine: added and removed lines go through the diff tokens", () => {
  assert.equal(
    styleDiffLine("+const b = 2;", fakeTheme),
    "<bg:toolSuccessBg><toolDiffAdded>+const b = 2;</toolDiffAdded></bg:toolSuccessBg>",
  );
  assert.equal(
    styleDiffLine("-const c = 3;", fakeTheme),
    "<bg:toolErrorBg><toolDiffRemoved>-const c = 3;</toolDiffRemoved></bg:toolErrorBg>",
  );
});

test("styleDiffLine: an unchanged line, and the diff header, stay in the content color", () => {
  assert.equal(styleDiffLine(" const a = 1;", fakeTheme), "<text> const a = 1;</text>");
  assert.equal(
    styleDiffLine("diff --git a/x.ts b/x.ts", fakeTheme),
    "<text>diff --git a/x.ts b/x.ts</text>",
  );
});

test("isJsonDocument: an object or an array is JSON, whatever the indentation is", () => {
  assert.equal(isJsonDocument('{"a":1}'), true);
  assert.equal(isJsonDocument('[1,2]'), true);
  assert.equal(isJsonDocument("\n  {\"a\": 1}\n"), true);
});

test("isJsonDocument: text that does not open with a brace or a bracket is not JSON", () => {
  assert.equal(isJsonDocument("plain text"), false);
  assert.equal(isJsonDocument('"{"'), false);
  assert.equal(isJsonDocument(""), false);
});

test("isJsonDocument: an opener plus a failed parse is not JSON", () => {
  assert.equal(isJsonDocument('{"a": }'), false);
  assert.equal(isJsonDocument("[1,2"), false);
});

test("buildListBody: an empty body renders nothing", () => {
  assert.equal(
    buildListBody({
      body: "",
      expanded: false,
      collapsedLines: 2,
      theme: fakeTheme,
      expandHint: "<hint>",
      styleLine: (raw) => `<${raw}>`,
    }),
    "",
  );
});

test("buildListBody: the collapsed view styles only the visible lines and counts the rest", () => {
  const text = buildListBody({
    body: "l1\nl2\nl3",
    expanded: false,
    collapsedLines: 2,
    theme: fakeTheme,
    expandHint: "<hint>",
    styleLine: (raw) => `<${raw}>`,
  });
  assert.equal(text, "\n<l1>\n<l2><muted>\n... (1 more lines,</muted> <hint><muted>)</muted>");
});

test("buildListBody: the expanded view has no footer", () => {
  const text = buildListBody({
    body: "l1\nl2\nl3",
    expanded: true,
    collapsedLines: 2,
    theme: fakeTheme,
    expandHint: "<hint>",
    styleLine: (raw) => `<${raw}>`,
  });
  assert.equal(text, "\n<l1>\n<l2>\n<l3>");
});

test("reuseText: the previous component is reused when it is a Text", () => {
  const previous = new Text("", 0, 0);
  assert.equal(reuseText(renderContext({ lastComponent: previous })), previous);
});

test("reuseText: a fresh Text is built when the slot holds no Text", () => {
  const component = reuseText(renderContext());
  assert.ok(component instanceof Text);
  assert.notEqual(component, reuseText(renderContext()));
});
