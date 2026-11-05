import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { SriWriterError } from "./errors.ts";
import { sha256Digest } from "./hash.ts";
import { parseLesson, serializeLesson } from "./lesson-frontmatter.ts";
import { ATTEMPTS_FILE, DECISION_FILE, HISTORY_DIR, LESSONS_DIR, RETIREMENT_FILE, SIGNALS_FILE, SKILL_FILE } from "./names.ts";
// Type-only, so the append of a signal line does not make this module depend on the collector at run time: the
// collector is the module that writes through this chokepoint, and the shape of the line it writes is declared there.
import type { SignalLine } from "./signals.ts";
import { stagingDir, stateDir } from "./write-base.ts";
import { assertWritable, isInsideOrEqual } from "./perimeter.ts";
import * as skillReference from "./skill-reference.ts";
import type { AttemptLine, DecisionRecord, Result, RetirementRecord, SkillRef } from "./types.ts";
import { isAlreadyExistsError, isMissingPathError, isPlainObject, isRegularFile, quote, toErrorMessage } from "./values.ts";

// The single write chokepoint of the package. Every write here:
//   1. runs assertWritable against the narrowest root that applies -- <base>/staging for
//      candidates, the skill directory, its lessons/ and its .history/ for the M1 writes,
//      the destination of a copy -- so a generated skill name, slug or timestamp cannot
//      leave the perimeter. The guard lives in the two write primitives below, which take
//      the root and assert it as their first statement (I10): no path through this module
//      reaches the disk without it, including a call site added later. A directory the
//      module creates itself, such as the history snapshot or the destination of a copy,
//      is checked before it is created, because no primitive sees that mkdir;
//   2. runs inside withFileMutationQueue(), which serializes operations targeting the
//      same file (keyed by realpath) and lets unrelated files proceed in parallel;
//   3. writes a temporary file in the destination directory and renames it, so a reader
//      never sees a half-written file;
//   4. reads the file back and compares the bytes, so a write that did not land is an
//      error instead of a silent success (verification on write, not only on read).
//
// The two writes of the package that are not a temporary file and a rename are the appends to the two files that are only
// ever added to: the index of attempts and the file of signals. One line is appended to them, in one write, and the write
// is verified against the tail of the file instead of against a read of the whole thing (appendAttemptLine, OA11;
// appendSignalLine, M3 S5). Everything above -- the perimeter first, the queue around it -- still holds for both, and both
// go through the same private helper so the protocol exists once.
//
// Nothing here renders lesson frontmatter: src/lesson-frontmatter.ts owns that format
// (P6) and hands the serialized file over as text. This module only moves bytes, hashes
// them and decides where they go -- and, before publishing a candidate, reads that text
// back with parseLesson (I6), so the writer never vouches for bytes it cannot parse.
// The Markdown of SKILL.md is not edited here either: src/skill-reference.ts owns the
// `## Lessons` section and the reference line (I9), and this module only writes the text
// that editor returns and verifies what landed.

const TEMP_PREFIX = ".sri-write-";
const MAX_TIMESTAMP_ATTEMPTS = 100;

// How much wider than its own line the verification of an append reads the tail of the index. The queue
// serializes this process only (OA11), so a line another process of pi appended between the write of this one
// and the read that follows it can be the last line of the file, and the line of this call then sits one or
// more lines back. A line of the index is a few hundred bytes, so this slack holds a whole cluster of them.
const TAIL_SLACK_BYTES = 8 * 1024;

// What a copy of a skill tree never receives: the skill's own history and its version control directory.
// Both live inside the skill directory and neither is part of what pi loads from it (Q9).
const EXCLUDED_COPY_ENTRIES: readonly string[] = [HISTORY_DIR, ".git"];

// The error class lives in src/errors.ts with the rest of the fail-closed errors; it is
// re-exported here because this is the module that raises it.
export { SriWriterError };

export interface StagingWriteInput {
  base: string; // writeBase(): staging/ and state/ live under it
  skill: SkillRef;
  slug: string; // names the file: lessons/<slug>.md
  decision: DecisionRecord;
  now: Date;
  // The complete lesson file, frontmatter included, already serialized. It is text and
  // not a LessonDraft on purpose: the file format belongs to src/lesson-frontmatter.ts
  // (P6) and reproducing it here would make two owners of the same format. It is the only
  // lesson input (I6): both hashes below and the file that lands on disk come from these
  // bytes, so the caller cannot hand over a draft that disagrees with the text.
  lessonText: string;
}

// The pair of hashes of a candidate, and its two names (D4).
export interface LessonHashes {
  contentHash: string; // "sha256:" + 64 hex, over the whole lesson file
  bodyHash: string; // "sha256:" + 64 hex, over the normalized body (D4)
}

export interface StagingWriteResult extends LessonHashes {
  stagingPath: string;
  lessonPath: string;
  decisionPath: string;
}

// D4: the two hashes come from the one input that defines a candidate, the lesson file as it will be
// written, and this is the only place the pair is computed. The flow uses it to build decision.json
// and the writer uses it to stamp the bytes it publishes, so the record in memory and the file it
// becomes cannot disagree -- only the writer hashes the normalized body of the bytes it wrote.
//
// A text this module cannot parse has no hashes: parseLesson owns the format (I6), so a text its own
// reader rejects comes back as the reason instead of as a digest of bytes nobody can recover.
export function lessonHashes(lessonText: string): Result<LessonHashes, string> {
  const parsed = parseLesson(lessonText);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  return {
    ok: true,
    value: {
      contentHash: sha256Digest(Buffer.from(lessonText, "utf8")),
      bodyHash: sha256Digest(Buffer.from(normalizeBody(parsed.value.body), "utf8")),
    },
  };
}

// The one absoluteness guard of the write chokepoint: a relative base resolves against the working
// directory of the process, so the tree would land in whatever project pi was started in. `operation`
// is the phrase that names what the caller was about to do, and `detail` the thing to quote when the
// operation needs one.
function requireAbsoluteBase(value: string, operation: string, detail?: string): void {
  if (path.isAbsolute(value)) return;
  const refused = detail === undefined ? operation : `${operation} ${quote(detail)}`;
  throw new SriWriterError(`${quote(value)} is not absolute: refusing to ${refused}`, value);
}

