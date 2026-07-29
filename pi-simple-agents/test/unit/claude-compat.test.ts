import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapClaudeTools,
  normalizeClaudeModel,
  claimUnwarned,
  reportInertUsage,
} from "../../src/claude-compat.ts";

// S9 — mapClaudeTools

test("mapClaudeTools maps known Claude tool names to their pi equivalents", () => {
  const { tools, inert } = mapClaudeTools(["Read", "Glob", "MultiEdit"]);

  assert.deepEqual(tools, ["read", "find", "edit"]);
  assert.deepEqual(inert, []);
});

test("mapClaudeTools passes through already-lowercase pi names and unknown names unchanged", () => {
  const { tools, inert } = mapClaudeTools(["bash", "SomeUnknownTool"]);

  assert.deepEqual(tools, ["bash", "SomeUnknownTool"]);
  assert.deepEqual(inert, []);
});

test("mapClaudeTools passes inert tools through in tools[] and also reports them in inert[]", () => {
  const { tools, inert } = mapClaudeTools(["Read", "Task"]);

  assert.deepEqual(tools, ["read", "Task"]);
  assert.deepEqual(inert, ["Task"]);
});

test("mapClaudeTools deduplicates tools preserving first-occurrence order", () => {
  const { tools } = mapClaudeTools(["Glob", "find"]);

  assert.deepEqual(tools, ["find"]);
});

test("mapClaudeTools deduplicates inert tools preserving first-occurrence order", () => {
  const { inert } = mapClaudeTools(["Task", "Task"]);

  assert.deepEqual(inert, ["Task"]);
});

// S10 — normalizeClaudeModel

test("normalizeClaudeModel('inherit') yields undefined model and no alias", () => {
  const result = normalizeClaudeModel("inherit");

  assert.equal(result.model, undefined);
  assert.ok(!result.alias);
});

test("normalizeClaudeModel resolves a known alias to itself with alias set", () => {
  const result = normalizeClaudeModel("sonnet");

  assert.equal(result.model, "sonnet");
  assert.equal(result.alias, "sonnet");
});

test("normalizeClaudeModel passes through a full model id with no alias", () => {
  const result = normalizeClaudeModel("claude-opus-5");

  assert.equal(result.model, "claude-opus-5");
  assert.ok(!result.alias);
});

// S11 — claimUnwarned

test("claimUnwarned returns and marks a fresh key on first call", () => {
  const registry = new Map<string, number>();

  const claimed = claimUnwarned(["permissionMode"], registry);

  assert.deepEqual(claimed, ["permissionMode"]);
  assert.ok(registry.has("permissionMode"));
});

test("claimUnwarned excludes a key already warned within the ttl window", () => {
  const registry = new Map<string, number>();

  claimUnwarned(["maxTurns"], registry);
  const second = claimUnwarned(["maxTurns"], registry);

  assert.deepEqual(second, []);
});

test("claimUnwarned re-includes a key whose registry entry is older than ttlMs", () => {
  const registry = new Map<string, number>([["hooks", Date.now() - 100_000]]);

  const claimed = claimUnwarned(["hooks"], registry, 60_000);

  assert.deepEqual(claimed, ["hooks"]);
});

// S12 — reportInertUsage

test("reportInertUsage returns undefined when there is nothing inert", () => {
  const registry = new Map<string, number>();

  const warning = reportInertUsage({ fields: [], tools: [], models: [] }, registry);

  assert.equal(warning, undefined);
});

test("reportInertUsage formats a single-group message for one inert field", () => {
  const registry = new Map<string, number>();

  const warning = reportInertUsage(
    { fields: ["maxTurns"], tools: [], models: [] },
    registry,
  );

  assert.equal(
    warning,
    "pi-simple-agents: accepted but inert in pi \u2014 fields: maxTurns",
  );
});

test("reportInertUsage formats a combined message when all three groups are present, sorted within each group", () => {
  const registry = new Map<string, number>();

  const warning = reportInertUsage(
    {
      fields: ["maxTurns", "permissionMode"],
      tools: ["Task"],
      models: ["sonnet"],
    },
    registry,
  );

  assert.equal(
    warning,
    "pi-simple-agents: accepted but inert in pi \u2014 fields: maxTurns, permissionMode; tools: Task; model aliases: sonnet (Claude Code compatibility)",
  );
});

test("reportInertUsage returns undefined when the registry has already claimed all the keys", () => {
  const registry = new Map<string, number>();
  reportInertUsage({ fields: ["maxTurns"], tools: ["Task"], models: [] }, registry);

  const warning = reportInertUsage(
    { fields: ["maxTurns"], tools: ["Task"], models: [] },
    registry,
  );

  assert.equal(warning, undefined);
});
