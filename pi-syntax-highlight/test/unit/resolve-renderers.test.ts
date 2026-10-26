import { test } from "node:test";
import assert from "node:assert/strict";
import { Box, Container, Text, imageFallback, setCapabilityOverrides, type Component } from "@earendil-works/pi-tui";
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

// Wide enough that the fake theme's own markup (which counts as visible text) does
// not push a line into a wrap: these tests assert content, not layout, and the
// components under test are `Text`, so a narrow width would split assertions.
const RENDER_WIDTH = 200;

function renderedLines(component: Component | undefined): string[] {
  return (component?.render(RENDER_WIDTH) ?? []).map((line) => line.trimEnd());
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

test("resolveToolRenderers: a tool with no overlay keeps every slot", () => {
  const base = baseRenderers();
  for (const toolName of ["mcp__docs__search", "some_unknown_tool"]) {
    const resolved = resolveToolRenderers(toolName, () => base);
    assert.notEqual(resolved, base);
    assert.equal(resolved?.renderCall, base.renderCall);
    assert.equal(resolved?.renderResult, base.renderResult);
    assert.equal(resolved?.renderShell, base.renderShell);
  }
});

test("resolveToolRenderers: read, write and edit replace the result slot and keep the base chain", () => {
  for (const toolName of ["read", "write", "edit"]) {
    const base = baseRenderers();
    const resolved = resolveToolRenderers(toolName, () => base);
    assert.notEqual(resolved, base);
    assert.equal(resolved?.renderShell, base.renderShell);
    assert.notEqual(resolved?.renderResult, base.renderResult);
    assert.equal(typeof resolved?.renderResult, "function");
  }
});

test("resolveToolRenderers: read and write replace the header, edit keeps the built-in preview", () => {
  for (const toolName of ["read", "write"]) {
    const base = baseRenderers();
    const resolved = resolveToolRenderers(toolName, () => base);
    assert.notEqual(resolved?.renderCall, base.renderCall);
    assert.equal(typeof resolved?.renderCall, "function");
  }
  // The preview of edit comes from a helper the host does not export, so the
  // built-in `renderCall` stays in place and only its box body is replaced.
  const base = baseRenderers();
  assert.equal(resolveToolRenderers("edit", () => base)?.renderCall, base.renderCall);
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
    const resolved = resolveToolRenderers(toolName, () => baseRenderers());
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
    assert.equal(render(true), `\n<text>${line}</text>`);
    assert.notEqual(render(false), `\n<text>${line}</text>`);
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
  assert.match(failed, /<text>\+const b = 2;<\/text>/);
  assert.equal(failed.includes("<toolDiffAdded>"), false);
  assert.equal(painted.includes("<toolDiffAdded>"), true);
  // The result the TUI hands to a renderer carries no `isError`; a copy that does
  // is not read, because the context is the only source.
  const flagged = Object.assign(shellResult(diff), { isError: true });
  assert.equal(render(flagged, false), painted);
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

// The read and edit tools carry their own details; the renderers are the only
// consumers of each shape.
function readResult(text: string, details?: unknown): HostResult {
  return { content: [{ type: "text", text }], details };
}

function editResult(diff: string): HostResult {
  return { content: [{ type: "text", text: "" }], details: { diff } };
}

// The header paints the path through the link helper, which is only wrapped in
// OSC 8 when the terminal supports it, so the assertions look for the colored
// text instead of pinning the whole line.
function headerText(toolName: string, args: unknown): string {
  const resolved = resolveToolRenderers(toolName, () => baseRenderers());
  return renderedLines(resolved?.renderCall?.(args, fakeTheme, hostContext({ args }))).join("\n");
}

test("resolveToolRenderers: the read header names the tool and the path", () => {
  const header = headerText("read", { path: "src/a.ts" });
  assert.match(header, /<toolTitle><b>read<\/b><\/toolTitle>/);
  assert.match(header, /<accent>src\/a\.ts<\/accent>/);
});

test("resolveToolRenderers: the write header previews the content and reports an invalid argument", () => {
  const header = headerText("write", { path: "a.ts", content: "const a = 1;" });
  assert.match(header, /<b>write<\/b>/);
  assert.match(header, /const a = 1;/);
  const invalid = headerText("write", { path: "a.ts", content: 42 });
  assert.match(invalid, /\[invalid content arg - expected string\]/);
});

test("resolveToolRenderers: an expanded read numbers the body from the recorded offset", () => {
  const resolved = resolveToolRenderers("read", () => baseRenderers());
  const render = (args: unknown): string =>
    renderedLines(
      resolved?.renderResult?.(
        readResult("const a = 1;\nconst b = 2;"),
        { expanded: true, isPartial: false },
        fakeTheme,
        hostContext({ isPartial: false, args }),
      ),
    ).join("\n");
  const text = render({ path: "a.ts" });
  assert.match(text, /<syntaxNumber>1<\/syntaxNumber><dim> \|<\/dim>/);
  assert.match(text, /const a = 1;/);
  // The offset moves the numbering itself, not only the header's range.
  assert.match(render({ path: "a.ts", offset: 98 }), /<syntaxNumber>98<\/syntaxNumber>/);
});

test("resolveToolRenderers: a collapsed read with no failure renders no rows", () => {
  const resolved = resolveToolRenderers("read", () => baseRenderers());
  const component = resolved?.renderResult?.(
    readResult("const a = 1;"),
    { expanded: false, isPartial: false },
    fakeTheme,
    hostContext({ isPartial: false, args: { path: "a.ts" } }),
  );
  assert.deepEqual(component?.render(40), []);
});

test("resolveToolRenderers: a read failure is painted flat even when collapsed", () => {
  const resolved = resolveToolRenderers("read", () => baseRenderers());
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

test("resolveToolRenderers: a write failure renders text and a success an empty container", () => {
  const resolved = resolveToolRenderers("write", () => baseRenderers());
  const render = (isError: boolean): Component | undefined =>
    resolved?.renderResult?.(
      readResult("permission denied"),
      { expanded: false, isPartial: false },
      fakeTheme,
      hostContext({ isPartial: false, isError }),
    );
  assert.match(renderedLines(render(true)).join("\n"), /<error>permission denied<\/error>/);
  const ok = render(false);
  assert.equal(ok instanceof Container, true);
  const container = ok as Container;
  assert.deepEqual(container.children, []);
  assert.deepEqual(container.render(40), []);
});

test("resolveToolRenderers: edit fills the built-in box with the diff and leaves the result slot empty", () => {
  // The built-in `renderCall` of edit builds this box and keeps it in the state;
  // the header is its first child.
  const box = new Box(1, 1, () => "");
  box.addChild(new Text("edit src/a.ts", 0, 0));
  const resolved = resolveToolRenderers("edit", () => baseRenderers());
  const component = resolved?.renderResult?.(
    editResult("-1 const a = 1;\n+1 const b = 2;"),
    { expanded: false, isPartial: false },
    fakeTheme,
    hostContext({ args: { path: "a.ts" }, isPartial: false, state: { callComponent: box } }),
  );
  assert.deepEqual(component?.render(40), []);
  // The header survives, the gap and our body follow it. The bodies are matched
  // by their markers: the word diff of a modification puts real inverse
  // sequences inside the content, so the text is no longer contiguous there.
  assert.equal(box.children.length, 3);
  const rendered = box.render(40).join("\n");
  assert.match(rendered, /edit src\/a\.ts/);
  assert.match(rendered, /<toolDiffRemoved>-<\/toolDiffRemoved>/);
  assert.match(rendered, /<toolDiffAdded>\+<\/toolDiffAdded>/);
  // A settled success brings the box's own success background back.
  assert.match(rendered, /<bg:toolSuccessBg>/);
});

test("resolveToolRenderers: an edit failure paints the box background red and the body in the error color", () => {
  const box = new Box(1, 1, () => "");
  box.addChild(new Text("edit src/a.ts", 0, 0));
  const resolved = resolveToolRenderers("edit", () => baseRenderers());
  const component = resolved?.renderResult?.(
    readResult("no such file"),
    { expanded: false, isPartial: false },
    fakeTheme,
    hostContext({
      args: { path: "a.ts" },
      isPartial: false,
      isError: true,
      state: { callComponent: box },
    }),
  );
  assert.deepEqual(component?.render(40), []);
  const rendered = box.render(40).join("\n");
  assert.match(rendered, /<bg:toolErrorBg>/);
  assert.match(rendered, /<error>no such file<\/error>/);
});

test("resolveToolRenderers: edit without a box renders the diff below the header", () => {
  const resolved = resolveToolRenderers("edit", () => baseRenderers());
  const component = resolved?.renderResult?.(
    editResult("-1 const a = 1;"),
    { expanded: false, isPartial: false },
    fakeTheme,
    hostContext({ args: { path: "a.ts" }, isPartial: false, outputPad: 2 }),
  );
  assert.equal(component instanceof Container, true);
  const rendered = renderedLines(component as Container);
  assert.equal(rendered.length, 2);
  // The body is padded by the value the row's own renderers use.
  assert.match(rendered[1], /^  .*const a = 1;/);
});
