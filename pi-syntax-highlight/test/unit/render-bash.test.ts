import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_BYTES, formatSize } from "@earendil-works/pi-coding-agent";
import { buildBashBody, formatDuration, type BashInput } from "../../src/render-bash.ts";
import type { HighlightFn } from "../../src/highlight.ts";
import { TOKEN } from "../../src/tokens.ts";

const fakeTheme = {
  fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
  bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
  bold: (t: string) => `<b>${t}</b>`,
};

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

function styled(color: string, text: string): string {
  return `<${color}>${text}</${color}>`;
}

function styledDiffChange(background: string, foreground: string, line: string): string {
  return `<bg:${background}>${styled(foreground, line)}</bg:${background}>`;
}

function bashInput(overrides: Partial<BashInput> = {}): BashInput {
  return {
    output: "",
    details: undefined,
    durationMs: undefined,
    theme: fakeTheme,
    ...overrides,
  };
}

test("buildBashBody: a diff is painted per line, headers in the function color and changes over their own background", () => {
  const output = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,2 +1,3 @@",
    " const a = 1;",
    "+const b = 2;",
    "-const c = 3;",
  ].join("\n");
  const { body, warnings, timer } = buildBashBody(bashInput({ output }));
  assert.equal(
    body,
    [
      styled("text", "diff --git a/x.ts b/x.ts"),
      styled("syntaxFunction", "--- a/x.ts"),
      styled("syntaxFunction", "+++ b/x.ts"),
      styled("syntaxFunction", "@@ -1,2 +1,3 @@"),
      styled("text", " const a = 1;"),
      styledDiffChange("toolSuccessBg", "toolDiffAdded", "+const b = 2;"),
      styledDiffChange("toolErrorBg", "toolDiffRemoved", "-const c = 3;"),
    ].join("\n"),
  );
  assert.equal(warnings, undefined);
  assert.equal(timer, undefined);
});

test("buildBashBody: JSON output is highlighted as one block", () => {
  const calls: HighlightCall[] = [];
  const json = '{"a":1,"b":[2,3]}';
  const { body } = buildBashBody(bashInput({ output: json, highlight: makeHighlight(calls) }));
  assert.deepEqual(calls, [{ code: json, lang: "json" }]);
  assert.equal(body, "<json>{\"a\":1,\"b\":[2,3]}</json>");
});

test("buildBashBody: output that starts like JSON but does not parse is painted per line", () => {
  const { body } = buildBashBody(bashInput({ output: '{"a": }', highlight: makeHighlight([]) }));
  assert.equal(body, styled("text", '{"a": }'));
});

test("buildBashBody: error and warning lines get their own colors", () => {
  assert.equal(TOKEN.broken, "error");
  assert.equal(TOKEN.notice, "warning");
  const { body } = buildBashBody(bashInput({ output: "error: boom\nwarning: careful\nplain text" }));
  assert.equal(
    body,
    [
      styled("error", "error: boom"),
      styled("warning", "warning: careful"),
      styled("text", "plain text"),
    ].join("\n"),
  );
});

test("buildBashBody: a path, line and text line is split into its three colors", () => {
  const { body } = buildBashBody(bashInput({ output: "src/app.ts:12: some text" }));
  assert.equal(
    body,
    [
      styled("accent", "src/app.ts"),
      styled("dim", ":"),
      styled("syntaxNumber", "12"),
      styled("dim", ":"),
      " ",
      styled("text", "some text"),
    ].join(""),
  );
});

test("buildBashBody: line truncation is reported with the shown and total line counts", () => {
  const { body, warnings } = buildBashBody(
    bashInput({
      output: "line1\nline2",
      details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 10, totalLines: 500 } },
    }),
  );
  assert.equal(warnings, "Truncated: showing 10 of 500 lines");
  assert.equal(body, [styled("text", "line1"), styled("text", "line2")].join("\n"));
});

test("buildBashBody: byte truncation reports the limit through formatSize", () => {
  const recorded = buildBashBody(
    bashInput({
      output: "x",
      details: { truncation: { truncated: true, truncatedBy: "bytes", outputLines: 7, maxBytes: 1024 } },
    }),
  );
  assert.equal(recorded.warnings, `Truncated: 7 lines shown (${formatSize(1024)} limit)`);

  const implicit = buildBashBody(
    bashInput({ output: "x", details: { truncation: { truncated: true, truncatedBy: "bytes", outputLines: 7 } } }),
  );
  assert.equal(implicit.warnings, `Truncated: 7 lines shown (${formatSize(DEFAULT_MAX_BYTES)} limit)`);
});

test("buildBashBody: the full output block moves from the body to the warnings", () => {
  const output = "line1\nline2\n\n[Full output: /tmp/pi-bash-1.log]";
  const { body, warnings } = buildBashBody(
    bashInput({
      output,
      details: {
        truncation: { truncated: true, truncatedBy: "lines", outputLines: 2, totalLines: 900 },
        fullOutputPath: "/tmp/pi-bash-1.log",
      },
    }),
  );
  assert.equal(body, [styled("text", "line1"), styled("text", "line2")].join("\n"));
  assert.equal(warnings, "Full output: /tmp/pi-bash-1.log. Truncated: showing 2 of 900 lines");
});

test("buildBashBody: a full output path without truncation is warned and stays in the body", () => {
  const output = "line1\n\n[Full output: /tmp/x.log]";
  const { body, warnings } = buildBashBody(bashInput({ output, details: { fullOutputPath: "/tmp/x.log" } }));
  assert.equal(warnings, "Full output: /tmp/x.log");
  assert.equal(
    body,
    [
      styled("text", "line1"),
      styled("text", ""),
      styled("text", "[Full output: /tmp/x.log]"),
    ].join("\n"),
  );
});

test("buildBashBody: an untruncated result carries no warning", () => {
  const { warnings } = buildBashBody(bashInput({ output: "line1" }));
  assert.equal(warnings, undefined);
});

test("buildBashBody: durationMs becomes the timer text without the prefix", () => {
  assert.equal(buildBashBody(bashInput({ output: "x", durationMs: 4200 })).timer, "4.2s");
  assert.equal(buildBashBody(bashInput({ output: "x" })).timer, undefined);
});

test("buildBashBody: empty and blank outputs have no body, warnings or timer", () => {
  for (const output of ["", "  \n  "]) {
    assert.deepEqual(buildBashBody(bashInput({ output })), {
      body: "",
      warnings: undefined,
      timer: undefined,
    });
  }
});

test("formatDuration: identical to the built-in formatter", () => {
  assert.equal(formatDuration(4200), "4.2s");
  assert.equal(formatDuration(65000), "1m 5s");
  assert.equal(formatDuration(7324000), "2h 2m 4s");
  // toFixed rounds 59.999 up to 60, which is what stock pi prints.
  assert.equal(formatDuration(59999), "60.0s");
});
