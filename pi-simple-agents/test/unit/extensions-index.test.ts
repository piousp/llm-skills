import { test } from "node:test";
import assert from "node:assert/strict";
import { DefaultResourceLoader, type ExtensionAPI, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import extensionFactory, { runSingleTask, SubagentParams } from "../../extensions/index.ts";
import { validateSubagentParams } from "../../src/validate.ts";
import { buildSubagentCallText } from "../../src/render-call.ts";
import { createProgressTracker, type TaskProgress } from "../../src/progress.ts";
import { buildSubagentResultText } from "../../src/render-result.ts";
import type { AgentConfig } from "../../src/agents.ts";
import type { RunUsage } from "../../src/usage.ts";

const sampleUsage: RunUsage = {
  input: 12500, output: 840, cacheRead: 1_200_000, cacheWrite: 3000,
  cost: 0.4123, isSubscription: false,
  context: { percent: 12.34, window: 200000 },
};

const fakeTheme = {
  fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
  bold: (t: string) => `<b>${t}</b>`,
};

function textOf(component: unknown): string {
  return (component as { text: string }).text;
}

async function loadExtension(createModelRuntime?: () => Promise<ModelRuntime>): Promise<any> {
  let captured: any;
  const fakePi = {
    registerTool: (cfg: any) => {
      captured = cfg;
    },
  } as unknown as ExtensionAPI;
  await extensionFactory(fakePi, createModelRuntime);
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

// (S16) Smoke-level only: full schema-shape assertions belong to
// test/unit/schema-consistency.test.ts (Bucket 4); this just confirms the
// tools/skills keys exist at both the top level and inside tasks[] items.
test("SubagentParams: has tools/skills keys at both top level and tasks[] item level", () => {
  const props = SubagentParams.properties;
  assert.ok("tools" in props);
  assert.ok("skills" in props);

  const taskItemProps = (props.tasks as any).items.properties;
  assert.ok("tools" in taskItemProps);
  assert.ok("skills" in taskItemProps);
});

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

// (d2)
test("renderResult: isPartial+expanded with progress delegates to buildSubagentResultText", async () => {
  const captured = await loadExtension();

  const progress: TaskProgress[] = [
    { agent: "scout", runningTools: [{ toolCallId: "a", toolName: "read" }], history: ["read foo.ts"], done: false },
  ];
  const result = { content: [], details: { progress }, isError: false };
  const options = { expanded: true, isPartial: true };

  const component = captured.renderResult(result, options, fakeTheme, {});
  const rendered = textOf(component);

  const expected = buildSubagentResultText(
    { isPartial: true, expanded: true, progress, content: "" },
    fakeTheme,
  );
  assert.equal(rendered, expected);
});

// (d3)
test("renderResult: final+collapsed renders nothing, delegating to buildSubagentResultText", async () => {
  const captured = await loadExtension();

  const result = { content: [{ type: "text" as const, text: "the full agent output" }], details: { runs: [] }, isError: false };
  const options = { expanded: false, isPartial: false };

  const component = captured.renderResult(result, options, fakeTheme, {});
  const rendered = textOf(component);

  assert.equal(rendered, "");
});

// (d4)
test("renderResult: final+expanded renders divider + full content, delegating to buildSubagentResultText", async () => {
  const captured = await loadExtension();

  const result = { content: [{ type: "text" as const, text: "the full agent output" }], details: { runs: [] }, isError: false };
  const options = { expanded: true, isPartial: false };

  const component = captured.renderResult(result, options, fakeTheme, {});
  const rendered = textOf(component);

  const expected = buildSubagentResultText(
    { isPartial: false, expanded: true, progress: undefined, content: "the full agent output" },
    fakeTheme,
  );
  assert.equal(rendered, expected);
});

// (d5)
test("renderResult: final+expanded with runs carrying usage delegates runs through to buildSubagentResultText", async () => {
  const captured = await loadExtension();

  const runs = [{ agent: "scout", task: "find things", durationMs: 10, status: "success" as const, usage: sampleUsage }];
  const result = { content: [{ type: "text" as const, text: "the full agent output" }], details: { runs }, isError: false };
  const options = { expanded: true, isPartial: false };

  const component = captured.renderResult(result, options, fakeTheme, {});
  const rendered = textOf(component);

  const expected = buildSubagentResultText(
    { isPartial: false, expanded: true, progress: undefined, content: "the full agent output", runs },
    fakeTheme,
  );
  assert.equal(rendered, expected);
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
        modelRuntime: {} as unknown as ModelRuntime,
        callerSessionFile: undefined,
      }),
    /reload failed/,
  );

  assert.equal(doneSpy.mock.callCount(), 1);
  // markTaskDone treats an explicit `undefined` usage the same as an omitted
  // one, so only the index and the absence of usage matter here — not
  // whether the second argument was passed at all.
  const [index, usage] = doneSpy.mock.calls[0].arguments;
  assert.equal(index, 0);
  assert.equal(usage, undefined);
});

