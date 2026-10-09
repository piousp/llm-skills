import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAgentOverridesEntry } from "../../src/overrides.ts";

const SETTINGS_PATH = "/home/user/.pi/agent/settings.json";
const VALID_MODEL = "anthropic/claude-opus-4-8";

test("validateAgentOverridesEntry: valid entry with all 13 overridable fields passes through verbatim with no warnings", async (t) => {
  const warnSpy = t.mock.method(console, "warn");

  const result = validateAgentOverridesEntry(
    "scout",
    {
      model: "anthropic/claude-opus-4-8",
      tools: ["read", "grep"],
      disallowedTools: ["bash"],
      skills: ["code-review"],
      defaultReads: ["./docs"],
      thinking: "high",
      maxTurns: 10,
      timeoutMs: 5000,
      systemPromptMode: "replace",
      inheritProjectContext: false,
      inheritSkills: true,
      inheritExtensions: false,
      defaultContext: "fresh",
    },
    SETTINGS_PATH,
  );

  assert.deepStrictEqual(result, {
    model: "anthropic/claude-opus-4-8",
    tools: ["read", "grep"],
    disallowedTools: ["bash"],
    skills: ["code-review"],
    defaultReads: ["./docs"],
    thinking: "high",
    maxTurns: 10,
    timeoutMs: 5000,
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: true,
    inheritExtensions: false,
    defaultContext: "fresh",
  });
  assert.equal(warnSpy.mock.calls.length, 0);
});

test("validateAgentOverridesEntry: model as a number is dropped with the exact invalid warning", async (t) => {
  const warnSpy = t.mock.method(console, "warn");

  const result = validateAgentOverridesEntry(
    "scout",
    { model: 123, thinking: "high" },
    SETTINGS_PATH,
  );

  assert.deepStrictEqual(result, { thinking: "high" });
  assert.equal(warnSpy.mock.calls.length, 1);
  assert.equal(
    warnSpy.mock.calls[0]!.arguments[0],
    'pi-simple-agents: invalid model 123 in agentOverrides["scout"] (/home/user/.pi/agent/settings.json), ignoring',
  );
});

test("validateAgentOverridesEntry: tools as a comma-separated string (no comma-splitting in the JSON layer) is dropped with the exact invalid warning", async (t) => {
  const warnSpy = t.mock.method(console, "warn");

  const result = validateAgentOverridesEntry(
    "scout",
    { tools: "read, grep", model: VALID_MODEL },
    SETTINGS_PATH,
  );

  assert.deepStrictEqual(result, { model: VALID_MODEL });
  assert.equal(warnSpy.mock.calls.length, 1);
  assert.equal(
    warnSpy.mock.calls[0]!.arguments[0],
    'pi-simple-agents: invalid tools "read, grep" in agentOverrides["scout"] (/home/user/.pi/agent/settings.json), ignoring',
  );
});

test("validateAgentOverridesEntry: skills as an array with a non-string element is dropped with the exact invalid warning", async (t) => {
  const warnSpy = t.mock.method(console, "warn");

  const result = validateAgentOverridesEntry(
    "scout",
    { skills: ["code-review", 42], model: VALID_MODEL },
    SETTINGS_PATH,
  );

  assert.deepStrictEqual(result, { model: VALID_MODEL });
  assert.equal(warnSpy.mock.calls.length, 1);
  assert.equal(
    warnSpy.mock.calls[0]!.arguments[0],
    'pi-simple-agents: invalid skills ["code-review",42] in agentOverrides["scout"] (/home/user/.pi/agent/settings.json), ignoring',
  );
});

test("validateAgentOverridesEntry: disallowedTools as a bare string is dropped with the exact invalid warning", async (t) => {
  const warnSpy = t.mock.method(console, "warn");

  const result = validateAgentOverridesEntry(
    "scout",
    { disallowedTools: "bash", model: VALID_MODEL },
    SETTINGS_PATH,
  );

  assert.deepStrictEqual(result, { model: VALID_MODEL });
  assert.equal(warnSpy.mock.calls.length, 1);
  assert.equal(
    warnSpy.mock.calls[0]!.arguments[0],
    'pi-simple-agents: invalid disallowedTools "bash" in agentOverrides["scout"] (/home/user/.pi/agent/settings.json), ignoring',
  );
});

