import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatReadLineRange,
  formatSize,
  getLanguageFromPath,
  getPackageDir,
  keyText,
} from "@earendil-works/pi-coding-agent";
import { highlightLines, type HighlightFn } from "./highlight.ts";
import { absolutePath, relativeToCwdOrAbsolute, renderToolPath } from "./render-path.ts";
import { moreLinesFooter, replaceTabs } from "./render-utils.ts";
import { BOLD_OFF, BOLD_ON, TOKEN, type StyleTheme } from "./tokens.ts";

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

// The compact header the built-in prints instead of the full path for the files
// the agent reads about itself.
const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const SKILL_FILE_NAME = "SKILL.md";
const PI_DOC_PREFIXES = ["docs/", "examples/"];
const PI_DOC_README = "README.md";

// `keyText` reads the live keybinding table, which is empty outside a session;
// the built-in default keeps the hint readable instead of " ( to expand)".
const EXPAND_KEYBINDING = "app.tools.expand";
const DEFAULT_EXPAND_KEY = "ctrl+o";

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
  /** 1-based first line the tool read, which is also the first line number shown. */
  offset: number | undefined;
  details: { truncation?: ReadTruncation } | undefined;
  expanded: boolean;
  isError: boolean;
  /** The result carries an image block, so the body is not file text. */
  hasImage: boolean;
  theme: StyleTheme;
  expandHint: string;
  highlight: HighlightFn;
}

export interface ReadCallInput {
  path: string;
  offset: number | undefined;
  limit: number | undefined;
  /** The transcript is collapsed, so the built-in header is the compact one. */
  compact: boolean;
  theme: StyleTheme;
  cwd: string | undefined;
}

// The two compact headers the built-in prints: a skill is announced by name, a
// resource of the agent or of pi by a cwd-relative label.
type ReadClassification = { kind: "skill" | "resource"; label: string };

export function readPath(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const value = (args as { file_path?: unknown; path?: unknown }).file_path ?? (args as { path?: unknown }).path;
  return typeof value === "string" ? value : "";
}

// Line counts arrive as numbers from the schema and as numeric strings from a
// restored session, so both are read; a value that is not a finite number leaves
// the field unset and the caller falls back to the built-in default.
function lineCount(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return undefined;
  // Fractional and non-positive offsets do not name a line; the tool itself
  // rejects them, so the clamp only keeps the gutter printable.
  return Math.max(1, Math.floor(parsed));
}

export function readOffset(args: unknown): number | undefined {
  return lineCount(typeof args === "object" && args !== null ? (args as { offset?: unknown }).offset : undefined);
}

