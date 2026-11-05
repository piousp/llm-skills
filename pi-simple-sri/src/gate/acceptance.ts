// The acceptance (M1, §S9): the one place of the package that writes inside a skill that is already in
// use. Everything it writes goes through the chokepoint of src/writer.ts, which owns the perimeter, the
// mutation queue, the temporary file with its rename and the read-back; what lives here is the order of
// the writes and the answers of the protocol, nothing about bytes.
//
// The order is not negotiable, and every position of it is a guarantee:
//
//   0. the skill is still one the settings admit. The verdict arrives as data -- this module reads no settings, on
//      purpose -- and a candidate the gate accepted under a skill the user has excluded since is refused here, before
//      the snapshot and before any byte: a lesson written into that skill is a lesson the loop refuses to improve from
//      then on, and the gate's own check is older than the write.
//   1. a SKILL.md that already references the slug is refused before anything is written. Both arms of the
//      gate were built from the skill as it stood, so a line that is already there makes them identical in
//      `## Lessons` and the gate would have compared the skill with itself. The refusal is here and not in
//      the overlay because the overlay has no operation that deletes a reference line and must not gain
//      one.
//   2. the SKILL.md of the skill has to hash to the value the gate preregistered: an edit between the
//      gate and the acceptance makes the verdict describe a skill that no longer exists, so the candidate
//      is refused instead of published.
//   3. the snapshot comes first and before any edit, so the skill as it was is always on disk when this
//      module starts to change it. History is never rewritten: a timestamp that is taken is taken.
//   4. the lesson is written and verified against the `contentHash` of the candidate, so the bytes that
//      land are the bytes the gate measured.
//   5. the reference line is added, idempotent by slug; if it cannot be, the lesson is withdrawn, because
//      a lesson pi cannot reach is inert and a half-accepted skill is worse than an unchanged one.
//   6. the authoritative record of the acceptance is written into the snapshot, and only after the bytes
//      of the skill are verified: a `.history/<ts>/decision.json` that says "accepted" can never describe
//      a write that did not happen.
//   7. the event of the index is appended with the `historyPath` of the record, which is what joins the
//      "gate-accepted" of the staged record with the "accepted" of the write by `candidateHash`.
//   8. the reload of the session is not a step of this protocol: it is a call on the context pi hands a command,
//      and it lives at the end of the command's handler (see the invariant at the end of acceptCandidate).
//
// The staged `decision.json` is never rewritten to "accepted": it keeps the "gate-accepted" the gate
// decided, and the line of the index is what tells both states apart.
//
// Nothing here reads settings, calls a model or spawns anything: it takes the record the gate wrote, the
// candidate it measured, the eligibility verdict its caller resolved (step 0, as data and never as a file) and one
// clock, and the answer is either the acceptance or the named reason it did not happen. Refusals the protocol does not
// name -- a skill that cannot be read, an index that cannot be appended -- are thrown, the same way the rest of the
// package treats a broken file.

import fs from "node:fs";
import path from "node:path";
import { buildAttemptLine } from "../attempts.ts";
import { sha256Digest } from "../hash.ts";
import { HISTORY_DIR, SKILL_FILE } from "../names.ts";
import { assertWritable, isInsideOrEqual } from "../perimeter.ts";
import { countReferenceLines, lessonReferencePath } from "../skill-reference.ts";
import type { AttemptLine, DecisionRecord, Eligibility, Result } from "../types.ts";
import { currentTime, quote, toErrorMessage } from "../values.ts";
import {
  appendAttemptLine,
  formatTimestamp,
  removeLessonFile,
  snapshotForHistory,
  SriWriterError,
  upsertReferenceLine,
  writeHistoryDecision,
  writeLessonFile,
} from "../writer.ts";

