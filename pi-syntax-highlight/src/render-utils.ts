import { DEFAULT_MAX_BYTES, formatSize } from "@earendil-works/pi-coding-agent";
import {
  Text,
  getCapabilities,
  getImageDimensions,
  imageFallback,
  stripTerminalSequences,
  type Component,
} from "@earendil-works/pi-tui";
import { TOKEN, type StyleTheme } from "./tokens.ts";

// Structural stand-in for the host's `ToolRenderContext`, which the package
// root does not export. Only the fields the renderers actually read
// are declared, and each one also exists on the host type, so this stays
// assignable to the real renderer context.
export interface RenderContext {
  args: unknown;
  lastComponent: Component | undefined;
  state: Record<string, unknown>;
  showImages: boolean;
  durationMs: number | undefined;
}

// Control characters crash `string-width`; tab and newline stay because the body
// is rendered line by line. The host also drops the interlinear annotation range
// (`\uFFF9`-`\uFFFB`), which this package does not carry.
const BINARY_CONTROL_CHARACTERS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

// Mirrors the built-in `getTextOutput`: every text block loses the ANSI the tool
// may have captured and the carriage returns of a progress-style body, and image
// blocks become the same `[Image: ...]` line stock pi prints when the terminal
// cannot show them or the caller turned them off.
export function textOutput(
  result: { content: Array<{ type: string; text?: string; mimeType?: string; data?: string }> } | undefined,
  showImages = true,
): string {
  if (!result) return "";
  const text = result.content
    .filter((entry) => entry.type === "text")
    .map((entry) =>
      stripTerminalSequences(entry.text ?? "")
        .replace(/\r/g, "")
        .replace(BINARY_CONTROL_CHARACTERS, ""),
    )
    .join("\n");
  const images = result.content.filter((entry) => entry.type === "image");
  if (images.length === 0 || (getCapabilities().images && showImages)) return text;
  const indicators = images.map(imageIndicator).join("\n");
  // With no text block the fallback is the whole output.
  return text === "" ? indicators : `${text}\n${indicators}`;
}

function imageIndicator(block: { mimeType?: string; data?: string }): string {
  const mimeType = block.mimeType ?? "image/unknown";
  const dims =
    block.data && block.mimeType ? (getImageDimensions(block.data, block.mimeType) ?? undefined) : undefined;
  return imageFallback(mimeType, dims);
}

// The host's text renderer expands a tab to three spaces before painting a read
// body, so a file indented with tabs keeps the same column geometry this package
// measures against when it adds its own gutter.
export function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

// The generic overlay receives an output that ends with a notice such as
// "\n\n[100 matches limit]". The blank line is the only separator, so a block
// that itself contains a newline is body text, not a notice.
export function splitTrailingNotice(output: string): { body: string; notice?: string } {
  const start = output.lastIndexOf("\n\n[");
  if (start === -1) return { body: output };
  const block = output.slice(start + 2);
  if (!block.endsWith("]") || block.includes("\n")) return { body: output };
  return { body: output.slice(0, start).trimEnd(), notice: block.slice(1, -1) };
}

