import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSubagentParams,
  resolveAgents,
  normalizeTasks,
  MAX_PARALLEL_TASKS,
} from "../../src/validate.ts";
import type { AgentConfig } from "../../src/agents.ts";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "scout",
    description: "finds things",
    systemPromptMode: "append",
    inheritProjectContext: true,
    defaultReads: [],
    source: "user",
    filePath: "/agents/scout.md",
    systemPrompt: "",
    ...overrides,
  };
}

test("validateSubagentParams: single mode with a valid model string carries it through in the returned value", () => {
  const result = validateSubagentParams({
    agent: "scout",
    task: "find things",
    model: "openrouter/anthropic/claude-sonnet-4-5",
  });

  assert.deepStrictEqual(result, {
    ok: true,
    value: {
      agent: "scout",
      task: "find things",
      model: "openrouter/anthropic/claude-sonnet-4-5",
    },
  });
});

test("validateSubagentParams: single mode with no model produces no model key on the returned value", () => {
  const result = validateSubagentParams({ agent: "scout", task: "find things" });

  assert.deepStrictEqual(result, {
    ok: true,
    value: { agent: "scout", task: "find things" },
  });
});

test("validateSubagentParams: single mode rejects malformed model strings, keeping multi-slash valid", () => {
  const invalidModels = ["opus", "/x", "anthropic/", "", 42];

  for (const model of invalidModels) {
    const result = validateSubagentParams({ agent: "scout", task: "find things", model });

    assert.equal(result.ok, false, `expected model ${JSON.stringify(model)} to be rejected`);
    if (!result.ok) {
      assert.match(result.error, /"model"/);
      assert.match(result.error, /provider\/modelId/);
    }
  }

  const validResult = validateSubagentParams({
    agent: "scout",
    task: "find things",
    model: "openrouter/anthropic/claude-sonnet-4-5",
  });
  assert.equal(validResult.ok, true);
});

test("validateSubagentParams: tasks mode carries a valid per-entry model through, leaving entries without one untouched", () => {
  const result = validateSubagentParams({
    tasks: [
      { agent: "scout", task: "find things", model: "openrouter/anthropic/claude-sonnet-4-5" },
      { agent: "reviewer", task: "review things" },
    ],
  });

  assert.deepStrictEqual(result, {
    ok: true,
    value: {
      tasks: [
        {
          agent: "scout",
          task: "find things",
          model: "openrouter/anthropic/claude-sonnet-4-5",
        },
        { agent: "reviewer", task: "review things" },
      ],
    },
  });
});

test("validateSubagentParams: tasks mode rejects a malformed per-entry model, citing the entry's index", () => {
  const result = validateSubagentParams({
    tasks: [
      { agent: "scout", task: "find things" },
      { agent: "reviewer", task: "review things", model: "opus" },
    ],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /tasks\[1\]\.model/);
    assert.match(result.error, /provider\/modelId/);
  }
});

test("validateSubagentParams: top-level model combined with tasks is rejected with a distinct per-entry-model message", () => {
  const result = validateSubagentParams({
    tasks: [{ agent: "x", task: "y" }],
    model: "anthropic/claude-opus-4-8",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /model/);
    assert.match(result.error, /per entry/);
    assert.doesNotMatch(result.error, /tasks\[\d+\]\.model/);
  }
});

test("validateSubagentParams: both {agent, task} and {tasks} provided is rejected as ambiguous mode", () => {
  const result = validateSubagentParams({
    agent: "scout",
    task: "find things",
    tasks: [{ agent: "scout", task: "find things" }],
  });

  assert.equal(result.ok, false);
});

test("validateSubagentParams: neither {agent, task} nor {tasks} provided is rejected", () => {
  const result = validateSubagentParams({});

  assert.equal(result.ok, false);
});

test("validateSubagentParams: tasks with 9 entries is rejected before any spawn, citing MAX_PARALLEL_TASKS", () => {
  assert.equal(MAX_PARALLEL_TASKS, 8);

  const nineTasks = Array.from({ length: 9 }, (_, i) => ({
    agent: "scout",
    task: `task ${i}`,
  }));

  const result = validateSubagentParams({ tasks: nineTasks });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /MAX_PARALLEL_TASKS|8/);
  }
});

