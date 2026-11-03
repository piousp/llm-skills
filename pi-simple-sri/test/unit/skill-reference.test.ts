import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countReferenceLines,
  hasReference,
  upsertReferenceLine,
} from "../../src/skill-reference.ts";

// Direct coverage of the Markdown editor (W5). src/writer.ts owns the file -- it reads the text,
// calls these functions, writes the bytes and verifies them -- so the rules of the `## Lessons`
// section can be exercised here as text -> text, with no disk and no fixture.

const SLUG = "merged-cells";
const TITLE = "Extract merged cells";
const REFERENCE = `- [lessons/${SLUG}.md](lessons/${SLUG}.md) - ${TITLE}`;
const EXISTING_REFERENCE = "- [lessons/existing.md](lessons/existing.md) - Existing lesson";
const SKILL_HEAD = ["# pdf-tools", "", "Use the scripts in this directory.", ""].join("\n");

interface UpsertCase {
  name: string;
  before: string;
  expected: string;
}

// The section is appended as its own block at the end of the file: one blank line between the
// previous content and the heading, one between the heading and the list. The three inputs differ
// only in how the existing text ends, which is what the separator rule reads.
const APPEND_SECTION_CASES: readonly UpsertCase[] = [
  {
    name: "an empty file",
    before: "",
    expected: `## Lessons\n\n${REFERENCE}\n`,
  },
  {
    name: "a file that ends with a newline",
    before: SKILL_HEAD,
    expected: `${SKILL_HEAD}\n## Lessons\n\n${REFERENCE}\n`,
  },
  {
    name: "a file that ends with a blank line",
    before: "# pdf-tools\n\n",
    expected: `# pdf-tools\n\n## Lessons\n\n${REFERENCE}\n`,
  },
  {
    name: "a file without a trailing newline",
    before: "# pdf-tools",
    expected: `# pdf-tools\n\n## Lessons\n\n${REFERENCE}\n`,
  },
];

for (const entry of APPEND_SECTION_CASES) {
  test(`upsertReferenceLine: a file without a Lessons section gets one at the end (${entry.name})`, () => {
    assert.equal(upsertReferenceLine(entry.before, SLUG, TITLE), entry.expected);
  });
}

// A section with nothing in it takes the line as its first bullet, one blank line below the
// heading, and the blank line that separated the heading from the next section stays where it was.
const EMPTY_SECTION_CASES: readonly UpsertCase[] = [
  {
    name: "a section at the end of the file",
    before: "# pdf-tools\n\n## Lessons\n",
    expected: `# pdf-tools\n\n## Lessons\n\n${REFERENCE}\n`,
  },
  {
    name: "a section followed by another section",
    before: "# pdf-tools\n\n## Lessons\n\n## Notes\n\nKeep it short.\n",
    expected: `# pdf-tools\n\n## Lessons\n\n${REFERENCE}\n\n## Notes\n\nKeep it short.\n`,
  },
  {
    name: "a section whose only content is a sub-heading and its text",
    // The ### sub-heading stays part of the section, and the line goes above it instead of below
    // its text: the blank line that follows the bullet is what keeps the two apart.
    before: "# pdf-tools\n\n## Lessons\n\n### Detalle\n\nNotes.\n",
    expected: `# pdf-tools\n\n## Lessons\n\n${REFERENCE}\n\n### Detalle\n\nNotes.\n`,
  },
];

for (const entry of EMPTY_SECTION_CASES) {
  test(`upsertReferenceLine: a section with no bullets takes the line first (${entry.name})`, () => {
    assert.equal(upsertReferenceLine(entry.before, SLUG, TITLE), entry.expected);
  });
}

