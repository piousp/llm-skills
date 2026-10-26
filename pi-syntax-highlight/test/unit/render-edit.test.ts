import { test } from "node:test";
import assert from "node:assert/strict";
import type { HighlightFn } from "../../src/highlight.ts";
import {
  buildEditDiffText,
  buildEditErrorText,
  classifyEditDiffLine,
  type EditDiffInput,
} from "../../src/render-edit.ts";
import { INVERSE_OFF, INVERSE_ON, TOKEN } from "../../src/tokens.ts";

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

// The intra-line markers are inserted by visible column, so the fakes used with a
// modification must not invent markup: `<typescript>` would count as characters
// on screen.
const plainHighlight: HighlightFn = (code) => code.split("\n");

function diffInput(overrides: Partial<EditDiffInput> = {}): EditDiffInput {
  return {
    diff: "",
    path: "a.ts",
    theme: fakeTheme,
    highlight: makeHighlight([]),
    ...overrides,
  };
}

// The marker, then the number, then one space, then the content: the shape the
// display diff of the tool has.
function diffLine(token: string, marker: string, number: string, content: string): string {
  const painted = /\d/.test(number) ? `<syntaxNumber>${number}</syntaxNumber>` : number;
  return `<${token}>${marker}</${token}>${painted} ${content}`;
}

test("classifyEditDiffLine: the three markers and the right-aligned number are separated", () => {
  assert.deepEqual(classifyEditDiffLine("+12 const b = 2;"), {
    kind: "added",
    prefix: "+",
    number: "12",
    content: "const b = 2;",
  });
  assert.deepEqual(classifyEditDiffLine("-  4 y"), { kind: "removed", prefix: "-", number: "  4", content: "y" });
  assert.deepEqual(classifyEditDiffLine("   7 z"), { kind: "context", prefix: " ", number: "  7", content: "z" });
});

test("classifyEditDiffLine: the elision between two hunks has no number", () => {
  assert.deepEqual(classifyEditDiffLine("     ..."), {
    kind: "elision",
    prefix: " ",
    number: "   ",
    content: "...",
  });
});

test("classifyEditDiffLine: a line outside the grammar is passed through", () => {
  assert.deepEqual(classifyEditDiffLine("not a diff line"), { kind: "other", raw: "not a diff line" });
  assert.deepEqual(classifyEditDiffLine(""), { kind: "other", raw: "" });
});

test("buildEditDiffText: an added line carries its marker, its number and the highlighted content", () => {
  const text = buildEditDiffText(diffInput({ diff: "+1 const b = 2;" }));
  assert.equal(text, diffLine("toolDiffAdded", "+", "1", "<typescript>const b = 2;</typescript>"));
});

test("buildEditDiffText: a context line keeps the diff context color and its own number", () => {
  const text = buildEditDiffText(diffInput({ diff: " 1 unchanged" }));
  assert.equal(text, diffLine("toolDiffContext", " ", "1", "<typescript>unchanged</typescript>"));
});

test("buildEditDiffText: contiguous lines of the same kind are highlighted in one call", () => {
  const calls: HighlightCall[] = [];
  const text = buildEditDiffText(diffInput({ diff: "+1 one\n+2 two", highlight: makeHighlight(calls) }));
  assert.deepEqual(calls, [{ code: "one\ntwo", lang: "typescript" }]);
  assert.equal(
    text,
    [
      diffLine("toolDiffAdded", "+", "1", "<typescript>one</typescript>"),
      diffLine("toolDiffAdded", "+", "2", "<typescript>two</typescript>"),
    ].join("\n"),
  );
});

test("buildEditDiffText: a kind change starts a new run and a new call", () => {
  const calls: HighlightCall[] = [];
  buildEditDiffText(diffInput({ diff: "+1 one\n 2 two\n+3 three", highlight: makeHighlight(calls) }));
  assert.deepEqual(calls, [
    { code: "one", lang: "typescript" },
    { code: "two", lang: "typescript" },
    { code: "three", lang: "typescript" },
  ]);
});

test("buildEditDiffText: without a grammar the content keeps its kind's color", () => {
  assert.equal(TOKEN.content, "text");
  const calls: HighlightCall[] = [];
  const text = buildEditDiffText(diffInput({ diff: "+1 one\n 2 two", path: "notes", highlight: makeHighlight(calls) }));
  assert.deepEqual(calls, []);
  assert.equal(
    text,
    [
      diffLine("toolDiffAdded", "+", "1", "<toolDiffAdded>one</toolDiffAdded>"),
      diffLine("toolDiffContext", " ", "2", "<toolDiffContext>two</toolDiffContext>"),
    ].join("\n"),
  );
});

