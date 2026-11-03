import { COMMAND_NAME, SKILL_IMPROVE_TOOL_NAME } from "./names.ts";
import { lessonReferencePath } from "./skill-reference.ts";
import type { DecisionSurface, SkillRef } from "./types.ts";
import { quote } from "./values.ts";

// The sentences the two surfaces of the loop report (P8, P9).
//
// Both surfaces answer the same six outcomes -- no such skill, no evidence, not eligible, no model, a
// generation that refused, a candidate staged -- and each of the six builders used to live twice,
// once in src/command-skill-improve.ts and once in src/tool-skill-improve.ts. The two copies drifted:
// the command said a standalone skill "cannot be improved" and named the lessons that would have
// nowhere to live, the tool did not; the command's no-model sentence ended with "and no candidate was
// generated" where the tool's ended with "so". This module is the one owner of that wording.
//
// What a surface says differently is a parameter and not a second copy: the surface is the same
// vocabulary decision.json uses for its trigger (src/types.ts), so a sentence can never claim to come
// from the surface that did not report it. What a surface formats for itself -- the command's usage
// line, the tool's diagnosis -- stays in its own module.

// The set of skills offered for improvement, one line per skill, with the description that says what
// the skill does. Exported because the command's usage line offers the same list under a
// different first sentence.
export function listedSkills(skills: readonly SkillRef[]): string[] {
  if (skills.length === 0) return ["  (none)"];
  return skills.map((skill) => `  ${skill.name}: ${skill.description}`);
}

// Unchanged in both surfaces: the refusal is the same fact whoever asked, and the settings that
// produced it are the same file.
export function notEligibleText(skill: SkillRef, reason: string): string {
  return `skill ${quote(skill.name)} is not eligible (${reason}): no candidate was generated.`;
}

// Unchanged in both surfaces too: the reason the generation refused is the generation's, not the
// surface's.
export function refusedText(skill: SkillRef, reason: string): string {
  return `the proposal for skill ${quote(skill.name)} was refused: ${reason}`;
}

export function noEvidenceText(surface: DecisionSurface, skill: SkillRef): string {
  const base = `skill ${quote(skill.name)}: this session shows no failure to learn from, so no candidate was generated.`;
  // The command is the surface that records the attempt next to the result it reports, and it says so
  // in the same sentence; the tool's answers are read by a model, which has the details for that.
  return surface === "command" ? `${base} The attempt was recorded as "no-evidence".` : base;
}

export function noModelText(surface: DecisionSurface): string {
  // The two sentences end differently because the surfaces do: the command has an attempt that was
  // recorded and nothing else, and the tool has no candidate either way.
  return surface === "command"
    ? `no model is available in this session: /${COMMAND_NAME} needs one to write the lesson, and no candidate was generated.`
    : `no model is available in this session: ${SKILL_IMPROVE_TOOL_NAME} needs one to write the lesson, so no candidate was generated.`;
}

export function proposedText(
  surface: DecisionSurface,
  skill: SkillRef,
  slug: string,
  stagingPath: string,
): string {
  // The path of the lesson is the one src/skill-reference.ts owns: the same one the reference line of
  // SKILL.md uses, so the answer and the acceptance cannot name two different files.
  const base = `staged ${lessonReferencePath(slug)} for skill ${quote(skill.name)} at ${quote(stagingPath)}`;
  // The tool never accepts, and it says so where the candidate is: acceptance edits a skill and
  // belongs to the command alone (Q12).
  return surface === "tool"
    ? `${base}; the skill is untouched and the candidate is not accepted, which belongs to the /${COMMAND_NAME} command.`
    : base;
}

export function unknownSkillText(
  surface: DecisionSurface,
  name: string,
  standalone: SkillRef | null,
  eligible: readonly SkillRef[],
): string {
  const opening = standalone === null ? notInstalledText(name) : standaloneSkillText(surface, name);
  // The offer is the eligible set, and each surface lists it the way its reader reads it: a user gets
  // one skill per line with its description, a model gets the names in one sentence.
  return surface === "command"
    ? [opening, "Eligible skills:", ...listedSkills(eligible)].join("\n")
    : `${opening} Eligible skills: ${listedNames(eligible)}.`;
}

// A name nobody knows. Both surfaces open with the same sentence.
function notInstalledText(name: string): string {
  return `No skill named ${quote(name)} is installed and eligible.`;
}

// A name the inventory holds as a standalone .md is not a name nobody knows: the file exists, and what
// it lacks is a directory of its own, so it has nowhere to keep lessons (F6). The command says what
// that costs; the tool goes straight to the verdict.
function standaloneSkillText(surface: DecisionSurface, name: string): string {
  const lead = `Skill ${quote(name)} exists, but it is a standalone .md file with no directory of its own,`;
  return surface === "command"
    ? `${lead} so its lessons would have nowhere to live and it cannot be improved.`
    : `${lead} so it cannot be improved.`;
}

function listedNames(skills: readonly SkillRef[]): string {
  const names = skills.map((skill) => skill.name);
  return names.length === 0 ? "(none)" : names.join(", ");
}
