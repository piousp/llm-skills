import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLanguage, detectOutputLanguage } from "../../src/detect-language.ts";

test("detectLanguage: a JSON object and a JSON array are both json", () => {
  assert.equal(detectLanguage(`{\n  "name": "pi",\n  "version": "1.0.0"\n}`), "json");
  // A single line, short, with no newline: the strong signal bypasses the gate.
  assert.equal(detectLanguage("[1, 2, 3]"), "json");
  assert.equal(detectLanguage("{not json}"), undefined);
});

test("detectLanguage: a patch is diff", () => {
  const patch = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
-old line
+new line`;
  assert.equal(detectLanguage(patch), "diff");
});

test("detectLanguage: a shebang names its interpreter", () => {
  assert.equal(detectLanguage(`#!/bin/bash\nset -euo pipefail\necho hi`), "bash");
  assert.equal(detectLanguage(`#!/usr/bin/env python3\nprint("hi")`), "python");
  assert.equal(detectLanguage(`#!/usr/bin/env node\nconsole.log("hi")`), "javascript");
});

test("detectLanguage: SQL needs a statement keyword and a clause keyword", () => {
  assert.equal(detectLanguage(`SELECT id, name\nFROM users\nWHERE active = 1;`), "sql");
  // Prose that opens with a statement keyword but carries no clause is prose.
  assert.equal(detectLanguage("select the option that fits the current layout"), undefined);
  assert.equal(detectLanguage("select the file"), undefined);
});

test("detectLanguage: a def with a colon is python", () => {
  assert.equal(detectLanguage(`def f(x):\n    if x:\n        return x\n    return None`), "python");
});

test("detectLanguage: key lines are yaml, and one colon in prose is not", () => {
  assert.equal(detectLanguage(`name: pi-syntax-highlight\nversion: 0.1.0\ndependencies:\n  left-pad: ^1.0.0`), "yaml");
  assert.equal(detectLanguage("Note: the plugin adds syntax highlighting for tool output"), undefined);
});

test("detectLanguage: a section header plus assignments is toml", () => {
  assert.equal(detectLanguage(`[package]\nname = "pi-syntax-highlight"\nversion = "0.1.0"`), "toml");
});

test("detectLanguage: annotations are typescript, plain declarations are javascript", () => {
  assert.equal(detectLanguage(`interface User {\n  id: number;\n  name: string;\n}`), "typescript");
  assert.equal(detectLanguage(`const items = [1, 2, 3];\nconst doubled = items.map((item) => item * 2);`), "javascript");
});

test("detectLanguage: go needs a package clause, a bare fn is not go", () => {
  assert.equal(detectLanguage(`package main\n\nfunc main() {\n\tprintln("hi")\n}`), "go");
  // A single fn signal is one of Rust's two, so this stays unlabeled instead of
  // becoming a wrong guess.
  assert.equal(detectLanguage(`fn main() {\n    println!("hello");\n}`), undefined);
});

test("detectLanguage: go and rust outrank the JavaScript signals they share", () => {
  // `import "fmt"` matches the JavaScript `import` signal, and `let mut` matches
  // its `let` one, so a wrong guess is what happens without the precedence.
  assert.equal(
    detectLanguage(`package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}`),
    "go",
  );
  assert.equal(detectLanguage(`fn main() {\n    let mut x = 1;\n    use std::io;\n}`), "rust");
});

test("detectLanguage: only an XML declaration, a doctype, or an html tag are markup", () => {
  assert.equal(detectLanguage(`<?xml version="1.0"?>\n<root>\n  <item/>\n</root>`), "xml");
  assert.equal(detectLanguage(`<!DOCTYPE html>\n<html lang="en">\n<body>hi</body>\n</html>`), "xml");
  assert.equal(detectLanguage(`<html lang="en">\n<body>hi</body>\n</html>`), "html");
  assert.equal(detectLanguage(`<div class="x">\n  <span>hello</span>\n</div>`), undefined);
});

test("detectLanguage: an access modifier next to a class or void keyword is java", () => {
  assert.equal(
    detectLanguage(`public class Main {\n    public static void main(String[] args) {\n        System.out.println("hi");\n    }\n}`),
    "java",
  );
  assert.equal(detectLanguage(`using System;\n\nnamespace App;\n\npublic class Program { }`), "csharp");
});

test("detectLanguage: a decorator alone does not make a snippet python", () => {
  // `@Injectable()` used to be a Python signal, which stole the block from the
  // type annotation that identifies it.
  assert.equal(detectLanguage(`@Injectable()\nexport class Api {\n  base: string;\n}`), "typescript");
});

test("detectLanguage: interface bodies with annotation lines are typescript, not css", () => {
  assert.equal(detectLanguage(`interface A {\n  a: string;\n}\ninterface B {\n  b: string;\n}`), "typescript");
});

