import { attemptSignature } from "./attempts.ts";
// Type-only, like the checks a case carries in src/types.ts: the contract of the bank is named here and the module that
// reads the file is the one that compiles its regexes, so this module keeps no run time dependency on the reader.
import type { CaseBank } from "./case-bank.ts";
import { SriDiagnosisError } from "./errors.ts";
import type { EvidenceContext } from "./evidence.ts";
import { sha256Digest } from "./hash.ts";
import { assertNever } from "./types.ts";
import type {
  DecisionTrigger,
  Diagnosis,
  EvidenceItem,
  EvidenceKind,
  EvidenceOrigin,
  Expectation,
  ReplayItem,
  SkillRef,
} from "./types.ts";
import { cutCodePoints, quote } from "./values.ts";

// Evidence becomes a diagnosis here: one summary, one signature, and the replay items the M1
// gate runs (Q2, Q13). Everything enters through the parameters; nothing is read from disk and
// nothing is invented.
//
// A replay item needs the prompt of the turn that failed, and EvidenceItem cannot carry it
// (see src/evidence.ts), so the caller passes the contexts derived with the evidence, keyed by
// evidence id. An item whose prompt is unknown produces no replay item: a made-up prompt would
// replay a task the user never asked for. That filter runs before the class priority (M5), so a
// failure that cannot be replayed never hides one that can. The same contexts carry the model of
// that turn, which is what a replay pins (Q13); the option below is only their fallback.
//
// Which class is replayable: the tool errors of the session. If the session has none, the retry
// loops. If it has neither, the user corrections, whose expectation needs no tool name.
// One replay item per selected failure, so the gate measures the failure that produced the
// diagnosis and not a different one.
//
// The fourth class, quality_defect (M1c), is never selected here and that is the point: its evidence does not come
// from a turn of the session but from an artifact, and what a replayed answer must satisfy is the list of checks
// the case bank gives it. A defect whose predicate does not travel with the evidence is not replayable from the
// transcript, so this module answers no expectation for the class instead of inventing one (see expectationFor);
// the constructor that has the bank in hand builds that item, and it is the only one that attaches checks.
//
// The base of the case bank has a constructor of its own, buildBaselineDiagnosis, and it does not come through here:
// an attempt measured by a bank has no failure of the transcript to point at, so its diagnosis is the ask and it
// carries no replay item. How many items a diagnosis must carry is a property of the base, and each constructor owns
// the answer for its own.
//
// The defect of M1c has the third constructor, buildDefectDiagnosis, and it is the only place the checks of a case become
// an expectation: its evidence comes from an artifact and its items are the cases of a bank, so neither the transcript
// nor the class can say what a replayed answer must satisfy.

const ID_SEPARATOR = "\n";

// The cap of the excerpt the summary of a defect quotes: the 200 code points src/evidence.ts and src/case-bank.ts declare,
// so the entry a defect was read from and the sentence a human reads quote the same text. A longer cap here would let the
// summary hold a finding the record cuts.
const MAX_EXCERPT_CODE_POINTS = 200;

interface KindRule {
  // Fallback order of the classes: the lower the number, the stronger the class.
  priority: number;
  // What the replayed turn must stop doing, as the gate reads it, or null for a class whose condition cannot be
  // derived from the evidence alone. The tool name is not in the table: a tool class is one row for every tool,
  // and expectationFor adds the name the evidence item carries.
  expectation: Expectation | null;
  // Whether the expectation has to carry the name of the failing tool to say anything.
  needsTool: boolean;
  // Singular form the summary uses; every label pluralizes with "s".
  label: string;
}

