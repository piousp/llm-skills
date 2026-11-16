import type { MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { detectLanguage } from "./detect-language.ts";

// CommonMark allows up to three spaces of indentation; four spaces open an
// indented code block and a blockquote prefix is not a fence at all, so neither
// matches here and both are copied untouched.
const OPENING_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

const MEMO_SIZE = 32;

interface OpeningFence {
  indent: string;
  fence: string;
  info: string;
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

// `Markdown.render` invokes the transformer on every cache miss, and a resize or
// a theme change invalidates that cache, so the same markdown arrives again and
// again. The transcript holds several messages, hence a small LRU; the width is not
// part of the key because no stage reads it.
export function createMarkdownTransformer(): MarkdownTransformer {
  const memo = new Map<string, string>();
  return (markdown) => {
    const cached = memo.get(markdown);
    if (cached !== undefined) {
      memo.delete(markdown);
      memo.set(markdown, cached);
      return cached;
    }
    let output = markdown;
    try {
      output = transformFenceLanguages(markdown);
    } catch {
      // A fence this module cannot parse must not take the message down: the
      // original markdown still renders with flat colors.
    }
    memo.set(markdown, output);
    if (memo.size > MEMO_SIZE) memo.delete(memo.keys().next().value as string);
    return output;
  };
}

// An info string the author wrote is copied byte for byte, whatever the body
// looks like: detection only fills the gap of an empty one, and a body that
// already carries escape sequences is not source code to guess a grammar for.
function rewriteOpeningFence(line: string, opening: OpeningFence, body: string): string {
  if (opening.info !== "" || body.includes("\x1b")) return line;
  const language = detectLanguage(body);
  return language === undefined ? line : `${opening.indent}${opening.fence}${language}`;
}

function parseOpeningFence(line: string): OpeningFence | undefined {
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
function isClosingFence(line: string, opening: OpeningFence): boolean {
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
