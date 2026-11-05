// The retirement of an accepted lesson (M3, S4): the second and the last path of the package that writes inside a skill,
// and the only one that takes something back out of it. A lesson that stops applying is not deleted: the file stays where
// it is and its frontmatter says `status: "retired"`, which is the tombstone, and the reference line leaves `## Lessons`,
// which is what makes the lesson inert -- pi loads a lesson through that line and not through the file (Q10), so a
// retired lesson costs nothing to the next session however intact its bytes are.
//
// Everything this module writes goes through the chokepoint of src/writer.ts, which owns the perimeter, the mutation
// queue, the temporary file with its rename and the read-back; what lives here is the order of the writes and the answers
// of the protocol, nothing about bytes.
//
// The order of the writes is the contract and every position of it is a guarantee:
//
//   1. the lesson on disk is the one the acceptance measured: its `contentHash` is the one the record of the acceptance
//      declares. A file that is not there is `lesson-missing`, one whose bytes moved is `lesson-drift`, and neither writes
//      anything -- a retirement takes back the lesson that was accepted and not whatever the slug names today.
//   2. the snapshot comes before the first edit, as in the acceptance: the skill as it was is always on disk when this
//      module starts to change it, and a timestamp that is taken is taken.
//   3. the reference line leaves `## Lessons`. This step comes *before* the tombstone and not after it, and that is the one
//      reason of the order: if step 4 fails, the file still says `accepted` and the lesson is already inert, so running the
//      retirement again finds the pre-image of step 1 intact and finishes. In the other order the second run trips over
//      its own pre-image -- the bytes it finds are a tombstone it wrote halfway -- and the skill keeps a tombstone nobody
//      can reach with the tool: the line is gone, the retirement is refused, and no invocation repairs it.
//   4. the lesson is rewritten with `status: "retired"` and the same body. The writer post-conditions the `bodyHash`, so a
//      retirement that changed the body is an error and not a retirement: the state changes and the correction does not.
//   5. `.history/<timestamp>/retirement.json`, the record of what was retired with which hashes and why, written after the
//      bytes of the skill landed.
//   6. the `retired` line of the index, with the pair of hashes of the acceptance and `failureSignature: null` -- the field
//      is required and nullable on purpose (OA4 of M1) -- so the line joins its `accepted` by `candidateHash` exactly the
//      way that line joined the `proposed` of the run that produced it.
//
// The merit of a retirement is the user's and not a measurement: there is no gate here. Requiring a measured regression
// before retiring would make a lesson that is simply false impossible to take back, which is the case the reason `wrong`
// exists for. The vocabulary of the reasons is closed and each key names a state the caller reports differently; the
// detail is free text, because a key without a sentence is a reason nobody can act on.
//
// Nothing here reads settings, calls a model, spawns anything or resolves the inventory: it takes the record of the
// acceptance as data, the reason as data and one clock, and the answer is either the retirement or the named reason it did
// not happen. Refusals the protocol does not name -- a snapshot that cannot be taken, a tombstone that cannot be written,
// a record that cannot land -- are thrown, the same way the rest of the package treats a broken file.

import fs from "node:fs";
import path from "node:path";
import { buildAttemptLine } from "./attempts.ts";
import { HISTORY_DIR } from "./names.ts";
import { isInsideOrEqual } from "./perimeter.ts";
import { lessonReferencePath } from "./skill-reference.ts";
import type { AttemptLine, Result, RetirementRecord } from "./types.ts";
import { currentTime, isMissingPathError, quote, toErrorMessage } from "./values.ts";
import {
  appendAttemptLine,
  dropReferenceLine,
  formatTimestamp,
  lessonHashes,
  retireLessonFile,
  snapshotForHistory,
  SriWriterError,
  writeHistoryRetirement,
} from "./writer.ts";

// Why a lesson stops applying. The list is closed and each key names a state a reader acts differently on: it went stale,
// something better replaced it, it was measured as ineffective, it is simply false, or nothing references it any more.
// The type is derived from the array the way LESSON_STATUSES is (I4), the schema declares the same five as its enum, and
// the manual teaches each key -- test/unit/package-skill.test.ts fails to compile without its line.
export const RETIREMENT_REASONS = ["stale", "superseded", "ineffective", "wrong", "unreferenced"] as const;

export type RetirementReason = (typeof RETIREMENT_REASONS)[number];

// Why an accepted lesson was not retired. The list is closed and each reason names a state the caller reports
// differently: the index does not hold an acceptance of this slug with these hashes, the index cannot be read at all (so
// nothing can be affirmed about what it accepted), the accepted file is not in the skill any more, its bytes moved from
// the ones the acceptance measured, the timestamp of the snapshot is taken, or the reference line could not be removed and
// the retirement stopped there. None of them is a failure of the run itself, which is why they are values and not errors.
export type RetireRejectionReason =
  | "never-accepted"
  | "unreadable-index"
  | "lesson-missing"
  | "lesson-drift"
  | "history-exists"
  | "reference-failed";

