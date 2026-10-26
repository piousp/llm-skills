import { keyHint } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, Theme, ToolRenderers, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { captureTheme } from "./active-theme.ts";
import { highlight, syncHighlightTheme } from "./highlight.ts";
import { buildBashBody, createBashPreview, type BashInput } from "./render-bash.ts";
import { buildEditDiffText, buildEditErrorText } from "./render-edit.ts";
import { buildFindResultText, type PathListInput } from "./render-find.ts";
import { buildGenericResultText } from "./render-generic.ts";
import { buildGrepResultText, type GrepInput } from "./render-grep.ts";
import { buildLsResultText, type LsInput } from "./render-ls.ts";
import {
  buildReadCallText,
  buildReadResultText,
  readLimit,
  readOffset,
  readPath,
  type ReadResultInput,
} from "./render-read.ts";
import { buildWriteCallText, buildWriteResultText } from "./render-write.ts";
import { reuseText, textOutput, type RenderContext } from "./render-utils.ts";
import { TOKEN } from "./tokens.ts";

type GrepDetails = GrepInput["details"];
type FindDetails = PathListInput["details"];
type LsDetails = LsInput["details"];

type ResultRenderer = NonNullable<ToolRenderers["renderResult"]>;
type CallRenderer = NonNullable<ToolRenderers["renderCall"]>;

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

// An image result is not file text: the body loses both the gutter and the
// grammar, which is the branch the built-in takes too.
function hasImageBlock(result: AgentToolResult<unknown>): boolean {
  return result.content.some((block) => block.type === "image");
}

// The content argument of `write`: "" while the argument has not arrived, null
// when what arrived is not a string (the built-in reports that as an invalid arg).
function writeContent(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return "";
  const content = (args as { content?: unknown }).content;
  if (content === undefined || content === null) return "";
  return typeof content === "string" ? content : null;
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

// `keyHint` reads the live keybindings and throws outside a session (export,
// headless). The hint is decoration: a stable fallback beats losing the row.
function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "ctrl+o to expand";
  }
}

function grepArgs(args: unknown): GrepInput["pattern"] {
  return typeof args === "object" && args !== null ? (args as GrepInput["pattern"]) : {};
}