// Why a candidate the gate accepted was not written. The list is closed and each reason names a state the
// caller can report differently: the skill is no longer one the settings admit, the slug is already live, the skill moved
// since the gate saw it, the history of that timestamp is taken, or the reference line could not be written (and the lesson
// was withdrawn). None of them is a failure of the run itself, which is why they are values and not errors.
export type AcceptRejectionReason =
  | "no-longer-eligible"
  | "slug-already-referenced"
  | "skill-drift"
  | "history-exists"
  | "reference-failed";

export interface AcceptRejection {
  reason: AcceptRejectionReason;
  detail: string;
}

// What an acceptance needs. `decision` is the record the gate left in staging, with `gate.status`
// "gate-accepted", and `expectedSkillContentHash` is the `skillContentHash` the gate preregistered
// (src/gate/overlay.ts): the two hashes cannot be recomputed here without losing what the gate saw.
//
// `candidate` carries the text and the hash the gate measured, never a draft: the format of a lesson file
// belongs to src/lesson-frontmatter.ts and was validated before the candidate was staged.
//
// `timestamp` names the snapshot directory and defaults to the clock of `deps.now`, in the same spelling
// the staging writer gives a candidate: UTC, no separators. It travels in the request because a test proves
// the refusal of an occupied timestamp without waiting for a millisecond to pass.
//
// `eligibility` is the verdict of the skill under the settings, and it travels as data (M3, S7): the gate checked it
// before it spent a run and this module checks it again before the first byte, because between the two the settings can
// have changed -- and the invariant of this file is that it reads no settings of its own, so the caller that resolved the
// verdict is the one that hands it over.
export interface AcceptRequest {
  base: string;
  skill: { name: string; realDir: string };
  candidate: { slug: string; title: string; lessonText: string; contentHash: string };
  decision: DecisionRecord;
  expectedSkillContentHash: string;
  eligibility: Eligibility;
  failureSignature: string;
  timestamp?: string;
}

// Where the acceptance left things, absolute: the record inside the skill, the lesson next to the others,
// and whether the reference line had to be added.
export interface AcceptResult {
  historyPath: string;
  lessonPath: string;
  referenceAdded: boolean;
}

export type AcceptOutcome = Result<AcceptResult, AcceptRejection>;

// The seams: every write of the protocol, plus the clock. Each one defaults to the function of
// src/writer.ts that implements it, so the acceptance exercises the real chokepoint; the ones that are a
// seam at all are the branch no real skill can be driven into on purpose -- a reference line that fails to
// land, and the clock every path of an acceptance is named after.
export interface AcceptDeps {
  now?: () => Date;
  snapshot?: (skillRealDir: string, timestamp: string) => Promise<string>;
  writeLesson?: (
    skillRealDir: string,
    slug: string,
    lessonText: string,
    expectedContentHash: string,
  ) => Promise<string>;
  removeLesson?: (skillRealDir: string, slug: string) => Promise<boolean>;
  upsertReference?: (skillRealDir: string, slug: string, title: string) => Promise<void>;
  writeHistoryDecision?: (skillRealDir: string, timestamp: string, decision: DecisionRecord) => Promise<string>;
  appendAttempt?: (base: string, line: AttemptLine) => Promise<void>;
}

// What an acceptance resolves its seams to. The type is derived and not declared: every field of AcceptDeps is one
// this resolver fills, so `Required<>` is exactly a resolved seam, and a new dependency means editing AcceptDeps and
// this resolver instead of a third list that could fall behind them.
type AcceptSeams = Required<AcceptDeps>;

