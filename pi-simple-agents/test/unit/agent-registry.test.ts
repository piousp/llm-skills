import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentRegistry } from "../../src/agent-registry.ts";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-agents-registry-test-"));
}

function writeAgentFile(dir: string, filename: string, content: string): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

test("load: returns agents from the agents dir with overrides applied", async () => {
  const agentsDir = makeTmpDir();
  const cwd = makeTmpDir();
  const userSettingsPath = path.join(makeTmpDir(), "user-settings.json");
  try {
    writeAgentFile(
      agentsDir,
      "scout.md",
      `---
name: scout
description: Finds things
model: sonnet
---
Body content.
`,
    );

    const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
    fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
    fs.writeFileSync(
      projectSettingsPath,
      JSON.stringify({
        "pi-simple-agents": {
          agentOverrides: {
            scout: { model: "overridden-model" },
          },
        },
      }),
      "utf8",
    );

    const registry = createAgentRegistry({ agentsDir, userSettingsPath });
    const loaded = await registry.load(cwd);

    assert.equal(loaded.agents.length, 1);
    assert.equal(loaded.agents[0]!.name, "scout");
    assert.equal(loaded.agents[0]!.model, "overridden-model");
  } finally {
    fs.rmSync(agentsDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("load: no concurrency in settings defaults to 4", async () => {
  const agentsDir = makeTmpDir();
  const cwd = makeTmpDir();
  const userSettingsPath = path.join(makeTmpDir(), "user-settings.json");
  try {
    const registry = createAgentRegistry({ agentsDir, userSettingsPath });
    const loaded = await registry.load(cwd);

    assert.equal(loaded.concurrency, 4);
  } finally {
    fs.rmSync(agentsDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("load: concurrency: 6 in settings file resolves to 6", async () => {
  const agentsDir = makeTmpDir();
  const cwd = makeTmpDir();
  const userSettingsPath = path.join(makeTmpDir(), "user-settings.json");
  try {
    const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
    fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
    fs.writeFileSync(
      projectSettingsPath,
      JSON.stringify({ "pi-simple-agents": { concurrency: 6 } }),
      "utf8",
    );

    const registry = createAgentRegistry({ agentsDir, userSettingsPath });
    const loaded = await registry.load(cwd);

    assert.equal(loaded.concurrency, 6);
  } finally {
    fs.rmSync(agentsDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("peek: before any load returns undefined", () => {
  const agentsDir = makeTmpDir();
  const cwd = makeTmpDir();
  const userSettingsPath = path.join(makeTmpDir(), "user-settings.json");
  try {
    const registry = createAgentRegistry({ agentsDir, userSettingsPath });
    assert.equal(registry.peek(cwd), undefined);
  } finally {
    fs.rmSync(agentsDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("peek: after await load(cwd) deep-equals the resolved value", async () => {
  const agentsDir = makeTmpDir();
  const cwd = makeTmpDir();
  const userSettingsPath = path.join(makeTmpDir(), "user-settings.json");
  try {
    const registry = createAgentRegistry({ agentsDir, userSettingsPath });
    const loaded = await registry.load(cwd);

    assert.deepEqual(registry.peek(cwd), loaded);
  } finally {
    fs.rmSync(agentsDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("peek: for a different cwd stays undefined after load(cwd)", async () => {
  const agentsDir = makeTmpDir();
  const cwd = makeTmpDir();
  const otherCwd = makeTmpDir();
  const userSettingsPath = path.join(makeTmpDir(), "user-settings.json");
  try {
    const registry = createAgentRegistry({ agentsDir, userSettingsPath });
    await registry.load(cwd);

    assert.equal(registry.peek(otherCwd), undefined);
  } finally {
    fs.rmSync(agentsDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(otherCwd, { recursive: true, force: true });
  }
});

test("load: called twice on the same registry instance dedupes the inert-field warning to one console.warn call", async (t) => {
  const agentsDir = makeTmpDir();
  const cwd = makeTmpDir();
  const userSettingsPath = path.join(makeTmpDir(), "user-settings.json");
  try {
    writeAgentFile(
      agentsDir,
      "agent-a.md",
      `---
name: agent-a
description: First agent
permissionMode: default
---
Body A.
`,
    );

    const warnSpy = t.mock.method(console, "warn");
    const registry = createAgentRegistry({ agentsDir, userSettingsPath });

    await registry.load(cwd);
    await registry.load(cwd);

    const inertSummaryCalls = warnSpy.mock.calls.filter(
      (call) =>
        typeof call.arguments[0] === "string" &&
        (call.arguments[0] as string).includes("accepted but inert in pi"),
    );

    assert.equal(inertSummaryCalls.length, 1);
  } finally {
    fs.rmSync(agentsDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("load: two separately-constructed registries each warn once for the inert field (not deduped across instances)", async (t) => {
  const agentsDir = makeTmpDir();
  const cwd = makeTmpDir();
  const userSettingsPath = path.join(makeTmpDir(), "user-settings.json");
  try {
    writeAgentFile(
      agentsDir,
      "agent-a.md",
      `---
name: agent-a
description: First agent
permissionMode: default
---
Body A.
`,
    );

    const warnSpy = t.mock.method(console, "warn");
    const registryOne = createAgentRegistry({ agentsDir, userSettingsPath });
    const registryTwo = createAgentRegistry({ agentsDir, userSettingsPath });

    await registryOne.load(cwd);
    await registryTwo.load(cwd);

    const inertSummaryCalls = warnSpy.mock.calls.filter(
      (call) =>
        typeof call.arguments[0] === "string" &&
        (call.arguments[0] as string).includes("accepted but inert in pi"),
    );

    assert.equal(inertSummaryCalls.length, 2);
  } finally {
    fs.rmSync(agentsDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("createAgentRegistry: constructing with a nonexistent agentsDir does not throw", () => {
  const agentsDir = path.join(makeTmpDir(), "does-not-exist");
  const userSettingsPath = path.join(makeTmpDir(), "user-settings.json");

  assert.doesNotThrow(() => {
    createAgentRegistry({ agentsDir, userSettingsPath });
  });
});

test("load: against a nonexistent agentsDir resolves to empty agents and default concurrency", async () => {
  const agentsDir = path.join(makeTmpDir(), "does-not-exist");
  const cwd = makeTmpDir();
  const userSettingsPath = path.join(makeTmpDir(), "user-settings.json");
  try {
    const registry = createAgentRegistry({ agentsDir, userSettingsPath });

    await assert.doesNotReject(async () => {
      const loaded = await registry.load(cwd);
      assert.deepEqual(loaded, { agents: [], concurrency: 4 });
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
