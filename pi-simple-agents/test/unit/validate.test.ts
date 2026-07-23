import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSubagentParams,
  resolveAgents,
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
