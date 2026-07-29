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

test("applyOverrides: timeoutMs override flows onto the merged config; agents without an override keep it undefined", () => {
  const scoutAgent: AgentConfig = {
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

  const otherAgent: AgentConfig = {
    name: "other",
    description: "test",
    tools: ["read"],
    model: "default",
    systemPromptMode: "append",
    inheritProjectContext: true,
    defaultReads: [],
    source: "user",
    filePath: "/fake/other.md",
    systemPrompt: "body",
  };

  const overrides: AgentOverrides = {
    scout: { timeoutMs: 1200000 },
  };

  const [appliedScout, appliedOther] = applyOverrides([scoutAgent, otherAgent], overrides);

  assert.equal(appliedScout!.timeoutMs, 1200000);
  assert.equal(appliedOther!.timeoutMs, undefined);
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

test("discoverAgents: maps Claude tool names onto tools/disallowedTools and does not skip the agent for inert fields", () => {
  const dir = makeTmpDir();
  try {
    writeAgentFile(
      dir,
      "scout-tools.md",
      `---
name: scout-tools
description: Tools mapping test
tools: Read, Glob
disallowedTools: Bash
model: sonnet
permissionMode: default
maxTurns: 5
---
Body.
`,
    );

    const agents = discoverAgents(dir, undefined, new Map<string, number>());

    assert.equal(agents.length, 1);
    const agent = agents[0]!;
    assert.deepEqual(agent.tools, ["read", "find"]);
    assert.deepEqual(agent.disallowedTools, ["bash"]);
    assert.equal(agent.model, "sonnet");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAgents: aggregates inert-field warnings across the whole pass into exactly one console.warn call", (t) => {
  const dir = makeTmpDir();
  try {
    writeAgentFile(
      dir,
      "agent-a.md",
      `---
name: agent-a
description: First agent
permissionMode: default
---
Body A.
`,
    );
    writeAgentFile(
      dir,
      "agent-b.md",
      `---
name: agent-b
description: Second agent
permissionMode: default
---
Body B.
`,
    );

    const warnSpy = t.mock.method(console, "warn");
    const warnRegistry = new Map<string, number>();

    const agents = discoverAgents(dir, undefined, warnRegistry);

    assert.equal(agents.length, 2);

    const inertSummaryCalls = warnSpy.mock.calls.filter(
      (call) =>
        typeof call.arguments[0] === "string" &&
        (call.arguments[0] as string).includes("accepted but inert in pi"),
    );

    assert.equal(inertSummaryCalls.length, 1);
    assert.match(inertSummaryCalls[0]!.arguments[0] as string, /fields: permissionMode/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAgents: model alias (e.g. opus) end-to-end produces exactly one console.warn matching 'model aliases: opus'", (t) => {
  const dir = makeTmpDir();
  try {
    writeAgentFile(
      dir,
      "aliased.md",
      `---
name: aliased
description: Uses a Claude model alias
model: opus
---
Body.
`,
    );

    const warnSpy = t.mock.method(console, "warn");
    const warnRegistry = new Map<string, number>();

    const agents = discoverAgents(dir, undefined, warnRegistry);

    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.model, "opus");
    assert.equal(warnSpy.mock.calls.length, 1);
    assert.match(warnSpy.mock.calls[0]!.arguments[0] as string, /model aliases: opus/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAgents: populates thinking, inheritSkills, inheritExtensions, defaultContext, skills from frontmatter", () => {
  const dir = makeTmpDir();
  try {
    writeAgentFile(
      dir,
      "thinker.md",
      `---
name: thinker
description: Uses extended fields
thinking: high
inheritSkills: true
inheritExtensions: false
defaultContext: fresh
skills: [code-review]
---
Body.
`,
    );

    const agents = discoverAgents(dir);

    assert.equal(agents.length, 1);
    const agent = agents[0]!;
    assert.equal(agent.thinking, "high");
    assert.equal(agent.inheritSkills, true);
    assert.equal(agent.inheritExtensions, false);
    assert.equal(agent.defaultContext, "fresh");
    assert.deepEqual(agent.skills, ["code-review"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAgents: golden-file backward-compat gate — agents-examples/scout.md and web-scout.md (S16)", (t) => {
  const agentsDir = path.join(import.meta.dirname, "../../agents-examples");
  const warnSpy = t.mock.method(console, "warn");

  const agents = discoverAgents(agentsDir);

  assert.equal(agents.length, 2);

  const scout = agents.find((agent) => agent.name === "scout")!;
  assert.ok(scout, "scout agent should be discovered");
  assert.equal(
    scout.description,
    "Fast codebase recon — finds files, symbols, patterns, and references. "
      + "No analysis, no evaluation, no implementation. Returns compressed "
      + "findings (file paths, line numbers, excerpts) to the caller.\n",
  );
  assert.deepEqual(scout.tools, ["read", "grep", "find", "ls"]);
  assert.equal(scout.systemPromptMode, "append");
  assert.equal(scout.inheritProjectContext, false);

  const webScout = agents.find((agent) => agent.name === "web-scout")!;
  assert.ok(webScout, "web-scout agent should be discovered");
  assert.deepEqual(webScout.tools, ["web_search", "web_read"]);
  assert.equal(webScout.systemPromptMode, "replace");
  assert.equal(webScout.inheritProjectContext, false);

  // Zero warnings/inert findings for either golden file.
  assert.equal(warnSpy.mock.calls.length, 0);
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
