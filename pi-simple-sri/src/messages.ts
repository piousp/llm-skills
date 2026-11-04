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
//
// M1c adds two more, and they are here for the same reason: the bank base that found no baseline to measure
// against (noBaselineText), which is a state of the attempt and not a verdict, and the gate that cannot run
// because the session has no model to replay and judge with (noModelGateText). The correction of
// noEvidenceText belongs to the same slice: the defect branch refuses with the word `no-evidence` when its
// bank or its artifact cannot be read, and the sentence may not claim that the session showed no failure.
// The discovery slice adds the third: the one line the extension reports when a session starts
// (feedbackNoticeText), which belongs here because it names both surfaces and this module is the one owner of
// the wording a surface reports.

// The line the extension reports once at the start of a session (M1c, S11, Q26). It exists because the channels of the
// package fail differently: the description of the tool is what a model reads and a session notice is what a user reads,
// and neither reader is guaranteed to see the other. So the line names what can be recorded and through which surface --
// the failures of the session, the two profiles of a bank, and the tool a correction or a rejection is registered with --
// and the two costs of the gate that have to be known before running it: the tokens a run spends, and the floor of two
// distinct items below which the paired replay has nothing to compare (MIN_ITEMS, src/gate/scorer.ts). It promises
// nothing beyond them, and the line names no skill and no path.
export function feedbackNoticeText(): string {
  return `Feedback that improves the installed skills can be recorded and gated: /${COMMAND_NAME} <skill> learns from at least two distinct tool failures of this session, --bank=<path> measures a directional improvement, --bank=<path> --defect a defect an artifact shows, and the ${SKILL_IMPROVE_TOOL_NAME} tool registers a correction; the gate spends tokens before a skill is edited.`;
}

