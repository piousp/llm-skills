import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { applyEmphasis, findMatchRanges, type MatchOptions } from "./emphasis.ts";
import { UNREADABLE_TEXT, parseGrepLine, type GrepLine } from "./grep-parse.ts";
import { highlightLines, type HighlightFn } from "./highlight.ts";
import { colonPrefix, moreLinesFooter, truncatedNotice } from "./render-utils.ts";
import { BOLD_OFF, BOLD_ON, TOKEN, type StyleTheme } from "./tokens.ts";

const COLLAPSED_LINES = 15;

// The pattern as the arguments carry it, once validated. Anything that is not a
// non-empty string leaves the line as it is, which is also what grep does when
// it is called without a pattern.
interface EmphasisPattern extends MatchOptions {
  pattern: string;
}

export interface GrepInput {
  output: string;
  expanded: boolean;
  pattern: { pattern?: unknown; literal?: unknown; ignoreCase?: unknown };
  details:
    | {
        matchLimitReached?: number;
        linesTruncated?: boolean;
        truncation?: { truncated?: boolean; maxBytes?: number };
      }
    | undefined;
  theme: StyleTheme;
  expandHint: string;
  highlight: HighlightFn;
}

type MatchLine = Extract<GrepLine, { kind: "match" }>;

function languageOf(entry: GrepLine): string | undefined {
  return entry.kind === "match" || entry.kind === "context" ? getLanguageFromPath(entry.path) : undefined;
}

function pathOf(entry: GrepLine): string | undefined {
  return entry.kind === "match" || entry.kind === "context" ? entry.path : undefined;
}

function entryText(entry: GrepLine): string {
  return entry.kind === "match" || entry.kind === "context" ? entry.text : "";
}

function resolvePattern(pattern: GrepInput["pattern"]): EmphasisPattern | undefined {
  if (typeof pattern.pattern !== "string" || pattern.pattern === "") return undefined;
  return { pattern: pattern.pattern, literal: pattern.literal === true, ignoreCase: pattern.ignoreCase === true };
}

// The ranges are computed on the plain text, so they address visible columns;
// `applyEmphasis` maps them onto the same columns of the highlighted string. The
// path and the line number are built afterwards, so they never carry a marker.
function emphasize(line: MatchLine, styled: string, pattern: EmphasisPattern | undefined): string {
  if (pattern === undefined) return styled;
  return applyEmphasis(styled, findMatchRanges(line.text, pattern.pattern, pattern), BOLD_ON, BOLD_OFF);
}

// The path arrives already colored, so each line kind decides its own weight:
// the path of a match is bold, the path of an unreadable entry is not.
function styleLine(
  entry: GrepLine,
  highlighted: string | undefined,
  theme: StyleTheme,
  pattern: EmphasisPattern | undefined,
): string {
  switch (entry.kind) {
    case "plain":
      return theme.fg(TOKEN.content, entry.text);
    case "notice":
      return theme.fg(TOKEN.notice, entry.text);
    case "unreadable":
      return `${colonPrefix(theme.fg(TOKEN.path, entry.path), entry.line, theme)} ${theme.fg(TOKEN.broken, UNREADABLE_TEXT)}`;
    case "match": {
      const content = highlighted ?? theme.fg(TOKEN.content, entry.text);
      const path = theme.bold(theme.fg(TOKEN.path, entry.path));
      return `${colonPrefix(path, entry.line, theme)} ${emphasize(entry, content, pattern)}`;
    }
    case "context":
      return `${theme.fg(TOKEN.context, entry.path)}-${theme.fg(TOKEN.context, String(entry.line))}- ${highlighted ?? theme.fg(TOKEN.context, entry.text)}`;
  }
}

// Contiguous lines from the same file are highlighted in a single call: per-line
// tokenizing would break multi-line constructs, and a call per line costs a cache
// lookup per line. The run also stops at a path change, so a file's lines are
// never tokenized together with another file's.
function styleLines(entries: GrepLine[], input: GrepInput, pattern: EmphasisPattern | undefined): string[] {
  const styled: string[] = [];
  const fallback = (line: string): string => input.theme.fg(TOKEN.content, line);
  let index = 0;
  while (index < entries.length) {
    const language = languageOf(entries[index]);
    const path = pathOf(entries[index]);
    if (language === undefined) {
      styled.push(styleLine(entries[index], undefined, input.theme, pattern));
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < entries.length && languageOf(entries[end]) === language && pathOf(entries[end]) === path) end += 1;
    const run = entries.slice(index, end);
    const code = run.map((entry) => entryText(entry)).join("\n");
    const highlighted = highlightLines(code, language, fallback, input.highlight);
    run.forEach((entry, offset) => {
      styled.push(styleLine(entry, highlighted[offset], input.theme, pattern));
    });
    index = end;
  }
  return styled;
}

export function buildGrepResultText(input: GrepInput): string {
  // grep appends its own "[N matches limit reached. …]" block, and stock pi
  // counts it as one more body line: it is painted as a notice and it counts
  // toward the collapsed cut like any other line.
  const output = input.output.trim();
  const bodyLines = output === "" ? [] : output.split("\n");
  const visible = input.expanded ? bodyLines : bodyLines.slice(0, COLLAPSED_LINES);
  const pattern = resolvePattern(input.pattern);
  const styled = styleLines(visible.map((line) => parseGrepLine(line)), input, pattern);

  let text = "";
  if (styled.length > 0) {
    text += `\n${styled.join("\n")}`;
    const hidden = bodyLines.length - styled.length;
    if (hidden > 0) text += moreLinesFooter(hidden, input.theme, input.expandHint);
  }
  // The details-derived warning is not part of the body, so it stays after the
  // footer exactly as stock pi prints it.
  text += truncatedNotice(
    {
      limitCount: input.details?.matchLimitReached,
      limitLabel: "matches limit",
      truncation: input.details?.truncation,
      extra: input.details?.linesTruncated ? ["some lines truncated"] : [],
    },
    input.theme,
  );
  return text;
}
