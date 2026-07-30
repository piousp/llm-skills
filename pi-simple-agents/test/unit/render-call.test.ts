import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAgentParams, buildSubagentCallText } from "../../src/render-call.ts";
import type { AgentConfig } from "../../src/agents.ts";
import type { CallTheme } from "../../src/render-call.ts";

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

test("formatAgentParams: model, thinking, and tools all set renders each verbatim", () => {
  const agent = makeAgent({
    model: "claude-opus-4",
    thinking: "high",
    tools: ["a", "b", "c"],
  });

  const result = formatAgentParams(agent);

  assert.equal(result, "model: claude-opus-4 · thinking: high · tools: a, b, c · skills: inherited");
});

test("formatAgentParams: none of the three set renders all as inherited", () => {
  const agent = makeAgent({});

  const result = formatAgentParams(agent);

  assert.equal(result, "model: inherited · thinking: inherited · tools: inherited · skills: inherited");
});

test("formatAgentParams: only model set renders thinking and tools as inherited", () => {
  const agent = makeAgent({ model: "claude-opus-4" });

  const result = formatAgentParams(agent);

  assert.equal(result, "model: claude-opus-4 · thinking: inherited · tools: inherited · skills: inherited");
});

test("formatAgentParams: empty tools array renders tools as none", () => {
  const agent = makeAgent({ tools: [] });

  const result = formatAgentParams(agent);

  assert.equal(result, "model: inherited · thinking: inherited · tools: none · skills: inherited");
});

test("formatAgentParams: exactly 5 tools renders the full list with no +more suffix", () => {
  const agent = makeAgent({ tools: ["a", "b", "c", "d", "e"] });

  const result = formatAgentParams(agent);

  assert.equal(result, "model: inherited · thinking: inherited · tools: a, b, c, d, e · skills: inherited");
});

test("formatAgentParams: 8 tools renders first 5 plus a +3 more suffix", () => {
  const agent = makeAgent({
    tools: ["a", "b", "c", "d", "e", "f", "g", "h"],
  });

  const result = formatAgentParams(agent);

  assert.equal(
    result,
    "model: inherited · thinking: inherited · tools: a, b, c, d, e +3 more · skills: inherited",
  );
});

const fakeTheme: CallTheme = {
  fg: (c, t) => `<${c}>${t}</${c}>`,
  bold: (t) => `<b>${t}</b>`,
};

test("buildSubagentCallText: agent + task renders bold prefix, accent agent, truncated first-line task (regression pin)", () => {
  const result = buildSubagentCallText(
    { agent: "scout", task: "Find X" },
    fakeTheme,
    new Map(),
  );

  assert.equal(
    result,
    "<toolTitle><b>subagent </b></toolTitle><accent>scout</accent>: Find X",
  );
});

test("buildSubagentCallText: missing agent renders literal '?' in place of the name", () => {
  const result = buildSubagentCallText({ task: "Find X" }, fakeTheme, new Map());

  assert.equal(
    result,
    "<toolTitle><b>subagent </b></toolTitle><accent>?</accent>: Find X",
  );
});

test("buildSubagentCallText: missing task renders no ': ...' segment", () => {
  const result = buildSubagentCallText({ agent: "scout" }, fakeTheme, new Map());

  assert.equal(
    result,
    "<toolTitle><b>subagent </b></toolTitle><accent>scout</accent>",
  );
});

test("buildSubagentCallText: task longer than 80 chars is truncated with ellipsis on first line only", () => {
  const longLine = "a".repeat(90);
  const result = buildSubagentCallText(
    { agent: "scout", task: `${longLine}\nsecond line` },
    fakeTheme,
    new Map(),
  );
  const expectedTruncated = `${"a".repeat(79)}\u2026`;

  assert.equal(
    result,
    `<toolTitle><b>subagent </b></toolTitle><accent>scout</accent>: ${expectedTruncated}`,
  );
});

test("buildSubagentCallText: paramAgents contains the agent appends a dim params line", () => {
  const agent = makeAgent({ name: "scout", model: "claude-opus-4" });
  const paramAgents = new Map([["scout", agent]]);

  const result = buildSubagentCallText(
    { agent: "scout", task: "Find X" },
    fakeTheme,
    paramAgents,
  );

  assert.equal(
    result,
    "<toolTitle><b>subagent </b></toolTitle><accent>scout</accent>: Find X"
      + `\n  <dim>${formatAgentParams(agent)}</dim>`,
  );
});

test("buildSubagentCallText: paramAgents does not contain the agent renders title only", () => {
  const paramAgents = new Map([["other", makeAgent({ name: "other" })]]);

  const result = buildSubagentCallText(
    { agent: "scout", task: "Find X" },
    fakeTheme,
    paramAgents,
  );

  assert.equal(
    result,
    "<toolTitle><b>subagent </b></toolTitle><accent>scout</accent>: Find X",
  );
});

