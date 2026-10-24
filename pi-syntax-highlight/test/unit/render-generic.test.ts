import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGenericResultText, type GenericInput } from "../../src/render-generic.ts";
import type { HighlightFn } from "../../src/highlight.ts";
import { TOKEN } from "../../src/tokens.ts";

const fakeTheme = {
  fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
  bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
  bold: (t: string) => `<b>${t}</b>`,
};

const EXPAND_HINT = "<hint>";
const FOOTER_1 = "<muted>\n... (1 more lines,</muted> <hint><muted>)</muted>";

function styled(color: string, text: string): string {
  return `<${color}>${text}</${color}>`;
}

function styledDiffChange(background: string, foreground: string, line: string): string {
  return `<bg:${background}>${styled(foreground, line)}</bg:${background}>`;
}

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

function genericInput(overrides: Partial<GenericInput> = {}): GenericInput {
  return {
    output: "",
    expanded: false,
    isError: false,
    theme: fakeTheme,
    expandHint: EXPAND_HINT,
    ...overrides,
  };
}

const PLAIN_LINES = Array.from({ length: 11 }, (_, index) => `line ${index}`);

test("buildGenericResultText: a JSON object is highlighted as one block", () => {
  const calls: HighlightCall[] = [];
  const json = '{"a":1,"b":[2,3]}';
  const text = buildGenericResultText(genericInput({ output: json }), makeHighlight(calls));
  assert.deepEqual(calls, [{ code: json, lang: "json" }]);
  assert.equal(text, ["", styled("json", json)].join("\n"));
});

test("buildGenericResultText: a multi-line JSON array keeps the surrounding context", () => {
  const calls: HighlightCall[] = [];
  const json = "[\n  1,\n  2\n]";
  const text = buildGenericResultText(genericInput({ output: json }), makeHighlight(calls));
  assert.deepEqual(calls, [{ code: json, lang: "json" }]);
  assert.equal(
    text,
    ["", styled("json", "["), styled("json", "  1,"), styled("json", "  2"), styled("json", "]")].join("\n"),
  );
});

test("buildGenericResultText: output that only looks like JSON keeps the flat content color", () => {
  const calls: HighlightCall[] = [];
  const output = '{"a": }';
  const text = buildGenericResultText(genericInput({ output }), makeHighlight(calls));
  assert.deepEqual(calls, []);
  assert.equal(text, ["", styled("text", output)].join("\n"));
});

test("buildGenericResultText: a diff is painted per line, changes over their own background", () => {
  const calls: HighlightCall[] = [];
  const output = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,2 +1,3 @@",
    " const a = 1;",
    "+const b = 2;",
    "-const c = 3;",
  ].join("\n");
  const text = buildGenericResultText(genericInput({ output }), makeHighlight(calls));
  assert.deepEqual(calls, []);
  assert.equal(
    text,
    [
      "",
      styled("text", "diff --git a/x.ts b/x.ts"),
      styled("syntaxFunction", "--- a/x.ts"),
      styled("syntaxFunction", "+++ b/x.ts"),
      styled("syntaxFunction", "@@ -1,2 +1,3 @@"),
      styled("text", " const a = 1;"),
      styledDiffChange("toolSuccessBg", "toolDiffAdded", "+const b = 2;"),
      styledDiffChange("toolErrorBg", "toolDiffRemoved", "-const c = 3;"),
    ].join("\n"),
  );
});

test("buildGenericResultText: plain text is painted line by line in the content token", () => {
  const calls: HighlightCall[] = [];
  const text = buildGenericResultText(genericInput({ output: "alpha\nbeta" }), makeHighlight(calls));
  assert.deepEqual(calls, []);
  assert.equal(text, ["", styled("text", "alpha"), styled("text", "beta")].join("\n"));
});

test("buildGenericResultText: eleven lines collapse to ten plus the footer", () => {
  const text = buildGenericResultText(genericInput({ output: PLAIN_LINES.join("\n") }), makeHighlight([]));
  assert.equal(text, ["", ...PLAIN_LINES.slice(0, 10).map((line) => styled("text", line))].join("\n") + FOOTER_1);
});

test("buildGenericResultText: expanded shows every line and no footer", () => {
  const text = buildGenericResultText(
    genericInput({ output: PLAIN_LINES.join("\n"), expanded: true }),
    makeHighlight([]),
  );
  assert.equal(text, ["", ...PLAIN_LINES.map((line) => styled("text", line))].join("\n"));
});

test("buildGenericResultText: a trailing notice is painted in the warning token and is not a line", () => {
  const text = buildGenericResultText(
    genericInput({ output: `${PLAIN_LINES.join("\n")}\n\n[100 matches limit]` }),
    makeHighlight([]),
  );
  assert.equal(
    text,
    ["", ...PLAIN_LINES.slice(0, 10).map((line) => styled("text", line))].join("\n") +
      FOOTER_1 +
      "\n" +
      styled("warning", "[100 matches limit]"),
  );
});

test("buildGenericResultText: an error result is painted flat in the content color", () => {
  assert.equal(TOKEN.content, "text");
  // A JSON body that parses is the case the flat rule exists for: painted by
  // kind it would look like a normal result instead of a failure.
  const calls: HighlightCall[] = [];
  const json = '{"error":"boom"}';
  const text = buildGenericResultText(genericInput({ output: json, isError: true }), makeHighlight(calls));
  assert.deepEqual(calls, []);
  assert.equal(text, ["", styled("text", json)].join("\n"));
});

test("buildGenericResultText: empty and whitespace-only output render nothing", () => {
  assert.equal(buildGenericResultText(genericInput({ output: "" }), makeHighlight([])), "");
  assert.equal(buildGenericResultText(genericInput({ output: "  \n\n \t " }), makeHighlight([])), "");
});
