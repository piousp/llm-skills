import fs from "node:fs";
import path from "node:path";
import { SriWriterError } from "../errors.ts";
import { sha256Digest } from "../hash.ts";
import { LESSONS_DIR, SKILL_FILE } from "../names.ts";
import { assertWritable } from "../perimeter.ts";
import * as skillReference from "../skill-reference.ts";
import type { Result, SkillRef } from "../types.ts";
import { quote, toErrorMessage } from "../values.ts";
import { stagingDir } from "../write-base.ts";
import { copySkillTree, discardStagingCandidate, writeTextAtomically } from "../writer.ts";

// The two arms of the gate (Q9): the skill as it stands and the skill plus the candidate lesson, each one
// copied into staging so the replay reads a skill directory and never the real skill. What the two arms may
// differ in is the `## Lessons` section and nothing else (Q13), because that section is what the gate
// measures: any other difference would make the comparison about something nobody asked about.
//
// This module composes primitives that already exist and adds no write path of its own: the tree copy
// (copySkillTree), the verified text write (writeTextAtomically) and the removal of an arm that must not be
// published (discardStagingCandidate), all from src/writer.ts; the Markdown of the section stays in
// src/skill-reference.ts. What is decided here is the order -- copy both arms from the skill, ensure the
// section in both, add the lesson and its reference line to the candidate only -- plus the one thing the gate
// has to prove later, the hash of the SKILL.md the run started from.
//
// Nothing here names a real skill: the source is the skill the caller resolved, and both destinations live
// under the candidate directory of staging, which is the perimeter every write below is guarded by.

// Where the arms live inside the candidate directory of staging:
// `<base>/staging/<ts>/<skill>/arms/{incumbent,candidate}/<name>/`. Each arm keeps the skill's name, so a
// person reading staging sees which skill the tree is; pi finds SKILL.md by scanning the directory, so the
// name is for the reader and not for the loader.
const ARMS_DIR = "arms";
const INCUMBENT_ARM = "incumbent";
const CANDIDATE_ARM = "candidate";

// The candidate is the one that changes and the incumbent is the control it is compared against; the list is
// what the compensation of an abandoned overlay walks, because neither arm survives without its pair.
const ARM_NAMES: readonly string[] = [INCUMBENT_ARM, CANDIDATE_ARM];

// What the flow hands over (§S5). `stagingPath` is the candidate directory the staging writer allocated,
// `<base>/staging/<ts>/<skill>`, and `base` is the write base of the run: the perimeter of the copies and
// the root the compensation of an abandoned arm is guarded by.
//
// `lessonText` is the whole lesson file, frontmatter included, as src/writer.ts already staged it. It is
// text and not a draft because the file format belongs to src/lesson-frontmatter.ts (P6), and it is not
// validated here again: the staged bytes were read back with the parser that owns the format before they
// reached the disk (I6).
export interface OverlayRequest {
  base: string;
  stagingPath: string;
  skill: SkillRef;
  slug: string;
  title: string;
  lessonText: string;
}

// The two directories the replay is pointed at, plus the hashes the record keeps for it (§TECHNICAL 3,
// `gate.replay.overlays`).
export interface OverlayArms {
  incumbentDir: string;
  candidateDir: string;
  // "sha256:" + 64 hex over the SKILL.md the skill had when the overlay started, read before any copy: the
  // value the acceptance compares later to detect drift between the gated skill and the accepted one.
  skillContentHash: string;
  // "sha256:" + 64 hex over the manifest of the arm copy: the sorted list of relative paths of the copied
  // tree, each with the digest of its bytes. Both arms are copied from the same tree and the guard below
  // proves the two copies agree, so one digest describes where both arms came from -- and an arm that later
  // diverges from the skill no longer hashes to this value.
  manifestHash: string;
}

// Why no overlay was built. The vocabulary is the gate's (§TECHNICAL 2: `overlay-failed` is one of its
// abstention reasons): an arm this module cannot build is an answer the flow records, never a crash of the
// run. `detail` is the refusal of the copy with its path in it, so the record says which file of which skill
// stopped the overlay.
export interface OverlayAbstention {
  reason: "overlay-failed";
  detail: string;
}

export type OverlayResult = Result<OverlayArms, OverlayAbstention>;

