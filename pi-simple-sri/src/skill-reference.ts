// The `## Lessons` section of SKILL.md and the canonical reference line that makes a lesson
// reachable (Q10): "- [lessons/<slug>.md](lessons/<slug>.md) - <title>". This module owns what
// the Markdown text means; src/writer.ts owns the file: it reads the text, calls the editor
// below, writes the bytes and verifies them. That is why the failure messages about the file
// stay in the writer and this module never raises.
//
// The reference lines are a flat list at the top of the section: a new line becomes the first
// bullet, one blank line below the `## Lessons` heading. The position is part of the contract, not
// a detail of the edit. The section may carry hand-written ### sub-sections, and a bullet appended
// at the end of the section lands under whichever sub-section happens to be last, inside content a
// ### heading owns and does not share. The reference belongs to the section as a whole, so it goes
// where the section itself starts; the sub-sections keep their own text below the list.
//
// Every function here is text -> text or text -> datum: no fs, no paths, no state. The caller
// hands over the text and decides what to do with the result, so the section rules can be
// exercised without touching the disk.

import { LESSONS_DIR } from "./names.ts";

// The level-2 heading whose section pi reads to reach a lesson.
const LESSONS_HEADING = "Lessons";

// The path a lesson is linked by, relative to the skill directory. Exported because the writer
// names the same path when the read-back proves the line did not land, and the convention needs
// one owner.
export function lessonReferencePath(slug: string): string {
  return `${LESSONS_DIR}/${slug}.md`;
}

// The reference counts only inside the `## Lessons` section (I11): that section is what pi reads
// to reach a lesson, so a mention in prose or in another section does not make the lesson
// reachable and must not stand in for the line that does.
export function hasReference(text: string, slug: string): boolean {
  return countReferenceLines(text, slug) > 0;
}

export function countReferenceLines(text: string, slug: string): number {
  const pattern = referencePattern(slug);
  return lessonsSectionLines(text).filter((line) => pattern.test(line)).length;
}

// Idempotent by slug: a text that already carries the line is returned unchanged, so accepting a
// lesson twice cannot add the line twice. Without the line a lesson is inert (Q10), which is why
// acceptance writes it.
//
// A section that does not exist yet is appended at the end of the file. An existing one takes the
// line as the first bullet of its list, above whatever the section already holds, so repeated calls
// leave the references most recent first and never place one under a ### sub-section.
export function upsertReferenceLine(text: string, slug: string, title: string): string {
  if (hasReference(text, slug)) return text;

  const line = referenceLine(slug, title);
  const lines = splitLines(text);
  const headingIndex = lines.findIndex(isLessonsHeading);

  if (headingIndex === -1) {
    return appendLessonsSection(text, line);
  }

  // The first line of the section that is not blank: the bullet takes that slot, and the blank line
  // the author already put below the heading stays where it is instead of being rewritten.
  const firstContent = firstContentIndex(lines, headingIndex + 1, sectionEnd(lines, headingIndex));
  const block = firstContent === headingIndex + 1 ? ["", line] : [line];

  // What follows the bullet is either the rest of the section or the heading that closes it, and
  // both need the blank line that ends the list. A reference line is the rest of the same list, so
  // joining it needs no separator.
  if (firstContent < lines.length && !isReferenceLine(lines[firstContent])) {
    block.push("");
  }

  lines.splice(firstContent, 0, ...block);
  return joinLines(lines);
}

// The first line of the section that is not blank, or `end` when the section holds no content.
function firstContentIndex(lines: readonly string[], from: number, end: number): number {
  for (let index = from; index < end; index++) {
    if (lines[index].trim() !== "") {
      return index;
    }
  }
  return end;
}

function referenceLine(slug: string, title: string): string {
  const reference = lessonReferencePath(slug);
  return `- [${reference}](${reference}) - ${title}`;
}

function referencePattern(slug: string): RegExp {
  return canonicalReferencePattern(escapeRegExp(lessonReferencePath(slug)));
}

// The canonical line: "- [lessons/<slug>.md](lessons/<slug>.md) - <title>". The link is required,
// not just the path, and the closing parenthesis after ".md" already keeps lessons/foo.md from
// matching inside lessons/foo.mdx. The path is a regexp fragment so the same shape also recognises
// a reference to any lesson: the list at the top of the section is made of those lines.
function canonicalReferencePattern(path: string): RegExp {
  return new RegExp(`^[ \\t]*-[ \\t]+\\[${path}\\]\\(${path}\\)`);
}

// Whether the line is a canonical reference to some lesson, whatever the slug: that is what makes
// the top of the section one list rather than a list per lesson.
function isReferenceLine(line: string): boolean {
  return canonicalReferencePattern(`${escapeRegExp(LESSONS_DIR)}/[^\\]\\s]+`).test(line);
}

function lessonsSectionLines(text: string): string[] {
  const lines = splitLines(text);
  const headingIndex = lines.findIndex(isLessonsHeading);
  if (headingIndex === -1) {
    return [];
  }
  return lines.slice(headingIndex + 1, sectionEnd(lines, headingIndex));
}

function appendLessonsSection(text: string, line: string): string {
  const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  const separator = base === "" || base.endsWith("\n\n") ? "" : "\n";
  return `${base}${separator}## ${LESSONS_HEADING}\n\n${line}\n`;
}

function isLessonsHeading(line: string): boolean {
  return new RegExp(`^##\\s+${LESSONS_HEADING}\\s*$`).test(line);
}

// The index of the line that closes the section, or the length of the file. Only levels 1 and 2
// end it: a ### sub-heading inside `## Lessons` stays part of it.
function sectionEnd(lines: readonly string[], headingIndex: number): number {
  for (let index = headingIndex + 1; index < lines.length; index++) {
    if (isSectionHeading(lines[index])) {
      return index;
    }
  }
  return lines.length;
}

function isSectionHeading(line: string): boolean {
  return /^#{1,2}\s+\S/.test(line);
}

// Splits keeping the line structure intact but dropping the empty element that a
// trailing newline produces, so joinLines can put back exactly one.
function splitLines(text: string): string[] {
  const withoutFinalNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutFinalNewline === "" ? [] : withoutFinalNewline.split("\n");
}

function joinLines(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
