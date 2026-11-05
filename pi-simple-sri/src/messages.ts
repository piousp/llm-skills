import path from "node:path";
import { COMMAND_NAME, PUBLISHED_SKILL_NAME, SKILL_IMPROVE_TOOL_NAME } from "./names.ts";
// Type-only, so the wording of the report does not pull the arithmetic of src/metrics.ts -- and the ledger behind it -- into
// every surface that reports a sentence: this module names the shape of the numbers, and metrics.ts is the one that counts
// them.
import type { GateTally, Metrics, SkillTally } from "./metrics.ts";
// Type-only, so the wording of this module does not pull the collector -- and the writer behind it -- into every surface
// that reports a sentence: this module names the shape of a suspicion and the collector is the one that builds it.
import type { Suspicion } from "./signals.ts";
import { lessonReferencePath } from "./skill-reference.ts";
// Type-only, so the wording of the report of the check does not pull the reader of the lesson bytes -- and the disk behind it
// -- into every surface that reports a sentence: this module names the shape of the report, and src/standing.ts is the one
// that reads the files behind it.
import type { LessonCheck, SkillStanding, StandingReport } from "./standing.ts";
// Type-only, so the wording of a retirement does not pull the protocol -- and the writer behind it -- into every surface that
// reports a sentence: this module names the refusal the retirement answered, and src/retirement.ts is the one that decided it.
import type { RetireRejection } from "./retirement.ts";
import { assertNever, type DecisionSurface, type NotEligibleReason, type SkillRef } from "./types.ts";
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
// the wording a surface reports. M3 adds the fourth: the line the collector reports when it raises a suspicion
// (signalText), which is here for the same reason as the notice and says the opposite thing about certainty, and the
// fifth: the report of the accepted lessons against the records that accepted them (standingText), which describes what is
// on disk and decides nothing. S4 adds the sixth: the sentence of a retirement (retiredText) and the one each of its
// refusals answers with (retireRejectedText), which belong here because a retirement is a write into a skill and the
// command is the only surface that makes one -- the tool gains no flag for it. S6 adds the seventh: the answer of a
// confirmation that names a suspicion nobody holds (unknownSignalText), which is here because it is the other half of the
// notice above -- one sentence opens the suspicion and one says it cannot be found.

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
// produced it are the same file. The two reasons are two different facts, so each one is its own
// sentence and a third reason cannot be added without reaching this switch (M2c, S2b).
//
// `not-eligible` is the verdict of the settings, and its sentence is the one it always was.
// `published-by-this-package` is the name this package reserves: `improving-skills` is the name its manual is published
// under, and a lesson written in a skill of that name does not survive an update of the package. The sentence says the
// reservation and not "this is the manual", because the rule compares the name -- on purpose, so that a skill the user
// installed under that name is refused too -- and a sentence that claimed to recognize the file would be false for it.
export function notEligibleText(skill: SkillRef, reason: NotEligibleReason): string {
  switch (reason) {
    case "not-eligible":
      return `skill ${quote(skill.name)} is not eligible (${reason}): no candidate was generated.`;
    case "published-by-this-package":
      return `skill ${quote(skill.name)} is not eligible (${reason}): ${quote(PUBLISHED_SKILL_NAME)} is the name this package reserves for the manual it publishes, and a lesson written in a skill of that name does not survive an update of the package, so no candidate was generated.`;
    default:
      return assertNever(reason);
  }
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

// The line the extension reports when the collector of signals raises a suspicion (M3, S5). It names the fact, the subject, the
// id the confirmation of the user names and the form that confirmation takes. It promises nothing about the skill, because a
// suspicion is not a defect (Q25) -- the user may have rewritten the draft by choice, or asked twice on purpose -- and names
// no skill either: a suspicion lives outside the index and carries none. Nothing was read, spent or edited behind it.
export function signalText(suspicion: Suspicion): string {
  const tail =
    `Nothing was spent and the skill was not touched: only a confirmation of the user turns a suspicion into a measurable attempt. Confirm it with /${COMMAND_NAME} <skill> --signal=${suspicion.id} --bank=<path>, naming the skill it applies to; without a bank nothing is spent and the suspicion stays open.`;

  switch (suspicion.kind) {
    case "rewritten-draft":
      return `possible rewritten draft: the file ${quote(suspicion.subject)} was written in an earlier turn and written again in turn ${suspicion.turnIndex} with different arguments. ${tail}`;
    case "repeated-request":
      return `possible repeated request: this turn asks, in substance, for what an earlier turn already asked -- ${quote(suspicion.excerpt)}. ${tail}`;
    default:
      // A kind of a later version that reaches this build of the messages is a sentence nobody wrote: the dispatch names it
      // instead of rendering it with the wording of another one.
      return assertNever(suspicion.kind);
  }
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

// The same sentence over a retirement (M3, S4), and it is its own function because the other one says the lesson was
// accepted: a retirement that takes a lesson back and a reload that fails is the same two facts, and a sentence that named
// the wrong write would leave a user believing a lesson is in force that is not.
export function retirementReloadFailedText(reason: string): string {
  return `the lesson was retired and its tombstone is already on disk, but the reload of this session failed: ${reason}. The retirement stands -- nothing was reverted -- and the next session start reads the skill as it is now, with the lesson unreferenced.`;
}

// The one sentence of a retirement (M3, S4): what stopped applying, where the tombstone and the reason are, and the one
// fact a user needs before trying again -- there is no unretire, the way back is another proposal. Both paths are absolute
// for the reason acceptedText names them that way: they are what a human opens. The clause about the reference line is
// the answer of the protocol and not an assumption of this module: a skill that never referenced the lesson is one the
// retirement did not have to edit, and the sentence says which of the two happened.
export function retiredText(
  skill: SkillRef,
  slug: string,
  lessonPath: string,
  retirementPath: string,
  referenceRemoved: boolean,
): string {
  const reference = referenceRemoved
    ? "and its reference line left the ## Lessons section of the skill, so pi no longer loads it"
    : "and the ## Lessons section of the skill carried no reference line to it, so pi was not loading it either";
  return `retired ${lessonReferencePath(slug)} from skill ${quote(skill.name)}: the file at ${quote(lessonPath)} now says status "retired" ${reference}; the record of the retirement is ${quote(retirementPath)}. There is no unretire: a lesson that stops applying is replaced by proposing another one. The session reloads next, and a reload that fails leaves this retirement standing and is reported on its own.`;
}

// The sentence of each refusal of a retirement, one per reason of the closed union and never a generic one: the six
// reasons name six states and the user acts differently on each, so each one gets the sentence that says what was not
// written and what is next. The detail the protocol computed travels inside it, because that is the text that names the
// paths and the bytes the user repairs.
export function retireRejectedText(skill: SkillRef, rejection: RetireRejection): string {
  // The reason travels in the sentence, the way the verdict of a gate travels in the line it reports: the user reads the
  // word the record of the retirement would have carried, so the refusal and the vocabulary are one thing.
  const opening = `skill ${quote(skill.name)} (${rejection.reason}): `;

  switch (rejection.reason) {
    case "never-accepted":
      return `${opening}nothing was retired -- ${rejection.detail}. A retirement takes back a lesson this package accepted, so a slug the index holds no acceptance of has nothing to take back.`;
    case "unreadable-index":
      return `${opening}nothing was retired, and the question cannot be answered from this index -- ${rejection.detail}. The line an interrupted append cut may be the acceptance of this lesson, so the refusal says the index is broken instead of claiming nothing was accepted.`;
    case "lesson-missing":
      return `${opening}nothing was retired -- ${rejection.detail}. The acceptance is in the index and the file it names is not in the skill, so there is no lesson to retire.`;
    case "lesson-drift":
      return `${opening}nothing was retired -- ${rejection.detail}. What a retirement takes back is the lesson the acceptance measured, and a file whose bytes moved is not that lesson: correct the file, or accept the lesson again, before retiring it.`;
    case "history-exists":
      return `${opening}nothing was retired -- ${rejection.detail}. Ask again a moment later: the snapshot of a retirement is named after the clock, and a history that is taken is never rewritten.`;
    case "reference-failed":
      return `${opening}the retirement stopped at the reference line and wrote no tombstone, no record and no line of the index -- ${rejection.detail}.`;
    default:
      // The six reasons are the whole union: a reason added to src/retirement.ts without a sentence here stops compiling.
      return assertNever(rejection.reason);
  }
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

// The report of the series of sessions (M3, S2): the numbers src/metrics.ts projects, each one printed next to the
// denominator it was computed over. The parenthesis is part of the number and not decoration -- "0.50 (2 of 4 gated
// attempts)" says what was divided by what, and a rate whose denominator the reader cannot see is a rate no one can audit.
//
// A denominator of 0 prints no rate at all. "0.00" over nothing is not a measurement of zero but the absence of one, so the
// sentence names the attempt that is missing: no gated attempt yet, no accepted lesson yet, no pair replayed by a gate yet.
//
// The two rates are the two numbers OA5 asks for, and they are printed under names that cannot be confused with each other.
// The recurrence is the definition of a regression the author gave -- going back to a path an accepted lesson had already
// corrected -- and it is computed over the lessons in force. The gate regressions are another fact with another denominator,
// and they travel as a column of support: the pairs of runs a gate replayed, of which some went from passing under the
// incumbent to failing under the candidate. A regression of the gate is not a recurrence: the first is about one candidate
// and one replay, the second is about the lessons a skill already carries.
//
// The split of D-B is the fourth line: why the failed runs of the fourth class failed, which is the number the unanimity
// rule is discussed with. The coverage is the last line and it is printed only when it has something to say (rule 5): a
// pruned `staging/` takes the record of a rejected attempt away and leaves the line of the index behind, so a report printed
// without it would claim a measurement over records nobody read.
export function metricsText(metrics: Metrics): string {
  const lines = [
    acceptanceRateText(metrics),
    recurrenceRateText(metrics),
    gateRegressionText(metrics.gated),
    `quality defects that failed: ${metrics.buried.toolError} by a tool error, ${metrics.buried.text} by the text.`,
  ];

  if (metrics.records.missing > 0) lines.push(coverageText(metrics.records));

  return lines.join("\n");
}

// The share of the attempts that reached a gate that the acceptance accepted. The rate is the one src/metrics.ts projected --
// this module prints it and never divides on its own -- and the parenthesis is the denominator that rate was computed over:
// the derived total of the gate (see GateTally), so an abstention is in it, because it reached a gate even though it
// concluded nothing.
function acceptanceRateText(metrics: Metrics): string {
  const { gated } = metrics;
  if (gated.attempts === 0) return "acceptance rate: no gated attempt yet.";

  return `acceptance rate ${rateText(metrics.acceptanceRate)} (${gated.accepted} of ${gatedAttemptsText(gated.attempts)}).`;
}

// The share of the accepted lessons in force whose failure class came back. The rate is the projected one again, and both
// counts are the sum of the rows of the report: a lesson is a fact of a skill and the report counts them per skill (rule 9),
// so the denominator is the sum of the rows and not a field of its own.
function recurrenceRateText(metrics: Metrics): string {
  const lessons = totalOf(metrics.bySkill, "lessons");
  if (lessons === 0) return "recurrence rate: no accepted lesson yet.";

  const recurrences = totalOf(metrics.bySkill, "recurrences");
  return `recurrence rate ${rateText(metrics.recurrenceRate)} (${recurrences} of ${acceptedLessonsText(lessons)}).`;
}

// The column of support: a count and its denominator, and not a rate, because what it answers -- did the candidate lose a
// pair the incumbent passed -- is read as a number of pairs and not as a share of anything.
function gateRegressionText(gated: GateTally): string {
  if (gated.pairs === 0) return "gate regressions: no pair replayed by a gate yet.";

  return `gate regressions ${gated.regressions} of ${gated.pairs} incumbent passes.`;
}

// The one line that keeps the report from claiming more than it measured: how many of the records the index names were not
// there and what that does to the numbers above.
function coverageText(records: { present: number; missing: number }): string {
  const named = recordsText(records.present + records.missing);
  return `coverage is partial: of the ${named} this index names, ${records.missing} could not be read, so the rates above measure the records that are here and not the series.`;
}

// Two decimals for every rate. The counts in the parenthesis are what the rounding leaves out: a reader who wants the exact
// share divides the two numbers the sentence already printed.
function rateText(rate: number): string {
  return rate.toFixed(2);
}

// The two denominators as words, so the sentence reads as English at both ends: one gated attempt and one accepted lesson
// are as ordinary as four of either, and "1 gated attempts" is the kind of detail that makes a report look generated.
function gatedAttemptsText(attempts: number): string {
  return attempts === 1 ? "1 gated attempt" : `${attempts} gated attempts`;
}

function acceptedLessonsText(lessons: number): string {
  return lessons === 1
    ? "1 accepted lesson that saw its failure class return"
    : `${lessons} accepted lessons that saw their failure class return`;
}

function recordsText(records: number): string {
  return records === 1 ? "1 record" : `${records} records`;
}

function totalOf(tallies: readonly SkillTally[], key: "recurrences" | "lessons"): number {
  return tallies.reduce((total, tally) => total + tally[key], 0);
}

// The report of the accepted lessons against the records that accepted them (M3, S3): what the bytes of each lesson on disk
// are worth next to the acceptance that wrote them. The states are the ones src/standing.ts decided; this module puts them
// in order and prints them, so nothing here can turn a report into a permission to retire, to re-accept or to edit, and a
// line that reads as good news is a description and not a warranty.
//
// One line per skill, then one line per lesson that has something to say, then the count of the lessons nobody could check.
// The rows travel in the order standingOf returned them, sorted by name there, and the lessons in the order of the index,
// which is the order a reader comparing two reports reads down.
//
// A lesson whose bytes are the ones of the record and whose skill still loads it is not printed at all: it is the answer the
// report exists to earn, and a line per intact lesson would bury the ones that are wrong. An index with no acceptance in
// force prints one sentence and no table, the rule the rates of metricsText follow: a table with no row is not a measurement
// of zero.
export function standingText(report: StandingReport): string {
  if (report.checks.length === 0 && report.skills.length === 0 && report.missingRecords === 0) {
    return "no accepted lesson is in force in this index, so there is nothing to check.";
  }

  const lines = report.skills.map(skillStandingText);
  lines.push(...report.checks.filter(carriesSomething).map(lessonStandingText));
  if (report.missingRecords > 0) lines.push(missingRecordsText(report.missingRecords));

  return lines.join("\n");
}

// Whether a lesson has something to say in the report: its bytes moved from the ones the record names, or the skill does not
// reach the file. The two questions are independent and each one is a repair of its own, so either of them earns a line.
function carriesSomething(check: LessonCheck): boolean {
  return check.standing !== "intact" || !check.referenced;
}

// One row per skill the check answered for (rule 8 of the slice): the worst state of its lessons, then the count and that
// same state again, so the line reads as a row of a report and not as a sentence about a count. The worst one is the whole
// answer of the row -- the count says nothing about how many of them are wrong -- and it is the state of the parenthesised
// half for a reader who scans only that.
function skillStandingText(row: SkillStanding): string {
  return `${row.skill}: ${row.worst} (${lessonsText(row.lessons)}, worst: ${row.worst})`;
}

// One lesson that needs saying, with the reason it does. A lesson whose bytes are the ones of the record is listed only
// because the skill does not reach it, and that line has to open with the fact the state hides: the file is there, and a
// lesson pi never loads does nothing (Q10).
function lessonStandingText(check: LessonCheck): string {
  const detail = check.detail ?? "no reason was recorded";
  const reason = check.standing === "intact" ? `the lesson file is in the skill, ${detail}` : detail;
  return `  - ${check.slug}: ${check.standing} (${reason})`;
}

// The last line, printed only when it has something to say: an acceptance whose record cannot be read is a lesson nothing
// compared against the bytes on disk, so the report counts it instead of letting a reader believe the rows above cover the
// whole index.
function missingRecordsText(missing: number): string {
  if (missing === 1) {
    return "1 accepted lesson could not be checked: the record that accepted it is not readable any more, so its bytes and its reference line were not compared against anything.";
  }
  return `${missing} accepted lessons could not be checked: the record that accepted them is not readable any more, so their bytes and their reference line were not compared against anything.`;
}

function lessonsText(lessons: number): string {
  return lessons === 1 ? "1 lesson" : `${lessons} lessons`;
}

// The line the two reports of the index add when the file stopped before its end (M3, S10). src/ledger.ts answers `damaged`
// when the first line it cannot interpret cuts the reading, and a report built over the lines before that cut is shorter than
// the index is and, for that same reason, more reassuring than the truth: the sentence names the line the reading stopped at,
// says that nothing after it was read, and gives the problem and the path of the file the reader has to repair. It is added to
// the answer the report already gave and not printed on its own, because it is a property of that answer and not a second one.
//
// The number is one more than the position the reader answered (M3, S11). `damaged.index` is a position inside a file -- 0-based,
// as src/ledger.ts says -- and the sentence names a line of the file a human opens, which counts from 1. The conversion lives here
// and not in the reader because the two count different things and only this sentence owes the second one: printed as it arrived,
// the position would call a cut on the first line `line 0`, and `line 1` would name the second.
export function damagedIndexText(damaged: { index: number; problem: string }, indexPath: string): string {
  return `the index ${quote(indexPath)} stops at line ${damaged.index + 1}, so everything after that line was not read and the answer above covers the lines before it only: ${damaged.problem}.`;
}

// The answer of a confirmation that names a suspicion nobody holds (M3, S6). A suspicion lives in two places and the
// sentence names both, because the id alone cannot say which one failed: the memory of this session and the file the
// collector hydrates when the session starts. It says where the open ones are -- the notice that reported them, which is
// the line the id arrived in -- and it promises nothing about the id it cannot see: no candidate, no gate and no model was
// reached, and the skill was not touched.
export function unknownSignalText(id: string): string {
  return `No suspicion with the id ${quote(id)} is open: it was not raised in this session or in the file of the collector, or a confirmation already consumed it. The open ones are named in the notice that reports them, and nothing was spent and the skill was not touched.`;
}
