import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DefaultResourceLoader, type ExtensionAPI, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import extensionFactory, { runSingleTask, SubagentParams, deliverJobResult } from "../../extensions/index.ts";
import type { JobSnapshot, SettledJob } from "../../src/background-jobs.ts";
import { validateSubagentParams } from "../../src/validate.ts";
import { buildSubagentCallText } from "../../src/render-call.ts";
import { createProgressTracker } from "../../src/progress.ts";
import { jobNotFoundText } from "../../src/job-view.ts";
import { buildSubagentResultText } from "../../src/render-result.ts";
import { childSessionDir } from "../../src/subagent-session.ts";
import type { AgentConfig } from "../../src/agents.ts";
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-agents-extensions-index-"));
}

const fakeTheme = {
  fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
  bold: (t: string) => `<b>${t}</b>`,
  bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
};

function textOf(component: unknown): string {
  return (component as { text: string }).text;
}

// Minimal no-op stand-ins for the registrations the factory makes at setup
// time (background-jobs wiring: /subagents, the subagent-result renderer,
// and the three pi.on() lifecycle handlers) — every test loads the real
// factory, so every test's fake `pi` needs these even if it never inspects
// them. Tests that DO need to inspect them use makeFakePi() below instead.
function loadExtensionFakePi() {
  return {
    registerTool: (_cfg: any) => {},
    registerCommand: (_name: string, _opts: any) => {},
    registerMessageRenderer: (_type: string, _renderer: any) => {},
    on: (_event: string, _handler: any) => () => {},
    sendMessage: (_message: unknown, _options?: unknown) => {},
  };
}

async function loadExtension(createModelRuntime?: () => Promise<ModelRuntime>): Promise<any> {
  let captured: any;
  const fakePi = {
    ...loadExtensionFakePi(),
    registerTool: (cfg: any) => {
      captured = cfg;
    },
  } as unknown as ExtensionAPI;
  await extensionFactory(fakePi, createModelRuntime);
  return captured;
}

// Richer fake that captures every registration, for the wiring tests that
// need to inspect or invoke the registered command/renderer/handlers
// directly instead of just the tool definition.
function makeFakePi() {
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>();
  const messageRenderers = new Map<string, (...args: any[]) => unknown>();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  let tool: any;
  return {
    registerTool: (cfg: any) => {
      tool = cfg;
    },
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    registerMessageRenderer: (type: string, renderer: any) => messageRenderers.set(type, renderer),
    on: (event: string, handler: any) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    sendMessage: (message: unknown, options?: unknown) => sentMessages.push({ message, options }),
    commands,
    messageRenderers,
    handlers,
    sentMessages,
    get tool() {
      return tool;
    },
  };
}

function fakeAgentSession(finalText: string) {
  return {
    getAllTools: () => [],
    bindExtensions: async () => {},
    extensionRunner: { hasHandlers: () => false, emit: async () => {} },
    subscribe: () => () => {},
    prompt: async () => {},
    getLastAssistantText: () => finalText,
    getContextUsage: () => undefined,
    dispose: () => {},
    abort: () => {},
  };
}

function fakeExecuteCtx(overrides: { hasUI?: boolean; signal?: AbortSignal } = {}) {
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    cwd: process.cwd(),
    mode: "tui" as const,
    hasUI: overrides.hasUI ?? true,
    signal: overrides.signal,
    sessionManager: { getSessionFile: () => undefined },
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      setWidget: (_key: string, _lines: unknown, _opts?: unknown) => {},
      theme: fakeTheme,
    },
    notifications,
  };
}

function fakeCommandCtx(overrides: { hasUI?: boolean } = {}) {
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    hasUI: overrides.hasUI ?? true,
    signal: undefined,
    cwd: process.cwd(),
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      setWidget: (_key: string, _lines: unknown, _opts?: unknown) => {},
      theme: fakeTheme,
    },
    notifications,
  };
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
// tools/skills keys exist at the top level and agent/task are required.
test("SubagentParams: has tools/skills keys and requires agent/task", () => {
  const props = SubagentParams.properties;
  assert.ok("tools" in props);
  assert.ok("skills" in props);
  assert.deepEqual([...SubagentParams.required].sort(), ["agent", "task"]);
});

