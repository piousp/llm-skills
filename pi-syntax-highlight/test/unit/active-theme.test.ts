import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { activeTheme, captureTheme, resetActiveTheme } from "../../src/active-theme.ts";

// The module stores the reference and nothing else, so a bare object stands in
// for the host's `Theme`, which cannot be constructed outside a session.
function fakeTheme(label: string): Theme {
  return { label } as unknown as Theme;
}

test("activeTheme: no capture yet yields undefined", () => {
  resetActiveTheme();
  assert.equal(activeTheme(), undefined);
});

test("activeTheme: the captured theme comes back as the same reference", () => {
  resetActiveTheme();
  const theme = fakeTheme("dark");
  captureTheme(theme);
  assert.equal(activeTheme(), theme);
});

test("captureTheme: a second capture replaces the first", () => {
  resetActiveTheme();
  const first = fakeTheme("dark");
  const second = fakeTheme("light");
  captureTheme(first);
  captureTheme(second);
  assert.equal(activeTheme(), second);
});

test("resetActiveTheme: the capture is dropped", () => {
  resetActiveTheme();
  captureTheme(fakeTheme("dark"));
  resetActiveTheme();
  assert.equal(activeTheme(), undefined);
});
