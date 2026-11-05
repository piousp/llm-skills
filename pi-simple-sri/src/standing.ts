import fs from "node:fs";
import path from "node:path";
import type { Ledger, LedgerLine } from "./ledger.ts";
import { SKILL_FILE } from "./names.ts";
import { countReferenceLines, lessonReferencePath } from "./skill-reference.ts";
import type { DecisionCandidate, DecisionRecord } from "./types.ts";
import { isMissingPathError, quote, toErrorMessage } from "./values.ts";
import { lessonHashes } from "./writer.ts";

// The check of an accepted lesson against the record that accepted it (M3, S3; OA6 of the plan): the tie M2 wrote
// down and nothing could verify until M3 grew a reader of the index of attempts (src/ledger.ts).
//
// Why the record is the authority and the file is not. A candidate is serialized with the frontmatter of the lesson it
// will become, `status: "accepted"` included, and a candidate the gate rejected stays in `staging/` carrying that same
// frontmatter. So a `lessons/<slug>.md` whose frontmatter says `accepted` may be the copy of a rejected attempt, and the
// frontmatter answers nothing by itself. What answers is the pair the record carries -- `candidate.contentHash` over the
// whole file and `candidate.bodyHash` over the normalized body (D4) -- compared against the bytes on disk now.
//
// The one sentence this module has to keep true: it never reads the frontmatter as a verdict. No branch below looks at
// `lesson.status` or at `lesson.gate`. Parsing the lesson to compute its bodyHash is not reading its frontmatter as a
// verdict: it is hashing the file with the function that defines the pair of hashes (lessonHashes, src/writer.ts), the
// same function the writer stamped the record with, so both sides of the comparison are one arithmetic.
//
// What it reads: the lines of the index and the decision.json each of them names, the bytes of the lesson, and the
// SKILL.md of the skill. What it does not read: the inventory of the skills. The path of the lesson is the one the
// record names -- relative to the skill and resolved over `realDir`, the path that survives a symlink -- so a skill that
// moved is answered by the record and not by where the skill happens to be today.
//
// It never writes: no mkdir, no writeFile, no rename, no rm, only fs.promises.readFile. No model, no process and no
// clock either: the report is a function of the ledger and the bytes on disk, so asking twice answers the same thing
// while neither of them changed.
//
// The pair of the acceptance, in the order the states are decided: the file is not there, the file cannot be read or
// hashed, its bytes hash to the ones the record names, only its frontmatter moved, or its body moved. The reference line
// of SKILL.md travels beside the state and not as a sixth one: a lesson can be byte-identical to its record and still be
// inert, because pi loads the skill through that line (Q10).

// What the bytes of a lesson say about the record that accepted them. The three states that describe a file which is
// there are ordered by how much of the acceptance survived: the whole file, the body alone, or neither.
export type LessonStanding = "intact" | "frontmatter-moved" | "body-moved" | "missing" | "unreadable";

export interface LessonCheck {
  skill: string; // the targetSkill of the line
  slug: string; // the slug of the record's candidate, which names the lesson file
  lessonPath: string; // absolute, resolved from the record and not from the inventory
  standing: LessonStanding;
  referenced: boolean; // SKILL.md carries the reference line of this slug
  historyPath: string | null; // the record that backs the acceptance
  detail?: string; // why it is not intact, why it is not referenced, or both
}

export interface SkillStanding {
  skill: string;
  worst: LessonStanding; // the worst state of its lessons, by SEVERITY below
  lessons: number;
}

export interface StandingReport {
  checks: LessonCheck[];
  skills: readonly SkillStanding[];
  missingRecords: number; // accepted lessons whose record could not be read: they cannot be checked at all
}

// The severity order of rule 8, from the worst state to the least. The row of a skill names one state, and which one
// that is cannot depend on the order the lessons of that skill happened to be read in: a lesson that vanished from the
// skill is worse than one whose body was rewritten, that one is worse than a frontmatter that moved on its own, and a
// file nobody can hash is not worse than a file that is known to have drifted -- what is unreadable is unknown, and
// unknown is reported as its own answer instead of as the worst of the known ones.
const SEVERITY: readonly LessonStanding[] = ["missing", "body-moved", "frontmatter-moved", "unreadable", "intact"];

// The event the acceptance writes, and the one the retirement writes. Both literals belong to src/metrics.ts, which reads
// the series with them; that module exports no predicate for the pair, so the rule of "accepted and still in force" is
// repeated below and the two have to move together.
const ACCEPTED_EVENT = "accepted";
const RETIRED_EVENT = "retired";