// One row per failure class: the single place this module names a class, so the two dispatch
// chains and the two parallel lists that used to sit beside the type are gone (I2). The record
// makes the kind set exhaustive by typecheck: a new EvidenceKind loses a member here and stops
// compiling wherever a class is looked up, with no switch and no runtime fallback behind it.
const KIND_RULES: Record<EvidenceKind, KindRule> = {
  tool_error: {
    priority: 0,
    expectation: { class: "tool_error", version: 1 },
    needsTool: true,
    label: "tool error",
  },
  retry_loop: {
    priority: 1,
    expectation: { class: "retry_loop", version: 1 },
    needsTool: true,
    label: "retry loop",
  },
  user_correction: {
    priority: 2,
    expectation: { class: "user_correction", version: 1 },
    needsTool: false,
    label: "user correction",
  },
  // M1c: the weakest class, and the only one whose expectation is not derivable from the evidence alone. It never
  // displaces a class of M1 -- a defect is evidence read from an artifact, so the class the transcript can prove is
  // the one the replay measures -- and it has no tool to watch.
  quality_defect: {
    priority: 3,
    expectation: null,
    needsTool: false,
    label: "quality defect",
  },
};

interface KindCount {
  kind: EvidenceKind;
  count: number;
}

export interface DiagnosisOptions {
  // Model of the session the diagnosis runs in, used only as a fallback: a replay item carries the
  // model of the assistant turn that failed (EvidenceContext.model, Q13, OA5) and falls back to
  // this one only when the transcript has no AssistantMessage to name it. Same spelling as the
  // evidence: "provider/model".
  model?: string;
}

// Fail-closed diagnosis error: no evidence, or no failure that can be replayed as asked.
// The class lives in src/errors.ts with the rest of the fail-closed errors; it is re-exported
// here because this is the module that raises it.
export { SriDiagnosisError };

export function buildDiagnosis(
  evidence: readonly EvidenceItem[],
  contextById: ReadonlyMap<string, EvidenceContext>,
  skill: SkillRef,
  cwd: string,
  options: DiagnosisOptions = {},
): Diagnosis {
  if (evidence.length === 0) {
    throw new SriDiagnosisError(`cannot diagnose skill ${quote(skill.name)}: the evidence is empty`);
  }

  const replayItems = selectReplayable(evidence, contextById).map((replayable) =>
    buildReplayItem(replayable, contextById, skill, cwd, options),
  );

  if (replayItems.length === 0) {
    throw new SriDiagnosisError(
      `cannot diagnose skill ${quote(skill.name)}: no failure has the prompt a replay item needs`,
    );
  }

  return {
    summary: summarize(evidence),
    failureSignature: signatureOf(evidence.map((item) => item.id)),
    replayItems,
  };
}

// The other constructor of this module, for the other base (M1c, OA2): an attempt that asks for a change and names a
// bank to measure it with has no failure of this session to point at and no turn of it to replay, so its diagnosis is
// the ask -- the skill and the focus the record already carries -- and nothing else. `replayItems` is empty because the
// turns it replays are the cases of the bank: the gate supplies them when it runs, and an item invented here would name
// a prompt nobody wrote.
//
// It does not go through buildDiagnosis on purpose. The guard of that constructor -- at least one replay item -- is the
// guard of the base of the transcript, and it stays there: how many items are right is a property of the base, so the
// constructor of each base owns its own answer instead of the schema owning neither.
//
// The signature of the ask is the digest of the attempt's identity (attemptSignature), which is what makes two
// directional attempts that ask for the same thing on the same skill one failure for a reader of the index, and a
// different focus or another skill a different one.
export function buildBaselineDiagnosis(trigger: DecisionTrigger, skill: SkillRef): Diagnosis {
  return {
    summary: summaryOfAsk(trigger, skill),
    // The published trigger spells an absent focus as null and the digest spells it as "": the conversion is here,
    // as it is for the hashes of an attempt (src/attempts.ts).
    failureSignature: attemptSignature("directional_improvement", skill.name, trigger.focus ?? undefined),
    replayItems: [],
  };
}

// One sentence, determined by the trigger: the skill and the ask, and -- when the user asked for nothing in particular --
// exactly that. It is the first text of a record a human reads, so the absent focus is said instead of filled in: a
// sentence that supplied a subject would be describing a request nobody made.
function summaryOfAsk(trigger: DecisionTrigger, skill: SkillRef): string {
  const ask = trigger.focus === null ? "no focus was asked for" : `the focus asked for was ${quote(trigger.focus)}`;
  return `Directional improvement of skill ${quote(skill.name)}: ${ask}.`;
}

