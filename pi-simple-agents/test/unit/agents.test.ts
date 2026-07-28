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
  type AgentOverrides,
  type CacheEntry,
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

test("loadOverrides: accepts 'subagents' key (Bug 1)", () => {
  const dir = makeTmpDir();
  try {
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        subagents: {
          agentOverrides: {
            scout: { model: "override-model" },
          },
        },
      }),
      "utf8",
    );

    const overrides = loadOverrides(settingsPath);
    assert.equal(overrides.scout?.model, "override-model");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyOverrides: propagates new fields (thinking, inheritSkills, defaultContext, skills)", () => {
  const baseAgent: AgentConfig = {
    name: "scout",
    description: "test",
    tools: ["read"],
    model: "default",
    systemPromptMode: "append",
    inheritProjectContext: true,
    defaultReads: [],
    source: "user",
    filePath: "/fake/scout.md",
    systemPrompt: "body",
  };

  const overrides = {
    scout: {
      thinking: "high",
      inheritSkills: false,
      defaultContext: "fresh" as const,
      skills: ["skill-a"],
    },
  };

  const [applied] = applyOverrides([baseAgent], overrides);

  assert.equal(applied!.thinking, "high");
  assert.equal(applied!.inheritSkills, false);
  assert.equal(applied!.defaultContext, "fresh");
  assert.deepEqual(applied!.skills, ["skill-a"]);
});

test("discoverAgents: cache returns cached data on second call", () => {
  const dir = makeTmpDir();
  try {
    writeAgentFile(
      dir,
      "test-agent.md",
      `---
name: test-agent
description: test
---
Body`,
    );

    const cache = new Map<string, CacheEntry<AgentConfig[]>>();

    const first = discoverAgents(dir, cache);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.name, "test-agent");

    // Delete the file and call again — should still return cached data
    fs.rmSync(path.join(dir, "test-agent.md"));
    const second = discoverAgents(dir, cache);
    assert.equal(second.length, 1);
    assert.equal(second[0]!.name, "test-agent");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAgents: cache is optional — not passing cache still works", () => {
  const dir = makeTmpDir();
  try {
    writeAgentFile(
      dir,
      "test-agent.md",
      `---
name: test-agent
description: test
---
Body`,
    );

    const agents = discoverAgents(dir);
    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.name, "test-agent");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOverrides: cache returns cached data on second call", () => {
  const dir = makeTmpDir();
  try {
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        "pi-simple-agents": {
          agentOverrides: {
            scout: { model: "first-model" },
          },
        },
      }),
      "utf8",
    );

    const cache = new Map<string, CacheEntry<AgentOverrides>>();

    const first = loadOverrides(settingsPath, undefined, cache);
    assert.equal(first.scout?.model, "first-model");

    // Change the file and call again — should still return cached data
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        "pi-simple-agents": {
          agentOverrides: {
            scout: { model: "second-model" },
          },
        },
      }),
      "utf8",
    );

    const second = loadOverrides(settingsPath, undefined, cache);
    assert.equal(second.scout?.model, "first-model");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
