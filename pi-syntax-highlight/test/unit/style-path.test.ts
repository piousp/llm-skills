import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPathLine, stylePath } from "../../src/style-path.ts";
import { splitExtension } from "../../src/tokens.ts";

const fakeTheme = {
  fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
  bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
  bold: (t: string) => `<b>${t}</b>`,
};

test("stylePath: every segment but the last is dimmed, the last takes the type color in bold", () => {
  assert.equal(
    stylePath("src/deep/a.ts", fakeTheme),
    "<muted>src</muted>/<muted>deep</muted>/<b><syntaxType>a.ts</syntaxType></b>",
  );
});

test("stylePath: a document name is colored like tool output", () => {
  assert.equal(stylePath("README.md", fakeTheme), "<b><toolOutput>README.md</toolOutput></b>");
});

test("stylePath: build files are colored as functions, dotfiles have no extension", () => {
  assert.equal(stylePath("Makefile", fakeTheme), "<b><syntaxFunction>Makefile</syntaxFunction></b>");
  assert.equal(stylePath("src/build.mk", fakeTheme), "<muted>src</muted>/<b><syntaxFunction>build.mk</syntaxFunction></b>");
  assert.equal(stylePath(".gitignore", fakeTheme), "<b><toolOutput>.gitignore</toolOutput></b>");
});

test("stylePath: only the extension after the last dot counts", () => {
  assert.equal(splitExtension("a.b.c.ts"), "ts");
  assert.equal(splitExtension(".gitignore"), undefined);
  assert.equal(splitExtension("Makefile"), undefined);
  assert.equal(stylePath("a.b.c.ts", fakeTheme), "<b><syntaxType>a.b.c.ts</syntaxType></b>");
});

test("stylePath: spaces in a directory segment are preserved verbatim", () => {
  assert.equal(
    stylePath("my docs/notes.md", fakeTheme),
    "<muted>my docs</muted>/<b><toolOutput>notes.md</toolOutput></b>",
  );
});

test("stylePath: a directory's own name is dimmed and bold, and keeps its slash", () => {
  assert.equal(stylePath("dir/", fakeTheme), "<b><dim>dir</dim></b>/");
  assert.equal(stylePath("src/sub/", fakeTheme), "<muted>src</muted>/<b><dim>sub</dim></b>/");
});

test("stylePath: an entry name ls prints carries the whole weight, and a directory is dimmed and bold", () => {
  assert.equal(stylePath("a.ts", fakeTheme), "<b><syntaxType>a.ts</syntaxType></b>");
  assert.equal(stylePath("notes", fakeTheme), "<b><toolOutput>notes</toolOutput></b>");
  assert.equal(stylePath("dir/", fakeTheme), "<b><dim>dir</dim></b>/");
});

test("classifyPathLine: sentinels and blank lines are plain", () => {
  for (const line of [
    "No matches found",
    "No files found matching pattern",
    "(empty directory)",
    "",
    "  ",
  ]) {
    assert.deepEqual(classifyPathLine(line), { kind: "plain", text: line });
  }
});

test("classifyPathLine: a bracketed notice line is its own kind", () => {
  const notice = "[50 entries limit reached. Use limit=100 for more]";
  assert.deepEqual(classifyPathLine(notice), { kind: "notice", text: notice });
});

test("classifyPathLine: a trailing slash is a directory, anything else a file", () => {
  assert.deepEqual(classifyPathLine("src/a.ts"), { kind: "file", path: "src/a.ts" });
  assert.deepEqual(classifyPathLine("src/"), { kind: "dir", path: "src/" });
});