// Byte-identical to the built-in footer (renderers/grep.ts, find.ts, ls.ts):
// any divergence here is a visible difference against stock pi.
export function moreLinesFooter(hidden: number, theme: StyleTheme, expandHint: string): string {
  return `${theme.fg("muted", `\n... (${hidden} more lines,`)} ${expandHint}${theme.fg("muted", ")")}`;
}

// The warnings a truncated result carries, in the order stock pi prints them:
// the limit the tool reported, the truncation itself, then the caller's own
// notices. `byteStyle` covers the two wordings pi uses: grep, find and ls print
// only the limit, the shell also prints how many lines survived.
export interface TruncationParts {
  limitCount?: number;
  limitLabel?: string;
  truncatedBy?: "lines" | "bytes";
  outputLines?: number;
  totalLines?: number;
  maxBytes?: number;
  extra?: readonly string[];
  byteStyle?: "lines-shown" | "limit-only";
}

export function truncationWarnings(parts: TruncationParts): string[] {
  const warnings: string[] = [];
  if (parts.limitCount !== undefined) warnings.push(`${parts.limitCount} ${parts.limitLabel ?? "limit"}`);
  if (parts.truncatedBy !== undefined || parts.maxBytes !== undefined || parts.outputLines !== undefined) {
    warnings.push(truncationWarning(parts));
  }
  if (parts.extra !== undefined) warnings.push(...parts.extra);
  return warnings;
}

// The parts of a details-derived warning the grep, find and ls renderers print.
// `truncation.truncated` is what decides whether the byte limit is one of them.
export interface LimitTruncation {
  limitCount?: number;
  limitLabel: string;
  truncation?: { truncated?: boolean; maxBytes?: number };
  extra?: readonly string[];
}

// The line the list renderers append after the footer, blank when the result
// carries nothing to report. Both the wording and the position match stock pi:
// the notice is not part of the body, so it is never counted by the footer.
export function truncatedNotice(parts: LimitTruncation, theme: StyleTheme): string {
  const byteTruncated = parts.truncation?.truncated === true;
  const warnings = truncationWarnings({
    limitCount: parts.limitCount,
    limitLabel: parts.limitLabel,
    byteStyle: "limit-only",
    truncatedBy: byteTruncated ? "bytes" : undefined,
    maxBytes: byteTruncated ? parts.truncation?.maxBytes : undefined,
    extra: parts.extra,
  });
  if (warnings.length === 0) return "";
  return `\n${theme.fg(TOKEN.notice, `[Truncated: ${warnings.join(", ")}]`)}`;
}

// Returned without the "Truncated: " prefix, which the shell renderer adds
// itself; the list renderers wrap the whole joined text in brackets instead.
function truncationWarning(parts: TruncationParts): string {
  if (parts.truncatedBy === "lines") {
    return `showing ${parts.outputLines} of ${parts.totalLines} lines`;
  }
  // The host does not always record the limit it applied, so the built-in
  // default stands in for it.
  const limit = formatSize(parts.maxBytes ?? DEFAULT_MAX_BYTES);
  return parts.byteStyle === "limit-only"
    ? `${limit} limit`
    : `${parts.outputLines ?? 0} lines shown (${limit} limit)`;
}

// A diff is recognized by its first line; how many changed lines are needed
// before the body counts as one is up to each renderer.
export const DIFF_HEADER = /^(diff --git|--- |\+\+\+ |@@ )/;

// Added and removed lines of a diff: the foreground token alone is a thin strip
// of color on a dark terminal, so the state is repeated on the background. Both
// diff-aware renderers share this so the two bodies cannot drift apart.
export function diffChangeLine(line: string, theme: StyleTheme): string {
  return line.startsWith("+")
    ? theme.bg("toolSuccessBg", theme.fg("toolDiffAdded", line))
    : theme.bg("toolErrorBg", theme.fg("toolDiffRemoved", line));
}

// The three header forms get the function color, added and removed lines the
// diff tokens over their own background, everything else the content color.
export function styleDiffLine(line: string, theme: StyleTheme): string {
  if (line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---")) {
    return theme.fg("syntaxFunction", line);
  }
  if (line.startsWith("+") || line.startsWith("-")) return diffChangeLine(line, theme);
  return theme.fg(TOKEN.content, line);
}

// The opener plus a successful parse, so a log line that merely starts with a
// brace keeps the flat content color.
export function isJsonDocument(text: string): boolean {
  const first = text.trimStart().charAt(0);
  if (first !== "{" && first !== "[") return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// The "path:line:" prefix every line-numbered output shares. The path arrives
// already colored so each caller decides its own weight.
export function colonPrefix(styledPath: string, line: number, theme: StyleTheme): string {
  const separator = theme.fg(TOKEN.context, ":");
  return `${styledPath}${separator}${theme.fg(TOKEN.lineNumber, String(line))}${separator}`;
}

export interface ListBodyInput {
  body: string;
  expanded: boolean;
  collapsedLines: number;
  theme: StyleTheme;
  expandHint: string;
  styleLine: (raw: string) => string;
}

// The body every list-shaped result shares (find, ls, and future callers):
// cut first, style second, so a collapsed view never styles thousands of
// hidden lines.
export function buildListBody(input: ListBodyInput): string {
  if (input.body === "") return "";
  const lines = input.body.split("\n");
  const visible = input.expanded ? lines : lines.slice(0, input.collapsedLines);
  let text = `\n${visible.map((line) => input.styleLine(line)).join("\n")}`;
  const hidden = lines.length - visible.length;
  if (hidden > 0) text += moreLinesFooter(hidden, input.theme, input.expandHint);
  return text;
}

// The host passes back the component it rendered last for this slot, so
// re-rendering mutates it in place instead of allocating a new one per frame.
// The caller owns `setText`.
export function reuseText(ctx: RenderContext): Text {
  return ctx.lastComponent instanceof Text ? ctx.lastComponent : new Text("", 0, 0);
}