// Characterization: pins the exact JSON schema this tool reports to the
// model, byte for byte — externally observable (it's what the model sees),
// so it must not change even though its TS source does. Regenerated for
// 1.0.0's required agent/task, no `tasks` key.
test("SubagentParams: emitted JSON schema is pinned", () => {
  assert.equal(JSON.stringify(SubagentParams), "{\"type\":\"object\",\"required\":[\"agent\",\"task\"],\"properties\":{\"agent\":{\"type\":\"string\"},\"task\":{\"type\":\"string\"},\"model\":{\"type\":\"string\",\"description\":\"Optional model override in \\\"provider/modelId\\\" form (e.g. \\\"anthropic/claude-opus-4-8\\\"). Takes precedence over the agent's configured model.\"},\"tools\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"Optional tool whitelist for this invocation only. Replaces the agent's configured tools entirely (no merge). pi tool names, including MCP tools as mcp__<server>__<tool>; `*` matches any characters (e.g. mcp__mde-build__*). Claude Code tool-name aliases are not mapped here.\"},\"skills\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"Optional skill whitelist for this invocation only. Replaces the agent's configured skills entirely (no merge).\"},\"thinking\":{\"type\":\"string\",\"description\":\"Optional per-invocation thinking-level override (e.g. \\\"off\\\", \\\"minimal\\\", \\\"low\\\", \\\"medium\\\", \\\"high\\\", \\\"xhigh\\\", \\\"max\\\"). Takes precedence over the agent's configured thinking level. An unrecognized level is warned and ignored at run time, falling back to the agent's configured level. Omit to inherit.\"},\"maxTurns\":{\"type\":\"integer\",\"minimum\":1,\"maximum\":100,\"description\":\"Optional per-invocation maxTurns override (1-100). Limits the number of model turns (one turn = one model response + its tool batch) before the run settles as an error. Takes precedence over the agent's configured maxTurns. Omit to inherit.\"},\"timeoutMs\":{\"type\":\"integer\",\"minimum\":1,\"maximum\":7200000,\"description\":\"Optional per-invocation timeout override, in milliseconds (max 7200000, i.e. 2 hours — values above this are clamped with a warning). Limits how long the run's prompt execution may take before it settles as an error. Takes precedence over the agent's configured timeoutMs. Omit to inherit.\"}}}");
});

// (a)
test("execute: missing agent/task returns validateSubagentParams' own error message as isError", async () => {
  const captured = await loadExtension();

  const expected = validateSubagentParams({});
  assert.equal(expected.ok, false);
  const expectedError = (expected as { ok: false; error: string }).error;

  const result = await captured.execute("call-1", {}, undefined, undefined, {});

  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: expectedError }]);
});

