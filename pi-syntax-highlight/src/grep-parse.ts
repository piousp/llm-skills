// Grep writes matches as `path:line: text` and context lines as
// `path-line- text`. The separator is repeated around the line number, which is
// what makes paths containing `:` or `-` parseable: the lazy path plus the digit
// anchor backtrack until both separators agree.
export const GREP_LINE_PATTERN = /^(?<path>.*?)(?<sep>:|-)(?<line>\d+)\k<sep> (?<text>[\s\S]*)$/;

export const UNREADABLE_TEXT = "(unable to read file)";

export type GrepLine =
  | { kind: "match"; path: string; line: number; text: string }
  | { kind: "context"; path: string; line: number; text: string }
  | { kind: "unreadable"; path: string; line: number }
  | { kind: "notice"; text: string }
  | { kind: "plain"; text: string };

// The tool appends its limit block as one bracketed line and stock pi counts it
// as body text, so it is a body line here too, painted apart from a plain one.
const NOTICE_LINE = /^\[.*\]$/;

export function parseGrepLine(line: string): GrepLine {
  const matched = parseMatchLine(line);
  if (matched !== undefined) return matched;
  return NOTICE_LINE.test(line) ? { kind: "notice", text: line } : { kind: "plain", text: line };
}

function parseMatchLine(line: string): GrepLine | undefined {
  const groups = GREP_LINE_PATTERN.exec(line)?.groups;
  if (groups === undefined) return undefined;
  const path = groups.path ?? "";
  const number = Number(groups.line ?? "");
  const text = groups.text ?? "";
  if (text === UNREADABLE_TEXT) return { kind: "unreadable", path, line: number };
  // The notice is decided after the unreadable marker and outranks a match whose
  // own line happens to be one bracketed block.
  if (NOTICE_LINE.test(line)) return undefined;
  if (groups.sep === ":") return { kind: "match", path, line: number, text };
  return { kind: "context", path, line: number, text };
}

export function parseGrepOutput(output: string): GrepLine[] {
  return output === "" ? [] : output.split("\n").map((line) => parseGrepLine(line));
}
