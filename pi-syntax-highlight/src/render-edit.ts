import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { diffWords } from "diff";
import { applyEmphasis, type Range } from "./emphasis.ts";
import { highlightLines, type HighlightFn } from "./highlight.ts";
import { replaceTabs } from "./render-utils.ts";
import { INVERSE_OFF, INVERSE_ON, TOKEN, type StyleTheme } from "./tokens.ts";

// The display diff `edit` carries in its details: one marker, the line number
// right-aligned to the widest one, one space, then the content:
//
//   +12 const b = 2;
//   -12 const a = 1;
//     12  unchanged
//        ...
//
// A line outside that grammar is passed through untouched, so nothing is lost if
// the host ever widens the shape.
const DIFF_LINE = /^([+-\s])(\s*\d*)\s(.*)$/;

const ELISION = "...";

const DIFF_KIND_TOKEN = {
  added: "toolDiffAdded",
  removed: "toolDiffRemoved",
  context: "toolDiffContext",
} as const;

export type EditDiffKind = keyof typeof DIFF_KIND_TOKEN;

export type EditDiffLine =
  | { kind: EditDiffKind; prefix: string; number: string; content: string }
  | { kind: "elision"; prefix: string; number: string; content: string }
  | { kind: "other"; raw: string };

type DiffBodyLine = Extract<EditDiffLine, { kind: EditDiffKind }>;

export interface EditDiffInput {
  diff: string;
  /** The argument's path, "" when the call does not carry one. */
  path: string;
  theme: StyleTheme;
  highlight: HighlightFn;
}

export function classifyEditDiffLine(line: string): EditDiffLine {
  const match = DIFF_LINE.exec(line);
  if (match === null) return { kind: "other", raw: line };
  const [, prefix, number, content] = match;
  // The elision the display diff uses between two hunks has no number and must
  // not be read as a body line.
  if (number.trim() === "" && content === ELISION) return { kind: "elision", prefix, number, content };
  if (prefix === "+") return { kind: "added", prefix, number, content };
  if (prefix === "-") return { kind: "removed", prefix, number, content };
  return { kind: "context", prefix, number, content };
}

function bodyLine(line: EditDiffLine | undefined, kind?: EditDiffKind): DiffBodyLine | undefined {
  if (line === undefined || line.kind === "elision" || line.kind === "other") return undefined;
  return kind === undefined || line.kind === kind ? line : undefined;
}

// A number without digits is the placeholder of an elision: it is emitted as the
// spaces it is, because the surrounding padding is the alignment.
function paintedNumber(number: string, theme: StyleTheme): string {
  return /\d/.test(number) ? theme.fg(TOKEN.lineNumber, number) : number;
}

function renderLine(line: EditDiffLine, content: string, theme: StyleTheme): string {
  if (line.kind === "other") return theme.fg(TOKEN.content, line.raw);
  const color = DIFF_KIND_TOKEN[line.kind === "elision" ? "context" : line.kind];
  return `${theme.fg(color, line.prefix)}${paintedNumber(line.number, theme)} ${content}`;
}

// One highlight call per contiguous run of the same kind: a per-line pass would
// break multi-line constructs, and the run is where the grammar's context ends
// anyway. Without a grammar every line keeps its kind's color.
function highlightRun(lines: DiffBodyLine[], language: string | undefined, input: EditDiffInput): string[] {
  const contents = lines.map((line) => replaceTabs(line.content));
  const kind = lines[0].kind;
  const fallback = (line: string): string => input.theme.fg(DIFF_KIND_TOKEN[kind], line);
  if (language === undefined) return contents.map(fallback);
  return highlightLines(contents.join("\n"), language, fallback, input.highlight);
}

interface ChangedRanges {
  removed: Range[];
  added: Range[];
}

function leadingWhitespace(value: string): number {
  return value.length - value.trimStart().length;
}

function pushRange(ranges: Range[], start: number, end: number): void {
  if (start < end) ranges.push({ start, end });
}