// (b)
test("execute: unknown agent name returns isError with resolveAgent's unknown-agent message", async () => {
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
  assert.match(text, /Unknown agent: definitely-not-a-real-agent-name-xyz/);
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

test("renderCall: context.expanded=true renders the expanded call text with the full task", async () => {
  const captured = await loadExtension();

  const args = { agent: "scout", task: "Line one\nLine two" };
  const context = { cwd: "/some/realistic/project/path", argsComplete: false, expanded: true };

  const rendered = textOf(captured.renderCall(args, fakeTheme, context));

  assert.equal(rendered, buildSubagentCallText(args, fakeTheme, new Map(), true));
  assert.match(rendered, /Line two/);
});

// (d) renderResult's generic {error}/no-details passthrough is unchanged
// from before background jobs existed — still delegates to
// buildSubagentResultText with progress/runs always undefined now (the old
// `{progress}`/`{runId,runs,results}` tool-result shapes are gone; that data
// now lives on the completion *message*, tested separately below).
test("renderResult: no details renders an empty Text without throwing", async () => {
  const captured = await loadExtension();

  const result = { content: [], details: undefined, isError: false };
  const options = { expanded: false, isPartial: false };

  const component = captured.renderResult(result, options, fakeTheme, {});
  assert.equal(textOf(component), "");
});

test("renderResult: {error} details, collapsed, renders nothing (same generic passthrough as before)", async () => {
  const captured = await loadExtension();

  const result = { content: [{ type: "text" as const, text: "boom" }], details: { error: "boom" }, isError: true };
  const options = { expanded: false, isPartial: false };

  const component = captured.renderResult(result, options, fakeTheme, {});
  assert.equal(textOf(component), "");
});

test("renderResult: {error} details, expanded, renders the divider + content", async () => {
  const captured = await loadExtension();

  const result = { content: [{ type: "text" as const, text: "boom" }], details: { error: "boom" }, isError: true };
  const options = { expanded: true, isPartial: false };

  const component = captured.renderResult(result, options, fakeTheme, {});
  const expected = buildSubagentResultText(
    { expanded: true, content: "boom", run: undefined },
    fakeTheme,
  );
  assert.equal(textOf(component), expected);
});

// (d-ack) the new launch-ack branch: collapsed shows a one-line dim summary
// naming the job id, expanded shows the ack text itself.
test("renderResult: ack details ({jobId}), collapsed, shows a one-line summary naming the job id", async () => {
  const captured = await loadExtension();

  const result = {
    content: [{ type: "text" as const, text: "Started background subagent job S1003:\n..." }],
    details: { jobId: "S1003", runId: "call-1", task: { agent: "scout", task: "x" } },
    isError: false,
  };
  const options = { expanded: false, isPartial: false };

  const component = captured.renderResult(result, options, fakeTheme, {});
  const rendered = textOf(component);
  assert.match(rendered, /S1003/);
  assert.match(rendered, /\/subagents/);
  assert.doesNotMatch(rendered, /Started background/);
});

test("renderResult: ack details ({jobId}), expanded, shows the full ack content", async () => {
  const captured = await loadExtension();

  const ackText = "Started background subagent job S1003:\n- scout: x\nThe result will be delivered automatically...";
  const result = {
    content: [{ type: "text" as const, text: ackText }],
    details: { jobId: "S1003", runId: "call-1", task: { agent: "scout", task: "x" } },
    isError: false,
  };
  const options = { expanded: true, isPartial: false };

  const component = captured.renderResult(result, options, fakeTheme, {});
  assert.equal(textOf(component), ackText);
});

// (wiring) the factory registers the full background-jobs surface: the
// subagents command, the subagent-result message renderer, and the three
// lifecycle handlers the settle barrier / headless cleanup / shutdown rely
// on. Exercised here instead of only reading the source so a future removal
// of any one registration fails a test, not just a code review.
test("wiring: registers the subagents command, the subagent-result message renderer, and the lifecycle handlers", async () => {
  const pi = makeFakePi();
  await extensionFactory(pi as unknown as ExtensionAPI);

  assert.ok(pi.commands.has("subagents"));
  assert.ok(pi.messageRenderers.has("subagent-result"));
  assert.ok(pi.handlers.has("agent_before_settle"));
  assert.ok(pi.handlers.has("agent_settled"));
  assert.ok(pi.handlers.has("session_shutdown"));
});

test("wiring: /subagents with no running jobs reports the empty-list message", async () => {
  const pi = makeFakePi();
  await extensionFactory(pi as unknown as ExtensionAPI);

  const ctx = fakeCommandCtx();
  await pi.commands.get("subagents")!.handler("", ctx);

  assert.equal(ctx.notifications.length, 1);
  assert.match(ctx.notifications[0].message, /No background subagent jobs/);
});

test("wiring: /subagents cancel <unknown-id> reports not-found as a warning", async () => {
  const pi = makeFakePi();
  await extensionFactory(pi as unknown as ExtensionAPI);

  const ctx = fakeCommandCtx();
  await pi.commands.get("subagents")!.handler("cancel S9999", ctx);

  assert.equal(ctx.notifications.length, 1);
  assert.match(ctx.notifications[0].message, /S9999/);
  assert.equal(ctx.notifications[0].type, "warning");
});

test("wiring: /subagents clear with no finished jobs reports nothing to clear", async () => {
  const pi = makeFakePi();
  await extensionFactory(pi as unknown as ExtensionAPI);

  const ctx = fakeCommandCtx();
  await pi.commands.get("subagents")!.handler("clear", ctx);

  assert.equal(ctx.notifications.length, 1);
  assert.match(ctx.notifications[0].message, /No finished jobs/);
});

test("wiring: /subagents status <unknown-id> reports not-found as a warning (shared wording)", async () => {
  const pi = makeFakePi();
  await extensionFactory(pi as unknown as ExtensionAPI);

  const ctx = fakeCommandCtx();
  await pi.commands.get("subagents")!.handler("status S9999", ctx);

  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].type, "warning");
  assert.equal(ctx.notifications[0].message, jobNotFoundText("S9999"));
});