// The line becomes the first bullet of the section and the content that was there moves below it:
// the blank line that closed the heading now closes the list, and the one that closes the section
// (a level-2 heading, a level-1 heading, or the end of the file) stays where it was.
const EXISTING_SECTION_CASES: readonly UpsertCase[] = [
  {
    name: "a section closed by a level-2 heading",
    before: [
      "# pdf-tools",
      "",
      "## Lessons",
      "",
      EXISTING_REFERENCE,
      "",
      "## Notes",
      "",
      "Keep the scripts small.",
      "",
    ].join("\n"),
    expected: [
      "# pdf-tools",
      "",
      "## Lessons",
      "",
      REFERENCE,
      EXISTING_REFERENCE,
      "",
      "## Notes",
      "",
      "Keep the scripts small.",
      "",
    ].join("\n"),
  },
  {
    name: "a section closed by a level-1 heading",
    before: ["# pdf-tools", "", "## Lessons", "", EXISTING_REFERENCE, "", "# Appendix", "", "More.", ""].join("\n"),
    expected: [
      "# pdf-tools",
      "",
      "## Lessons",
      "",
      REFERENCE,
      EXISTING_REFERENCE,
      "",
      "# Appendix",
      "",
      "More.",
      "",
    ].join("\n"),
  },
  {
    name: "a section that ends the file",
    before: ["## Lessons", "", EXISTING_REFERENCE, ""].join("\n"),
    expected: ["## Lessons", "", REFERENCE, EXISTING_REFERENCE, ""].join("\n"),
  },
];

for (const entry of EXISTING_SECTION_CASES) {
  test(`upsertReferenceLine: the line lands at the top of the section (${entry.name})`, () => {
    assert.equal(upsertReferenceLine(entry.before, SLUG, TITLE), entry.expected);
  });
}

// The section is closed by a level-1 or level-2 heading only (Q10: that section is what pi reads
// to reach a lesson). A ### sub-heading is part of the section, and the line still goes above it:
// placement follows the top of the section, not the start of a sub-section.
const SECTION_BOUNDARY_CASES: readonly UpsertCase[] = [
  {
    name: "a sub-heading inside the section does not close it",
    before: [
      "# pdf-tools",
      "",
      "## Lessons",
      "",
      EXISTING_REFERENCE,
      "",
      "### Detalle",
      "",
      "Keep the scripts small.",
      "",
    ].join("\n"),
    expected: [
      "# pdf-tools",
      "",
      "## Lessons",
      "",
      REFERENCE,
      EXISTING_REFERENCE,
      "",
      "### Detalle",
      "",
      "Keep the scripts small.",
      "",
    ].join("\n"),
  },
  {
    name: "another level-2 section closes it",
    before: ["# pdf-tools", "", "## Lessons", "", EXISTING_REFERENCE, "", "## Otra", "", "Texto.", ""].join("\n"),
    expected: [
      "# pdf-tools",
      "",
      "## Lessons",
      "",
      REFERENCE,
      EXISTING_REFERENCE,
      "",
      "## Otra",
      "",
      "Texto.",
      "",
    ].join("\n"),
  },
];

for (const entry of SECTION_BOUNDARY_CASES) {
  test(`upsertReferenceLine: only a level-1 or level-2 heading closes the section (${entry.name})`, () => {
    assert.equal(upsertReferenceLine(entry.before, SLUG, TITLE), entry.expected);
  });
}

// The reason the line goes first: a ### sub-section owns its own text, so a bullet appended at the
// end of the section would land under a sub-section it does not belong to. The list of references
// stays flat at the top, above the first sub-section, whatever the section already holds.
const SUB_SECTION_CASES: readonly UpsertCase[] = [
  {
    name: "a section with two populated sub-sections",
    before: [
      "# pdf-tools",
      "",
      "## Lessons",
      "",
      "### Primera",
      "",
      "Texto uno.",
      "",
      "### Segunda",
      "",
      "Texto dos.",
      "",
    ].join("\n"),
    expected: [
      "# pdf-tools",
      "",
      "## Lessons",
      "",
      REFERENCE,
      "",
      "### Primera",
      "",
      "Texto uno.",
      "",
      "### Segunda",
      "",
      "Texto dos.",
      "",
    ].join("\n"),
  },
];

for (const entry of SUB_SECTION_CASES) {
  test(`upsertReferenceLine: the line stays above the sub-sections (${entry.name})`, () => {
    assert.equal(upsertReferenceLine(entry.before, SLUG, TITLE), entry.expected);
  });
}

interface ReferenceCase {
  name: string;
  text: string;
  expected: boolean;
}

