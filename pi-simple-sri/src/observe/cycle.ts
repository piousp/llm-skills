import { labelingRecordOf, type LabelingRecord } from "./labeling.ts";
import { PROBATION_OUTCOME } from "./outcome.ts";
import {
  OBSERVE_FORMAT,
  MAX_GATE_RESTAGINGS,
  MAX_PREPARE_FAILED_REASON_CHARS,
  MAX_SUMMARY_CHARS,
  MIN_IDLE_MS,
  PENDING_TO_PROBATION_DAYS,
  SOURCE_WEIGHTS,
  observeId,
  type Episode,
  type EpisodeEvent,
  type GateKind,
  type GateOutcomeClass,
  type JudgeFinding,
  type JudgedOutcome,
  type ObservationEvent,
  type ObserveConfig,
  type ObserveCursor,
  type ObserveEvent,
  type ObserveState,
  type PatternView,
  type PrefilterResult,
  type PromptAnswer,
  type PromptStage,
  type Provenance,
  type ProposalEvent,
  type CursorEntry,
  type SessionFileRef,
  type SessionRead,
  type TombstoneReason,
} from "./types.ts";
import type { Result } from "../types.ts";
import { cutCodePoints, toErrorMessage } from "../values.ts";

// The sequencing of one observer cycle: ingest the stored sessions, take the proposable patterns in order until one
// reaches a dialog, prepare its proposal, ask the user, run the gate, ask again. It does no I/O of its own: every collaborator arrives in
// CycleDeps, and src/observe/wire.ts binds the real ones. The cycle never reloads and never accepts a lesson: the
// user's acceptance is the command `--review`, dispatched at the end.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SAMPLE_SIZE = 30;

export type CycleMode = "background" | "scan" | "dry-run";

export interface CycleInput {
  mode: CycleMode;
  config: ObserveConfig;
  now: Date;
  // The session that is running: never read, its episodes are not finished.
  currentSessionFile: string | null;
  // The cwd of the session; the preferred cwd of a bank.
  ctxCwd: string;
  // YYYY-MM-DD: episodes that started earlier are ignored.
  since?: string;
  // Dry-run only: how many episodes are judged.
  sampleSize?: number;
  signal?: AbortSignal;
}

// What the judge answered for one episode (the wiring adapts the judge of src/observe/judge.ts to it).
export interface CycleVerdict {
  outcome: JudgedOutcome;
  model: string;
  findings: JudgeFinding[];
  reason?: string;
}

export interface CostEstimate {
  calls: number;
  inTokens: number;
  outTokens: number;
  usd: number | null;
}

// What the bank selection hands to the generator; `episodes` is opaque to the cycle.
export interface BankSelection {
  cwd: string;
  episodes: readonly unknown[];
}

export type BankSelectionResult = { kind: "ready"; selection: BankSelection } | { kind: "pending"; reason: string };

export interface ProposalDraft {
  stagingPath: string;
  candidateHash: string;
  // SHA-256 digest ("sha256:<hex>") of SKILL.md at staging.
  skillContentHash: string;
}

export interface GateOutcomeView {
  class: GateOutcomeClass;
  status: string;
  reason: string | null;
}

// What the dialogs show. The texts are the wiring's: the cycle only decides when each one is asked.
export interface ProposalOffer {
  view: PatternView;
  proposal: ProposalEvent;
}

export interface AcceptanceOffer extends ProposalOffer {
  outcome: GateOutcomeView;
}

export type AnswerA = Extract<PromptAnswer, "approve" | "reject" | "later" | "timeout">;
export type AnswerB = Extract<PromptAnswer, "accept" | "later" | "reject" | "timeout">;

export interface CycleStore {
  readEvents(): Promise<ObserveEvent[]>;
  append(events: ObserveEvent[]): Promise<void>;
  readCursor(): Promise<ObserveCursor>;
  writeCursor(cursor: ObserveCursor): Promise<void>;
  // The scan lock: the gate and the dialogs never run under it.
  withLock<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<Result<T, "locked">>;
}