// The third constructor of this module, for the third base (M1c, S8): the evidence a defect gives and the bank whose cases
// measure it. A defect is a truth observable in an artifact -- a review finding, a draft that was rejected -- so its
// evidence is not read from a turn of the session, and what a replayed answer must satisfy is not a property of a class
// but the list of checks each case carries (see expectationFor).
//
// One replay item per case of the bank, and the prompt of each item is the prompt of its case: the turns this base replays
// are the ones the user wrote, and a prompt invented here would replay a task nobody asked for. Every item names the same
// failure -- the one evidence item -- because every case measures the same defect, and the gate pairs the two by signing
// the id of that evidence (src/gate/flow.ts, planItemsOf).
//
// A case whose checks are empty produces no item: an expectation of this class with no predicate is a condition nobody
// wrote, and src/checks.ts would have nothing to execute. The reader of the bank refuses such a case, so this is a guard
// over a bank built somewhere else and not a case the flow can reach.
//
// The signature of the diagnosis is the signature of the one evidence item, which is also the signature of every item, so
// the two cannot describe different failures.
export function buildDefectDiagnosis(
  evidence: EvidenceItem,
  bank: CaseBank,
  skill: SkillRef,
  cwd: string,
  model?: string,
): Diagnosis {
  const origin = evidence.origin;
  if (evidence.kind !== "quality_defect" || origin === undefined) {
    throw new SriDiagnosisError(
      `cannot diagnose skill ${quote(skill.name)}: the evidence ${quote(evidence.id)} is not a defect read from an artifact`,
    );
  }

  const failureSignature = signatureOf([evidence.id]);
  const replayItems: ReplayItem[] = [];
  for (const entry of bank.cases) {
    if (entry.checks.length === 0) continue;

    const item: ReplayItem = {
      prompt: entry.prompt,
      cwd,
      // A fresh list every time: the case of the bank is data this record copies, and a caller that edited what it was
      // handed would edit the bank the next case is read from.
      expectation: { class: "quality_defect", version: 1, checks: [...entry.checks] },
      skills: [skill.name],
      failureSignature,
    };
    // Q13, OA5: the model the replay pins is the one of the invocation, because a defect has no failing turn to name its
    // own. Absent when the session runs no model, and then the gate abstains with `no-model` instead of guessing one.
    if (model !== undefined) item.model = model;
    replayItems.push(item);
  }

  return { summary: summaryOfDefect(evidence, origin, skill), failureSignature, replayItems };
}

// The sentence a human reads about a defect, derived from the artifact and never invented: how it was found, where it is,
// and the entry that does not hold. With no excerpt the sentence says exactly that, the way the summary of an ask says
// there was no focus.
function summaryOfDefect(evidence: EvidenceItem, origin: EvidenceOrigin, skill: SkillRef): string {
  const entry =
    evidence.excerpt === undefined
      ? "no entry was recorded"
      : quote(cutCodePoints(evidence.excerpt, MAX_EXCERPT_CODE_POINTS));
  return `Quality defect of skill ${quote(skill.name)} read from ${quote(origin.path)} (${quote(origin.kind)}): ${entry}.`;
}

// A failure that yields both values a replay item needs, read once from the evidence and its
// context so neither the selection nor the construction asks for them again.
interface Replayable {
  item: EvidenceItem;
  prompt: string;
  expectation: Expectation;
}

