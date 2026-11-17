import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OBSERVE_FILE } from "../../src/names.ts";
import { appendObserveEvents, foldObserveState, observeLogPath, readObserveLog } from "../../src/observe/store.ts";
import { OBSERVE_FORMAT } from "../../src/observe/types.ts";
import type {
  EpisodeEvent,
  JudgedEvent,
  ObservationEvent,
  ObserveEvent,
  PrepareFailedEvent,
  PromptEvent,
  ProposalEvent,
  TombstoneEvent,
} from "../../src/observe/types.ts";
import { AFTER_OPT_IN_AT, BEFORE_OPT_IN_AT, FIXTURE_NOW, OPT_IN_AT, makeAgentDir } from "./observe-fixtures.ts";

// The reader and the fold of state/observe.jsonl. The reader is tolerant (a line it cannot use is skipped, a truncated
// tail is dropped); the fold is where the rules of the plan live: dedupe by id, nothing before the opt-in, nothing at or
// before a forget -- compared with the session time -- and nothing past the 365 day cutoff.

const NOW = new Date(FIXTURE_NOW);
const SKILL = "demo-skill";
const OTHER = "other-skill";

function episode(id: string, startedAt: string, extra: Partial<EpisodeEvent> = {}): EpisodeEvent {
  return {
    format: OBSERVE_FORMAT,
    type: "episode",
    at: AFTER_OPT_IN_AT,
    id,
    skill: SKILL,
    sessionId: `s-${id}`,
    sessionFile: `/sessions/${id}.jsonl`,
    cwd: "/work/proj-a",
    startEntryId: "e1",
    endEntryId: "e9",
    anchorEntryIds: ["e1"],
    startedAt,
    attribution: "explicit",
    providers: [],
    flags: [],
    clean: true,
    ...extra,
  };
}

function observation(id: string, episodeId: string | null, at: string, extra: Partial<ObservationEvent> = {}): ObservationEvent {
  return {
    format: OBSERVE_FORMAT,
    type: "observation",
    at,
    id,
    episodeId,
    sessionId: "s-1",
    skill: SKILL,
    source: "judge",
    kind: "scope",
    summary: "did more than asked",
    confidence: 0.8,
    weight: 0.48,
    anchorEntryId: "e3",
    patternId: "pt-1",
    ...extra,
  };
}

function judged(episodeId: string, at: string, extra: Partial<JudgedEvent> = {}): JudgedEvent {
  return { format: OBSERVE_FORMAT, type: "judged", at, episodeId, model: "p/m", outcome: "clean", ...extra };
}

function proposal(id: string, at: string, extra: Partial<ProposalEvent> = {}): ProposalEvent {
  return {
    format: OBSERVE_FORMAT,
    type: "proposal",
    at,
    id,
    patternId: "pt-1",
    skill: SKILL,
    stagingPath: "staging/x",
    candidateHash: "sha256:aa",
    gate: "probation",
    bankPath: null,
    provenance: null,
    cwd: "/work/proj-a",
    skillContentHash: "a".repeat(64),
    ...extra,
  };
}

function prepareFailed(at: string, extra: Partial<PrepareFailedEvent> = {}): PrepareFailedEvent {
  return { format: OBSERVE_FORMAT, type: "prepare-failed", at, skill: SKILL, patternId: "pt-1", reason: "bank pending", ...extra };
}

function prompt(proposalId: string, at: string): PromptEvent {
  return { format: OBSERVE_FORMAT, type: "prompt", at, proposalId, stage: "a", answer: "later" };
}

function tombstone(at: string, extra: Partial<TombstoneEvent> = {}): TombstoneEvent {
  return { format: OBSERVE_FORMAT, type: "tombstone", at, patternId: "pt-1", skill: SKILL, reason: "user-rejected", candidateHash: null, ...extra };
}

const optIn = (at = OPT_IN_AT): ObserveEvent => ({ format: OBSERVE_FORMAT, type: "opt-in", at });
const forget = (at: string, skill = SKILL): ObserveEvent => ({ format: OBSERVE_FORMAT, type: "forget", at, skill });