// The whole report, from the ledger and from nothing else.
//
// A damaged ledger is read as far as it went: src/ledger.ts already names the position and the problem of the line that
// broke, and this module does not re-derive it -- the report of a series that stops at a truncated line must not pretend
// the lines after it were checked.
export async function standingOf(ledger: Ledger): Promise<StandingReport> {
  const checks: LessonCheck[] = [];
  let missingRecords = 0;

  for (const entry of ledger.lines) {
    if (!isInForce(entry, ledger.lines)) continue;

    // An acceptance whose record is gone cannot be checked: `.history/` may be pruned like `staging/`, and a lesson
    // nobody can compare against its record is a hole in the coverage, never an intact lesson. It is counted and left
    // out of the checks, so a reader of the report sees the number it was not able to verify.
    const record = entry.record;
    if (record === null) {
      missingRecords += 1;
      continue;
    }

    checks.push(await checkOf(entry, record));
  }

  return { checks, skills: standingsOf(checks), missingRecords };
}

// One accepted lesson against its record. The two questions are independent and each answers on its own: the state of
// the bytes, and whether the skill still reaches the file.
async function checkOf(entry: LedgerLine, record: DecisionRecord): Promise<LessonCheck> {
  const skill = entry.line.targetSkill;
  // The record names the lesson relative to the skill (lessonReferencePath, src/skill-reference.ts) and `realDir` is the
  // path that survives a symlink, so the two fields of the record are the whole path: the inventory of today is never
  // consulted, because what is checked is the record.
  const lessonPath = path.resolve(record.skill.realDir, record.candidate.lessonPath);
  const standing = await standingAt(lessonPath, record.candidate);
  const reference = await referenceOf(record.skill.realDir, skill, record.candidate.slug);
  const detail = detailOf([standing.detail, reference.detail]);

  return {
    skill,
    slug: record.candidate.slug,
    lessonPath,
    standing: standing.standing,
    referenced: reference.referenced,
    historyPath: entry.recordPath,
    ...detail,
  };
}

// The states of a lesson file, in the order they are decided: absent, unreadable, intact, only its frontmatter moved,
// its body moved. The order matters and is the contract: a file that is not there has no hash to compare, and a file
// whose whole digest matches is intact whatever its frontmatter says -- which is the tie of M2, since the record is what
// decided the acceptance and the bytes are what the record names.
async function standingAt(
  lessonPath: string,
  candidate: DecisionCandidate,
): Promise<{ standing: LessonStanding; detail?: string }> {
  let text: string;
  try {
    text = await fs.promises.readFile(lessonPath, "utf8");
  } catch (error) {
    // ENOTDIR is the same absence one level down: a component of the path is a file, so the lesson cannot be there.
    if (isMissingPathError(error)) {
      return { standing: "missing", detail: `the lesson ${quote(lessonPath)} is not there` };
    }
    return { standing: "unreadable", detail: `${quote(lessonPath)}: ${toErrorMessage(error)}` };
  }

  // The pair comes from the one function that computes it (D4, src/writer.ts): the same arithmetic that stamped the
  // record, so "the bytes are the ones the record names" is answered the same way on both sides. A text that function
  // rejects has no pair at all, and a file nobody can hash is not a file this module may call intact.
  const hashes = lessonHashes(text);
  if (!hashes.ok) {
    return { standing: "unreadable", detail: `${quote(lessonPath)}: not a valid lesson file (${hashes.error})` };
  }

  if (hashes.value.contentHash === candidate.contentHash) return { standing: "intact" };

  // The body survived and the file did not: the frontmatter moved, which is the case of a lesson accepted before M2 and
  // of one whose date or status was edited afterwards. The bytes of the body are the correction; the header around them
  // is not.
  if (hashes.value.bodyHash === candidate.bodyHash) {
    return {
      standing: "frontmatter-moved",
      detail: `${quote(lessonPath)}: the body still hashes to ${candidate.bodyHash} and the file hashes to ${hashes.value.contentHash}, not to the ${candidate.contentHash} of the record`,
    };
  }

  return {
    standing: "body-moved",
    detail: `${quote(lessonPath)}: the file hashes to ${hashes.value.contentHash} and its body to ${hashes.value.bodyHash}, not to the ${candidate.contentHash} and ${candidate.bodyHash} of the record`,
  };
}