export interface CycleDeps {
  store: CycleStore;
  fold(events: readonly ObserveEvent[], now: Date): ObserveState;
  listSessions(): Promise<SessionFileRef[]>;
  planScan(
    files: readonly SessionFileRef[],
    cursor: ObserveCursor,
    options: { now: Date; currentSessionFile: string | null; minIdleMs: number },
  ): { read: SessionFileRef[] };
  readSession(path: string): Promise<Result<SessionRead, string>>;
  segment(read: SessionRead, ref: SessionFileRef): Episode[];
  prefilter(episode: Episode, read: SessionRead): PrefilterResult;
  // false: the recorded provider differs from the judge's and the model is not pinned (D2).
  providerOk(episode: Episode): boolean;
  judge(input: { episode: Episode; read: SessionRead; state: ObserveState }, signal?: AbortSignal): Promise<CycleVerdict>;
  // The id of the existing pattern a finding belongs to, null when it is a new one.
  assignPattern(finding: Pick<JudgeFinding, "patternRef" | "typeTokens">, state: ObserveState, skill: string): string | null;
  redact(text: string): string;
  cursorEntryOf(ref: SessionFileRef, read: SessionRead): CursorEntry;
  estimateCost(episodes: readonly Episode[]): CostEstimate;
  confirmDryRun(estimate: CostEstimate): Promise<boolean>;
  // Writes <labelingDir>/<fileName> privately.
  writeLabeling(fileName: string, text: string): Promise<void>;
  proposable(state: ObserveState, now: Date): PatternView[];
  // The staged record of the proposal says the lesson is already in the skill.
  isAccepted(proposal: ProposalEvent): Promise<boolean>;
  bank: {
    // An existing bank of the skill: user's or shipped by the skill.
    resolve(skill: string): Promise<{ path: string; provenance: Provenance } | null>;
    select(view: PatternView, state: ObserveState, ctxCwd: string): Promise<BankSelectionResult>;
    // Generates the draft in staging, before the lesson exists; returns the draft path.
    generate(input: { skill: string; view: PatternView; selection: BankSelection }, signal?: AbortSignal): Promise<Result<string, string>>;
    // Writes the approved draft to banks/ and returns the final path; throws on a conflict.
    promote(draftPath: string, skill: string): Promise<string>;
  };
  propose(
    input: { view: PatternView; state: ObserveState; gate: GateKind; bankPath: string | null },
    signal?: AbortSignal,
  ): Promise<Result<ProposalDraft, string>>;
  runGate(input: { proposal: ProposalEvent; bankPath: string | null }, signal?: AbortSignal): Promise<GateOutcomeView>;
  // The user forgot the skill while a proposal was being prepared: erases what the cycle already made for it (the draft
  // bank, the staged candidate, a promoted auto bank), with the same helpers `--forget` uses.
  discardArtifacts(skill: string): Promise<void>;
  offerA(offer: ProposalOffer, signal?: AbortSignal): Promise<AnswerA>;
  offerB(offer: AcceptanceOffer, signal?: AbortSignal): Promise<AnswerB>;
  // Fire and forget: `/skill-improve --review <id>`.
  dispatchReview(proposalId: string): void;
}

export type ProposalStep =
  | "none"
  | "pending"
  | "failed"
  | "later"
  | "rejected"
  | "gate-rejected"
  | "gate-retryable"
  | "awaiting-review"
  | "review-dispatched";

export interface CycleReport {
  mode: CycleMode;
  status: "done" | "disabled" | "locked" | "declined" | "interrupted";
  files: number;
  episodes: number;
  judgeCalls: number;
  observations: number;
  // Files and episodes left for the next cycle: unreadable, provider mismatch, no budget.
  blocked: number;
  proposal: ProposalStep;
  proposalId: string | null;
  labeling: { file: string; records: number } | null;
  // Skills whose artifacts could not be discarded after a forget (the lock or the disk failed): the cycle went on.
  discardFailed: string[];
}

