import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  initTheme,
  keyHint,
  keyText,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, imageFallback, setCapabilityOverrides, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
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

// The resolver only overlays a slot that is the host's own renderer, so the
// overlay cases start from the stock definitions.
const STOCK_DEFINITIONS: Record<string, (cwd: string) => unknown> = {
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
  read: createReadToolDefinition,
  write: createWriteToolDefinition,
  edit: createEditToolDefinition,
  bash: createBashToolDefinition,
  powershell: createPowerShellToolDefinition,
};

function stockFor(toolName: string): ToolRenderers {
  return STOCK_DEFINITIONS[toolName]!(process.cwd()) as ToolRenderers;
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
    keyText: () => "",
    keyHint: (_keybinding, description) => description,
    ...overrides,
  };
}

function firstLine(component: Component | undefined): string | undefined {
  return component?.render(40)[0]?.trimEnd();
}

// Wide enough that the fake theme's own markup (which counts as visible text) does
// not push a line into a wrap: these tests assert content, not layout, and the
// components under test are `Text`, so a narrow width would split assertions.
const RENDER_WIDTH = 200;

function renderedLines(component: Component | undefined): string[] {
  return (component?.render(RENDER_WIDTH) ?? []).map((line) => line.trimEnd());
}

test("resolveToolRenderers: grep, find, ls, bash and powershell replace renderResult and keep the other slots", () => {
  for (const toolName of ["grep", "find", "ls", "bash", "powershell"]) {
    const base = stockFor(toolName);
    const resolved = resolveToolRenderers(toolName, () => base);
    assert.notEqual(resolved, base);
    assert.equal(resolved?.renderCall, base.renderCall);
    assert.equal(resolved?.renderShell, base.renderShell);
    assert.notEqual(resolved?.renderResult, base.renderResult);
    assert.equal(typeof resolved?.renderResult, "function");
  }
});

test("resolveToolRenderers: a tool with a foreign renderResult comes back as the same object", () => {
  const base = baseRenderers();
  for (const toolName of ["mcp__docs__search", "some_unknown_tool", "grep", "bash", "read", "edit"]) {
    assert.equal(resolveToolRenderers(toolName, () => base), base);
  }
});

test("resolveToolRenderers: read and edit replace the result slot and keep the base chain", () => {
  for (const toolName of ["read", "edit"]) {
    const base = stockFor(toolName);
    const resolved = resolveToolRenderers(toolName, () => base);
    assert.notEqual(resolved, base);
    assert.equal(resolved?.renderShell, base.renderShell);
    assert.notEqual(resolved?.renderResult, base.renderResult);
    assert.equal(typeof resolved?.renderResult, "function");
  }
});

test("resolveToolRenderers: read and edit keep the built-in header", () => {
  for (const toolName of ["read", "edit"]) {
    const base = stockFor(toolName);
    assert.equal(resolveToolRenderers(toolName, () => base)?.renderCall, base.renderCall);
  }
});

