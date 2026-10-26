import type { MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { detectLanguage } from "./detect-language.ts";
import { markdownPalette, type MarkdownPalette } from "./markdown-theme.ts";
import { styleMarkdown } from "./markdown-style.ts";
import type { AnsiTheme } from "./tokens.ts";

// Fences the built-in mermaid transformer already consumed: by the
// time this transformer runs, that one has rewritten the block, and guessing a
// language from a diagram body would repaint it as something else entirely.
const RESERVED_INFO = new Set(["mermaid", "math", "latex", "katex"]);

// CommonMark allows up to three spaces of indentation; four spaces open an
// indented code block and a blockquote prefix is not a fence at all, so neither
// matches here and both are copied untouched.
const OPENING_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

// Exported so the styling pass scans fences with the very same grammar instead of
// keeping a second copy of it: two scanners would eventually disagree about what a
// fence is, and the disagreement would paint body text as markdown.
export interface OpeningFence {
  indent: string;
  fence: string;
  info: string;
}

// The info string carries either the language, an attribute list such as
// `{.ts}`, or the language followed by attributes such as `js title="a"`.
// A token the author wrote is returned as it is: rewriting a correctly labeled
// fence is a visible difference, and an unknown name is still their choice. Only
// an unlabeled fence is worth a guess.
export function normalizeInfoString(info: string, body: string): string {
  return normalizeToken(cleanInfoToken(info), body);
}

// Only the opening line of a closed fence is rewritten; an open fence is still
// arriving, so its body is only a prefix of the final one.
export function transformFenceLanguages(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const opening = parseOpeningFence(lines[index]);
    if (opening === undefined) {
      appendLines(output, lines, index, index);
      index += 1;
      continue;
    }
    const closing = findClosingFence(lines, index + 1, opening);
    if (closing === undefined) {
      // An unclosed fence is a message still arriving, so its body is only a
      // prefix of the final one and any guess would change as the stream grows.
      // The missing closing line is the whole condition, and it stays true after
      // the stream ends.
      appendLines(output, lines, index, lines.length - 1);
      break;
    }
    output.push(rewriteOpeningFence(lines[index], opening, lines.slice(index + 1, closing).join("\n")));
    appendLines(output, lines, index + 1, closing);
    index = closing + 1;
  }
  return output.join("\n");
}

export interface MarkdownTransformerOptions {
  // Read at render time rather than captured at load time: the extension registers
  // before any session exists, and the object the host hands out is a proxy whose
  // reads resolve against the theme in effect, so one captured reference stays
  // valid across a theme switch.
  resolveTheme: () => AnsiTheme | undefined;
}

// `Markdown.render` invokes the transformer on every cache miss, and a resize or
// a theme change invalidates that cache, so the same markdown arrives again and
// again. One entry is enough: the transcript renders one message at a time. The
// key carries the palette signature because a theme switch changes the output
// without changing the input; the width is not part of it because no stage reads it.
export function createMarkdownTransformer(options: MarkdownTransformerOptions): MarkdownTransformer {
  let memo: { input: string; signature: string; output: string } | undefined;
  return (markdown, context) => {
    // Only assistant prose is styled: a user message renders its backslash escapes
    // verbatim (`user-message.js` sets `preserveBackslashEscapes`), which would make
    // the restored code-span delimiters visible, and thinking text is painted with an
    // italic default style this pass would degrade.
    const palette = context.messageType === "assistant" ? paletteOrUndefined(options.resolveTheme) : undefined;
    const signature = palette?.signature ?? "";
    if (memo !== undefined && memo.input === markdown && memo.signature === signature) return memo.output;
    let output = markdown;
    try {
      output = transformFenceLanguages(markdown);
    } catch {
      // A fence this module cannot parse must not take the message down: the
      // original markdown still renders with flat colors.
      output = markdown;
    }
    if (palette !== undefined) {
      try {
        output = styleMarkdown(output, palette);
      } catch {
        // Styling is the optional half of the pipeline: the fence labels above are
        // already in `output` and stay, so a failure costs the colors and nothing else.
      }
    }
    memo = { input: markdown, signature, output };
    return output;
  };
}

// The derivation is the one step that can fail: `resolveTheme` answers `undefined`
// before a theme is captured, and the host's theme throws while uninitialized
// (`theme.js` reads `globalThis` and throws when nothing is installed). Neither may
// reach the renderer, so no palette means no styling instead of no message.
function paletteOrUndefined(resolveTheme: () => AnsiTheme | undefined): MarkdownPalette | undefined {
  try {
    const theme = resolveTheme();
    return theme === undefined ? undefined : markdownPalette(theme);
  } catch {
    return undefined;
  }
}

function rewriteOpeningFence(line: string, opening: OpeningFence, body: string): string {
  const token = cleanInfoToken(opening.info);
  if (RESERVED_INFO.has(token.toLowerCase())) return line;
  const language = normalizeToken(token, body);
  if (language === opening.info) return line;
  return `${opening.indent}${opening.fence}${language}`;
}

export function parseOpeningFence(line: string): OpeningFence | undefined {
  const matched = OPENING_FENCE.exec(line);
  if (matched === null) return undefined;
  const fence = matched[2] ?? "";
  const info = (matched[3] ?? "").trim();
  // CommonMark forbids the fence character inside the info string of its own
  // fence, so such a line opens nothing and the rest of the message is copied:
  // it is prose that happens to start with three ticks or tildes.
  if (info.includes(fence.charAt(0))) return undefined;
  return { indent: matched[1] ?? "", fence, info };
}

function findClosingFence(lines: readonly string[], start: number, opening: OpeningFence): number | undefined {
  for (let index = start; index < lines.length; index += 1) {
    if (isClosingFence(lines[index], opening)) return index;
  }
  return undefined;
}

// A closing fence is the opening character repeated at least as many times as the
// opener, indented at most three spaces, with nothing but spaces after it.
export function isClosingFence(line: string, opening: OpeningFence): boolean {
  return closingFencePattern(opening).test(line);
}

// The only fence characters are a backtick and a tilde (the opening pattern
// admits nothing else) and neither is special in a regular expression.
function closingFencePattern(opening: OpeningFence): RegExp {
  const character = opening.fence.charAt(0);
  return new RegExp(`^ {0,3}${character}{${opening.fence.length},} *$`);
}

// A loop instead of `push(...slice)` because a fence body can be arbitrarily
// long and spreading it would hit the argument limit.
function appendLines(target: string[], source: readonly string[], start: number, end: number): void {
  for (const line of source.slice(start, end + 1)) target.push(line);
}

// Detection only fills a gap: a label the author wrote is returned whatever the
// body looks like.
function normalizeToken(token: string, body: string): string {
  if (token !== "") return token;
  return detectLanguage(body) ?? "";
}

function cleanInfoToken(info: string): string {
  const first = info.trim().split(/\s+/)[0] ?? "";
  // `{.ts}`, `{ts,}`, and a bare `.ts` name the same language; the attributes
  // after the language (`js title="a"`) were cut by the split.
  const unwrapped = first.startsWith("{") ? first.slice(1) : first;
  return unwrapped.replace(/^\.+/, "").replace(/[`,}]+$/, "");
}