// The protocol of §7, in its order. The answer is the acceptance or the named reason it did not happen;
// the refusal of a broken file is thrown, and it names the path it is about.
export async function acceptCandidate(request: AcceptRequest, deps: AcceptDeps = {}): Promise<AcceptOutcome> {
  const seams = seamsOf(deps);
  // One clock for the whole acceptance: the snapshot directory, the `decidedAt` of the record and the
  // `ts` of the index line name the same instant, so a reader can order them without comparing three
  // spellings of it.
  const now = seams.now();
  const skillDir = path.resolve(request.skill.realDir);
  const skillFilePath = path.join(skillDir, SKILL_FILE);
  const timestamp = request.timestamp ?? formatTimestamp(now, "history snapshot");
  const { slug, title, lessonText, contentHash } = request.candidate;

  // Step 0: the skill is still one the settings admit. The verdict is the caller's -- this module reads no settings, on
  // purpose -- and the refusal is here because this is the last moment before the first byte: a lesson written into a
  // skill the user has excluded since the gate would be one the loop refuses to improve from then on. Nothing of the skill
  // is read, nothing is snapshotted and nothing is written, which is what the reason says.
  const eligibility = request.eligibility;
  if (!eligibility.eligible) {
    return reject(
      "no-longer-eligible",
      `${quote(request.skill.name)} is no longer eligible: ${eligibility.reason}; nothing was written`,
    );
  }

  // The SKILL.md is read once: the reference count of step 1 and the hash of step 2 come from the same
  // bytes, so the two questions are answered about one version of the file.
  const skillBytes = readSkillBytes(skillFilePath);
  const reference = lessonReferencePath(slug);

  // Step 1: the slug is already reachable from the skill. Nothing is created, not even a snapshot: the
  // gate that accepted this candidate compared the skill with itself.
  if (countReferenceLines(skillBytes.toString("utf8"), slug) > 0) {
    return reject(
      "slug-already-referenced",
      `${quote(skillFilePath)} already references ${quote(reference)}: the gate compared the skill with itself, so no candidate was accepted`,
    );
  }

  // Step 2: the skill has not moved since the gate preregistered it. The perimeter of the skill file comes
  // with this check and before any write, so a SKILL.md that is a link out of the skill is refused here
  // instead of one step later, after the snapshot had been taken for it.
  assertWritable(skillFilePath, [skillDir]);
  const skillContentHash = sha256Digest(skillBytes);
  if (skillContentHash !== request.expectedSkillContentHash) {
    return reject(
      "skill-drift",
      `${quote(skillFilePath)} hashes to ${skillContentHash}, not to the ${request.expectedSkillContentHash} the gate preregistered for ${quote(skillDir)}: the candidate describes a skill that no longer exists`,
    );
  }

  // Step 3: the copy of the skill as it was, before anything of it changes. An occupied timestamp is its
  // own answer and not an error: the writer refuses it too, and this check only names it as the typed
  // rejection the caller reports. A timestamp that leaves `.history/` is not pre-checked here: the writer
  // refuses it with its perimeter, which is the guard that has to hold even if this check is removed.
  const snapshotPath = path.join(skillDir, HISTORY_DIR, timestamp);
  if (isInsideOrEqual(path.resolve(snapshotPath), skillDir) && fs.existsSync(snapshotPath)) {
    return reject(
      "history-exists",
      `the history snapshot ${quote(snapshotPath)} already exists: a history is never rewritten`,
    );
  }
  const snapshot = await seams.snapshot(skillDir, timestamp);

  // Step 4: the lesson, verified against the hash of the candidate. The writer refuses a text that does
  // not hash to it, so the bytes that land are the bytes the gate measured.
  const lessonPath = await seams.writeLesson(skillDir, slug, lessonText, contentHash);

  // Step 5: the reference line that makes the lesson reachable (Q10). A failure here withdraws the lesson,
  // because a lesson pi cannot reach is inert and a skill with half an acceptance is worse than the skill
  // that was there. The compensation does not change the reason: it is still a reference that could not be
  // written, and the detail says what happened to the lesson and names the snapshot that was kept.
  try {
    await seams.upsertReference(skillDir, slug, title);
  } catch (error) {
    const removed = await withdrawLesson(seams, skillDir, slug);
    return reject(
      "reference-failed",
      `the reference line ${quote(reference)} could not be written into ${quote(skillFilePath)}: ${toErrorMessage(error)}; the lesson ${quote(lessonPath)} was withdrawn (removed: ${removed}) and the snapshot ${quote(snapshot)} is kept`,
    );
  }

  // Step 6: the authoritative record of the acceptance, inside the snapshot the acceptance took. The
  // record is the one the gate wrote with the outcome of the write and nothing else: `gate.status` stays
  // "gate-accepted", which is what the gate decided, and the record is built as a copy because the caller
  // keeps its own object.
  const decision: DecisionRecord = {
    ...request.decision,
    outcome: { status: "accepted", reason: null, decidedAt: now.toISOString() },
  };
  const historyPath = await seams.writeHistoryDecision(skillDir, timestamp, decision);

  // Step 7: the event of the index, joined to the "proposed" and, through `candidateHash`, to the
  // "gate-accepted" of the staged record -- M1 emits no line for a gate that passed, so this is the line
  // that closes the pair. The candidate hash is the one step 3 verified against the bytes now on disk, and
  // the body hash is the one the record declares for that same candidate: the request carries the hash of
  // the file, the record carries the pair.
  await seams.appendAttempt(
    request.base,
    buildAttemptLine({
      now,
      event: "accepted",
      targetSkill: request.skill.name,
      hashes: { candidateHash: contentHash, bodyHash: request.decision.candidate.bodyHash },
      failureSignature: request.failureSignature,
      historyPath,
    }),
  );

  // Step 8 of the protocol is not a step of this module, and that is an invariant rather than a note about one
  // version of it: the reload of the session is a call on the context pi hands a command, and this function receives
  // AcceptDeps -- writes and seams, no context at all. The file that declares `waitForIdle` and `reload` is the
  // command's (SkillImproveContext, src/command-skill-improve.ts), and the two calls live at the end of its handler,
  // after this answer has returned and its writes are on disk. A reload written here would have to hand this module a
  // context it is built not to see, which is why the step is absent here now that it exists.
  //
  // `referenceAdded` is true whenever this answer is an acceptance, and that is not an assumption: step 0
  // refused a slug whose line was already there, and src/writer.ts proves after its write that the section
  // carries exactly one line for this slug. The field says the line exists as a result of this call, which
  // is what a caller reports; a future acceptance that tolerates an existing line can answer false here
  // without changing the shape of the answer.
  return { ok: true, value: { historyPath, lessonPath, referenceAdded: true } };
}

