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
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, type Component } from "@earendil-works/pi-tui";
import { resolveToolRenderers } from "../../src/resolve-renderers.ts";

// The host's theme lives on `globalThis` under this symbol; the stock renderers read
// it from there, so the same object is what both sides must paint with.
const HOST_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
initTheme("system");
const theme = (globalThis as unknown as Record<symbol, Theme>)[HOST_THEME_KEY]!;

type ResultRenderer = NonNullable<ToolRenderers["renderResult"]>;
type CallRenderer = NonNullable<ToolRenderers["renderCall"]>;
type HostResult = Parameters<ResultRenderer>[0];
type HostContext = Parameters<ResultRenderer>[3];

const WIDTH = 80;
const DURATION_MS = 1500;

// Stock renderers call the exported `keyHint` directly and ignore `context.keyHint`;
// after `initTheme` it is deterministic (empty key), so handing the same function to
// the context keeps both sides byte-comparable. The app.* bindings cannot be
// initialised in a test, so the key text itself is not under test here.
function context(overrides: Partial<HostContext>): HostContext {
  return {
    args: {},
    toolCallId: "call-1",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: false,
    argsComplete: false,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    durationMs: DURATION_MS,
    outputPad: 1,
    keyText,
    keyHint,
    ...overrides,
  };
}

function textResult(text: string, details?: unknown): HostResult {
  return { content: [{ type: "text", text }], details };
}

interface Scenario {
  tool: string;
  stock: ToolRenderers;
  args?: unknown;
  result: HostResult;
  isError?: boolean;
  expanded?: boolean;
  withCall?: boolean;
  argsComplete?: boolean;
}

// What a row shows: the call component (when asked) followed by the result component.
// Each side has its own renderer state, as each side would have its own row.
function renderRow(renderers: ToolRenderers, scenario: Scenario): string[] {
  const state: Record<string, unknown> = {};
  const base = {
    args: scenario.args ?? {},
    state,
    expanded: scenario.expanded ?? false,
    isError: scenario.isError ?? false,
  };
  const components: Component[] = [];
  if (scenario.withCall === true) {
    const call = (renderers.renderCall as CallRenderer)(
      base.args as never,
      theme,
      context({ ...base, isPartial: true, argsComplete: scenario.argsComplete ?? false }),
    );
    components.push(call);
  }
  const resultContext = context(base);
  const component = (renderers.renderResult as ResultRenderer)(
    scenario.result,
    { expanded: base.expanded, isPartial: false },
    theme,
    resultContext,
  );
  components.push(component);
  return components.flatMap((c) => c.render(WIDTH));
}

function sides(scenario: Scenario): { stock: string[]; ours: string[] } {
  const ours = resolveToolRenderers(scenario.tool, () => scenario.stock);
  assert.ok(ours !== undefined);
  return { stock: renderRow(scenario.stock, scenario), ours: renderRow(ours, scenario) };
}

function assertByteExact(scenario: Scenario): void {
  const { stock, ours } = sides(scenario);
  assert.deepEqual(ours, stock);
}

// A highlighted body is allowed to differ in colours only: same text, same shape.
function assertSameTextAndShape(scenario: Scenario): void {
  const { stock, ours } = sides(scenario);
  assert.equal(ours.length, stock.length);
  assert.deepEqual(ours.map(stripTerminalSequences), stock.map(stripTerminalSequences));
}

const cwd = process.cwd();
const grep = createGrepToolDefinition(cwd) as unknown as ToolRenderers;
const find = createFindToolDefinition(cwd) as unknown as ToolRenderers;
const ls = createLsToolDefinition(cwd) as unknown as ToolRenderers;
const read = createReadToolDefinition(cwd) as unknown as ToolRenderers;
const write = createWriteToolDefinition(cwd) as unknown as ToolRenderers;
const edit = createEditToolDefinition(cwd) as unknown as ToolRenderers;
const bash = createBashToolDefinition(cwd) as unknown as ToolRenderers;
const powershell = createPowerShellToolDefinition(cwd) as unknown as ToolRenderers;

const manyLines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");

// Byte-exact where nothing is highlighted.

test("parity: grep lines that carry no highlighted body render like stock", () => {
  assertByteExact({
    tool: "grep",
    stock: grep,
    args: { pattern: "line" },
    result: textResult(manyLines(30, "no path prefix here")),
  });
});

test("parity: grep error renders like stock", () => {
  assertByteExact({ tool: "grep", stock: grep, args: { pattern: "x" }, result: textResult("grep failed"), isError: true });
});

test("parity: find error renders like stock", () => {
  assertByteExact({ tool: "find", stock: find, args: { pattern: "*.ts" }, result: textResult("find failed"), isError: true });
});

test("parity: ls error renders like stock", () => {
  assertByteExact({ tool: "ls", stock: ls, args: { path: "." }, result: textResult("ls failed"), isError: true });
});

for (const [tool, stock] of [["bash", bash], ["powershell", powershell]] as const) {
  for (const expanded of [false, true]) {
    test(`parity: ${tool} plain log renders like stock (${expanded ? "expanded" : "collapsed"})`, () => {
      assertByteExact({
        tool,
        stock,
        args: { command: "build" },
        result: textResult(manyLines(30, "building step")),
        expanded,
      });
    });
  }
}