test("readObserveLog: an absent log is no events", async (t) => {
  const fixture = makeAgentDir(t);
  assert.deepEqual(await readObserveLog(fixture.base), []);
});

test("appendObserveEvents then readObserveLog: the events come back in order, the file is 0600 in a 0700 directory", async (t) => {
  const fixture = makeAgentDir(t);
  const events = [optIn(), episode("ep-1", AFTER_OPT_IN_AT), observation("ob-1", "ep-1", AFTER_OPT_IN_AT)];

  await appendObserveEvents(fixture.base, events);

  assert.deepEqual(await readObserveLog(fixture.base), events);
  assert.equal(fs.statSync(observeLogPath(fixture.base)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(observeLogPath(fixture.base))).mode & 0o777, 0o700);
});

test("readObserveLog: skips garbage, other formats, unknown types and events without their fields; drops a truncated tail", async (t) => {
  const fixture = makeAgentDir(t);
  const good = episode("ep-1", AFTER_OPT_IN_AT);
  const lines = [
    "not json",
    "[1,2]",
    JSON.stringify({ ...good, format: "pi-simple-sri/observe@2" }),
    JSON.stringify({ ...good, type: "from-the-future" }),
    JSON.stringify({ ...good, id: undefined }),
    JSON.stringify({ ...good, at: 5 }),
    JSON.stringify(good),
  ];
  const logPath = observeLogPath(fixture.base);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, `${lines.join("\n")}\n${JSON.stringify(episode("ep-2", AFTER_OPT_IN_AT))}`);

  assert.deepEqual(await readObserveLog(fixture.base), [good]);
  assert.equal(path.basename(logPath), OBSERVE_FILE);
});

test("foldObserveState: duplicate ids keep the first, except an episode, where the latest wins", () => {
  const first = episode("ep-1", AFTER_OPT_IN_AT, { sessionFile: "/sessions/parent.jsonl" });
  const second = episode("ep-1", AFTER_OPT_IN_AT, { sessionFile: "/sessions/child.jsonl" });
  const state = foldObserveState(
    [
      optIn(),
      first,
      second,
      observation("ob-1", "ep-1", AFTER_OPT_IN_AT),
      observation("ob-1", "ep-1", AFTER_OPT_IN_AT, { summary: "again" }),
      proposal("pr-1", AFTER_OPT_IN_AT),
      proposal("pr-1", AFTER_OPT_IN_AT, { stagingPath: "staging/y" }),
      judged("ep-1", AFTER_OPT_IN_AT),
      judged("ep-1", AFTER_OPT_IN_AT),
    ],
    NOW,
  );

  assert.deepEqual(state.episodes, [second]);
  assert.equal(state.observations.length, 1);
  assert.equal(state.observations[0].summary, "did more than asked");
  assert.equal(state.proposals.length, 1);
  assert.equal(state.proposals[0].stagingPath, "staging/x");
  assert.equal(state.judged.length, 1);
});

test("foldObserveState: optInAt is the opt-in event, and an episode that started before it goes with what hangs from it", () => {
  const before = episode("ep-old", BEFORE_OPT_IN_AT);
  const after = episode("ep-new", AFTER_OPT_IN_AT);
  const state = foldObserveState(
    [
      optIn(),
      before,
      after,
      observation("ob-old", "ep-old", AFTER_OPT_IN_AT),
      observation("ob-new", "ep-new", AFTER_OPT_IN_AT),
      observation("ob-note-old", null, BEFORE_OPT_IN_AT),
      observation("ob-note-new", null, AFTER_OPT_IN_AT),
      judged("ep-old", AFTER_OPT_IN_AT),
      judged("ep-new", AFTER_OPT_IN_AT),
    ],
    NOW,
  );

  assert.equal(state.optInAt, OPT_IN_AT);
  assert.deepEqual(state.episodes.map((item) => item.id), ["ep-new"]);
  assert.deepEqual(state.observations.map((item) => item.id), ["ob-new", "ob-note-new"]);
  assert.deepEqual(state.judged.map((item) => item.episodeId), ["ep-new"]);
});

