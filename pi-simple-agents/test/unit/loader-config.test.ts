import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLoaderOptions } from "../../src/loader-config.ts";
import type { AgentConfig } from "../../src/agents.ts";

interface FakeSkill {
  name: string;
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-agents-test-"));
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

// --- S7: noThemes ---

test("buildLoaderOptions: noThemes is unconditionally true regardless of agent config", () => {
  const cwd = "/some/cwd";
  const homeDir = "/some/home";

  const minimal = buildLoaderOptions(baseAgent(), cwd, homeDir);
  assert.equal(minimal.options.noThemes, true);

  const withOverrides = buildLoaderOptions(
    baseAgent({
      inheritExtensions: false,
      inheritSkills: false,
      inheritProjectContext: false,
      systemPromptMode: "replace",
      systemPrompt: "X",
    }),
    cwd,
    homeDir,
  );
  assert.equal(withOverrides.options.noThemes, true);
});

// --- S2: paridad ---

test("buildLoaderOptions: inheritExtensions false maps to noExtensions true, undefined maps to false", () => {
  const cwd = "/some/cwd";
  const homeDir = "/some/home";

  const withFalse = buildLoaderOptions(baseAgent({ inheritExtensions: false }), cwd, homeDir);
  assert.equal(withFalse.options.noExtensions, true);

  const withUndefined = buildLoaderOptions(baseAgent(), cwd, homeDir);
  assert.equal(withUndefined.options.noExtensions, false);
});

test("buildLoaderOptions: inheritSkills false maps to noSkills true, undefined maps to false", () => {
  const cwd = "/some/cwd";
  const homeDir = "/some/home";

  const withFalse = buildLoaderOptions(baseAgent({ inheritSkills: false }), cwd, homeDir);
  assert.equal(withFalse.options.noSkills, true);

  const withUndefined = buildLoaderOptions(baseAgent(), cwd, homeDir);
  assert.equal(withUndefined.options.noSkills, false);
});

test("buildLoaderOptions: inheritProjectContext false maps to noContextFiles true", () => {
  const cwd = "/some/cwd";
  const homeDir = "/some/home";

  const result = buildLoaderOptions(baseAgent({ inheritProjectContext: false }), cwd, homeDir);
  assert.equal(result.options.noContextFiles, true);
});

test("buildLoaderOptions: systemPromptMode 'replace' with non-empty systemPrompt sets systemPromptOverride", () => {
  const cwd = "/some/cwd";
  const homeDir = "/some/home";

  const result = buildLoaderOptions(
    baseAgent({ systemPromptMode: "replace", systemPrompt: "X" }),
    cwd,
    homeDir,
  );

  assert.equal(result.options.systemPromptOverride!(undefined), "X");
});

test("buildLoaderOptions: systemPromptMode 'append' with non-empty systemPrompt sets appendSystemPromptOverride", () => {
  const cwd = "/some/cwd";
  const homeDir = "/some/home";

  const result = buildLoaderOptions(
    baseAgent({ systemPromptMode: "append", systemPrompt: "X" }),
    cwd,
    homeDir,
  );

  assert.deepEqual(result.options.appendSystemPromptOverride!(["base"]), ["base", "X"]);
});

test("buildLoaderOptions: empty (falsy) systemPrompt yields no overrides regardless of systemPromptMode", () => {
  const cwd = "/some/cwd";
  const homeDir = "/some/home";

  const replaceResult = buildLoaderOptions(
    baseAgent({ systemPromptMode: "replace", systemPrompt: "" }),
    cwd,
    homeDir,
  );
  assert.equal(replaceResult.options.systemPromptOverride, undefined);
  assert.equal(replaceResult.options.appendSystemPromptOverride, undefined);

  const appendResult = buildLoaderOptions(
    baseAgent({ systemPromptMode: "append", systemPrompt: "" }),
    cwd,
    homeDir,
  );
  assert.equal(appendResult.options.systemPromptOverride, undefined);
  assert.equal(appendResult.options.appendSystemPromptOverride, undefined);
});

test("buildLoaderOptions: cwd and agentDir are set from parameters", () => {
  const cwd = "/some/cwd";
  const homeDir = "/some/home";

  const result = buildLoaderOptions(baseAgent(), cwd, homeDir);

  assert.equal(result.options.cwd, cwd);
  assert.equal(result.options.agentDir, path.join(homeDir, ".pi", "agent"));
});

// --- S3: defaultReads ---

test("buildLoaderOptions: empty defaultReads leaves agentsFilesOverride undefined", () => {
  const dir = makeTmpDir();
  try {
    const result = buildLoaderOptions(baseAgent({ defaultReads: [] }), dir, os.homedir());
    assert.equal(result.options.agentsFilesOverride, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLoaderOptions: defaultReads with a real file appends it after the base agentsFiles", () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, "extra.md"), "extra content", "utf8");

    const result = buildLoaderOptions(baseAgent({ defaultReads: ["extra.md"] }), dir, os.homedir());

    assert.notEqual(result.options.agentsFilesOverride, undefined);
    const output = result.options.agentsFilesOverride!({
      agentsFiles: [{ path: "base.md", content: "b" }],
    });

    assert.deepEqual(output, {
      agentsFiles: [
        { path: "base.md", content: "b" },
        { path: path.resolve(dir, "extra.md"), content: "extra content" },
      ],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLoaderOptions: extra whose resolved path matches a base entry is not duplicated", () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, "dup.md"), "dup content", "utf8");
    const resolvedDupPath = path.resolve(dir, "dup.md");

    const result = buildLoaderOptions(baseAgent({ defaultReads: ["dup.md"] }), dir, os.homedir());

    const baseAgentsFiles = [{ path: resolvedDupPath, content: "original base content" }];
    const output = result.options.agentsFilesOverride!({ agentsFiles: baseAgentsFiles });

    assert.deepEqual(output, { agentsFiles: baseAgentsFiles });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLoaderOptions: missing defaultReads file produces a warning; override stays defined if some files remain, undefined if none do", () => {
  const dir = makeTmpDir();
  try {
    // Case A: one missing, one present -> warning + override defined.
    fs.writeFileSync(path.join(dir, "present.md"), "present content", "utf8");
    const mixed = buildLoaderOptions(
      baseAgent({ defaultReads: ["missing.md", "present.md"] }),
      dir,
      os.homedir(),
    );
    assert.equal(mixed.warnings.length, 1);
    assert.match(mixed.warnings[0]!, /missing\.md/);
    assert.notEqual(mixed.options.agentsFilesOverride, undefined);

    // Case B: only missing -> warning + override undefined (nothing to add).
    const allMissing = buildLoaderOptions(
      baseAgent({ defaultReads: ["missing.md"] }),
      dir,
      os.homedir(),
    );
    assert.equal(allMissing.warnings.length, 1);
    assert.equal(allMissing.options.agentsFilesOverride, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLoaderOptions: noContextFiles and agentsFilesOverride are independent", () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, "extra.md"), "extra content", "utf8");

    const result = buildLoaderOptions(
      baseAgent({ inheritProjectContext: false, defaultReads: ["extra.md"] }),
      dir,
      os.homedir(),
    );

    assert.equal(result.options.noContextFiles, true);
    assert.notEqual(result.options.agentsFilesOverride, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- S5: skillsOverride ---

test("buildLoaderOptions: skills undefined leaves skillsOverride undefined regardless of inheritSkills", () => {
  const cwd = "/some/cwd";
  const homeDir = "/some/home";

  const withInheritTrue = buildLoaderOptions(
    baseAgent({ skills: undefined, inheritSkills: true }),
    cwd,
    homeDir,
  );
  assert.equal(withInheritTrue.options.skillsOverride, undefined);

  const withInheritFalse = buildLoaderOptions(
    baseAgent({ skills: undefined, inheritSkills: false }),
    cwd,
    homeDir,
  );
  assert.equal(withInheritFalse.options.skillsOverride, undefined);
});

test("buildLoaderOptions: skills set with inheritSkills false is a contradictory config — no skillsOverride, warning added", () => {
  const cwd = "/some/cwd";
  const homeDir = "/some/home";

  const result = buildLoaderOptions(
    baseAgent({ skills: ["a"], inheritSkills: false }),
    cwd,
    homeDir,
  );

  assert.equal(result.options.skillsOverride, undefined);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /skills/i);
});

test("buildLoaderOptions: skills set with inheritSkills true (or undefined) defines skillsOverride that filters by name and preserves diagnostics", () => {
  const cwd = "/some/cwd";
  const homeDir = "/some/home";

  const result = buildLoaderOptions(
    baseAgent({ skills: ["a", "zzz"], inheritSkills: true }),
    cwd,
    homeDir,
  );

  assert.notEqual(result.options.skillsOverride, undefined);

  const diagnostics = [{ message: "D" }];
  const base = {
    skills: [{ name: "a" } as FakeSkill, { name: "b" } as FakeSkill],
    diagnostics,
  };
  const output = result.options.skillsOverride!(base as never);

  assert.deepEqual(output, { skills: [{ name: "a" }], diagnostics });
});

test("buildLoaderOptions: missing defaultReads file and contradictory skills config on the same agent both produce warnings", () => {
  const dir = makeTmpDir();
  try {
    const result = buildLoaderOptions(
      baseAgent({
        name: "my-agent",
        defaultReads: ["missing.md"],
        skills: ["a"],
        inheritSkills: false,
      }),
      dir,
      os.homedir(),
    );

    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings[0]!, /missing\.md/);
    assert.match(result.warnings[1]!, /my-agent/);
    assert.match(result.warnings[1]!, /skills/i);
    assert.match(result.warnings[1]!, /inheritSkills/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLoaderOptions: skillsOverride callback warns via console.warn about missing skill names, including the agent name", (t) => {
  const cwd = "/some/cwd";
  const homeDir = "/some/home";

  const warnSpy = t.mock.method(console, "warn");

  const result = buildLoaderOptions(
    baseAgent({ name: "my-agent", skills: ["a", "zzz"], inheritSkills: undefined }),
    cwd,
    homeDir,
  );

  const base = {
    skills: [{ name: "a" } as FakeSkill, { name: "b" } as FakeSkill],
    diagnostics: [],
  };
  result.options.skillsOverride!(base as never);

  const matchingCalls = warnSpy.mock.calls.filter(
    (call) =>
      typeof call.arguments[0] === "string" &&
      (call.arguments[0] as string).includes("zzz") &&
      (call.arguments[0] as string).includes("my-agent"),
  );
  assert.equal(matchingCalls.length, 1);
});
