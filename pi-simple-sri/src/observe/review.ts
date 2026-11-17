import type { DirectionalGateResult } from "../gate/directional-flow.ts";
import type { AcceptOutcome } from "../gate/acceptance.ts";
import type { GateFlowResult } from "../gate/flow.ts";
import { assertNever } from "../types.ts";
import { toErrorMessage } from "../values.ts";
import { latestBy, latestProposals } from "./cycle.ts";
import { PROBATION_OUTCOME, classifyGateResult, type GateClassification } from "./outcome.ts";
import { offerAcceptance, offerProposal, type PromptUi, type ProposalView } from "./prompts.ts";
import {
  OBSERVE_FORMAT,
  type GateOutcomeEvent,
  type ObserveEvent,
  type ObserveState,
  type PromptEvent,
  type ProposalEvent,
  type TombstoneEvent,
} from "./types.ts";

type Notify = (message: string, type?: "info" | "warning" | "error") => void;

// ---------------------------------------------------------------------------------------------
// Dispatching `/skill-improve --review=<id>` (spike Q1: DEFERRED_COMMAND).
// ---------------------------------------------------------------------------------------------

export interface ReviewApi {
  sendUserMessage(text: string, options: { expandPromptTemplates: boolean }): unknown;
  notify: Notify;
}

function reviewCommandOf(proposalId: string): string {
  return `/skill-improve --review=${proposalId}`;
}

// Fire and forget. `command` sends at once; `deferred-command` sends only when the session is idle, otherwise at the
// next settle and only if it is idle again (a command run while streaming silently drops its reload); `notice` only
// names the command. A failed send is a notice, never an exception: the review stays available by hand.
export function dispatchReview(
  api: ReviewApi,
  isIdle: () => boolean,
  onSettled: (callback: () => void) => void,
  proposalId: string,
  mode: "command" | "deferred-command" | "notice",
): void {
  const command = reviewCommandOf(proposalId);
  const notice = (): void => api.notify(`A lesson is ready for review: run ${command}`, "info");
  const send = (): void => {
    const failed = (error: unknown): void =>
      api.notify(`Could not start the review (${error instanceof Error ? error.message : String(error)}): run ${command}`, "warning");
    try {
      Promise.resolve(api.sendUserMessage(command, { expandPromptTemplates: true })).catch(failed);
    } catch (error) {
      failed(error);
    }
  };

  switch (mode) {
    case "command":
      return send();
    case "deferred-command":
      if (isIdle()) return send();
      return onSettled(() => (isIdle() ? send() : notice()));
    case "notice":
      return notice();
    default:
      return assertNever(mode);
  }
}

// ---------------------------------------------------------------------------------------------
// reviewProposal
// ---------------------------------------------------------------------------------------------

export type ReviewResult = "accepted" | "rejected" | "retryable" | "declined" | "nothing-to-review";

export interface ReviewUi extends PromptUi {
  notify: Notify;
}

export interface ReviewContext {
  ui: ReviewUi;
  signal?: AbortSignal;
}

// Every effect of a review is a dependency. None of them reloads: only the command that called the review may.
export interface ReviewDeps {
  now(): Date;
  readState(): Promise<ObserveState>;
  // The staged record says the lesson is already in the skill.
  isAccepted(proposal: ProposalEvent): Promise<boolean>;
  viewOf(proposal: ProposalEvent): Promise<ProposalView>;
  // Writes an approved auto bank to banks/ and answers the path the gate reads; null when the proposal has no bank.
  promoteBank(proposal: ProposalEvent): Promise<string | null>;
  runGate(proposal: ProposalEvent, bankPath: string | null, signal?: AbortSignal): Promise<GateFlowResult | DirectionalGateResult>;
  accept(proposal: ProposalEvent, outcome: GateClassification): Promise<AcceptOutcome>;
  append(events: ObserveEvent[]): Promise<void>;
}

function latestOutcomeOf(state: ObserveState, proposalId: string): GateOutcomeEvent | undefined {
  return latestBy(state.gateOutcomes.filter((o) => o.proposalId === proposalId));
}

// A tombstone without a hash closes the pattern; one with a hash closes only that candidate.
function isTombstoned(proposal: ProposalEvent, state: ObserveState): boolean {
  return state.tombstones.some(
    (t) => t.patternId === proposal.patternId && (t.candidateHash === null || t.candidateHash === proposal.candidateHash),
  );
}

function classificationOf(event: GateOutcomeEvent): GateClassification {
  return { class: event.class, status: event.status, reason: event.reason };
}

