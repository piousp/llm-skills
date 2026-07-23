import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverAgents,
  loadOverrides,
  applyOverrides,
  type AgentConfig,
} from "../../src/agents.ts";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-agents-test-"));
}

function writeAgentFile(dir: string, filename: string, content: string): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

test("discoverAgents: directory with one valid agent .md returns one AgentConfig with resolved defaults", () => {
  const dir = makeTmpDir();
  try {
    writeAgentFile(
      dir,
      "scout.md",
      `---
name: scout
description: Finds things
tools: read, grep
model: sonnet
---
Body content.
`,
    );

    const agents = discoverAgents(dir);

    assert.equal(agents.length, 1);
    const agent = agents[0]!;
    assert.equal(agent.name, "scout");
    assert.equal(agent.description, "Finds things");
    assert.deepEqual(agent.tools, ["read", "grep"]);
    assert.equal(agent.model, "sonnet");
    assert.equal(agent.systemPromptMode, "append");
    assert.equal(agent.inheritProjectContext, true);
    assert.deepEqual(agent.defaultReads, []);
    assert.equal(agent.source, "user");
    assert.equal(agent.filePath, path.join(dir, "scout.md"));
    assert.equal(agent.systemPrompt, "Body content.");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAgents: file missing description is skipped without throwing; other valid files still returned", () => {
  const dir = makeTmpDir();
  try {
    writeAgentFile(
      dir,
      "broken.md",
      `---
name: broken
---
No description here.
`,
    );
    writeAgentFile(
      dir,
      "good.md",
      `---
name: good
description: Works fine
---
Body.
`,
    );

    const agents = discoverAgents(dir);

    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.name, "good");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAgents: symlinked .md with only 4 base Claude Code fields gets pi-simple-agents defaults filled in", () => {
  const dir = makeTmpDir();
  const realFileDir = makeTmpDir();
  try {
    const realFilePath = writeAgentFile(
      realFileDir,
      "claude-agent.md",
      `---
name: claude-agent
description: A Claude Code style agent
tools: read
model: haiku
---
Claude Code body.
`,
    );

    const symlinkPath = path.join(dir, "claude-agent.md");
    fs.symlinkSync(realFilePath, symlinkPath);

    const agents = discoverAgents(dir);

    assert.equal(agents.length, 1);
    const agent = agents[0]!;
    assert.equal(agent.name, "claude-agent");
    assert.equal(agent.description, "A Claude Code style agent");
    assert.equal(agent.systemPromptMode, "append");
    assert.equal(agent.inheritProjectContext, true);
    assert.deepEqual(agent.defaultReads, []);
    assert.equal(agent.source, "user");
    assert.equal(agent.systemPrompt, "Claude Code body.");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(realFileDir, { recursive: true, force: true });
  }
});

test("loadOverrides: no settings files present returns {}", () => {
  const dir = makeTmpDir();
  try {
    const userSettingsPath = path.join(dir, "user-settings.json");
    const projectSettingsPath = path.join(dir, "project-settings.json");

    const overrides = loadOverrides(userSettingsPath, projectSettingsPath);

    assert.deepEqual(overrides, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyOverrides: project override wins over user override; user override wins over frontmatter when project doesn't touch the field", () => {
  const dir = makeTmpDir();
  try {
    const userSettingsPath = path.join(dir, "user-settings.json");
    const projectSettingsPath = path.join(dir, "project-settings.json");

    fs.writeFileSync(
      userSettingsPath,
      JSON.stringify({
        "pi-simple-agents": {
          agentOverrides: {
            scout: { model: "user-model", description: "User description" },
          },
        },
      }),
      "utf8",
    );

    fs.writeFileSync(
      projectSettingsPath,
      JSON.stringify({
        "pi-simple-agents": {
          agentOverrides: {
            scout: { model: "project-model" },
          },
        },
      }),
      "utf8",
    );

    const overrides = loadOverrides(userSettingsPath, projectSettingsPath);

    const baseAgent: AgentConfig = {
      name: "scout",
      description: "Frontmatter description",
      tools: ["read"],
      model: "frontmatter-model",
      systemPromptMode: "append",
      inheritProjectContext: true,
      defaultReads: [],
      source: "user",
      filePath: "/fake/scout.md",
      systemPrompt: "Frontmatter body.",
    };

    const [applied] = applyOverrides([baseAgent], overrides);

    assert.equal(applied!.model, "project-model");
    assert.equal(applied!.description, "User description");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
