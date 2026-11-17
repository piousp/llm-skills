import { betaUpperTail, decayedWeight } from "./beta.ts";
import {
  CUTOFF_DAYS,
  MAX_PROPOSALS_PER_WINDOW,
  PREPARE_BACKOFF_MS,
  PROPOSAL_WINDOW_MS,
  SNOOZE_MS,
  THRESHOLD,
  type JudgeFinding,
  type ObservationEvent,
  type ObserveState,
  type PatternView,
} from "./types.ts";

// A pattern is not stored: it is the set of observations that share a `patternId`. This module groups a finding into
// a pattern, folds the observations of a pattern into the posterior the threshold reads, and decides which patterns
// are worth a question to the user. It does arithmetic over ObserveState and does no I/O.

const DAY_MS = 24 * 60 * 60 * 1000;
const JACCARD_FLOOR = 0.5;
const NEW_PATTERN = "new";

// The blocks `PatternView.blockedBy` names. The first five are the threshold; the rest come from the history.
export const BLOCKED_BY = {
  mechanicalOnly: "mechanical-only",
  sessions: "sessions",
  days: "days",
  weight: "weight",
  posterior: "posterior",
  tombstone: "tombstone",
  snoozed: "snoozed",
  backoff: "backoff",
  rateLimit: "rate-limit",
} as const;

// ---------------------------------------------------------------------------------------------
// assignPattern
// ---------------------------------------------------------------------------------------------

export interface KnownPattern {
  id: string;
  typeTokens: readonly string[];
}

export function tokenSet(tokens: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const token of tokens) {
    const normalized = token.trim().toLowerCase();
    if (normalized !== "") set.add(normalized);
  }
  return set;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

// The pattern a finding belongs to: the one the judge named when it exists, else the best match on `typeTokens` at
// Jaccard >= 0.5 (a tie goes to the smaller id, so the answer does not depend on the order of the list), else "new".
export function assignPattern(finding: JudgeFinding, patterns: readonly KnownPattern[]): string {
  if (finding.patternRef !== NEW_PATTERN && patterns.some((pattern) => pattern.id === finding.patternRef)) {
    return finding.patternRef;
  }
  const tokens = tokenSet(finding.typeTokens);
  let best: { id: string; score: number } | null = null;
  for (const pattern of patterns) {
    const score = jaccard(tokens, tokenSet(pattern.typeTokens));
    if (score < JACCARD_FLOOR) continue;
    if (best === null || score > best.score || (score === best.score && pattern.id < best.id)) {
      best = { id: pattern.id, score };
    }
  }
  return best === null ? NEW_PATTERN : best.id;
}

// ---------------------------------------------------------------------------------------------
// patternViews
// ---------------------------------------------------------------------------------------------

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// The first clause of the threshold a view fails, or undefined when it passes them all. It reads the numbers of the
// view, so a view cannot claim a pass its numbers do not give.
function thresholdBlock(view: PatternView): string | undefined {
  if (view.mechanicalOnly) return BLOCKED_BY.mechanicalOnly;
  if (view.sessions < THRESHOLD.minSessions) return BLOCKED_BY.sessions;
  if (view.days < THRESHOLD.minDays) return BLOCKED_BY.days;
  if (view.weight < THRESHOLD.minWeight) return BLOCKED_BY.weight;
  if (view.pAbove < THRESHOLD.minPosterior) return BLOCKED_BY.posterior;
  return undefined;
}

interface Trial {
  at: number;
  // Σ raw weights of the pattern in this episode.
  weight: number;
}

