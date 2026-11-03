import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SriPerimeterError } from "../../src/errors.ts";
import {
  assertBaseOutsideSkill,
  relativeToBase,
  stagingDir,
  stateDir,
  writeBase,
} from "../../src/write-base.ts";

interface AgentTree {
  agentDir: string;
  base: string;
}

// A real agent directory: the functions under test compute paths, so what a test needs is the tree the
// first writer would create, and not a stub.
function createAgentTree(t: TestContext): AgentTree {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-base-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir, { recursive: true });

  return { agentDir, base: path.join(agentDir, "sri") };
}

// The anchor of every write: a directory of this package's own under pi's agent directory, so a
// reinstall of the package cannot take staging/ or state/ away and pi's own tree is not written into.
test("writeBase: a directory of the package under the agent directory", (t) => {
  const tree = createAgentTree(t);

  assert.equal(writeBase(tree.agentDir), path.join(tree.agentDir, "sri"));
  assert.equal(path.basename(writeBase(tree.agentDir)), "sri");
  // Computed, not created: importing and asking must never touch the disk.
  assert.equal(fs.existsSync(writeBase(tree.agentDir)), false);
});

test("stagingDir and stateDir: under the base, creating nothing", (t) => {
  const tree = createAgentTree(t);

  assert.equal(stagingDir(tree.base), path.join(tree.base, "staging"));
  assert.equal(stateDir(tree.base), path.join(tree.base, "state"));
  assert.equal(fs.existsSync(stagingDir(tree.base)), false);
  assert.equal(fs.existsSync(stateDir(tree.base)), false);
  assert.deepEqual(fs.readdirSync(tree.agentDir), []);
});

// The records name a candidate relative to the base: the same record stays readable after the agent
// directory moves, and no machine-specific path enters the index or decision.json.
test("relativeToBase: a target inside the base loses the base", () => {
  assert.equal(relativeToBase("/agent/sri", "/agent/sri/staging/20261103T200011248Z/pdf-tools"), "staging/20261103T200011248Z/pdf-tools");
  assert.equal(relativeToBase("/agent/sri", "/agent/sri/state/attempts.jsonl"), "state/attempts.jsonl");
});

// A target outside the base keeps its absolute spelling: path.relative would answer "../..", which reads
// as a relative path that does not exist, and the base itself has no relative spelling at all.
test("relativeToBase: a target outside the base, or the base itself, stays absolute", () => {
  assert.equal(relativeToBase("/agent/sri", "/elsewhere/staging/x"), "/elsewhere/staging/x");
  assert.equal(relativeToBase("/agent/sri", "/agent/other"), "/agent/other");
  assert.equal(relativeToBase("/agent/sri", "/agent/sri"), "/agent/sri");
  assert.equal(relativeToBase("/agent/sri", "/agent/sri-2/staging"), "/agent/sri-2/staging");
});

// A base inside the skill would make staging a part of the skill and put the audit index next to its
// SKILL.md. Refused with both paths named, so a PI_CODING_AGENT_DIR pointed at a skill is readable as
// such instead of as a permission error later.
test("assertBaseOutsideSkill: a base inside the skill is refused, naming both", () => {
  assert.throws(
    () => assertBaseOutsideSkill("/skills/pdf-tools/staging-rel", ["/skills/pdf-tools"]),
    (error: unknown) =>
      error instanceof SriPerimeterError &&
      error.message.includes("/skills/pdf-tools/staging-rel") &&
      error.message.includes("/skills/pdf-tools") &&
      error.target === "/skills/pdf-tools/staging-rel",
  );
});

// The boundary: the skill directory itself and a sibling whose name starts with the same bytes are two
// different answers.
test("assertBaseOutsideSkill: the skill itself is refused and a sibling is not", () => {
  assert.throws(
    () => assertBaseOutsideSkill("/skills/pdf-tools", ["/skills/pdf-tools"]),
    (error: unknown) => error instanceof SriPerimeterError,
  );
  assert.doesNotThrow(() => assertBaseOutsideSkill("/skills/pdf-tools-2", ["/skills/pdf-tools"]));
  assert.doesNotThrow(() => assertBaseOutsideSkill("/agent/sri", ["/skills/pdf-tools"]));
});

// The inventory keeps both spellings of a skill (F5), so a base inside the resolved directory is refused
// even when the linked path is somewhere else.
test("assertBaseOutsideSkill: every spelling of the skill is compared", () => {
  assert.throws(
    () => assertBaseOutsideSkill("/home/me/skills/pdf-tools/state", ["/skills/pdf-tools", "/home/me/skills/pdf-tools"]),
    (error: unknown) => error instanceof SriPerimeterError,
  );
});