// The reference is the canonical bullet inside `## Lessons` (I11). A path mentioned in prose, a
// link without the bullet, or the bullet in another section leaves the lesson unreachable, so
// none of them counts as the reference.
const REFERENCE_CASES: readonly ReferenceCase[] = [
  {
    name: "a prose mention with no section",
    text: "# pdf-tools\n\nSee lessons/merged-cells.md for details.\n",
    expected: false,
  },
  {
    name: "a prose mention inside the section",
    text: "## Lessons\n\nSee lessons/merged-cells.md for details.\n",
    expected: false,
  },
  {
    name: "a link without the bullet",
    text: "## Lessons\n\n[lessons/merged-cells.md](lessons/merged-cells.md)\n",
    expected: false,
  },
  {
    name: "the canonical line in another section",
    text: `## Notes\n\n${REFERENCE}\n`,
    expected: false,
  },
  {
    name: "the canonical line with no section at all",
    text: `${REFERENCE}\n`,
    expected: false,
  },
  {
    name: "the canonical line inside the section",
    text: `## Lessons\n\n${REFERENCE}\n`,
    expected: true,
  },
  {
    name: "the canonical line with another title",
    text: `## Lessons\n\n- [lessons/merged-cells.md](lessons/merged-cells.md) - Old title\n`,
    expected: true,
  },
  {
    name: "an indented canonical line",
    text: `## Lessons\n\n  - [lessons/merged-cells.md](lessons/merged-cells.md) - Merged cells\n`,
    expected: true,
  },
];

for (const entry of REFERENCE_CASES) {
  test(`hasReference: ${entry.expected ? "recognises" : "ignores"} ${entry.name}`, () => {
    assert.equal(hasReference(entry.text, SLUG), entry.expected);
  });
}

interface IdempotenceCase {
  name: string;
  before: string;
}

const IDEMPOTENCE_CASES: readonly IdempotenceCase[] = [
  { name: "a file without the section", before: SKILL_HEAD },
  { name: "an empty section", before: "# pdf-tools\n\n## Lessons\n" },
  {
    name: "a section that already lists another lesson",
    before: ["# pdf-tools", "", "## Lessons", "", EXISTING_REFERENCE, ""].join("\n"),
  },
];

// Acceptance is idempotent by slug through hasReference: the writer reads the text, asks
// hasReference and calls the editor only when the reference is missing (src/writer.ts). The
// editor writes the line unconditionally, so the guard is what keeps a second accept from adding a
// second line; these cases pin the result of the two and three call contract.
for (const entry of IDEMPOTENCE_CASES) {
  test(`upsertReferenceLine + hasReference: repeating the same slug leaves one line (${entry.name})`, () => {
    const accept = (text: string): string =>
      hasReference(text, SLUG) ? text : upsertReferenceLine(text, SLUG, TITLE);

    const once = accept(entry.before);
    const twice = accept(once);
    const thrice = accept(twice);

    assert.equal(twice, once);
    assert.equal(thrice, once);
    assert.equal(countReferenceLines(once, SLUG), 1);
  });
}

// Counting is the check the writer runs on the text it read back: only canonical lines inside the
// section count, so a prose mention, a different file and a bullet in another section cannot make
// an inert lesson look referenced.
const COUNTING_TEXT = [
  "# pdf-tools",
  "",
  "## Lessons",
  "",
  `- [lessons/${SLUG}.md](lessons/${SLUG}.md) - Merged cells`,
  `  - [lessons/${SLUG}.md](lessons/${SLUG}.md) - the same file, nested bullet`,
  `See lessons/${SLUG}.md for details.`,
  `- [lessons/${SLUG}.mdx](lessons/${SLUG}.mdx) - a different file`,
  "- [lessons/other.md](lessons/other.md) - Other lesson",
  "",
  "## Notes",
  "",
  `- [lessons/${SLUG}.md](lessons/${SLUG}.md) - Merged cells`,
  "",
].join("\n");

test("countReferenceLines: counts the canonical lines of the section and nothing else", () => {
  // Five lines mention the path: two bullets of the section, a nested bullet, a prose line, a link
  // to another file whose name starts the same, and the bullet in `## Notes`. Only the two bullets
  // of the section are the reference.
  const mentioningLines = COUNTING_TEXT.split("\n").filter((line) => line.includes(`lessons/${SLUG}.md`));
  assert.equal(mentioningLines.length, 5);
  assert.equal(countReferenceLines(COUNTING_TEXT, SLUG), 2);
  assert.equal(countReferenceLines(COUNTING_TEXT, "other"), 1);
  assert.equal(countReferenceLines(COUNTING_TEXT, "absent"), 0);
  assert.equal(hasReference(COUNTING_TEXT, SLUG), true);
});