// Whether the skill reaches the lesson (Q10): the reference line of the `## Lessons` section is what pi loads, so a
// lesson without it is inert however intact its bytes are. A SKILL.md nobody can read is not a failure of the check --
// the check answers the only thing it can, that the lesson is not reachable -- and the detail says which of the two
// happened, because a skill that lost the line and a skill whose file is gone are different repairs.
async function referenceOf(
  skillRealDir: string,
  skill: string,
  slug: string,
): Promise<{ referenced: boolean; detail?: string }> {
  const skillFilePath = path.join(skillRealDir, SKILL_FILE);

  let text: string;
  try {
    text = await fs.promises.readFile(skillFilePath, "utf8");
  } catch (error) {
    return {
      referenced: false,
      detail: `cannot read the ${SKILL_FILE} of ${quote(skill)} at ${quote(skillFilePath)}: ${toErrorMessage(error)}`,
    };
  }

  if (countReferenceLines(text, slug) > 0) return { referenced: true };

  // Without the line the lesson is inert: the file is on disk and no session will ever load it, which is the failure
  // this report exists to shout.
  return {
    referenced: false,
    detail: `${quote(skillFilePath)} has no reference line to ${quote(lessonReferencePath(slug))}: the lesson is inert`,
  };
}

// The two reasons a check can carry, in one sentence. A lesson that drifted and is unreachable has two problems, and the
// report names both instead of letting the first one hide the second.
function detailOf(reasons: readonly (string | undefined)[]): { detail?: string } {
  const present = reasons.filter((reason): reason is string => reason !== undefined);
  return present.length === 0 ? {} : { detail: present.join("; ") };
}

// Rule 1: an accepted line is checked only while it is in force. The rule is the one of the recurrence of src/metrics.ts
// -- that module is its owner and builds its denominator with it -- and it is repeated here because it exports no
// predicate for the pair; the two implementations move together or the series and the check disagree about which lessons
// exist.
function isInForce(entry: LedgerLine, lines: readonly LedgerLine[]): boolean {
  if (entry.line.event !== ACCEPTED_EVENT) return false;
  return !isRetired(entry, lines);
}

// The candidate of the line is no longer in force when a later line of the same skill names the same candidate as
// `retired`. That event is the one the retirement of S4 (OA4) writes, and the comparison is against the literal because a
// line of the index carries a string the tolerant reader keeps verbatim: the vocabulary of src/attempts.ts is the type of
// the writer, and this module reads what the index holds.
function isRetired(lesson: LedgerLine, lines: readonly LedgerLine[]): boolean {
  return lines.some(
    (entry) =>
      entry.line.event === RETIRED_EVENT &&
      entry.line.targetSkill === lesson.line.targetSkill &&
      entry.line.candidateHash === lesson.line.candidateHash &&
      isLater(entry.line.ts, lesson.line.ts),
  );
}

// Whether one moment of the index is later than another, compared as instants and not as strings: the spelling is an ISO
// date-time written by one clock (src/attempts.ts), and parsing them answers the order without a clock of this module. A
// moment nothing can parse is later than nothing, which keeps a damaged timestamp from retiring a lesson on its own.
function isLater(ts: string, than: string): boolean {
  const moment = Date.parse(ts);
  const other = Date.parse(than);
  return Number.isFinite(moment) && Number.isFinite(other) && moment > other;
}

// Rule 8: one row per skill the report checked, sorted by name, with the worst state of its lessons and how many were
// checked. A skill whose only accepted lessons have no record has no row: it is the count of `missingRecords`, and
// inventing a state for a lesson nobody could compare would be the lie the report is written against.
function standingsOf(checks: readonly LessonCheck[]): SkillStanding[] {
  const rows = new Map<string, SkillStanding>();

  for (const check of checks) {
    const known = rows.get(check.skill);
    const worst = known === undefined ? check.standing : worstOf(known.worst, check.standing);
    rows.set(check.skill, { skill: check.skill, worst, lessons: (known?.lessons ?? 0) + 1 });
  }

  return [...rows.values()].sort((left, right) => (left.skill < right.skill ? -1 : left.skill > right.skill ? 1 : 0));
}

function worstOf(left: LessonStanding, right: LessonStanding): LessonStanding {
  return SEVERITY.indexOf(left) <= SEVERITY.indexOf(right) ? left : right;
}
