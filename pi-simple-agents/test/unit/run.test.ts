import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentViaSdk, runWithTimeoutAndAbort, clampThinkingLevel, mapWithConcurrencyLimit, resolveTimeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, resolveConcurrency, DEFAULT_CONCURRENCY, resolveMaxTurns, MAX_TURNS_LIMIT } from "../../src/run.ts";
import { applyOverrides, applyInvocationOverride, type AgentConfig } from "../../src/agents.ts";
import { invocationOverrideOf } from "../../src/validate.ts";
import type { SubagentToolEvent } from "../../src/progress.ts";

function assistantMessageEnd(usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }, provider = "anthropic") {
  return {
    type: "message_end",
    message: { role: "assistant", provider, usage: { ...usage, cost: { total: usage.cost } } },
  };
}

class FakeAgentSession {
  private _lastAssistantText: string;
  private _listeners: Array<(event: any) => void> = [];
  private _resolvePrompt?: () => void;
  private _toolEvents: any[];
  private _turnEvents: any[];
  private _messageEvents: any[];
  private _contextUsage: any;
  shouldThrow = false;
  hangUntilAbort = false;
  abortCalled = false;
  subscribeCallCount = 0;
  _getContextUsageHook?: () => void;
  _dispose?: () => void;

  throwAfterEvents = false;

  constructor(text: string, opts: { hangUntilAbort?: boolean; toolEvents?: any[]; turnEvents?: any[]; messageEvents?: any[]; contextUsage?: any; throwAfterEvents?: boolean } = {}) {
    this._lastAssistantText = text;
    this.hangUntilAbort = opts.hangUntilAbort ?? false;
    this._toolEvents = opts.toolEvents ?? [];
    this._turnEvents = opts.turnEvents ?? [];
    this._messageEvents = opts.messageEvents ?? [];
    this._contextUsage = opts.contextUsage;
    this.throwAfterEvents = opts.throwAfterEvents ?? false;
  }

  subscribe(listener: (event: any) => void): () => void {
    this.subscribeCallCount++;
    this._listeners.push(listener);
    return () => {};
  }

  async prompt(_text: string): Promise<void> {
    if (this.shouldThrow) throw new Error("prompt failed");
    // Order is deterministic: messageEvents (usage lands first), then
    // turnEvents (may trigger maxTurns mid-stream), then an optional
    // post-events failure, then an optional hang, then toolEvents.
    for (const event of this._messageEvents) {
      this._listeners.forEach((l) => l(event));
    }
    for (const event of this._turnEvents) {
      this._listeners.forEach((l) => l(event));
    }
    if (this.throwAfterEvents) throw new Error("boom after events");
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

  getContextUsage(): any {
    this._getContextUsageHook?.();
    return this._contextUsage;
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

test("resolveTimeoutMs: exactly MAX_TIMEOUT_MS passes through silently", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  assert.equal(resolveTimeoutMs(MAX_TIMEOUT_MS), MAX_TIMEOUT_MS);
  assert.equal(warnSpy.mock.callCount(), 0);
});

test("resolveTimeoutMs: finite value over the ceiling clamps to MAX_TIMEOUT_MS with warning", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  assert.equal(resolveTimeoutMs(MAX_TIMEOUT_MS + 1), MAX_TIMEOUT_MS);
  assert.equal(warnSpy.mock.callCount(), 1);
});

test("resolveTimeoutMs: very large finite value clamps to MAX_TIMEOUT_MS", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  assert.equal(resolveTimeoutMs(1e12), MAX_TIMEOUT_MS);
  assert.equal(warnSpy.mock.callCount(), 1);
});

test("resolveTimeoutMs: Infinity still falls back to default, not the ceiling", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});
  assert.equal(resolveTimeoutMs(Infinity), DEFAULT_TIMEOUT_MS);
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

test("resolveMaxTurns: passes through undefined and valid 1..100 with no warning; invalid inputs warn once and resolve to undefined", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});

  // undefined and integer 1..100 pass through, no warn.
  assert.equal(resolveMaxTurns(undefined), undefined);
  assert.equal(resolveMaxTurns(1), 1);
  assert.equal(resolveMaxTurns(50), 50);
  assert.equal(resolveMaxTurns(100), 100);
  assert.equal(warnSpy.mock.callCount(), 0);

  // Every other value: undefined + one warn naming "maxTurns" and the bad value.
  for (const value of [0, -1, 101, 2.5, NaN, Infinity, "5"]) {
    const before = warnSpy.mock.callCount();
    assert.equal(resolveMaxTurns(value), undefined);
    assert.equal(warnSpy.mock.callCount(), before + 1);
    const message = warnSpy.mock.calls[before]!.arguments[0] as string;
    assert.match(message, /maxTurns/);
    assert.ok(
      message.includes(String(value)),
      `expected warning to mention the invalid value ${String(value)}; got: ${message}`,
    );
  }
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
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any },
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
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any },
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
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(disposed, true);
});

