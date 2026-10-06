import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSubagentParams,
  resolveAgent,
  invocationOverrideOf,
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

test("validateSubagentParams: single mode empty agent/task — exact current wording", () => {
  const emptyAgent = validateSubagentParams({ agent: "", task: "find things" });
  assert.deepStrictEqual(emptyAgent, { ok: false, error: '"agent" must be a non-empty string.' });

  const emptyTask = validateSubagentParams({ agent: "scout", task: "" });
  assert.deepStrictEqual(emptyTask, { ok: false, error: '"task" must be a non-empty string.' });
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

test("validateSubagentParams: single mode with a numeric maxTurns carries it through in the returned value", () => {
  const result = validateSubagentParams({
    agent: "scout",
    task: "find things",
    maxTurns: 5,
  });

  assert.deepStrictEqual(result, {
    ok: true,
    value: {
      agent: "scout",
      task: "find things",
      maxTurns: 5,
    },
  });
});

test("validateSubagentParams: single mode with a non-number maxTurns drops the field and warns once, leaving the rest of the value intact", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});

  const result = validateSubagentParams({
    agent: "scout",
    task: "find things",
    maxTurns: "5",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepStrictEqual(result.value, { agent: "scout", task: "find things" });
    assert.ok(!("maxTurns" in result.value), "maxTurns should not be on the returned value");
  }
  assert.equal(warnSpy.mock.callCount(), 1, "expected exactly one console.warn for the non-number maxTurns");
  const message = warnSpy.mock.calls[0]!.arguments[0] as string;
  assert.match(message, /maxTurns/);
});

test("validateSubagentParams: single mode lets numeric maxTurns (0, 101, 2.5) pass through untouched — no warn at this layer (range/integer check lives in resolveMaxTurns)", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});

  for (const value of [0, 101, 2.5]) {
    const result = validateSubagentParams({
      agent: "scout",
      task: "find things",
      maxTurns: value,
    });

    assert.equal(result.ok, true, `expected maxTurns: ${value} to validate ok`);
    if (result.ok) {
      assert.deepStrictEqual(
        result.value,
        { agent: "scout", task: "find things", maxTurns: value },
      );
    }
  }

  assert.equal(
    warnSpy.mock.callCount(),
    0,
    "validate.ts must not warn about out-of-range or non-integer maxTurns — that lives at the use site",
  );
});

test("invocationOverrideOf: a present maxTurns is carried through to the returned override", () => {
  const result = invocationOverrideOf({ maxTurns: 5 });

  assert.deepStrictEqual(result, { maxTurns: 5 });
});

test("invocationOverrideOf: input without maxTurns produces no maxTurns key on the returned override", () => {
  const result = invocationOverrideOf({});

  assert.ok(!("maxTurns" in result));
});

test("invocationOverrideOf: an explicit undefined maxTurns is treated the same as an absent one, producing no key", () => {
  const result = invocationOverrideOf({ maxTurns: undefined });

  assert.ok(!("maxTurns" in result));
});

test("validateSubagentParams: single mode with a string thinking carries it through in the returned value", () => {
  const result = validateSubagentParams({
    agent: "scout",
    task: "find things",
    thinking: "low",
  });

  assert.deepStrictEqual(result, {
    ok: true,
    value: {
      agent: "scout",
      task: "find things",
      thinking: "low",
    },
  });
});

test("validateSubagentParams: single mode lets an unrecognized thinking level pass through untouched — no warn at this layer (level validity check lives in clampThinkingLevel)", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});

  const result = validateSubagentParams({
    agent: "scout",
    task: "find things",
    thinking: "adaptative",
  });

  assert.equal(result.ok, true, "expected an unrecognized thinking level to validate ok");
  if (result.ok) {
    assert.deepStrictEqual(
      result.value,
      { agent: "scout", task: "find things", thinking: "adaptative" },
    );
  }

  assert.equal(
    warnSpy.mock.callCount(),
    0,
    "validate.ts must not warn about an unrecognized thinking level — that lives at the use site",
  );
});

test("validateSubagentParams: single mode with a non-string thinking drops the field and warns once, leaving the rest of the value intact", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});

  const result = validateSubagentParams({
    agent: "scout",
    task: "find things",
    thinking: 5,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepStrictEqual(result.value, { agent: "scout", task: "find things" });
    assert.ok(!("thinking" in result.value), "thinking should not be on the returned value");
  }
  assert.equal(warnSpy.mock.callCount(), 1, "expected exactly one console.warn for the non-string thinking");
  const message = warnSpy.mock.calls[0]!.arguments[0] as string;
  assert.match(message, /thinking/);
});

