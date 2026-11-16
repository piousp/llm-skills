import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { highlightLines, type HighlightFn } from "./highlight.ts";
import { moreLinesFooter, replaceTabs } from "./render-utils.ts";
import { TOKEN, type StyleTheme } from "./tokens.ts";

// The built-in read renderer shows 10 lines when collapsed; any other number is
// a visible difference against stock pi.
const COLLAPSED_LINES = 10;

// The notices the tool appends after a blank line, matched in full. Anchoring is
// what keeps a file whose last line merely opens with a bracket as body text.
const READ_NOTICES = [
  /^\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/,
  // The byte limit is spelled by `formatSize`, which prints whole bytes without a
  // decimal and the larger units with one (`512B`, `50.0KB`, `1.5MB`), always
  // followed by " limit".
  /^\[Showing lines \d+-\d+ of \d+( \(\d+(?:\.\d+)?(?:B|KB|MB) limit\))?\. Use offset=\d+ to continue\.\]$/,
];
const NOTICE_SEPARATOR = "\n\n";

// The truncation the host records for a read; every field is optional because a
// result restored from a session may carry an older shape.
export interface ReadTruncation {
  truncated?: boolean;
  truncatedBy?: "lines" | "bytes" | null;
  firstLineExceedsLimit?: boolean;
  outputLines?: number;
  totalLines?: number;
  maxLines?: number;
  maxBytes?: number;
}

export interface ReadResultInput {
  output: string;
  /** The argument's path, "" when the call does not carry one. */
  path: string;
  details: { truncation?: ReadTruncation } | undefined;
  expanded: boolean;
  isError: boolean;
  /** The result carries an image block, so the body is not file text. */
  hasImage: boolean;
  theme: StyleTheme;
  expandHint: string;
  highlight: HighlightFn;
}

export function readPath(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const value = (args as { file_path?: unknown; path?: unknown }).file_path ?? (args as { path?: unknown }).path;
  return typeof value === "string" ? value : "";
}

// The tool separates its continuation notice from the body with a blank line, so
// the split both looks for that separator and matches the whole block: a body
// line that reads like a notice stays in the body. The oversized-first-line
// message is the whole output and carries no separator at all.
export function splitReadNotice(
  output: string,
  firstLineExceedsLimit: boolean,
): { body: string; notice: string | undefined } {
  if (firstLineExceedsLimit) {
    const block = output.trim();
    if (block === "") return { body: "", notice: undefined };
    const unbracketed = block.startsWith("[") && block.endsWith("]") ? block.slice(1, -1) : block;
    return { body: "", notice: unbracketed };
  }
  const start = output.lastIndexOf(NOTICE_SEPARATOR);
  if (start === -1) return { body: output, notice: undefined };
  const block = output.slice(start + NOTICE_SEPARATOR.length).trimEnd();
  if (!block.startsWith("[") || !block.endsWith("]")) return { body: output, notice: undefined };
  if (!READ_NOTICES.some((pattern) => pattern.test(block))) return { body: output, notice: undefined };
  // The blank lines that separate the block are trailing lines of the body, which
  // the body builder trims anyway, so the slice keeps the body verbatim.
  return { body: output.slice(0, start), notice: block.slice(1, -1) };
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end);
}

function languageOf(path: string): string | undefined {
  return path === "" ? undefined : getLanguageFromPath(path);
}

// One call for the whole body: a per-line pass would break multi-line
// constructs, and the highlighter takes every line the renderer shows.
function styleLines(contents: string[], language: string | undefined, input: ReadResultInput): string[] {
  const fallback = (line: string): string => input.theme.fg(TOKEN.content, line);
  if (language === undefined) return contents.map(fallback);
  return highlightLines(contents.join("\n"), language, fallback, input.highlight);
}

// The three wordings the built-in prints, byte for byte, including the built-in
// default it falls back to when the host recorded no limit.
function readTruncationNotice(truncation: ReadTruncation | undefined, theme: StyleTheme): string {
  if (truncation?.truncated !== true) return "";
  if (truncation.firstLineExceedsLimit === true) {
    return `\n${theme.fg(TOKEN.notice, `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
  }
  if (truncation.truncatedBy === "lines") {
    const limit = truncation.maxLines ?? DEFAULT_MAX_LINES;
    return `\n${theme.fg(TOKEN.notice, `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${limit} line limit)]`)}`;
  }
  return `\n${theme.fg(TOKEN.notice, `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
}

export function buildReadResultText(input: ReadResultInput): string {
  // Stock pi keeps a collapsed read silent: the header carries the call and the
  // body is not worth a row until it is expanded or failed.
  if (!input.expanded && !input.isError) return "";
  const truncation = input.details?.truncation;
  const firstLineExceedsLimit = truncation?.firstLineExceedsLimit === true;
  const { body, notice } = splitReadNotice(input.output, firstLineExceedsLimit);
  const lines = trimTrailingEmptyLines(body.split("\n"));
  // A failure, an image block and the oversized-first-line message are not file
  // text: no grammar, exactly like the built-in.
  const fileText = !input.isError && !input.hasImage && !firstLineExceedsLimit;
  const limit = input.expanded ? lines.length : COLLAPSED_LINES;
  // The tab expansion happens before the grammar, which measures the columns the
  // terminal will show.
  const contents = lines.slice(0, limit).map((line) => replaceTabs(line));
  const styled = styleLines(contents, fileText ? languageOf(input.path) : undefined, input);

  let text = "";
  if (styled.length > 0) {
    text += `\n${styled.join("\n")}`;
  }
  // The notice is the last body line of the built-in output, so it stays before
  // the footer even though it is no longer counted as one of the file's lines.
  if (notice !== undefined) text += `\n${input.theme.fg(TOKEN.notice, `[${notice}]`)}`;
  const hidden = lines.length - limit;
  if (hidden > 0) text += moreLinesFooter(hidden, input.theme, input.expandHint);
  return text + readTruncationNotice(truncation, input.theme);
}
