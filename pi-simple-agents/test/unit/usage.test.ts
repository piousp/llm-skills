import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyUsage,
  applyUsageEvent,
  toRunUsage,
  formatTokens,
  formatRunUsage,
  type UsageAccumulator,
} from "../../src/usage.ts";

function assistantEnd(usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }, provider = "anthropic") {
  return {
    type: "message_end" as const,
    message: { role: "assistant", provider, usage: { ...usage, cost: { total: usage.cost } } },
  } as any;
}

function toolResultEnd(usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } | undefined) {
  return {
    type: "message_end" as const,
    message: { role: "toolResult", usage: usage ? { ...usage, cost: { total: usage.cost } } : undefined },
  } as any;
}

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

test("applyUsageEvent: message_end assistant adds its usage to the accumulator", () => {
  const acc = applyUsageEvent(emptyUsage(), assistantEnd({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 }));
  assert.deepEqual(acc, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, provider: "anthropic" });
});

test("applyUsageEvent: message_end toolResult with usage adds it", () => {
  const acc = applyUsageEvent(emptyUsage(), toolResultEnd({ input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }));
  assert.deepEqual(acc, { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, provider: undefined });
});

test("applyUsageEvent: message_end toolResult without usage is a no-op", () => {
  const initial = emptyUsage();
  const acc = applyUsageEvent(initial, toolResultEnd(undefined));
  assert.deepEqual(acc, initial);
});

test("applyUsageEvent: message_end user is a no-op", () => {
  const initial = emptyUsage();
  const event = { type: "message_end", message: { role: "user" } } as any;
  const acc = applyUsageEvent(initial, event);
  assert.deepEqual(acc, initial);
});

test("applyUsageEvent: message_start is ignored (no double counting)", () => {
  const initial = emptyUsage();
  const event = { type: "message_start", message: { role: "assistant", provider: "anthropic", usage: { ...ZERO, input: 99, cost: { total: 0 } } } } as any;
  const acc = applyUsageEvent(initial, event);
  assert.deepEqual(acc, initial);
});

test("applyUsageEvent: turn_end is ignored (re-emits the same message as message_end)", () => {
  const initial = emptyUsage();
  const event = { type: "turn_end", message: { role: "assistant", provider: "anthropic", usage: { ...ZERO, input: 99, cost: { total: 0 } } } } as any;
  const acc = applyUsageEvent(initial, event);
  assert.deepEqual(acc, initial);
});

test("applyUsageEvent: tool_execution_start/end are ignored", () => {
  const initial = emptyUsage();
  let acc = applyUsageEvent(initial, { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: {} } as any);
  acc = applyUsageEvent(acc, { type: "tool_execution_end", toolCallId: "a", toolName: "read", result: "x", isError: false } as any);
  assert.deepEqual(acc, initial);
});

test("applyUsageEvent: captures the provider of the last assistant message seen", () => {
  let acc = emptyUsage();
  acc = applyUsageEvent(acc, assistantEnd({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, "anthropic"));
  acc = applyUsageEvent(acc, assistantEnd({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, "openai"));
  assert.equal(acc.provider, "openai");
});

test("applyUsageEvent: does not mutate the accumulator passed in", () => {
  const initial = emptyUsage();
  applyUsageEvent(initial, assistantEnd({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }));
  assert.deepEqual(initial, emptyUsage());
});

test("toRunUsage: maps accumulator totals and context through", () => {
  const acc: UsageAccumulator = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.02, provider: "anthropic" };
  const run = toRunUsage(acc, { tokens: 100, contextWindow: 200000, percent: 0.05 }, () => true);
  assert.deepEqual(run, {
    input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.02,
    isSubscription: true,
    context: { percent: 0.05, window: 200000 },
  });
});

test("toRunUsage: context undefined stays undefined", () => {
  const acc: UsageAccumulator = { ...emptyUsage() };
  const run = toRunUsage(acc, undefined, () => false);
  assert.equal(run.context, undefined);
});

test("toRunUsage: percent null is preserved", () => {
  const acc: UsageAccumulator = { ...emptyUsage() };
  const run = toRunUsage(acc, { tokens: null, contextWindow: 200000, percent: null }, () => false);
  assert.deepEqual(run.context, { percent: null, window: 200000 });
});

test("toRunUsage: invokes the subscription predicate with the captured provider", () => {
  const acc: UsageAccumulator = { ...emptyUsage(), provider: "kimi-coding" };
  let seen: string | undefined;
  toRunUsage(acc, undefined, (p) => { seen = p; return false; });
  assert.equal(seen, "kimi-coding");
});

test("toRunUsage: no provider means the predicate is never invoked and isSubscription is false", () => {
  const acc: UsageAccumulator = { ...emptyUsage() };
  let called = false;
  const run = toRunUsage(acc, undefined, () => { called = true; return true; });
  assert.equal(called, false);
  assert.equal(run.isSubscription, false);
});

test("formatTokens: known boundary values", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(9999), "10.0k");
  assert.equal(formatTokens(10000), "10k");
  assert.equal(formatTokens(999999), "1000k");
  assert.equal(formatTokens(1_000_000), "1.0M");
  assert.equal(formatTokens(9_999_999), "10.0M");
  assert.equal(formatTokens(10_000_000), "10M");
});

test("formatRunUsage: full reference example with all fields", () => {
  const line = formatRunUsage({
    input: 12500, output: 840, cacheRead: 1_200_000, cacheWrite: 3000,
    cost: 0.4123, isSubscription: false,
    context: { percent: 12.34, window: 200000 },
  });
  assert.equal(line, "\u219113k \u2193840 R1.2M W3.0k CH98.7% $0.412 12.3%/200k");
});

test("formatRunUsage: subscription with unknown context percent", () => {
  const line = formatRunUsage({
    input: 100, output: 50, cacheRead: 0, cacheWrite: 0,
    cost: 0, isSubscription: true,
    context: { percent: null, window: 200000 },
  });
  assert.equal(line, "\u2191100 \u219350 $0.000 (sub) ?/200k");
});

test("formatRunUsage: all zero, no subscription, no context renders empty string", () => {
  const line = formatRunUsage({
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    cost: 0, isSubscription: false, context: undefined,
  });
  assert.equal(line, "");
});

test("formatRunUsage: CH hidden when there is no cache read/write", () => {
  const line = formatRunUsage({
    input: 100, output: 10, cacheRead: 0, cacheWrite: 0,
    cost: 0.01, isSubscription: false, context: undefined,
  });
  assert.equal(line, "\u2191100 \u219310 $0.010");
});

test("formatRunUsage: CH is shown for a cache-write-only run (no cache reads yet), $ hidden when cost is zero and not subscription", () => {
  const line = formatRunUsage({
    input: 0, output: 0, cacheRead: 0, cacheWrite: 5,
    cost: 0, isSubscription: false, context: undefined,
  });
  assert.equal(line, "W5 CH0.0%");
});
