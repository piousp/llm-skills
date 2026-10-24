import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { parseGrepLine } from "./grep-parse.ts";
import { highlight as builtInHighlight, highlightLines, type HighlightFn } from "./highlight.ts";
import { DIFF_HEADER, colonPrefix, isJsonDocument, styleDiffLine, truncationWarnings } from "./render-utils.ts";
import { TOKEN, type StyleTheme } from "./tokens.ts";

// The built-in shell renderer keeps five visual lines when collapsed; any other
// number is a visible difference against stock pi.
const PREVIEW_LINES = 5;

// The built-in separates its "[Full output: ...]" block with a blank line, which
// is what keeps the strip from eating body text that merely ends in "]".
const FULL_OUTPUT_SEPARATOR = "\n\n[";

const DIFF_HUNK = /^@@ /;
const DIFF_CHANGE = /^[+-]/;
const ERROR_LINE = /^(error|fatal|panic|traceback|ERR!)/i;
const WARNING_LINE = /^(warning|warn)\b/i;

export interface BashInput {
  output: string;
  details:
    | {
        truncation?: {
          truncated?: boolean;
          truncatedBy?: "lines" | "bytes";
          outputLines?: number;
          totalLines?: number;
          maxBytes?: number;
        };
        fullOutputPath?: string;
      }
    | undefined;
  durationMs: number | undefined;
  /**
   * A streaming result: the host keeps the full-output block in the body and the
   * builder prints no timer, so the elapsed line stays with the live renderer.
   */
  isPartial?: boolean;
  theme: StyleTheme;
  /** Injected in tests: `highlightCode` paints through the module-global theme. */
  highlight?: HighlightFn;
}

export interface BashBody {
  /** Styled body, without the leading newline the component wrapper adds. */
  body: string;
  /** Bracketed warning text, without the brackets. */
  warnings?: string;
  /** Duration text, without the "Took " prefix. */
  timer?: string;
}

// Byte-identical to the built-in `formatToolDuration`: a diff here is a visible
// difference in the timer line, and `60.0s` at 59.999 ms is intended behavior.
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return minutes < 60
    ? `${minutes}m ${remainder}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

// A diff is recognized by its header plus a hunk marker or several changed
// lines: a log line that merely starts with "--- " must not paint red/green.
function isDiffOutput(lines: string[]): boolean {
  const first = lines.find((line) => line.trim() !== "");
  if (first === undefined || !DIFF_HEADER.test(first)) return false;
  let hunks = 0;
  let changes = 0;
  for (const line of lines) {
    if (DIFF_HUNK.test(line)) hunks += 1;
    else if (DIFF_CHANGE.test(line)) changes += 1;
  }
  return hunks > 0 || changes > 1;
}

// Commands that print compiler or test output repeat grep's "path:line: text"
// shape, so it is parsed with the same function instead of a second regex.
function styleLine(line: string, theme: StyleTheme): string {
  if (ERROR_LINE.test(line)) return theme.fg(TOKEN.broken, line);
  if (WARNING_LINE.test(line)) return theme.fg(TOKEN.notice, line);
  const entry = parseGrepLine(line);
  if (entry.kind !== "match") return theme.fg(TOKEN.content, line);
  const path = theme.fg(TOKEN.path, entry.path);
  return `${colonPrefix(path, entry.line, theme)} ${theme.fg(TOKEN.content, entry.text)}`;
}

function styleOutput(output: string, theme: StyleTheme, highlight: HighlightFn): string {
  const lines = output.split("\n");
  if (isDiffOutput(lines)) return lines.map((line) => styleDiffLine(line, theme)).join("\n");
  if (isJsonDocument(output)) {
    // Whole-block highlighting keeps keys, strings and numbers distinct; the
    // fallback protects readers when the tokenizer throws.
    const fallback = (line: string): string => theme.fg(TOKEN.content, line);
    return highlightLines(output, "json", fallback, highlight).join("\n");
  }
  return lines.map((line) => styleLine(line, theme)).join("\n");
}

type BashTruncation = NonNullable<NonNullable<BashInput["details"]>["truncation"]>;

// Same wording as the built-in renderer, including the byte limit it falls back
// to when the host did not record one. The built-in treats a missing
// `truncatedBy` as byte truncation, so the default is spelled out here.
function truncationText(truncation: BashTruncation): string {
  return truncationWarnings({
    truncatedBy: truncation.truncatedBy ?? "bytes",
    outputLines: truncation.outputLines,
    totalLines: truncation.totalLines,
    maxBytes: truncation.maxBytes,
  }).join(". ");
}

// The built-in moves the trailing "[Full output: ...]" block out of the body and
// rebuilds it as a warning, so the path is not shown twice. A partial result may
// still be rewritten by the tool, so the block stays in place exactly as the
// built-in does (`!options.isPartial`), and its own blank line is the only
// separator that can start the block.
function stripFullOutputBlock(output: string, details: BashInput["details"], isPartial: boolean): string {
  const truncation = details?.truncation;
  const fullOutputPath = details?.fullOutputPath;
  if (isPartial || !truncation?.truncated || !fullOutputPath || !output.endsWith("]")) return output;
  const blockStart = output.lastIndexOf(FULL_OUTPUT_SEPARATOR);
  if (blockStart === -1 || !output.slice(blockStart).includes(fullOutputPath)) return output;
  return output.slice(0, blockStart).trimEnd();
}

// A partial result prints no timer: the elapsed line belongs to the live
// renderer.
export function buildBashBody(input: BashInput): BashBody {
  const truncation = input.details?.truncation;
  const fullOutputPath = input.details?.fullOutputPath;
  const output = stripFullOutputBlock(input.output.trim(), input.details, input.isPartial === true);

  const body = output === "" ? "" : styleOutput(output, input.theme, input.highlight ?? builtInHighlight);

  const warnings: string[] = [];
  if (fullOutputPath) warnings.push(`Full output: ${fullOutputPath}`);
  if (truncation?.truncated) warnings.push(`Truncated: ${truncationText(truncation)}`);

  return {
    body,
    warnings: warnings.length === 0 ? undefined : warnings.join(". "),
    timer: input.isPartial || input.durationMs === undefined ? undefined : formatDuration(input.durationMs),
  };
}

// Collapsed shell output is cut by visual line, not by logical line: a single
// long line (minified JSON, a build log without newlines) would otherwise fill
// the screen. The lines are cached per width because a component re-renders on
// every frame of the transcript.
export function createBashPreview(body: string, expandHint: string, theme: StyleTheme): Component {
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;
  return {
    render(width: number): string[] {
      if (cachedLines !== undefined && cachedWidth === width) return cachedLines;
      const { visualLines, skippedCount } = truncateToVisualLines(body, PREVIEW_LINES, width, 0, "end");
      const lines = visualLines.map((line) => truncateToWidth(line, width));
      if (skippedCount > 0) {
        // Same hint format as the built-in preview, above the kept tail.
        const hint = `${theme.fg("muted", `... (${skippedCount} earlier lines,`)} ${expandHint}${theme.fg("muted", ")")}`;
        cachedLines = [truncateToWidth(hint, width), ...lines];
      } else {
        cachedLines = lines;
      }
      cachedWidth = width;
      return cachedLines;
    },
    invalidate(): void {
      cachedWidth = undefined;
      cachedLines = undefined;
    },
  };
}