test("wiring: /subagents with no args lists; 'status' and 'cancel' with no id are usage errors", async () => {
  const pi = makeFakePi();
  await extensionFactory(pi as unknown as ExtensionAPI);

  const statusCtx = fakeCommandCtx();
  await pi.commands.get("subagents")!.handler("status", statusCtx);
  assert.equal(statusCtx.notifications[0].type, "warning");
  assert.match(statusCtx.notifications[0].message, /Usage: \/subagents status <id>/);
});

// A nested session whose prompt hangs (so the job stays running) and whose
// subscribe() keeps the listeners, so the test can drive the same session
// events the real coding-agent session emits during a run. abort() resolves
// the prompt like the real session does, so cancelling the job at the end of
// a test settles the run (eventually releasing the 10-min prompt-timeout
// timer) instead of leaving the test process hanging until it fires.
function hangingStreamingSession() {
  const listeners: Array<(event: any) => void> = [];
  let unblockPrompt: (() => void) | undefined;
  const session = {
    getAllTools: () => [],
    bindExtensions: async () => {},
    extensionRunner: { hasHandlers: () => false, emit: async () => {} },
    subscribe: (listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {};
    },
    prompt: () => new Promise<void>((resolve) => { unblockPrompt = resolve; }),
    getLastAssistantText: () => "",
    getContextUsage: () => ({ tokens: 500, contextWindow: 200000, percent: 0.25 }),
    dispose: () => {},
    abort: () => { unblockPrompt?.(); },
  } as any;
  const emit = (events: any[]) => listeners.forEach((listener) => events.forEach((event) => listener(event)));
  return { session, emit, listeners };
}

// Settles a still-hanging job created against hangingStreamingSession so the
// test process can exit: cancels through the command handler (user cancel)
// and waits for the run to settle and deliver.
async function settleRunningJob(pi: ReturnType<typeof makeFakePi>, jobId: string): Promise<void> {
  await pi.commands.get("subagents")!.handler(`cancel ${jobId}`, fakeCommandCtx());
  await waitUntil(() => pi.sentMessages.length > 0);
}

test("wiring: end-to-end — a real job's stream phases, tools, and usage reach the widget and /subagents status", async () => {
  const pi = makeFakePi();
  const { session, emit, listeners } = hangingStreamingSession();
  const modelRuntime = { isUsingSubscription: () => false, getModel: () => undefined } as unknown as ModelRuntime;
  const createSession = async () => ({ session } as any);
  await extensionFactory(pi as unknown as ExtensionAPI, () => Promise.resolve(modelRuntime), createSession);

  const widgetLines: Array<string[] | undefined> = [];
  const ctx = fakeExecuteCtx();
  (ctx.ui as any).setWidget = (_key: string, lines: string[] | undefined) => widgetLines.push(lines);

  const result = await pi.tool.execute("call-7", { agent: "scout", task: "think then act" }, undefined, undefined, ctx);
  const jobId = (result.details as { jobId: string }).jobId;

  // The run starts on a later microtask; wait until the nested session is
  // actually subscribed before driving its events.
  await waitUntil(() => listeners.length > 0);

  // Same dispatch order a real run produces: thinking delta, then a tool
  // executes (activity: read), then an assistant message settles with usage.
  emit([
    { type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_delta", delta: "hm", partial: {} } },
    { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } },
    { type: "message_end", message: { role: "assistant", provider: "anthropic", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.005 } } } },
  ]);

  // Widget shows the running job with the tool word (running tool wins).
  const liveWidget = widgetLines.at(-1);
  assert.ok(liveWidget);
  assert.match(liveWidget.find((l) => l.includes(jobId))!, /<dim>read<\/dim>/);

  // /subagents status reports the live extras the list view lacks.
  const statusCtx = fakeCommandCtx();
  await pi.commands.get("subagents")!.handler(`status ${jobId}`, statusCtx);
  const statusText = statusCtx.notifications.at(-1)!.message;
  assert.match(statusText, new RegExp(`^${jobId} running`));
  assert.match(statusText, /activity: read/);
  assert.match(statusText, /tool: read a\.ts/);
  assert.match(statusText, /usage: /);
  assert.match(statusText, /\$0\.005/);

  await settleRunningJob(pi, jobId);
});