export interface RetireRejection {
  reason: RetireRejectionReason;
  detail: string;
}

// The skill block, taken from the record of the acceptance and never from the inventory: the `realDir` here is the path
// the acceptance wrote through, which is also the path the lesson and the snapshot are read from.
export interface RetireSkill {
  name: string;
  dir: string;
  realDir: string;
  wasSymlink: boolean;
}

// What a retirement needs, and all of it comes from one place: the record of the acceptance. `contentHash` is the pre-image
// of step 1 and `bodyHash` is the other half of the pair the acceptance declared, which travels so the record and the line
// of the index can carry it: the whole-file digest covers the body, so once step 1 passes the pair cannot disagree with the
// bytes on disk. `title` is the title the acceptance recorded, which is what the retirement record carries;
// `acceptedHistoryPath` is that record's own path inside the skill, or null when the line of the index that named it carried
// none.
//
// `timestamp` names the snapshot directory and defaults to the clock of `deps.now`, in the same spelling the acceptance
// gives it: UTC, no separators. It travels in the request because a test proves the refusal of an occupied timestamp
// without waiting for a millisecond to pass.
export interface RetireRequest {
  base: string;
  skill: RetireSkill;
  lesson: { slug: string; title: string; contentHash: string; bodyHash: string };
  acceptedHistoryPath: string | null;
  reason: { key: RetirementReason; detail: string };
  timestamp?: string;
}

// Where the retirement left things, absolute: the tombstone, the record of the reason, and whether the reference line had
// to be removed -- a skill that never referenced the lesson is one the retirement did not have to edit.
export interface RetireResult {
  lessonPath: string;
  retirementPath: string;
  referenceRemoved: boolean;
  retiredContentHash: string;
}

export type RetireOutcome = Result<RetireResult, RetireRejection>;

// The seams: every write of the protocol, plus the clock. Each one defaults to the function of src/writer.ts that
// implements it, so the retirement exercises the real chokepoint; the ones that are a seam at all are the branches no real
// skill can be driven into on purpose -- a reference line that cannot come out, a tombstone that cannot be written, and
// the clock every snapshot of a retirement is named after.
export interface RetireDeps {
  now?: () => Date;
  snapshot?: (skillRealDir: string, timestamp: string) => Promise<string>;
  dropReference?: (skillRealDir: string, slug: string) => Promise<boolean>;
  retireLesson?: (skillRealDir: string, slug: string, expectedContentHash: string) => Promise<{ contentHash: string; bodyHash: string }>;
  writeHistoryRetirement?: (skillRealDir: string, timestamp: string, record: RetirementRecord) => Promise<string>;
  appendAttempt?: (base: string, line: AttemptLine) => Promise<void>;
}

// What a retirement resolves its seams to. The type is derived and not declared, the rule src/gate/acceptance.ts follows:
// every field of RetireDeps is one this resolver fills, so a new dependency means editing RetireDeps and this resolver
// instead of a third list that could fall behind them.
type RetireSeams = Required<RetireDeps>;

