import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentViaSdk, clampThinkingLevel, mapWithConcurrencyLimit } from "../../src/run.ts";
import { applyOverrides, type AgentConfig } from "../../src/agents.ts";

class FakeAgentSession {
  private _lastAssistantText: string;
  private _listeners: Array<(event: any) => void> = [];
  shouldThrow = false;
  _dispose?: () => void;

  constructor(text: string) {
    this._lastAssistantText = text;
  }

  subscribe(listener: (event: any) => void): () => void {
    this._listeners.push(listener);
    return () => {};
  }

  async prompt(_text: string): Promise<void> {
    if (this.shouldThrow) throw new Error("prompt failed");
    for (const char of this._lastAssistantText) {
      this._listeners.forEach((l) =>
        l({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: char },
        }),
      );
    }
  }

  getLastAssistantText(): string {
    return this._lastAssistantText;
  }

  dispose(): void {
    this._dispose?.();
  }

  abort(): void {}
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
    ...overrides,
  };
}

test("clampThinkingLevel: valid level passes through", () => {
  assert.equal(clampThinkingLevel("high"), "high");
  assert.equal(clampThinkingLevel("off"), "off");
  assert.equal(clampThinkingLevel("max"), "max");
});

test("clampThinkingLevel: invalid level returns undefined with warning", () => {
  const result = clampThinkingLevel("adaptative");
  assert.equal(result, undefined);
});

test("mapWithConcurrencyLimit: empty input returns empty array", async () => {
  const result = await mapWithConcurrencyLimit([], 4, async () => "x");
  assert.deepEqual(result, []);
});

test("mapWithConcurrencyLimit: processes all items in order", async () => {
  const result = await mapWithConcurrencyLimit(
    [1, 2, 3, 4, 5],
    2,
    async (n) => n * 2,
  );
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
});

test("mapWithConcurrencyLimit: respects concurrency limit", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;

  const result = await mapWithConcurrencyLimit(
    [1, 2, 3, 4, 5, 6],
    3,
    async (n) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
      return n;
    },
  );

  assert.equal(maxConcurrent, 3);
  assert.deepEqual(result, [1, 2, 3, 4, 5, 6]);
});

test("runAgentViaSdk: resolves success with finalText from session", async () => {
  const fakeSession = new FakeAgentSession("found it");
  const createSession = async () => ({ session: fakeSession as any });

  const result = await runAgentViaSdk(
    makeAgent(),
    "find things",
    { modelRuntime: {}, createSession, resourceLoader: {}, sessionManager: {} } as any,
  );

  assert.equal(result.status, "success");
  assert.equal(result.finalText, "found it");
});

test("runAgentViaSdk: resolves error when session.prompt throws", async () => {
  const fakeSession = new FakeAgentSession("ignored");
  fakeSession.shouldThrow = true;
  const createSession = async () => ({ session: fakeSession as any });

  const result = await runAgentViaSdk(
    makeAgent(),
    "find things",
    { modelRuntime: {}, createSession, resourceLoader: {}, sessionManager: {} } as any,
  );

  assert.equal(result.status, "error");
  assert.ok((result as any).error);
});

test("runAgentViaSdk: dispose called in finally even on error", async () => {
  let disposed = false;
  const fakeSession = new FakeAgentSession("ignored");
  fakeSession.shouldThrow = true;
  fakeSession._dispose = () => { disposed = true; };
  const createSession = async () => ({ session: fakeSession as any });

  await runAgentViaSdk(
    makeAgent(),
    "find things",
    { modelRuntime: {}, createSession, resourceLoader: {}, sessionManager: {} } as any,
  );

  assert.equal(disposed, true);
});

test("runAgentViaSdk: resolves abort-named error when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await runAgentViaSdk(
    makeAgent(),
    "find things",
    { modelRuntime: {}, createSession: async () => ({ session: new FakeAgentSession("x") as any }), resourceLoader: {}, sessionManager: {}, signal: controller.signal } as any,
  );

  assert.equal(result.status, "error");
  assert.match((result as any).error ?? "", /abort/i);
});

test("runAgentViaSdk: calls onProgress with text deltas", async () => {
  const progressCalls: string[] = [];
  const fakeSession = new FakeAgentSession("hello world");
  const createSession = async () => ({ session: fakeSession as any });

  await runAgentViaSdk(
    makeAgent(),
    "find things",
    { modelRuntime: {}, createSession, resourceLoader: {}, sessionManager: {}, onProgress: (t) => progressCalls.push(t) } as any,
  );

  assert.ok(progressCalls.length > 0);
  assert.equal(progressCalls.join(""), "hello world");
});

test("runAgentViaSdk: resolves model from getModel when agent.model is set", async () => {
  let capturedModel: unknown = undefined;
  const fakeSession = new FakeAgentSession("done");
  const createSession = async (opts: any) => {
    capturedModel = opts.model;
    return { session: fakeSession as any };
  };
  const getModel = (provider: string, modelId: string) => `${provider}/${modelId}`;

  await runAgentViaSdk(
    makeAgent({ model: "openrouter/gpt-4" }),
    "find things",
    { modelRuntime: {}, createSession, resourceLoader: {}, sessionManager: {}, getModel } as any,
  );

  assert.equal(capturedModel, "openrouter/gpt-4");
});

test("runAgentViaSdk: passes thinkingLevel from agent.thinking", async () => {
  let capturedThinkingLevel: unknown = undefined;
  const fakeSession = new FakeAgentSession("done");
  const createSession = async (opts: any) => {
    capturedThinkingLevel = opts.thinkingLevel;
    return { session: fakeSession as any };
  };

  await runAgentViaSdk(
    makeAgent({ thinking: "high" } as any),
    "find things",
    { modelRuntime: {}, createSession, resourceLoader: {}, sessionManager: {} } as any,
  );

  assert.equal(capturedThinkingLevel, "high");
});

test("runAgentViaSdk: passes tools from agent.tools", async () => {
  let capturedTools: unknown = undefined;
  const fakeSession = new FakeAgentSession("done");
  const createSession = async (opts: any) => {
    capturedTools = opts.tools;
    return { session: fakeSession as any };
  };

  await runAgentViaSdk(
    makeAgent({ tools: ["read", "write"] }),
    "find things",
    { modelRuntime: {}, createSession, resourceLoader: {}, sessionManager: {} } as any,
  );

  assert.deepEqual(capturedTools, ["read", "write"]);
});

test("runAgentViaSdk: model override via applyOverrides flows through getModel", async () => {
  const baseAgent: AgentConfig = {
    name: "scout",
    description: "test",
    tools: ["read"],
    model: "default-model",
    systemPromptMode: "append",
    inheritProjectContext: true,
    defaultReads: [],
    source: "user",
    filePath: "/fake/scout.md",
    systemPrompt: "body",
  };

  const overrides = {
    scout: { model: "openrouter/gpt-4" },
  };

  const [overridden] = applyOverrides([baseAgent], overrides);

  let capturedModel: unknown = undefined;
  const fakeSession = new FakeAgentSession("done");
  const createSession = async (opts: any) => {
    capturedModel = opts.model;
    return { session: fakeSession as any };
  };
  const getModel = (provider: string, modelId: string) => `${provider}/${modelId}`;

  await runAgentViaSdk(
    overridden!,
    "find things",
    { modelRuntime: {}, createSession, resourceLoader: {}, sessionManager: {}, getModel } as any,
  );

  assert.equal(capturedModel, "openrouter/gpt-4");
});