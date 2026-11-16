// Emphasis marks the spans that `grep` matched inside a line that is already
// colored. Ranges are expressed in visible columns, because the styled text
// carries ANSI sequences that take no room on screen.

export interface Range {
  start: number;
  end: number;
}

export interface MatchOptions {
  literal: boolean;
  ignoreCase: boolean;
}

// The full set the RegExp constructor treats specially; escaping all of it keeps
// a literal pattern (the usual grep input) out of the parser.
const REGEXP_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

// Sticky so the scan reads each escape once instead of rescanning the rest of
// the string. SGR (`ESC [ ... m`) and OSC (`ESC ] ... BEL`) are the only
// sequences the theme and the highlighter emit.
const ANSI_SEQUENCE = /\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/y;

const ESCAPE = "\x1b";

// Past these sizes the backtracking matcher is not worth the risk on a render
// path; the cost is a line without emphasis, never a missing line.
const MAX_REGEX_LENGTH = 256;
export const GREP_MAX_LINE_LENGTH = 500;

function escapeLiteral(pattern: string): string {
  return pattern.replace(REGEXP_METACHARACTERS, "\\$&");
}

// Length of the escape sequence starting at `index`, or zero when the character
// there is visible. The early return is the fast path: this runs once per
// character of every emphasized line.
function ansiLengthAt(text: string, index: number): number {
  if (text[index] !== ESCAPE) return 0;
  ANSI_SEQUENCE.lastIndex = index;
  const match = ANSI_SEQUENCE.exec(text);
  return match === null ? 0 : match[0].length;
}

function visibleLength(text: string): number {
  let raw = 0;
  let visible = 0;
  while (raw < text.length) {
    const ansi = ansiLengthAt(text, raw);
    if (ansi > 0) {
      raw += ansi;
      continue;
    }
    raw += 1;
    visible += 1;
  }
  return visible;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: Range[] = [];
  for (const range of sorted) {
    // Touching ranges are merged as well: two marker pairs back to back render
    // exactly like one, and one pair is cheaper to insert.
    if (merged.length > 0) {
      const previous = merged[merged.length - 1];
      if (range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end);
        continue;
      }
    }
    merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

// Ranges become visible columns here: anything outside the text is dropped
// before the caller can insert a marker where there is no character to wrap.
function clipRanges(ranges: Range[], limit: number): Range[] {
  const clipped: Range[] = [];
  for (const range of ranges) {
    const start = Math.max(0, Math.min(range.start, limit));
    const end = Math.max(0, Math.min(range.end, limit));
    if (start < end) clipped.push({ start, end });
  }
  return mergeRanges(clipped);
}

interface GroupFrame {
  hasQuantifier: boolean;
  hasAlternation: boolean;
}

// Index just past the `?` prefix of a group (`?:`, `?=`, `?!`, `?<=`, `?<!`,
// `?<name>`), so that prefix is not mistaken for a quantifier.
function skipGroupPrefix(source: string, index: number): number {
  if (source[index] !== "?") return index;
  const next = source[index + 1];
  if (next === "<" && source[index + 2] !== "=" && source[index + 2] !== "!") {
    const close = source.indexOf(">", index);
    return close === -1 ? source.length : close + 1;
  }
  return next === "<" ? index + 3 : index + 2;
}

// Catastrophic backtracking needs a repeated group whose body can repeat or
// branch, and a backreference defeats any static check: both are rejected by a
// scan that follows escapes, character classes and the group nesting. A lone
// `?` after a group repeats nothing, so `(https?://)?` stays allowed.
function isBacktrackingSafe(source: string): boolean {
  const stack: GroupFrame[] = [{ hasQuantifier: false, hasAlternation: false }];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      const next = source[index + 1];
      if ((next >= "1" && next <= "9") || (next === "k" && source[index + 2] === "<")) return false;
      index += 2;
      continue;
    }
    if (char === "[") {
      index += 1;
      while (index < source.length && source[index] !== "]") index += source[index] === "\\" ? 2 : 1;
      index += 1;
      continue;
    }
    const top = stack[stack.length - 1];
    if (char === "(") {
      stack.push({ hasQuantifier: false, hasAlternation: false });
      index = skipGroupPrefix(source, index + 1);
      continue;
    }
    if (char === ")" && stack.length > 1) {
      const frame = stack.pop() as GroupFrame;
      const parent = stack[stack.length - 1];
      const after = source[index + 1];
      const repeated = after === "+" || after === "*" || after === "{";
      if (repeated && (frame.hasQuantifier || frame.hasAlternation)) return false;
      parent.hasQuantifier ||= frame.hasQuantifier || repeated || after === "?";
      parent.hasAlternation ||= frame.hasAlternation;
    } else if (char === "|") {
      top.hasAlternation = true;
    } else if (char === "+" || char === "*" || char === "?" || char === "{") {
      top.hasQuantifier = true;
    }
    index += 1;
  }
  return true;
}

