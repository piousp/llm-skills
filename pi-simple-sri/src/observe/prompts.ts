import { PROBATION_OUTCOME, type GateClassification } from "./outcome.ts";
import { jaccard, tokenSet } from "./patterns.ts";
import { PROMPT_TIMEOUT_MS, type GateKind, type PromptAnswer, type Provenance } from "./types.ts";

// What the gate does and does not establish (decisions 2, D3). Both prompts carry it: the user is approving a measured
// lesson, not a verified diagnosis.
export const GATE_PROOF_NOTICE =
  "The gate shows the lesson makes these cases pass; it does not prove the pattern is real.";

const MAX_SHOWN_OBSERVATIONS = 3;
const SIMILAR_OBSERVATION_JACCARD = 0.7;

export interface BankCaseView {
  id: string;
  prompt: string;
  // One readable line per check.
  checks: readonly string[];
}

// Everything a prompt shows, already resolved by the caller: this module reads no store, file or clock.
export interface ProposalView {
  skill: string;
  patternSummary: string;
  // Redacted summaries of the observations of the pattern.
  observations: readonly string[];
  sessions: number;
  days: number;
  // Real runs of the skill the gate plans: arms x repetitions x items. Not how often the pattern was seen.
  realRuns: number;
  lesson: string;
  gate: GateKind;
  // The directory the gate replays in.
  cwd: string;
  bank: { provenance: Provenance | null; cases: readonly BankCaseView[] } | null;
}

export interface DialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface PromptUi {
  select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined>;
}

function wordsOf(text: string): Set<string> {
  return tokenSet(text.split(/[^\p{L}\p{N}]+/u));
}

// The first of each group of near-identical summaries (token Jaccard >= 0.7 against one already kept), at most
// MAX_SHOWN_OBSERVATIONS of them; everything else is counted.
function observationLines(view: ProposalView): string[] {
  const kept: Array<{ text: string; words: Set<string> }> = [];
  for (const text of view.observations) {
    if (kept.length === MAX_SHOWN_OBSERVATIONS) break;
    const words = wordsOf(text);
    if (kept.some((other) => jaccard(words, other.words) >= SIMILAR_OBSERVATION_JACCARD)) continue;
    kept.push({ text, words });
  }
  const shown = kept.map((item) => `  - ${item.text}`);
  const rest = view.observations.length - shown.length;
  return rest > 0 ? [...shown, `  +${rest} more`] : shown;
}

function bankLines(view: ProposalView): string[] {
  if (view.gate === "probation" || view.bank === null) return ["Probation: not measured."];
  const runs = `The gate will spend up to ${view.realRuns} real runs of the skill in ${view.cwd} (arms x repetitions x items).`;
  const header = `Bank (provenance: ${view.bank.provenance ?? "unknown"}), ${view.bank.cases.length} cases:`;
  const cases = view.bank.cases.flatMap((c) => [`  ${c.id}: ${c.prompt}`, ...c.checks.map((check) => `    ${check}`)]);
  return [runs, header, ...cases];
}

function summaryLines(view: ProposalView): string[] {
  return [
    `Skill: ${view.skill}`,
    `Pattern: ${view.patternSummary}`,
    `Seen in ${view.sessions} sessions over ${view.days} days.`,
    "Observations:",
    ...observationLines(view),
    "Proposed lesson:",
    view.lesson,
  ];
}

export function promptAText(view: ProposalView): string {
  return [
    ...summaryLines(view),
    ...bankLines(view),
    `Gate cwd: ${view.cwd}`,
    GATE_PROOF_NOTICE,
    "Approve the lesson and the bank before the gate spends runs?",
  ].join("\n");
}

function outcomeLine(view: ProposalView, outcome: GateClassification): string {
  const measured = view.gate === "bank" && outcome.class !== "not-measurable";
  const detail = outcome.reason === null ? outcome.status : `${outcome.status}: ${outcome.reason}`;
  if (outcome.status === PROBATION_OUTCOME.status) return "Not measured. The lesson was not compared against any case.";
  return measured
    ? `Gate result: ${outcome.class} (${detail}).`
    : `Not measured: ${detail}. The lesson was not compared against any case.`;
}

export function promptBText(view: ProposalView, outcome: GateClassification): string {
  const measured = view.gate === "bank" && outcome.class !== "not-measurable";
  return [
    ...summaryLines(view),
    outcomeLine(view, outcome),
    ...(measured ? [GATE_PROOF_NOTICE] : []),
    "Accept the lesson into the skill?",
  ].join("\n");
}

type Labelled<Answer extends PromptAnswer> = ReadonlyArray<readonly [label: string, answer: Answer]>;

// An abort (the session is shutting down) counts as `later` and the caller checks the signal before it persists:
// dismissing by timeout, Esc or abort all return undefined, so the signal is the only way to tell the abort apart.
async function offer<Answer extends PromptAnswer>(
  ui: PromptUi,
  title: string,
  choices: Labelled<Answer>,
  signal: AbortSignal | undefined,
): Promise<Answer | "timeout"> {
  if (signal?.aborted) return choices[0]![1];
  const picked = await ui.select(
    title,
    choices.map(([label]) => label),
    { timeout: PROMPT_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
  );
  if (signal?.aborted) return choices[0]![1];
  if (picked === undefined) return "timeout";
  return choices.find(([label]) => label === picked)?.[1] ?? choices[0]![1];
}

const PROPOSAL_CHOICES: Labelled<"later" | "approve" | "reject"> = [
  ["Later", "later"],
  ["Approve", "approve"],
  ["Reject", "reject"],
];

const ACCEPTANCE_CHOICES: Labelled<"later" | "accept" | "reject"> = [
  ["Later", "later"],
  ["Accept", "accept"],
  ["Reject", "reject"],
];

export function offerProposal(
  view: ProposalView,
  ui: PromptUi,
  opts: { signal?: AbortSignal },
): Promise<"approve" | "reject" | "later" | "timeout"> {
  return offer(ui, promptAText(view), PROPOSAL_CHOICES, opts.signal);
}

export function offerAcceptance(
  view: ProposalView,
  outcome: GateClassification,
  ui: PromptUi,
  opts: { signal?: AbortSignal },
): Promise<"accept" | "later" | "reject" | "timeout"> {
  return offer(ui, promptBText(view, outcome), ACCEPTANCE_CHOICES, opts.signal);
}