test("wiring: end-to-end — no UI events yet, a just-launched job status shows waiting", async () => {
  const pi = makeFakePi();
  const { session } = hangingStreamingSession();
  const createSession = async () => ({ session } as any);
  await extensionFactory(pi as unknown as ExtensionAPI, undefined, createSession);

  const ctx = fakeExecuteCtx();
  const result = await pi.tool.execute("call-8", { agent: "scout", task: "x" }, undefined, undefined, ctx);
  const jobId = (result.details as { jobId: string }).jobId;

  const statusCtx = fakeCommandCtx();
  await pi.commands.get("subagents")!.handler(`status ${jobId}`, statusCtx);
  const statusText = statusCtx.notifications.at(-1)!.message;
  assert.match(statusText, new RegExp(`^${jobId} running`));
  assert.match(statusText, /activity: waiting/);

  await settleRunningJob(pi, jobId);
});

test("wiring: session_shutdown does not throw even with no jobs ever started", async () => {
  const pi = makeFakePi();
  await extensionFactory(pi as unknown as ExtensionAPI);

  const ctx = fakeCommandCtx();
  await assert.doesNotReject(() => Promise.resolve(pi.handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx)));
});

test("wiring: agent_before_settle resolves immediately when the context has a UI", async () => {
  const pi = makeFakePi();
  await extensionFactory(pi as unknown as ExtensionAPI);

  const ctx = fakeCommandCtx({ hasUI: true });
  await assert.doesNotReject(() =>
    Promise.resolve(pi.handlers.get("agent_before_settle")!({ type: "agent_before_settle" }, ctx)),
  );
});

// (wiring) deliverJobResult is the job registry's onSettled hook, pulled out
// to its own exported function precisely so this delivery wiring \u2014 build the
// completion message, hand it to pi.sendMessage with the right options \u2014 is
// testable without a real job ever running and settling.
function settledJobOf(overrides: Partial<SettledJob> = {}): SettledJob {
  const base: JobSnapshot = {
    id: "S1001",
    runId: "call-1",
    startedAt: 1000,
    task: { agent: "scout", task: "x" },
    progress: { agent: "scout", runningTools: [], history: [], done: true },
    state: { status: "completed", settledAt: 2000, result: { agent: "scout", task: "x", durationMs: 1, status: "success", finalText: "done" } },
  };
  return { ...base, ...overrides } as SettledJob;
}

test("deliverJobResult: completed job calls pi.sendMessage once with the built message and followUp options", () => {
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const fakePi = { sendMessage: (message: unknown, options?: unknown) => sent.push({ message, options }) };

  const job = settledJobOf({
    state: {
      status: "completed", settledAt: 2000,
      result: { agent: "scout", task: "x", durationMs: 1, status: "success", finalText: "done" },
    },
  });
  deliverJobResult(fakePi, job);

  assert.equal(sent.length, 1);
  const { message, options } = sent[0] as { message: { customType: string; details: { jobId: string } }; options: unknown };
  assert.equal(message.customType, "subagent-result");
  assert.equal(message.details.jobId, "S1001");
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
});

test("deliverJobResult: cancelled job delivers with triggerTurn:false", () => {
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const fakePi = { sendMessage: (message: unknown, options?: unknown) => sent.push({ message, options }) };

  const job = settledJobOf({
    state: {
      status: "cancelled", settledAt: 2000,
      result: { agent: "scout", task: "x", durationMs: 1, status: "error", error: "run was aborted" },
      reason: "user",
    },
  });
  deliverJobResult(fakePi, job);

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].options, { triggerTurn: false });
});

// (wiring) renderSubagentResultMessage: registered via pi.registerMessageRenderer,
// captured in makeFakePi()'s messageRenderers map. Exercises the Box+MouseRegion
// wrapping directly: render() produces the themed block, a simulated left click
// toggles its local expanded state independent of a parent rebuild.
test("wiring: the subagent-result message renderer renders a themed block and toggles on click", async () => {
  const pi = makeFakePi();
  await extensionFactory(pi as unknown as ExtensionAPI);

  const renderer = pi.messageRenderers.get("subagent-result")!;
  assert.ok(renderer);

  const message = {
    customType: "subagent-result",
    content: "Background subagent job S1001 finished \u2014 completed\n\nHello from scout",
    display: true as const,
    details: {
      jobId: "S1001", runId: "call-1", status: "completed",
      task: { agent: "scout", task: "x" },
      run: { agent: "scout", task: "x", durationMs: 1, status: "success" as const, finalText: "Hello from scout" },
      usage: undefined, isError: false,
    },
  };

  const collapsed = renderer(message as any, { expanded: false, outputPad: 1 }, fakeTheme as any);
  assert.ok(collapsed);
  const collapsedLines = (collapsed as any).render(80);
  assert.ok(Array.isArray(collapsedLines));
  assert.ok(!collapsedLines.join("\n").includes("Hello from scout"));

  const expanded = renderer(message as any, { expanded: true, outputPad: 1 }, fakeTheme as any);
  const expandedLines = (expanded as any).render(80);
  assert.ok(expandedLines.join("\n").includes("Hello from scout"));

  // Simulated left click toggles the freshly-constructed (collapsed) component
  // on its own, independent of any parent rebuild.
  const clickResult = (collapsed as any).handleMouse({
    type: "click", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 1,
    shift: false, alt: false, ctrl: false,
  });
  assert.equal(clickResult?.handled, true);
  const afterClick = (collapsed as any).render(80);
  assert.ok(afterClick.join("\n").includes("Hello from scout"));
});

