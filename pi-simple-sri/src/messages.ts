import path from "node:path";
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
//
// M1 adds the gate to both surfaces and three answers with it: the gate passed, the gate rejected the
// candidate, the gate abstained. They are here for the same reason as the six above -- the two surfaces
// report the same verdict, and the tool has to add that it never accepts -- and they carry the budget of
// the gate, because a verdict over twelve runs that does not say how many it cost is a verdict a reader
// cannot audit. The acceptance is the command's alone (Q12), so acceptedText has no per-surface variant: a
// branch the tool can never reach would be a sentence nobody prints.

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

export function gatePassedText(
  surface: DecisionSurface,
  skill: SkillRef,
  plannedRuns: number,
  usedRuns: number,
): string {
  // Both numbers, because they are two different facts: what the preregistered design promised to spend and
  // what the budget actually cost. The rule itself stays in decision.json, which is where a reader checks it.
  const sentence = `the gate for skill ${quote(skill.name)} passed after ${runsText(usedRuns)} of the ${plannedRuns} it planned`;
  // The tool never accepts, and it says so where the verdict is: acceptance edits a skill and belongs to the
  // command alone (Q12).
  return surface === "tool"
    ? `${sentence}; the skill is untouched and the candidate is not accepted, which belongs to the /${COMMAND_NAME} command.`
    : `${sentence}.`;
}

export function gateRejectedText(
  surface: DecisionSurface,
  skill: SkillRef,
  reason: string | null,
  usedRuns: number,
): string {
  const sentence = `the gate rejected the candidate for skill ${quote(skill.name)} after ${runsText(usedRuns)}: ${reasonText(reason)}`;
  // A rejection is not a failure of the run: the candidate lost to the skill as it stands, and the skill is
  // the one thing the answer has to report about.
  return surface === "tool"
    ? `${sentence}; the skill is untouched and the candidate stays in staging.`
    : `${sentence}; the skill was not edited.`;
}

export function gateAbstainedText(
  surface: DecisionSurface,
  skill: SkillRef,
  reason: string | null,
  detail?: string,
): string {
  const sentence = `the gate abstained for skill ${quote(skill.name)}: ${abstentionReasonText(reason, detail)}`;
  // An abstention spent what it spent and concluded nothing, so there is no count in the sentence: the reason
  // is the whole answer, and the budget of the attempt is in decision.json.
  return surface === "tool"
    ? `${sentence}; the skill is untouched and the candidate stays in staging.`
    : `${sentence}; the skill was not edited.`;
}

// The one sentence of the acceptance, and the only builder here without a per-surface variant: the tool never
// accepts (Q12), so a variant for it would be a branch nothing reaches. Both paths are absolute -- the lesson
// inside the skill and the record inside its history -- because they are what a human opens, and M2 is not
// promised: the session is not reloaded by this version.
export function acceptedText(skill: SkillRef, slug: string, lessonPath: string, historyPath: string): string {
  return `accepted ${lessonReferencePath(slug)} into skill ${quote(skill.name)} at ${quote(lessonPath)}, and its SKILL.md now references it; the record of the acceptance is ${quote(historyPath)}.`;
}

// A concluded gate always has a reason, except on an acceptance, where there was nothing to explain. The
// absence is stated instead of rendered as an empty colon.
function reasonText(reason: string | null): string {
  return reason ?? "no reason was recorded";
}

// M4: an abstention that cost no run is often a fact about a file -- an overlay that could not copy it, a
// lesson whose bytes moved -- and the reason alone leaves the reader without it. The detail is the flow's
// `detail`, in the same wording the line of the index keeps. Absent, the sentence is the one it always was.
function abstentionReasonText(reason: string | null, detail: string | undefined): string {
  if (detail === undefined) return reasonText(reason);
  return `${reasonText(reason)}: ${detail}`;
}

function runsText(runs: number): string {
  return runs === 1 ? "1 run" : `${runs} runs`;
}

export function proposedText(
  surface: DecisionSurface,
  skill: SkillRef,
  slug: string,
  stagingPath: string,
  base: string,
): string {
  // The path of the lesson is the one src/skill-reference.ts owns: the same one the reference line of
  // SKILL.md uses, so the answer and the acceptance cannot name two different files.
  //
  // The answer names the candidate by its absolute path: the records keep the base-relative spelling
  // (a record stays readable after the agent directory moves), but a human who reads the answer opens
  // the file from the session's working directory, and a relative path there points at nothing.
  const candidatePath = path.join(base, stagingPath);
  const sentence = `staged ${lessonReferencePath(slug)} for skill ${quote(skill.name)} at ${quote(candidatePath)}`;
  // The tool never accepts, and it says so where the candidate is: acceptance edits a skill and
  // belongs to the command alone (Q12).
  return surface === "tool"
    ? `${sentence}; the skill is untouched and the candidate is not accepted, which belongs to the /${COMMAND_NAME} command.`
    : sentence;
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