test("buildEditDiffText: the elision is painted as metainformation", () => {
  const text = buildEditDiffText(diffInput({ diff: "   ..." }));
  // The number is the empty slot of the elision, so it is emitted as the spaces
  // it is: painting them would be the same pixels with two extra sequences.
  assert.equal(text, diffLine("toolDiffContext", " ", " ", "<toolDiffContext>...</toolDiffContext>"));
});

test("buildEditDiffText: a line outside the grammar keeps the content color", () => {
  const text = buildEditDiffText(diffInput({ diff: "not a diff line" }));
  assert.equal(text, "<text>not a diff line</text>");
});

test("buildEditDiffText: an empty diff renders nothing", () => {
  assert.equal(buildEditDiffText(diffInput({ diff: "" })), "");
});

test("buildEditDiffText: one removed and one added line invert only the changed words", () => {
  const text = buildEditDiffText(
    diffInput({ diff: "-1 const a = 1;\n+1 const b = 2;", highlight: plainHighlight }),
  );
  assert.equal(
    text,
    [
      diffLine("toolDiffRemoved", "-", "1", `const ${INVERSE_ON}a${INVERSE_OFF} = ${INVERSE_ON}1${INVERSE_OFF};`),
      diffLine("toolDiffAdded", "+", "1", `const ${INVERSE_ON}b${INVERSE_OFF} = ${INVERSE_ON}2${INVERSE_OFF};`),
    ].join("\n"),
  );
});

test("buildEditDiffText: the indentation of the first changed part is never inverted", () => {
  const text = buildEditDiffText(diffInput({ diff: "-1   x\n+1   y", highlight: plainHighlight }));
  assert.equal(
    text,
    [
      diffLine("toolDiffRemoved", "-", "1", `  ${INVERSE_ON}x${INVERSE_OFF}`),
      diffLine("toolDiffAdded", "+", "1", `  ${INVERSE_ON}y${INVERSE_OFF}`),
    ].join("\n"),
  );
});

test("buildEditDiffText: several removed lines are not a modification, so nothing is inverted", () => {
  const text = buildEditDiffText(diffInput({ diff: "-1 a\n-2 b\n+1 c", highlight: plainHighlight }));
  assert.equal(text.includes(INVERSE_ON), false);
  assert.equal(text.split("\n").length, 3);
});

test("buildEditDiffText: a standalone added line is not a modification", () => {
  const text = buildEditDiffText(diffInput({ diff: "+1 b\n-1 a", highlight: plainHighlight }));
  assert.equal(text.includes(INVERSE_ON), false);
  assert.equal(text.split("\n").length, 2);
});

test("buildEditDiffText: one removed line followed by several added lines stays flat", () => {
  const text = buildEditDiffText(diffInput({ diff: "-1 a\n+1 b\n+2 c", highlight: plainHighlight }));
  assert.equal(text.includes(INVERSE_ON), false);
});

test("buildEditDiffText: the changed span is inverted inside an already colored line", () => {
  const ansiHighlight: HighlightFn = (code) => code.split("\n").map((line) => `\x1b[36m${line}\x1b[39m`);
  const text = buildEditDiffText(diffInput({ diff: "-1 const a = 1;\n+1 const b = 2;", highlight: ansiHighlight }));
  assert.equal(
    text,
    [
      diffLine(
        "toolDiffRemoved",
        "-",
        "1",
        `\x1b[36mconst ${INVERSE_ON}a${INVERSE_OFF} = ${INVERSE_ON}1${INVERSE_OFF};\x1b[39m`,
      ),
      diffLine(
        "toolDiffAdded",
        "+",
        "1",
        `\x1b[36mconst ${INVERSE_ON}b${INVERSE_OFF} = ${INVERSE_ON}2${INVERSE_OFF};\x1b[39m`,
      ),
    ].join("\n"),
  );
});

test("buildEditErrorText: the failure is painted in the error color without a leading newline", () => {
  assert.equal(TOKEN.broken, "error");
  assert.equal(buildEditErrorText("no such file", fakeTheme), "<error>no such file</error>");
});

test("buildEditErrorText: several text blocks stay inside the one wrapper", () => {
  assert.equal(buildEditErrorText("first\nsecond", fakeTheme), "<error>first\nsecond</error>");
});

test("buildEditErrorText: an empty failure renders nothing", () => {
  assert.equal(buildEditErrorText("", fakeTheme), "");
});