function wrapResultRenderer<TDetails>(build: ResultTextBuilder<TDetails>): ResultRenderer {
  return (result, options, theme, context) => {
    // The last theme seen is what the paths outside a renderer paint with.
    captureTheme(theme);
    // The cached highlight lines were painted with the previous theme, if any.
    syncHighlightTheme(theme);
    const component = reuseText(context);
    const output = textOutput(result, context.showImages);
    // The TUI hands the failure through the context; the result it passes to the
    // renderer carries no `isError`, so reading it there would always be false.
    const isError = context.isError === true;
    try {
      component.setText(
        build(output, result.details, options.expanded, theme, expandHint(), context.args, isError),
      );
    } catch {
      // Losing the colors is recoverable; losing the output is not.
      component.setText(fallbackBody(output, options.expanded, theme));
    }
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
  captureTheme(theme);
  // The cached highlight lines were painted with the previous theme, if any.
  syncHighlightTheme(theme);
  const component = reuseText(context);
  const output = textOutput(result, context.showImages);
  try {
    component.setText(
      buildReadResultText({
        output,
        path: readPath(context.args),
        offset: readOffset(context.args),
        details: readDetails(result.details),
        expanded: options.expanded,
        // The TUI hands the failure through the context; the result it passes to
        // the renderer carries no `isError`, so reading it there would always be
        // false.
        isError: context.isError === true,
        hasImage: hasImageBlock(result),
        theme,
        expandHint: expandHint(),
        highlight,
      }),
    );
  } catch {
    component.setText(fallbackBody(output, options.expanded, theme));
  }
  return component;
};

// A success has no body at all (the tool reports it with no text), so the slot is
// cleared back to the container the host reuses instead of holding an empty text.
function emptyResult(context: RenderContext): Container {
  const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
  component.clear();
  return component;
}

const WRITE_RESULT: ResultRenderer = (result, _options, theme, context) => {
  captureTheme(theme);
  syncHighlightTheme(theme);
  const output = textOutput(result, context.showImages);
  const text = buildWriteResultText({ output, isError: context.isError === true, theme });
  if (text === "") return emptyResult(context);
  const component = reuseText(context);
  component.setText(text);
  return component;
};

// The built-in `renderCall` of edit keeps its `Box` in the renderer state, and
// the built-in `renderResult` writes the diff into that same box. Only the two
// members this package touches are declared: a host that drops one loses the
// background and the in-box body, never the diff.
interface EditCallBox extends Component {
  children: Component[];
  addChild(component: Component): void;
  removeChild(component: Component): void;
  setBgFn(bgFn?: (text: string) => string): void;
}

function editCallBox(state: Record<string, unknown>): EditCallBox | undefined {
  const candidate = state.callComponent as Partial<EditCallBox> | null | undefined;
  if (candidate === undefined || candidate === null) return undefined;
  const usable =
    Array.isArray(candidate.children) &&
    typeof candidate.addChild === "function" &&
    typeof candidate.removeChild === "function" &&
    typeof candidate.setBgFn === "function" &&
    typeof candidate.render === "function";
  return usable ? (candidate as EditCallBox) : undefined;
}

// The first child is the header the built-in `renderCall` left in place, with its
// path and hyperlink; every child after it is the preview this result replaces.
function replaceEditBody(box: EditCallBox, isError: boolean, body: string, theme: Theme): void {
  for (const child of box.children.slice(1)) box.removeChild(child);
  box.setBgFn((text) => theme.bg(isError ? "toolErrorBg" : "toolSuccessBg", text));
  if (body === "") return;
  box.addChild(new Spacer(1));
  box.addChild(new Text(body, 0, 0));
}

const EDIT_RESULT: ResultRenderer = (result, _options, theme, context) => {
  captureTheme(theme);
  syncHighlightTheme(theme);
  const isError = context.isError === true;
  const body = isError
    ? buildEditErrorText(textOutput(result, context.showImages), theme)
    : buildEditDiffText({ diff: editDiff(result.details), path: readPath(context.args), theme, highlight });
  const box = editCallBox(context.state);
  if (box !== undefined) {
    replaceEditBody(box, isError, body, theme);
    // The diff lives inside the box now, so the result slot stays empty.
    return emptyResult(context);
  }
  // Degradation: with no box to fill, the body goes below the header the way the
  // built-in draws it when its own call renderer did not run.
  const component = emptyResult(context);
  if (body !== "") {
    component.addChild(new Spacer(1));
    component.addChild(new Text(body, context.outputPad, 0));
  }
  return component;
};

const READ_CALL: CallRenderer = (args, theme, context) => {
  captureTheme(theme);
  const component = reuseText(context);
  component.setText(
    buildReadCallText({
      path: readPath(args),
      offset: readOffset(args),
      limit: readLimit(args),
      compact: !context.expanded,
      theme,
      cwd: context.cwd,
    }),
  );
  return component;
};

const WRITE_CALL: CallRenderer = (args, theme, context) => {
  captureTheme(theme);
  // The preview tokenizes through the shared cache, which is keyed by language
  // and code alone: a theme switch has to invalidate it here as well.
  syncHighlightTheme(theme);
  const component = reuseText(context);
  component.setText(
    buildWriteCallText({
      path: readPath(args),
      content: writeContent(args),
      argsComplete: context.argsComplete,
      expanded: context.expanded,
      theme,
      expandHint: expandHint(),
      highlight,
      cwd: context.cwd,
    }),
  );
  return component;
};

// Keyed by name because the resolver is the single entry point for every tool;
// only the slots named here are overridden, and the rest come from the base
// chain. `edit` keeps its built-in `renderCall`: the preview it draws comes from
// a helper the host does not export, and its box is what our body fills.
const STYLED_SLOTS = new Map<string, ToolRenderers>([
  ["grep", { renderResult: GREP_RESULT }],
  ["find", { renderResult: FIND_RESULT }],
  ["ls", { renderResult: LS_RESULT }],
  ["read", { renderCall: READ_CALL, renderResult: READ_RESULT }],
  ["write", { renderCall: WRITE_CALL, renderResult: WRITE_RESULT }],
  ["edit", { renderResult: EDIT_RESULT }],
]);

// The shell body is a component tree, not a text block: the collapsed view cuts
// visual lines at render time, so it cannot be built once at module load.
const SHELL_TOOLS = new Set(["bash", "powershell"]);

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
  // A recorded duration wins because it survives reloads; the clock the row
  // started from is the fallback for results stored without one.
  const duration =
    context.durationMs ?? (timer.startedAt !== undefined ? Date.now() - timer.startedAt : undefined);
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
      container.addChild(createBashPreview(built.body, expandHint(), theme));
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

function buildShellFallback(result: AgentToolResult<unknown>, theme: Theme, context: RenderContext): Text {
  const component = reuseText(context);
  const output = textOutput(result, context.showImages);
  component.setText(output.split("\n").map((line) => theme.fg(TOKEN.content, line)).join("\n"));
  return component;
}

// The shell renderer is created per resolution, not baked into the map above,
// because it needs the base chain at call time.
function createShellResultRenderer(base: ToolRenderers | undefined): ResultRenderer {
  return (result, options, theme, context) => {
    captureTheme(theme);
    syncHighlightTheme(theme);
    const inherited = base?.renderResult;
    // Streaming stays on the built-in path when there is one: it owns the elapsed
    // line and the repaint interval, which a final result cannot reproduce. With
    // no `base.renderResult` the chain has nowhere to fall through, so the builder
    // runs in partial mode: the full-output block stays in the body and no timer
    // line is added.
    if (options.isPartial && inherited !== undefined) return inherited(result, options, theme, context);
    try {
      return buildShellComponent(result, options, theme, context);
    } catch {
      // Losing the colors is recoverable; losing the output is not.
      return buildShellFallback(result, theme, context);
    }
  };
}

// Overlay only the slots this package owns: `next()` is the host's own chain
// (later resolvers, then the tool definition), so whatever it returns for
// `renderCall` and `renderShell` is passed through untouched. `next()` is always
// spread into a fresh object because returning `undefined` would end the chain
// with no fallback at all.
export function resolveToolRenderers(toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined {
  const base = next();
  const slots = STYLED_SLOTS.get(toolName);
  if (slots !== undefined) return { ...base, ...slots };
  if (SHELL_TOOLS.has(toolName)) return { ...base, renderResult: createShellResultRenderer(base) };
  // Everything else (MCP servers, codemode, names the host does not know) keeps
  // its own renderer when it has one; only a tool with no result renderer at all
  // gets the generic overlay. Deleting this branch rolls E6 back to a no-op.
  if (base?.renderResult === undefined) return { ...base, renderResult: GENERIC_RESULT };
  return { ...base };
}
