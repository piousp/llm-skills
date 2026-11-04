import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { LESSON_STATUSES } from "./types.ts";
import type { LessonDraft, LessonStatus, Result } from "./types.ts";
import { describe, isPlainObject, quote, toErrorMessage } from "./values.ts";

// The lesson file format: a frontmatter block with title, date, status, source-evidence and gate,
// then the body. The example carries the status and the gate a candidate is written with (M2); a lesson
// written before M2 says "proposed" and "pending" and validates exactly the same way.
//
//   ---
//   title: "Extract tables with merged cells"
//   date: "2026-11-02"
//   status: "accepted"
//   source-evidence:
//     - "ev-3f9a1c02"
//   gate: "accepted"
//   ---
//
//   <body>
//
// Reading goes through parseFrontmatter from pi-coding-agent, which is the parser pi itself
// uses for SKILL.md (OA2), so a file this module writes is a file pi can read. Writing is done
// here because no YAML emitter is available: scalars are written with JSON.stringify, and a JSON
// string is a valid YAML double-quoted scalar, so a title with a colon, quotes or accents
// survives the round trip.
//
// The slug is not part of the file: it names the file (lessons/<slug>.md). parseLesson derives it
// from the title with slugify, so callers must name the file after slugify(title) for the slug
// they read back to match the path they read it from.
//
// Both directions run the same validation (M2): serializeLesson hands validateLessonFields what it
// is about to write and parseLesson what it just read, so a draft this module emits is a draft
// this module accepts, and no rule or message exists twice to drift.
//
// parseLesson never throws on malformed content: every rejection is a typed error naming the
// field that failed. A malformed file recovered from disk must not take down the caller, and the
// caller decides what to do with the reason.

const MAX_SLUG_LENGTH = 64;
// The size limit of a lesson body. Exported because the prompt that asks the model for one states the
// same number (src/proposer.ts): a prompt that promised a limit the validator does not enforce would
// be a promise the file cannot keep, and a second literal in the prompt is how the two drift.
export const MAX_BODY_BYTES = 8192;
// A title made only of symbols still needs a file name.
const FALLBACK_SLUG = "lesson";
const FRONTMATTER_FENCE = "---";
const EVIDENCE_ID_PATTERN = /^ev-[0-9a-f]{8}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// The fields a lesson file carries, declared once (M2). It is not LessonDraft: the record also
// holds the slug, which the file does not store, so the shape both directions validate is the
// draft minus the slug that names the file.
type LessonFields = Omit<LessonDraft, "slug">;

// What validateLessonFields receives before anything is proven: the values come from a YAML
// document on the read path and from a draft on the write path, so none of them is trusted yet.
// The body is the exception, because it is the text after the block and parseFrontmatter always
// answers it as a string.
type RawLessonFields = Omit<{ [K in keyof LessonFields]: unknown }, "body"> & { body: string };

// lowercase, accents folded to ASCII, every run of anything else replaced by one "-", hyphens
// trimmed from both ends, at most 64 characters, never empty. "Extracción de tablas: celdas"
// becomes "extraccion-de-tablas-celdas"; "!!!" becomes "lesson".
export function slugify(title: string): string {
  const folded = foldAscii(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // Truncation can leave a hyphen at the end, which the pattern for a lesson slug forbids.
  const truncated = folded.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
  return truncated === "" ? FALLBACK_SLUG : truncated;
}

// Emits the block above followed by the body, with exactly one trailing newline so appending to
// the file stays a line operation. The body is trimmed of surrounding whitespace because
// parseFrontmatter trims it on read: writing it verbatim would make the round trip lossy.
//
// The draft is validated before a byte is produced (M2): a draft whose body is empty or over the
// size limit would serialize into a file parseLesson rejects, and that text is what staging
// publishes and what recovery later fails on. The body validated is the trimmed one, because the
// trimmed one is what the file will hold.
export function serializeLesson(draft: LessonDraft): Result<string, string> {
  // The slug names the file and is not one of its fields, so it is dropped here; the body is the
  // trimmed one, the body the file will hold.
  const { slug: _slug, ...draftFields } = draft;
  const fields = validateLessonFields({ ...draftFields, body: draftFields.body.trim() });
  if (!fields.ok) {
    return fields;
  }

  const lesson = fields.value;
  const evidenceLines =
    lesson.sourceEvidence.length === 0
      ? ["source-evidence: []"]
      : ["source-evidence:", ...lesson.sourceEvidence.map((id: string) => `  - ${quote(id)}`)];

  const frontmatter = [
    `title: ${quote(lesson.title)}`,
    `date: ${quote(lesson.date)}`,
    `status: ${quote(lesson.status)}`,
    ...evidenceLines,
    `gate: ${quote(lesson.gate)}`,
  ];

  const text = `${FRONTMATTER_FENCE}\n${frontmatter.join("\n")}\n${FRONTMATTER_FENCE}\n\n${lesson.body}`;
  return { ok: true, value: `${text.trimEnd()}\n` };
}

// Reads a lesson file back. Validates every field the record depends on: a lesson with a broken
// date, an unknown status, an evidence id that cannot be joined to decision.json, an empty gate,
// or a body over the size limit is a corrupt record, not a lesson.
export function parseLesson(raw: string): Result<LessonDraft, string> {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    return { ok: false, error: `cannot parse the frontmatter: ${toErrorMessage(error)}` };
  }

  // parseFrontmatter answers with an empty object when the file has no block, and with whatever
  // the YAML document held when the block is not a mapping.
  const frontmatter = parsed.frontmatter;
  if (!isPlainObject(frontmatter) || Object.keys(frontmatter).length === 0) {
    return { ok: false, error: `missing frontmatter: the file must start with a ${FRONTMATTER_FENCE} block` };
  }

  const fields = validateLessonFields({
    title: frontmatter.title,
    date: frontmatter.date,
    status: frontmatter.status,
    sourceEvidence: frontmatter["source-evidence"],
    gate: frontmatter.gate,
    body: parsed.body,
  });
  if (!fields.ok) {
    return fields;
  }

  return { ok: true, value: { slug: slugify(fields.value.title), ...fields.value } };
}

