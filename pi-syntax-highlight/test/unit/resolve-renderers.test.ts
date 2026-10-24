import { test } from "node:test";
import assert from "node:assert/strict";
import { Text, imageFallback, setCapabilityOverrides, type Component } from "@earendil-works/pi-tui";
import type { ThemeBg, ThemeColor, ToolRenderers, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { resolveToolRenderers } from "../../src/resolve-renderers.ts";

// Only the slots are under test, so the components themselves are opaque.
function baseRenderers(renderShell: ToolRenderers["renderShell"] = "default"): ToolRenderers {
  return {
    renderShell,
    renderCall: () => new Text("base call", 0, 0),
    renderResult: () => new Text("base result", 0, 0),
  };
}

// A tool that brings no result renderer of its own: the case the generic
// overlay exists for.
function baseRenderersWithoutResult(renderShell: ToolRenderers["renderShell"] = "default"): ToolRenderers {
  return {
    renderShell,
    renderCall: () => new Text("base call", 0, 0),
  };
}

type ResultRenderer = NonNullable<ToolRenderers["renderResult"]>;
type HostResult = Parameters<ResultRenderer>[0];
type HostContext = Parameters<ResultRenderer>[3];
type HostTheme = Parameters<ResultRenderer>[2];

// The delegation path never reads a color, so the two members this package uses
// stand in for the host's richer `Theme`.
const fakeTheme = {
  fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
  bg: (color: ThemeBg, text: string) => `<bg:${color}>${text}</bg:${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
} as HostTheme;

function shellResult(text: string): HostResult {
  return { content: [{ type: "text", text }], details: undefined };
}

// The host's `ToolRenderContext` is not exported, so the fake is
// typed from the renderer signature and carries every field the renderers read.
function hostContext(overrides: Partial<HostContext> = {}): HostContext {
  return {
    args: {},
    toolCallId: "call-1",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: "/tmp",
    executionStarted: true,
    argsComplete: true,
    isPartial: true,
    expanded: false,
    showImages: false,
    isError: false,
    durationMs: undefined,
    outputPad: 0,
    ...overrides,
  };
}

function firstLine(component: Component | undefined): string | undefined {
  return component?.render(40)[0]?.trimEnd();
}

function renderedLines(component: Component | undefined): string[] {
  return (component?.render(40) ?? []).map((line) => line.trimEnd());
}

test("resolveToolRenderers: grep, find, ls, bash and powershell replace renderResult and keep the other slots", () => {
  for (const toolName of ["grep", "find", "ls", "bash", "powershell"]) {
    const base = baseRenderers();
    const resolved = resolveToolRenderers(toolName, () => base);
    assert.notEqual(resolved, base);
    assert.equal(resolved?.renderCall, base.renderCall);
    assert.equal(resolved?.renderShell, base.renderShell);
    assert.notEqual(resolved?.renderResult, base.renderResult);
    assert.equal(typeof resolved?.renderResult, "function");
  }
});

test("resolveToolRenderers: a tool that brings its own renderResult keeps every slot", () => {
  const base = baseRenderers();
  for (const toolName of ["read", "write", "edit", "mcp__docs__search", "some_unknown_tool"]) {
    const resolved = resolveToolRenderers(toolName, () => base);
    assert.notEqual(resolved, base);
    assert.equal(resolved?.renderCall, base.renderCall);
    assert.equal(resolved?.renderResult, base.renderResult);
    assert.equal(resolved?.renderShell, base.renderShell);
  }
});

test("resolveToolRenderers: an unknown tool without a renderResult gains only the generic overlay", () => {
  for (const toolName of ["mcp__docs__search", "codemode"]) {
    const base = baseRenderersWithoutResult();
    const resolved = resolveToolRenderers(toolName, () => base);
    assert.notEqual(resolved, base);
    assert.equal(resolved?.renderCall, base.renderCall);
    assert.equal(resolved?.renderShell, base.renderShell);
    assert.equal(typeof resolved?.renderResult, "function");
  }
});

test("resolveToolRenderers: the generic overlay renders the result body", () => {
  const resolved = resolveToolRenderers("codemode", () => baseRenderersWithoutResult());
  const component = resolved?.renderResult?.(
    shellResult("plain output"),
    { expanded: false, isPartial: false },
    fakeTheme,
    hostContext({ isPartial: false }),
  );
  // `wrapResultRenderer` falls back to the unstyled body when the module-global
  // theme is not initialized, which is the case outside a pi session, so the
  // assertion is on the output rather than on the exact prefix.
  assert.match(renderedLines(component).join("\n"), /plain output/);
});

test("resolveToolRenderers: renderShell \"self\" survives the spread", () => {
  const resolved = resolveToolRenderers("edit", () => baseRenderers("self"));
  assert.equal(resolved?.renderShell, "self");
});

test("resolveToolRenderers: next() is called exactly once", () => {
  let calls = 0;
  resolveToolRenderers("grep", () => {
    calls += 1;
    return baseRenderers();
  });
  assert.equal(calls, 1);
});

test("resolveToolRenderers: a base of undefined yields an object instead of ending the chain", () => {
  for (const toolName of ["grep", "find", "ls", "bash", "powershell"]) {
    const styled = resolveToolRenderers(toolName, () => undefined);
    assert.notEqual(styled, undefined);
    assert.equal(styled?.renderCall, undefined);
    assert.equal(typeof styled?.renderResult, "function");
  }

  // The generic overlay applies to any name the host resolves, so an unknown
  // tool with no base at all still comes back renderable instead of `undefined`.
  const other = resolveToolRenderers("some_unknown_tool", () => undefined);
  assert.notEqual(other, undefined);
  assert.equal(other?.renderCall, undefined);
  assert.equal(other?.renderShell, undefined);
  assert.equal(typeof other?.renderResult, "function");
});

test("resolveToolRenderers: a partial shell result delegates to the built-in renderResult", () => {
  for (const toolName of ["bash", "powershell"]) {
    const seen: ToolRenderResultOptions[] = [];
    const base: ToolRenderers = {
      ...baseRenderers(),
      renderResult: (_result, options) => {
        seen.push(options);
        return new Text("built-in partial", 0, 0);
      },
    };
    const resolved = resolveToolRenderers(toolName, () => base);
    const component = resolved?.renderResult?.(
      shellResult("streaming output"),
      { expanded: false, isPartial: true },
      fakeTheme,
      hostContext(),
    );
    assert.equal(firstLine(component), "built-in partial");
    assert.deepEqual(seen, [{ expanded: false, isPartial: true }]);
  }
});

test("resolveToolRenderers: a final shell result stops the pending interval and stamps the end time", () => {
  const cleared: unknown[] = [];
  const realClearInterval = globalThis.clearInterval;
  // The renderer resolves `clearInterval` from the global object at call time, so
  // replacing it here is what makes the cancellation observable.
  Object.assign(globalThis, {
    clearInterval: (handle: ReturnType<typeof setInterval>) => {
      cleared.push(handle);
    },
  });
  try {
    // A plain object stands in for the host's `Timeout`: only `clearInterval`
    // ever reads it, and that is the function replaced above.
    const interval = { unref: () => {} };
    const state: Record<string, unknown> = { startedAt: Date.now() - 5000, interval };
    const resolved = resolveToolRenderers("bash", () => baseRenderers());
    resolved?.renderResult?.(
      shellResult("done"),
      { expanded: false, isPartial: false },
      fakeTheme,
      hostContext({ isPartial: false, durationMs: 4150, state }),
    );
    assert.deepEqual(cleared, [interval]);
    assert.equal(Object.hasOwn(state, "interval"), false);
    assert.equal(typeof state.endedAt, "number");
  } finally {
    Object.assign(globalThis, { clearInterval: realClearInterval });
  }
});

test("resolveToolRenderers: an unrecorded duration falls back to the row's own clock", () => {
  const state: Record<string, unknown> = { startedAt: Date.now() - 1500 };
  const resolved = resolveToolRenderers("bash", () => baseRenderers());
  const component = resolved?.renderResult?.(
    shellResult("done"),
    { expanded: false, isPartial: false },
    fakeTheme,
    hostContext({ isPartial: false, durationMs: undefined, state }),
  );
  // The timer is the last child of the component tree, after body and warnings.
  assert.match(renderedLines(component).join("\n"), /<muted>Took \d+\.\ds<\/muted>/);
});

test("resolveToolRenderers: the image fallback follows context.showImages", () => {
  // Both directions are only observable when the terminal can show images, so
  // the capability is pinned for the duration of the test.
  setCapabilityOverrides({ images: "kitty" });
  try {
    const result: HostResult = {
      content: [
        { type: "text", text: "a screenshot" },
        { type: "image", data: "not-an-image", mimeType: "image/png" },
      ],
      details: undefined,
    };
    const render = (showImages: boolean): string => {
      const resolved = resolveToolRenderers("codemode", () => baseRenderersWithoutResult());
      const component = resolved?.renderResult?.(
        result,
        { expanded: false, isPartial: false },
        fakeTheme,
        hostContext({ isPartial: false, showImages }),
      );
      return renderedLines(component).join("\n");
    };
    // The exact wording belongs to the package; comparing against its own
    // formatter keeps this test from pinning a format the host may change.
    assert.equal(render(true).includes(imageFallback("image/png")), false);
    assert.equal(render(false).includes(imageFallback("image/png")), true);
  } finally {
    setCapabilityOverrides({});
  }
});