test("validateAgentOverridesEntry: defaultReads as null is dropped with the exact invalid warning", async (t) => {
  const warnSpy = t.mock.method(console, "warn");

  const result = validateAgentOverridesEntry(
    "scout",
    { defaultReads: null, model: VALID_MODEL },
    SETTINGS_PATH,
  );

  assert.deepStrictEqual(result, { model: VALID_MODEL });
  assert.equal(warnSpy.mock.calls.length, 1);
  assert.equal(
    warnSpy.mock.calls[0]!.arguments[0],
    'pi-simple-agents: invalid defaultReads null in agentOverrides["scout"] (/home/user/.pi/agent/settings.json), ignoring',
  );
});

test("validateAgentOverridesEntry: thinking as a non-string is dropped with the exact invalid warning", async (t) => {
  const warnSpy = t.mock.method(console, "warn");

  const result = validateAgentOverridesEntry(
    "scout",
    { thinking: 3, model: VALID_MODEL },
    SETTINGS_PATH,
  );

  assert.deepStrictEqual(result, { model: VALID_MODEL });
  assert.equal(warnSpy.mock.calls.length, 1);
  assert.equal(
    warnSpy.mock.calls[0]!.arguments[0],
    'pi-simple-agents: invalid thinking 3 in agentOverrides["scout"] (/home/user/.pi/agent/settings.json), ignoring',
  );
});

test("validateAgentOverridesEntry: maxTurns that is non-integer, out of range, or non-number is dropped with the exact invalid warning", async (t) => {
  const warnSpy = t.mock.method(console, "warn");

  // [raw value, its JSON rendering as it must appear in the warning]
  const cases: Array<[value: unknown, json: string]> = [
    [1.5, "1.5"],
    [0, "0"],
    [101, "101"],
    ["10", '"10"'],
  ];

  for (const [i, [value, json]] of cases.entries()) {
    const result = validateAgentOverridesEntry(
      "scout",
      { maxTurns: value, model: VALID_MODEL },
      SETTINGS_PATH,
    );

    assert.deepStrictEqual(result, { model: VALID_MODEL }, `maxTurns ${json}`);
    assert.equal(warnSpy.mock.calls.length, i + 1);
    assert.equal(
      warnSpy.mock.calls[i]!.arguments[0],
      `pi-simple-agents: invalid maxTurns ${json} in agentOverrides["scout"] (/home/user/.pi/agent/settings.json), ignoring`,
    );
  }
});

test("validateAgentOverridesEntry: timeoutMs as a non-number is dropped with the exact invalid warning", async (t) => {
  const warnSpy = t.mock.method(console, "warn");

  const result = validateAgentOverridesEntry(
    "scout",
    { timeoutMs: "5000", model: VALID_MODEL },
    SETTINGS_PATH,
  );

  assert.deepStrictEqual(result, { model: VALID_MODEL });
  assert.equal(warnSpy.mock.calls.length, 1);
  assert.equal(
    warnSpy.mock.calls[0]!.arguments[0],
    'pi-simple-agents: invalid timeoutMs "5000" in agentOverrides["scout"] (/home/user/.pi/agent/settings.json), ignoring',
  );
});

test("validateAgentOverridesEntry: systemPromptMode outside append|replace is dropped with the exact invalid warning", async (t) => {
  const warnSpy = t.mock.method(console, "warn");

  const result = validateAgentOverridesEntry(
    "scout",
    { systemPromptMode: "merge", model: VALID_MODEL },
    SETTINGS_PATH,
  );

  assert.deepStrictEqual(result, { model: VALID_MODEL });
  assert.equal(warnSpy.mock.calls.length, 1);
  assert.equal(
    warnSpy.mock.calls[0]!.arguments[0],
    'pi-simple-agents: invalid systemPromptMode "merge" in agentOverrides["scout"] (/home/user/.pi/agent/settings.json), ignoring',
  );
});

test("validateAgentOverridesEntry: defaultContext outside forked|fresh is dropped with the exact invalid warning", async (t) => {
  const warnSpy = t.mock.method(console, "warn");

  const result = validateAgentOverridesEntry(
    "scout",
    { defaultContext: "new", model: VALID_MODEL },
    SETTINGS_PATH,
  );

  assert.deepStrictEqual(result, { model: VALID_MODEL });
  assert.equal(warnSpy.mock.calls.length, 1);
  assert.equal(
    warnSpy.mock.calls[0]!.arguments[0],
    'pi-simple-agents: invalid defaultContext "new" in agentOverrides["scout"] (/home/user/.pi/agent/settings.json), ignoring',
  );
});

