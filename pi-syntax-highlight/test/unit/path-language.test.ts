import { test } from "node:test";
import assert from "node:assert/strict";
import { languageForPath } from "../../src/path-language.ts";

test("languageForPath: fills the extensions the host does not know", () => {
  assert.equal(languageForPath("src/Greeter.groovy"), "groovy");
  assert.equal(languageForPath("script.gvy"), "groovy");
  assert.equal(languageForPath("build.gradle"), "groovy");
  assert.equal(languageForPath("build.gradle.kts"), "kotlin");
  assert.equal(languageForPath("lib/Foo.pm"), "perl");
  assert.equal(languageForPath("script.pl"), "perl");
  assert.equal(languageForPath("rules.mk"), "makefile");
  assert.equal(languageForPath("flake.nix"), "nix");
  assert.equal(languageForPath("bin/main.dart"), "dart");
});

test("languageForPath: the host answer wins over the gap table", () => {
  assert.equal(languageForPath("src/a.ts"), "typescript");
  assert.equal(languageForPath("src/a.py"), "python");
  assert.equal(languageForPath("styles/app.css"), "css");
  // `Makefile` has no dot, so the gap table is never consulted: the host already
  // answers for the bare name, and this module adds answers rather than removing
  // them.
  assert.equal(languageForPath("Makefile"), "makefile");
});

test("languageForPath: a path with no extension or no name has no language", () => {
  assert.equal(languageForPath(""), undefined);
  assert.equal(languageForPath("src/README"), undefined);
  assert.equal(languageForPath("src/Makefile.in"), undefined);
});