export function findMatchRanges(text: string, pattern: string, options: MatchOptions): Range[] {
  // An empty pattern matches everywhere and nowhere at once, and grep never
  // sends it; treating it as "no match" keeps the line plain.
  if (pattern === "" || text.length > GREP_MAX_LINE_LENGTH) return [];
  if (!options.literal && (pattern.length > MAX_REGEX_LENGTH || !isBacktrackingSafe(pattern))) return [];
  const source = options.literal ? escapeLiteral(pattern) : pattern;
  let regex: RegExp;
  try {
    // The unicode flag makes `\p{L}` and friends address the characters grep
    // matched; a pattern only the non-unicode parser accepts (`\-`) fails here
    // and takes the same fallback as any other broken pattern.
    regex = new RegExp(source, options.ignoreCase ? "giu" : "gu");
  } catch {
    // A half-typed pattern must not break the render: no ranges means no emphasis.
    return [];
  }
  const ranges: Range[] = [];
  for (const match of text.matchAll(regex)) {
    // `matchAll` always reports `index`; the `?? 0` also satisfies the optional
    // declaration older lib versions carry.
    const start = match.index ?? 0;
    const end = start + match[0].length;
    // Zero-length matches (`a*`, `\b`) would repeat at the same offset forever
    // and there is no character to wrap.
    if (start === end) continue;
    ranges.push({ start, end });
  }
  return clipRanges(ranges, text.length);
}

type MarkerEvent = { column: number; marker: string };

// `text` arrives from `highlightCode`, so it interleaves visible characters with
// ANSI sequences. Both indices advance together: `raw` walks the string, and
// `visible` is the column a range can address. Markers are only ever inserted on
// a boundary of the second index, which is why a sequence is never split. The
// outer color is not restored after `off`: `\x1b[22m` only cancels the weight,
// which is the accepted behaviour.
export function applyEmphasis(text: string, ranges: Range[], on: string, off: string): string {
  if (ranges.length === 0) return text;
  const inRange = clipRanges(ranges, visibleLength(text));
  if (inRange.length === 0) return text;
  // One open and one close per range, already in column order because the ranges
  // come out of `clipRanges` sorted and non-overlapping.
  const events: MarkerEvent[] = inRange.flatMap((range) => [
    { column: range.start, marker: on },
    { column: range.end, marker: off },
  ]);
  let styled = "";
  let raw = 0;
  let visible = 0;
  let next = 0;
  while (raw < text.length) {
    // Markers go before the token that starts at this column, so an escape
    // sequence is copied whole.
    while (next < events.length && events[next].column === visible) {
      styled += events[next].marker;
      next += 1;
    }
    const ansi = ansiLengthAt(text, raw);
    if (ansi > 0) {
      styled += text.slice(raw, raw + ansi);
      raw += ansi;
      continue;
    }
    styled += text[raw];
    raw += 1;
    visible += 1;
  }
  // A range ending on the last column has no token after it to trigger the check
  // above, and by now only closes can be pending.
  while (next < events.length) {
    styled += events[next].marker;
    next += 1;
  }
  return styled;
}