test("validateSubagentParams: single mode with a numeric timeoutMs carries it through in the returned value", () => {
  const result = validateSubagentParams({
    agent: "scout",
    task: "find things",
    timeoutMs: 60_000,
  });

  assert.deepStrictEqual(result, {
    ok: true,
    value: {
      agent: "scout",
      task: "find things",
      timeoutMs: 60_000,
    },
  });
});

test("validateSubagentParams: single mode with a non-number timeoutMs drops the field and warns once, leaving the rest of the value intact", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});

  const result = validateSubagentParams({
    agent: "scout",
    task: "find things",
    timeoutMs: "60000",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepStrictEqual(result.value, { agent: "scout", task: "find things" });
    assert.ok(!("timeoutMs" in result.value), "timeoutMs should not be on the returned value");
  }
  assert.equal(warnSpy.mock.callCount(), 1, "expected exactly one console.warn for the non-number timeoutMs");
  const message = warnSpy.mock.calls[0]!.arguments[0] as string;
  assert.match(message, /timeoutMs/);
});

test("validateSubagentParams: single mode lets numeric timeoutMs (0, 1e12) pass through untouched — no warn at this layer (range/ceiling check lives in resolveTimeoutMs)", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});

  for (const value of [0, 1e12]) {
    const result = validateSubagentParams({
      agent: "scout",
      task: "find things",
      timeoutMs: value,
    });

    assert.equal(result.ok, true, `expected timeoutMs: ${value} to validate ok`);
    if (result.ok) {
      assert.deepStrictEqual(
        result.value,
        { agent: "scout", task: "find things", timeoutMs: value },
      );
    }
  }

  assert.equal(
    warnSpy.mock.callCount(),
    0,
    "validate.ts must not warn about out-of-range timeoutMs — that lives at the use site",
  );
});

test("invocationOverrideOf: a present thinking is carried through to the returned override", () => {
  const result = invocationOverrideOf({ thinking: "max" });

  assert.deepStrictEqual(result, { thinking: "max" });
});

test("invocationOverrideOf: input without thinking produces no thinking key on the returned override", () => {
  const result = invocationOverrideOf({});

  assert.ok(!("thinking" in result));
});

test("invocationOverrideOf: an explicit undefined thinking is treated the same as an absent one, producing no key", () => {
  const result = invocationOverrideOf({ thinking: undefined });

  assert.ok(!("thinking" in result));
});

test("invocationOverrideOf: a present timeoutMs is carried through to the returned override", () => {
  const result = invocationOverrideOf({ timeoutMs: 60_000 });

  assert.deepStrictEqual(result, { timeoutMs: 60_000 });
});

test("invocationOverrideOf: input without timeoutMs produces no timeoutMs key on the returned override", () => {
  const result = invocationOverrideOf({});

  assert.ok(!("timeoutMs" in result));
});

test("invocationOverrideOf: an explicit undefined timeoutMs is treated the same as an absent one, producing no key", () => {
  const result = invocationOverrideOf({ timeoutMs: undefined });

  assert.ok(!("timeoutMs" in result));
});

test("validateSubagentParams: a non-object raw value is rejected", () => {
  for (const raw of [null, "x", 42, undefined]) {
    const result = validateSubagentParams(raw);
    assert.deepStrictEqual(result, { ok: false, error: 'Provide an object with "agent" and "task".' });
  }
});

test("validateSubagentParams: a stray \"tasks\" key alongside agent/task is silently ignored", () => {
  const result = validateSubagentParams({
    agent: "scout",
    task: "find things",
    tasks: [{ agent: "builder", task: "build things" }],
  });

  assert.deepStrictEqual(result, {
    ok: true,
    value: { agent: "scout", task: "find things" },
  });
});

test("resolveAgent: a known agent name resolves to its full AgentConfig", () => {
  const scout = makeAgent({ name: "scout" });
  const reviewer = makeAgent({ name: "reviewer" });

  const result = resolveAgent("scout", [scout, reviewer]);

  assert.deepStrictEqual(result, { ok: true, value: scout });
});

test("resolveAgent: an unknown name is rejected with an error listing it and the available agents", () => {
  const scout = makeAgent({ name: "scout" });
  const reviewer = makeAgent({ name: "reviewer" });

  const result = resolveAgent("ghost", [scout, reviewer]);

  assert.deepStrictEqual(result, {
    ok: false,
    error: "Unknown agent: ghost. Available agents: scout, reviewer",
  });
});

test("resolveAgent: empty agents list is rejected with an empty available-agents list", () => {
  const result = resolveAgent("scout", []);

  assert.deepStrictEqual(result, {
    ok: false,
    error: "Unknown agent: scout. Available agents: ",
  });
});
