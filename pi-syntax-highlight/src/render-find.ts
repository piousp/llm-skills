import { buildListBody, truncatedNotice } from "./render-utils.ts";
import { classifyPathLine, stylePath } from "./style-path.ts";
import { TOKEN, type StyleTheme } from "./tokens.ts";

// The built-in find renderer shows 20 lines when collapsed; any other number
// is a visible difference against stock pi.
const COLLAPSED_LINES = 20;

export interface PathListInput {
  output: string;
  expanded: boolean;
  /**
   * A failed search is painted flat: styling it by path family would read as a
   * normal listing, and stock pi leaves the failure in the content color.
   */
  isError: boolean;
  details:
    | {
        resultLimitReached?: number;
        truncation?: { truncated?: boolean; maxBytes?: number };
      }
    | undefined;
  theme: StyleTheme;
  expandHint: string;
}

function stylePathLine(line: string, theme: StyleTheme): string {
  const entry = classifyPathLine(line);
  switch (entry.kind) {
    case "dir":
    case "file":
      return stylePath(entry.path, theme);
    case "notice":
      return theme.fg(TOKEN.notice, entry.text);
    case "plain":
      return theme.fg(TOKEN.empty, entry.text);
  }
}

export function buildFindResultText(input: PathListInput): string {
  // `find` ends its output with its own "[N results limit reached. Use
  // limit=...]" block, and stock pi counts it as one more body line: it is
  // painted as a notice and it counts toward the collapsed cut.
  let text = buildListBody({
    body: input.output.trim(),
    expanded: input.expanded,
    collapsedLines: COLLAPSED_LINES,
    theme: input.theme,
    expandHint: input.expandHint,
    styleLine: (line) =>
      input.isError ? input.theme.fg(TOKEN.content, line) : stylePathLine(line, input.theme),
  });
  // Stock pi paints the details-derived warning last, so it is appended instead
  // of passed into the body builder.
  text += truncatedNotice(
    {
      limitCount: input.details?.resultLimitReached,
      limitLabel: "results limit",
      truncation: input.details?.truncation,
    },
    input.theme,
  );
  return text;
}