// Asks prompt (a) when the user never approved the lesson and the bank, gates in the foreground when the outcome is
// missing or retryable, asks the user, and accepts only on their answer. A probation proposal has no gate: the lesson was
// never measured.
export async function reviewProposal(id: string, ctx: ReviewContext, deps: ReviewDeps): Promise<ReviewResult> {
  const state = await deps.readState();
  // Only the latest proposal of a pattern is live: a restaging replaced the earlier ones.
  const proposal = latestProposals(state).find((p) => p.id === id);
  if (proposal === undefined || isTombstoned(proposal, state) || (await deps.isAccepted(proposal))) return "nothing-to-review";

  const at = (): string => deps.now().toISOString();
  const tombstone = (reason: TombstoneEvent["reason"]): TombstoneEvent => ({
    format: OBSERVE_FORMAT,
    at: at(),
    type: "tombstone",
    patternId: proposal.patternId,
    skill: proposal.skill,
    reason,
    candidateHash: proposal.candidateHash,
  });

  // A proposal staged without the hash of the skill can never be accepted: it is closed instead of asked about.
  const stagedHash: unknown = proposal.skillContentHash;
  if (typeof stagedHash !== "string" || stagedHash === "") {
    await deps.append([tombstone("stale")]);
    ctx.ui.notify("This lesson was staged by an older version and cannot be accepted: it is closed, and a fresh one is staged when the pattern comes back.", "warning");
    return "nothing-to-review";
  }

  const persisted = latestOutcomeOf(state, proposal.id);
  if (persisted?.class === "rejected") return "nothing-to-review";

  const approved = state.prompts.some((p) => p.proposalId === proposal.id && p.stage === "a" && p.answer === "approve");
  if (!approved) {
    const answerA = await offerProposal(await deps.viewOf(proposal), ctx.ui, ctx.signal === undefined ? {} : { signal: ctx.signal });
    if (ctx.signal?.aborted) return "declined";
    await deps.append([{ format: OBSERVE_FORMAT, at: at(), type: "prompt", proposalId: proposal.id, stage: "a", answer: answerA }]);
    if (answerA === "reject") {
      await deps.append([tombstone("user-rejected")]);
      return "rejected";
    }
    if (answerA !== "approve") return "declined";
  }

  let outcome: GateClassification;
  if (proposal.gate === "probation") {
    outcome = PROBATION_OUTCOME;
  } else if (persisted !== undefined && persisted.class !== "retryable") {
    outcome = classificationOf(persisted);
  } else {
    let bankPath: string | null;
    try {
      bankPath = await deps.promoteBank(proposal);
    } catch (error) {
      ctx.ui.notify(`The bank could not be promoted (${toErrorMessage(error)}); nothing was gated.`, "warning");
      return "retryable";
    }
    outcome = classifyGateResult(await deps.runGate(proposal, bankPath, ctx.signal));
    const event: GateOutcomeEvent = {
      format: OBSERVE_FORMAT,
      at: at(),
      type: "gate-outcome",
      proposalId: proposal.id,
      ...outcome,
    };
    await deps.append([event]);
    if (outcome.class === "rejected") {
      await deps.append([tombstone("gate-rejected")]);
      return "rejected";
    }
    if (outcome.class === "retryable" || ctx.signal?.aborted) {
      ctx.ui.notify(
        `The gate did not conclude (${outcome.reason === null ? outcome.status : `${outcome.status}: ${outcome.reason}`}); the observer stages a fresh candidate at a later start.`,
        "warning",
      );
      return "retryable";
    }
  }

  const answer = await offerAcceptance(await deps.viewOf(proposal), outcome, ctx.ui, ctx.signal === undefined ? {} : { signal: ctx.signal });
  if (ctx.signal?.aborted) return "declined";

  const prompt: PromptEvent = { format: OBSERVE_FORMAT, at: at(), type: "prompt", proposalId: proposal.id, stage: "b", answer };
  await deps.append([prompt]);

  switch (answer) {
    case "later":
    case "timeout":
      return "declined";
    case "reject":
      await deps.append([tombstone("user-rejected")]);
      return "rejected";
    case "accept": {
      const accepted = await deps.accept(proposal, outcome);
      if (accepted.ok) {
        await deps.append([tombstone("accepted")]);
        return "accepted";
      }
      ctx.ui.notify(`The lesson was not accepted (${accepted.error.reason}): ${accepted.error.detail}`, "warning");
      // The skill changed since the lesson was staged: this proposal can never be accepted, so it is closed (prompt (b) is not
      // asked again for it) and the pattern reopens on a newer observation.
      if (accepted.error.reason === "skill-drift") await deps.append([tombstone("stale")]);
      return "retryable";
    }
    default:
      return assertNever(answer);
  }
}
