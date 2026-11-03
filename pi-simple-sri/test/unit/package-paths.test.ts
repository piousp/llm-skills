import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot, stagingDir, stateDir } from "../../src/package-paths.ts";

interface PackageTree {
  base: string;
  root: string;
  extensionsDir: string;
}

// The temp root is canonicalized first: os.tmpdir() is a symlink on some platforms
// (macOS /var -> /private/var), and packageRoot must return the root the test built.
function createPackageTree(t: TestContext): PackageTree {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-paths-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const root = path.join(base, "pi-simple-sri");
  const extensionsDir = path.join(root, "extensions");
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.writeFileSync(path.join(extensionsDir, "index.ts"), "// factory\n", "utf8");

  return { base, root, extensionsDir };
}

// The documented precondition: the module that calls packageRoot lives directly in
// <root>/extensions/, so two levels up is the package root and not the directory that
// contains it.
test("packageRoot: <root>/extensions/index.ts resolves to <root>", (t) => {
  const tree = createPackageTree(t);
  const moduleUrl = pathToFileURL(path.join(tree.extensionsDir, "index.ts")).href;

  assert.equal(packageRoot(moduleUrl), tree.root);
  assert.notEqual(packageRoot(moduleUrl), tree.base);
  assert.equal(path.basename(packageRoot(moduleUrl)), "pi-simple-sri");
});

// The same rule without a tree on disk: nothing in these functions touches the
// filesystem.
test("packageRoot: resolves an absolute directory for a module that does not exist", () => {
  const modulePath = path.join(path.sep, "opt", "sri", "extensions", "index.ts");

  assert.equal(packageRoot(pathToFileURL(modulePath).href), path.join(path.sep, "opt", "sri"));
});

test("stagingDir and stateDir: computed under the root, creating nothing", (t) => {
  const tree = createPackageTree(t);

  assert.equal(stagingDir(tree.root), path.join(tree.root, "staging"));
  assert.equal(stateDir(tree.root), path.join(tree.root, "state"));

  assert.equal(fs.existsSync(stagingDir(tree.root)), false);
  assert.equal(fs.existsSync(stateDir(tree.root)), false);
  assert.deepEqual(fs.readdirSync(tree.root), ["extensions"]);
});