test("resolveToolRenderers: write comes back as the stock slots untouched", () => {
  const base = createWriteToolDefinition(process.cwd()) as unknown as ToolRenderers;
  assert.equal(resolveToolRenderers("write", () => base), base);
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

test("resolveToolRenderers: find and ls paint the body flat when the context reports the error", () => {
  const cases = [
    { toolName: "find", line: "src/a.ts" },
    { toolName: "ls", line: "src/" },
  ];
  for (const { toolName, line } of cases) {
    const resolved = resolveToolRenderers(toolName, () => stockFor(toolName));
    const render = (isError: boolean): string =>
      renderedLines(
        resolved?.renderResult?.(
          shellResult(line),
          { expanded: false, isPartial: false },
          fakeTheme,
          hostContext({ isPartial: false, isError }),
        ),
      ).join("\n");
    // The failure is painted flat in the content color: no bold, no file-family
    // color, which is the rule both list renderers share.
    assert.equal(render(true), `\n<toolOutput>${line}</toolOutput>`);
    assert.notEqual(render(false), `\n<toolOutput>${line}</toolOutput>`);
  }
});

test("resolveToolRenderers: the generic overlay takes the failure from the context, not from the result", () => {
  const resolved = resolveToolRenderers("codemode", () => baseRenderersWithoutResult());
  const diff = "diff --git a/x.ts b/x.ts\n+const b = 2;";
  const render = (result: HostResult, isError: boolean): string =>
    renderedLines(
      resolved?.renderResult?.(
        result,
        { expanded: false, isPartial: false },
        fakeTheme,
        hostContext({ isPartial: false, isError }),
      ),
    ).join("\n");
  // A diff body painted by kind would pass for a normal result, which is the case
  // the flat rule exists for.
  const failed = render(shellResult(diff), true);
  const painted = render(shellResult(diff), false);
  assert.match(failed, /<toolOutput>\+const b = 2;<\/toolOutput>/);
  assert.equal(failed.includes("<toolDiffAdded>"), false);
  assert.equal(painted.includes("<toolDiffAdded>"), true);
  // The result the TUI hands to a renderer carries no `isError`; a copy that does
  // is not read, because the context is the only source.
  const flagged = Object.assign(shellResult(diff), { isError: true });
  assert.equal(render(flagged, false), painted);
});

test("resolveToolRenderers: renderShell \"self\" survives the spread", () => {
  const resolved = resolveToolRenderers("edit", () => ({ ...stockFor("edit"), renderShell: "self" }));
  assert.equal(resolved?.renderShell, "self");
});

test("resolveToolRenderers: next() is called exactly once", () => {
  let calls = 0;
  resolveToolRenderers("grep", () => {
    calls += 1;
    return stockFor("grep");
  });
  assert.equal(calls, 1);
});

test("resolveToolRenderers: a base of undefined passes through as undefined", () => {
  for (const toolName of ["grep", "find", "ls", "bash", "powershell", "read", "some_unknown_tool"]) {
    assert.equal(resolveToolRenderers(toolName, () => undefined), undefined);
  }
});

// Real theme and key hints: the stock renderers read them from the host's globals,
// so both sides must paint with the same ones.
const HOST_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

// The rest of the file renders against the fake theme with the host's global left
// as it was, so the real theme is only installed for the duration of one test.
function withHostTheme(run: (theme: Theme) => void): void {
  const holder = globalThis as unknown as Record<symbol, Theme | undefined>;
  const previous = holder[HOST_THEME_KEY];
  initTheme("system");
  try {
    run(holder[HOST_THEME_KEY]!);
  } finally {
    holder[HOST_THEME_KEY] = previous;
  }
}

test("resolveToolRenderers: a partial shell result is rendered by the built-in renderResult", () => {
  withHostTheme((theme) => {
    for (const toolName of ["bash", "powershell"]) {
      const base = stockFor(toolName);
      const render = (renderers: ToolRenderers): string[] => {
        const state: Record<string, unknown> = { startedAt: 1000 };
        const component = renderers.renderResult?.(
          shellResult("streaming output"),
          { expanded: false, isPartial: true },
          theme,
          hostContext({ state }),
        );
        clearInterval(state.interval as ReturnType<typeof setInterval>);
        return renderedLines(component);
      };
      assert.deepEqual(render(resolveToolRenderers(toolName, () => base)!), render(base));
    }
  });
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
    const resolved = resolveToolRenderers("bash", () => stockFor("bash"));
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
  const resolved = resolveToolRenderers("bash", () => stockFor("bash"));
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

// The read and edit tools carry their own details; the renderers are the only
// consumers of each shape.
function readResult(text: string, details?: unknown): HostResult {
  return { content: [{ type: "text", text }], details };
}

function editResult(diff: string): HostResult {
  return { content: [{ type: "text", text: "" }], details: { diff } };
}

test("resolveToolRenderers: an expanded read highlights the body with no gutter", () => {
  const resolved = resolveToolRenderers("read", () => stockFor("read"));
  const text = renderedLines(
    resolved?.renderResult?.(
      readResult("const a = 1;\nconst b = 2;"),
      { expanded: true, isPartial: false },
      fakeTheme,
      hostContext({ isPartial: false, args: { path: "a.ts" } }),
    ),
  ).join("\n");
  assert.match(text, /const a = 1;/);
  assert.equal(text.includes("<syntaxNumber>1</syntaxNumber>"), false);
  assert.equal(text.includes(" |"), false);
});

test("resolveToolRenderers: a collapsed read with no failure renders no rows", () => {
  const resolved = resolveToolRenderers("read", () => stockFor("read"));
  const component = resolved?.renderResult?.(
    readResult("const a = 1;"),
    { expanded: false, isPartial: false },
    fakeTheme,
    hostContext({ isPartial: false, args: { path: "a.ts" } }),
  );
  assert.deepEqual(component?.render(40), []);
});

test("resolveToolRenderers: a read failure is painted flat even when collapsed", () => {
  const resolved = resolveToolRenderers("read", () => stockFor("read"));
  const component = resolved?.renderResult?.(
    readResult("denied"),
    { expanded: false, isPartial: false },
    fakeTheme,
    hostContext({ isPartial: false, args: { path: "a.ts" }, isError: true }),
  );
  const text = renderedLines(component).join("\n");
  assert.match(text, /<toolOutput>denied<\/toolOutput>/);
  assert.equal(text.includes("<syntaxNumber>"), false);
});

// Stock `renderCall` of edit must leave its box in the state with the header as
// the first child: the replacement of the diff depends on it.
test("contract: stock edit renderCall leaves a usable state.callComponent with the header first", () => {
  withHostTheme((theme) => {
    const stock = stockFor("edit");
    const state: Record<string, unknown> = {};
    const args = { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] };
    stock.renderCall!(args as never, theme, stockContext({ args, state, isPartial: true }));
    const box = state.callComponent as Box | undefined;
    assert.ok(box instanceof Box, "state.callComponent is no longer a Box");
    assert.ok(box.children.length >= 1, "the box has no header child");
    assert.match(stripTerminalSequences(box.children[0].render(80).join("")), /edit\s+a\.ts/);
  });
});

test("resolveToolRenderers: edit replaces the stock diff in the box and keeps the header", () => {
  withHostTheme((theme) => {
    const stock = stockFor("edit");
    const ours = resolveToolRenderers("edit", () => stock)!;
    const args = { path: "a.ts", edits: [{ oldText: "const b = 2;", newText: "const b = 3;" }] };
    const diff = " 1 const a = 1;\n-2 const b = 2;\n+2 const b = 3;";
    const state: Record<string, unknown> = {};
    ours.renderCall!(args as never, theme, stockContext({ args, state, isPartial: true }));
    const box = state.callComponent as Box;
    const component = ours.renderResult!(
      { content: [{ type: "text", text: "ok" }], details: { diff } },
      { expanded: false, isPartial: false },
      theme,
      stockContext({ args, state }),
    );
    assert.deepEqual(component.render(80), []);
    assert.equal(box.children.length, 3);
    const rendered = stripTerminalSequences(box.render(80).join("\n"));
    assert.match(rendered, /edit\s+a\.ts/);
    assert.match(rendered, /-2 const b = 2;/);
    assert.match(rendered, /\+2 const b = 3;/);
  });
});

test("resolveToolRenderers: edit without a box replaces the body of the container stock returned", () => {
  withHostTheme((theme) => {
    const stock = stockFor("edit");
    const ours = resolveToolRenderers("edit", () => stock)!;
    const diff = "-1 const a = 1;\n+1 const a = 2;";
    const component = ours.renderResult!(
      { content: [{ type: "text", text: "ok" }], details: { diff } },
      { expanded: false, isPartial: false },
      theme,
      stockContext({ args: { path: "a.ts" }, outputPad: 2 }),
    );
    assert.equal(component instanceof Container, true);
    const lines = (component as Container).render(80).map(stripTerminalSequences);
    assert.equal(lines.length, 3);
    assert.match(lines[1], /^ {2}-1 const a = 1;/);
  });
});

test("resolveToolRenderers: an edit failure and an edit without a diff return what stock returned", () => {
  withHostTheme((theme) => {
    const real = stockFor("edit");
    const ours = resolveToolRenderers("edit", () => real)!;
    const render = (renderers: ToolRenderers, result: HostResult, isError: boolean): string[] =>
      renderers.renderResult!(
        result,
        { expanded: false, isPartial: false },
        theme,
        stockContext({ args: { path: "a.ts" }, isError }),
      ).render(80);
    const failure = readResult("Could not find the text");
    assert.deepEqual(render(ours, failure, true), render(real, failure, true));
    const noDiff = readResult("ok", {});
    assert.deepEqual(render(ours, noDiff, false), render(real, noDiff, false));
  });
});

test("resolveToolRenderers: the stock fallback gets lastComponent undefined", () => {
  withHostTheme((theme) => {
    const ours = resolveToolRenderers("grep", () => stockFor("grep"))!;
    const previous = new Text("previous", 0, 0);
    const component = ours.renderResult!(
      detailsThrowingOnce("src/a.ts:1: x"),
      { expanded: false, isPartial: false },
      theme,
      stockContext({ lastComponent: previous }),
    );
    // Stock reuses the slot it is given, so a different object proves a fresh one was passed.
    assert.notEqual(component, previous);
  });
});

// The sentinel proves the footer comes from the context's own `keyHint`, which is
// the copy of pi that owns the keybindings, and not from an import.
const sentinelKeyHint: HostContext["keyHint"] = (keybinding, description) => `[[${keybinding}|${description}]]`;

function renderResultWith(toolName: string, text: string, context: HostContext): string {
  const resolved = resolveToolRenderers(toolName, () => stockFor(toolName));
  return renderedLines(
    resolved?.renderResult?.(shellResult(text), { expanded: false, isPartial: false }, fakeTheme, context),
  ).join("\n");
}

test("resolveToolRenderers: the expand hint of every list footer comes from context.keyHint", () => {
  const lines = Array.from({ length: 30 }, (_, index) => `src/file${index}.ts`).join("\n");
  for (const toolName of ["find", "ls"]) {
    const rendered = renderResultWith(toolName, lines, hostContext({ isPartial: false, keyHint: sentinelKeyHint }));
    assert.match(rendered, /\[\[app\.tools\.expand\|to expand\]\]/);
  }
});

test("resolveToolRenderers: the collapsed shell preview takes its expand hint from context.keyHint", () => {
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
  const rendered = renderResultWith("bash", lines, hostContext({ isPartial: false, keyHint: sentinelKeyHint }));
  assert.match(rendered, /\[\[app\.tools\.expand\|to expand\]\]/);
});

test("resolveToolRenderers: a context without keyHint still shows the expand hint", () => {
  // `rawKeyHint` paints through the host's module-global theme, which only exists
  // after the host initializes it.
  Object.assign(globalThis, { [Symbol.for("@earendil-works/pi-coding-agent:theme")]: fakeTheme });
  const lines = Array.from({ length: 30 }, (_, index) => `src/file${index}.ts`).join("\n");
  const context = { ...hostContext({ isPartial: false }), keyHint: undefined } as unknown as HostContext;
  assert.match(renderResultWith("find", lines, context), /ctrl\+o.*to expand/);
});


function stockContext(overrides: Partial<HostContext> = {}): HostContext {
  return hostContext({ isPartial: false, durationMs: 1500, keyText, keyHint, outputPad: 1, ...overrides });
}

// The first read of `details` throws, which is the one thing our builder does
// inside its guarded region; the stock renderer reads it afterwards.
function detailsThrowingOnce(text: string): HostResult {
  let reads = 0;
  return {
    content: [{ type: "text", text }],
    get details() {
      reads += 1;
      if (reads === 1) throw new Error("boom");
      return undefined;
    },
  };
}

test("resolveToolRenderers: a throwing builder renders the stock output", () => {
  withHostTheme((theme) => {
    const lines = Array.from({ length: 30 }, (_, index) => `src/a.ts:${index + 1}: line ${index}`).join("\n");
    for (const toolName of ["grep", "bash"]) {
      const stock = stockFor(toolName);
      const ours = resolveToolRenderers(toolName, () => stock)!;
      const render = (renderers: ToolRenderers, result: HostResult): string[] =>
        (renderers.renderResult!(result, { expanded: false, isPartial: false }, theme, stockContext()) as Component).render(80);
      assert.deepEqual(render(ours, detailsThrowingOnce(lines)), render(stock, shellResult(lines)));
    }
  });
});

for (const toolName of ["bash", "powershell"]) {
  test(`contract: stock ${toolName} renderCall sets a numeric state.startedAt`, () => {
    withHostTheme((theme) => {
      const state: Record<string, unknown> = {};
      const args = { command: "ls" };
      stockFor(toolName).renderCall!(args as never, theme, stockContext({ args, state, isPartial: true, executionStarted: true }));
      assert.equal(typeof state.startedAt, "number");
    });
  });

  test(`contract: partial stock ${toolName} renderResult sets state.interval`, () => {
    withHostTheme((theme) => {
      const state: Record<string, unknown> = { startedAt: Date.now() };
      try {
        stockFor(toolName).renderResult!(shellResult("out"), { expanded: false, isPartial: true }, theme, stockContext({ state, isPartial: true }));
        assert.notEqual(state.interval, undefined);
      } finally {
        clearInterval(state.interval as ReturnType<typeof setInterval>);
      }
    });
  });

  test(`resolveToolRenderers: ${toolName} timer is frozen at endedAt - startedAt across later renders`, () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const state: Record<string, unknown> = { startedAt: now - 5000, endedAt: now - 1000 };
      const resolved = resolveToolRenderers(toolName, () => stockFor(toolName));
      const render = (): string =>
        renderedLines(
          resolved?.renderResult?.(
            shellResult("done"),
            { expanded: false, isPartial: false },
            fakeTheme,
            hostContext({ isPartial: false, durationMs: undefined, state }),
          ),
        ).join("\n");
      assert.match(render(), /<muted>Took 4\.0s<\/muted>/);
      now += 2000;
      assert.match(render(), /<muted>Took 4\.0s<\/muted>/);
    } finally {
      Date.now = realNow;
    }
  });
}
