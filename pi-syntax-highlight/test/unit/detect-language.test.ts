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
  assert.equal(detectLanguage(`<div class="x">\n  <span>hello</span>\n</div>`), "html");
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

// Phase 6: one block per added language. Each has positives, log-shaped
// negatives, and an assertion on whether the language may paint shell output.

test("php: an opening tag on the first line is php, before the xml rule", () => {
  assert.equal(detectLanguage(`<?php\necho "hi";`), "php");
  assert.equal(detectLanguage("<?php echo 1;"), "php");
  assert.equal(detectLanguage(`<?xml version="1.0"?>\n<root>\n</root>`), "xml");
  assert.equal(detectLanguage("PHP Warning:  Undefined variable $x in /app/a.php on line 3\nPHP Stack trace:"), undefined);
  assert.equal(detectOutputLanguage(`<?php\necho "hi";\n$x = 1;`), "php");
});

test("ndjson: two or more json lines are json, one line is not ndjson", () => {
  assert.equal(detectLanguage(`{"a":1}\n{"a":2}\n{"a":3}`), "json");
  assert.equal(detectLanguage(`{"a":1}\n[1,2]`), "json");
  assert.equal(detectLanguage(`{"a":1}\n{"a":2\nplain text here and more to pass the gate`), undefined);
  assert.equal(detectLanguage(`2024-01-02 {"a":1}\n2024-01-03 {"a":2}\n2024-01-04 done ok`), undefined);
});

test("ndjson: in output it is json only when the sample is not one document", () => {
  assert.equal(detectOutputLanguage(`{"a":1}\n{"a":2}`), "json");
  assert.equal(detectOutputLanguage(`{\n  "a": 1\n}`), undefined);
  assert.equal(detectOutputLanguage(`[1, 2,\n3`), undefined);
});

test("dockerfile: FROM first, then another instruction", () => {
  assert.equal(detectLanguage(`FROM node:20\nRUN npm ci\nCMD ["node", "index.js"]`), "dockerfile");
  assert.equal(detectLanguage(`# syntax=docker/dockerfile:1\n\nFROM alpine AS base\nWORKDIR /app`), "dockerfile");
  assert.equal(detectLanguage(`FROM scratch\nfoo bar baz and some more text here`), undefined);
  assert.equal(detectLanguage(`Step 1/5 : FROM node:20\n ---> abc123\nStep 2/5 : RUN npm ci`), undefined);
  assert.equal(detectOutputLanguage(`FROM node:20\nRUN npm ci\nCOPY . .`), "dockerfile");
});

test("makefile: .PHONY, or a rule with dependencies and a tab recipe", () => {
  assert.equal(detectLanguage(`.PHONY: all clean\nall: build\n\techo done`), "makefile");
  assert.equal(detectLanguage(`build: main.o util.o\n\tcc -o app main.o util.o`), "makefile");
  // Two `key: value` lines are yaml to the older detector; what matters is makefile.
  assert.notEqual(detectLanguage(`make: *** [all] Error 1\nmake: Leaving directory '/app'`), "makefile");
  assert.equal(detectLanguage(`switch (x) {\ndefault:\n\treturn 1;\n}`), undefined);
  assert.equal(detectOutputLanguage(`build: main.o\n\tcc -o app main.o`), "makefile");
});

test("makefile: a JVM stack trace is not a rule", () => {
  const trace = `java.net.ConnectException: Connection refused\n\tat java.base/sun.nio.ch.Net.connect0(Native Method)\n\tat Main.main(Main.java:10)`;
  assert.equal(detectLanguage(trace), undefined);
  assert.equal(detectOutputLanguage(trace), undefined);
});

test("makefile: an RFC822 folded header is not a rule", () => {
  assert.notEqual(detectLanguage(`Received: from a by b\n\tid 1`), "makefile");
});

test("makefile: dotted and pattern targets stay rules", () => {
  assert.equal(detectLanguage(`%.o: %.c\n\t$(CC) -c $< -o $@`), "makefile");
  assert.equal(detectLanguage(`Main.class: Main.java\n\tjavac Main.java`), "makefile");
  assert.equal(detectLanguage(`build-all: deps\n\t./build.sh`), "makefile");
});

test("c and cpp: an include picks c, cpp-only syntax picks cpp", () => {
  assert.equal(detectLanguage(`#include <stdio.h>\nint main(void) { return 0; }`), "c");
  assert.equal(detectLanguage(`#include "a.h"\nint x;`), "c");
  assert.equal(detectLanguage(`#include <iostream>\nint main() { std::cout << 1; }`), "cpp");
  assert.equal(detectLanguage(`#include <vector>\ntemplate <typename T>\nT id(T t) { return t; }`), "cpp");
  assert.equal(detectLanguage(`#include <a.h>\nnamespace app { int x; }`), "cpp");
  assert.equal(detectLanguage(`x.c:3:10: fatal error: foo.h: No such file or directory\n    3 | #include <foo.h>`), undefined);
  assert.notEqual(detectLanguage(`warning: unused variable\nnote: declared here too and longer`), "c");
  assert.equal(detectOutputLanguage(`#include <stdio.h>\nint main(void) { return 0; }`), "c");
  assert.equal(detectOutputLanguage(`#include <iostream>\nint main() { std::cout << 1; }`), "cpp");
});