// The visible columns the word diff marks on each side of a modification. The
// walk mirrors the built-in `renderIntraLineDiff`: an unchanged part advances
// both columns, a removed one exists on the old side only and an added one on the
// new side only, and the leading whitespace of the first change on either side is
// never marked because it is indentation, not a change.
function changedRanges(removedContent: string, addedContent: string): ChangedRanges {
  const ranges: ChangedRanges = { removed: [], added: [] };
  let removedColumn = 0;
  let addedColumn = 0;
  let firstRemoved = true;
  let firstAdded = true;
  for (const part of diffWords(removedContent, addedContent)) {
    const length = part.value.length;
    if (part.removed === true) {
      pushRange(ranges.removed, removedColumn + (firstRemoved ? leadingWhitespace(part.value) : 0), removedColumn + length);
      removedColumn += length;
      firstRemoved = false;
      continue;
    }
    if (part.added === true) {
      pushRange(ranges.added, addedColumn + (firstAdded ? leadingWhitespace(part.value) : 0), addedColumn + length);
      addedColumn += length;
      firstAdded = false;
      continue;
    }
    removedColumn += length;
    addedColumn += length;
  }
  return ranges;
}

// The pair the built-in marks intra-line: exactly one removed line directly
// followed by exactly one added one. Anything else (several removed lines, a
// standalone addition) keeps the per-kind colors only.
function modificationAt(lines: EditDiffLine[], index: number): { removed: DiffBodyLine; added: DiffBodyLine } | undefined {
  const removed = bodyLine(lines[index], "removed");
  if (removed === undefined) return undefined;
  const added = bodyLine(lines[index + 1], "added");
  if (added === undefined) return undefined;
  if (bodyLine(lines[index + 2], "added") !== undefined) return undefined;
  return { removed, added };
}

function renderModification(
  pair: { removed: DiffBodyLine; added: DiffBodyLine },
  language: string | undefined,
  input: EditDiffInput,
): string[] {
  // The word diff runs on the tab-expanded content, which is also what the
  // highlighter receives, so the columns line up on screen.
  const removedContent = replaceTabs(pair.removed.content);
  const addedContent = replaceTabs(pair.added.content);
  const [removedStyled] = highlightRun([{ ...pair.removed, content: removedContent }], language, input);
  const [addedStyled] = highlightRun([{ ...pair.added, content: addedContent }], language, input);
  const ranges = changedRanges(removedContent, addedContent);
  return [
    renderLine(pair.removed, applyEmphasis(removedStyled, ranges.removed, INVERSE_ON, INVERSE_OFF), input.theme),
    renderLine(pair.added, applyEmphasis(addedStyled, ranges.added, INVERSE_ON, INVERSE_OFF), input.theme),
  ];
}

function runEnd(lines: EditDiffLine[], index: number, kind: EditDiffKind): number {
  let end = index + 1;
  while (end < lines.length && bodyLine(lines[end], kind) !== undefined) end += 1;
  return end;
}

export function buildEditDiffText(input: EditDiffInput): string {
  if (input.diff === "") return "";
  const lines = input.diff.split("\n").map(classifyEditDiffLine);
  const language = input.path === "" ? undefined : getLanguageFromPath(input.path);
  const styled: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const pair = modificationAt(lines, index);
    if (pair !== undefined) {
      styled.push(...renderModification(pair, language, input));
      index += 2;
      continue;
    }
    const line = lines[index];
    if (line.kind === "elision") {
      styled.push(renderLine(line, input.theme.fg(DIFF_KIND_TOKEN.context, line.content), input.theme));
      index += 1;
      continue;
    }
    const body = bodyLine(line);
    if (body === undefined) {
      styled.push(renderLine(line, "", input.theme));
      index += 1;
      continue;
    }
    const end = runEnd(lines, index, body.kind);
    // Every line of the run was matched by `bodyLine` above, so the cast loses
    // nothing; the array is typed by what `runEnd` has already checked.
    const run = lines.slice(index, end).map((entry) => entry as DiffBodyLine);
    const highlighted = highlightRun(run, language, input);
    run.forEach((entry, offset) => {
      styled.push(renderLine(entry, highlighted[offset], input.theme));
    });
    index = end;
  }
  return styled.join("\n");
}

// The body the built-in paints inside the call's `Box`: the failure text in the
// error color, with no newline of its own because the box adds the gap.
export function buildEditErrorText(output: string, theme: StyleTheme): string {
  return output === "" ? "" : theme.fg(TOKEN.broken, output);
}
