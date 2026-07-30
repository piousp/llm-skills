import { test } from "node:test";
import assert from "node:assert/strict";
import { WARN_PREFIX, emitWarnings, toErrorMessage } from "../../src/warn.ts";

test("emitWarnings: N warnings call console.warn N times, each message starting with WARN_PREFIX", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});

  emitWarnings(["first issue", "second issue", "third issue"]);

  assert.equal(warnSpy.mock.calls.length, 3);
  assert.equal(warnSpy.mock.calls[0]!.arguments[0], WARN_PREFIX + "first issue");
  assert.equal(warnSpy.mock.calls[1]!.arguments[0], WARN_PREFIX + "second issue");
  assert.equal(warnSpy.mock.calls[2]!.arguments[0], WARN_PREFIX + "third issue");
});

test("emitWarnings: empty array does not call console.warn", (t) => {
  const warnSpy = t.mock.method(console, "warn", () => {});

  emitWarnings([]);

  assert.equal(warnSpy.mock.calls.length, 0);
});

test("toErrorMessage: an Error instance returns its message", () => {
  const error = new Error("boom");

  assert.equal(toErrorMessage(error), "boom");
});

test("toErrorMessage: a non-Error thrown value returns String(error)", () => {
  assert.equal(toErrorMessage("plain string"), "plain string");
  assert.equal(toErrorMessage(42), "42");
});