// Writes <base>/staging/<ts>/<skill>/lessons/<slug>.md and decision.json next to it.
// `ts` is UTC YYYYMMDDTHHMMSSfffZ; a timestamp already in use gets -2, -3, ... so two
// candidates produced in the same millisecond never share a directory.
export async function writeStagingCandidate(input: StagingWriteInput): Promise<StagingWriteResult> {
  // I12: refused while nothing exists yet, before the perimeter below ever runs.
  requireAbsoluteBase(input.base, "create", stagingDir(input.base));

  const stagingRoot = stagingDir(input.base);
  const lessonFileName = `${input.slug}.md`;

  // I6: the text is what the candidate will be, so it is read back with the parser of
  // src/lesson-frontmatter.ts before the staging tree exists. A text its own reader rejects
  // would become a lesson no later step can recover, and the hashes below would describe
  // bytes this module cannot vouch for. lessonHashes names the field that failed.
  const hashes = lessonHashes(input.lessonText);
  if (!hashes.ok) {
    throw new SriWriterError(
      `refusing to stage ${quote(lessonFileName)}: the lesson text is not a valid lesson file (${hashes.error})`,
      stagingRoot,
    );
  }

  fs.mkdirSync(stagingRoot, { recursive: true });

  const baseTimestamp = formatTimestamp(input.now, "staging directory");

  // Probe before the timestamp directory exists: the skill name and the slug become path
  // segments, so a name such as "../../etc" must be rejected while staging is still
  // empty. The probe carries the timestamp a real candidate would use, so nothing is
  // created for it.
  assertWritable(path.join(stagingRoot, baseTimestamp, input.skill.name, LESSONS_DIR, lessonFileName), [stagingRoot]);
  assertWritable(path.join(stagingRoot, baseTimestamp, input.skill.name, DECISION_FILE), [stagingRoot]);

  const stagingPath = allocateCandidateDir(stagingRoot, baseTimestamp);
  // The candidate directory adds the skill name; `stagingPath` is the timestamp
  // directory that the collision guard allocated.
  const candidateDir = path.join(stagingPath, input.skill.name);
  const lessonsDir = path.join(candidateDir, LESSONS_DIR);
  const lessonPath = path.join(lessonsDir, lessonFileName);
  const decisionPath = path.join(candidateDir, DECISION_FILE);

  fs.mkdirSync(lessonsDir, { recursive: true });

  // Both hashes come from the same text (I6), through the one function that computes the pair
  // (lessonHashes below): the whole file as it will be written, and the normalized body of the draft
  // a reader recovers from those bytes. The flow builds decision.json with the same pair, so the
  // values stamped here are the values the record already carried.
  //
  // The narrowest roots travel to the two writes below -- lessons/ for the lesson, the candidate
  // directory for the record -- because a slug carrying a path separator stays inside staging but
  // leaves lessons/, which is not where the lesson belongs. Two checks cover them and neither
  // replaces the other: the probes above run while staging is still empty, against the full path a
  // candidate would use, and the guard inside the primitive re-asserts the path against the
  // narrower root as its first statement, before the temporary file exists (I10), so a call site
  // added later cannot skip it.
  const lessonBytes = Buffer.from(input.lessonText, "utf8");

  await writeFileQueued(lessonPath, lessonBytes, lessonsDir);

  const { contentHash, bodyHash } = hashes.value;
  // decision.json lands last and already stamped: a record on disk means the lesson it names
  // is on disk too, and carries the hashes of those exact bytes.
  await writeFileQueued(
    decisionPath,
    Buffer.from(
      decisionText({ ...input.decision, candidate: { ...input.decision.candidate, contentHash, bodyHash } }),
      "utf8",
    ),
    candidateDir,
  );

  return {
    stagingPath: candidateDir,
    lessonPath,
    decisionPath,
    contentHash,
    bodyHash,
  };
}

// Append-only index: one JSON line per event (Q14). The existing bytes are never rewritten or reordered; the
// new line is the only addition, so events joined by candidateHash stay readable after a crash.
//
// The append is one write with the newline included, made through a handle opened for appending (OA11).
// O_APPEND places the bytes at the end of the file as the kernel sees it when the write runs, so two
// processes of pi appending at the same moment cannot lose each other's line the way a read-modify-write
// does -- the whole file used to be read and written back, and the writer that read first overwrote the line
// of the writer that landed in between.
//
// There is no lock file and no retry: a lock is machinery the majority decision discarded (tmp/plan-M1.md,
// OA11), because the append of one line is what has to be atomic and it already is. What stays is the
// in-process queue, which keeps two callers of this module from interleaving their verification, and the
// perimeter, which runs before the handle exists (I10).
export async function appendAttemptLine(base: string, line: AttemptLine): Promise<void> {
  await appendStateLine(base, ATTEMPTS_FILE, line);
}

// The same append for the file of signals (M3, S5): the collector raises and consumes suspicions in a file that is only
// ever added to, under the same state directory and with the same protocol. The line is the collector's to shape
// (src/signals.ts owns the two events) and the protocol is this module's only, which is why the helper below is the one
// append of the package and this function is a name and a file.
export async function appendSignalLine(base: string, line: SignalLine): Promise<void> {
  await appendStateLine(base, SIGNALS_FILE, line);
}