test("validateAgentOverridesEntry: inherit* flags as the string \"true\" (no string coercion in the JSON layer) are dropped with the exact invalid warning", async (t) => {
  const warnSpy = t.mock.method(console, "warn");

  const fields = ["inheritProjectContext", "inheritSkills", "inheritExtensions"];

  for (const [i, field] of fields.entries()) {
    const result = validateAgentOverridesEntry(
      "scout",
      { [field]: "true", model: VALID_MODEL },
      SETTINGS_PATH,
    );

    assert.deepStrictEqual(result, { model: VALID_MODEL }, field);
    assert.equal(warnSpy.mock.calls.length, i + 1);
    assert.equal(
      warnSpy.mock.calls[i]!.arguments[0],
      `pi-simple-agents: invalid ${field} "true" in agentOverrides["scout"] (/home/user/.pi/agent/settings.json), ignoring`,
    );
  }
});

test("validateAgentOverridesEntry: model \"inherit\" normalizes to an undefined model with no warnings", async (t) => {
  const warnSpy = t.mock.method(console, "warn");

  const result = validateAgentOverridesEntry("scout", { model: "inherit" }, SETTINGS_PATH);

  assert.deepStrictEqual(result, { model: undefined });
  assert.equal(warnSpy.mock.calls.length, 0);
});

test("validateAgentOverridesEntry: model as any string is kept verbatim — form and resolvability are not judged here", async (t) => {
  const warnSpy = t.mock.method(console, "warn");

  for (const model of ["opus", "provider/x", "x/"]) {
    const result = validateAgentOverridesEntry("scout", { model }, SETTINGS_PATH);
    assert.deepStrictEqual(result, { model }, `model ${model}`);
  }

  assert.equal(warnSpy.mock.calls.length, 0);
});

test("validateAgentOverridesEntry: excluded identity/lifecycle keys are dropped with the exact excluded-key warning", async (t) => {
  const warnSpy = t.mock.method(console, "warn");

  const cases: Array<[field: string, value: unknown]> = [
    ["name", "rogue-name"],
    ["description", "rogue description"],
    ["source", "user"],
    ["filePath", "/rogue/scout.md"],
    ["systemPrompt", "rogue system prompt"],
  ];

  for (const [i, [field, value]] of cases.entries()) {
    const result = validateAgentOverridesEntry(
      "scout",
      { [field]: value, model: VALID_MODEL },
      SETTINGS_PATH,
    );

    assert.deepStrictEqual(result, { model: VALID_MODEL }, field);
    assert.equal(warnSpy.mock.calls.length, i + 1);
    assert.equal(
      warnSpy.mock.calls[i]!.arguments[0],
      `pi-simple-agents: agentOverrides["scout"].${field} in (/home/user/.pi/agent/settings.json) is not overridable (identity/lifecycle field), ignoring`,
    );
  }
});

test("validateAgentOverridesEntry: an unknown key is dropped with the exact unknown-key warning", async (t) => {
  const warnSpy = t.mock.method(console, "warn");

  const result = validateAgentOverridesEntry(
    "scout",
    { favoriteSnack: "cookies", model: VALID_MODEL },
    SETTINGS_PATH,
  );

  assert.deepStrictEqual(result, { model: VALID_MODEL });
  assert.equal(warnSpy.mock.calls.length, 1);
  assert.equal(
    warnSpy.mock.calls[0]!.arguments[0],
    'pi-simple-agents: unknown field "favoriteSnack" in agentOverrides["scout"] (/home/user/.pi/agent/settings.json), ignoring',
  );
});

test("validateAgentOverridesEntry: a non-object entry (string, null, or array) yields an empty partial with the not-an-object warning", async (t) => {
  const warnSpy = t.mock.method(console, "warn");

  const raws: unknown[] = ["not an object", null, ["not", "an", "object"]];

  for (const [i, raw] of raws.entries()) {
    const result = validateAgentOverridesEntry("scout", raw, SETTINGS_PATH);

    assert.deepStrictEqual(result, {}, `raw ${JSON.stringify(raw)}`);
    assert.equal(warnSpy.mock.calls.length, i + 1);
    assert.equal(
      warnSpy.mock.calls[i]!.arguments[0],
      'pi-simple-agents: agentOverrides["scout"] in (/home/user/.pi/agent/settings.json) is not an object, ignoring',
    );
  }
});
