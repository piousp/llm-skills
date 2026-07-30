import { test } from "node:test";
import assert from "node:assert/strict";
import { DefaultResourceLoader, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import extensionFactory, { runSingleTask } from "../../extensions/index.ts";
import { validateSubagentParams } from "../../src/validate.ts";
import { buildSubagentCallText } from "../../src/render-call.ts";
import { createProgressTracker } from "../../src/progress.ts";
import type { AgentConfig } from "../../src/agents.ts";

const fakeTheme = {
  fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
  bold: (t: string) => `<b>${t}</b>`,
};

function textOf(component: unknown): string {
  return (component as { text: string }).text;
}

async function loadExtension(): Promise<any> {
  let captured: any;
  const fakePi = {
    registerTool: (cfg: any) => {
      captured = cfg;
    },
  } as unknown as ExtensionAPI;
  await extensionFactory(fakePi);
  return captured;
}

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

// (a)
test("execute: neither {agent, task} nor {tasks} returns validateSubagentParams' own error message as isError", async () => {
  const captured = await loadExtension();

  const expected = validateSubagentParams({});
  assert.equal(expected.ok, false);
  const expectedError = (expected as { ok: false; error: string }).error;

  const result = await captured.execute("call-1", {}, undefined, undefined, {});

  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: expectedError }]);
});

// (b)
test("execute: unknown agent name returns isError with resolveAgents' unknown-agent message", async () => {
  const captured = await loadExtension();

  const result = await captured.execute(
    "call-2",
    { agent: "definitely-not-a-real-agent-name-xyz", task: "x" },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );

  assert.equal(result.isError, true);
  const text = result.content[0].text as string;
  assert.match(text, /Unknown agent\(s\): definitely-not-a-real-agent-name-xyz/);
});

// (c)
test("renderCall: argsComplete=false renders title only — never per-agent params, regardless of registry.peek", async () => {
  const captured = await loadExtension();

  const args = { agent: "scout", task: "Find X" };
  const context = { cwd: "/some/realistic/project/path", argsComplete: false };

  const component = captured.renderCall(args, fakeTheme, context);
  const rendered = textOf(component);

  const expected = buildSubagentCallText(args, fakeTheme, new Map());
  assert.equal(rendered, expected);
  assert.doesNotMatch(rendered, /model:|thinking:|tools:/);
});

// (d)
test("renderResult: isPartial with content:[] and details:undefined renders an empty Text without throwing", async () => {
  const captured = await loadExtension();

  const result = { content: [], details: undefined, isError: false };
  const options = { expanded: false, isPartial: true };

  const component = captured.renderResult(result, options, fakeTheme, {});
  const rendered = textOf(component);

  assert.equal(rendered, "");
});

// (e)
// Mechanism note: runAgentViaSdk never rejects (it catches internally and
// always resolves), and createSession is hardcoded — neither is a reachable
// rejection seam today. resourceLoader.reload() is a real async I/O call
// inside the try block that CAN reject, so we mock
// DefaultResourceLoader.prototype.reload with node:test's built-in mock
// (same idiom already used for console.warn elsewhere in this suite) to
// force that rejection deterministically.
test("runSingleTask: resourceLoader.reload() rejecting still calls tracker.markTaskDone via finally, and the rejection propagates", async (t) => {
  t.mock.method(DefaultResourceLoader.prototype, "reload", () => Promise.reject(new Error("reload failed")));

  const agent = makeAgent();
  const tracker = createProgressTracker(["scout"], () => {});
  const doneSpy = t.mock.method(tracker, "markTaskDone");

  await assert.rejects(
    () =>
      runSingleTask({ agent: "scout", task: "do it" }, agent, 0, tracker, {
        cwd: process.cwd(),
        signal: undefined,
        modelRegistry: {} as unknown as ModelRegistry,
        callerSessionFile: undefined,
      }),
    /reload failed/,
  );

  assert.equal(doneSpy.mock.callCount(), 1);
  assert.deepEqual(doneSpy.mock.calls[0].arguments, [0]);
});
