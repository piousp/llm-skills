import { isClosingFence, parseOpeningFence, type OpeningFence } from "./markdown-fence-lang.ts";
import type { MarkdownPalette } from "./markdown-theme.ts";
import { FG_DEFAULT, ITALIC_OFF, ITALIC_ON, UNDERLINE_OFF, UNDERLINE_ON } from "./tokens.ts";

// CommonMark allows up to three spaces before a block marker. The text after the
// marker is required: a bare `## ` is a heading still arriving while the message
// streams, and wrapping an empty span would only add sequences around nothing.
const HEADING = /^( {0,3})(#{1,6})([ \t]+)(.*)$/;

// The `>` run is captured whole so a nested quote keeps every marker exactly where
// the renderer expects to find it before it prepends its own border.
const QUOTE = /^( {0,3})((?:>[ \t]?)+)(.*)$/;

// The pass writes its own escapes, and the mermaid transformer that runs before it
// may have written some too. A line that already carries one is copied verbatim:
// that single guard is what makes a second run over the same text a no-op, and
// what keeps a diagram from being restyled as a blockquote.
const ESCAPE = "\u001b";

// A backtick preceded by a backslash: the escape a code span needs, and also the
// escape the pass itself emits, so a line carrying one is never rewritten twice.
// Rewriting half of it would turn visible text into markup, and the same guard
// covers a span whose text ends in a backslash, because the tick after that
// backslash is escaped too.
const ESCAPED_BACKTICK = "\\`";

// The delimiters the renderer drops from a code span, re-emitted escaped so
// `marked` hands them back as text and they take the style of their context.
const RESTORED_BACKTICK = ESCAPED_BACKTICK;

// The host already paints every heading bold, so the level is told apart by one
// attribute that survives the host's own prefixes: h1 and h3 take italic, h2
// underline, and h4-h6 nothing, since the renderer prints their `#` prefix
// visibly and that is distinction enough.
const ITALIC = { on: ITALIC_ON, off: ITALIC_OFF };
const UNDERLINE = { on: UNDERLINE_ON, off: UNDERLINE_OFF };

// Styles the constructs the transformer alone can reach, leaving every visible
// character where it was: headings and blockquote lines get their sequences inside
// the line, and the delimiters of an inline code span come back as escaped text.
// Fences are the one place both stages agree not to touch (see `markdown-fence-lang`).
export function styleMarkdown(markdown: string, palette: MarkdownPalette): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let opening: OpeningFence | undefined;
  for (const line of lines) {
    if (opening !== undefined) {
      // Inside a fence every line is literal body, closing line included.
      output.push(line);
      if (isClosingFence(line, opening)) opening = undefined;
      continue;
    }
    const fence = parseOpeningFence(line);
    if (fence !== undefined) {
      output.push(line);
      opening = fence;
      continue;
    }
    if (line.includes(ESCAPE)) {
      output.push(line);
      continue;
    }
    output.push(styleLine(restoreInlineCode(line), palette));
  }
  return output.join("\n");
}

// Headings and quote markers are mutually exclusive (`#` and `>` cannot start the
// same line), so the order only documents which construct owns the line.
function styleLine(line: string, palette: MarkdownPalette): string {
  const heading = HEADING.exec(line);
  if (heading !== null) {
    const text = heading[4] ?? "";
    if (text !== "") {
      const attribute = headingAttribute((heading[2] ?? "").length);
      const open = palette.accent + (attribute?.on ?? "");
      if (open === "") return line;
      // Closed in reverse order: the attribute first, then the color it borrowed.
      const close = (attribute?.off ?? "") + (palette.accent === "" ? "" : FG_DEFAULT);
      return `${heading[1] ?? ""}${heading[2] ?? ""}${heading[3] ?? ""}${open}${text}${close}`;
    }
  }
  if (palette.quoteOpen === "") return line;
  const quote = QUOTE.exec(line);
  if (quote === null) return line;
  const text = quote[3] ?? "";
  // A quote line with no text is the blank line between two quote paragraphs: the
  // host prints it empty, so there is nothing to color and no pair to add.
  if (text === "") return line;
  return `${quote[1] ?? ""}${quote[2] ?? ""}${palette.quoteOpen}${text}${palette.quoteClose}`;
}

function headingAttribute(level: number): { on: string; off: string } | undefined {
  if (level === 1 || level === 3) return ITALIC;
  if (level === 2) return UNDERLINE;
  return undefined;
}

// The renderer prints a code span without its backticks (`markdown.js` styles
// `token.text` only), so the delimiters come back as escaped text. Nothing is
// injected: the delimiters inherit the style of the context they sit in, which
// degrades nothing inside a link, a heading or a table cell.
function restoreInlineCode(line: string): string {
  if (line.includes(ESCAPED_BACKTICK)) return line;
  let output = "";
  let index = 0;
  while (index < line.length) {
    const open = singleBacktickAt(line, index);
    if (open === -1) return output + line.slice(index);
    const close = singleBacktickAt(line, open + 1);
    // Half a pair is a span still arriving: the line stays as it is until the
    // closing tick shows up, which is the same moment the renderer turns it into a
    // code span.
    if (close === -1) return line;
    const text = line.slice(open + 1, close);
    // A span holding a double tick is a multi-backtick delimiter this pass does not
    // model. An empty span cannot reach here (`singleBacktickAt` refuses a run of
    // two), and the check stays as the invariant the pair is written under.
    if (text === "" || text.includes("``")) return line;
    output += line.slice(index, open) + RESTORED_BACKTICK + text + RESTORED_BACKTICK;
    index = close + 1;
  }
  return output;
}

// Returns the index of the next backtick that stands alone, or -1. A run of two or
// more is a different delimiter, so it is skipped rather than taken as an edge.
function singleBacktickAt(line: string, from: number): number {
  for (let index = line.indexOf("`", from); index !== -1; index = line.indexOf("`", index + 1)) {
    if (line[index - 1] === "`" || line[index + 1] === "`") continue;
    return index;
  }
  return -1;
}
