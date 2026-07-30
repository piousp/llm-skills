import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverAgents,
  loadSettings,
  applyOverrides,
  type AgentConfig,
  type AgentOverrides,
  type CacheEntry,
  type SubagentSettings,
} from "../../src/agents.ts";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-agents-test-"));
}

function writeAgentFile(dir: string, filename: string, content: string): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

test("discoverAgents: directory with one valid agent .md returns one AgentConfig with resolved defaults", async () => {
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

    const agents = await discoverAgents(dir);

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

test("discoverAgents: file missing description is skipped without throwing; other valid files still returned", async () => {
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

    const agents = await discoverAgents(dir);

    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.name, "good");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAgents: symlinked .md with only 4 base Claude Code fields gets pi-simple-agents defaults filled in", async () => {
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

    const agents = await discoverAgents(dir);

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

test("applyOverrides: project override wins over user override; user override wins over frontmatter when project doesn't touch the field", () => {
  const overrides: AgentOverrides = {
    scout: { model: "project-model", description: "User description" },
  };

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

test("discoverAgents: cache returns cached data on second call", async () => {
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

    const cache = new Map<string, CacheEntry<Promise<AgentConfig[]>>>();

    const first = await discoverAgents(dir, cache);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.name, "test-agent");

    // Delete the file and call again — should still return cached data
    fs.rmSync(path.join(dir, "test-agent.md"));
    const second = await discoverAgents(dir, cache);
    assert.equal(second.length, 1);
    assert.equal(second[0]!.name, "test-agent");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAgents: cache is optional — not passing cache still works", async () => {
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

    const agents = await discoverAgents(dir);
    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.name, "test-agent");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAgents: two synchronous un-awaited calls with the same cache Map and dir return Object.is-equal promises", () => {
  const dir = makeTmpDir();
  try {
    const cache = new Map<string, CacheEntry<Promise<AgentConfig[]>>>();

    const first = discoverAgents(dir, cache);
    const second = discoverAgents(dir, cache);

    assert.ok(Object.is(first, second));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAgents: warnings are emitted in readdir/filename order regardless of internal parallel execution", async (t) => {
  const dir = makeTmpDir();
  try {
    writeAgentFile(
      dir,
      "agent-a.md",
      `---
name: agent-a
---
Missing description A.
`,
    );
    writeAgentFile(
      dir,
      "agent-b.md",
      `---
name: agent-b
---
Missing description B.
`,
    );
    writeAgentFile(
      dir,
      "agent-c.md",
      `---
name: agent-c
---
Missing description C.
`,
    );

    const warnSpy = t.mock.method(console, "warn");

    const agents = await discoverAgents(dir);

    assert.equal(agents.length, 0);

    const skipWarnings = warnSpy.mock.calls
      .map((call) => call.arguments[0] as string)
      .filter((message) => message.includes("skipping"));

    assert.equal(skipWarnings.length, 3);
    assert.ok(skipWarnings[0]!.includes("agent-a.md"));
    assert.ok(skipWarnings[1]!.includes("agent-b.md"));
    assert.ok(skipWarnings[2]!.includes("agent-c.md"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAgents: maps Claude tool names onto tools/disallowedTools and does not skip the agent for inert fields", async () => {
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

    const agents = await discoverAgents(dir, undefined, new Map<string, number>());

    assert.equal(agents.length, 1);
    const agent = agents[0]!;
    assert.deepEqual(agent.tools, ["read", "find"]);
    assert.deepEqual(agent.disallowedTools, ["bash"]);
    assert.equal(agent.model, "sonnet");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAgents: aggregates inert-field warnings across the whole pass into exactly one console.warn call", async (t) => {
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

    const agents = await discoverAgents(dir, undefined, warnRegistry);

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

test("discoverAgents: model alias (e.g. opus) end-to-end produces exactly one console.warn matching 'model aliases: opus'", async (t) => {
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

    const agents = await discoverAgents(dir, undefined, warnRegistry);

    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.model, "opus");
    assert.equal(warnSpy.mock.calls.length, 1);
    assert.match(warnSpy.mock.calls[0]!.arguments[0] as string, /model aliases: opus/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAgents: populates thinking, inheritSkills, inheritExtensions, defaultContext, skills from frontmatter", async () => {
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

    const agents = await discoverAgents(dir);

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

test("discoverAgents: golden-file backward-compat gate — agents-examples/scout.md and web-scout.md (S16)", async (t) => {
  const agentsDir = path.join(import.meta.dirname, "../../agents-examples");
  const warnSpy = t.mock.method(console, "warn");

  const agents = await discoverAgents(agentsDir);

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

test("loadSettings: both files missing returns empty agentOverrides and undefined concurrency", async () => {
  const dir = makeTmpDir();
  try {
    const userSettingsPath = path.join(dir, "user-settings.json");
    const projectSettingsPath = path.join(dir, "project-settings.json");

    const settings = await loadSettings(userSettingsPath, projectSettingsPath);

    assert.deepEqual(settings.agentOverrides, {});
    assert.equal(settings.concurrency, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSettings: reads concurrency from 'pi-simple-agents' key", async () => {
  const dir = makeTmpDir();
  try {
    const userSettingsPath = path.join(dir, "user-settings.json");
    fs.writeFileSync(
      userSettingsPath,
      JSON.stringify({ "pi-simple-agents": { concurrency: 6 } }),
      "utf8",
    );

    const settings = await loadSettings(userSettingsPath);

    assert.equal(settings.concurrency, 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSettings: reads concurrency from legacy 'subagents' key", async () => {
  const dir = makeTmpDir();
  try {
    const userSettingsPath = path.join(dir, "user-settings.json");
    fs.writeFileSync(
      userSettingsPath,
      JSON.stringify({ subagents: { concurrency: 6 } }),
      "utf8",
    );

    const settings = await loadSettings(userSettingsPath);

    assert.equal(settings.concurrency, 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSettings: legacy 'subagents' key emits a deprecation warning naming the settings file", async (t) => {
  const dir = makeTmpDir();
  try {
    const userSettingsPath = path.join(dir, "user-settings.json");
    fs.writeFileSync(
      userSettingsPath,
      JSON.stringify({ subagents: { concurrency: 6 } }),
      "utf8",
    );

    const warnSpy = t.mock.method(console, "warn", () => {});

    const settings = await loadSettings(userSettingsPath);

    assert.equal(settings.concurrency, 6);
    assert.ok(
      warnSpy.mock.calls.some((call) => {
        const message = call.arguments[0] as string;
        return message.includes("subagents") && message.includes(userSettingsPath);
      }),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSettings: legacy 'subagents' key used for both agentOverrides and concurrency warns once, not twice", async (t) => {
  const dir = makeTmpDir();
  try {
    const userSettingsPath = path.join(dir, "user-settings.json");
    fs.writeFileSync(
      userSettingsPath,
      JSON.stringify({
        subagents: { concurrency: 6, agentOverrides: { scout: { model: "custom" } } },
      }),
      "utf8",
    );

    const warnSpy = t.mock.method(console, "warn", () => {});

    const settings = await loadSettings(userSettingsPath);

    assert.equal(settings.concurrency, 6);
    assert.equal(settings.agentOverrides.scout?.model, "custom");
    const deprecationCalls = warnSpy.mock.calls.filter((call) => {
      const message = call.arguments[0] as string;
      return message.includes("subagents") && message.includes(userSettingsPath);
    });
    assert.equal(deprecationCalls.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSettings: 'pi-simple-agents' key alone does not emit the legacy deprecation warning", async (t) => {
  const dir = makeTmpDir();
  try {
    const userSettingsPath = path.join(dir, "user-settings.json");
    fs.writeFileSync(
      userSettingsPath,
      JSON.stringify({ "pi-simple-agents": { concurrency: 6 } }),
      "utf8",
    );

    const warnSpy = t.mock.method(console, "warn", () => {});

    const settings = await loadSettings(userSettingsPath);

    assert.equal(settings.concurrency, 6);
    assert.equal(warnSpy.mock.calls.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSettings: 'pi-simple-agents' concurrency and legacy 'subagents' agentOverrides in the same file are both honored independently", async () => {
  const dir = makeTmpDir();
  try {
    const userSettingsPath = path.join(dir, "user-settings.json");
    fs.writeFileSync(
      userSettingsPath,
      JSON.stringify({
        "pi-simple-agents": { concurrency: 6 },
        subagents: { agentOverrides: { scout: { model: "custom" } } },
      }),
      "utf8",
    );

    const settings = await loadSettings(userSettingsPath);

    assert.equal(settings.concurrency, 6);
    assert.equal(settings.agentOverrides.scout?.model, "custom");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSettings: 'pi-simple-agents' agentOverrides and legacy 'subagents' concurrency in the same file are both honored independently", async () => {
  const dir = makeTmpDir();
  try {
    const userSettingsPath = path.join(dir, "user-settings.json");
    fs.writeFileSync(
      userSettingsPath,
      JSON.stringify({
        "pi-simple-agents": { agentOverrides: { scout: { model: "custom" } } },
        subagents: { concurrency: 8 },
      }),
      "utf8",
    );

    const settings = await loadSettings(userSettingsPath);

    assert.equal(settings.concurrency, 8);
    assert.equal(settings.agentOverrides.scout?.model, "custom");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSettings: when both 'pi-simple-agents' and legacy 'subagents' set agentOverrides in the same file, 'pi-simple-agents' wins entirely", async () => {
  const dir = makeTmpDir();
  try {
    const userSettingsPath = path.join(dir, "user-settings.json");
    fs.writeFileSync(
      userSettingsPath,
      JSON.stringify({
        "pi-simple-agents": { agentOverrides: { scout: { model: "primary-model" } } },
        subagents: { agentOverrides: { scout: { model: "legacy-model" } } },
      }),
      "utf8",
    );

    const settings = await loadSettings(userSettingsPath);

    assert.equal(settings.agentOverrides.scout?.model, "primary-model");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSettings: project file's concurrency overrides user file's", async () => {
  const dir = makeTmpDir();
  try {
    const userSettingsPath = path.join(dir, "user-settings.json");
    const projectSettingsPath = path.join(dir, "project-settings.json");

    fs.writeFileSync(
      userSettingsPath,
      JSON.stringify({ "pi-simple-agents": { concurrency: 4 } }),
      "utf8",
    );
    fs.writeFileSync(
      projectSettingsPath,
      JSON.stringify({ "pi-simple-agents": { concurrency: 8 } }),
      "utf8",
    );

    const settings = await loadSettings(userSettingsPath, projectSettingsPath);

    assert.equal(settings.concurrency, 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSettings: project file with no concurrency key falls back to user file's value", async () => {
  const dir = makeTmpDir();
  try {
    const userSettingsPath = path.join(dir, "user-settings.json");
    const projectSettingsPath = path.join(dir, "project-settings.json");

    fs.writeFileSync(
      userSettingsPath,
      JSON.stringify({ "pi-simple-agents": { concurrency: 4 } }),
      "utf8",
    );
    fs.writeFileSync(
      projectSettingsPath,
      JSON.stringify({ "pi-simple-agents": { agentOverrides: {} } }),
      "utf8",
    );

    const settings = await loadSettings(userSettingsPath, projectSettingsPath);

    assert.equal(settings.concurrency, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSettings: agentOverrides merge — project field wins per-agent over user", async () => {
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

    const settings = await loadSettings(userSettingsPath, projectSettingsPath);

    assert.equal(settings.agentOverrides.scout?.model, "project-model");
    assert.equal(settings.agentOverrides.scout?.description, "User description");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSettings: malformed JSON in project file only still returns user file's data, with a warning naming the project file", async (t) => {
  const dir = makeTmpDir();
  try {
    const userSettingsPath = path.join(dir, "user-settings.json");
    const projectSettingsPath = path.join(dir, "project-settings.json");

    fs.writeFileSync(
      userSettingsPath,
      JSON.stringify({
        "pi-simple-agents": {
          concurrency: 6,
          agentOverrides: { scout: { model: "user-model" } },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(projectSettingsPath, "{ not valid json", "utf8");

    const warnSpy = t.mock.method(console, "warn");

    const settings = await loadSettings(userSettingsPath, projectSettingsPath);

    assert.equal(settings.concurrency, 6);
    assert.equal(settings.agentOverrides.scout?.model, "user-model");
    assert.ok(
      warnSpy.mock.calls.some((call) =>
        (call.arguments[0] as string).includes(projectSettingsPath),
      ),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSettings: non-object agentOverrides in settings file falls back to {} and warns naming the file", async (t) => {
  const dir = makeTmpDir();
  try {
    const userSettingsPath = path.join(dir, "user-settings.json");

    fs.writeFileSync(
      userSettingsPath,
      JSON.stringify({
        "pi-simple-agents": {
          agentOverrides: "oops",
        },
      }),
      "utf8",
    );

    const warnSpy = t.mock.method(console, "warn");

    const settings = await loadSettings(userSettingsPath);

    assert.deepEqual(settings.agentOverrides, {});
    assert.ok(
      warnSpy.mock.calls.some((call) =>
        (call.arguments[0] as string).includes(userSettingsPath),
      ),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSettings: two synchronous un-awaited calls with the same cache Map and paths return Object.is-equal promises", () => {
  const dir = makeTmpDir();
  try {
    const userSettingsPath = path.join(dir, "user-settings.json");
    const projectSettingsPath = path.join(dir, "project-settings.json");

    const cache = new Map<string, CacheEntry<Promise<SubagentSettings>>>();

    const first = loadSettings(userSettingsPath, projectSettingsPath, cache);
    const second = loadSettings(userSettingsPath, projectSettingsPath, cache);

    assert.ok(Object.is(first, second));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSettings: cache hit within TTL does not re-read the file", async () => {
  const dir = makeTmpDir();
  try {
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        "pi-simple-agents": { agentOverrides: { scout: { model: "first-model" } } },
      }),
      "utf8",
    );

    const cache = new Map<string, CacheEntry<Promise<SubagentSettings>>>();

    const first = await loadSettings(settingsPath, undefined, cache);
    assert.equal(first.agentOverrides.scout?.model, "first-model");

    // Change the file and call again — should still return cached data
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        "pi-simple-agents": { agentOverrides: { scout: { model: "second-model" } } },
      }),
      "utf8",
    );

    const second = await loadSettings(settingsPath, undefined, cache);
    assert.equal(second.agentOverrides.scout?.model, "first-model");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