export async function buildArmOverlays(input: OverlayRequest): Promise<OverlayResult> {
  const stagingRoot = stagingDir(input.base);
  const incumbentDir = armDir(input, INCUMBENT_ARM);
  const candidateDir = armDir(input, CANDIDATE_ARM);

  try {
    // The original is read once, before any copy, and both the text and the hash come from those bytes: the
    // hash the acceptance compares later is the hash of what the skill had when the gate started, not of a
    // copy an edit could have moved on from.
    const original = await readOriginalSkill(input.skill.realDir);
    const skillContentHash = sha256Digest(original);

    // Two independent copies of the same tree, and not one copy of the other: neither arm is derived from
    // its pair, so no edit made to the incumbent can leak into the candidate. `.history/` and `.git/` stay
    // behind (copySkillTree), because neither is part of what pi loads from a skill.
    const incumbentCopy = await copySkillTree(input.skill.realDir, incumbentDir, stagingRoot);
    const candidateCopy = await copySkillTree(input.skill.realDir, candidateDir, stagingRoot);

    // The two copies of one tree answer one hash. Two different ones mean the skill moved while the overlay
    // was being built, and then the arms are not the pair the gate claims to compare: an abstention is the
    // only honest answer, because no run over them could be read as a difference of the section.
    if (incumbentCopy.manifestHash !== candidateCopy.manifestHash) {
      return await abstain(
        input,
        `the two copies of ${quote(input.skill.realDir)} are not the same tree (${incumbentCopy.manifestHash} and ${candidateCopy.manifestHash})`,
      );
    }

    // Both arms carry the section with no line of this candidate, because a scenario without it would not be
    // comparable: in the candidate the section exists because the lesson needs it (Q13). Only the candidate
    // receives the line, and src/skill-reference.ts is what knows both edits.
    const ensured = skillReference.ensureLessonsSection(original.toString("utf8"));
    await writeTextAtomically(path.join(incumbentDir, SKILL_FILE), ensured, incumbentDir);
    await writeTextAtomically(
      path.join(candidateDir, SKILL_FILE),
      skillReference.upsertReferenceLine(ensured, input.slug, input.title),
      candidateDir,
    );

    // The lesson itself, at the path the reference points to: one owner of that convention, so the file and
    // the line cannot disagree about where it is.
    const candidateLessonsDir = path.join(candidateDir, LESSONS_DIR);
    // The directory is created here, so it is checked before it exists: no primitive below sees this mkdir
    // (I10), and a skill without lessons/ is the ordinary case for the first lesson of a skill.
    assertWritable(candidateLessonsDir, [candidateDir]);
    fs.mkdirSync(candidateLessonsDir, { recursive: true });
    await writeTextAtomically(
      path.join(candidateDir, skillReference.lessonReferencePath(input.slug)),
      input.lessonText,
      candidateDir,
    );

    return {
      ok: true,
      value: { incumbentDir, candidateDir, skillContentHash, manifestHash: incumbentCopy.manifestHash },
    };
  } catch (error) {
    // A skill with an internal symlink, a file that cannot be read or bytes that did not land are properties
    // of this skill, not reasons to crash the gate: the answer is the abstention the flow records. A
    // perimeter rejection is not caught here -- it says this module computed a path outside staging, which is
    // a defect that has to stay loud instead of becoming a verdict.
    if (!(error instanceof SriWriterError)) {
      throw error;
    }
    return await abstain(input, error.message);
  }
}

function armDir(input: OverlayRequest, arm: string): string {
  return path.join(input.stagingPath, ARMS_DIR, arm, input.skill.name);
}

// The SKILL.md of the skill as it stands, read before any copy. A file that cannot be read is a refusal and
// not an empty text, so the failure reaches the caller as the abstention of the overlay.
async function readOriginalSkill(skillRealDir: string): Promise<Buffer> {
  const skillFilePath = path.join(skillRealDir, SKILL_FILE);
  try {
    return await fs.promises.readFile(skillFilePath);
  } catch (error) {
    throw new SriWriterError(`cannot read ${quote(skillFilePath)}: ${toErrorMessage(error)}`, skillFilePath);
  }
}

// An arm without its pair is not an overlay, so an abstention leaves no destination behind: both are
// discarded, the same rule a copy that failed halfway follows (I7). The removal is best effort and guarded
// by staging/, like every other compensation of the writer, and the answer already carries the failure that
// caused it.
async function abstain(input: OverlayRequest, detail: string): Promise<OverlayResult> {
  for (const arm of ARM_NAMES) {
    await discardStagingCandidate(input.base, armDir(input, arm));
  }
  return { ok: false, error: { reason: "overlay-failed", detail } };
}