test("normalizeTasks: single mode {agent, task} produces a one-entry array with that agent and task", () => {
  const result = normalizeTasks({ agent: "scout", task: "find things" });

  assert.deepStrictEqual(result, [{ agent: "scout", task: "find things" }]);
});

test("normalizeTasks: tasks mode returns the same tasks array back", () => {
  const tasks = [
    { agent: "scout", task: "find things" },
    { agent: "reviewer", task: "review things" },
  ];

  const result = normalizeTasks({ tasks });

  assert.deepStrictEqual(result, tasks);
});

test("normalizeTasks: single mode with a model carries it through on the single produced entry", () => {
  const result = normalizeTasks({ agent: "scout", task: "find things", model: "a/b" });

  assert.deepStrictEqual(result, [{ agent: "scout", task: "find things", model: "a/b" }]);
});

test("normalizeTasks: tasks mode preserves each entry's own model, present or absent, without adding an undefined key", () => {
  const tasks = [
    { agent: "scout", task: "find things", model: "a/b" },
    { agent: "reviewer", task: "review things" },
  ];

  const result = normalizeTasks({ tasks });

  assert.deepStrictEqual(result, tasks);
  assert.ok(!("model" in result[1]));
});

test("validateSubagentParams: single mode rejects a non-array \"tools\" value", () => {
  const result = validateSubagentParams({ agent: "scout", task: "find things", tools: "read" });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /"tools"/);
    assert.match(result.error, /array of strings/);
  }
});

test("validateSubagentParams: single mode rejects a \"tools\" array containing a non-string element", () => {
  const result = validateSubagentParams({ agent: "scout", task: "find things", tools: ["read", 42] });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /"tools"/);
    assert.match(result.error, /array of strings/);
  }
});

test("validateSubagentParams: single mode accepts an empty \"tools\" array, carrying it through", () => {
  const result = validateSubagentParams({ agent: "scout", task: "find things", tools: [] });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepStrictEqual(result.value, { agent: "scout", task: "find things", tools: [] });
  }
});

test("validateSubagentParams: single mode with no \"tools\" produces no tools key on the returned value", () => {
  const result = validateSubagentParams({ agent: "scout", task: "find things" });

  assert.deepStrictEqual(result, {
    ok: true,
    value: { agent: "scout", task: "find things" },
  });
});

test("validateSubagentParams: single mode rejects a non-array \"skills\" value", () => {
  const result = validateSubagentParams({ agent: "scout", task: "find things", skills: "tdd" });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /"skills"/);
    assert.match(result.error, /array of strings/);
  }
});

test("validateSubagentParams: single mode rejects a \"skills\" array containing a non-string element", () => {
  const result = validateSubagentParams({
    agent: "scout",
    task: "find things",
    skills: ["tdd", 42],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /"skills"/);
    assert.match(result.error, /array of strings/);
  }
});

test("validateSubagentParams: single mode accepts an empty \"skills\" array, carrying it through", () => {
  const result = validateSubagentParams({ agent: "scout", task: "find things", skills: [] });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepStrictEqual(result.value, { agent: "scout", task: "find things", skills: [] });
  }
});

test("validateSubagentParams: single mode with no \"skills\" produces no skills key on the returned value", () => {
  const result = validateSubagentParams({ agent: "scout", task: "find things" });

  assert.deepStrictEqual(result, {
    ok: true,
    value: { agent: "scout", task: "find things" },
  });
});

test("validateSubagentParams: tasks mode rejects a non-array tools value on an entry, citing the entry's index", () => {
  const result = validateSubagentParams({
    tasks: [{ agent: "scout", task: "find things", tools: "read" }],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /tasks\[0\]\.tools/);
    assert.match(result.error, /array of strings/);
  }
});

test("validateSubagentParams: tasks mode rejects a tools array with a non-string element on an entry", () => {
  const result = validateSubagentParams({
    tasks: [{ agent: "scout", task: "find things", tools: ["read", 42] }],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /tasks\[0\]\.tools/);
    assert.match(result.error, /array of strings/);
  }
});

