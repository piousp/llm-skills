import { highlight as builtInHighlight, highlightLines, type HighlightFn } from "./highlight.ts";
import { DIFF_HEADER, isJsonDocument, moreLinesFooter, styleDiffLine } from "./render-utils.ts";
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
 * servers, codemode, names the host does not know). It mirrors the host's own
 * result fallback line for line, so the only difference a reader can see is the
 * highlighting of a JSON or diff body.
 *
 * `highlightFn` is injected in tests, where `highlightCode` reads the
 * module-global theme.
 */
export function buildGenericResultText(input: GenericInput, highlightFn: HighlightFn = builtInHighlight): string {
  if (input.output === "") return "";
  const lines = input.output.split("\n");
  const visible = input.expanded ? lines : lines.slice(0, COLLAPSED_LINES);
  const kind = input.isError ? "plain" : detectBodyKind(input.output);
  let text = styleLines(kind, visible, input.theme, highlightFn).join("\n");
  const hidden = lines.length - visible.length;
  if (hidden > 0) text += moreLinesFooter(hidden, input.theme, input.expandHint);
  return text;
}
