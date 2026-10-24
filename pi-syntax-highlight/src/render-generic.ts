import { highlight as builtInHighlight, highlightLines, type HighlightFn } from "./highlight.ts";
import { DIFF_HEADER, isJsonDocument, moreLinesFooter, splitTrailingNotice, styleDiffLine } from "./render-utils.ts";
import { TOKEN, type StyleTheme } from "./tokens.ts";

// Tools with no renderer of their own collapse to the line count the built-in
// fallback uses (`FALLBACK_PREVIEW_LINES`), so a large MCP payload does not
// flood the transcript.
const COLLAPSED_LINES = 10;

export interface GenericInput {
  output: string;
  expanded: boolean;
  /**
   * A failed tool is painted flat: a diff or JSON body that happens to parse
   * would otherwise disguise the failure as a normal result.
   */
  isError: boolean;
  theme: StyleTheme;
  expandHint: string;
}

// What the body is decides the painter; anything else is painted as content.
type BodyKind = "json" | "diff" | "plain";

function firstNonBlank(lines: string[]): string | undefined {
  return lines.find((line) => line.trim() !== "");
}

function isDiffBody(lines: string[]): boolean {
  const first = firstNonBlank(lines);
  return first !== undefined && DIFF_HEADER.test(first);
}

// Detection runs on the whole body, before the collapsed cut: a JSON document
// whose first twenty lines are an unterminated array does not parse on its own.
function detectBodyKind(body: string): BodyKind {
  if (isJsonDocument(body)) return "json";
  if (isDiffBody(body.split("\n"))) return "diff";
  return "plain";
}

// Styling happens after the cut, so a collapsed view tokenizes the visible lines
// regardless of how much the tool returned. JSON is the one batch call: a
// per-line pass would break multi-line strings and map keys out of context.
function styleLines(kind: BodyKind, lines: string[], theme: StyleTheme, highlightFn: HighlightFn): string[] {
  if (lines.length === 0) return [];
  const fallback = (line: string): string => theme.fg(TOKEN.content, line);
  switch (kind) {
    case "json":
      return highlightLines(lines.join("\n"), "json", fallback, highlightFn);
    case "diff":
      return lines.map((line) => styleDiffLine(line, theme));
    case "plain":
      return lines.map(fallback);
  }
}

/**
 * Body-only rendering for tools that bring no renderer of their own (MCP
 * servers, codemode, names the host does not know). There is no header to
 * reproduce: the generic overlay never invents one.
 *
 * `highlightFn` is injected in tests, where `highlightCode` reads the
 * module-global theme.
 */
export function buildGenericResultText(input: GenericInput, highlightFn: HighlightFn = builtInHighlight): string {
  const output = input.output.trim();
  // An error has no notice slot to split off: every line keeps the content
  // color, which is the rule find and ls follow too.
  const { body, notice } = input.isError ? { body: output, notice: undefined } : splitTrailingNotice(output);
  const lines = body === "" ? [] : body.split("\n");
  const visible = input.expanded ? lines : lines.slice(0, COLLAPSED_LINES);
  const styled = input.isError
    ? visible.map((line) => input.theme.fg(TOKEN.content, line))
    : styleLines(detectBodyKind(body), visible, input.theme, highlightFn);

  let text = "";
  if (styled.length > 0) {
    text += `\n${styled.join("\n")}`;
    // The notice is split off first, so it never counts as a hidden line.
    const hidden = lines.length - styled.length;
    if (hidden > 0) text += moreLinesFooter(hidden, input.theme, input.expandHint);
  }
  if (notice) text += `\n${input.theme.fg(TOKEN.notice, `[${notice}]`)}`;
  return text;
}