test("runAgentViaSdk: resolves abort-named error when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await runAgentViaSdk(
    makeAgent(),
    "find things",
    { createSession: async () => ({ session: new FakeAgentSession("x") as any }), modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any, signal: controller.signal },
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
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any, onToolEvent: (e) => events.push(e) },
  );

  assert.deepEqual(events, [
    { type: "tool_start", toolCallId: "t1", toolName: "read", summary: "read" },
    { type: "tool_end", toolCallId: "t1" },
  ]);
});

test("runAgentViaSdk: no onToolEvent still subscribes once, for usage accumulation", async () => {
  const fakeSession = new FakeAgentSession("done", {
    toolEvents: [
      { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} },
    ],
  });
  const createSession = async () => ({ session: fakeSession as any });

  await runAgentViaSdk(
    makeAgent(),
    "find things",
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  // Usage accumulation subscribes unconditionally, independent of onToolEvent.
  assert.equal(fakeSession.subscribeCallCount, 1);
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
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any, onToolEvent: (e) => events.push(e) },
  );

  assert.deepEqual(events, [
    { type: "tool_start", toolCallId: "t1", toolName: "read", summary: "read" },
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
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any, getModel },
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
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any, getModel },
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
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any, getModel },
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
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any, getModel },
  );

  assert.equal(warnSpy.mock.calls.length, 0);
});

test("runAgentViaSdk: forwards modelRuntime through to createSession by identity, and never sends modelRegistry", async () => {
  const runtimeSentinel = { find: () => undefined } as any;
  let captured: any = undefined;
  const fakeSession = new FakeAgentSession("done");
  const createSession = async (opts: any) => {
    captured = opts;
    return { session: fakeSession as any };
  };

  await runAgentViaSdk(
    makeAgent(),
    "find things",
    { modelRuntime: runtimeSentinel, createSession, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(captured.modelRuntime, runtimeSentinel);
  assert.notEqual(captured.modelRuntime, null);
  assert.equal("modelRegistry" in captured, false);
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
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(capturedThinkingLevel, "high");
});

// Reachability: composes invocationOverrideOf + applyInvocationOverride exactly
// as runSingleTask (extensions/index.ts) does, then feeds the resulting
// effectiveAgent into runAgentViaSdk — proving a per-invocation thinking
// override (not just a directly-configured agent.thinking) reaches
// createSession's thinkingLevel.
test("runAgentViaSdk: a per-invocation thinking override reaches thinkingLevel via the same composition runSingleTask uses", async () => {
  let capturedThinkingLevel: unknown = undefined;
  const fakeSession = new FakeAgentSession("done");
  const createSession = async (opts: any) => {
    capturedThinkingLevel = opts.thinkingLevel;
    return { session: fakeSession as any };
  };

  const baseAgent = makeAgent({ thinking: "low" } as any);
  const effectiveAgent = applyInvocationOverride(
    baseAgent,
    invocationOverrideOf({ thinking: "max" }),
  );

  await runAgentViaSdk(
    effectiveAgent,
    "find things",
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(capturedThinkingLevel, "max");
});

// Same composition, proving a per-invocation timeoutMs override (not just a
// directly-configured agent.timeoutMs) actually drives the real timer.
test("runAgentViaSdk: a per-invocation timeoutMs override drives the real timer via the same composition runSingleTask uses", async () => {
  const fakeSession = new FakeAgentSession("done", { hangUntilAbort: true });
  const createSession = async () => ({ session: fakeSession as any });

  const baseAgent = makeAgent({ timeoutMs: 5000 } as any);
  const effectiveAgent = applyInvocationOverride(
    baseAgent,
    invocationOverrideOf({ timeoutMs: 20 }),
  );

  const result = await runAgentViaSdk(
    effectiveAgent,
    "find things",
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal((result as any).status, "error");
  assert.match((result as any).error, /timed out after 20ms/);
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
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any },
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
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any },
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
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any },
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
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any, getModel },
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
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any, getModel },
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
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any },
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
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(result.status, "success");
});