test("detectLanguage: bare key lines are yaml even when the values look like annotations", () => {
  assert.equal(detectLanguage(`name: string\nage: number\nenabled: boolean`), "yaml");
});

test("detectLanguage: a markdown table is not shell", () => {
  assert.equal(
    detectLanguage(`| Language | Runtime |\n|---|---|\n| Rust | native |\n| Go | native |`),
    undefined,
  );
});

test("detectLanguage: a log, prose, and empty text have no language", () => {
  assert.equal(
    detectLanguage(`2024-01-02T03:04:05Z INFO starting\n2024-01-02T03:04:06Z WARN slow\n2024-01-02T03:04:07Z INFO done`),
    undefined,
  );
  assert.equal(
    detectLanguage(
      "This paragraph explains why the transformer runs before rendering.\nIt keeps the fence character and the body untouched.",
    ),
    undefined,
  );
  assert.equal(detectLanguage(""), undefined);
  assert.equal(detectLanguage("   \n\t\n"), undefined);
});

test("detectLanguage: a single short line never carries a language", () => {
  assert.equal(detectLanguage("x = 1"), undefined);
});

test("detectOutputLanguage: two plain keys with an indented one are yaml", () => {
  assert.equal(detectOutputLanguage("apiVersion: v1\nkind: Service\nmetadata:\n  name: pi"), "yaml");
});

test("detectOutputLanguage: three plain keys are yaml without any structure", () => {
  assert.equal(detectOutputLanguage("name: pi\nversion: 0.1.0\nlicense: MIT"), "yaml");
});

test("detectOutputLanguage: two bare keys with no structure are not yaml", () => {
  // The same body is yaml to the fence detector; the guard is what keeps it out
  // of the tokenizer, where its error and warning lines keep their colors.
  assert.equal(detectOutputLanguage("error: boom\nwarning: careful\nplain text"), undefined);
});

test("detectOutputLanguage: a git log is not yaml", () => {
  assert.equal(
    detectOutputLanguage(
      [
        "commit 8f2a1c0",
        "Author: Ada <ada@example.com>",
        "Date:   Mon Jan 1 12:00:00 2024 +0000",
        "",
        "    Add the output guard",
      ].join("\n"),
    ),
    undefined,
  );
});

test("detectOutputLanguage: HTTP headers are not yaml", () => {
  assert.equal(
    detectOutputLanguage("HTTP/1.1 200 OK\nContent-Type: application/json\nContent-Length: 42"),
    undefined,
  );
});

test("detectOutputLanguage: a query with a terminator is sql", () => {
  assert.equal(detectOutputLanguage("SELECT id, email\nFROM users\nWHERE created_at > now();"), "sql");
});

test("detectOutputLanguage: prose with one clause keyword is not sql", () => {
  assert.equal(
    detectOutputLanguage("select the row from the list that matches the current filter\nIt keeps the widths untouched."),
    undefined,
  );
});

test("detectOutputLanguage: an environment dump is bash", () => {
  assert.equal(detectOutputLanguage("PATH=/usr/local/bin:/usr/bin\nHOME=/home/pi\nLANG=en_US.UTF-8"), "bash");
});

test("detectOutputLanguage: a JSON prefix is never json", () => {
  assert.equal(detectOutputLanguage("[1, 2,\n3"), undefined);
});

test("detectOutputLanguage: a diff keeps the diff painter", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    "-old line",
    "+new line",
  ].join("\n");
  assert.equal(detectOutputLanguage(patch), undefined);
});

test("detectOutputLanguage: a java body is outside the allowlist", () => {
  assert.equal(
    detectOutputLanguage('public class Main {\n    public static void main(String[] args) {'),
    undefined,
  );
});

test("detectOutputLanguage: a JavaScript body is javascript", () => {
  assert.equal(detectOutputLanguage("const x = 1;\nfunction f() {\n  return x;\n}"), "javascript");
});

test("detectOutputLanguage: three HTTP headers are not yaml", () => {
  assert.equal(
    detectOutputLanguage("Content-Type: application/json\nContent-Length: 42\nAccept-Ranges: bytes"),
    undefined,
  );
});

test("detectOutputLanguage: prose with two lowercase clause keywords is not sql", () => {
  assert.equal(
    detectOutputLanguage("Update the docs in the table from last week\nIt keeps the widths untouched."),
    undefined,
  );
});

test("detectOutputLanguage: a bare parent key with a list is yaml", () => {
  assert.equal(detectOutputLanguage("ports:\n  - 80\n  - 443\nname: pi"), "yaml");
});

test("detectOutputLanguage: a lowercase query with no terminator stays flat", () => {
  assert.equal(detectOutputLanguage("SELECT id\nfrom users\nwhere active"), undefined);
});