// One view per pattern with at least one observation inside the cutoff. A trial is an episode: f = min(1, Σ weights
// of the pattern in it) successes and s = 1 - f failures, both decayed by the age of the episode (the start of the
// episode; an observation without an episode in the state is a trial of its own, dated by itself). A clean episode of
// the skill that holds no observation of the pattern is a failure of it, decayed the same way.
export function patternViews(state: ObserveState, now: Date): PatternView[] {
  const nowMs = now.getTime();
  const episodeStart = new Map<string, number>();
  for (const episode of state.episodes) episodeStart.set(episode.id, Date.parse(episode.startedAt));

  const byPattern = new Map<string, ObservationEvent[]>();
  for (const observation of state.observations) {
    const group = byPattern.get(observation.patternId);
    if (group === undefined) byPattern.set(observation.patternId, [observation]);
    else group.push(observation);
  }

  const ageDaysOf = (at: number) => (nowMs - at) / DAY_MS;
  const inWindow = (at: number) => Number.isFinite(at) && ageDaysOf(at) <= CUTOFF_DAYS;

  const views: PatternView[] = [];
  for (const [id, observations] of byPattern) {
    const trials = new Map<string, Trial>();
    const kept: ObservationEvent[] = [];
    let weight = 0;
    for (const observation of observations) {
      const key = observation.episodeId ?? `observation:${observation.id}`;
      const at =
        observation.episodeId !== null && episodeStart.has(observation.episodeId)
          ? (episodeStart.get(observation.episodeId) as number)
          : Date.parse(observation.at);
      if (!inWindow(at)) continue;
      kept.push(observation);
      weight += decayedWeight(observation.weight, ageDaysOf(at));
      const trial = trials.get(key);
      if (trial === undefined) trials.set(key, { at, weight: observation.weight });
      else trial.weight += observation.weight;
    }
    if (kept.length === 0) continue;

    const skill = kept[0].skill;
    let alpha = 1;
    let beta = 1;
    const days = new Set<string>();
    for (const trial of trials.values()) {
      const successes = Math.min(1, trial.weight);
      alpha += decayedWeight(successes, ageDaysOf(trial.at));
      beta += decayedWeight(1 - successes, ageDaysOf(trial.at));
      days.add(utcDay(trial.at));
    }
    for (const episode of state.episodes) {
      if (!episode.clean || episode.skill !== skill || trials.has(episode.id)) continue;
      const at = Date.parse(episode.startedAt);
      if (inWindow(at)) beta += decayedWeight(1, ageDaysOf(at));
    }

    const view: PatternView = {
      id,
      skill,
      observationIds: kept.map((observation) => observation.id),
      sessions: new Set(kept.map((observation) => observation.sessionId)).size,
      days: days.size,
      weight,
      alpha,
      beta,
      pAbove: betaUpperTail(THRESHOLD.rateFloor, alpha, beta),
      mechanicalOnly: kept.every((observation) => observation.source === "mechanical"),
      proposable: false,
    };
    const blockedBy = thresholdBlock(view);
    views.push(blockedBy === undefined ? { ...view, proposable: true } : { ...view, blockedBy });
  }
  return views.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// proposablePatterns
// ---------------------------------------------------------------------------------------------

function isRateLimited(state: ObserveState, nowMs: number): boolean {
  const recent = state.proposals.filter((proposal) => nowMs - Date.parse(proposal.at) < PROPOSAL_WINDOW_MS);
  return recent.length >= MAX_PROPOSALS_PER_WINDOW;
}

// Closed (rejected by the user or the gate, accepted, or stale): blocked until an observation of the pattern arrives after
// the latest tombstone. "After" is the time of the session the observation is about (its episode's start; its own `at`
// when it has none), not the moment the log learned of it: a session that ended before the tombstone and is read after
// it does not reopen the pattern.
function isTombstoned(view: PatternView, state: ObserveState): boolean {
  let latest = Number.NEGATIVE_INFINITY;
  for (const tombstone of state.tombstones) {
    if (tombstone.patternId === view.id) latest = Math.max(latest, Date.parse(tombstone.at));
  }
  if (latest === Number.NEGATIVE_INFINITY) return false;
  const ids = new Set(view.observationIds);
  const episodeStart = new Map(state.episodes.map((episode) => [episode.id, Date.parse(episode.startedAt)]));
  return !state.observations.some((observation) => {
    if (!ids.has(observation.id)) return false;
    const sessionTime = observation.episodeId === null ? undefined : episodeStart.get(observation.episodeId);
    return (sessionTime ?? Date.parse(observation.at)) > latest;
  });
}

// Put off ("later") or left unanswered ("timeout") within the last SNOOZE_MS, for a proposal of this pattern. A put-off
// older than the latest approval or acceptance of the pattern, or its latest tombstone, is superseded by it and no
// longer snoozes: the proposal it was about is settled.
function isSnoozed(view: PatternView, state: ObserveState, nowMs: number): boolean {
  const proposalIds = new Set(state.proposals.filter((proposal) => proposal.patternId === view.id).map((proposal) => proposal.id));
  let settledAt = Number.NEGATIVE_INFINITY;
  for (const prompt of state.prompts) {
    if (proposalIds.has(prompt.proposalId) && (prompt.answer === "approve" || prompt.answer === "accept")) {
      settledAt = Math.max(settledAt, Date.parse(prompt.at));
    }
  }
  for (const tombstone of state.tombstones) {
    if (tombstone.patternId === view.id) settledAt = Math.max(settledAt, Date.parse(tombstone.at));
  }
  return state.prompts.some((prompt) => {
    if (!proposalIds.has(prompt.proposalId) || (prompt.answer !== "later" && prompt.answer !== "timeout")) return false;
    const at = Date.parse(prompt.at);
    return at >= settledAt && nowMs - at < SNOOZE_MS;
  });
}

// A proposal that could not be prepared waits 24h after the first failure of the pattern, 72h after the second and 7d
// after the third or later, counted from the latest.
function isBackedOff(view: PatternView, state: ObserveState, nowMs: number): boolean {
  const failures = state.prepareFailures.filter((failure) => failure.patternId === view.id);
  if (failures.length === 0) return false;
  const latest = Math.max(...failures.map((failure) => Date.parse(failure.at)));
  return nowMs - latest < PREPARE_BACKOFF_MS[Math.min(failures.length, PREPARE_BACKOFF_MS.length) - 1]!;
}

// The views worth a question now, best first (posterior, then weight, then id). A view must pass the threshold on its
// numbers and then clear the history: tombstones, snoozes, the backoff of failed preparations, and one proposal per
// window in total. The caller tries them in order until one reaches a dialog.
export function proposablePatterns(views: readonly PatternView[], state: ObserveState, now: Date): PatternView[] {
  const nowMs = now.getTime();
  if (isRateLimited(state, nowMs)) return [];
  return views
    .filter((view) => thresholdBlock(view) === undefined && !isTombstoned(view, state) && !isSnoozed(view, state, nowMs) && !isBackedOff(view, state, nowMs))
    .map((view) => ({ ...view, proposable: true, blockedBy: undefined }))
    .sort((a, b) => b.pAbove - a.pAbove || b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
