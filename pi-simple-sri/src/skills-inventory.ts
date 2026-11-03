import fs from "node:fs";
import path from "node:path";
import { DefaultResourceLoader, type Skill } from "@earendil-works/pi-coding-agent";
import { SriFailClosedError } from "./errors.ts";
import { LESSONS_DIR, SKILL_FILE } from "./names.ts";
import type { SkillKind, SkillRef } from "./types.ts";
import { isMissingPathError, quote, toErrorMessage } from "./values.ts";

// Inventory of the skills pi would load (P3). pi's loader is the source of truth for
// discovery: walking the directories here would duplicate its rules (a directory with
// SKILL.md is a skill root and is not searched deeper, dot-directories are skipped,
// the first declaration of a name wins).
//
// A fresh DefaultResourceLoader is built on every call and nothing is cached at module
// scope. Skills change while pi is running, and a cached loader would answer with the
// set from its first call. The cost is one discovery pass per command.
//
// reload() is mandatory. A fresh loader starts with an empty skill list and only
// reload() fills it, so calling getSkills() first returns [] -- indistinguishable from
// "no skills installed" for the caller.
//
// Only skills are loaded: extensions, prompt templates, themes and context files are
// turned off, so this module never runs third-party code. The flip side is that a skill
// contributed by `resources_discover` or by the CLI (-e / -s) is invisible here, because
// those paths are neither settings nor packages.
//
// pi drops the skills that have no `description` (they cannot be routed), so the
// inventory never contains one; this module does not filter again. Name collisions do
// not reach this module either: pi keeps the first skill declared with a name and drops
// the later ones, and listSkills preserves that order.
//
// kind: "declared" is a directory holding SKILL.md, so lessons/ and .history/ live
// inside it and it is the write target. "standalone" is a single .md file with no
// directory of its own: its dir is the shared skills directory, which is not a valid
// write target.
//
// listSkills reports both kinds -- the inventory is informational, and dropping the
// standalone skills would hide why a name the user asked about did not resolve.
// findSkill is the consumable view and answers for declared skills only: a standalone
// skill has no directory of its own, so there is nowhere for lessons/ and .history/ to
// live, and returning its dir would hand a write to the shared skills root.
//
// isSymlinkedSkill() is `dir !== realDir`: the discovered path is not canonical because
// one of its components -- in practice the skill directory itself -- is a symlink (Q11).
// Writes must target realDir. The comparison is derived here instead of stored on the
// skill (I13): a stored copy can disagree with the paths it summarizes.
//
// The paths of a skill are read with realpathSync and statSync. An absent path -- ENOENT,
// or ENOTDIR when a component of it is a file -- is data: the skill went away between
// discovery and this call, so the discovered path is reported as it is. Any other failure
// (EACCES, EIO, ELOOP) is not "no path": it is rethrown with the skill name and the path,
// because a wrong realDir or a false hasLessons would otherwise travel to decision.json.

export interface ListSkillsOptions {
  cwd: string;
  agentDir: string;
}

export async function listSkills(options: ListSkillsOptions): Promise<SkillRef[]> {
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    // Names checked against @earendil-works/pi-coding-agent@1.4.0
    // (dist/core/resource-loader.d.ts, DefaultResourceLoaderOptions).
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  // Without this await the loader still holds its initial empty skill list.
  await loader.reload();

  return loader.getSkills().skills.map(toSkillRef);
}

// pi accepts a frontmatter `name` that differs from the directory name, so both
// spellings resolve; a frontmatter name match wins over a directory name match.
//
// Standalone skills are not candidates for either spelling. Their dir is the shared
// skills directory, so the directory fallback would answer a request for "skills" with
// an unrelated skill, and a name match would return a write target that is the root all
// the standalone skills share.
export function findSkill(skills: readonly SkillRef[], name: string): SkillRef | undefined {
  const declared = skills.filter(isDeclaredSkill);
  const byName = declared.find((skill) => skill.name === name);
  if (byName !== undefined) {
    return byName;
  }
  return declared.find((skill) => path.basename(skill.dir) === name);
}

// The symlink check, derived from the two paths the skill carries (I13).
export function isSymlinkedSkill(skill: SkillRef): boolean {
  return skill.dir !== skill.realDir;
}

function isDeclaredSkill(skill: SkillRef): boolean {
  return skill.kind === "declared";
}

function toSkillRef(skill: Skill): SkillRef {
  // pi sets baseDir to dirname(filePath) for both kinds: the directory holding
  // SKILL.md for a declared skill, the shared skills directory for a standalone one.
  const dir = skill.baseDir;
  const kind: SkillKind = path.basename(skill.filePath) === SKILL_FILE ? "declared" : "standalone";
  const realDir = realPathOf(skill.name, dir);

  return {
    name: skill.name,
    description: skill.description,
    dir,
    realDir,
    // A standalone skill has no directory of its own, so a lessons/ directory in the
    // shared skills directory is not its lessons.
    hasLessons: kind === "declared" && hasLessonsDir(skill.name, dir),
    kind,
  };
}

function realPathOf(skillName: string, dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch (error) {
    // The directory vanished between discovery and this call: report the path pi looked
    // at instead of throwing.
    if (isMissingPathError(error)) return dir;
    throw inspectionFailure(skillName, dir, error);
  }
}

// An unreadable lessons/ is not a skill without lessons, which is what a boolean stat helper
// answering false for every failure would record: only an absent path means "no lessons".
function hasLessonsDir(skillName: string, dir: string): boolean {
  const lessonsDir = path.join(dir, LESSONS_DIR);
  try {
    return fs.statSync(lessonsDir).isDirectory();
  } catch (error) {
    // No lessons/ directory is the common case, not a failure.
    if (isMissingPathError(error)) return false;
    throw inspectionFailure(skillName, lessonsDir, error);
  }
}

function inspectionFailure(skillName: string, target: string, error: unknown): SriFailClosedError {
  const message = `cannot inspect skill ${quote(skillName)} at ${quote(target)}: ${toErrorMessage(error)}`;
  return new SriFailClosedError(message, { cause: error });
}
