import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { highlightLines, type HighlightFn } from "./highlight.ts";
import { renderToolPath } from "./render-path.ts";
import { replaceTabs } from "./render-utils.ts";
import { TOKEN, type StyleTheme } from "./tokens.ts";

// The built-in write renderer shows 10 lines when collapsed; any other number is
// a visible difference against stock pi.
const COLLAPSED_LINES = 10;

// While the argument is still streaming the tail is repainted on every frame and
// tokenizing it costs more than it shows: the prefix is what the reader watches.
const PARTIAL_HIGHLIGHT_LINES = 60;

const INVALID_CONTENT = "[invalid content arg - expected string]";

export interface WriteResultInput {
  output: string;
  isError: boolean;
  theme: StyleTheme;
}

export interface WriteCallInput {
  /** The argument's path, "" when the call does not carry one. */
  path: string;
  /** "" is an argument that has not arrived yet, null one that is not a string. */
  content: string | null;
  argsComplete: boolean;
  expanded: boolean;
  theme: StyleTheme;
  expandHint: string;
  highlight: HighlightFn;
  cwd: string | undefined;
}

// The tool reports a success with no text at all, so only a failure has a body
// to paint; the caller drops the empty string instead of drawing a blank row.
export function buildWriteResultText(input: WriteResultInput): string {
  if (!input.isError || input.output === "") return "";
  return `\n${input.theme.fg(TOKEN.broken, input.output)}`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end);
}

function previewLines(lines: string[], language: string | undefined, input: WriteCallInput): string[] {
  const fallback = (line: string): string => input.theme.fg(TOKEN.plain, line);
  if (language === undefined) return lines.map(fallback);
  const head = input.argsComplete ? lines : lines.slice(0, PARTIAL_HIGHLIGHT_LINES);
  const highlighted = highlightLines(head.join("\n"), language, fallback, input.highlight);
  return [...highlighted, ...lines.slice(head.length).map(fallback)];
}

// The header the built-in writes, plus the preview of what is about to be
// written. The pipeline is the built-in's, with the streaming case bounded: the
// trailing blank lines go before the count and the tab expansion, the content is
// tokenized as one block, and the footer keeps its wording.
export function buildWriteCallText(input: WriteCallInput): string {
  const theme = input.theme;
  const title = `${theme.fg("toolTitle", theme.bold("write"))} ${renderToolPath(input.path, theme, input.cwd)}`;
  if (input.content === null) return `${title}\n\n${theme.fg(TOKEN.broken, INVALID_CONTENT)}`;
  if (input.content === "") return title;
  // Carriage returns go before anything is measured, so a CRLF argument does not
  // show as an extra blank line; the three spaces of a tab are the indent the
  // rest of the package renders against.
  const content = replaceTabs(input.content.replace(/\r/g, ""));
  const lines = trimTrailingEmptyLines(content.split("\n"));
  const language = input.path === "" ? undefined : getLanguageFromPath(input.path);
  const styled = previewLines(lines, language, input);
  const total = lines.length;
  const limit = input.expanded ? total : COLLAPSED_LINES;
  let text = `${title}\n\n${styled.slice(0, limit).join("\n")}`;
  const hidden = total - limit;
  if (hidden > 0) {
    text += `${theme.fg("muted", `\n... (${hidden} more lines, ${total} total,`)} ${input.expandHint}${theme.fg("muted", ")")}`;
  }
  return text;
}