// The one append of the module: `file` is the name of an append-only file under state/, and the base of the run decides
// the directory it lands in. The caller of an append names no path, so no caller can append outside the state directory
// of the base it was given.
async function appendStateLine(base: string, file: string, line: AttemptLine | SignalLine): Promise<void> {
  requireAbsoluteBase(base, "append");

  // The base is known here, so the write is guarded against the whole state directory instead of the path the
  // caller handed over; that check runs inside appendQueued below, where the bytes land, and is not repeated
  // here.
  const stateRoot = stateDir(base);
  const statePath = path.join(stateRoot, file);
  fs.mkdirSync(stateRoot, { recursive: true });

  // One string, one write: the newline travels with the line, so a crash either lands the whole event or
  // leaves the file as it was to the last complete line.
  const jsonLine = `${JSON.stringify(line)}\n`;
  const bytes = Buffer.from(jsonLine, "utf8");

  await withFileMutationQueue(statePath, async () => {
    await assertEndsWithNewline(statePath);
    await appendQueued(statePath, bytes, stateRoot);

    // Verified by its tail: the question is whether the line landed, and the last bytes of the file answer
    // it without reading -- and certainly without rewriting -- the lines that were already there.
    //
    // The question is not whether the line is the last one. Two processes of pi appending to the same file is
    // the ordinary case (OA11), and one of them can land its line between the append above and this read: the
    // tail then ends with a line this call did not write, while the line of this call is one or more lines
    // back, still in the window TAIL_SLACK_BYTES makes wide enough to hold it. What the window proves is what
    // the append promised: the file ends where a line ends, and this event is in it. A substring cannot be
    // some other event -- buildAttemptLine makes its line unique through `ts` and the candidate hashes, and the id of a
    // signal line is the occurrence itself.
    const tail = await readTail(statePath, bytes.length + TAIL_SLACK_BYTES);
    if (!tail.endsWith("\n") || !tail.includes(jsonLine)) {
      throw new SriWriterError(
        `${quote(statePath)}: the event that was written does not appear in the tail of the index after the append`,
        statePath,
      );
    }
  });
}

// The compensation of a candidate whose index line failed (F1): the directory this module created is
// removed, because a candidate no line names is an orphan -- the run would report that nothing was
// written while the bytes sit in staging, and the next run would trip over a directory nobody can
// explain. Removal is the one destructive operation in this module, so it is guarded by the same
// perimeter as the writes: only a directory inside <base>/staging is discarded. The answer says
// whether the directory is gone; the caller reports it next to the error that caused the removal.
export async function discardStagingCandidate(base: string, stagingPath: string): Promise<boolean> {
  requireAbsoluteBase(base, "discard", stagingPath);

  assertWritable(stagingPath, [stagingDir(base)]);

  try {
    await fs.promises.rm(stagingPath, { recursive: true, force: true });
    // "Removed" means the path is gone after the attempt, the same reading removeIfExists has.
    return true;
  } catch {
    return false;
  }
}

// Copies SKILL.md and lessons/ into <skillRealDir>/.history/<timestamp>/ before a skill
// is modified (M1). History is never rewritten: a timestamp that already exists is an
// error, not an overwrite.
export async function snapshotForHistory(skillRealDir: string, timestamp: string): Promise<string> {
  const skillDir = requireDirectory(skillRealDir, "skill directory");
  const skillFilePath = path.join(skillDir, SKILL_FILE);
  const lessonsPath = path.join(skillDir, LESSONS_DIR);
  const snapshotPath = path.join(skillDir, HISTORY_DIR, timestamp);

  // The snapshot lands inside the skill, so the skill directory is the root. This check is not
  // delegated to the write primitive below, and it is not a duplicate of it: the snapshot
  // directory is created with mkdirSync, which no primitive guards, so an escaping timestamp has
  // to be refused before that call. Without it the writer would create a directory outside the
  // skill and only then fail on the file it puts inside.
  assertWritable(snapshotPath, [skillDir]);

  if (!isRegularFile(skillFilePath)) {
    throw new SriWriterError(`${quote(skillFilePath)} is not a regular file: refusing to snapshot ${quote(skillDir)}`, skillDir);
  }

  return await withFileMutationQueue(snapshotPath, async () => {
    if (fs.existsSync(snapshotPath)) {
      throw new SriWriterError(`history snapshot ${quote(snapshotPath)} already exists: history is never rewritten`, snapshotPath);
    }

    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    try {
      // Non-recursive: EEXIST means a concurrent call claimed this timestamp first.
      fs.mkdirSync(snapshotPath);
    } catch (error) {
      throw new SriWriterError(`cannot create the history snapshot ${quote(snapshotPath)}: ${toErrorMessage(error)}`, snapshotPath);
    }

    try {
      await writeFileAtomic(path.join(snapshotPath, SKILL_FILE), await readBytesOrThrow(skillFilePath), skillDir);

      if (fs.existsSync(lessonsPath)) {
        const lessonsSnapshot = path.join(snapshotPath, LESSONS_DIR);
        await copyTree(lessonsPath, lessonsSnapshot, skillDir);
        const source = listRelativeFiles(lessonsPath);
        const copy = listRelativeFiles(lessonsSnapshot);
        if (source.join("\n") !== copy.join("\n")) {
          throw new SriWriterError(`the history snapshot of ${quote(lessonsPath)} is incomplete`, snapshotPath);
        }
      }
    } catch (error) {
      // I7: a copy that fails halfway leaves a partial snapshot, and history is never
      // rewritten, so that timestamp would stay blocked forever. The failure removes what
      // it created and rethrows the original error.
      discardPartialSnapshot(snapshotPath);
      throw error;
    }

    return snapshotPath;
  });
}

// Adds "- [lessons/<slug>.md](lessons/<slug>.md) - <title>" to SKILL.md, idempotent by
// slug: a lesson referenced already is left untouched, so accepting twice cannot add the
// line twice. Without the line a lesson is inert (Q10), which is why acceptance writes it.
// The edit itself is text -> text and lives in src/skill-reference.ts (I9); what stays here is
// the file: reading it, writing it inside the perimeter and checking the line landed.
export async function upsertReferenceLine(skillRealDir: string, slug: string, title: string): Promise<void> {
  const skillDir = requireDirectory(skillRealDir, "skill directory");
  const skillFilePath = path.join(skillDir, SKILL_FILE);

  // No assertWritable here: writeFileAtomic guards the file against the skill directory as its
  // first statement (I10), and this function writes nothing else. The check this function adds is
  // about content, not about the perimeter: the read-back below counts the reference lines.
  await withFileMutationQueue(skillFilePath, async () => {
    const content = await readTextOrThrow(skillFilePath);
    const next = skillReference.upsertReferenceLine(content, slug, title);
    await writeFileAtomic(skillFilePath, Buffer.from(next, "utf8"), skillDir);

    const readBack = await readTextOrThrow(skillFilePath);
    if (skillReference.countReferenceLines(readBack, slug) !== 1) {
      throw new SriWriterError(
        `${quote(skillFilePath)}: the reference to ${quote(skillReference.lessonReferencePath(slug))} is not exactly one line after the write`,
        skillFilePath,
      );
    }
  });
}