// M5: the prompt filter comes first, so a failure without a prompt never displaces one that can
// be replayed. Among the items that can, the strongest class present wins: a tool error is a
// failure the gate measures directly, a retry loop is the same failure observed several times,
// and a correction is the model being wrong with no tool failing. An item also has to yield an
// expectation: a tool class without a tool name cannot say what must stop failing, so it is not
// replayable either and must not shadow a weaker class that is.
//
// One pass over the evidence: the buffer holds the strongest class seen so far and a stronger one
// found later replaces it, so the items that survive keep the order the evidence gave them.
function selectReplayable(
  evidence: readonly EvidenceItem[],
  contextById: ReadonlyMap<string, EvidenceContext>,
): Replayable[] {
  const replayable: Replayable[] = [];
  let strongestPriority = Number.POSITIVE_INFINITY;

  for (const item of evidence) {
    const prompt = promptOf(item, contextById);
    if (prompt === undefined) continue;

    const expectation = expectationFor(item);
    if (expectation === undefined) continue;

    const { priority } = KIND_RULES[item.kind];
    if (priority < strongestPriority) {
      strongestPriority = priority;
      replayable.length = 0;
    }
    if (priority === strongestPriority) replayable.push({ item, prompt, expectation });
  }

  return replayable;
}

function buildReplayItem(
  replayable: Replayable,
  contextById: ReadonlyMap<string, EvidenceContext>,
  skill: SkillRef,
  cwd: string,
  options: DiagnosisOptions,
): ReplayItem {
  const { item, prompt, expectation } = replayable;

  const replayItem: ReplayItem = {
    prompt,
    cwd,
    expectation,
    skills: [skill.name],
    failureSignature: signatureOf([item.id]),
  };
  // Q13, OA5: the model the failure came from, not the one the session runs now. The option is the
  // fallback of a transcript that never recorded the failing turn.
  const model = contextById.get(item.id)?.model ?? options.model;
  if (model !== undefined) replayItem.model = model;

  const assistantCycleIndex = contextById.get(item.id)?.assistantCycleIndex;
  if (assistantCycleIndex !== undefined) replayItem.assistantCycleIndex = assistantCycleIndex;
  if (item.toolName !== undefined) replayItem.failingToolCall = item.toolName;
  return replayItem;
}

// The prompt of the turn that failed; a whitespace-only prompt is no prompt, because the replay
// would start from nothing. The selection reads it once and hands it to the replay item, so the
// rule lives here once.
function promptOf(
  item: EvidenceItem,
  contextById: ReadonlyMap<string, EvidenceContext>,
): string | undefined {
  const prompt = contextById.get(item.id)?.prompt;
  if (prompt === undefined || prompt.trim() === "") return undefined;
  return prompt;
}

// The condition a replayed turn is judged by. A tool class needs the tool name to say what must stop
// failing; a correction does not, because what must stop is the user objecting. A fresh object every
// time: the row of the table is shared by every item of its class, and a caller that edited what it was
// handed would edit the class.
//
// A quality_defect yields no expectation here. What its replayed answer must satisfy is the list of checks the case
// bank carries, and that list travels with the evidence and not with the class, so an expectation built from the
// class alone would be a condition nobody wrote. The constructor that holds the bank builds that item and attaches
// the checks (M1c, buildDefectDiagnosis); this function answers undefined so no caller mistakes the class for one a
// transcript can replay.
function expectationFor(item: EvidenceItem): Expectation | undefined {
  const rule = KIND_RULES[item.kind];
  if (rule.expectation === null) return undefined;
  if (!rule.needsTool) return { ...rule.expectation };
  if (item.toolName === undefined) return undefined;
  return { ...rule.expectation, tool: item.toolName };
}

// The sentence a human reads about an expectation, derived from the descriptor so the wording never
// becomes the contract again: src/proposer.ts writes it into the prompt as "must-stop" and
// src/tool-skill-improve.ts answers a diagnosis with it. The text is the one the prose predicate used to
// carry, word for word: this function changes where the sentence comes from, not what it says.
export function describeExpectation(expectation: Expectation): string {
  switch (expectation.class) {
    case "user_correction":
      return "the user does not correct the model again";
    case "tool_error":
    case "retry_loop":
      // A tool class without a tool name is not replayable, so nothing this package writes reaches the
      // fallback; the sentence still has to describe the class for a record written elsewhere.
      return expectation.tool === undefined
        ? "the failing tool does not return an error again"
        : `the tool ${expectation.tool} does not return an error again`;
    case "quality_defect":
      // The sentence names the class and not the checks: what the user reads is what the answer must satisfy, and
      // the list itself is data the gate runs. It is worded for a record written elsewhere too, so a defect whose
      // checks are missing still has a sentence.
      return "the answer passes every check the defect carries";
    default:
      return assertNever(expectation.class);
  }
}