test("foldObserveState: an episode that started exactly at optInAt is kept", () => {
  const state = foldObserveState([optIn(), episode("ep-1", OPT_IN_AT)], NOW);
  assert.deepEqual(state.episodes.map((item) => item.id), ["ep-1"]);
});

test("foldObserveState: the first of two opt-ins is optInAt", () => {
  const state = foldObserveState([optIn(AFTER_OPT_IN_AT), optIn(OPT_IN_AT)], NOW);
  assert.equal(state.optInAt, OPT_IN_AT);
});

test("foldObserveState: without an opt-in event optInAt is null and nothing is cut by it", () => {
  const state = foldObserveState([episode("ep-1", BEFORE_OPT_IN_AT)], NOW);
  assert.equal(state.optInAt, null);
  assert.equal(state.episodes.length, 1);
});

test("foldObserveState: a forget drops what started at or before it, for that skill only", () => {
  const forgotAt = "2026-11-13T00:00:00.000Z";
  const state = foldObserveState(
    [
      optIn(),
      episode("ep-before", "2026-11-12T00:00:00.000Z"),
      episode("ep-at", forgotAt),
      episode("ep-after", "2026-11-14T00:00:00.000Z"),
      episode("ep-other", "2026-11-12T00:00:00.000Z", { skill: OTHER }),
      observation("ob-before", "ep-before", "2026-11-15T00:00:00.000Z"),
      observation("ob-note-before", null, "2026-11-12T00:00:00.000Z", { source: "user-note" }),
      observation("ob-note-after", null, "2026-11-14T00:00:00.000Z", { source: "user-note" }),
      tombstone("2026-11-12T00:00:00.000Z"),
      forget(forgotAt),
    ],
    NOW,
  );

  assert.deepEqual(state.episodes.map((item) => item.id), ["ep-after", "ep-other"]);
  assert.deepEqual(state.observations.map((item) => item.id), ["ob-note-after"]);
  assert.deepEqual(state.tombstones, []);
  assert.deepEqual(state.forgets, { [SKILL]: forgotAt });
});

test("foldObserveState: a session older than the forget scanned again after it does not bring the skill back", () => {
  const forgotAt = "2026-11-13T00:00:00.000Z";
  // The log learned of the episode (`at`) after the forget, but the session is from before it.
  const rescanned = episode("ep-1", "2026-11-11T00:00:00.000Z", { at: "2026-11-15T00:00:00.000Z" });
  const state = foldObserveState([optIn(), forget(forgotAt), rescanned], NOW);
  assert.deepEqual(state.episodes, []);
});

test("foldObserveState: the latest forget of a skill wins", () => {
  const state = foldObserveState([forget("2026-11-14T00:00:00.000Z"), forget("2026-11-12T00:00:00.000Z")], NOW);
  assert.deepEqual(state.forgets, { [SKILL]: "2026-11-14T00:00:00.000Z" });
});

test("foldObserveState: a proposal after the forget survives with its prompts; one before it goes with them", () => {
  const forgotAt = "2026-11-13T00:00:00.000Z";
  const state = foldObserveState(
    [
      optIn(),
      proposal("pr-old", "2026-11-12T00:00:00.000Z"),
      prompt("pr-old", "2026-11-12T00:01:00.000Z"),
      proposal("pr-new", "2026-11-14T00:00:00.000Z"),
      prompt("pr-new", "2026-11-14T00:01:00.000Z"),
      {
        format: OBSERVE_FORMAT,
        type: "gate-outcome",
        at: "2026-11-12T00:02:00.000Z",
        proposalId: "pr-old",
        class: "rejected",
        status: "gate-rejected",
        reason: null,
      },
      forget(forgotAt),
    ],
    NOW,
  );

  assert.deepEqual(state.proposals.map((item) => item.id), ["pr-new"]);
  assert.deepEqual(state.prompts.map((item) => item.proposalId), ["pr-new"]);
  assert.deepEqual(state.gateOutcomes, []);
});