// (wiring, end-to-end) These tests inject a fake AgentSession through the
// default export's test-only 3rd param (createSessionOverride), so a real
// job can launch and settle without any network/model call \u2014 the only way
// to exercise execute()'s actual happy path and the lifecycle handlers'
// observable effects on a real (if fake-backed) job, rather than a synthetic
// SettledJob built by hand.
async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("execute(): happy path returns the ack immediately, without waiting for the job; the job later delivers via pi.sendMessage", async () => {
  const pi = makeFakePi();
  const createSession = async () => ({ session: fakeAgentSession("hi from scout") as any });
  await extensionFactory(pi as unknown as ExtensionAPI, undefined, createSession);

  const ctx = fakeExecuteCtx();
  const result = await pi.tool.execute("call-1", { agent: "scout", task: "say hi" }, undefined, undefined, ctx);

  assert.equal(result.isError, false);
  assert.ok("jobId" in result.details);
  assert.match(result.content[0].text, /S\d+/);

  await waitUntil(() => pi.sentMessages.length > 0);
  const sent = pi.sentMessages[0] as { message: { details: { jobId: string; isError: boolean; run: unknown } }; options: unknown };
  assert.equal(sent.message.details.jobId, (result.details as { jobId: string }).jobId);
  assert.equal(sent.message.details.isError, false);
  assert.deepEqual(sent.options, { triggerTurn: true, deliverAs: "followUp" });
});

test("execute(): the launching tool call's own signal is not wired to the job \u2014 aborting it does not stop the job from completing (Q4)", async () => {
  const pi = makeFakePi();
  const createSession = async () => ({ session: fakeAgentSession("still here") as any });
  await extensionFactory(pi as unknown as ExtensionAPI, undefined, createSession);

  const controller = new AbortController();
  const ctx = fakeExecuteCtx();
  const result = await pi.tool.execute("call-2", { agent: "scout", task: "x" }, controller.signal, undefined, ctx);
  controller.abort(); // abort right after launch, as Esc would

  await waitUntil(() => pi.sentMessages.length > 0);
  const sent = pi.sentMessages[0] as { message: { details: { jobId: string; status: string } } };
  assert.equal(sent.message.details.jobId, (result.details as { jobId: string }).jobId);
  assert.equal(sent.message.details.status, "completed"); // not "cancelled"
});

test("wiring: session_shutdown cancels running jobs, clears the widget, and suppresses further delivery", async () => {
  const pi = makeFakePi();
  let resolvePrompt!: () => void;
  const session = fakeAgentSession("never reached");
  session.prompt = () => new Promise<void>((resolve) => (resolvePrompt = resolve));
  const createSession = async () => ({ session: session as any });
  await extensionFactory(pi as unknown as ExtensionAPI, undefined, createSession);

  const widgetCalls: Array<string[] | undefined> = [];
  const ctx = fakeExecuteCtx({ hasUI: true });
  (ctx.ui as any).setWidget = (_key: string, lines: string[] | undefined) => widgetCalls.push(lines);

  // The fake session never fires a tool_execution_start event, so onChange
  // (and thus the widget) never sees the job before it settles — real
  // subagents call a tool almost immediately, which is what actually drives
  // the widget's first paint in production. This test only needs
  // dispose()'s own unconditional setWidget(..., undefined) clear.
  await pi.tool.execute("call-3", { agent: "scout", task: "x" }, undefined, undefined, ctx);
  await waitUntil(() => resolvePrompt !== undefined); // let the chain actually reach prompt()

  await pi.handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
  assert.ok(widgetCalls.length > 0);
  assert.equal(widgetCalls.at(-1), undefined); // cleared, unconditionally, by widget.dispose()

  const sentBefore = pi.sentMessages.length;
  resolvePrompt(); // the run "finishes" only now, after shutdown
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pi.sentMessages.length, sentBefore); // shutdown suppressed delivery

  const listCtx = fakeExecuteCtx();
  await pi.commands.get("subagents")!.handler("", listCtx);
  assert.match(listCtx.notifications.at(-1)!.message, /cancelled/);
});

