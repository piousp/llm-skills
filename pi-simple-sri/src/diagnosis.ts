import { SriDiagnosisError } from "./errors.ts";
import type { EvidenceContext } from "./evidence.ts";
import { sha256Digest } from "./hash.ts";
import { assertNever } from "./types.ts";
import type { Diagnosis, EvidenceItem, EvidenceKind, Expectation, ReplayItem, SkillRef } from "./types.ts";
import { quote } from "./values.ts";

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

const ID_SEPARATOR = "\n";

interface KindRule {
  // Fallback order of the classes: the lower the number, the stronger the class.
  priority: number;
  // What the replayed turn must stop doing, as the gate reads it. The tool name is not in the table: a
  // tool class is one row for every tool, and expectationFor adds the name the evidence item carries.
  expectation: Expectation;
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
function expectationFor(item: EvidenceItem): Expectation | undefined {
  const rule = KIND_RULES[item.kind];
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
    default:
      return assertNever(expectation.class);
  }
}

// Ids are sorted before hashing: the signature names the set of failures, so the same evidence
// in another transcript order yields the same signature, and one different id changes it.
function signatureOf(ids: readonly string[]): string {
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