test("runAgentViaSdk: no timeoutMs configured still succeeds on a fast run (default timeout doesn't interfere)", async () => {
  const fakeSession = new FakeAgentSession("done fast");
  const createSession = async () => ({ session: fakeSession as any });

  const result = await runAgentViaSdk(
    makeAgent(),
    "find things",
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(result.status, "success");
});

test("runAgentViaSdk: when maxTurns is set and turn_start events exceed it, settles with maxTurns error, aborts, and disposes the session", async () => {
  let disposed = false;
  const fakeSession = new FakeAgentSession("ignored", {
    turnEvents: [
      { type: "turn_start" },
      { type: "turn_start" },
      { type: "turn_start" },
    ],
  });
  fakeSession._dispose = () => { disposed = true; };
  const createSession = async () => ({ session: fakeSession as any });

  const result = await runAgentViaSdk(
    makeAgent({ maxTurns: 2 }),
    "find things",
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(result.status, "error");
  assert.equal((result as any).error, "reached maxTurns limit of 2");
  assert.equal(fakeSession.abortCalled, true);

  // settleOnce resolves the outer promise synchronously from the listener,
  // but the IIFE's finally block (which calls dispose) runs in a later
  // microtask. Poll for it, bounded, instead of asserting on a race — the
  // existing timeout test uses the same shape.
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 200;
    const check = () => {
      if (disposed) return resolve();
      if (Date.now() > deadline) return reject(new Error("session was not disposed within 200ms of maxTurns limit"));
      setTimeout(check, 0);
    };
    check();
  });
  assert.equal(disposed, true);
});

test("runAgentViaSdk: when maxTurns fires first with a long timeoutMs set, maxTurns wins: settles maxTurns error, aborts, disposes, and the timer is cleaned up", async () => {
  // Composition contract: whichever of (turnStart-past-limit, timeout) fires
  // first wins via the existing settleOnce dedupe. Here the turn fires first
  // (the fake's prompt() resolves normally after firing the events, so the
  // 5000ms timer never actually elapses); the run settles via the maxTurns
  // path and the runWithTimeoutAndAbort finally still clears its timer.
  let disposed = false;
  const fakeSession = new FakeAgentSession("ignored", {
    turnEvents: [
      { type: "turn_start" },
      { type: "turn_start" },
    ],
  });
  fakeSession._dispose = () => { disposed = true; };
  const createSession = async () => ({ session: fakeSession as any });

  const result = await runAgentViaSdk(
    makeAgent({ maxTurns: 1, timeoutMs: 5000 }),
    "find things",
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(result.status, "error");
  assert.equal((result as any).error, "reached maxTurns limit of 1");
  assert.equal(fakeSession.abortCalled, true);

  // settleOnce resolves the outer promise from the listener, but the IIFE's
  // finally block (which calls dispose) runs in a later microtask. Poll for
  // it, bounded, instead of asserting on a race — the existing timeout test
  // uses the same shape.
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 200;
    const check = () => {
      if (disposed) return resolve();
      if (Date.now() > deadline) return reject(new Error("session was not disposed within 200ms of maxTurns-composes-with-timeout path"));
      setTimeout(check, 0);
    };
    check();
  });
  assert.equal(disposed, true);
});

test("runAgentViaSdk: maxTurns (unreached) + signal abort mid-prompt settles with abort error, aborts, and does not produce a maxTurns error", async () => {
  // Composition contract: when maxTurns is set high enough that the limit is
  // never hit, and the run is hanging on prompt, aborting the signal must win
  // over the (non-existent) maxTurns path. The run settles with the existing
  // signal-abort error and the turn counter never fires. This proves the
  // settleOnce dedupe is correct in the maxTurns+signal composition: only one
  // path can settle, and the signal path is the one that wins.
  const fakeSession = new FakeAgentSession("ignored", { hangUntilAbort: true });
  const controller = new AbortController();
  const createSession = async () => ({ session: fakeSession as any });

  const promise = runAgentViaSdk(
    makeAgent({ maxTurns: 100 }),
    "find things",
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any, signal: controller.signal },
  );
  // Let the IIFE enter runWithTimeoutAndAbort (which registers the abort
  // listener) before aborting — mirrors the "signal abort mid-prompt" test.
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await promise;

  assert.equal(result.status, "error");
  assert.match((result as any).error ?? "", /abort/i);
  assert.doesNotMatch((result as any).error ?? "", /maxTurns/);
  assert.equal(fakeSession.abortCalled, true);
});