// ---------------------------------------------------------------------------------------------
// M1 primitives: the six operations the gate and the acceptance need. Each of them is an entry point of
// this chokepoint, not a new rule: the perimeter, the mutation queue, the temporary file with its rename
// and the read-back are the ones above. What each one adds is the narrowest root that applies to it --
// staging/ for a record, the skill for a lesson, .history/ for a history record, the destination for a
// copy -- plus the hash it has to agree with before it writes.
// ---------------------------------------------------------------------------------------------

export interface OverlayCopyResult {
  files: number;
  manifestHash: string; // "sha256:" + 64 hex over the sorted manifest of the copy
}

// Copies a whole skill tree into `destinationDir`, which the caller places inside `root` (the arms of
// the gate are built from the skill as it stands, §S5). Two entries never travel: `.history/` is the
// skill's own history, and a copy that carried it would double a history that is never rewritten, and
// `.git/` is not part of what a skill is to pi.
//
// A symlink inside the skill is refused rather than followed: an arm has to be exactly what the skill
// says it is, and a link can point anywhere, including out of the root the copy is guarded by.
//
// The answer is the number of files copied and `manifestHash`, the digest of the manifest of the copy,
// so whoever compares the two arms can prove they differ where they should and nowhere else. The
// manifest is the sorted list of relative paths, each with the digest of the bytes it holds: two copies
// of the same tree answer the same hash, and one changed byte changes it.
export async function copySkillTree(sourceRealDir: string, destinationDir: string, root: string): Promise<OverlayCopyResult> {
  // This call creates the destination, so it is asserted against the caller's root before the directory
  // exists (I10: nothing this module creates is created unguarded).
  assertWritable(destinationDir, [root]);
  const sourceDir = requireDirectory(sourceRealDir, "skill directory");

  return await withFileMutationQueue(destinationDir, async () => {
    try {
      // The root of every file of the copy is the copy itself: it exists from the mkdir inside copyTree,
      // and nothing the walk discovers can place a file outside it.
      await copyTree(sourceDir, destinationDir, destinationDir, EXCLUDED_COPY_ENTRIES);
    } catch (error) {
      // A copy that fails halfway leaves an arm missing files, and an arm is read as the whole skill: it
      // is discarded instead of published, the same rule the history snapshot follows (I7).
      discardPartialSnapshot(destinationDir);
      throw error;
    }

    const manifest: string[] = [];
    for (const relative of listRelativeFiles(destinationDir)) {
      const digest = sha256Digest(await readBytesOrThrow(path.join(destinationDir, relative)));
      manifest.push(`${digest}  ${relative}`);
    }

    return { files: manifest.length, manifestHash: sha256Digest(manifest.join("\n")) };
  });
}

// The text of a run: the JSONL of a replay (§OA10) and any other artefact a caller has to keep. The
// caller names the narrowest root the file may land in -- the directory the artefact belongs to -- and
// this primitive only forwards to the write the rest of the module uses, so the temporary file, the
// rename, the read-back and the symlink rule (Q11) are not restated here. No directory is created: a
// target whose directory does not exist is a refusal, never an implicit mkdir.
export async function writeTextAtomically(target: string, text: string, root: string): Promise<void> {
  await writeFileQueued(target, Buffer.from(text, "utf8"), root);
}

export interface DecisionRewriteResult {
  decisionPath: string;
  contentHash: string; // the hash of the lesson on disk, which this call verified
  bodyHash: string;
}

// Replaces the decision.json of a staged candidate (§S8): the preregistration and the verdict of the
// gate are written into the same record, so one file stays authoritative and the timestamp of the
// preregistration stays auditable.
//
// The record on disk is read first and the lesson it describes is hashed: a record is only replaced
// while the candidate on disk is still the candidate the record declares. A decision.json that carried
// a verdict about bytes nobody can find would be worse than no verdict at all.
export async function rewriteStagingDecision(
  base: string,
  stagingPath: string,
  decision: DecisionRecord,
): Promise<DecisionRewriteResult> {
  const stagingRoot = stagingDir(base);
  const decisionPath = path.join(stagingPath, DECISION_FILE);

  // staging/ is the root and not the candidate directory: the candidate is a path the caller names, so a
  // root taken from it would move together with an escaping stagingPath.
  assertWritable(decisionPath, [stagingRoot]);

  return await withFileMutationQueue(decisionPath, async () => {
    const candidate = await readStagedCandidate(decisionPath);

    // The record was read from disk, so the slug that names its lesson is data and not a trusted segment:
    // it stays inside the candidate directory, which is the only place a lesson of that candidate lives.
    const lessonPath = path.join(stagingPath, LESSONS_DIR, `${candidate.slug}.md`);
    if (!isInsideOrEqual(path.resolve(lessonPath), path.resolve(stagingPath))) {
      throw new SriWriterError(
        `refusing to rewrite ${quote(decisionPath)}: the record names a lesson outside the candidate directory`, decisionPath,
      );
    }

    const hashes = lessonHashes(await readTextOrThrow(lessonPath));
    if (!hashes.ok) {
      throw new SriWriterError(
        `refusing to rewrite ${quote(decisionPath)}: the lesson ${quote(lessonPath)} is not a valid lesson file (${hashes.error})`,
        decisionPath,
      );
    }
    if (hashes.value.contentHash !== candidate.contentHash || hashes.value.bodyHash !== candidate.bodyHash) {
      throw new SriWriterError(
        `refusing to rewrite ${quote(decisionPath)}: the lesson ${quote(lessonPath)} no longer hashes to what the record declares`,
        decisionPath,
      );
    }

    // The verified pair is what the new record carries, the same way writeStagingCandidate stamps the
    // bytes it publishes: the record and the file it names cannot disagree.
    const { contentHash, bodyHash } = hashes.value;
    await writeFileAtomic(
      decisionPath,
      Buffer.from(
        decisionText({ ...decision, candidate: { ...decision.candidate, contentHash, bodyHash } }),
        "utf8",
      ),
      stagingRoot,
    );

    return { decisionPath, contentHash, bodyHash };
  });
}