export function readLimit(args: unknown): number | undefined {
  return lineCount(typeof args === "object" && args !== null ? (args as { limit?: unknown }).limit : undefined);
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
// constructs, and the cached highlighter already caps how many lines it takes.
function styleLines(contents: string[], language: string | undefined, input: ReadResultInput): string[] {
  const fallback = (line: string): string => input.theme.fg(TOKEN.plain, line);
  if (language === undefined) return contents.map(fallback);
  return highlightLines(contents.join("\n"), language, fallback, input.highlight);
}

// The real line numbers of the file: `offset` is where the tool started reading,
// so the first visible line is not always line 1. Numbers are right-aligned to
// the widest one on screen, and a blank line has no trailing space to paint.
// That last decision belongs to the raw line: a colored line never is empty.
function numbered(rawLines: string[], styledLines: string[], start: number, theme: StyleTheme): string {
  const width = String(start + rawLines.length - 1).length;
  const separator = theme.fg(TOKEN.context, " |");
  return rawLines
    .map((raw, index) => {
      const number = theme.fg(TOKEN.lineNumber, String(start + index).padStart(width));
      return raw === "" ? `${number}${separator}` : `${number}${separator} ${styledLines[index]}`;
    })
    .join("\n");
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
  // text: no gutter and no grammar, exactly like the built-in.
  const fileText = !input.isError && !input.hasImage && !firstLineExceedsLimit;
  const limit = input.expanded ? lines.length : COLLAPSED_LINES;
  // The tab expansion happens before the grammar and before the gutter: both
  // measure the columns the terminal will show.
  const contents = lines.slice(0, limit).map((line) => replaceTabs(line));
  const styled = styleLines(contents, fileText ? languageOf(input.path) : undefined, input);

  let text = "";
  if (styled.length > 0) {
    text += `\n${fileText ? numbered(contents, styled, input.offset ?? 1, input.theme) : styled.join("\n")}`;
  }
  // The notice is the last body line of the built-in output, so it stays before
  // the footer even though it is no longer counted as one of the file's lines.
  if (notice !== undefined) text += `\n${input.theme.fg(TOKEN.notice, `[${notice}]`)}`;
  const hidden = lines.length - limit;
  if (hidden > 0) text += moreLinesFooter(hidden, input.theme, input.expandHint);
  return text + readTruncationNotice(truncation, input.theme);
}

// The label the pi package directory gives a path inside it, or undefined when
// the path is outside and when the package root cannot be located (a global
// install with no readable package directory).
function piDocsLabel(path: string): string | undefined {
  let root: string;
  try {
    root = resolve(getPackageDir());
  } catch {
    return undefined;
  }
  const relativePath = relative(root, resolve(path));
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return undefined;
  }
  const label = relativePath.split(sep).join("/");
  return label === PI_DOC_README || PI_DOC_PREFIXES.some((prefix) => label.startsWith(prefix)) ? label : undefined;
}

function classifyReadPath(rawPath: string, cwd: string | undefined): ReadClassification | undefined {
  if (rawPath === "") return undefined;
  const absolute = absolutePath(rawPath, cwd);
  const fileName = basename(absolute);
  if (fileName === SKILL_FILE_NAME) return { kind: "skill", label: basename(dirname(absolute)) || fileName };
  // The built-in also folds pi's own documentation and examples into a label;
  // every other file keeps the full header.
  const docs = piDocsLabel(absolute);
  if (docs !== undefined) return { kind: "resource", label: docs };
  if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
    return { kind: "resource", label: relativeToCwdOrAbsolute(absolute, cwd) };
  }
  return undefined;
}

function expandKey(): string {
  try {
    return keyText(EXPAND_KEYBINDING) || DEFAULT_EXPAND_KEY;
  } catch {
    return DEFAULT_EXPAND_KEY;
  }
}

// The `:start-end` the header appends, omitted when the call carries no range.
function lineRange(offset: number | undefined, limit: number | undefined, theme: StyleTheme): string {
  const range = formatReadLineRange(offset, limit);
  return range === "" ? "" : theme.fg(TOKEN.notice, range);
}

function fullReadCall(input: ReadCallInput): string {
  const title = input.theme.fg("toolTitle", input.theme.bold("read"));
  return `${title} ${renderToolPath(input.path, input.theme, input.cwd)}${lineRange(input.offset, input.limit, input.theme)}`;
}

function compactReadCall(classification: ReadClassification, input: ReadCallInput): string {
  const range = lineRange(input.offset, input.limit, input.theme);
  const hint = input.theme.fg("dim", ` (${expandKey()} to expand)`);
  if (classification.kind === "skill") {
    // The built-in spells the bold markers itself so the brackets share them.
    const label = input.theme.fg("customMessageLabel", `${BOLD_ON}[skill]${BOLD_OFF} `);
    return `${label}${input.theme.fg("customMessageText", classification.label)}${range}${hint}`;
  }
  const title = input.theme.fg("toolTitle", input.theme.bold(`read ${classification.kind}`));
  return `${title} ${input.theme.fg(TOKEN.path, classification.label)}${range}${hint}`;
}

export function buildReadCallText(input: ReadCallInput): string {
  const classification = input.compact ? classifyReadPath(input.path, input.cwd) : undefined;
  return classification === undefined ? fullReadCall(input) : compactReadCall(classification, input);
}
