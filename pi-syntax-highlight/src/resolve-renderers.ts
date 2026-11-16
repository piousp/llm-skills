import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  rawKeyHint,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, Theme, ToolRenderers, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { highlight, syncHighlightTheme } from "./highlight.ts";
import { buildBashBody, createBashPreview, type BashInput } from "./render-bash.ts";
import { buildEditDiffText } from "./render-edit.ts";
import { buildFindResultText, type PathListInput } from "./render-find.ts";
import { buildGenericResultText } from "./render-generic.ts";
import { buildGrepResultText, type GrepInput } from "./render-grep.ts";
import { buildLsResultText, type LsInput } from "./render-ls.ts";
import { buildReadResultText, readPath, type ReadResultInput } from "./render-read.ts";
import { reuseText, textOutput, type RenderContext } from "./render-utils.ts";
import { TOKEN } from "./tokens.ts";

type GrepDetails = GrepInput["details"];
type FindDetails = PathListInput["details"];
type LsDetails = LsInput["details"];

type ResultRenderer = NonNullable<ToolRenderers["renderResult"]>;

// The last resort when a body cannot be styled still has to fit the collapsed
// transcript, so it keeps the line count the list renderers use.
const COLLAPSED_FALLBACK_LINES = 15;

// The host types `details` as `any`; every field this package reads is optional,
// so a shape carrying extra members still renders.
function shellDetails(details: unknown): BashInput["details"] {
  return details as BashInput["details"];
}

function readDetails(details: unknown): ReadResultInput["details"] {
  return details as ReadResultInput["details"];
}

// The display diff of `edit`, or "" when the result carries none: the tool only
// records it on success.
function editDiff(details: unknown): string {
  const diff = typeof details === "object" && details !== null ? (details as { diff?: unknown }).diff : undefined;
  return typeof diff === "string" ? diff : "";
}

// An image result is not file text: the body loses the grammar, which is the
// branch the built-in takes too.
function hasImageBlock(result: AgentToolResult<unknown>): boolean {
  return result.content.some((block) => block.type === "image");
}

// Every styled list result turns plain text into themed text from the same
// render inputs. The call arguments come last because only grep reads them
// today: its pattern drives the match emphasis. `isError` follows them because
// only the renderers that paint a failure differently read it.
type ResultTextBuilder<TDetails> = (
  output: string,
  details: TDetails,
  expanded: boolean,
  theme: Theme,
  expandHint: string,
  args: unknown,
  isError: boolean,
) => string;

// `rawKeyHint` takes no keybinding lookup, so the fallback cannot throw outside
// a session (export, headless).
function expandHint(context: RenderContext): string {
  return context.keyHint?.("app.tools.expand", "to expand") ?? rawKeyHint("ctrl+o", "to expand");
}

function grepArgs(args: unknown): GrepInput["pattern"] {
  return typeof args === "object" && args !== null ? (args as GrepInput["pattern"]) : {};
}

// Ours first; when it throws, the host's own renderer takes the result, with a
// fresh slot because ours may have left the previous component half-built. With
// no host renderer to fall back to (generic overlay) the plain body is the floor.
function withStockFallback(ours: ResultRenderer, stock: ResultRenderer | undefined): ResultRenderer {
  return (result, options, theme, context) => {
    try {
      return ours(result, options, theme, context);
    } catch {
      if (stock !== undefined) return stock(result, options, theme, { ...context, lastComponent: undefined });
      return new Text(fallbackBody(textOutput(result, context.showImages), options.expanded, theme), 0, 0);
    }
  };
}

function wrapResultRenderer<TDetails>(build: ResultTextBuilder<TDetails>): ResultRenderer {
  return (result, options, theme, context) => {
    // The cached highlight lines were painted with the previous theme, if any.
    syncHighlightTheme(theme);
    const component = reuseText(context);
    const output = textOutput(result, context.showImages);
    // The TUI hands the failure through the context; the result it passes to the
    // renderer carries no `isError`, so reading it there would always be false.
    const isError = context.isError === true;
    component.setText(
      build(output, result.details, options.expanded, theme, expandHint(context), context.args, isError),
    );
    return component;
  };
}

// Losing the colors is recoverable; losing the output is not. The same token as
// the body keeps the fallback from looking like another tool, and a collapsed
// view is cut so it cannot flood the frame.
function fallbackBody(output: string, expanded: boolean, theme: Theme): string {
  const lines = output.split("\n");
  const visible = expanded ? lines : lines.slice(0, COLLAPSED_FALLBACK_LINES);
  return visible.map((line) => theme.fg(TOKEN.content, line)).join("\n");
}