// The accepted lesson lands inside the skill (M1): lessons/<slug>.md, the file pi reads when SKILL.md
// references it (Q10). Two things are checked before a byte is written: the perimeter, and that the text
// is the candidate the gate ran against -- `expectedContentHash` is the `candidate.contentHash` of the
// record, so an acceptance cannot publish a text nobody gated.
//
// The narrowest root is lessons/: a slug carrying a path separator stays inside the skill but leaves
// lessons/, where it would overwrite a file that is not a lesson. The skill directory is the guard that
// runs while lessons/ does not exist yet, because the perimeter resolves its roots on disk.
export async function writeLessonFile(
  skillRealDir: string,
  slug: string,
  lessonText: string,
  expectedContentHash: string,
): Promise<string> {
  const skillDir = requireDirectory(skillRealDir, "skill directory");
  const lessonsDir = path.join(skillDir, LESSONS_DIR);
  const lessonPath = path.join(lessonsDir, `${slug}.md`);

  assertWritable(lessonPath, [skillDir]);

  // I6 again, and the hash of D4: the text is read back with the parser that owns the format and hashed
  // with the one function that computes the pair, so the bytes written are the bytes the record names.
  const hashes = lessonHashes(lessonText);
  if (!hashes.ok) {
    throw new SriWriterError(
      `refusing to write ${quote(lessonPath)}: the lesson text is not a valid lesson file (${hashes.error})`,
      lessonPath,
    );
  }
  if (hashes.value.contentHash !== expectedContentHash) {
    throw new SriWriterError(
      `refusing to write ${quote(lessonPath)}: the lesson text hashes to ${hashes.value.contentHash}, not to the ${expectedContentHash} of the candidate`,
      lessonPath,
    );
  }

  fs.mkdirSync(lessonsDir, { recursive: true });
  // The write itself is guarded by the directory the file belongs to; it exists now.
  await writeFileQueued(lessonPath, Buffer.from(lessonText, "utf8"), lessonsDir);

  return lessonPath;
}

// The compensation of an acceptance whose reference line failed (§S9): the lesson is withdrawn so the
// skill stays as it was. Removal is destructive, so it passes the same perimeter as the writes -- the
// root is lessons/, the only place this may delete from -- and the answer says whether the path is gone,
// the same reading removeIfExists has: a lesson that was already absent is not an error, because the
// question the caller asks is "is it gone?".
//
// The root has to exist, and the perimeter resolves it on disk: a skill with no lessons/ is refused
// instead of answered "nothing to remove", because no lesson of this package can have been written there.
export async function removeLessonFile(skillRealDir: string, slug: string): Promise<boolean> {
  const skillDir = requireDirectory(skillRealDir, "skill directory");
  const lessonsDir = path.join(skillDir, LESSONS_DIR);
  const lessonPath = path.join(lessonsDir, `${slug}.md`);

  assertWritable(lessonPath, [lessonsDir]);

  return await withFileMutationQueue(lessonPath, async () => removeIfExists(lessonPath));
}

// The authoritative record of an acceptance (§S9): .history/<timestamp>/decision.json, written after the
// bytes of the skill are verified, so a record that says "accepted" cannot describe a write that did not
// happen. It lands in the snapshot the acceptance took before touching the skill, and only there: a
// timestamp without a snapshot names a history this package never took, and taking it is the job of
// snapshotForHistory.
//
// `.history/` is the root and not the skill, and not the snapshot either: the timestamp is the path
// segment the caller names, so a root taken from it would move with an escaping timestamp and accept
// `.history/../lessons`. `.history/` exists whenever a snapshot does.
export async function writeHistoryDecision(
  skillRealDir: string,
  timestamp: string,
  decision: DecisionRecord,
): Promise<string> {
  const skillDir = requireDirectory(skillRealDir, "skill directory");
  const historyDir = path.join(skillDir, HISTORY_DIR);
  const snapshotPath = path.join(historyDir, timestamp);
  const decisionPath = path.join(snapshotPath, DECISION_FILE);

  assertWritable(decisionPath, [historyDir]);

  // The snapshot is the copy this record belongs to; the perimeter already refused a timestamp that
  // leaves .history/, so what is left to prove is that the timestamp names a directory that is there.
  requireDirectory(snapshotPath, "history snapshot");

  await withFileMutationQueue(decisionPath, async () => {
    if (fs.existsSync(decisionPath)) {
      throw new SriWriterError(
        `the history record ${quote(decisionPath)} already exists: history is never rewritten`,
        decisionPath,
      );
    }
    await writeFileAtomic(decisionPath, Buffer.from(decisionText(decision), "utf8"), historyDir);
  });

  return decisionPath;
}

// ---------------------------------------------------------------------------------------------
// M3, S4: the three writes of the retirement. The protocol, the order of the steps and the reason for the order live in
// src/retirement.ts; what lives here is the file -- the tombstone, the reference line that comes out and the record of
// the reason -- with the perimeter, the mutation queue and the read-back of every other write in this module.
// ---------------------------------------------------------------------------------------------

// The pair of hashes a tombstone answers with: the digest of the file as it is after the rewrite, and the digest of the
// normalized body, which the retirement does not change.
export interface RetiredLesson {
  contentHash: string; // "sha256:" + 64 hex over the whole lesson file, tombstone included
  bodyHash: string; // "sha256:" + 64 hex over the normalized body, the one of the acceptance
}