test("foldObserveState: the 365 day cutoff drops an episode at 366 days and keeps one at 364", () => {
  const day = 24 * 60 * 60 * 1000;
  const old = new Date(NOW.getTime() - 366 * day).toISOString();
  const recent = new Date(NOW.getTime() - 364 * day).toISOString();
  const state = foldObserveState(
    [
      episode("ep-old", old),
      episode("ep-recent", recent),
      observation("ob-old", "ep-old", recent),
      observation("ob-note-old", null, old),
      proposal("pr-old", old),
      tombstone(old),
      judged("ep-recent", old),
    ],
    NOW,
  );

  assert.deepEqual(state.episodes.map((item) => item.id), ["ep-recent"]);
  assert.deepEqual(state.observations, []);
  assert.deepEqual(state.proposals, []);
  assert.deepEqual(state.tombstones, []);
  assert.deepEqual(state.judged, []);
});

test("foldObserveState: does not mutate its input", () => {
  const events = [optIn(), episode("ep-old", BEFORE_OPT_IN_AT), forget(AFTER_OPT_IN_AT)];
  const snapshot = JSON.stringify(events);
  foldObserveState(events, NOW);
  assert.equal(JSON.stringify(events), snapshot);
});

test("foldObserveState: the latest episode event of an id wins, so a session that grew replaces its stored end", () => {
  const grown = episode("ep-1", AFTER_OPT_IN_AT, { at: "2026-11-16T10:00:00.000Z", endEntryId: "e20" });
  const stored = episode("ep-1", AFTER_OPT_IN_AT, { at: "2026-11-15T10:00:00.000Z", endEntryId: "e9" });

  assert.equal(foldObserveState([optIn(), stored, grown], NOW).episodes[0]?.endEntryId, "e20");
  assert.equal(foldObserveState([optIn(), grown, stored], NOW).episodes[0]?.endEntryId, "e20");
  assert.equal(foldObserveState([optIn(), stored, grown], NOW).episodes.length, 1);
});

test("foldObserveState: a note or a self-report from before the opt-in survives; a judge or mechanical one does not", () => {
  const state = foldObserveState(
    [
      optIn(),
      observation("ob-note", null, BEFORE_OPT_IN_AT, { source: "user-note" }),
      observation("ob-self", null, BEFORE_OPT_IN_AT, { source: "self-report" }),
      observation("ob-judge", null, BEFORE_OPT_IN_AT, { source: "judge" }),
      observation("ob-mech", null, BEFORE_OPT_IN_AT, { source: "mechanical" }),
    ],
    NOW,
  );

  assert.deepEqual(state.observations.map((item) => item.id), ["ob-note", "ob-self"]);
});

test("foldObserveState: a note from before the opt-in is still erased by a forget of its skill", () => {
  const state = foldObserveState(
    [optIn(), observation("ob-note", null, BEFORE_OPT_IN_AT, { source: "user-note" }), forget(AFTER_OPT_IN_AT)],
    NOW,
  );

  assert.deepEqual(state.observations, []);
});

test("foldObserveState: prepare-failed events are kept in order and erased by a forget of their skill", () => {
  const forgotAt = "2026-11-13T00:00:00.000Z";
  const state = foldObserveState(
    [
      optIn(),
      prepareFailed("2026-11-12T00:00:00.000Z"),
      prepareFailed("2026-11-14T00:00:00.000Z"),
      prepareFailed("2026-11-14T00:00:00.000Z", { skill: OTHER, patternId: "pt-2" }),
      forget(forgotAt),
    ],
    NOW,
  );

  assert.deepEqual(state.prepareFailures.map((item) => [item.skill, item.at]), [
    [SKILL, "2026-11-14T00:00:00.000Z"],
    [OTHER, "2026-11-14T00:00:00.000Z"],
  ]);
});

test("readObserveLog: a prepare-failed line without its pattern is skipped", async (t) => {
  const fixture = makeAgentDir(t);
  await appendObserveEvents(fixture.base, [optIn(), prepareFailed(AFTER_OPT_IN_AT)]);
  fs.appendFileSync(observeLogPath(fixture.base), `${JSON.stringify({ ...prepareFailed(AFTER_OPT_IN_AT), patternId: undefined })}\n`);

  assert.equal((await readObserveLog(fixture.base)).filter((event) => event.type === "prepare-failed").length, 1);
});