function seamsOf(deps: AcceptDeps): AcceptSeams {
  return {
    now: deps.now ?? currentTime,
    snapshot: deps.snapshot ?? snapshotForHistory,
    writeLesson: deps.writeLesson ?? writeLessonFile,
    removeLesson: deps.removeLesson ?? removeLessonFile,
    upsertReference: deps.upsertReference ?? upsertReferenceLine,
    writeHistoryDecision: deps.writeHistoryDecision ?? writeHistoryDecision,
    appendAttempt: deps.appendAttempt ?? appendAttemptLine,
  };
}

function reject(reason: AcceptRejectionReason, detail: string): AcceptOutcome {
  return { ok: false, error: { reason, detail } };
}

// The SKILL.md that steps 0 and 1 read. A file this module cannot read is a refusal with its path on it,
// and not a rejection with a reason of its own: the protocol names the states of a candidate, and a skill
// that cannot be read is a broken run.
function readSkillBytes(skillFilePath: string): Buffer {
  try {
    return fs.readFileSync(skillFilePath);
  } catch (error) {
    throw new SriWriterError(`cannot read the ${SKILL_FILE} of the skill: ${quote(skillFilePath)}: ${toErrorMessage(error)}`, skillFilePath);
  }
}

// The compensation of step 5. The removal can itself fail, and the error the caller is about to read
// already names the reference line that did not land, so this function only answers whether the lesson is
// gone -- the same value src/writer.ts answers with, and never a second reason (I8).
async function withdrawLesson(seams: AcceptSeams, skillDir: string, slug: string): Promise<boolean> {
  try {
    return await seams.removeLesson(skillDir, slug);
  } catch {
    return false;
  }
}