test("ruby: needs two signals; python def with a colon is still python", () => {
  assert.equal(detectLanguage(`class Foo < Bar\n  def hello\n    puts "hi"\n  end\nend`), "ruby");
  assert.equal(detectLanguage(`require 'json'\nitems.each do |item|\n  puts item\nend`), "ruby");
  assert.equal(detectLanguage(`attr_reader :name\ndef name\n  @name\nend`), "ruby");
  assert.equal(detectLanguage(`def f(x):\n    return x\n`), "python");
  assert.equal(detectLanguage(`class Box<T> {\n  v: string;\n}\nend of the line is here`), "typescript");
  assert.equal(detectLanguage(`the end\nend\nsome words are here to pass the gate ok`), undefined);
  assert.equal(detectOutputLanguage(`require 'json'\nputs JSON.dump({})`), "ruby");
});

test("powershell: two signals; header-like and table output are not powershell", () => {
  assert.equal(detectLanguage(`Get-ChildItem | Where-Object { $_.Length -gt 1 }`), "powershell");
  assert.equal(detectLanguage(`param($Name)\nWrite-Host $env:USERNAME`), "powershell");
  assert.equal(detectLanguage(`[CmdletBinding()]\nparam([string]$Path)`), "powershell");
  assert.equal(detectLanguage(`if ($a -eq 1) {\n  Write-Output $a\n}`), "powershell");
  assert.equal(
    detectLanguage(`Mode                 LastWriteTime         Length Name\n----                 -------------         ------ ----\nd-----        1/1/2024  12:00 PM                src`),
    undefined,
  );
  assert.notEqual(detectLanguage(`HTTP/1.1 200 OK\nSet-Cookie: a=1\nContent-Type: text/html`), "powershell");
  assert.equal(detectOutputLanguage(`param($Name)\nWrite-Host $env:USERNAME`), "powershell");
});

test("properties: dotted lowercase keys only, fence detection only", () => {
  const body = `# server\nserver.port=8080\nspring.application.name = pi\n`;
  assert.equal(detectLanguage(body), "properties");
  assert.equal(detectLanguage(`a.b=1\nc.d=2\nsome other line that is not a pair`), undefined);
  assert.equal(detectLanguage(`path.home=$HOME\nuser.name=pi`), undefined);
  assert.equal(detectLanguage(`window.x = 1;\nwindow.y = 2;`), undefined);
  assert.equal(detectLanguage(`PATH=/usr/bin\nHOME=/home/pi\nLANG=en_US`), "bash");
  assert.equal(detectOutputLanguage(body), undefined);
});

test("jsx and tsx: element syntax promotes the javascript and typescript answers", () => {
  assert.equal(
    detectLanguage(`const App = () => {\n  return (\n    <div>hi</div>\n  );\n};`),
    "jsx",
  );
  assert.equal(detectLanguage(`const a = 1;\nconst b = <Button onClick={f}>go</Button>;`), "jsx");
  assert.equal(detectLanguage(`const a = <div className="x" />;\nexport default a;`), "jsx");
  assert.equal(
    detectLanguage(`interface P { n: number }\nconst C = (p: P) => <Item n={p.n} />;`),
    "tsx",
  );
  assert.equal(detectLanguage(`const id = <T>(x: T) => x;\nconst n: number = 1;\nconst m = new Map<Foo, Bar>();`), "typescript");
  assert.equal(detectLanguage(`const a = 1;\nconst b = a < 2 && a > 0;`), "javascript");
  assert.equal(detectOutputLanguage(`const a = <div className="x" />;\nexport default a;`), "jsx");
  assert.equal(detectOutputLanguage(`interface P { n: number }\nconst C = () => <Item n={1} />;`), "tsx");
});

test("html fragment: a known tag or a comment first, with a closing tag, is html", () => {
  assert.equal(detectLanguage(`<div class="x">\n  <span>hello</span>\n</div>`), "html");
  assert.equal(detectLanguage(`<!-- header -->\n<nav>\n  <a href="/">home</a>\n</nav>`), "html");
  assert.equal(detectOutputLanguage(`<ul>\n  <li>one</li>\n  <li>two</li>\n</ul>`), "html");
});

test("html fragment: generics, jsx, unknown-tag xml and logs are not html", () => {
  assert.notEqual(detectLanguage(`<div className="x">\n  <span>hi</span>\n</div>`), "html");
  assert.notEqual(detectLanguage(`<button onClick={go}>\n  <b>go</b>\n</button>`), "html");
  assert.equal(detectLanguage(`<config>\n  <entry>value</entry>\n</config>`), undefined);
  assert.equal(detectLanguage(`Array<string> is a generic\nMap<string, number> too, </p> aside`), undefined);
  assert.equal(detectLanguage(`<div>\nno closing tag here, just a log line`), undefined);
  assert.equal(detectOutputLanguage(`<6> kernel: started\n<6> kernel: stopped </b>`), undefined);
});