// The set of skills offered for improvement, as the names of the eligible ones in one comma-separated
// list. Exported because the command's usage line offers the same list under a different first
// sentence. The description is not part of it: the help names what can be asked for, and the
// inventory already carries what each skill does.
export function listedNames(skills: readonly SkillRef[]): string {
  const names = skills.map((skill) => skill.name);
  return names.length === 0 ? "(none)" : names.join(", ");
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

export function noEvidenceText(surface: DecisionSurface, skill: SkillRef, reason: string | null): string {
  // Two facts share this outcome (M1c, S8): the session that showed nothing to learn from, and the run whose material --
  // the bank of a defect, or the artifact it names -- could not be read. The second one is not a session without failures,
  // and the reason the flow recorded says which problem it is, so the sentence names it instead of blaming the session.
  const base =
    reason === null
      ? `skill ${quote(skill.name)}: this session shows no failure to learn from, so no candidate was generated.`
      : `skill ${quote(skill.name)}: this run has no material to learn from -- ${reason} -- so no candidate was generated.`;
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

// The tool never accepts: acceptance edits a skill and belongs to the command alone (Q12), so every answer it
// gives about a candidate says the skill is untouched. Two wordings, because a verdict the gate concluded on
// and a path waiting in staging are different facts about it: the first is a candidate nobody accepted, the
// second is a candidate where the gate will read it.
const TOOL_NOT_ACCEPTED = `; the skill is untouched and the candidate is not accepted, which belongs to the /${COMMAND_NAME} command.`;
const TOOL_IN_STAGING = "; the skill is untouched and the candidate stays in staging.";

// What the command appends instead is the ending of its own sentence, so it stays at the call site: the period
// that closes a verdict, the line that says the skill was left alone -- a rejection is not a failure of the run,
// and an abstention concluded nothing, so the skill is the one thing the answer has to report about -- or
// nothing at all where the sentence is already done.
const COMMAND_NOT_EDITED = "; the skill was not edited.";

// The clause each surface appends to the sentence it built.
function withClause(surface: DecisionSurface, clause: { tool: string; command: string }): string {
  return surface === "tool" ? clause.tool : clause.command;
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
  return `${sentence}${withClause(surface, { tool: TOOL_NOT_ACCEPTED, command: "." })}`;
}

// A rejection below the rule is its whole story, and a rejection the judge produced is not (M4): the flow computes a detail
// with the case and the judge's sentence, and the reason alone -- `judge-failed` -- leaves the user without either. The
// detail is printed the way an abstention prints it, in the same wording the line of the index keeps, and a rejection
// without one reads as it always did.
export function gateRejectedText(
  surface: DecisionSurface,
  skill: SkillRef,
  reason: string | null,
  usedRuns: number,
  detail?: string,
): string {
  const sentence = `the gate rejected the candidate for skill ${quote(skill.name)} after ${runsText(usedRuns)}: ${reasonText(reason, detail)}`;
  return `${sentence}${withClause(surface, { tool: TOOL_IN_STAGING, command: COMMAND_NOT_EDITED })}`;
}

export function gateAbstainedText(
  surface: DecisionSurface,
  skill: SkillRef,
  reason: string | null,
  detail?: string,
): string {
  const sentence = `the gate abstained for skill ${quote(skill.name)}: ${reasonText(reason, detail)}`;
  // An abstention spent what it spent and concluded nothing, so there is no count in the sentence: the reason
  // is the whole answer, and the budget of the attempt is in decision.json.
  return `${sentence}${withClause(surface, { tool: TOOL_IN_STAGING, command: COMMAND_NOT_EDITED })}`;
}

// A gate of the case-bank base that found nothing to measure against (M1c, OA9): the bank is absent, unreadable, over its
// cap or not a bank of this version, so no case was replayed and nothing was spent. It is not a verdict of the gate and not
// a failure of the run, so the sentence carries the two things a reader needs to act: the reason of the reader of the bank --
// which names the file or the field to fix -- and the path of the candidate, which is where the retry is pointed at.
export function noBaselineText(
  surface: DecisionSurface,
  skill: SkillRef,
  reason: string,
  stagingPath: string,
): string {
  const sentence = `the gate for skill ${quote(skill.name)} found no baseline to measure the candidate against: ${reason}. Nothing was spent and the candidate stays in staging at ${quote(stagingPath)}, so the same candidate can be gated again once the bank is there`;
  return `${sentence}${withClause(surface, { tool: TOOL_NOT_ACCEPTED, command: COMMAND_NOT_EDITED })}`;
}

// A gate of the case-bank base in a session with no model (M1c, S10): the cases are replayed by the model of the session and
// the candidate's answers are judged by the same one (OA5), so without it the gate has no arm to run and no condition to
// apply. Said before anything is read, because it is the last moment at which nothing has been spent.
export function noModelGateText(surface: DecisionSurface, skill: SkillRef): string {
  const sentence = `the gate for skill ${quote(skill.name)} needs the model of this session -- one to run the cases of the bank and one to judge the answers -- and this session has none; nothing was read and no run was spent`;
  return `${sentence}${withClause(surface, { tool: TOOL_IN_STAGING, command: COMMAND_NOT_EDITED })}`;
}

// The one sentence of the acceptance, and the only builder here without a per-surface variant: the tool never
// accepts (Q12), so a variant for it would be a branch nothing reaches. Both paths are absolute -- the lesson
// inside the skill and the record inside its history -- because they are what a human opens. What the sentence promises
// about the session is the step the run takes next and not its outcome: the reload comes after this notice
// (src/command-skill-improve.ts:578-596), and a reload that fails has the sentence of reloadFailedText below.
export function acceptedText(skill: SkillRef, slug: string, lessonPath: string, historyPath: string): string {
  return `accepted ${lessonReferencePath(slug)} into skill ${quote(skill.name)} at ${quote(lessonPath)}, and its SKILL.md now references it; the record of the acceptance is ${quote(historyPath)}. The session reloads next, with the lesson already on disk, and a reload that fails leaves this acceptance standing and is reported on its own.`;
}

// The one sentence of a reload that did not happen over a skill that did change: the acceptance is a write and no
// operation undoes it, so the sentence says the two facts -- the skill is accepted on disk, the reload of the session
// failed -- and the reason, and promises nothing beyond the next session start. One variant and no surface,
// for the reason acceptedText has none: the reload is a call of the command's context and the tool never has one.
export function reloadFailedText(reason: string): string {
  return `the skill was accepted and its lesson is already on disk, but the reload of this session failed: ${reason}. The acceptance stands -- nothing was reverted -- and the next session start reads the skill as it is now.`;
}

// A concluded gate always has a reason, except on an acceptance, where there was nothing to explain. The
// absence is stated instead of rendered as an empty colon. M4: an abstention that cost no run is often a fact
// about a file -- an overlay that could not copy it, a lesson whose bytes moved -- and the reason alone leaves
// the reader without it; the detail is the flow's `detail`, in the same wording the line of the index keeps,
// and without it the sentence is the one it always was.
function reasonText(reason: string | null, detail?: string): string {
  const base = reason ?? "no reason was recorded";
  return detail === undefined ? base : `${base}: ${detail}`;
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
  return `${sentence}${withClause(surface, { tool: TOOL_NOT_ACCEPTED, command: "" })}`;
}

export function unknownSkillText(
  surface: DecisionSurface,
  name: string,
  standalone: SkillRef | null,
  eligible: readonly SkillRef[],
): string {
  const opening = standalone === null ? notInstalledText(name) : standaloneSkillText(surface, name);
  // The offer is the eligible set, listed the same way in both surfaces: the names in one sentence and no
  // descriptions, because what is being offered is the name to type.
  return `${opening} Eligible skills: ${listedNames(eligible)}.`;
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
