import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDefaultReads } from "../../src/default-reads.ts";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-agents-test-"));
}

test("resolveDefaultReads: empty defaultReads returns empty files and warnings", () => {
  const dir = makeTmpDir();
  try {
    const result = resolveDefaultReads([], dir, os.homedir());
    assert.deepEqual(result, { files: [], warnings: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDefaultReads: relative path resolved against cwd, content read", () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, "notes.md"), "notes content", "utf8");

    const result = resolveDefaultReads(["notes.md"], dir, os.homedir());

    assert.deepEqual(result, {
      files: [{ path: path.resolve(dir, "notes.md"), content: "notes content" }],
      warnings: [],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDefaultReads: absolute path used as-is, cwd untouched", () => {
  const dir = makeTmpDir();
  const otherDir = makeTmpDir();
  try {
    const absPath = path.join(otherDir, "abs.md");
    fs.writeFileSync(absPath, "abs content", "utf8");

    const result = resolveDefaultReads([absPath], dir, os.homedir());

    assert.deepEqual(result, {
      files: [{ path: absPath, content: "abs content" }],
      warnings: [],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  }
});

test("resolveDefaultReads: '~/x.md' resolved against homeDir", () => {
  const dir = makeTmpDir();
  const homeDir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(homeDir, "x.md"), "home content", "utf8");

    const result = resolveDefaultReads(["~/x.md"], dir, homeDir);

    assert.deepEqual(result, {
      files: [{ path: path.join(homeDir, "x.md"), content: "home content" }],
      warnings: [],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("resolveDefaultReads: bare '~' resolves to homeDir itself, which is a directory, so it warns and is omitted", () => {
  const dir = makeTmpDir();
  const homeDir = makeTmpDir();
  try {
    const result = resolveDefaultReads(["~"], dir, homeDir);

    assert.deepEqual(result.files, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]!, /"~"/);
    assert.match(result.warnings[0]!, new RegExp(homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("resolveDefaultReads: missing file produces a warning with raw and resolved path, rest of list still processed", () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, "present.md"), "present content", "utf8");

    const result = resolveDefaultReads(["missing.md", "present.md"], dir, os.homedir());

    assert.deepEqual(result.files, [
      { path: path.resolve(dir, "present.md"), content: "present content" },
    ]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]!, /missing\.md/);
    assert.match(result.warnings[0]!, new RegExp(path.resolve(dir, "missing.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDefaultReads: directory entry produces a warning and is omitted, never throws EISDIR", () => {
  const dir = makeTmpDir();
  try {
    fs.mkdirSync(path.join(dir, "adir"));

    const result = resolveDefaultReads(["adir"], dir, os.homedir());

    assert.deepEqual(result.files, []);
    assert.equal(result.warnings.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDefaultReads: two entries resolving to the same absolute path dedupe, first wins, no warning", () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, "notes.md"), "first content", "utf8");
    const absPath = path.resolve(dir, "notes.md");

    const result = resolveDefaultReads(["notes.md", absPath], dir, os.homedir());

    assert.deepEqual(result, {
      files: [{ path: absPath, content: "first content" }],
      warnings: [],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDefaultReads: files order matches defaultReads order minus omitted entries", () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, "b.md"), "b content", "utf8");
    fs.writeFileSync(path.join(dir, "a.md"), "a content", "utf8");

    const result = resolveDefaultReads(["b.md", "missing.md", "a.md"], dir, os.homedir());

    assert.deepEqual(
      result.files.map((f) => f.path),
      [path.resolve(dir, "b.md"), path.resolve(dir, "a.md")],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
