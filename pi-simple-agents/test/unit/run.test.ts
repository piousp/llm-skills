import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentViaSdk, runWithTimeoutAndAbort, clampThinkingLevel, mapWithConcurrencyLimit, resolveTimeoutMs, DEFAULT_TIMEOUT_MS, resolveConcurrency, DEFAULT_CONCURRENCY } from "../../src/run.ts";
import { applyOverrides, applyInvocationOverride, type AgentConfig } from "../../src/agents.ts";
import type { SubagentToolEvent } from "../../src/progress.ts";

class FakeAgentSession {
  private _lastAssistantText: string;
  private _listeners: Array<(event: any) => void> = [];
  private _resolvePrompt?: () => void;
  private _toolEvents: any[];
  shouldThrow = false;
  hangUntilAbort = false;
  abortCalled = false;
  subscribeCallCount = 0;
  _dispose?: () => void;

  constructor(text: string, opts: { hangUntilAbort?: boolean; toolEvents?: any[] } = {}) {
    this._lastAssistantText = text;
    this.hangUntilAbort = opts.hangUntilAbort ?? false;
    this._toolEvents = opts.toolEvents ?? [];
  }

  subscribe(listener: (event: any) => void): () => void {
    this.subscribeCallCount++;
    this._listeners.push(listener);
    return () => {};
  }

  async prompt(_text: string): Promise<void> {
    if (this.shouldThrow) throw new Error("prompt failed");
    if (this.hangUntilAbort) {
      await new Promise<void>((resolve) => { this._resolvePrompt = resolve; });
      return;
    }
    for (const event of this._toolEvents) {
      this._listeners.forEach((l) => l(event));
    }
  }

  getLastAssistantText(): string {
    return this._lastAssistantText;
  }

  dispose(): void {
    this._dispose?.();
  }

  abort(): void {
    this.abortCalled = true;
    this._resolvePrompt?.();
  }
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

test("clampThinkingLevel: valid level passes through", () => {
  assert.equal(clampThinkingLevel("high"), "high");
  assert.equal(clampThinkingLevel("off"), "off");
  assert.equal(clampThinkingLevel("max"), "max");
});

test("clampThinkingLevel: invalid level returns undefined with warning", () => {
  const result = clampThinkingLevel("adaptative");
  assert.equal(result, undefined);
});

test("resolveTimeoutMs: undefined falls back to default", () => {
  assert.equal(resolveTimeoutMs(undefined), DEFAULT_TIMEOUT_MS);
});

test("resolveTimeoutMs: finite positive number passes through", () => {
  assert.equal(resolveTimeoutMs(1000), 1000);
});

test("resolveTimeoutMs: 0 falls back to default with warning", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  assert.equal(resolveTimeoutMs(0), DEFAULT_TIMEOUT_MS);
  assert.equal(warnSpy.mock.callCount(), 1);
});

test("resolveTimeoutMs: negative number falls back to default with warning", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  assert.equal(resolveTimeoutMs(-5), DEFAULT_TIMEOUT_MS);
  assert.equal(warnSpy.mock.callCount(), 1);
});

test("resolveTimeoutMs: NaN falls back to default with warning", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  assert.equal(resolveTimeoutMs(NaN), DEFAULT_TIMEOUT_MS);
  assert.equal(warnSpy.mock.callCount(), 1);
});

test("resolveTimeoutMs: Infinity falls back to default with warning", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  assert.equal(resolveTimeoutMs(Infinity), DEFAULT_TIMEOUT_MS);
  assert.equal(warnSpy.mock.callCount(), 1);
});

test("resolveTimeoutMs: string value falls back to default with warning", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  assert.equal(resolveTimeoutMs("600000"), DEFAULT_TIMEOUT_MS);
  assert.equal(warnSpy.mock.callCount(), 1);
});

test("resolveConcurrency: undefined falls back to default", () => {
  assert.equal(resolveConcurrency(undefined), DEFAULT_CONCURRENCY);
});

test("resolveConcurrency: valid integers pass through unchanged", () => {
  assert.equal(resolveConcurrency(1), 1);
  assert.equal(resolveConcurrency(8), 8);
});

test("resolveConcurrency: 0 falls back to default with warning", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  assert.equal(resolveConcurrency(0), DEFAULT_CONCURRENCY);
  assert.equal(warnSpy.mock.callCount(), 1);
});