// The tombstone of a retired lesson (M3, S4): lessons/<slug>.md rewritten with `status: "retired"` and nothing else
// changed. The file stays where it is -- the retirement deletes nothing -- and two conditions make the state honest:
//
//   - the bytes on disk are the ones the acceptance measured. The caller verified the same hash before the snapshot, and
//     the check is here again because this is the function that writes: what is retired is what was accepted, and a file
//     whose bytes moved is refused instead of being buried under a tombstone nobody decided on.
//   - the body does not move. That is the post-condition of the round trip: the state changes and the correction does not,
//     so a body hash that differs afterwards throws instead of leaving a rewritten file. parseLesson and serializeLesson are
//     the two directions of the one format that owns the file (P6), so this module spells no frontmatter by hand.
//
// The narrowest root is lessons/, exactly as in removeLessonFile: the slug names a file of that directory, and a slug
// carrying a path separator stays inside the skill but leaves the directory the lessons are the only files of.
export async function retireLessonFile(
  skillRealDir: string,
  slug: string,
  expectedContentHash: string,
): Promise<RetiredLesson> {
  const skillDir = requireDirectory(skillRealDir, "skill directory");
  const lessonsDir = path.join(skillDir, LESSONS_DIR);
  const lessonPath = path.join(lessonsDir, `${slug}.md`);

  assertWritable(lessonPath, [skillDir]);

  // The read, the two conditions and the write happen under the queue of this file, the shape rewriteStagingDecision has: the
  // pre-image that was verified is the one that is rewritten, and two retirements of the same lesson cannot interleave their
  // verification with each other's write. writeFileAtomic is the primitive and not writeFileQueued because the queue is
  // already held here, and withFileMutationQueue is not reentrant on the same path.
  return await withFileMutationQueue(lessonPath, async () => {
    const text = await readTextOrThrow(lessonPath);
    const before = lessonHashes(text);
    if (!before.ok) {
      throw new SriWriterError(
        `refusing to retire ${quote(lessonPath)}: the lesson file is not a valid lesson file (${before.error})`,
        lessonPath,
      );
    }
    if (before.value.contentHash !== expectedContentHash) {
      throw new SriWriterError(
        `refusing to retire ${quote(lessonPath)}: the lesson file hashes to ${before.value.contentHash}, not to the ${expectedContentHash} of the acceptance`,
        lessonPath,
      );
    }

    const lesson = parseLesson(text);
    if (!lesson.ok) {
      throw new SriWriterError(`refusing to retire ${quote(lessonPath)}: ${lesson.error}`, lessonPath);
    }

    const retired = serializeLesson({ ...lesson.value, status: "retired" });
    if (!retired.ok) {
      throw new SriWriterError(`refusing to retire ${quote(lessonPath)}: ${retired.error}`, lessonPath);
    }

    const after = lessonHashes(retired.value);
    if (!after.ok) {
      throw new SriWriterError(`refusing to retire ${quote(lessonPath)}: ${after.error}`, lessonPath);
    }
    if (after.value.bodyHash !== before.value.bodyHash) {
      throw new SriWriterError(
        `refusing to retire ${quote(lessonPath)}: the body would hash to ${after.value.bodyHash} instead of the ${before.value.bodyHash} of the file on disk; a retirement changes the state and never the body`,
        lessonPath,
      );
    }

    await writeFileAtomic(lessonPath, Buffer.from(retired.value, "utf8"), lessonsDir);

    return after.value;
  });
}

// The other edit of a retirement (M3, S4): the reference line of the slug leaves `## Lessons`, so pi stops loading the
// lesson (Q10). The text -> text rule is src/skill-reference.ts's -- the inverse of upsertReferenceLine -- and what stays
// here is the file: reading it, writing it inside the perimeter and checking the line is gone, the way the acceptance
// checks the line landed.
//
// The answer says whether there was a line to remove. A SKILL.md without it is not rewritten with the same bytes: a write
// that changes nothing is a chance to lose something, and the second run of a retirement after a failure has to find this
// step already done instead of a file it rewrites for nothing.
export async function dropReferenceLine(skillRealDir: string, slug: string): Promise<boolean> {
  const skillDir = requireDirectory(skillRealDir, "skill directory");
  const skillFilePath = path.join(skillDir, SKILL_FILE);

  // No assertWritable here, for the reason upsertReferenceLine has none: writeFileAtomic guards the file against the skill
  // directory as its first statement (I10), and this function writes nothing else. The check this function adds is about
  // content, not about the perimeter: the read-back below counts the reference lines.
  let removed = false;
  await withFileMutationQueue(skillFilePath, async () => {
    const content = await readTextOrThrow(skillFilePath);
    const next = skillReference.removeReferenceLine(content, slug);
    if (next === content) {
      return;
    }

    await writeFileAtomic(skillFilePath, Buffer.from(next, "utf8"), skillDir);

    const readBack = await readTextOrThrow(skillFilePath);
    if (skillReference.countReferenceLines(readBack, slug) !== 0) {
      throw new SriWriterError(
        `${quote(skillFilePath)}: the reference to ${quote(skillReference.lessonReferencePath(slug))} is still there after the write`,
        skillFilePath,
      );
    }
    removed = true;
  });

  return removed;
}

// The record of a retirement (M3, S4): .history/<timestamp>/retirement.json, written after the tombstone landed, so a
// record that says what was retired describes a skill that says the same thing. It lands in the snapshot the retirement
// took before touching the skill and only there, the rule writeHistoryDecision follows and for the same reason: the
// timestamp is a path segment the caller names, so `.history/` is the root and the snapshot has to be a directory that is
// there. A record that already exists is refused: history is never rewritten.
export async function writeHistoryRetirement(
  skillRealDir: string,
  timestamp: string,
  record: RetirementRecord,
): Promise<string> {
  const skillDir = requireDirectory(skillRealDir, "skill directory");
  const historyDir = path.join(skillDir, HISTORY_DIR);
  const snapshotPath = path.join(historyDir, timestamp);
  const retirementPath = path.join(snapshotPath, RETIREMENT_FILE);

  assertWritable(retirementPath, [historyDir]);

  requireDirectory(snapshotPath, "history snapshot");

  await withFileMutationQueue(retirementPath, async () => {
    if (fs.existsSync(retirementPath)) {
      throw new SriWriterError(
        `the retirement record ${quote(retirementPath)} already exists: history is never rewritten`,
        retirementPath,
      );
    }
    await writeFileAtomic(retirementPath, Buffer.from(retirementText(record), "utf8"), historyDir);
  });

  return retirementPath;
}

// What this module needs from a record it is about to replace: the identity of the candidate, which is
// the slug that names its lesson and the pair of hashes of that file. Read as data and never with a
// cast: a field that is missing or of another type is a refusal, not a record with a hole in it.
interface StagedCandidate {
  slug: string;
  contentHash: string;
  bodyHash: string;
}