interface IngestStats {
  files: number;
  episodes: number;
  judgeCalls: number;
  observations: number;
  blocked: number;
}

function emptyReport(mode: CycleMode, status: CycleReport["status"]): CycleReport {
  return {
    mode,
    status,
    files: 0,
    episodes: 0,
    judgeCalls: 0,
    observations: 0,
    blocked: 0,
    proposal: "none",
    proposalId: null,
    labeling: null,
    discardFailed: [],
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function sinceMs(since: string | undefined): number | null {
  if (since === undefined) return null;
  const parsed = Date.parse(since);
  return Number.isNaN(parsed) ? null : parsed;
}

function startedAtOrAfter(episode: Episode, floorMs: number | null): boolean {
  return floorMs === null || Date.parse(episode.startedAt) >= floorMs;
}

export async function runObserveCycle(input: CycleInput, deps: CycleDeps): Promise<CycleReport> {
  if (input.mode === "dry-run") return runDryRun(input, deps);
  if (!input.config.enabled) return emptyReport(input.mode, "disabled");

  const ingested = await deps.store.withLock((lockSignal) =>
    ingestSessions(input, deps, input.signal ? AbortSignal.any([input.signal, lockSignal]) : lockSignal),
  );
  if (!ingested.ok) return emptyReport(input.mode, "locked");
  const report: CycleReport = { ...emptyReport(input.mode, "done"), ...ingested.value };
  if (isAborted(input.signal)) return { ...report, status: "interrupted" };

  const discardFailed: string[] = [];
  const offered = await offerOne(input, deps, discardFailed);
  const interrupted = isAborted(input.signal);
  return { ...report, status: interrupted ? "interrupted" : "done", proposal: offered.step, proposalId: offered.proposalId, discardFailed };
}

// ---------------------------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------------------------

function uniqueKinds(result: PrefilterResult): EpisodeEvent["flags"] {
  return [...new Set(result.flags.map((flag) => flag.kind))];
}

function summaryOf(deps: CycleDeps, text: string): string {
  return cutCodePoints(deps.redact(text), MAX_SUMMARY_CHARS);
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

async function judgeSafely(deps: CycleDeps, episode: Episode, read: SessionRead, state: ObserveState, signal?: AbortSignal): Promise<CycleVerdict> {
  try {
    return await deps.judge({ episode, read, state }, signal);
  } catch (error) {
    return { outcome: "failed", model: "unknown", findings: [], reason: toErrorMessage(error) };
  }
}

function judgedEventOf(episode: Episode, verdict: CycleVerdict, at: string): ObserveEvent {
  return {
    format: OBSERVE_FORMAT,
    type: "judged",
    at,
    episodeId: episode.id,
    model: verdict.model,
    outcome: verdict.outcome,
    ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
  };
}

async function ingestSessions(input: CycleInput, deps: CycleDeps, signal: AbortSignal): Promise<IngestStats> {
  const stats: IngestStats = { files: 0, episodes: 0, judgeCalls: 0, observations: 0, blocked: 0 };
  const at = input.now.toISOString();
  const known = await deps.store.readEvents();
  let state = deps.fold(known, input.now);

  let optInAt = state.optInAt;
  if (optInAt === null) {
    const optIn: ObserveEvent = { format: OBSERVE_FORMAT, type: "opt-in", at };
    await deps.store.append([optIn]);
    known.push(optIn);
    state = deps.fold(known, input.now);
    optInAt = at;
  }
  const optInMs = Date.parse(optInAt);
  const floorMs = sinceMs(input.since);

  const usedToday = state.judged.filter(
    (judged) => judged.outcome !== "skipped" && Date.parse(judged.at) > input.now.getTime() - DAY_MS,
  ).length;
  let budgetLeft = input.config.judgeCallsPerDay - usedToday;

  const cursor = await deps.store.readCursor();
  const plan = deps.planScan(await deps.listSessions(), cursor, {
    now: input.now,
    currentSessionFile: input.currentSessionFile,
    minIdleMs: MIN_IDLE_MS,
  });
  const seenObservations = new Set(state.observations.map((observation) => observation.id));
  // id -> where the stored episode ended: a session that grew past it is processed again.
  const storedEnds = new Map(state.episodes.map((episode) => [episode.id, episode.endEntryId]));

  for (const ref of plan.read) {
    if (isAborted(signal)) break;
    const read = await deps.readSession(ref.path);
    if (!read.ok) {
      stats.blocked += 1;
      continue;
    }
    stats.files += 1;
    const fileEvents: ObserveEvent[] = [];
    let settled = true;
    const remember = (event: ObserveEvent): void => {
      fileEvents.push(event);
      known.push(event);
    };

    for (const episode of deps.segment(read.value, ref)) {
      if (storedEnds.get(episode.id) === episode.endEntryId) continue;
      if (Date.parse(episode.startedAt) < optInMs || !startedAtOrAfter(episode, floorMs)) continue;
      // What the user made the observer forget is not read again, whichever file it comes back in.
      const forgotAt = state.forgets[episode.skill];
      if (forgotAt !== undefined && Date.parse(episode.startedAt) <= Date.parse(forgotAt)) continue;

      const prefiltered = deps.prefilter(episode, read.value);
      let verdict: CycleVerdict | null = null;
      if (prefiltered.needsJudge) {
        if (!deps.providerOk(episode) || budgetLeft <= 0) {
          stats.blocked += 1;
          settled = false;
          continue;
        }
        budgetLeft -= 1;
        stats.judgeCalls += 1;
        verdict = await judgeSafely(deps, episode, read.value, state, signal);
        if (isAborted(signal)) {
          settled = false;
          break;
        }
        // A judgement that did not happen does not consume the episode: it is judged again at a later start. A failed
        // call was made and counts against the budget; a skipped one never was.
        if (verdict.outcome === "failed" || verdict.outcome === "skipped") {
          if (verdict.outcome === "failed") remember(judgedEventOf(episode, verdict, at));
          stats.blocked += 1;
          settled = false;
          continue;
        }
      }

      const findings: { source: ObservationEvent["source"]; finding: JudgeFinding }[] = [];
      if (verdict?.outcome === "findings") {
        for (const finding of verdict.findings) findings.push({ source: "judge", finding });
      }
      for (const flag of prefiltered.flags) {
        if (flag.kind === "correction") continue;
        findings.push({
          source: "mechanical",
          finding: { kind: flag.kind, summary: flag.detail, confidence: 1, anchorEntryId: flag.anchorEntryId, patternRef: "new", typeTokens: [flag.kind] },
        });
      }

      const observations: ObservationEvent[] = [];
      for (const { source, finding } of findings) {
        const id = observeId("ob", [source, episode.id, finding.anchorEntryId, finding.kind]);
        if (seenObservations.has(id)) continue;
        seenObservations.add(id);
        const existing = deps.assignPattern(finding, state, episode.skill);
        const confidence = source === "judge" ? clampUnit(finding.confidence) : null;
        const observation: ObservationEvent = {
          format: OBSERVE_FORMAT,
          type: "observation",
          at,
          id,
          episodeId: episode.id,
          sessionId: episode.sessionId,
          skill: episode.skill,
          source,
          kind: finding.kind,
          summary: summaryOf(deps, finding.summary),
          confidence,
          weight: source === "judge" ? SOURCE_WEIGHTS.judge * (confidence ?? 0) : SOURCE_WEIGHTS[source],
          anchorEntryId: finding.anchorEntryId,
          patternId: existing ?? observeId("pt", [episode.skill, id]),
        };
        observations.push(observation);
        // The next finding of the episode may belong to the pattern this one opened.
        state = deps.fold([...known, ...observations], input.now);
      }

      // Clean also means nothing was found in an earlier pass over the same episode.
      const foundBefore = known.some((event) => event.type === "observation" && event.episodeId === episode.id);
      const episodeEvent: EpisodeEvent = {
        format: OBSERVE_FORMAT,
        type: "episode",
        at,
        ...episode,
        flags: uniqueKinds(prefiltered),
        clean: observations.length === 0 && !foundBefore,
      };
      // Order in the file: the episode first, then what was found in it.
      remember(episodeEvent);
      if (verdict) remember(judgedEventOf(episode, verdict, at));
      for (const observation of observations) remember(observation);
      stats.episodes += 1;
      stats.observations += observations.length;
      storedEnds.set(episode.id, episode.endEntryId);
      state = deps.fold(known, input.now);
    }

    if (fileEvents.length > 0) await deps.store.append(fileEvents);
    if (settled && !isAborted(signal)) {
      cursor.files[ref.headerId] = deps.cursorEntryOf(ref, read.value);
      await deps.store.writeCursor(cursor);
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------------------------
// Select, prepare, offer
// ---------------------------------------------------------------------------------------------

interface OfferResult {
  step: ProposalStep;
  proposalId: string | null;
}

// The newest of the events, by `at` (the later one in the list on a tie): the one every reader of a history takes.
export function latestBy<T extends { at: string }>(items: readonly T[]): T | undefined {
  return items.reduce<T | undefined>((latest, item) => (latest === undefined || item.at >= latest.at ? item : latest), undefined);
}

function latestProposalOf(state: ObserveState, patternId: string): ProposalEvent | undefined {
  return latestBy(state.proposals.filter((proposal) => proposal.patternId === patternId));
}

// The live proposals: the latest of each pattern. An earlier one was replaced by a restaging and is never gated or
// offered again.
export function latestProposals(state: ObserveState): ProposalEvent[] {
  const patterns = new Set(state.proposals.map((proposal) => proposal.patternId));
  return [...patterns].flatMap((patternId) => latestProposalOf(state, patternId) ?? []);
}

// A staged proposal is offered again, not generated again, until the gate or the user rejected it.
function reusableProposal(state: ObserveState, latest: ProposalEvent | undefined): ProposalEvent | null {
  if (latest === undefined) return null;
  if (state.tombstones.some((tombstone) => tombstone.candidateHash === latest.candidateHash)) return null;
  const outcome = latestBy(state.gateOutcomes.filter((candidate) => candidate.proposalId === latest.id));
  return outcome?.class === "rejected" ? null : latest;
}

function firstObservedMs(state: ObserveState, view: PatternView): number {
  const ids = new Set(view.observationIds);
  const times = state.observations.filter((observation) => ids.has(observation.id)).map((observation) => Date.parse(observation.at));
  return times.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...times);
}

// The retryable gate answers the pattern has had, over all its proposals.
function retryableGatesOf(state: ObserveState, patternId: string): number {
  const ids = new Set(state.proposals.filter((proposal) => proposal.patternId === patternId).map((proposal) => proposal.id));
  return state.gateOutcomes.filter((outcome) => outcome.class === "retryable" && ids.has(outcome.proposalId)).length;
}

// The proposable patterns in order, until one reaches a dialog. A pattern whose proposal could not be prepared, or whose
// lesson is already in the skill, does not hold back the next one.
async function offerOne(input: CycleInput, deps: CycleDeps, discardFailed: string[]): Promise<OfferResult> {
  const state = deps.fold(await deps.store.readEvents(), input.now);
  let unprepared: OfferResult | null = null;
  for (const view of deps.proposable(state, input.now)) {
    const result = await offerView(input, deps, state, view, discardFailed);
    if (result.proposalId !== null || isAborted(input.signal)) return result;
    if (unprepared === null && result.step !== "none") unprepared = result;
  }
  return unprepared ?? { step: "none", proposalId: null };
}

async function offerView(input: CycleInput, deps: CycleDeps, state: ObserveState, view: PatternView, discardFailed: string[]): Promise<OfferResult> {
  const { signal, now } = input;
  const at = now.toISOString();
  const emit = (event: ObserveEvent): Promise<void> => deps.store.append([event]);

  const tombstone = (proposal: ProposalEvent, reason: TombstoneReason): Promise<void> =>
    emit({ format: OBSERVE_FORMAT, type: "tombstone", at, patternId: proposal.patternId, skill: proposal.skill, reason, candidateHash: proposal.candidateHash });
  const prompt = (proposal: ProposalEvent, stage: PromptStage, answer: PromptAnswer): Promise<void> =>
    emit({ format: OBSERVE_FORMAT, type: "prompt", at, proposalId: proposal.id, stage, answer });
  const prepareFailed = (subject: Pick<PatternView, "id" | "skill">, reason: string): Promise<void> =>
    emit({
      format: OBSERVE_FORMAT,
      type: "prepare-failed",
      at,
      skill: subject.skill,
      patternId: subject.id,
      reason: cutCodePoints(deps.redact(reason), MAX_PREPARE_FAILED_REASON_CHARS),
    });

  // The user may have forgotten the skill after the fold this cycle started from, and again during any await below: each
  // await is followed by this check, and the artifacts made so far are erased.
  const forgotten = async (): Promise<boolean> => {
    const forgotAt = deps.fold(await deps.store.readEvents(), now).forgets[view.skill];
    if (forgotAt === undefined || Date.parse(forgotAt) < now.getTime()) return false;
    try {
      await deps.discardArtifacts(view.skill);
    } catch {
      if (!discardFailed.includes(view.skill)) discardFailed.push(view.skill);
    }
    return true;
  };
  const none: OfferResult = { step: "none", proposalId: null };
  if (await forgotten()) return none;

  const latest = latestProposalOf(state, view.id);
  // The lesson is in the skill already: the pattern closes until an observation arrives after it, and the next one is tried.
  const decided = latest !== undefined && state.tombstones.some((candidate) => candidate.candidateHash === latest.candidateHash);
  if (latest !== undefined && !decided && (await deps.isAccepted(latest))) {
    await tombstone(latest, "accepted");
    return { step: "none", proposalId: null };
  }

  let proposal = reusableProposal(state, latest);
  let probationOnly = false;
  const reused = proposal;
  if (reused !== null && latestBy(state.gateOutcomes.filter((candidate) => candidate.proposalId === reused.id))?.class === "retryable") {
    // A concluded record is not gated again, so a retryable answer is not retried on the same candidate: a fresh one is
    // staged, twice at most, and then the lesson goes to probation.
    probationOnly = retryableGatesOf(state, view.id) > MAX_GATE_RESTAGINGS;
    proposal = null;
  }
  if (proposal === null) {
    const prepared = await prepareProposal(input, deps, state, view, probationOnly, forgotten);
    if (!("proposal" in prepared)) {
      if (prepared.reason !== null && !isAborted(signal)) await prepareFailed(view, prepared.reason);
      return { step: prepared.step, proposalId: null };
    }
    proposal = prepared.proposal;
    if (await forgotten()) return none;
    await emit(proposal);
  }
  if (isAborted(signal)) return { step: "none", proposalId: proposal.id };
  const proposalId = proposal.id;
  const offer: ProposalOffer = { view, proposal };

  let outcome: GateOutcomeView | undefined = latestBy(state.gateOutcomes.filter((candidate) => candidate.proposalId === proposalId));
  if (outcome === undefined) {
    // The setting may have changed since the proposal was staged: a skill the user no longer allows is not replayed, so the
    // user is not asked about a gate that cannot run and nothing is promoted. The answer is retryable: the next start stages
    // a fresh candidate, now a probation one.
    if (proposal.gate === "bank" && !input.config.replayAllow.includes(proposal.skill)) {
      await emit({ format: OBSERVE_FORMAT, type: "gate-outcome", at, proposalId, class: "retryable", status: "refused", reason: "replay-not-allowed" });
      return { step: "gate-retryable", proposalId };
    }
    const approved = state.prompts.some((candidate) => candidate.proposalId === proposalId && candidate.stage === "a" && candidate.answer === "approve");
    if (!approved) {
      if (await forgotten()) return none;
      const answer = await deps.offerA(offer, signal);
      if (isAborted(signal)) return { step: "none", proposalId };
      if (await forgotten()) return none;
      await prompt(proposal, "a", answer);
      if (answer === "reject") {
        await tombstone(proposal, "user-rejected");
        return { step: "rejected", proposalId };
      }
      if (answer !== "approve") return { step: "later", proposalId };
    }

    let bankPath = proposal.bankPath;
    if (proposal.provenance === "auto" && proposal.bankPath !== null) {
      if (await forgotten()) return none;
      try {
        bankPath = await deps.bank.promote(proposal.bankPath, proposal.skill);
      } catch (error) {
        // A conflict does not mend itself at the next start: the pattern waits out its backoff instead of throwing each time.
        await prepareFailed(view, `bank promotion failed: ${toErrorMessage(error)}`);
        return { step: "failed", proposalId };
      }
    }
    if (await forgotten()) return none;
    outcome = proposal.gate === "probation" ? PROBATION_OUTCOME : await deps.runGate({ proposal, bankPath }, signal);
    if (await forgotten()) return none;
    await emit({ format: OBSERVE_FORMAT, type: "gate-outcome", at, proposalId, class: outcome.class, status: outcome.status, reason: outcome.reason });
    if (outcome.class === "rejected") {
      await tombstone(proposal, "gate-rejected");
      return { step: "gate-rejected", proposalId };
    }
    if (outcome.class === "retryable") return { step: "gate-retryable", proposalId };
    if (isAborted(signal)) return { step: "none", proposalId };
  }

  if (await forgotten()) return none;
  const answerB = await deps.offerB({ ...offer, outcome }, signal);
  if (isAborted(signal)) return { step: "none", proposalId };
  if (await forgotten()) return none;
  await prompt(proposal, "b", answerB);
  if (answerB === "accept") {
    deps.dispatchReview(proposalId);
    return { step: "review-dispatched", proposalId };
  }
  if (answerB === "reject") {
    await tombstone(proposal, "user-rejected");
    return { step: "rejected", proposalId };
  }
  return { step: "awaiting-review", proposalId };
}

async function prepareProposal(
  input: CycleInput,
  deps: CycleDeps,
  state: ObserveState,
  view: PatternView,
  probationOnly: boolean,
  forgotten: () => Promise<boolean>,
): Promise<{ proposal: ProposalEvent } | { step: ProposalStep; reason: string | null }> {
  const { signal, now, ctxCwd } = input;
  let gate: GateKind = "probation";
  let bankPath: string | null = null;
  let provenance: Provenance | null = null;
  let cwd = ctxCwd;

  // Nothing replays unless the user allowed the skill (D1).
  if (!probationOnly && input.config.replayAllow.includes(view.skill)) {
    let existing: Awaited<ReturnType<CycleDeps["bank"]["resolve"]>>;
    try {
      existing = await deps.bank.resolve(view.skill);
    } catch (error) {
      // A bank that exists and cannot be used is neither "no bank" (nothing is generated over it) nor a reason to stop the
      // cycle: this pattern waits out its backoff and the next one is tried.
      return { step: "failed", reason: toErrorMessage(error) };
    }
    if (existing) {
      gate = "bank";
      bankPath = existing.path;
      provenance = existing.provenance;
    } else {
      const selected = await deps.bank.select(view, state, ctxCwd);
      if (isAborted(signal) || (await forgotten())) return { step: "none", reason: null };
      if (selected.kind === "ready") {
        const generated = await deps.bank.generate({ skill: view.skill, view, selection: selected.selection }, signal);
        if (isAborted(signal) || (await forgotten())) return { step: "none", reason: null };
        if (!generated.ok) return { step: "failed", reason: `bank generation failed: ${generated.error}` };
        gate = "bank";
        bankPath = generated.value;
        provenance = "auto";
        cwd = selected.selection.cwd;
      } else if ((now.getTime() - firstObservedMs(state, view)) / DAY_MS < PENDING_TO_PROBATION_DAYS) {
        return { step: "pending", reason: `bank pending: ${selected.reason}` };
      }
    }
  }

  const drafted = await deps.propose({ view, state, gate, bankPath }, signal);
  if (isAborted(signal) || (await forgotten())) return { step: "none", reason: null };
  if (!drafted.ok) return { step: "failed", reason: `proposal refused: ${drafted.error}` };
  // The same candidate the user or the gate already decided on is not offered again (Q4).
  if (state.tombstones.some((tombstone) => tombstone.candidateHash === drafted.value.candidateHash)) {
    return { step: "failed", reason: "the candidate was already decided on" };
  }

  return {
    proposal: {
      format: OBSERVE_FORMAT,
      type: "proposal",
      at: now.toISOString(),
      id: observeId("pr", [view.id, drafted.value.candidateHash, drafted.value.stagingPath]),
      patternId: view.id,
      skill: view.skill,
      stagingPath: drafted.value.stagingPath,
      candidateHash: drafted.value.candidateHash,
      gate,
      bankPath,
      provenance,
      cwd,
      skillContentHash: drafted.value.skillContentHash,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Dry-run: measures the prefilter and the judge on real sessions and writes nothing to the store.
// ---------------------------------------------------------------------------------------------

interface Candidate {
  ref: SessionFileRef;
  episode: Episode;
  flagged: boolean;
}

function stampOf(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function runDryRun(input: CycleInput, deps: CycleDeps): Promise<CycleReport> {
  const { signal, now } = input;
  const report = emptyReport("dry-run", "done");
  const floorMs = sinceMs(input.since);
  // No cursor: every session is a candidate, as the first scan after opting in would see them.
  const plan = deps.planScan(await deps.listSessions(), { files: {} }, { now, currentSessionFile: input.currentSessionFile, minIdleMs: MIN_IDLE_MS });

  const candidates: Candidate[] = [];
  for (const ref of plan.read) {
    if (isAborted(signal)) return { ...report, status: "interrupted" };
    const read = await deps.readSession(ref.path);
    if (!read.ok) {
      report.blocked += 1;
      continue;
    }
    report.files += 1;
    for (const episode of deps.segment(read.value, ref)) {
      if (!startedAtOrAfter(episode, floorMs)) continue;
      if (!deps.providerOk(episode)) {
        report.blocked += 1;
        continue;
      }
      candidates.push({ ref, episode, flagged: deps.prefilter(episode, read.value).flags.length > 0 });
    }
  }

  const sample = candidates
    .sort((left, right) => right.episode.startedAt.localeCompare(left.episode.startedAt))
    .slice(0, input.sampleSize ?? DEFAULT_SAMPLE_SIZE);
  if (sample.length === 0) return report;

  if (!(await deps.confirmDryRun(deps.estimateCost(sample.map((candidate) => candidate.episode))))) {
    return { ...report, status: "declined" };
  }

  const state = deps.fold([], now);
  const records: LabelingRecord[] = [];
  const byFile = new Map<string, Candidate[]>();
  for (const candidate of sample) byFile.set(candidate.ref.path, [...(byFile.get(candidate.ref.path) ?? []), candidate]);

  for (const group of byFile.values()) {
    if (isAborted(signal)) return { ...report, status: "interrupted" };
    const read = await deps.readSession(group[0]!.ref.path);
    if (!read.ok) {
      report.blocked += group.length;
      continue;
    }
    for (const { episode, flagged } of group) {
      const verdict = await judgeSafely(deps, episode, read.value, state, signal);
      if (isAborted(signal)) return { ...report, status: "interrupted" };
      report.judgeCalls += 1;
      // A failed or skipped judgement says nothing about the judge: it is left out of the scores.
      if (verdict.outcome === "failed" || verdict.outcome === "skipped") {
        report.blocked += 1;
        continue;
      }
      records.push(labelingRecordOf(episode, flagged, verdict.findings.length > 0));
      report.episodes += 1;
    }
  }

  if (records.length === 0) return report;
  const file = `${stampOf(now)}.jsonl`;
  await deps.writeLabeling(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return { ...report, labeling: { file, records: records.length } };
}
