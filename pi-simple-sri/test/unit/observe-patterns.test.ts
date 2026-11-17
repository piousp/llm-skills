import { test } from "node:test";
import assert from "node:assert/strict";
import { assignPattern, patternViews, proposablePatterns } from "../../src/observe/patterns.ts";
import { foldObserveState } from "../../src/observe/store.ts";
import {
  OBSERVE_FORMAT,
  type EpisodeEvent,
  type JudgeFinding,
  type ObservationEvent,
  type ObservationSource,
  type ObserveState,
  type PatternView,
  type PrepareFailedEvent,
  type PromptEvent,
  type ProposalEvent,
  type TombstoneEvent,
} from "../../src/observe/types.ts";

// The grouping of observations into patterns and the rule that decides which one is worth a question. Every state is
// built by hand: the module is arithmetic over ObserveState, and a store on disk would prove src/observe/store.ts
// again. The numbers in the comments are closed forms (see observe-beta.test.ts), not outputs of the code.

const NOW = new Date("2026-11-16T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SKILL = "pdf-tools";
const OTHER_SKILL = "mde-pending-reviews";

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

function daysAgo(days: number): string {
  return ago(days * DAY_MS);
}

function episode(id: string, options: { sessionId?: string; startedAt?: string; skill?: string; clean?: boolean } = {}): EpisodeEvent {
  return {
    format: OBSERVE_FORMAT,
    type: "episode",
    at: options.startedAt ?? daysAgo(1),
    id,
    skill: options.skill ?? SKILL,
    sessionId: options.sessionId ?? `session-${id}`,
    sessionFile: `/sessions/${id}.jsonl`,
    cwd: "/work/proj-a",
    startEntryId: `${id}-start`,
    endEntryId: `${id}-end`,
    anchorEntryIds: [`${id}-start`],
    startedAt: options.startedAt ?? daysAgo(1),
    attribution: "explicit",
    providers: ["anthropic"],
    flags: [],
    clean: options.clean ?? false,
  };
}

interface ObservationOptions {
  episodeId?: string | null;
  sessionId?: string;
  source?: ObservationSource;
  weight?: number;
  at?: string;
  skill?: string;
}

function observation(id: string, patternId: string, options: ObservationOptions = {}): ObservationEvent {
  const source = options.source ?? "user-note";
  return {
    format: OBSERVE_FORMAT,
    type: "observation",
    at: options.at ?? daysAgo(1),
    id,
    episodeId: options.episodeId === undefined ? `ep-${id}` : options.episodeId,
    sessionId: options.sessionId ?? `session-${id}`,
    skill: options.skill ?? SKILL,
    source,
    kind: "correction",
    summary: "the user asked for the table to be left out",
    confidence: null,
    weight: options.weight ?? (source === "user-note" ? 1 : source === "mechanical" ? 0.3 : 0.5),
    anchorEntryId: `${id}-anchor`,
    patternId,
  };
}

function stateOf(parts: Partial<ObserveState> = {}): ObserveState {
  return {
    optInAt: daysAgo(30),
    episodes: [],
    judged: [],
    observations: [],
    proposals: [],
    prepareFailures: [],
    prompts: [],
    gateOutcomes: [],
    tombstones: [],
    forgets: {},
    ...parts,
  };
}

// One observation per episode, one episode per session, each on its own day: the minimal shape that crosses the
// threshold with two user notes (Σ weight ≈ 2, Beta(≈3, 1): P(rate > 0.15) ≈ 0.996).
function passingPattern(patternId = "pt-1", prefix = "a"): { episodes: EpisodeEvent[]; observations: ObservationEvent[] } {
  const early = episode(`${prefix}1`, { startedAt: daysAgo(3) });
  const late = episode(`${prefix}2`, { startedAt: daysAgo(1) });
  return {
    episodes: [early, late],
    observations: [
      observation(`${prefix}1`, patternId, { episodeId: early.id, sessionId: early.sessionId, at: early.startedAt }),
      observation(`${prefix}2`, patternId, { episodeId: late.id, sessionId: late.sessionId, at: late.startedAt }),
    ],
  };
}

function statePassing(extra: Partial<ObserveState> = {}): ObserveState {
  const { episodes, observations } = passingPattern();
  return stateOf({ episodes, observations, ...extra });
}

function proposalEvent(id: string, patternId: string, at: string): ProposalEvent {
  return {
    format: OBSERVE_FORMAT,
    type: "proposal",
    at,
    id,
    patternId,
    skill: SKILL,
    stagingPath: `staging/${SKILL}/x`,
    candidateHash: "sha256:" + "a".repeat(64),
    gate: "probation",
    bankPath: null,
    provenance: null,
    cwd: "/work/proj-a",
    skillContentHash: "b".repeat(64),
  };
}

function prepareFailedEvent(patternId: string, at: string): PrepareFailedEvent {
  return { format: OBSERVE_FORMAT, type: "prepare-failed", at, skill: SKILL, patternId, reason: "bank pending" };
}

function promptEvent(proposalId: string, answer: PromptEvent["answer"], at: string): PromptEvent {
  return { format: OBSERVE_FORMAT, type: "prompt", at, proposalId, stage: "a", answer };
}

function tombstoneEvent(patternId: string, at: string, reason: TombstoneEvent["reason"] = "gate-rejected"): TombstoneEvent {
  return { format: OBSERVE_FORMAT, type: "tombstone", at, patternId, skill: SKILL, reason, candidateHash: null };
}

function viewOf(state: ObserveState, patternId = "pt-1"): PatternView {
  const view = patternViews(state, NOW).find((candidate) => candidate.id === patternId);
  assert.ok(view, `no view for ${patternId}`);
  return view;
}

function proposableIds(state: ObserveState): string[] {
  return proposablePatterns(patternViews(state, NOW), state, NOW).map((view) => view.id);
}

function assertClose(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${expected}, got ${actual}`);
}

// ---------------------------------------------------------------------------------------------------------------
// assignPattern
// ---------------------------------------------------------------------------------------------------------------

function finding(patternRef: string, typeTokens: string[]): JudgeFinding {
  return { kind: "correction", summary: "s", confidence: 0.9, anchorEntryId: "e1", patternRef, typeTokens };
}

const EXISTING = [
  { id: "pt-aaa", typeTokens: ["table", "format", "output"] },
  { id: "pt-bbb", typeTokens: ["language", "reply"] },
];

test("assignPattern: a patternRef that names an existing pattern wins over similarity", () => {
  assert.equal(assignPattern(finding("pt-bbb", ["table", "format", "output"]), EXISTING), "pt-bbb");
});

test("assignPattern: an unknown patternRef falls back to the Jaccard match instead of being trusted", () => {
  assert.equal(assignPattern(finding("pt-invented", ["table", "format", "output"]), EXISTING), "pt-aaa");
});

test("assignPattern: a new ref whose tokens sit at Jaccard 0.5 joins the pattern (the boundary is inclusive)", () => {
  // {a, b} vs {a, b, c, d}: 2 / 4
  assert.equal(assignPattern(finding("new", ["a", "b"]), [{ id: "pt-half", typeTokens: ["a", "b", "c", "d"] }]), "pt-half");
});

test("assignPattern: below 0.5 the finding opens a new pattern", () => {
  // {a, b} vs {a, c, d}: 1 / 4
  assert.equal(assignPattern(finding("new", ["a", "b"]), [{ id: "pt-low", typeTokens: ["a", "c", "d"] }]), "new");
});

test("assignPattern: the best of several matches wins, and a tie goes to the smaller id", () => {
  const patterns = [
    { id: "pt-weak", typeTokens: ["a", "b", "c", "d"] },
    { id: "pt-strong", typeTokens: ["a", "b", "c"] },
  ];
  assert.equal(assignPattern(finding("new", ["a", "b", "c"]), patterns), "pt-strong");
  const tied = [
    { id: "pt-z", typeTokens: ["a", "b"] },
    { id: "pt-m", typeTokens: ["a", "b"] },
  ];
  assert.equal(assignPattern(finding("new", ["a", "b"]), tied), "pt-m");
});

test("assignPattern: tokens compare case-insensitively and duplicates do not count twice", () => {
  assert.equal(assignPattern(finding("new", ["Table", "TABLE", " format "]), [{ id: "pt-a", typeTokens: ["table", "format"] }]), "pt-a");
});

test("assignPattern: no tokens and no ref never match anything", () => {
  assert.equal(assignPattern(finding("new", []), [{ id: "pt-empty", typeTokens: [] }]), "new");
  assert.equal(assignPattern(finding("new", ["a"]), []), "new");
});

// ---------------------------------------------------------------------------------------------------------------
// patternViews
// ---------------------------------------------------------------------------------------------------------------

test("patternViews: counts sessions and UTC days, and sums the decayed weight", () => {
  const view = viewOf(statePassing());
  assert.equal(view.skill, SKILL);
  assert.deepEqual(view.observationIds, ["a1", "a2"]);
  assert.equal(view.sessions, 2);
  assert.equal(view.days, 2);
  const expectedWeight = 0.5 ** (3 / 90) + 0.5 ** (1 / 90);
  assertClose(view.weight, expectedWeight);
  assertClose(view.alpha, 1 + expectedWeight);
  assertClose(view.beta, 1);
  assert.equal(view.mechanicalOnly, false);
});

test("patternViews: two observations of one episode are one trial: f is capped at 1 and s is 0", () => {
  const ep = episode("e1", { startedAt: ago(0) });
  const state = stateOf({
    episodes: [ep],
    observations: [
      observation("o1", "pt-1", { episodeId: ep.id, sessionId: ep.sessionId, at: ep.startedAt, weight: 1 }),
      observation("o2", "pt-1", { episodeId: ep.id, sessionId: ep.sessionId, at: ep.startedAt, weight: 0.6, source: "judge" }),
    ],
  });
  const view = viewOf(state);
  assertClose(view.alpha, 2);
  assertClose(view.beta, 1);
  assertClose(view.weight, 1.6);
});

test("patternViews: a partial episode splits into f = Σ weights and s = 1 - f", () => {
  const ep = episode("e1", { startedAt: ago(0) });
  const state = stateOf({
    episodes: [ep],
    observations: [observation("o1", "pt-1", { episodeId: ep.id, at: ep.startedAt, source: "self-report", weight: 0.4 })],
  });
  const view = viewOf(state);
  assertClose(view.alpha, 1.4);
  assertClose(view.beta, 1.6);
});

test("patternViews: both sides decay with the age of the episode", () => {
  const ep = episode("e1", { startedAt: daysAgo(90) });
  const state = stateOf({
    episodes: [ep],
    observations: [observation("o1", "pt-1", { episodeId: ep.id, at: ep.startedAt, source: "self-report", weight: 0.4 })],
  });
  const view = viewOf(state);
  // f = 0.4, s = 0.6, factor 0.5
  assertClose(view.alpha, 1 + 0.2);
  assertClose(view.beta, 1 + 0.3);
  assertClose(view.weight, 0.2);
});

test("patternViews: a clean episode of the skill is a failure of the pattern (s = 1)", () => {
  const hit = episode("e1", { startedAt: ago(0) });
  const clean = episode("e2", { startedAt: ago(0), clean: true });
  const state = stateOf({
    episodes: [hit, clean],
    observations: [observation("o1", "pt-1", { episodeId: hit.id, at: hit.startedAt })],
  });
  const view = viewOf(state);
  assertClose(view.alpha, 2);
  assertClose(view.beta, 2);
});

test("patternViews: a clean episode of another skill, or one that is not clean, adds nothing", () => {
  const hit = episode("e1", { startedAt: ago(0) });
  const state = stateOf({
    episodes: [
      hit,
      episode("e2", { startedAt: ago(0), clean: true, skill: OTHER_SKILL }),
      episode("e3", { startedAt: ago(0), clean: false }),
    ],
    observations: [observation("o1", "pt-1", { episodeId: hit.id, at: hit.startedAt })],
  });
  assertClose(viewOf(state).beta, 1);
});

test("patternViews: a clean episode decays like any other trial", () => {
  const hit = episode("e1", { startedAt: ago(0) });
  const clean = episode("e2", { startedAt: daysAgo(90), clean: true });
  const state = stateOf({
    episodes: [hit, clean],
    observations: [observation("o1", "pt-1", { episodeId: hit.id, at: hit.startedAt })],
  });
  assertClose(viewOf(state).beta, 1.5);
});

test("patternViews: observations without an episode are one trial each", () => {
  const state = stateOf({
    episodes: [],
    observations: [
      observation("n1", "pt-1", { episodeId: null, sessionId: "s1", at: ago(0) }),
      observation("n2", "pt-1", { episodeId: null, sessionId: "s1", at: ago(0) }),
    ],
  });
  const view = viewOf(state);
  assertClose(view.alpha, 3);
  assertClose(view.beta, 1);
  assert.equal(view.sessions, 1);
});

test("patternViews: mechanicalOnly holds only when every observation is mechanical", () => {
  const mechanical = stateOf({
    observations: [
      observation("m1", "pt-1", { source: "mechanical" }),
      observation("m2", "pt-1", { source: "mechanical" }),
    ],
  });
  assert.equal(viewOf(mechanical).mechanicalOnly, true);
  const mixed = stateOf({
    observations: [
      observation("m1", "pt-1", { source: "mechanical" }),
      observation("m2", "pt-1", { source: "self-report" }),
    ],
  });
  assert.equal(viewOf(mixed).mechanicalOnly, false);
});

test("patternViews: patterns are kept apart and carry the skill of their observations", () => {
  const state = stateOf({
    observations: [
      observation("x1", "pt-1"),
      observation("y1", "pt-2", { skill: OTHER_SKILL }),
    ],
  });
  const views = patternViews(state, NOW);
  assert.deepEqual(views.map((view) => [view.id, view.skill, view.observationIds]), [
    ["pt-1", SKILL, ["x1"]],
    ["pt-2", OTHER_SKILL, ["y1"]],
  ]);
});

test("patternViews: an observation past the 365-day cutoff counts for nothing", () => {
  const old = episode("old", { startedAt: daysAgo(400) });
  const state = stateOf({
    episodes: [old],
    observations: [observation("o1", "pt-1", { episodeId: old.id, at: old.startedAt })],
  });
  assert.deepEqual(patternViews(state, NOW), []);
});

test("patternViews: the posterior is the upper tail of Beta(alpha, beta) at the rate floor", () => {
  // two fresh user notes in two episodes: Beta(3, 1), P(rate > 0.15) = 1 - 0.15^3
  const a = episode("a", { startedAt: ago(0), sessionId: "s1" });
  const b = episode("b", { startedAt: ago(0), sessionId: "s2" });
  const state = stateOf({
    episodes: [a, b],
    observations: [
      observation("o1", "pt-1", { episodeId: a.id, sessionId: "s1", at: a.startedAt }),
      observation("o2", "pt-1", { episodeId: b.id, sessionId: "s2", at: b.startedAt }),
    ],
  });
  assertClose(viewOf(state).pAbove, 1 - 0.15 ** 3);
});

test("patternViews: the view reports the clause that blocks it, in the order of the threshold", () => {
  const passing = viewOf(statePassing());
  assert.equal(passing.proposable, true);
  assert.equal(passing.blockedBy, undefined);

  const oneSession = stateOf({
    episodes: [episode("e1", { sessionId: "s", startedAt: daysAgo(3) }), episode("e2", { sessionId: "s", startedAt: daysAgo(1) })],
    observations: [
      observation("o1", "pt-1", { episodeId: "e1", sessionId: "s", at: daysAgo(3) }),
      observation("o2", "pt-1", { episodeId: "e2", sessionId: "s", at: daysAgo(1) }),
    ],
  });
  assert.equal(viewOf(oneSession).proposable, false);
  assert.equal(viewOf(oneSession).blockedBy, "sessions");
});

// ---------------------------------------------------------------------------------------------------------------
// proposablePatterns
// ---------------------------------------------------------------------------------------------------------------

test("proposablePatterns: a pattern that crosses every clause is proposable", () => {
  assert.deepEqual(proposableIds(statePassing()), ["pt-1"]);
});

test("proposablePatterns: a pattern backed by mechanical observations alone never is, however heavy", () => {
  // 3 x 0.3 per episode: Σ weight 1.8 >= 1.6, two sessions, two days
  const early = episode("e1", { startedAt: daysAgo(3) });
  const late = episode("e2", { startedAt: daysAgo(1) });
  const mechanical = (id: string, ep: EpisodeEvent) =>
    observation(id, "pt-1", { episodeId: ep.id, sessionId: ep.sessionId, at: ep.startedAt, source: "mechanical" });
  const state = stateOf({
    episodes: [early, late],
    observations: [mechanical("m1", early), mechanical("m2", early), mechanical("m3", early), mechanical("m4", late), mechanical("m5", late), mechanical("m6", late)],
  });
  assert.equal(viewOf(state).blockedBy, "mechanical-only");
  assert.deepEqual(proposableIds(state), []);
});

test("proposablePatterns: one session is not enough", () => {
  const state = stateOf({
    episodes: [episode("e1", { sessionId: "s", startedAt: daysAgo(3) }), episode("e2", { sessionId: "s", startedAt: daysAgo(1) })],
    observations: [
      observation("o1", "pt-1", { episodeId: "e1", sessionId: "s", at: daysAgo(3) }),
      observation("o2", "pt-1", { episodeId: "e2", sessionId: "s", at: daysAgo(1) }),
    ],
  });
  assert.deepEqual(proposableIds(state), []);
});

test("proposablePatterns: one UTC day is not enough, even across two sessions", () => {
  const a = episode("e1", { startedAt: "2026-11-15T01:00:00.000Z" });
  const b = episode("e2", { startedAt: "2026-11-15T23:00:00.000Z" });
  const state = stateOf({
    episodes: [a, b],
    observations: [
      observation("o1", "pt-1", { episodeId: a.id, sessionId: a.sessionId, at: a.startedAt }),
      observation("o2", "pt-1", { episodeId: b.id, sessionId: b.sessionId, at: b.startedAt }),
    ],
  });
  assert.equal(viewOf(state).days, 1);
  assert.equal(viewOf(state).blockedBy, "days");
  assert.deepEqual(proposableIds(state), []);
});

test("proposablePatterns: two days that straddle midnight UTC are two days", () => {
  const a = episode("e1", { startedAt: "2026-11-14T23:59:00.000Z" });
  const b = episode("e2", { startedAt: "2026-11-15T00:01:00.000Z" });
  const state = stateOf({
    episodes: [a, b],
    observations: [
      observation("o1", "pt-1", { episodeId: a.id, sessionId: a.sessionId, at: a.startedAt }),
      observation("o2", "pt-1", { episodeId: b.id, sessionId: b.sessionId, at: b.startedAt }),
    ],
  });
  assert.equal(viewOf(state).days, 2);
  assert.deepEqual(proposableIds(state), ["pt-1"]);
});

test("proposablePatterns: a weight under 1.6 is not enough", () => {
  const a = episode("e1", { startedAt: daysAgo(3) });
  const b = episode("e2", { startedAt: daysAgo(1) });
  const state = stateOf({
    episodes: [a, b],
    observations: [
      observation("o1", "pt-1", { episodeId: a.id, sessionId: a.sessionId, at: a.startedAt, source: "judge", weight: 0.5 }),
      observation("o2", "pt-1", { episodeId: b.id, sessionId: b.sessionId, at: b.startedAt, source: "judge", weight: 0.5 }),
    ],
  });
  assert.equal(viewOf(state).blockedBy, "weight");
  assert.deepEqual(proposableIds(state), []);
});

test("proposablePatterns: an old pattern loses weight to the half-life and drops under the threshold", () => {
  const a = episode("e1", { startedAt: daysAgo(190) });
  const b = episode("e2", { startedAt: daysAgo(180) });
  const state = stateOf({
    episodes: [a, b],
    observations: [
      observation("o1", "pt-1", { episodeId: a.id, sessionId: a.sessionId, at: a.startedAt }),
      observation("o2", "pt-1", { episodeId: b.id, sessionId: b.sessionId, at: b.startedAt }),
    ],
  });
  // 0.5^(190/90) + 0.5^(2) ≈ 0.23 + 0.25
  assert.equal(viewOf(state).blockedBy, "weight");
  assert.deepEqual(proposableIds(state), []);
});

test("proposablePatterns: clean runs of the skill pull the posterior under 0.8 even when weight, sessions and days pass", () => {
  const { episodes, observations } = passingPattern();
  const clean = Array.from({ length: 10 }, (_, i) => episode(`c${i}`, { clean: true, startedAt: daysAgo(1) }));
  const state = stateOf({ episodes: [...episodes, ...clean], observations });
  // Beta(≈3, ≈11): P(rate > 0.15) ≈ 0.7, under the 0.8 floor (Beta(3, 9) would already be 0.78)
  const view = viewOf(state);
  assert.ok(view.pAbove < 0.8, `pAbove ${view.pAbove}`);
  assert.ok(view.weight >= 1.6);
  assert.equal(view.blockedBy, "posterior");
  assert.deepEqual(proposableIds(state), []);
});

test("proposablePatterns: the threshold is judged from the numbers of the view, not from its flags", () => {
  const view = viewOf(statePassing());
  const tampered: PatternView = { ...view, sessions: 1, proposable: true, blockedBy: undefined };
  assert.deepEqual(proposablePatterns([tampered], statePassing(), NOW), []);
});

test("proposablePatterns: a rejected pattern stays blocked until an observation arrives after the rejection", () => {
  const rejected = statePassing({ tombstones: [tombstoneEvent("pt-1", ago(12 * HOUR_MS))] });
  assert.deepEqual(proposableIds(rejected), []);

  const fresh = episode("a3", { startedAt: ago(HOUR_MS) });
  const { episodes, observations } = passingPattern();
  const reopened = stateOf({
    episodes: [...episodes, fresh],
    observations: [...observations, observation("a3", "pt-1", { episodeId: fresh.id, sessionId: fresh.sessionId, at: fresh.startedAt })],
    tombstones: [tombstoneEvent("pt-1", ago(12 * HOUR_MS))],
  });
  assert.deepEqual(proposableIds(reopened), ["pt-1"]);
});

test("proposablePatterns: a user rejection blocks the same way as a gate rejection", () => {
  const state = statePassing({ tombstones: [tombstoneEvent("pt-1", ago(HOUR_MS), "user-rejected")] });
  assert.deepEqual(proposableIds(state), []);
});

test("proposablePatterns: the latest tombstone is the one that counts", () => {
  // an old tombstone, an observation after it, then a newer tombstone: the observation is older than the newer one
  const { episodes, observations } = passingPattern();
  const state = stateOf({
    episodes,
    observations,
    tombstones: [tombstoneEvent("pt-1", daysAgo(2)), tombstoneEvent("pt-1", ago(HOUR_MS))],
  });
  assert.deepEqual(proposableIds(state), []);
});

test("proposablePatterns: a tombstone on another pattern does not block this one", () => {
  const state = statePassing({ tombstones: [tombstoneEvent("pt-other", ago(HOUR_MS))] });
  assert.deepEqual(proposableIds(state), ["pt-1"]);
});

test("proposablePatterns: a pattern the user put off ('later') is snoozed for 24 hours", () => {
  const proposal = proposalEvent("pr-1", "pt-1", ago(30 * HOUR_MS));
  const state = statePassing({ proposals: [proposal], prompts: [promptEvent("pr-1", "later", ago(20 * HOUR_MS))] });
  assert.deepEqual(proposableIds(state), []);
});

test("proposablePatterns: a prompt nobody answered ('timeout') snoozes like 'later'", () => {
  const proposal = proposalEvent("pr-1", "pt-1", ago(30 * HOUR_MS));
  const state = statePassing({ proposals: [proposal], prompts: [promptEvent("pr-1", "timeout", ago(HOUR_MS))] });
  assert.deepEqual(proposableIds(state), []);
});

test("proposablePatterns: the snooze ends after 24 hours", () => {
  const proposal = proposalEvent("pr-1", "pt-1", ago(50 * HOUR_MS));
  const state = statePassing({ proposals: [proposal], prompts: [promptEvent("pr-1", "later", ago(25 * HOUR_MS))] });
  assert.deepEqual(proposableIds(state), ["pt-1"]);
});

test("proposablePatterns: a snooze belongs to the pattern of its proposal, not to the others", () => {
  const first = passingPattern("pt-1", "a");
  const second = passingPattern("pt-2", "b");
  const proposal = proposalEvent("pr-1", "pt-1", ago(30 * HOUR_MS));
  const state = stateOf({
    episodes: [...first.episodes, ...second.episodes],
    observations: [...first.observations, ...second.observations],
    proposals: [proposal],
    prompts: [promptEvent("pr-1", "later", ago(2 * HOUR_MS))],
  });
  assert.deepEqual(proposableIds(state), ["pt-2"]);
});

test("proposablePatterns: an answer other than later/timeout does not snooze", () => {
  const proposal = proposalEvent("pr-1", "pt-1", ago(30 * HOUR_MS));
  const state = statePassing({ proposals: [proposal], prompts: [promptEvent("pr-1", "approve", ago(HOUR_MS))] });
  assert.deepEqual(proposableIds(state), ["pt-1"]);
});

// The log of a pattern whose proposal was put off twice, then approved, accepted and tombstoned, folded for real. The
// session passed in is the newest observation; the prompt times sit inside the 24h snooze window.
function settledLog(extra: ObserveState["proposals"] = []) {
  const { episodes, observations } = passingPattern();
  const fresh = episode("a3", { startedAt: ago(HOUR_MS) });
  const freshObservation = observation("a3", "pt-1", { episodeId: fresh.id, sessionId: fresh.sessionId, at: fresh.startedAt });
  const timeouts = [promptEvent("pr-1", "timeout", ago(20 * HOUR_MS)), promptEvent("pr-1", "later", ago(15 * HOUR_MS))];
  const settled = [
    promptEvent("pr-1", "approve", ago(10 * HOUR_MS)),
    { ...promptEvent("pr-1", "accept", ago(9 * HOUR_MS)), stage: "b" as const },
    tombstoneEvent("pt-1", ago(8 * HOUR_MS), "accepted"),
  ];
  return { episodes, observations, fresh, freshObservation, timeouts, settled, proposals: [proposalEvent("pr-1", "pt-1", ago(30 * HOUR_MS)), ...extra] };
}

test("proposablePatterns: timeouts older than the approval, acceptance and tombstone of the pattern do not snooze it once a newer session arrives", () => {
  const log = settledLog();
  const state = foldObserveState(
    [...log.episodes, log.fresh, ...log.observations, log.freshObservation, ...log.proposals, ...log.timeouts, ...log.settled],
    NOW,
  );
  assert.deepEqual(proposableIds(state), ["pt-1"]);
});

test("proposablePatterns: the same timeouts snooze while nothing settled the proposal after them", () => {
  const log = settledLog();
  const state = foldObserveState([...log.episodes, ...log.observations, ...log.proposals, ...log.timeouts], NOW);
  assert.deepEqual(proposableIds(state), []);
});

test("proposablePatterns: a put-off newer than the acceptance still snoozes", () => {
  const log = settledLog();
  const later = { ...promptEvent("pr-1", "later", ago(2 * HOUR_MS)), stage: "b" as const };
  const state = foldObserveState(
    [...log.episodes, log.fresh, ...log.observations, log.freshObservation, ...log.proposals, ...log.timeouts, ...log.settled, later],
    NOW,
  );
  assert.deepEqual(proposableIds(state), []);
});

test("proposablePatterns: once the old snooze is superseded, the proposal rate limit still holds", () => {
  const log = settledLog([proposalEvent("pr-2", "pt-elsewhere", ago(5 * HOUR_MS))]);
  const state = foldObserveState(
    [...log.episodes, log.fresh, ...log.observations, log.freshObservation, ...log.proposals, ...log.timeouts, ...log.settled],
    NOW,
  );
  assert.deepEqual(proposableIds(state), []);
});

test("proposablePatterns: one proposal in 24 hours in total: a proposal for any pattern or skill blocks the rest", () => {
  const recent = proposalEvent("pr-9", "pt-elsewhere", ago(23 * HOUR_MS));
  assert.deepEqual(proposableIds(statePassing({ proposals: [recent] })), []);
});

test("proposablePatterns: the window of the proposal rule is 24 hours", () => {
  const expired = proposalEvent("pr-9", "pt-elsewhere", ago(25 * HOUR_MS));
  assert.deepEqual(proposableIds(statePassing({ proposals: [expired] })), ["pt-1"]);
});

test("proposablePatterns: the survivors come best first (posterior, then weight, then id)", () => {
  const weak = passingPattern("pt-weak", "a");
  const strongEpisodes = ["s1", "s2", "s3"].map((id, i) => episode(id, { startedAt: daysAgo(4 - i) }));
  const strong = {
    episodes: strongEpisodes,
    observations: strongEpisodes.map((ep, i) =>
      observation(`s${i + 1}`, "pt-strong", { episodeId: ep.id, sessionId: ep.sessionId, at: ep.startedAt }),
    ),
  };
  const state = stateOf({
    episodes: [...weak.episodes, ...strong.episodes],
    observations: [...weak.observations, ...strong.observations],
  });
  assert.deepEqual(proposableIds(state), ["pt-strong", "pt-weak"]);
});

test("proposablePatterns: it does not mutate the state or the views it is given", () => {
  const state = statePassing({ tombstones: [tombstoneEvent("pt-1", ago(HOUR_MS))] });
  const views = patternViews(state, NOW);
  const before = JSON.stringify({ state, views });
  proposablePatterns(views, state, NOW);
  assert.equal(JSON.stringify({ state, views }), before);
});

test("proposablePatterns: a failed preparation backs the pattern off 24h, then 72h, then 7d from the latest failure", () => {
  const failures = (count: number, latestAgo: number): PrepareFailedEvent[] =>
    Array.from({ length: count }, (_, index) => prepareFailedEvent("pt-1", ago(latestAgo + (count - 1 - index) * 30 * DAY_MS)));
  const proposable = (count: number, latestAgo: number): string[] => proposableIds(statePassing({ prepareFailures: failures(count, latestAgo) }));

  assert.deepEqual(proposable(1, 23 * HOUR_MS), []);
  assert.deepEqual(proposable(1, 25 * HOUR_MS), ["pt-1"]);
  assert.deepEqual(proposable(2, 71 * HOUR_MS), []);
  assert.deepEqual(proposable(2, 73 * HOUR_MS), ["pt-1"]);
  assert.deepEqual(proposable(3, 6 * DAY_MS), []);
  assert.deepEqual(proposable(3, 8 * DAY_MS), ["pt-1"]);
  assert.deepEqual(proposable(5, 6 * DAY_MS), []);
  assert.deepEqual(proposable(5, 8 * DAY_MS), ["pt-1"]);
});

test("proposablePatterns: the backoff of one pattern does not hold back another", () => {
  const first = passingPattern("pt-1", "a");
  const second = passingPattern("pt-2", "b");
  const state = stateOf({
    episodes: [...first.episodes, ...second.episodes],
    observations: [...first.observations, ...second.observations],
    prepareFailures: [prepareFailedEvent("pt-1", ago(HOUR_MS))],
  });
  assert.deepEqual(proposableIds(state), ["pt-2"]);
});

test("proposablePatterns: a session that ended before the tombstone and is read after it does not reopen the pattern, whatever the reason", () => {
  for (const reason of ["accepted", "stale", "user-rejected", "gate-rejected"] as const) {
    const tombstone = tombstoneEvent("pt-1", ago(12 * HOUR_MS), reason);
    // The session is two days old; the log learned of it an hour ago, after the tombstone.
    const old = episode("a3", { startedAt: daysAgo(2) });
    const { episodes, observations } = passingPattern();
    const late = stateOf({
      episodes: [...episodes, old],
      observations: [...observations, observation("a3", "pt-1", { episodeId: old.id, sessionId: old.sessionId, at: ago(HOUR_MS) })],
      tombstones: [tombstone],
    });
    assert.deepEqual(proposableIds(late), [], reason);

    // The same lateness with a session that started after the tombstone is new evidence.
    const fresh = episode("a4", { startedAt: ago(2 * HOUR_MS) });
    const reopened = stateOf({
      episodes: [...episodes, fresh],
      observations: [...observations, observation("a4", "pt-1", { episodeId: fresh.id, sessionId: fresh.sessionId, at: ago(HOUR_MS) })],
      tombstones: [tombstone],
    });
    assert.deepEqual(proposableIds(reopened), ["pt-1"], reason);
  }
});

test("proposablePatterns: an observation with no episode is dated by itself", () => {
  const tombstone = tombstoneEvent("pt-1", ago(12 * HOUR_MS), "stale");
  const { episodes, observations } = passingPattern();
  const note = observation("n1", "pt-1", { episodeId: null, at: ago(HOUR_MS) });
  assert.deepEqual(proposableIds(stateOf({ episodes, observations: [...observations, note], tombstones: [tombstone] })), ["pt-1"]);
});

test("proposablePatterns: an accepted lesson closes the pattern until an observation arrives after the acceptance", () => {
  const accepted = tombstoneEvent("pt-1", ago(12 * HOUR_MS), "accepted");
  assert.deepEqual(proposableIds(statePassing({ tombstones: [accepted] })), []);

  const fresh = episode("a3", { startedAt: ago(HOUR_MS) });
  const { episodes, observations } = passingPattern();
  const reopened = stateOf({
    episodes: [...episodes, fresh],
    observations: [...observations, observation("a3", "pt-1", { episodeId: fresh.id, sessionId: fresh.sessionId, at: fresh.startedAt })],
    tombstones: [accepted],
  });
  assert.deepEqual(proposableIds(reopened), ["pt-1"]);
});