const GREP_RESULT = wrapResultRenderer<GrepDetails>((output, details, expanded, theme, expandHint, args) =>
  buildGrepResultText({ output, details, expanded, pattern: grepArgs(args), theme, expandHint, highlight }),
);

const FIND_RESULT = wrapResultRenderer<FindDetails>((output, details, expanded, theme, expandHint, _args, isError) =>
  buildFindResultText({ output, details, expanded, isError, theme, expandHint }),
);

const LS_RESULT = wrapResultRenderer<LsDetails>((output, details, expanded, theme, expandHint, _args, isError) =>
  buildLsResultText({ output, details, expanded, isError, theme, expandHint }),
);

// Fallback for every tool this package does not style: the body is painted, the
// header stays whatever the tool brought (usually nothing).
const GENERIC_RESULT = wrapResultRenderer<unknown>(
  (output, _details, expanded, theme, expandHint, _args, isError) =>
    buildGenericResultText({ output, expanded, isError, theme, expandHint }),
);

const READ_RESULT: ResultRenderer = (result, options, theme, context) => {
  // The cached highlight lines were painted with the previous theme, if any.
  syncHighlightTheme(theme);
  const component = reuseText(context);
  const output = textOutput(result, context.showImages);
  component.setText(
    buildReadResultText({
      output,
      path: readPath(context.args),
      details: readDetails(result.details),
      expanded: options.expanded,
      // The TUI hands the failure through the context; the result it passes to
      // the renderer carries no `isError`, so reading it there would always be
      // false.
      isError: context.isError === true,
      hasImage: hasImageBlock(result),
      theme,
      expandHint: expandHint(context),
      highlight,
    }),
  );
  return component;
};

// The built-in `renderCall` of edit keeps its `Box` in the renderer state, and
// the built-in `renderResult` writes the diff into that same box. The header the
// built-in left is the first child; the members declared are the ones this
// package touches, so a host that drops one loses the highlight, never the diff.
interface EditCallBox extends Component {
  children: Component[];
  addChild(component: Component): void;
  removeChild(component: Component): void;
}

function editCallBox(state: Record<string, unknown>): EditCallBox | undefined {
  const candidate = state.callComponent as Partial<EditCallBox> | null | undefined;
  if (candidate === undefined || candidate === null) return undefined;
  const usable =
    Array.isArray(candidate.children) &&
    candidate.children.length > 0 &&
    typeof candidate.addChild === "function" &&
    typeof candidate.removeChild === "function" &&
    typeof candidate.render === "function";
  return usable ? (candidate as EditCallBox) : undefined;
}

function replaceChildrenAfter(container: Pick<EditCallBox, "children" | "addChild" | "removeChild">, keep: number, body: Component): void {
  for (const child of container.children.slice(keep)) container.removeChild(child);
  container.addChild(new Spacer(1));
  container.addChild(body);
}

// Stock draws everything; only a successful diff is replaced by the highlighted
// one, in the box stock filled or, with no box, in the container it returned.
function editSlot(base: { renderResult: ResultRenderer }): ToolRenderers {
  const stock = base.renderResult;
  const ours: ResultRenderer = (result, options, theme, context) => {
    syncHighlightTheme(theme);
    const stockOut = stock(result, options, theme, context);
    const diff = editDiff(result.details);
    if (context.isError === true || diff === "") return stockOut;
    const body = buildEditDiffText({ diff, path: readPath(context.args), theme, highlight });
    const box = editCallBox(context.state);
    if (box !== undefined) {
      replaceChildrenAfter(box, 1, new Text(body, 0, 0));
      return stockOut;
    }
    if (!(stockOut instanceof Container)) return stockOut;
    replaceChildrenAfter(stockOut, 0, new Text(body, context.outputPad, 0));
    return stockOut;
  };
  return { renderResult: withStockFallback(ours, stock) };
}

// The host's own definitions, by tool name: a slot is overlaid only when the base
// renderResult is the one of these.
const STOCK_DEFINITIONS: Record<string, (cwd: string) => unknown> = {
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
  read: createReadToolDefinition,
  edit: createEditToolDefinition,
  bash: createBashToolDefinition,
  powershell: createPowerShellToolDefinition,
};

const stockResultCache = new Map<string, ResultRenderer | undefined>();