async function readStagedCandidate(decisionPath: string): Promise<StagedCandidate> {
  const text = await readTextOrThrow(decisionPath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SriWriterError(`${quote(decisionPath)} is not JSON: ${toErrorMessage(error)}`, decisionPath);
  }

  const candidate: unknown = isPlainObject(parsed) ? parsed.candidate : undefined;
  if (!isPlainObject(candidate)) {
    throw new SriWriterError(
      `refusing to rewrite ${quote(decisionPath)}: it carries no candidate to verify`,
      decisionPath,
    );
  }

  const slug = candidate.slug;
  const contentHash = candidate.contentHash;
  const bodyHash = candidate.bodyHash;
  if (typeof slug !== "string" || typeof contentHash !== "string" || typeof bodyHash !== "string") {
    throw new SriWriterError(
      `refusing to rewrite ${quote(decisionPath)}: it carries no candidate hashes to verify`,
      decisionPath,
    );
  }

  return { slug, contentHash, bodyHash };
}

// 2026-11-02T14:03:22.481Z -> 20261102T140322481Z. UTC (toISOString always is), no
// colons, so the staging tree stays sortable and portable. `named` is what the caller numbers with it --
// the staging directory of a candidate, the history snapshot of an acceptance -- so the refusal of an
// invalid date says which of the two it could not name.
export function formatTimestamp(now: Date, named: string): string {
  if (Number.isNaN(now.getTime())) {
    throw new SriWriterError(`cannot name a ${named} after an invalid date`);
  }
  return now.toISOString().replace(/[-:.]/g, "");
}

function allocateCandidateDir(stagingRoot: string, baseTimestamp: string): string {
  for (let attempt = 1; attempt <= MAX_TIMESTAMP_ATTEMPTS; attempt++) {
    const name = attempt === 1 ? baseTimestamp : `${baseTimestamp}-${attempt}`;
    const dir = path.join(stagingRoot, name);
    try {
      // mkdir without recursive is the atomic test-and-set: it throws EEXIST for the
      // loser, which is exactly the collision signal.
      fs.mkdirSync(dir);
      return dir;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw new SriWriterError(`cannot create the staging directory ${quote(dir)}: ${toErrorMessage(error)}`, dir);
      }
    }
  }

  throw new SriWriterError(
    `cannot allocate a staging directory for ${quote(baseTimestamp)} under ${quote(stagingRoot)} after ${MAX_TIMESTAMP_ATTEMPTS} attempts`,
    stagingRoot,
  );
}

// The one serialization of a decision record: two-space JSON and one trailing newline, so appending to a
// record stays a line operation and two records of the same shape compare byte for byte. The staging
// writer stamps the candidate hashes it computed; the history writer stores the record as the acceptance
// built it.
//
// D4: the candidate hashes go into decision.json next to contentHash. The writer is the one that hashes
// the bytes that actually reached the disk, so the two call sites that stamp them spread a copy into the
// record instead of trusting values computed elsewhere -- and the caller's object is not mutated.
function decisionText(record: DecisionRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

// The one serialization of a retirement record (M3, S4), the shape decisionText gives a decision: two-space JSON and one
// trailing newline, so the two files that share a snapshot are read the same way and neither ends in the middle of a
// line.
function retirementText(record: RetirementRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

// D4: two lessons with the same body and a different date share bodyHash, so the attempts
// index can spot an equivalent candidate proposed twice.
function normalizeBody(body: string): string {
  return body.trim().replace(/\s+/g, " ");
}

// Temporary file plus rename, then a read-back comparison. The caller must already hold
// withFileMutationQueue() for this path: withFileMutationQueue is not reentrant on the
// same file (a nested call waits for the outer one to finish and would never return).
//
// `root` is the narrowest directory the bytes may land in and the guard runs before the
// temporary file exists (I10), so no caller can write through this module while skipping the
// perimeter.
//
// Q11: a destination that is a symlink is written through, not replaced. A rename over the link would
// leave a regular file where the link was, so a skill whose SKILL.md lives elsewhere -- a shared file,
// a layout that links it into the skill -- would lose the link. The link is resolved before the
// temporary file exists, and the perimeter checks the resolved path: a link that points outside every
// writable root is refused instead of followed out of it.
async function writeFileAtomic(target: string, bytes: Buffer, root: string): Promise<void> {
  const destination = resolveWriteTarget(target);
  assertWritable(destination, [root]);
  const tempPath = path.join(path.dirname(destination), `${TEMP_PREFIX}${randomUUID()}`);

  try {
    // "wx" never reuses an existing temporary file.
    await fs.promises.writeFile(tempPath, bytes, { flag: "wx" });
    await fs.promises.rename(tempPath, destination);
  } catch (error) {
    await removeIfExists(tempPath);
    throw new SriWriterError(`cannot write ${quote(destination)}: ${toErrorMessage(error)}`, destination);
  }

  let readBack: Buffer;
  try {
    readBack = await fs.promises.readFile(destination);
  } catch (error) {
    throw new SriWriterError(`wrote ${quote(destination)} but cannot read it back: ${toErrorMessage(error)}`, destination);
  }

  if (!readBack.equals(bytes)) {
    // An unverified file is not left published: it was written by this call and just
    // proven wrong. The message says whether the removal worked (I8), so a corrupt file
    // that survived a failed removal is not reported as cleaned up.
    const removed = await removeIfExists(destination);
    throw new SriWriterError(
      `wrote ${quote(destination)} but reading it back returned different bytes (removed: ${removed})`,
      destination,
    );
  }
}

// The file the bytes belong to: the path itself, or the file a symlink at that path points to (Q11).
// A path that does not exist is the ordinary case of a new file, and a link that cannot be resolved is
// a refusal: writing to the path itself would replace the link with a regular file.
function resolveWriteTarget(target: string): string {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if (isMissingPathError(error)) return target;
    throw new SriWriterError(`cannot inspect ${quote(target)}: ${toErrorMessage(error)}`, target);
  }

  if (!stats.isSymbolicLink()) return target;

  try {
    return fs.realpathSync(target);
  } catch (error) {
    throw new SriWriterError(`cannot resolve the symlink ${quote(target)}: ${toErrorMessage(error)}`, target);
  }
}

// Same write, for callers that are not already holding the queue: paths are unique per
// call (staging/<ts>/<skill>/...), so serializing per file is enough here. The name says queue,
// not verification: the byte comparison belongs to writeFileAtomic, which this wrapper only
// calls.
async function writeFileQueued(target: string, bytes: Buffer, root: string): Promise<void> {
  assertWritable(target, [root]);
  await withFileMutationQueue(target, () => writeFileAtomic(target, bytes, root));
}

// `root` is the perimeter every copied file must stay inside; it is the same root the caller
// already resolved -- the snapshot, or the arm of the gate -- passed down so each write is guarded by the
// primitive. `exclude` names the entries this copy leaves behind, by file name and at any depth: a
// snapshot of a skill copies lessons/ as it is, while an arm never receives .history/ or .git/.
async function copyTree(
  sourceDir: string,
  destinationDir: string,
  root: string,
  exclude: readonly string[] = [],
): Promise<void> {
  fs.mkdirSync(destinationDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (exclude.includes(entry.name)) continue;

    const source = path.join(sourceDir, entry.name);
    const destination = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(source, destination, root, exclude);
    } else if (entry.isFile()) {
      await writeFileAtomic(destination, await readBytesOrThrow(source), root);
    } else {
      // Symlinks and devices are refused: neither a snapshot nor an arm may depend on content outside
      // the skill, and a link can point anywhere, including out of the root the copy is guarded by.
      throw new SriWriterError(`cannot copy ${quote(source)}: only regular files and directories are copied`, source);
    }
  }
}