// The two relations between an expectation and its class that JSON Schema cannot state, because it ties no property
// to another: `tool` is present exactly on the two tool classes, and `checks` is present and non-empty exactly on
// quality_defect. One function owns both, so a record written by a later slice and a record read from disk are
// judged by the same rule, and test/unit/diagnosis.test.ts walks the whole product of the three dimensions (class,
// tool, checks) instead of a sample of it.
//
// "Owner" is literal: describeExpectation is defined over any Expectation, because a sentence has to be derivable
// from a record this package did not write, and that is a different question from whether the record is well formed.
// `undefined` is the expectation that satisfies both relations.
export function expectationViolation(expectation: Expectation): string | undefined {
  const toolClass = expectation.class === "tool_error" || expectation.class === "retry_loop";
  if (toolClass && expectation.tool === undefined) {
    return `a ${quote(expectation.class)} expectation needs the name of the failing tool`;
  }
  if (!toolClass && expectation.tool !== undefined) {
    return `a ${quote(expectation.class)} expectation names no tool, got ${quote(expectation.tool)}`;
  }

  const checks = expectation.checks;
  if (expectation.class === "quality_defect") {
    return checks === undefined || checks.length === 0
      ? `a ${quote(expectation.class)} expectation needs at least one check`
      : undefined;
  }
  return checks === undefined || checks.length === 0
    ? undefined
    : `a ${quote(expectation.class)} expectation carries no checks, got ${checks.length}`;
}

// Ids are sorted before hashing: the signature names the set of failures, so the same evidence
// in another transcript order yields the same signature, and one different id changes it.
//
// Exported because it is the package's one rule for what a failure signature is: the gate recovers the excerpt of
// a replay item by signing the id of each evidence entry with this function (src/gate/flow.ts), so a change here
// moves the signature of the diagnosis and the pairing of the gate together instead of only one of them.
export function signatureOf(ids: readonly string[]): string {
  return sha256Digest([...ids].sort().join(ID_SEPARATOR));
}

// One English sentence naming the tool and the failure classes present, with no content the
// evidence does not have.
function summarize(evidence: readonly EvidenceItem[]): string {
  const counts = countsByKind(evidence).map(
    (entry) => `${entry.count} ${labelFor(entry.kind, entry.count)}`,
  );

  const tools = toolNames(evidence);
  const toolPhrase = tools.length === 1 ? "tool" : "tools";
  const suffix = tools.length === 0 ? "" : ` for ${toolPhrase} ${tools.map(quote).join(", ")}`;

  return `Observed ${joinWithAnd(counts)} in this session${suffix}.`;
}

// Counts per class present, strongest class first. Counting the evidence instead of iterating
// KIND_RULES keeps the key type: a record iterates as string keys and narrowing them back to
// EvidenceKind would need a cast.
function countsByKind(evidence: readonly EvidenceItem[]): KindCount[] {
  const counts = new Map<EvidenceKind, number>();
  for (const item of evidence) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => KIND_RULES[left.kind].priority - KIND_RULES[right.kind].priority);
}

// Every label in KIND_RULES pluralizes with "s"; a class with an irregular plural would need a
// second form in the table.
function labelFor(kind: EvidenceKind, count: number): string {
  const { label } = KIND_RULES[kind];
  return count === 1 ? label : `${label}s`;
}

function toolNames(evidence: readonly EvidenceItem[]): string[] {
  const names = new Set<string>();
  for (const item of evidence) {
    if (item.toolName !== undefined) names.add(item.toolName);
  }
  return [...names].sort();
}

function joinWithAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
