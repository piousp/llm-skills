import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertWritable, SriPerimeterError } from "../../src/perimeter.ts";

interface Tree {
  base: string;
  staging: string;
  state: string;
}

// Canonical temp root: with a symlinked tmpdir every path would resolve elsewhere and
// the symlink assertions below would be meaningless.
function createTree(t: TestContext): Tree {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-perimeter-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const staging = path.join(base, "staging");
  const state = path.join(base, "state");
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(state, { recursive: true });

  return { base, staging, state };
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected the call to throw");
}

function expectRejection(target: string, roots: readonly string[]): SriPerimeterError {
  const error = captureError(() => assertWritable(target, roots));
  assert.ok(error instanceof SriPerimeterError, `expected SriPerimeterError, got ${String(error)}`);
  return error;
}

test("assertWritable: accepts an existing file inside a root", (t) => {
  const tree = createTree(t);
  const attemptsPath = path.join(tree.state, "attempts.jsonl");
  fs.writeFileSync(attemptsPath, "{}\n", "utf8");

  assertWritable(attemptsPath, [tree.staging, tree.state]);
});

test("assertWritable: accepts a target whose parent does not exist yet", (t) => {
  const tree = createTree(t);
  const lessonPath = path.join(tree.staging, "20261102T140322481Z", "pdf-tools", "lessons", "merged-cells.md");
  assert.equal(fs.existsSync(lessonPath), false);

  assertWritable(lessonPath, [tree.staging]);
});

test("assertWritable: accepts the root itself", (t) => {
  const tree = createTree(t);

  assertWritable(tree.staging, [tree.staging]);
});

// path.join() would collapse the ".." while building the string, so the traversal has
// to be spelled out to reach the check.
test("assertWritable: accepts a .. that stays inside the root", (t) => {
  const tree = createTree(t);

  assertWritable(`${tree.staging}/a/../b/lesson.md`, [tree.staging]);
});

test("assertWritable: accepts a symlink inside the root that resolves inside the root", (t) => {
  const tree = createTree(t);
  const realDir = path.join(tree.staging, "real");
  fs.mkdirSync(realDir, { recursive: true });
  fs.symlinkSync(realDir, path.join(tree.staging, "link"), "dir");

  assertWritable(path.join(tree.staging, "link", "lesson.md"), [tree.staging]);
});

test("assertWritable: rejects a relative target", (t) => {
  const tree = createTree(t);

  const error = expectRejection("staging/lesson.md", [tree.staging]);

  assert.equal(error.name, "SriPerimeterError");
  assert.equal(error.target, "staging/lesson.md");
  assert.ok(error.message.includes("not absolute"), `got ${JSON.stringify(error.message)}`);
});

test("assertWritable: rejects a .. that leaves the root", (t) => {
  const tree = createTree(t);

  const error = expectRejection(`${tree.staging}/../escape/lesson.md`, [tree.staging]);

  assert.ok(error.message.includes("outside every writable root"), `got ${JSON.stringify(error.message)}`);
  assert.ok(error.message.includes(path.join(tree.base, "escape", "lesson.md")));
});

test("assertWritable: rejects an absolute target outside every root", (t) => {
  const tree = createTree(t);

  const error = expectRejection(path.join(tree.base, "elsewhere", "lesson.md"), [tree.staging, tree.state]);

  assert.ok(error.message.includes("outside every writable root"), `got ${JSON.stringify(error.message)}`);
});

// /a/bc is not inside /a/b, even though a bare startsWith would say it is.
test("assertWritable: a sibling whose name starts with the root's name is outside", (t) => {
  const tree = createTree(t);
  const parent = path.join(tree.base, "a");
  const writableRoot = path.join(parent, "b");
  const sibling = path.join(parent, "bc");
  fs.mkdirSync(writableRoot, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });

  const error = expectRejection(path.join(sibling, "lesson.md"), [writableRoot]);

  assert.ok(error.message.includes("outside every writable root"), `got ${JSON.stringify(error.message)}`);
});

test("assertWritable: rejects a symlinked ancestor that points outside the root", (t) => {
  const tree = createTree(t);
  const outside = path.join(tree.base, "outside", "real");
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(tree.staging, "link"), "dir");

  const error = expectRejection(path.join(tree.staging, "link", "lesson.md"), [tree.staging]);

  assert.ok(error.message.includes("resolves to"), `got ${JSON.stringify(error.message)}`);
  assert.ok(error.message.includes(outside), `got ${JSON.stringify(error.message)}`);
});

test("assertWritable: rejects an empty root list instead of admitting everything", (t) => {
  const tree = createTree(t);

  const error = expectRejection(path.join(tree.staging, "lesson.md"), []);

  assert.ok(error.message.includes("no writable root"), `got ${JSON.stringify(error.message)}`);
});

test("assertWritable: rejects a root that does not exist", (t) => {
  const tree = createTree(t);

  const error = expectRejection(path.join(tree.staging, "lesson.md"), [path.join(tree.base, "missing-root")]);

  assert.ok(error.message.includes("cannot be read"), `got ${JSON.stringify(error.message)}`);
});

test("assertWritable: rejects a root that is a file", (t) => {
  const tree = createTree(t);
  const fileRoot = path.join(tree.base, "not-a-directory");
  fs.writeFileSync(fileRoot, "", "utf8");

  const error = expectRejection(path.join(tree.staging, "lesson.md"), [fileRoot]);

  assert.ok(error.message.includes("is not a directory"), `got ${JSON.stringify(error.message)}`);
});

test("assertWritable: a long root list is summarized instead of dumped", (t) => {
  const tree = createTree(t);
  const roots = [1, 2, 3, 4, 5].map((index) => {
    const dir = path.join(tree.base, `root-${index}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });

  const error = expectRejection(path.join(tree.base, "elsewhere", "lesson.md"), roots);

  assert.ok(error.message.includes("and 2 more"), `got ${JSON.stringify(error.message)}`);
  assert.ok(error.message.includes(roots[0]));
  assert.equal(error.message.includes(roots[4]), false, `got ${JSON.stringify(error.message)}`);
});
