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

export function findMatchRanges(text: string, pattern: string, options: MatchOptions): Range[] {
  // An empty pattern matches everywhere and nowhere at once, and grep never
  // sends it; treating it as "no match" keeps the line plain.
  if (pattern === "") return [];
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