test("runAgentViaSdk: no maxTurns + many turn_start events settles success, never aborts, and never subscribes a turn counter", async () => {
  const fakeSession = new FakeAgentSession("done", {
    turnEvents: [
      { type: "turn_start", turnIndex: 0 },
      { type: "turn_start", turnIndex: 1 },
      { type: "turn_start", turnIndex: 2 },
      { type: "turn_start", turnIndex: 3 },
      { type: "turn_start", turnIndex: 4 },
    ],
  });
  const createSession = async () => ({ session: fakeSession as any });

  const result = await runAgentViaSdk(
    makeAgent(),
    "find things",
    { createSession, modelRuntime: {} as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(result.status, "success");
  assert.equal((result as any).finalText, "done");
  assert.equal(fakeSession.abortCalled, false);
  // No maxTurns and no onToolEvent -> only the unconditional usage-accumulation
  // subscription happens. The if (maxTurns !== undefined) guard is what keeps
  // the turn-counter subscriber from being registered.
  assert.equal(fakeSession.subscribeCallCount, 1);
});

test("runAgentViaSdk: no maxTurns + onToolEvent collector subscribes only the tool-events subscriber (no turn counter)", async () => {
  const fakeSession = new FakeAgentSession("done", {
    turnEvents: [
      { type: "turn_start", turnIndex: 0 },
      { type: "turn_start", turnIndex: 1 },
      { type: "turn_start", turnIndex: 2 },
      { type: "turn_start", turnIndex: 3 },
      { type: "turn_start", turnIndex: 4 },
    ],
  });
  const createSession = async () => ({ session: fakeSession as any });
  const collected: SubagentToolEvent[] = [];

  const result = await runAgentViaSdk(
    makeAgent(),
    "find things",
    {
      createSession,
      modelRuntime: {} as any,
      resourceLoader: {} as any,
      sessionManager: {} as any,
      onToolEvent: (e) => { collected.push(e); },
    },
  );

  assert.equal(result.status, "success");
  assert.equal(fakeSession.abortCalled, false);
  // Two subscriptions: the unconditional usage-accumulation one, plus the
  // tool-events one for onToolEvent. The turn counter is gated on
  // maxTurns !== undefined, so with no maxTurns it must NOT register a third.
  assert.equal(fakeSession.subscribeCallCount, 2);
  // Sanity: 5 turn_start events fired to the one subscriber and none of them
  // had any side effect (no settle, no abort, no extra onToolEvent call).
  assert.deepEqual(collected, []);
});

test("FakeAgentSession: turnEvents option fires configured turn_start events in order to subscribers", async () => {
  const events: any[] = [];
  const fakeSession = new FakeAgentSession("done", {
    turnEvents: [
      { type: "turn_start", turnIndex: 0 },
      { type: "turn_start", turnIndex: 1 },
      { type: "turn_start", turnIndex: 2 },
    ],
  });
  fakeSession.subscribe((event: any) => events.push(event));
  await fakeSession.prompt("find things");
  assert.deepEqual(events, [
    { type: "turn_start", turnIndex: 0 },
    { type: "turn_start", turnIndex: 1 },
    { type: "turn_start", turnIndex: 2 },
  ]);
});

test("runAgentViaSdk: accumulates usage from message_end assistant events across the run and attaches it on success", async () => {
  const fakeSession = new FakeAgentSession("done", {
    messageEvents: [
      assistantMessageEnd({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 }),
      assistantMessageEnd({ input: 20, output: 8, cacheRead: 100, cacheWrite: 0, cost: 0.02 }),
    ],
    contextUsage: { tokens: 500, contextWindow: 200000, percent: 0.25 },
  });
  const createSession = async () => ({ session: fakeSession as any });

  const result = await runAgentViaSdk(
    makeAgent(),
    "find things",
    { createSession, modelRuntime: { isUsingSubscription: () => false } as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(result.status, "success");
  assert.deepEqual(result.usage, {
    input: 30, output: 13, cacheRead: 100, cacheWrite: 0, cost: 0.03,
    isSubscription: false,
    context: { percent: 0.25, window: 200000 },
  });
});

test("runAgentViaSdk: usage accumulated before the throw is still attached when prompt() fails", async () => {
  const messageEvents = [assistantMessageEnd({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.005 })];
  const fakeSession = new FakeAgentSession("ignored", { messageEvents, throwAfterEvents: true });
  const createSession = async () => ({ session: fakeSession as any });

  const result = await runAgentViaSdk(
    makeAgent(),
    "find things",
    { createSession, modelRuntime: { isUsingSubscription: () => false } as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(result.status, "error");
  assert.equal(result.usage?.input, 7);
  assert.equal(result.usage?.output, 3);
});

test("runAgentViaSdk: usage accumulated before a timeout is still attached", async () => {
  const messageEvents = [assistantMessageEnd({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.005 })];
  const fakeSession = new FakeAgentSession("ignored", { messageEvents, hangUntilAbort: true });
  const createSession = async () => ({ session: fakeSession as any });

  const result = await runAgentViaSdk(
    makeAgent({ timeoutMs: 10 }),
    "find things",
    { createSession, modelRuntime: { isUsingSubscription: () => false } as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(result.status, "error");
  assert.equal(result.usage?.input, 7);
  assert.equal(result.usage?.output, 3);
});

test("runAgentViaSdk: usage accumulated before hitting maxTurns is still attached", async () => {
  const messageEvents = [assistantMessageEnd({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.005 })];
  const fakeSession = new FakeAgentSession("ignored", {
    messageEvents,
    turnEvents: [{ type: "turn_start" }, { type: "turn_start" }],
  });
  const createSession = async () => ({ session: fakeSession as any });

  const result = await runAgentViaSdk(
    makeAgent({ maxTurns: 1 }),
    "find things",
    { createSession, modelRuntime: { isUsingSubscription: () => false } as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(result.status, "error");
  assert.equal(result.usage?.input, 7);
  assert.equal(result.usage?.output, 3);
});

test("runAgentViaSdk: usage accumulated before a signal abort is still attached", async () => {
  const messageEvents = [assistantMessageEnd({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.005 })];
  const fakeSession = new FakeAgentSession("ignored", { messageEvents, hangUntilAbort: true });
  const createSession = async () => ({ session: fakeSession as any });
  const controller = new AbortController();

  const promise = runAgentViaSdk(
    makeAgent(),
    "find things",
    { createSession, modelRuntime: { isUsingSubscription: () => false } as any, resourceLoader: {} as any, sessionManager: {} as any, signal: controller.signal },
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await promise;

  assert.equal(result.status, "error");
  assert.equal(result.usage?.input, 7);
  assert.equal(result.usage?.output, 3);
});

test("runAgentViaSdk: createSession throwing before a session exists attaches zeroed usage with no context", async () => {
  const createSession = async (): Promise<any> => { throw new Error("boom"); };

  const result = await runAgentViaSdk(
    makeAgent(),
    "find things",
    { createSession, modelRuntime: { isUsingSubscription: () => false } as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(result.status, "error");
  assert.deepEqual(result.usage, {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
    isSubscription: false,
    context: undefined,
  });
});

test("runAgentViaSdk: isUsingSubscription is invoked with the provider of the last assistant message", async () => {
  const fakeSession = new FakeAgentSession("done", {
    messageEvents: [assistantMessageEnd({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, "kimi-coding")],
  });
  const createSession = async () => ({ session: fakeSession as any });
  let seenProvider: string | undefined;

  const result = await runAgentViaSdk(
    makeAgent(),
    "find things",
    { createSession, modelRuntime: { isUsingSubscription: (p: string) => { seenProvider = p; return true; } } as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(seenProvider, "kimi-coding");
  assert.equal(result.usage?.isSubscription, true);
});

test("runAgentViaSdk: no assistant messages means isUsingSubscription is never invoked", async () => {
  const fakeSession = new FakeAgentSession("done");
  const createSession = async () => ({ session: fakeSession as any });
  let called = false;

  const result = await runAgentViaSdk(
    makeAgent(),
    "find things",
    { createSession, modelRuntime: { isUsingSubscription: () => { called = true; return true; } } as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.equal(called, false);
  assert.equal(result.usage?.isSubscription, false);
});

test("runAgentViaSdk: getContextUsage is read before the session is disposed", async () => {
  const order: string[] = [];
  const fakeSession = new FakeAgentSession("done", { contextUsage: { tokens: 10, contextWindow: 200000, percent: 0.01 } });
  fakeSession._getContextUsageHook = () => order.push("getContextUsage");
  fakeSession._dispose = () => order.push("dispose");
  const createSession = async () => ({ session: fakeSession as any });

  await runAgentViaSdk(
    makeAgent(),
    "find things",
    { createSession, modelRuntime: { isUsingSubscription: () => false } as any, resourceLoader: {} as any, sessionManager: {} as any },
  );

  assert.deepEqual(order, ["getContextUsage", "dispose"]);
});