test("validateSubagentParams: tasks mode accepts an empty tools array on an entry", () => {
  const result = validateSubagentParams({
    tasks: [{ agent: "scout", task: "find things", tools: [] }],
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepStrictEqual(result.value, {
      tasks: [{ agent: "scout", task: "find things", tools: [] }],
    });
  }
});

test("validateSubagentParams: tasks mode entry with no tools produces no tools key on that entry", () => {
  const result = validateSubagentParams({
    tasks: [{ agent: "scout", task: "find things" }],
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepStrictEqual(result.value, {
      tasks: [{ agent: "scout", task: "find things" }],
    });
  }
});

test("validateSubagentParams: tasks mode rejects a non-array skills value on an entry, citing the entry's index", () => {
  const result = validateSubagentParams({
    tasks: [{ agent: "scout", task: "find things", skills: "tdd" }],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /tasks\[0\]\.skills/);
    assert.match(result.error, /array of strings/);
  }
});

test("validateSubagentParams: tasks mode rejects a skills array with a non-string element on an entry", () => {
  const result = validateSubagentParams({
    tasks: [{ agent: "scout", task: "find things", skills: ["tdd", 42] }],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /tasks\[0\]\.skills/);
    assert.match(result.error, /array of strings/);
  }
});

test("validateSubagentParams: tasks mode accepts an empty skills array on an entry", () => {
  const result = validateSubagentParams({
    tasks: [{ agent: "scout", task: "find things", skills: [] }],
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepStrictEqual(result.value, {
      tasks: [{ agent: "scout", task: "find things", skills: [] }],
    });
  }
});

test("validateSubagentParams: tasks mode entry with no skills produces no skills key on that entry", () => {
  const result = validateSubagentParams({
    tasks: [{ agent: "scout", task: "find things" }],
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepStrictEqual(result.value, {
      tasks: [{ agent: "scout", task: "find things" }],
    });
  }
});

test("validateSubagentParams: top-level tools combined with tasks is rejected, naming tools", () => {
  const result = validateSubagentParams({
    tasks: [{ agent: "x", task: "y" }],
    tools: ["read"],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /"tools"/);
  }
});

test("validateSubagentParams: top-level skills combined with tasks is rejected, naming skills", () => {
  const result = validateSubagentParams({
    tasks: [{ agent: "x", task: "y" }],
    skills: ["tdd"],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /"skills"/);
  }
});

test("normalizeTasks: single mode with tools and skills carries both through on the single produced entry", () => {
  const result = normalizeTasks({
    agent: "scout",
    task: "find things",
    tools: ["read"],
    skills: ["tdd"],
  });

  assert.deepStrictEqual(result, [
    { agent: "scout", task: "find things", tools: ["read"], skills: ["tdd"] },
  ]);
});

test("validateSubagentParams: single mode with model, tools, and skills all set carries all three through", () => {
  const result = validateSubagentParams({
    agent: "scout",
    task: "find things",
    model: "anthropic/claude-opus-4-8",
    tools: ["read", "grep"],
    skills: ["tdd"],
  });

  assert.deepStrictEqual(result, {
    ok: true,
    value: {
      agent: "scout",
      task: "find things",
      model: "anthropic/claude-opus-4-8",
      tools: ["read", "grep"],
      skills: ["tdd"],
    },
  });
});

test("resolveAgents: known agent names resolve to their full AgentConfig entries", () => {
  const scout = makeAgent({ name: "scout" });
  const reviewer = makeAgent({ name: "reviewer" });

  const result = resolveAgents(["reviewer", "scout"], [scout, reviewer]);

  assert.deepEqual(result, { ok: true, value: [reviewer, scout] });
});

test("resolveAgents: an unknown name is rejected with an error listing it and the available agents", () => {
  const scout = makeAgent({ name: "scout" });
  const reviewer = makeAgent({ name: "reviewer" });

  const result = resolveAgents(["ghost"], [scout, reviewer]);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /ghost/);
    assert.match(result.error, /scout/);
    assert.match(result.error, /reviewer/);
  }
});

test("resolveAgents: duplicate names resolve to duplicate AgentConfig entries in the same order", () => {
  const scout = makeAgent({ name: "scout" });

  const result = resolveAgents(["scout", "scout"], [scout]);

  assert.deepEqual(result, { ok: true, value: [scout, scout] });
});

test("resolveAgents: empty names array resolves ok with an empty value array", () => {
  const scout = makeAgent({ name: "scout" });

  const result = resolveAgents([], [scout]);

  assert.deepEqual(result, { ok: true, value: [] });
});