test("buildSubagentCallText: paramAgents undefined renders title only", () => {
  const result = buildSubagentCallText(
    { agent: "scout", task: "Find X" },
    fakeTheme,
    new Map(),
  );

  assert.equal(
    result,
    "<toolTitle><b>subagent </b></toolTitle><accent>scout</accent>: Find X",
  );
});

const prefix = "<toolTitle><b>subagent </b></toolTitle>";

test("buildSubagentCallText: two tasks, paramAgents undefined renders parallel title (regression pin)", () => {
  const result = buildSubagentCallText(
    {
      tasks: [
        { agent: "scout", task: "List files" },
        { agent: "web-scout", task: "Find docs" },
      ],
    },
    fakeTheme,
    new Map(),
  );

  assert.equal(result, `${prefix}(2): scout: List files, ...`);
});

test("buildSubagentCallText: single task in tasks array renders no ', ...' suffix", () => {
  const result = buildSubagentCallText(
    { tasks: [{ agent: "scout", task: "List files" }] },
    fakeTheme,
    new Map(),
  );

  assert.equal(result, `${prefix}(1): scout: List files`);
});

test("buildSubagentCallText: tasks entry missing task renders empty description instead of throwing", () => {
  const result = buildSubagentCallText(
    { tasks: [{ agent: "scout" }] },
    fakeTheme,
    new Map(),
  );

  assert.equal(result, `${prefix}(1): scout: `);
});

test("buildSubagentCallText: tasks entry missing agent renders '?' instead of throwing", () => {
  const result = buildSubagentCallText(
    { tasks: [{ task: "List files" }] },
    fakeTheme,
    new Map(),
  );

  assert.equal(result, `${prefix}(1): ?: List files`);
});

test("buildSubagentCallText: empty tasks array falls through to single-agent branch", () => {
  const result = buildSubagentCallText(
    { agent: "scout", task: "Find X", tasks: [] },
    fakeTheme,
    new Map(),
  );

  assert.equal(
    result,
    "<toolTitle><b>subagent </b></toolTitle><accent>scout</accent>: Find X",
  );
});

test("buildSubagentCallText: two tasks, paramAgents has both appends two param lines in order", () => {
  const scoutAgent = makeAgent({ name: "scout", model: "claude-opus-4" });
  const webScoutAgent = makeAgent({ name: "web-scout", model: "claude-haiku" });
  const paramAgents = new Map([
    ["scout", scoutAgent],
    ["web-scout", webScoutAgent],
  ]);

  const result = buildSubagentCallText(
    {
      tasks: [
        { agent: "scout", task: "List files" },
        { agent: "web-scout", task: "Find docs" },
      ],
    },
    fakeTheme,
    paramAgents,
  );

  assert.equal(
    result,
    `${prefix}(2): scout: List files, ...`
      + `\n  <accent>scout</accent><dim>: ${formatAgentParams(scoutAgent)}</dim>`
      + `\n  <accent>web-scout</accent><dim>: ${formatAgentParams(webScoutAgent)}</dim>`,
  );
});

test("buildSubagentCallText: two tasks, paramAgents has only the second appends exactly one param line", () => {
  const webScoutAgent = makeAgent({ name: "web-scout", model: "claude-haiku" });
  const paramAgents = new Map([["web-scout", webScoutAgent]]);

  const result = buildSubagentCallText(
    {
      tasks: [
        { agent: "scout", task: "List files" },
        { agent: "web-scout", task: "Find docs" },
      ],
    },
    fakeTheme,
    paramAgents,
  );

  assert.equal(
    result,
    `${prefix}(2): scout: List files, ...`
      + `\n  <accent>web-scout</accent><dim>: ${formatAgentParams(webScoutAgent)}</dim>`,
  );
});

test("buildSubagentCallText: duplicate agent name in tasks produces two separate param lines", () => {
  const scoutAgent = makeAgent({ name: "scout", model: "claude-opus-4" });
  const paramAgents = new Map([["scout", scoutAgent]]);

  const result = buildSubagentCallText(
    {
      tasks: [
        { agent: "scout", task: "List files" },
        { agent: "scout", task: "Find docs" },
      ],
    },
    fakeTheme,
    paramAgents,
  );

  assert.equal(
    result,
    `${prefix}(2): scout: List files, ...`
      + `\n  <accent>scout</accent><dim>: ${formatAgentParams(scoutAgent)}</dim>`
      + `\n  <accent>scout</accent><dim>: ${formatAgentParams(scoutAgent)}</dim>`,
  );
});

test("buildSubagentCallText: tasks present with paramAgents undefined renders title only, no param lines", () => {
  const result = buildSubagentCallText(
    {
      tasks: [
        { agent: "scout", task: "List files" },
        { agent: "web-scout", task: "Find docs" },
      ],
    },
    fakeTheme,
    new Map(),
  );

  assert.equal(result, `${prefix}(2): scout: List files, ...`);
});