test("resolveConcurrency: negative number falls back to default with warning", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  assert.equal(resolveConcurrency(-1), DEFAULT_CONCURRENCY);
  assert.equal(warnSpy.mock.callCount(), 1);
});

test("resolveConcurrency: NaN falls back to default with warning", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  assert.equal(resolveConcurrency(NaN), DEFAULT_CONCURRENCY);
  assert.equal(warnSpy.mock.callCount(), 1);
});

test("resolveConcurrency: Infinity falls back to default with warning", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  assert.equal(resolveConcurrency(Infinity), DEFAULT_CONCURRENCY);
  assert.equal(warnSpy.mock.callCount(), 1);
});

test("resolveConcurrency: non-integer falls back to default with warning", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  assert.equal(resolveConcurrency(2.5), DEFAULT_CONCURRENCY);
  assert.equal(warnSpy.mock.callCount(), 1);
});

test("resolveConcurrency: non-number falls back to default with warning", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  assert.equal(resolveConcurrency("4"), DEFAULT_CONCURRENCY);
  assert.equal(warnSpy.mock.callCount(), 1);
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

test("runWithTimeoutAndAbort: prompt resolves normally before timeout/abort -> resolves cleanly and removes abort listener", async () => {
  const fakeSession = new FakeAgentSession("done");
  const controller = new AbortController();
  let removeCalled = false;
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.removeEventListener = ((...args: Parameters<typeof originalRemove>) => {
    removeCalled = true;
    return originalRemove(...args);
  }) as typeof controller.signal.removeEventListener;

  let onTimeoutCalled = false;
  await runWithTimeoutAndAbort(
    fakeSession as any,
    "find things",
    5000,
    controller.signal,
    () => { onTimeoutCalled = true; },
  );

  assert.equal(fakeSession.abortCalled, false);
  assert.equal(onTimeoutCalled, false);
  assert.equal(removeCalled, true);
});

test("runWithTimeoutAndAbort: signal abort mid-prompt calls agentSession.abort()", async () => {
  const fakeSession = new FakeAgentSession("ignored", { hangUntilAbort: true });
  const controller = new AbortController();
  let onTimeoutCalled = false;

  const promise = runWithTimeoutAndAbort(
    fakeSession as any,
    "find things",
    5000,
    controller.signal,
    () => { onTimeoutCalled = true; },
  );
  controller.abort();
  await promise;

  assert.equal(fakeSession.abortCalled, true);
  assert.equal(onTimeoutCalled, false);
});

test("runWithTimeoutAndAbort: timeout elapses before prompt resolves -> onTimeout invoked then agentSession.abort() called", async () => {
  const fakeSession = new FakeAgentSession("ignored", { hangUntilAbort: true });
  let onTimeoutCalled = false;

  await runWithTimeoutAndAbort(
    fakeSession as any,
    "find things",
    10,
    undefined,
    () => { onTimeoutCalled = true; },
  );

  assert.equal(onTimeoutCalled, true);
  assert.equal(fakeSession.abortCalled, true);
});

test("runAgentViaSdk: resolves success with finalText from session", async () => {
  const fakeSession = new FakeAgentSession("found it");
  const createSession = async () => ({ session: fakeSession as any });

  const result = await runAgentViaSdk(
    makeAgent(),
    "find things",
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any },
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
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any },
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
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(disposed, true);
});

test("runAgentViaSdk: resolves abort-named error when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await runAgentViaSdk(
    makeAgent(),
    "find things",
    { modelRegistry: {} as any, createSession: async () => ({ session: new FakeAgentSession("x") as any }), resourceLoader: {} as any, sessionManager: {} as any, signal: controller.signal },
  );

  assert.equal(result.status, "error");
  assert.match((result as any).error ?? "", /abort/i);
});

test("runAgentViaSdk: onToolEvent translates tool_execution_start/end into SubagentToolEvent, in order", async () => {
  const events: SubagentToolEvent[] = [];
  const fakeSession = new FakeAgentSession("done", {
    toolEvents: [
      { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} },
      { type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "ok", isError: false },
    ],
  });
  const createSession = async () => ({ session: fakeSession as any });

  await runAgentViaSdk(
    makeAgent(),
    "find things",
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any, onToolEvent: (e) => events.push(e) },
  );

  assert.deepEqual(events, [
    { type: "tool_start", toolCallId: "t1", toolName: "read" },
    { type: "tool_end", toolCallId: "t1" },
  ]);
});