function listRelativeFiles(rootDir: string): string[] {
  const files: string[] = [];

  const walk = (currentDir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path.join(currentDir, entry.name), relative);
      } else {
        files.push(relative);
      }
    }
  };

  walk(rootDir, "");
  return files.sort();
}

// Append-only has one precondition this module checks instead of assuming: the file ends where a line ends.
// A line appended after a truncated one would be glued to it, and the index would carry a JSON line nobody can
// parse. The check reads one byte, not the file, so the append stays a write.
async function assertEndsWithNewline(filePath: string): Promise<void> {
  let size: number;
  try {
    size = (await fs.promises.stat(filePath)).size;
  } catch (error) {
    // A missing index is the ordinary first append: the handle below creates it.
    if (isMissingPathError(error)) return;
    throw new SriWriterError(`cannot inspect ${quote(filePath)}: ${toErrorMessage(error)}`, filePath);
  }
  if (size === 0) return;

  if ((await readTail(filePath, 1)) !== "\n") {
    throw new SriWriterError(
      `${quote(filePath)} does not end with a newline: refusing to append a line after a truncated one`,
      filePath,
    );
  }
}

// The one append primitive of the module. `root` is the narrowest directory the bytes may land in and the
// guard runs before the handle exists (I10), so no call site reaches the disk without the perimeter. The
// handle is followed, not replaced: "a" writes through a symlink instead of renaming over it (Q11), and a
// link that points outside the root was already refused above.
async function appendQueued(target: string, bytes: Buffer, root: string): Promise<void> {
  assertWritable(target, [root]);

  let bytesWritten: number;
  try {
    bytesWritten = await appendToFile(target, bytes);
  } catch (error) {
    throw new SriWriterError(`cannot append to ${quote(target)}: ${toErrorMessage(error)}`, target);
  }

  // A short write would leave half a line at the end of the index, and the tail check that follows could
  // only say the tail is wrong: the count says what happened.
  if (bytesWritten !== bytes.length) {
    throw new SriWriterError(
      `cannot append to ${quote(target)}: wrote ${bytesWritten} of ${bytes.length} bytes`,
      target,
    );
  }
}

// Opens, writes once and closes. The handle never outlives the call, so no caller can forget to close it, and
// the write is one call with the whole line in it: O_APPEND puts those bytes at the end of the file as it is
// when the kernel runs the write.
async function appendToFile(target: string, bytes: Buffer): Promise<number> {
  const handle = await fs.promises.open(target, "a");
  try {
    return (await handle.write(bytes)).bytesWritten;
  } finally {
    await handle.close();
  }
}

// The last `length` bytes of a file, as text. The append verifies itself with this and never with a read of
// the whole file: reading everything to compare one line is the read-modify-write this module stopped doing
// (OA11). A file shorter than the window answers the window with everything it holds: the append asks for more
// bytes than its own line, so the index of a single event is shorter than the request, and an empty answer would
// read as a failed append.
async function readTail(filePath: string, length: number): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await fs.promises.open(filePath, "r");
  } catch (error) {
    throw new SriWriterError(`cannot read ${quote(filePath)}: ${toErrorMessage(error)}`, filePath);
  }

  try {
    const { size } = await handle.stat();
    const window = Math.min(size, length);
    if (window <= 0) return "";

    const tail = Buffer.alloc(window);
    await handle.read(tail, 0, window, size - window);
    return tail.toString("utf8");
  } catch (error) {
    throw new SriWriterError(`cannot read ${quote(filePath)}: ${toErrorMessage(error)}`, filePath);
  } finally {
    await handle.close();
  }
}

async function readTextOrThrow(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    throw new SriWriterError(`cannot read ${quote(filePath)}: ${toErrorMessage(error)}`, filePath);
  }
}

async function readBytesOrThrow(filePath: string): Promise<Buffer> {
  try {
    return await fs.promises.readFile(filePath);
  } catch (error) {
    throw new SriWriterError(`cannot read ${quote(filePath)}: ${toErrorMessage(error)}`, filePath);
  }
}

async function removeIfExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.rm(filePath, { force: true });
    // "Removed" means the path is gone after the attempt, not that it existed before it: the
    // caller reports this value, and reporting a removal that failed is the lie I8 is about.
    return true;
  } catch {
    return false;
  }
}

// I7: best effort, because the error that made the copy fail is the one the caller needs.
function discardPartialSnapshot(snapshotPath: string): void {
  try {
    fs.rmSync(snapshotPath, { recursive: true, force: true });
  } catch {
    // Nothing better can be done from here.
  }
}

function requireDirectory(directoryPath: string, label: string): string {
  if (!path.isAbsolute(directoryPath)) {
    throw new SriWriterError(`${quote(directoryPath)} is not absolute: the ${label} must be an absolute path`, directoryPath);
  }

  const resolved = path.resolve(directoryPath);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch (error) {
    throw new SriWriterError(`cannot read the ${label} ${quote(resolved)}: ${toErrorMessage(error)}`, resolved);
  }

  if (!stats.isDirectory()) {
    throw new SriWriterError(`the ${label} ${quote(resolved)} is not a directory`, resolved);
  }
  return resolved;
}
