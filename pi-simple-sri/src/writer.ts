import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { SriWriterError } from "./errors.ts";
import { sha256Digest } from "./hash.ts";
import { parseLesson } from "./lesson-frontmatter.ts";
import { ATTEMPTS_FILE, DECISION_FILE, HISTORY_DIR, LESSONS_DIR, SKILL_FILE } from "./names.ts";
import { stagingDir, stateDir } from "./package-paths.ts";
import { assertWritable } from "./perimeter.ts";
import * as skillReference from "./skill-reference.ts";
import type { AttemptLine, DecisionRecord, Result, SkillRef } from "./types.ts";
import { isAlreadyExistsError, isMissingPathError, isRegularFile, quote, toErrorMessage } from "./values.ts";

// The single write chokepoint of the package. Every write here:
//   1. runs assertWritable against the narrowest root that applies -- <root>/staging for
//      candidates, the skill directory for the M1 writes -- so a generated skill name,
//      slug or timestamp cannot leave the perimeter. The guard lives in the two write
//      primitives below, which take the root and assert it as their first statement (I10):
//      no path through this module reaches the disk without it, including a call site
//      added later. A directory the module creates itself, such as the history snapshot,
//      is checked before it is created, because no primitive sees that mkdir;
//   2. runs inside withFileMutationQueue(), which serializes operations targeting the
//      same file (keyed by realpath) and lets unrelated files proceed in parallel;
//   3. writes a temporary file in the destination directory and renames it, so a reader
//      never sees a half-written file;
//   4. reads the file back and compares the bytes, so a write that did not land is an
//      error instead of a silent success (verification on write, not only on read).
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

// The error class lives in src/errors.ts with the rest of the fail-closed errors; it is
// re-exported here because this is the module that raises it.
export { SriWriterError };

export interface StagingWriteInput {
  root: string; // packageRoot(): staging/ and state/ live under it
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

// Writes <root>/staging/<ts>/<skill>/lessons/<slug>.md and decision.json next to it.
// `ts` is UTC YYYYMMDDTHHMMSSfffZ; a timestamp already in use gets -2, -3, ... so two
// candidates produced in the same millisecond never share a directory.
export async function writeStagingCandidate(input: StagingWriteInput): Promise<StagingWriteResult> {
  // I12: a relative root resolves against the working directory of the process, so the
  // staging tree would land inside whatever project pi was started in before the
  // perimeter below ever ran. Refused while nothing exists yet.
  if (!path.isAbsolute(input.root)) {
    throw new SriWriterError(
      `${quote(input.root)} is not absolute: refusing to create ${quote(stagingDir(input.root))}`,
      input.root,
    );
  }

  const stagingRoot = stagingDir(input.root);
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

  const baseTimestamp = formatTimestamp(input.now);

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
  // decision.json lands last and already stamped: a record on disk means the lesson it names
  // is on disk too, and carries the hashes of those exact bytes.
  await writeFileQueued(
    decisionPath,
    Buffer.from(serializeDecision(input.decision, hashes.value.contentHash, hashes.value.bodyHash), "utf8"),
    candidateDir,
  );

  return {
    stagingPath: candidateDir,
    lessonPath,
    decisionPath,
    contentHash: hashes.value.contentHash,
    bodyHash: hashes.value.bodyHash,
  };
}

// Append-only index: one JSON line per event (Q14). The existing bytes are never
// rewritten or reordered; the new line is the only addition, so events joined by
// candidateHash stay readable after a crash.
export async function appendAttemptLine(root: string, line: AttemptLine): Promise<void> {
  if (!path.isAbsolute(root)) {
    throw new SriWriterError(`${quote(root)} is not absolute: refusing to append`, root);
  }

  // The root is known here, so the write is guarded against the whole state directory instead of
  // the path the caller handed over; that check runs inside writeFileAtomic below, where the bytes
  // land, and is not repeated here.
  const stateRoot = stateDir(root);
  const statePath = path.join(stateRoot, ATTEMPTS_FILE);
  fs.mkdirSync(stateRoot, { recursive: true });

  const jsonLine = JSON.stringify(line);

  await withFileMutationQueue(statePath, async () => {
    const previous = await readTextIfExists(statePath);
    const separator = previous === "" || previous.endsWith("\n") ? "" : "\n";
    await writeFileAtomic(statePath, Buffer.from(`${previous}${separator}${jsonLine}\n`, "utf8"), stateRoot);

    const lastLine = (await readTextOrThrow(statePath)).split("\n").filter((entry) => entry !== "").at(-1);
    if (lastLine !== jsonLine) {
      throw new SriWriterError(`${quote(statePath)}: the last line after the append is not the event that was written`, statePath);
    }
  });
}

// The compensation of a candidate whose index line failed (F1): the directory this module created is
// removed, because a candidate no line names is an orphan -- the run would report that nothing was
// written while the bytes sit in staging, and the next run would trip over a directory nobody can
// explain. Removal is the one destructive operation in this module, so it is guarded by the same
// perimeter as the writes: only a directory inside <root>/staging is discarded. The answer says
// whether the directory is gone; the caller reports it next to the error that caused the removal.
export async function discardStagingCandidate(root: string, stagingPath: string): Promise<boolean> {
  if (!path.isAbsolute(root)) {
    throw new SriWriterError(
      `${quote(root)} is not absolute: refusing to discard ${quote(stagingPath)}`,
      root,
    );
  }

  assertWritable(stagingPath, [stagingDir(root)]);

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

// 2026-11-02T14:03:22.481Z -> 20261102T140322481Z. UTC (toISOString always is), no
// colons, so the staging tree stays sortable and portable.
function formatTimestamp(now: Date): string {
  if (Number.isNaN(now.getTime())) {
    throw new SriWriterError("cannot name a staging directory after an invalid date");
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

// D4: the candidate hashes go into decision.json next to contentHash. The writer is the
// one that hashes the bytes that actually reached the disk, so it stamps them into the
// record it writes instead of trusting values computed elsewhere; the caller's object is
// not mutated.
function serializeDecision(record: DecisionRecord, contentHash: string, bodyHash: string): string {
  const stamped: DecisionRecord = {
    ...record,
    candidate: { ...record.candidate, contentHash, bodyHash },
  };
  return `${JSON.stringify(stamped, null, 2)}\n`;
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
// already resolved for the snapshot, passed down so each write is guarded by the primitive.
async function copyTree(sourceDir: string, destinationDir: string, root: string): Promise<void> {
  fs.mkdirSync(destinationDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(source, destination, root);
    } else if (entry.isFile()) {
      await writeFileAtomic(destination, await readBytesOrThrow(source), root);
    } else {
      // Symlinks and devices are refused: a snapshot must not depend on content outside
      // the skill.
      throw new SriWriterError(`cannot snapshot ${quote(source)}: only regular files and directories are copied`, source);
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

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return "";
    }
    throw new SriWriterError(`cannot read ${quote(filePath)}: ${toErrorMessage(error)}`, filePath);
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