test("runAgentViaSdk: no onToolEvent means no subscription happens at all", async () => {
  const fakeSession = new FakeAgentSession("done", {
    toolEvents: [
      { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} },
    ],
  });
  const createSession = async () => ({ session: fakeSession as any });

  await runAgentViaSdk(
    makeAgent(),
    "find things",
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(fakeSession.subscribeCallCount, 0);
});

test("runAgentViaSdk: tool_execution_update events are ignored, not translated", async () => {
  const events: SubagentToolEvent[] = [];
  const fakeSession = new FakeAgentSession("done", {
    toolEvents: [
      { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} },
      { type: "tool_execution_update", toolCallId: "t1", toolName: "read", args: {}, partialResult: "partial" },
      { type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "ok", isError: false },
    ],
  });
  const createSession = async () => ({ session: fakeSession as any });

  await runAgentViaSdk(
    makeAgent(),
    "find things",
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any, onToolEvent: (e) => events.push(e) },
  );

  assert.deepEqual(events, [
    { type: "tool_start", toolCallId: "t1", toolName: "read" },
    { type: "tool_end", toolCallId: "t1" },
  ]);
});

test("runAgentViaSdk: resolves model from getModel when agent.model is set", async () => {
  let capturedModel: unknown = undefined;
  const fakeSession = new FakeAgentSession("done");
  const createSession = async (opts: any) => {
    capturedModel = opts.model;
    return { session: fakeSession as any };
  };
  const getModel = ((provider: string, modelId: string) => `${provider}/${modelId}`) as any;

  await runAgentViaSdk(
    makeAgent({ model: "openrouter/gpt-4" }),
    "find things",
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any, getModel },
  );

  assert.equal(capturedModel, "openrouter/gpt-4");
});

test("runAgentViaSdk: calls getModel with provider and modelId split from agent.model", async () => {
  const calls: Array<[string, string]> = [];
  const fakeSession = new FakeAgentSession("done");
  const createSession = async () => ({ session: fakeSession as any });
  const getModel = ((provider: string, modelId: string) => {
    calls.push([provider, modelId]);
    return `${provider}/${modelId}`;
  }) as any;

  await runAgentViaSdk(
    makeAgent({ model: "anthropic/claude-fable-5" }),
    "find things",
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any, getModel },
  );

  assert.deepEqual(calls, [["anthropic", "claude-fable-5"]]);
});

test("runAgentViaSdk: warns and falls back when configured model is not in the registry", async (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  let capturedModel: unknown = "sentinel";
  const fakeSession = new FakeAgentSession("done");
  const createSession = async (opts: any) => {
    capturedModel = opts.model;
    return { session: fakeSession as any };
  };
  const getModel = (() => undefined) as any;

  await runAgentViaSdk(
    makeAgent({ model: "nex-agi/nex-n2-mini" }),
    "find things",
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any, getModel },
  );

  assert.equal(capturedModel, undefined);
  assert.equal(warnSpy.mock.calls.length, 1);
  const message = warnSpy.mock.calls[0]!.arguments[0] as string;
  assert.match(message, /nex-agi\/nex-n2-mini/);
  assert.match(message, /provider "nex-agi"/);
  assert.match(message, /falling back to the session default model/);
});

test("runAgentViaSdk: no warning when configured model resolves", async (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  const fakeSession = new FakeAgentSession("done");
  const createSession = async () => ({ session: fakeSession as any });
  const getModel = ((provider: string, modelId: string) => `${provider}/${modelId}`) as any;

  await runAgentViaSdk(
    makeAgent({ model: "openrouter/nex-agi/nex-n2-mini" }),
    "find things",
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any, getModel },
  );

  assert.equal(warnSpy.mock.calls.length, 0);
});

