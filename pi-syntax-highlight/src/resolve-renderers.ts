import { keyHint } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, Theme, ToolRenderers, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { highlight, syncHighlightTheme } from "./highlight.ts";
import { buildBashBody, createBashPreview, type BashInput } from "./render-bash.ts";
import { buildFindResultText, type PathListInput } from "./render-find.ts";
import { buildGenericResultText } from "./render-generic.ts";
import { buildGrepResultText, type GrepInput } from "./render-grep.ts";
import { buildLsResultText, type LsInput } from "./render-ls.ts";
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
    // The cached highlight lines were painted with the previous theme, if any.
    syncHighlightTheme(theme);
    const component = reuseText(context);
    const output = textOutput(result, context.showImages);
    try {
      component.setText(
        build(output, result.details, options.expanded, theme, expandHint(), context.args, result.isError === true),
      );
    } catch {
      // Losing the colors is recoverable; losing the output is not. The same
      // token as the body keeps the fallback from looking like another tool, and
      // a collapsed view is cut so it cannot flood the frame.
      const lines = output.split("\n");
      const visible = options.expanded ? lines : lines.slice(0, COLLAPSED_FALLBACK_LINES);
      component.setText(visible.map((line) => theme.fg(TOKEN.content, line)).join("\n"));
    }
    return component;
  };
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

// Keyed by name because the resolver is the single entry point for every tool
// and the ones missing here are decided by the branches below.
const STYLED_RESULTS = new Map<string, ResultRenderer>([
  ["grep", GREP_RESULT],
  ["find", FIND_RESULT],
  ["ls", LS_RESULT],
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
  const styled = STYLED_RESULTS.get(toolName);
  if (styled !== undefined) return { ...base, renderResult: styled };
  if (SHELL_TOOLS.has(toolName)) return { ...base, renderResult: createShellResultRenderer(base) };
  // Everything else (MCP servers, codemode, names the host does not know) keeps
  // its own renderer when it has one; only a tool with no result renderer at all
  // gets the generic overlay. Deleting this branch rolls E6 back to a no-op.
  if (base?.renderResult === undefined) return { ...base, renderResult: GENERIC_RESULT };
  return { ...base };
}