test("wiring: agent_settled cancels still-running jobs when the session has no UI (headless safety net)", async () => {
  const pi = makeFakePi();
  const session = fakeAgentSession("never reached");
  session.prompt = () => new Promise<void>(() => {}); // never resolves on its own
  const createSession = async () => ({ session: session as any });
  await extensionFactory(pi as unknown as ExtensionAPI, undefined, createSession);

  const ctx = fakeExecuteCtx({ hasUI: false });
  await pi.tool.execute("call-4", { agent: "scout", task: "x" }, undefined, undefined, ctx);

  await pi.handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
  await waitUntil(() => pi.sentMessages.length > 0);
  const sent = pi.sentMessages.at(-1) as { message: { details: { status: string } } };
  assert.equal(sent.message.details.status, "cancelled");
});

test("wiring: agent_before_settle with no UI waits for a running job to finish before resolving", async () => {
  const pi = makeFakePi();
  let resolvePrompt!: () => void;
  const session = fakeAgentSession("headless result");
  session.prompt = () => new Promise<void>((resolve) => (resolvePrompt = resolve));
  const createSession = async () => ({ session: session as any });
  await extensionFactory(pi as unknown as ExtensionAPI, undefined, createSession);

  const ctx = fakeExecuteCtx({ hasUI: false });
  await pi.tool.execute("call-5", { agent: "scout", task: "x" }, undefined, undefined, ctx);
  await waitUntil(() => resolvePrompt !== undefined); // let the chain actually reach prompt()

  let settledBarrier = false;
  const barrierPromise = Promise.resolve(
    pi.handlers.get("agent_before_settle")!({ type: "agent_before_settle" }, ctx),
  ).then(() => (settledBarrier = true));

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settledBarrier, false); // still waiting on the running job

  resolvePrompt();
  await barrierPromise;
  assert.equal(settledBarrier, true);
});

test("wiring: /subagents cancel on a real running job, then /subagents clear, through the command handler", async () => {
  const pi = makeFakePi();
  const session = fakeAgentSession("never reached");
  session.prompt = () => new Promise<void>(() => {});
  const createSession = async () => ({ session: session as any });
  await extensionFactory(pi as unknown as ExtensionAPI, undefined, createSession);

  const ctx = fakeExecuteCtx();
  const result = await pi.tool.execute("call-6", { agent: "scout", task: "x" }, undefined, undefined, ctx);
  const jobId = (result.details as { jobId: string }).jobId;

  await pi.commands.get("subagents")!.handler(`cancel ${jobId}`, ctx);
  assert.match(ctx.notifications.at(-1)!.message, new RegExp(`Cancelling job ${jobId}`));

  await waitUntil(() => pi.sentMessages.length > 0);

  await pi.commands.get("subagents")!.handler("clear", ctx);
  assert.match(ctx.notifications.at(-1)!.message, /Cleared 1 finished job/);

  const afterClearCtx = fakeExecuteCtx();
  await pi.commands.get("subagents")!.handler("", afterClearCtx);
  assert.doesNotMatch(afterClearCtx.notifications.at(-1)!.message, new RegExp(jobId));
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
  const tracker = createProgressTracker("scout", () => {});
  const doneSpy = t.mock.method(tracker, "markTaskDone");

  await assert.rejects(
    () =>
      runSingleTask({ agent: "scout", task: "do it" }, agent, tracker, {
        cwd: process.cwd(),
        signal: undefined,
        modelRuntime: {} as unknown as ModelRuntime,
        callerSessionFile: undefined,
        runId: "call-1",
        mode: "tui" as const,
      }),
    /reload failed/,
  );

  assert.equal(doneSpy.mock.callCount(), 1);
  // markTaskDone treats an explicit `undefined` usage the same as an omitted
  // one, so only the absence of usage matters here — not whether the
  // argument was passed at all.
  const [usage] = doneSpy.mock.calls[0].arguments;
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
  const tracker = createProgressTracker("scout", () => {});
  const doneSpy = t.mock.method(tracker, "markTaskDone");
  const fakeModelRuntime = {
    getModel: () => { throw new Error("stop before session creation"); },
  } as unknown as ModelRuntime;

  await runSingleTask({ agent: "scout", task: "do it" }, agent, tracker, {
    cwd: process.cwd(),
    signal: undefined,
    modelRuntime: fakeModelRuntime,
    callerSessionFile: undefined,
    runId: "call-2",
    mode: "tui" as const,
  });

  assert.equal(doneSpy.mock.callCount(), 1);
  const [usage] = doneSpy.mock.calls[0].arguments;
  assert.deepEqual(usage, {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
    isSubscription: false, context: undefined,
  });
});