test("runAgentViaSdk: forwards modelRegistry through to createSession unchanged", async () => {
  const registryMarker = { find: () => undefined } as any;
  let capturedRegistry: unknown = undefined;
  const fakeSession = new FakeAgentSession("done");
  const createSession = async (opts: any) => {
    capturedRegistry = opts.modelRegistry;
    return { session: fakeSession as any };
  };

  await runAgentViaSdk(
    makeAgent(),
    "find things",
    { modelRegistry: registryMarker, createSession, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(capturedRegistry, registryMarker);
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
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any },
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
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.deepEqual(capturedTools, ["read", "write"]);
});

test("runAgentViaSdk: forwards agent.disallowedTools as excludeTools", async () => {
  let capturedExcludeTools: unknown = undefined;
  const fakeSession = new FakeAgentSession("done");
  const createSession = async (opts: any) => {
    capturedExcludeTools = opts.excludeTools;
    return { session: fakeSession as any };
  };

  await runAgentViaSdk(
    makeAgent({ disallowedTools: ["grep"] }),
    "find things",
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.deepEqual(capturedExcludeTools, ["grep"]);
});

test("runAgentViaSdk: agent.disallowedTools undefined forwards excludeTools as undefined", async () => {
  let capturedExcludeTools: unknown = "not-yet-captured";
  const fakeSession = new FakeAgentSession("done");
  const createSession = async (opts: any) => {
    capturedExcludeTools = opts.excludeTools;
    return { session: fakeSession as any };
  };

  await runAgentViaSdk(
    makeAgent(),
    "find things",
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(capturedExcludeTools, undefined);
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
  const getModel = ((provider: string, modelId: string) => `${provider}/${modelId}`) as any;

  await runAgentViaSdk(
    overridden!,
    "find things",
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any, getModel },
  );

  assert.equal(capturedModel, "openrouter/gpt-4");
});

test("runAgentViaSdk: precedence chain — invocation override wins over settings override wins over frontmatter", async () => {
  const baseAgent: AgentConfig = {
    name: "scout",
    description: "test",
    tools: ["read"],
    model: "anthropic/claude-haiku",
    systemPromptMode: "append",
    inheritProjectContext: true,
    defaultReads: [],
    source: "user",
    filePath: "/fake/scout.md",
    systemPrompt: "body",
  };

  const settingsOverrides = {
    scout: { model: "anthropic/claude-sonnet-5" },
  };

  const [afterSettingsOverride] = applyOverrides([baseAgent], settingsOverrides);
  const afterInvocationOverride = applyInvocationOverride(afterSettingsOverride!, { model: "anthropic/claude-opus-4-8" });

  let capturedModel: unknown = undefined;
  const fakeSession = new FakeAgentSession("done");
  const createSession = async (opts: any) => {
    capturedModel = opts.model;
    return { session: fakeSession as any };
  };
  const getModel = ((provider: string, modelId: string) => ({ provider, modelId })) as any;

  await runAgentViaSdk(
    afterInvocationOverride,
    "find things",
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any, getModel },
  );

  assert.deepEqual(capturedModel, { provider: "anthropic", modelId: "claude-opus-4-8" });
});

test("runAgentViaSdk: timeoutMs elapses, settles error and aborts+disposes the session", async () => {
  let disposed = false;
  const fakeSession = new FakeAgentSession("ignored", { hangUntilAbort: true });
  fakeSession._dispose = () => { disposed = true; };
  const createSession = async () => ({ session: fakeSession as any });

  const result = await runAgentViaSdk(
    makeAgent({ timeoutMs: 20 }),
    "find things",
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(result.status, "error");
  assert.match((result as any).error, /timed out after 20ms/);
  assert.equal(fakeSession.abortCalled, true);

  // settleOnce resolves the outer promise before abort() unblocks the hung
  // prompt(), so dispose() (in the IIFE's finally) may still be pending a
  // moment after this await returns. Poll for it, bounded by a short real
  // timeout, instead of asserting on a race.
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 200;
    const check = () => {
      if (disposed) return resolve();
      if (Date.now() > deadline) return reject(new Error("session was not disposed within 200ms of timeout"));
      setTimeout(check, 0);
    };
    check();
  });
  assert.equal(disposed, true);
});

test("runAgentViaSdk: large timeoutMs does not interfere with a fast successful run", async () => {
  const fakeSession = new FakeAgentSession("done fast");
  const createSession = async () => ({ session: fakeSession as any });

  const result = await runAgentViaSdk(
    makeAgent({ timeoutMs: 5000 }),
    "find things",
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(result.status, "success");
});

test("runAgentViaSdk: no timeoutMs configured still succeeds on a fast run (default timeout doesn't interfere)", async () => {
  const fakeSession = new FakeAgentSession("done fast");
  const createSession = async () => ({ session: fakeSession as any });

  const result = await runAgentViaSdk(
    makeAgent(),
    "find things",
    { modelRegistry: {} as any, createSession, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(result.status, "success");
});