function stockResult(toolName: string): ResultRenderer | undefined {
  if (stockResultCache.has(toolName)) return stockResultCache.get(toolName);
  let stock: ResultRenderer | undefined;
  try {
    stock = (STOCK_DEFINITIONS[toolName]?.(process.cwd()) as ToolRenderers | undefined)?.renderResult;
  } catch {
    stock = undefined;
  }
  stockResultCache.set(toolName, stock);
  return stock;
}

// The built-in `bash` and `powershell` renderers are built per definition, so
// identity fails and the source text is the second test. Anything undecidable
// counts as foreign: the look the tool brought is the safe one.
function isStockSlot(toolName: string, renderResult: ResultRenderer): boolean {
  const stock = stockResult(toolName);
  if (stock === undefined) return false;
  try {
    return renderResult === stock || renderResult.toString() === stock.toString();
  } catch {
    return false;
  }
}

type SlotFactory = (base: ToolRenderers & { renderResult: ResultRenderer }) => ToolRenderers;

const resultSlot =
  (ours: ResultRenderer): SlotFactory =>
  (base) => ({ renderResult: withStockFallback(ours, base.renderResult) });

// The host keeps the row's clock in `context.state` between renders; these are
// the three fields this renderer reads and writes.
type ShellTimerState = {
  startedAt?: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
};

function shellTimerState(context: RenderContext): ShellTimerState {
  return context.state as ShellTimerState;
}

// Same child order as the built-in renderer: body, then warnings, then timer.
function buildShellComponent(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext,
): Component {
  const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
  container.clear();
  const timer = shellTimerState(context);
  // A final result ends the row's clock: an interval left running would keep
  // invalidating a row that no longer changes, and the end time is stamped once.
  if (timer.interval !== undefined) {
    clearInterval(timer.interval);
    delete timer.interval;
  }
  timer.endedAt ??= Date.now();
  // A recorded duration wins because it survives reloads; the row's own clock
  // is the fallback, frozen at the stamped end so later renders do not grow it.
  const duration =
    context.durationMs ??
    (typeof timer.startedAt === "number" && typeof timer.endedAt === "number"
      ? timer.endedAt - timer.startedAt
      : undefined);
  const built = buildBashBody({
    output: textOutput(result, context.showImages),
    details: shellDetails(result.details),
    durationMs: duration,
    isPartial: options.isPartial,
    theme,
  });
  if (built.body !== "") {
    if (options.expanded) {
      container.addChild(new Text(`\n${built.body}`, 0, 0));
    } else {
      container.addChild(new Spacer(1));
      container.addChild(createBashPreview(built.body, expandHint(context), theme));
    }
  }
  if (built.warnings !== undefined) {
    container.addChild(new Text(`\n${theme.fg(TOKEN.notice, `[${built.warnings}]`)}`, 0, 0));
  }
  if (built.timer !== undefined) {
    container.addChild(new Text(`\n${theme.fg("muted", `Took ${built.timer}`)}`, 0, 0));
  }
  return container;
}

// The shell renderer is created per resolution because it needs the host's
// renderer at call time.
function shellSlot(base: { renderResult: ResultRenderer }): ToolRenderers {
  const stock = base.renderResult;
  const final = withStockFallback(buildShellComponent, stock);
  // Streaming stays on the built-in path: it owns the elapsed line and the
  // repaint interval, which a final result cannot reproduce.
  return {
    renderResult: (result, options, theme, context) => {
      syncHighlightTheme(theme);
      return options.isPartial ? stock(result, options, theme, context) : final(result, options, theme, context);
    },
  };
}

// Keyed by name because the resolver is the single entry point for every tool.
const STYLED_SLOTS = new Map<string, SlotFactory>([
  ["grep", resultSlot(GREP_RESULT)],
  ["find", resultSlot(FIND_RESULT)],
  ["ls", resultSlot(LS_RESULT)],
  ["read", resultSlot(READ_RESULT)],
  ["edit", editSlot],
  ["bash", shellSlot],
  ["powershell", shellSlot],
]);

// `undefined` ends the chain the way the host expects, so it passes through. A
// renderResult this package does not recognise is left exactly as it came (same
// object); only a stock slot is overlaid, and only a tool that brings no result
// renderer at all gets the generic body.
export function resolveToolRenderers(toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined {
  const base = next();
  if (base === undefined) return undefined;
  const current = base.renderResult;
  if (current === undefined) return { ...base, renderResult: withStockFallback(GENERIC_RESULT, undefined) };
  const slot = STYLED_SLOTS.get(toolName);
  if (slot === undefined || !isStockSlot(toolName, current)) return base;
  return { ...base, ...slot({ ...base, renderResult: current }) };
}