test("formatAgentParams: 6 tools renders first 5 plus a +1 more suffix", () => {
  const agent = makeAgent({ tools: ["a", "b", "c", "d", "e", "f"] });

  const result = formatAgentParams(agent);

  assert.equal(
    result,
    "model: inherited · thinking: inherited · tools: a, b, c, d, e +1 more · skills: inherited",
  );
});

test("formatAgentParams: modelOverride present shows the override instead of agent.model", () => {
  const agent = makeAgent({ model: "claude-opus-4" });

  const result = formatAgentParams(agent, { model: "claude-haiku" });

  assert.equal(result, "model: claude-haiku · thinking: inherited · tools: inherited · skills: inherited");
});

test("formatAgentParams: tools override renders 'none' regardless of agent's configured tools", () => {
  const agent = makeAgent({ tools: ["a", "b", "c"] });

  const result = formatAgentParams(agent, { tools: [] });

  assert.equal(result, "model: inherited · thinking: inherited · tools: none · skills: inherited");
});

test("formatAgentParams: empty override object behaves exactly like no override", () => {
  const agent = makeAgent({ model: "claude-opus-4", tools: ["a", "b"] });

  const result = formatAgentParams(agent, {});

  assert.equal(result, "model: claude-opus-4 · thinking: inherited · tools: a, b · skills: inherited");
});

test("formatAgentParams: skills override renders a new skills segment with the effective skills", () => {
  const agent = makeAgent({});

  const result = formatAgentParams(agent, { skills: ["a", "b"] });

  assert.equal(result, "model: inherited · thinking: inherited · tools: inherited · skills: a, b");
});

test("formatAgentParams: tools and skills both overridden together renders both effective values", () => {
  const agent = makeAgent({ tools: ["a", "b"], skills: ["x"] });

  const result = formatAgentParams(agent, { tools: ["read", "grep"], skills: ["tdd", "gof-design-patterns"] });

  assert.equal(
    result,
    "model: inherited · thinking: inherited · tools: read, grep · skills: tdd, gof-design-patterns",
  );
});

test("buildSubagentCallText: single-mode args.model overrides the agent's configured model in the param line", () => {
  const agent = makeAgent({ name: "scout", model: "claude-opus-4" });
  const paramAgents = new Map([["scout", agent]]);

  const result = buildSubagentCallText(
    { agent: "scout", task: "Find X", model: "claude-haiku" },
    fakeTheme,
    paramAgents,
  );

  assert.equal(
    result,
    "<toolTitle><b>subagent </b></toolTitle><accent>scout</accent>: Find X"
      + `\n  <dim>${formatAgentParams(agent, { model: "claude-haiku" })}</dim>`,
  );
});

test("buildSubagentCallText: parallel tasks each show their own model override independently", () => {
  const scoutAgent = makeAgent({ name: "scout", model: "claude-opus-4" });
  const webScoutAgent = makeAgent({ name: "web-scout", model: "claude-haiku" });
  const paramAgents = new Map([
    ["scout", scoutAgent],
    ["web-scout", webScoutAgent],
  ]);

  const result = buildSubagentCallText(
    {
      tasks: [
        { agent: "scout", task: "List files", model: "claude-sonnet" },
        { agent: "web-scout", task: "Find docs" },
      ],
    },
    fakeTheme,
    paramAgents,
  );

  assert.equal(
    result,
    `${prefix}(2): scout: List files, ...`
      + `\n  <accent>scout</accent><dim>: ${formatAgentParams(scoutAgent, { model: "claude-sonnet" })}</dim>`
      + `\n  <accent>web-scout</accent><dim>: ${formatAgentParams(webScoutAgent, undefined)}</dim>`,
  );
});

test("buildSubagentCallText: parallel tasks each show their own tools/skills override independently", () => {
  const scoutAgent = makeAgent({ name: "scout", tools: ["read", "grep"] });
  const webScoutAgent = makeAgent({ name: "web-scout", skills: ["web-fetch"] });
  const paramAgents = new Map([
    ["scout", scoutAgent],
    ["web-scout", webScoutAgent],
  ]);

  const result = buildSubagentCallText(
    {
      tasks: [
        { agent: "scout", task: "List files", tools: [] },
        { agent: "web-scout", task: "Find docs", skills: ["search"] },
      ],
    },
    fakeTheme,
    paramAgents,
  );

  assert.equal(
    result,
    `${prefix}(2): scout: List files, ...`
      + `\n  <accent>scout</accent><dim>: ${formatAgentParams(scoutAgent, { tools: [] })}</dim>`
      + `\n  <accent>web-scout</accent><dim>: ${formatAgentParams(webScoutAgent, { skills: ["search"] })}</dim>`,
  );
});

test("buildSubagentCallText: task exactly 80 chars renders without truncation", () => {
  const exactTask = "a".repeat(80);
  const result = buildSubagentCallText(
    { agent: "scout", task: exactTask },
    fakeTheme,
    new Map(),
  );

  assert.equal(
    result,
    `<toolTitle><b>subagent </b></toolTitle><accent>scout</accent>: ${exactTask}`,
  );
});