test("parity: generic plain body renders like the host's result fallback", () => {
  // The host's fallback lives in ToolExecutionComponent, not in a tool definition:
  // this mirrors its createResultFallback (10 lines, toolOutput, muted notice).
  const output = manyLines(25, "mcp output");
  const lines = output.split("\n");
  const shown = lines.slice(0, 10);
  const hidden = lines.length - shown.length;
  const text =
    shown.map((line) => theme.fg("toolOutput", line)).join("\n") +
    `${theme.fg("muted", `\n... (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
  const ours = resolveToolRenderers("mcp_tool", () => ({ renderCall: () => undefined as never }));
  const component = (ours?.renderResult as ResultRenderer)(
    textResult(output),
    { expanded: false, isPartial: false },
    theme,
    context({}),
  );
  const reference = new Text(text, 0, 0);
  assert.deepEqual(component.render(WIDTH), reference.render(WIDTH));
});

test("parity: read with no language renders like stock", () => {
  assertByteExact({
    tool: "read",
    stock: read,
    args: { path: "LICENSE" },
    result: textResult(manyLines(30, "licence text")),
    withCall: true,
  });
});

test("parity: read call with a range renders like stock", () => {
  assertByteExact({
    tool: "read",
    stock: read,
    args: { path: "LICENSE", offset: 5, limit: 10 },
    result: textResult(manyLines(10, "licence text")),
    withCall: true,
  });
});

for (const name of ["AGENTS.md", "docs/SKILL.md"]) {
  test(`parity: read call of ${name} renders like stock`, () => {
    assertByteExact({
      tool: "read",
      stock: read,
      args: { path: name },
      result: textResult(manyLines(10, "doc text")),
      withCall: true,
    });
  });
}

test("parity: read error renders like stock", () => {
  assertByteExact({
    tool: "read",
    stock: read,
    args: { path: "LICENSE" },
    result: textResult("File not found"),
    isError: true,
    withCall: true,
  });
});

test("parity: write call and result with no language render like stock", () => {
  assertByteExact({
    tool: "write",
    stock: write,
    args: { path: "LICENSE", content: manyLines(30, "text") },
    result: textResult("Wrote 30 lines"),
    withCall: true,
  });
});

test("parity: write call with highlighted content keeps the stock text and shape", () => {
  assertSameTextAndShape({
    tool: "write",
    stock: write,
    args: { path: "a.ts", content: manyLines(30, "const v = 1; // line") },
    result: textResult("Wrote 30 lines"),
    withCall: true,
  });
});

test("parity: expanded write call with highlighted content keeps the stock text and shape", () => {
  assertSameTextAndShape({
    tool: "write",
    stock: write,
    args: { path: "a.ts", content: manyLines(30, "const v = 1; // line") },
    result: textResult("Wrote 30 lines"),
    withCall: true,
    expanded: true,
    argsComplete: true,
  });
});

test("parity: write call with complete args and no language renders like stock", () => {
  assertByteExact({
    tool: "write",
    stock: write,
    args: { path: "LICENSE", content: manyLines(30, "text") },
    result: textResult("Wrote 30 lines"),
    withCall: true,
    argsComplete: true,
  });
});

test("parity: edit error renders like stock", () => {
  assertByteExact({
    tool: "edit",
    stock: edit,
    args: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
    result: textResult("Could not find the text"),
    isError: true,
    withCall: true,
  });
});

// Same text and line count where a body is highlighted.

test("parity: read of a .ts file keeps the stock text and shape", () => {
  assertSameTextAndShape({
    tool: "read",
    stock: read,
    args: { path: "a.ts" },
    result: textResult("const a: number = 1;\nexport function f() {\n  return a;\n}\n"),
    withCall: true,
    expanded: true,
  });
});

test("parity: edit success diff keeps the stock text and shape", () => {
  const diff = [" 1 const a = 1;", "-2 const b = 2;", "+2 const b = 3;", " 3 export { a, b };"].join("\n");
  assertSameTextAndShape({
    tool: "edit",
    stock: edit,
    args: { path: "a.ts", edits: [{ oldText: "const b = 2;", newText: "const b = 3;" }] },
    result: textResult("Edited a.ts", { diff }),
    withCall: true,
  });
});

function renderGeneric(body: string, expanded = false): string[] {
  const ours = resolveToolRenderers("mcp_tool", () => ({ renderCall: () => undefined as never }));
  const component = (ours?.renderResult as ResultRenderer)(
    textResult(body),
    { expanded, isPartial: false },
    theme,
    context({ expanded }),
  );
  return component.render(WIDTH).map((l) => stripTerminalSequences(l).trimEnd());
}

function stockFallback(body: string, expanded = false): string[] {
  const lines = body.split("\n");
  const shown = expanded ? lines : lines.slice(0, 10);
  const remaining = lines.length - shown.length;
  const footer = remaining > 0 ? [`... (${remaining} more lines, ${stripTerminalSequences(keyHint("app.tools.expand", "to expand"))})`] : [];
  return [...shown, ...footer];
}

test("parity: generic JSON body keeps the host fallback text and shape", () => {
  const body = JSON.stringify({ name: "x", items: [1, 2], nested: { ok: true } }, null, 2);
  assert.ok(body.split("\n").length <= 10);
  assert.deepEqual(renderGeneric(body), stockFallback(body));
});

test("parity: generic JSON body over ten lines keeps the collapsed lines and the host footer", () => {
  const body = JSON.stringify({ name: "x", items: [1, 2, 3, 4, 5, 6], nested: { ok: true } }, null, 2);
  assert.ok(body.split("\n").length > 10);
  const rendered = renderGeneric(body);
  assert.deepEqual(rendered, stockFallback(body));
  assert.match(rendered.at(-1) ?? "", /^\.\.\. \(\d+ more lines, .*\)$/);
});