// Mutation-tested against the reviewer's finding: deleting `mode,` at the
// runAgentViaSdk() call site inside runSingleTask (src/run.ts consumer) used
// to leave the whole ctx.mode -> RunTaskOptions -> runSingleTask ->
// RunAgentViaSdkOptions threading unverified end-to-end — tsc catches an
// omission (mode is required on RunTaskOptions), but not a wrong constant.
// This test exercises the real threading through an injected createSession,
// asserting the mode that actually reaches bindExtensions.
test("runSingleTask: forwards options.mode through to the nested session's bindExtensions call", async () => {
  const agent = makeAgent({
    tools: ["read"],
  } as Partial<AgentConfig>);
  const capturedTools = [{ sourceInfo: { origin: "package" as const, source: "some-extension-package" } }];
  let capturedBindings: unknown;

  const fakeSession = {
    getAllTools: () => capturedTools,
    bindExtensions: async (bindings: unknown) => { capturedBindings = bindings; },
    extensionRunner: { hasHandlers: () => false, emit: async () => {} },
    subscribe: () => () => {},
    prompt: async () => {},
    getLastAssistantText: () => "done",
    getContextUsage: () => undefined,
    dispose: () => {},
    abort: () => {},
  };
  const createSession = async () => ({ session: fakeSession as any });
  const modelRuntime = { isUsingSubscription: () => false } as unknown as ModelRuntime;

  await runSingleTask({ agent: "scout", task: "do it" }, agent, undefined, {
    cwd: process.cwd(),
    signal: undefined,
    modelRuntime,
    callerSessionFile: undefined,
    runId: "call-3",
    mode: "rpc",
    createSession,
  });

  assert.deepEqual(capturedBindings, { mode: "rpc" });
});

// Exercises the P3 wiring end-to-end with the real session-manager factory
// (no fakes on that path): a subagent run with a persisted caller session
// must land its own session file at the conventional
// <parent-without-ext>/<runId>/run-<index>/session.jsonl path, so usage
// dashboards that reconcile nested sessions by that convention can attribute
// the run's cost and model to it.
test("runSingleTask: persists its session at the conventional childSessionDir path derived from runId and index", async () => {
  const tmpCwd = makeTmpDir();
  try {
    const callerSessionFile = path.join(tmpCwd, "sessions", "parent.jsonl");
    fs.mkdirSync(path.dirname(callerSessionFile), { recursive: true });

    const agent = makeAgent();
    const fakeSession = {
      getAllTools: () => [],
      bindExtensions: async () => {},
      extensionRunner: { hasHandlers: () => false, emit: async () => {} },
      subscribe: () => () => {},
      prompt: async () => {},
      getLastAssistantText: () => "done",
      getContextUsage: () => undefined,
      dispose: () => {},
      abort: () => {},
    };
    const createSession = async () => ({ session: fakeSession as any });
    const modelRuntime = { isUsingSubscription: () => false } as unknown as ModelRuntime;

    const result = await runSingleTask({ agent: "scout", task: "do it" }, agent, undefined, {
      cwd: tmpCwd,
      signal: undefined,
      modelRuntime,
      callerSessionFile,
      runId: "call-xyz",
      mode: "rpc",
      createSession,
    });

    const expectedDir = childSessionDir(callerSessionFile, "call-xyz", 0)!; // RUN_INDEX is always 0 now
    assert.equal(result.sessionFile, path.join(expectedDir, "session.jsonl"));
  } finally {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
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

  await runSingleTask({ agent: "scout", task: "do it" }, agent, undefined, {
    cwd: process.cwd(),
    signal: undefined,
    modelRuntime: fakeModelRuntime,
    callerSessionFile: undefined,
    runId: "call-4",
    mode: "tui" as const,
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
