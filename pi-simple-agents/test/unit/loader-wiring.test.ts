// Integration test (no live model call): wires buildLoaderOptions' overrides
// into a REAL DefaultResourceLoader from the SDK and confirms .reload()
// actually invokes them and reflects the result — not just that the
// callback shape is correct in isolation (that's covered by
// loader-config.test.ts unit tests). Uses fresh tmpdirs for cwd/agentDir so
// it never touches a real ~/.pi/agent.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DefaultResourceLoader, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { buildLoaderOptions } from "../../src/loader-config.ts";
import type { AgentConfig } from "../../src/agents.ts";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-agents-wiring-test-"));
}

function baseAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "test agent",
    systemPromptMode: "append",
    inheritProjectContext: true,
    defaultReads: [],
    source: "user",
    filePath: "/tmp/test-agent.md",
    systemPrompt: "",
    ...overrides,
  };
}

test("buildLoaderOptions + real DefaultResourceLoader: defaultReads file is present in getAgentsFiles() after reload()", async () => {
  const cwd = makeTmpDir();
  const homeDir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(cwd, "extra.md"), "extra content from defaultReads", "utf8");

    const { options } = buildLoaderOptions(baseAgent({ defaultReads: ["extra.md"] }), cwd, homeDir);
    const loader = new DefaultResourceLoader(options);

    await loader.reload();

    const { agentsFiles } = loader.getAgentsFiles();
    const extra = agentsFiles.find((f) => f.path === path.resolve(cwd, "extra.md"));

    assert.notEqual(extra, undefined, "expected defaultReads file to appear in loader.getAgentsFiles()");
    assert.equal(extra!.content, "extra content from defaultReads");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("buildLoaderOptions + real DefaultResourceLoader: without defaultReads, agentsFilesOverride is never invoked and getAgentsFiles() matches the SDK's unmodified base", async () => {
  const cwd = makeTmpDir();
  const homeDir = makeTmpDir();
  try {
    const { options } = buildLoaderOptions(baseAgent({ defaultReads: [] }), cwd, homeDir);
    assert.equal(options.agentsFilesOverride, undefined);

    const loader = new DefaultResourceLoader(options);
    await loader.reload();

    // Independently recomputed base (same call the SDK makes internally when
    // there's no override) instead of assuming an empty result — avoids
    // depending on whether ancestor dirs of os.tmpdir() happen to contain an
    // AGENTS.md/CLAUDE.md.
    const expectedBase = loadProjectContextFiles({ cwd, agentDir: path.join(homeDir, ".pi", "agent") });
    const { agentsFiles } = loader.getAgentsFiles();
    assert.deepEqual(agentsFiles, expectedBase);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

function writeRealSkill(skillsDir: string, name: string, description: string): void {
  const dir = path.join(skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
}

test("buildLoaderOptions + real DefaultResourceLoader: skillsOverride filters real discovered skills down to the agent's requested list and warns on unknown names", async (t) => {
  const cwd = makeTmpDir();
  const homeDir = makeTmpDir();
  try {
    // agentDir is homeDir/.pi/agent (matches buildLoaderOptions), and the SDK's
    // package manager auto-discovers <agentDir>/skills/<name>/SKILL.md as
    // "user" scope skills with no extra options needed.
    const skillsDir = path.join(homeDir, ".pi", "agent", "skills");
    writeRealSkill(skillsDir, "alpha", "Alpha skill for testing.");
    writeRealSkill(skillsDir, "beta", "Beta skill for testing.");

    const warn = t.mock.method(console, "warn", () => {});

    const { options, warnings } = buildLoaderOptions(
      baseAgent({ skills: ["alpha", "zzz"] }),
      cwd,
      homeDir,
    );
    const loader = new DefaultResourceLoader(options);

    await loader.reload();

    const { skills } = loader.getSkills();
    const names = skills.map((s) => s.name);

    assert.deepEqual(names, ["alpha"], "expected only the requested real skill to survive the filter");

    // Q2: the unknown-skills warning goes to the live warnings sink (emitted
    // post-reload by runSingleTask), not console.warn during the closure.
    const sinkWarning = warnings.some((w) => w.includes("zzz"));
    assert.equal(sinkWarning, true, "expected the warnings sink to gain a warning mentioning the unknown requested skill 'zzz'");
    assert.equal(warn.mock.calls.length, 0, "expected no direct console.warn during reload()");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("buildLoaderOptions + real DefaultResourceLoader: pi's built-in codemode, tool-search and mcp extensions load, and inheritExtensions: false disables them", async () => {
  const cwd = makeTmpDir();
  const homeDir = makeTmpDir();
  try {
    const builtinPaths = ["builtin:codemode", "builtin:tool-search", "builtin:mcp"];

    const inherited = new DefaultResourceLoader(buildLoaderOptions(baseAgent(), cwd, homeDir).options);
    await inherited.reload();
    const loadedPaths = inherited.getExtensions().extensions.map((e) => e.path);
    for (const p of builtinPaths) assert.ok(loadedPaths.includes(p), `expected ${p} in ${JSON.stringify(loadedPaths)}`);

    const isolated = new DefaultResourceLoader(buildLoaderOptions(baseAgent({ inheritExtensions: false }), cwd, homeDir).options);
    await isolated.reload();
    const isolatedPaths = isolated.getExtensions().extensions.map((e) => e.path);
    for (const p of builtinPaths) assert.ok(!isolatedPaths.includes(p), `expected ${p} absent with inheritExtensions: false`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