// The protocol above, in its order. The answer is the retirement or the named reason it did not happen; the refusal of a
// broken file is thrown, and it names the path it is about.
export async function retireLesson(request: RetireRequest, deps: RetireDeps = {}): Promise<RetireOutcome> {
  const seams = seamsOf(deps);
  // One clock for the whole retirement: the snapshot directory, the `createdAt` of the record and the `ts` of the index
  // line name the same instant, so a reader can order them without comparing three spellings of it.
  const now = seams.now();
  const skillDir = path.resolve(request.skill.realDir);
  const timestamp = request.timestamp ?? formatTimestamp(now, "history snapshot");
  const { slug } = request.lesson;
  const lessonPath = path.join(skillDir, lessonReferencePath(slug));

  // Step 1: the file on disk is the lesson the acceptance measured. Nothing is snapshotted and nothing is written for a
  // file that moved: a tombstone over bytes nobody accepted would retire a correction the gate never measured.
  const before = readLessonText(lessonPath);
  if (before.kind === "missing") {
    return reject("lesson-missing", `the lesson ${quote(lessonPath)} is not there, and the index records an acceptance of it`);
  }
  const hashes = lessonHashes(before.text);
  if (!hashes.ok) {
    return reject("lesson-drift", `${quote(lessonPath)} is not a valid lesson file (${hashes.error}), so it is not the lesson the acceptance measured`);
  }
  if (hashes.value.contentHash !== request.lesson.contentHash) {
    return reject(
      "lesson-drift",
      `${quote(lessonPath)} hashes to ${hashes.value.contentHash}, not to the ${request.lesson.contentHash} the acceptance measured for ${quote(skillDir)}`,
    );
  }

  // Step 2: the copy of the skill as it was, before anything of it changes. An occupied timestamp is its own answer and
  // not an error: the writer refuses it too, and this check only names it as the typed rejection the caller reports. A
  // timestamp that leaves `.history/` is not pre-checked here: the writer refuses it with its perimeter, which is the
  // guard that has to hold even if this check is removed.
  const snapshotPath = path.join(skillDir, HISTORY_DIR, timestamp);
  if (isInsideOrEqual(path.resolve(snapshotPath), skillDir) && fs.existsSync(snapshotPath)) {
    return reject(
      "history-exists",
      `the history snapshot ${quote(snapshotPath)} already exists, so no snapshot was taken and nothing was written: a history is never rewritten`,
    );
  }
  const snapshot = await seams.snapshot(skillDir, timestamp);

  // Step 3: the reference line leaves the section, and this comes before the tombstone on purpose -- see the module
  // comment: a retirement that stops here leaves a skill that is inert and unchanged, and the next run finishes.
  let referenceRemoved: boolean;
  try {
    referenceRemoved = await seams.dropReference(skillDir, slug);
  } catch (error) {
    return reject(
      "reference-failed",
      `the reference line to ${quote(lessonReferencePath(slug))} could not be removed from the skill: ${toErrorMessage(error)}; the snapshot ${quote(snapshot)} is kept and no tombstone, no record and no line of the index were written, so the retirement can be run again`,
    );
  }

  // Step 4: the tombstone, verified against the same hash step 1 verified and post-conditioned on the body it found.
  const tombstone = await seams.retireLesson(skillDir, slug, request.lesson.contentHash);

  // Step 5: the record of the reason, inside the snapshot this retirement took. The two hashes of the lesson are the ones
  // of the acceptance, which are the ones steps 1 and 4 verified, and `retiredContentHash` is what the file says now.
  const record: RetirementRecord = {
    schema: "pi-simple-sri/retirement@1",
    createdAt: now.toISOString(),
    skill: {
      name: request.skill.name,
      dir: request.skill.dir,
      realDir: request.skill.realDir,
      wasSymlink: request.skill.wasSymlink,
    },
    lesson: {
      slug,
      title: request.lesson.title,
      lessonPath: lessonReferencePath(slug),
      contentHash: request.lesson.contentHash,
      bodyHash: request.lesson.bodyHash,
      retiredContentHash: tombstone.contentHash,
    },
    retires: { historyPath: request.acceptedHistoryPath },
    reason: { key: request.reason.key, detail: request.reason.detail },
  };
  const retirementPath = await seams.writeHistoryRetirement(skillDir, timestamp, record);

  // Step 6: the event of the index, joined to its `accepted` by the pair of hashes of the acceptance. `failureSignature`
  // is null because a retirement decides nothing about a failure, and `reason` carries the key and the sentence in one field
  // -- the two the record of the retirement keeps apart -- so the line says why a reader of the index alone can tell.
  await seams.appendAttempt(
    request.base,
    buildAttemptLine({
      now,
      event: "retired",
      targetSkill: request.skill.name,
      hashes: { candidateHash: request.lesson.contentHash, bodyHash: request.lesson.bodyHash },
      failureSignature: null,
      ...(request.acceptedHistoryPath === null ? {} : { historyPath: request.acceptedHistoryPath }),
      reason: `${request.reason.key}: ${request.reason.detail}`,
    }),
  );

  return {
    ok: true,
    value: {
      lessonPath,
      retirementPath,
      referenceRemoved,
      retiredContentHash: tombstone.contentHash,
    },
  };
}

function seamsOf(deps: RetireDeps): RetireSeams {
  return {
    now: deps.now ?? currentTime,
    snapshot: deps.snapshot ?? snapshotForHistory,
    dropReference: deps.dropReference ?? dropReferenceLine,
    retireLesson: deps.retireLesson ?? retireLessonFile,
    writeHistoryRetirement: deps.writeHistoryRetirement ?? writeHistoryRetirement,
    appendAttempt: deps.appendAttempt ?? appendAttemptLine,
  };
}

function reject(reason: RetireRejectionReason, detail: string): RetireOutcome {
  return { ok: false, error: { reason, detail } };
}

// The text of the lesson step 1 verifies. A file that is not there is the answer `missing` and not an exception -- it is
// the `lesson-missing` rejection -- while a read that failed for any other reason is a broken skill, and it throws with the
// path it is about, the rule src/gate/acceptance.ts follows for the SKILL.md it reads.
function readLessonText(lessonPath: string): { kind: "present"; text: string } | { kind: "missing" } {
  try {
    return { kind: "present", text: fs.readFileSync(lessonPath, "utf8") };
  } catch (error) {
    if (isMissingPathError(error)) {
      return { kind: "missing" };
    }
    throw new SriWriterError(`cannot read the lesson: ${quote(lessonPath)}: ${toErrorMessage(error)}`, lessonPath);
  }
}