// The only set of rules a lesson satisfies, shared by both directions (M2). The order of the
// checks is the order a reader sees the fields, and the first failure is the one reported.
function validateLessonFields(raw: RawLessonFields): Result<LessonFields, string> {
  const title = raw.title;
  if (typeof title !== "string" || title.trim() === "") {
    return { ok: false, error: `"title" must be a non-empty string, got ${describe(title)}` };
  }

  // A title is one line by contract: the acceptance puts it after the reference line of the skill
  // (``- [lessons/<slug>.md](lessons/<slug>.md) - <title>``), so a line break inside it would open a
  // bullet of its own in SKILL.md and the title would stop being the description of the lesson.
  if (title.includes("\n") || title.includes("\r")) {
    return {
      ok: false,
      error: `"title" must be a single line, got ${describe(title)}`,
    };
  }

  const date = raw.date;
  if (typeof date !== "string" || !isIsoDate(date)) {
    return { ok: false, error: `"date" must be a YYYY-MM-DD calendar date, got ${describe(date)}` };
  }

  const status = raw.status;
  if (!isStatus(status)) {
    return { ok: false, error: `"status" must be one of ${LESSON_STATUSES.join(", ")}, got ${describe(status)}` };
  }

  const sourceEvidence = raw.sourceEvidence;
  if (!isEvidenceIdList(sourceEvidence)) {
    return {
      ok: false,
      error: `"source-evidence" must be a list of ev-<8 lowercase hex> ids, got ${describe(sourceEvidence)}`,
    };
  }

  const gate = raw.gate;
  if (typeof gate !== "string" || gate.trim() === "") {
    return { ok: false, error: `"gate" must be a non-empty string, got ${describe(gate)}` };
  }

  const body = raw.body;
  if (body.trim() === "") {
    return { ok: false, error: "the body after the frontmatter is empty" };
  }

  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > MAX_BODY_BYTES) {
    return { ok: false, error: `the body is ${bodyBytes} bytes, over the ${MAX_BODY_BYTES} byte limit` };
  }

  return { ok: true, value: { title, date, status, sourceEvidence: [...sourceEvidence], gate, body } };
}

// NFD splits "é" into "e" plus a combining accent and "ñ" into "n" plus a combining tilde, so
// dropping the combining marks folds the whole Latin range to ASCII.
function foldAscii(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// The pattern alone accepts 2026-13-45; a real calendar date is the date that survives a round
// trip through UTC.
function isIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;

  const [year, month, day] = value.split("-").map((part: string) => Number(part));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

// Derived from the array in src/types.ts, never from a second literal (I4).
function isStatus(value: unknown): value is LessonStatus {
  return typeof value === "string" && LESSON_STATUSES.some((status) => status === value);
}

function isEvidenceIdList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((id: unknown) => typeof id === "string" && EVIDENCE_ID_PATTERN.test(id))
  );
}