// (e2)
// Same mechanism as (g) below: getModel throws before createSession is ever
// called, so runAgentViaSdk settles an error result whose usage is the
// zeroed default (no session, no messages) — still a real RunUsage object,
// not undefined. This proves runSingleTask forwards result.usage to the
// tracker rather than dropping it.
test("runSingleTask: forwards the run's usage snapshot to tracker.markTaskDone", async (t) => {
  t.mock.method(DefaultResourceLoader.prototype, "reload", () => Promise.resolve());

  const agent = makeAgent({ model: "anthropic/claude-fable-5" });
  const tracker = createProgressTracker(["scout"], () => {});
  const doneSpy = t.mock.method(tracker, "markTaskDone");
  const fakeModelRuntime = {
    getModel: () => { throw new Error("stop before session creation"); },
  } as unknown as ModelRuntime;

  await runSingleTask({ agent: "scout", task: "do it" }, agent, 0, tracker, {
    cwd: process.cwd(),
    signal: undefined,
    modelRuntime: fakeModelRuntime,
    callerSessionFile: undefined,
  });

  assert.equal(doneSpy.mock.callCount(), 1);
  const [index, usage] = doneSpy.mock.calls[0].arguments;
  assert.equal(index, 0);
  assert.deepEqual(usage, {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
    isSubscription: false, context: undefined,
  });
});

// (g)
// Mechanism note: runSingleTask's getModel closure delegates straight to
// modelRuntime.getModel(provider, modelId) (RF-2). To observe that call
// without triggering a real session/network call, resourceLoader.reload()
// is mocked to resolve (same idiom as the (e) test above, success instead
// of rejection, so the flow proceeds far enough to reach the closure) and
// the fake getModel throws right after recording its arguments — the throw
// is caught by runAgentViaSdk's own try/catch (src/run.ts), settling the
// run as an error result before options.createSession is ever invoked.
test("runSingleTask: getModel resolver calls modelRuntime.getModel with the parsed provider and modelId", async (t) => {
  t.mock.method(DefaultResourceLoader.prototype, "reload", () => Promise.resolve());

  const agent = makeAgent({ model: "anthropic/claude-fable-5" });
  const captured: Array<[string, string]> = [];
  const fakeModelRuntime = {
    getModel: (provider: string, modelId: string) => {
      captured.push([provider, modelId]);
      throw new Error("stop before session creation");
    },
  } as unknown as ModelRuntime;

  await runSingleTask({ agent: "scout", task: "do it" }, agent, 0, undefined, {
    cwd: process.cwd(),
    signal: undefined,
    modelRuntime: fakeModelRuntime,
    callerSessionFile: undefined,
  });

  assert.deepEqual(captured, [["anthropic", "claude-fable-5"]]);
});

// (f)
test("execute: when ModelRuntime.create() rejects, the tool still registers and every invocation returns a clear error", async () => {
  const captured = await loadExtension(() => Promise.reject(new Error("boom")));

  assert.ok(captured);

  const result = await captured.execute(
    "call-3",
    { agent: "scout", task: "find things" },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );

  assert.equal(result.isError, true);
  const text = result.content[0].text as string;
  assert.match(text, /failed to initialize model runtime/);
});
