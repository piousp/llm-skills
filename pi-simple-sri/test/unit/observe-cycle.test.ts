import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runObserveCycle,
  type AnswerA,
  type AnswerB,
  type CycleDeps,
  type CycleInput,
  type CycleVerdict,
  type GateOutcomeView,
} from "../../src/observe/cycle.ts";
import { foldObserveState } from "../../src/observe/store.ts";
import { reviewProposal, type ReviewDeps } from "../../src/observe/review.ts";
import type { ProposalView } from "../../src/observe/prompts.ts";
import { sha256Digest } from "../../src/hash.ts";
import { observeId } from "../../src/observe/types.ts";
import { patternViews, proposablePatterns } from "../../src/observe/patterns.ts";
import { PROBATION_OUTCOME } from "../../src/observe/outcome.ts";
import {
  OBSERVE_FORMAT,
  type Episode,
  type JudgeFinding,
  type ObserveCursor,
  type ObserveEvent,
  type ObserveState,
  type PatternView,
  type PrefilterResult,
  type SessionFileRef,
  type SessionRead,
} from "../../src/observe/types.ts";
import { FAKE_SECRETS, FIXTURE_NOW, OPT_IN_AT, AFTER_OPT_IN_AT, BEFORE_OPT_IN_AT, fakeUi } from "./observe-fixtures.ts";
import { validateAgainstObserveEventSchema } from "./schema-reader.ts";

const NOW = new Date(FIXTURE_NOW);
const READ = { header: { id: "h" }, entries: [], endOffset: 0 } as unknown as SessionRead;

function episode(id: string, overrides: Partial<Episode> = {}): Episode {
  return {
    id,
    skill: "alpha",
    sessionId: `s-${id}`,
    sessionFile: `/sessions/${id}.jsonl`,
    cwd: "/work/proj-a",
    startEntryId: `start-${id}`,
    endEntryId: `end-${id}`,
    anchorEntryIds: [`anchor-${id}`],
    startedAt: AFTER_OPT_IN_AT,
    attribution: "explicit",
    providers: ["anthropic"],
    ...overrides,
  };
}

function ref(name: string): SessionFileRef {
  return { path: `/sessions/${name}.jsonl`, headerId: `hdr-${name}`, size: 100, mtimeMs: 1 };
}

function finding(overrides: Partial<JudgeFinding> = {}): JudgeFinding {
  return {
    kind: "wrong-format",
    summary: "the user asked for a table",
    confidence: 0.5,
    anchorEntryId: "anchor-1",
    patternRef: "new",
    typeTokens: ["format"],
    ...overrides,
  };
}

function view(overrides: Partial<PatternView> = {}): PatternView {
  return {
    id: "pt-1",
    skill: "alpha",
    observationIds: [],
    sessions: 2,
    days: 2,
    weight: 2,
    alpha: 2,
    beta: 1,
    pAbove: 0.9,
    mechanicalOnly: false,
    proposable: true,
    ...overrides,
  };
}

function emptyState(): ObserveState {
  return { optInAt: null, episodes: [], judged: [], observations: [], proposals: [], prepareFailures: [], prompts: [], gateOutcomes: [], tombstones: [], forgets: {} };
}

// Just enough of foldObserveState for the cycle: group by type, no filtering.
function foldFake(events: readonly ObserveEvent[]): ObserveState {
  const state = emptyState();
  for (const event of events) {
    switch (event.type) {
      case "opt-in":
        state.optInAt ??= event.at;
        break;
      case "episode":
        state.episodes.push(event);
        break;
      case "judged":
        state.judged.push(event);
        break;
      case "observation":
        state.observations.push(event);
        break;
      case "proposal":
        state.proposals.push(event);
        break;
      case "prepare-failed":
        state.prepareFailures.push(event);
        break;
      case "prompt":
        state.prompts.push(event);
        break;
      case "gate-outcome":
        state.gateOutcomes.push(event);
        break;
      case "tombstone":
        state.tombstones.push(event);
        break;
      case "forget":
        state.forgets[event.skill] = event.at;
        break;
    }
  }
  return state;
}

interface Script {
  files?: Record<string, { episodes: Episode[]; flags?: Record<string, PrefilterResult["flags"]>; needsJudge?: Record<string, boolean> }>;
  verdicts?: Record<string, CycleVerdict>;
  events?: ObserveEvent[];
  views?: PatternView[];
  locked?: boolean;
  providerBlocked?: string[];
  bank?: { path: string; provenance: "user" | "skill-shipped" | "auto" } | null;
  selection?: { kind: "ready"; cwd: string } | { kind: "pending"; reason: string };
  generate?: { ok: true; value: string } | { ok: false; error: string };
  proposal?: { stagingPath: string; candidateHash: string } | null;
  // Every propose answers a candidate of its own (staging/c<n>, c<n>), like the real stager.
  freshCandidates?: boolean;
  gate?: GateOutcomeView;
  // A gate that behaves like the real one: a staged candidate that already concluded is refused `already-concluded`.
  realisticGate?: boolean;
  // Ids of the proposals whose staged record already holds the lesson.
  accepted?: string[];
  promoteError?: string;
  // Skills whose bank.resolve throws this message (a bank that exists and cannot be used).
  resolveError?: Record<string, string>;
  // The real fold and the real rule of what is proposable, over the events of the store.
  realRules?: boolean;
  answerA?: AnswerA;
  answerB?: AnswerB;
  unreadable?: string[];
  // The answer to the dry-run cost confirmation.
  confirm?: boolean;
}

function harness(script: Script = {}) {
  const log: string[] = [];
  // Seeded with the opt-in marker unless a test passes `events` (use `events: []` for an unseeded store).
  const stored: ObserveEvent[] = [...(script.events ?? [{ format: OBSERVE_FORMAT, type: "opt-in", at: OPT_IN_AT }])];
  const cursor: ObserveCursor = { files: {} };
  const written: ObserveCursor[] = [];
  const labeling: { name: string; text: string }[] = [];
  const judged: string[] = [];
  const dispatched: string[] = [];
  const gateRuns: { proposalId: string; bankPath: string | null }[] = [];
  const shown: string[] = [];
  const prefiltered: string[] = [];
  const proposed: { gate: string; bankPath: string | null }[] = [];
  const concluded = new Set<string>();
  const discarded: string[] = [];
  const resolved: string[] = [];
  const generated: string[] = [];
  let candidates = 0;
  const files = script.files ?? {};

  const deps: CycleDeps = {
    store: {
      readEvents: async () => [...stored],
      append: async (events) => {
        log.push(`append:${events.map((event) => event.type).join(",")}`);
        stored.push(...events);
      },
      readCursor: async () => structuredClone(cursor),
      writeCursor: async (next) => {
        written.push(structuredClone(next));
        Object.assign(cursor.files, next.files);
      },
      withLock: async (fn) => {
        if (script.locked) return { ok: false, error: "locked" };
        return { ok: true, value: await fn(new AbortController().signal) };
      },
    },
    fold: (events, now) => (script.realRules ? foldObserveState(events, now) : foldFake(events)),
    listSessions: async () => Object.keys(files).map(ref),
    planScan: (list, current) => ({ read: list.filter((file) => current.files[file.headerId] === undefined) }),
    readSession: async (path) => (script.unreadable?.includes(path) ? { ok: false, error: "gone" } : { ok: true, value: READ }),
    segment: (_read, file) => files[file.path.replace("/sessions/", "").replace(".jsonl", "")]!.episodes,
    prefilter: (ep) => {
      prefiltered.push(ep.id);
      const owner = Object.values(files).find((candidate) => candidate.episodes.includes(ep))!;
      const flags = owner.flags?.[ep.id] ?? [];
      return { episodeId: ep.id, flags, needsJudge: owner.needsJudge?.[ep.id] ?? flags.some((flag) => flag.kind === "correction") };
    },
    providerOk: (ep) => !(script.providerBlocked ?? []).includes(ep.id),
    judge: async ({ episode: ep }) => {
      judged.push(ep.id);
      return script.verdicts?.[ep.id] ?? { outcome: "clean", model: "m/x", findings: [] };
    },
    assignPattern: () => null,
    redact: (text) => text.replaceAll(FAKE_SECRETS.githubToken, "[REDACTED]"),
    cursorEntryOf: (file) => ({ path: file.path, size: file.size, mtimeMs: file.mtimeMs, firstLineHash: "h" }),
    estimateCost: (eps) => ({ calls: eps.length, inTokens: 1, outTokens: 1, usd: null }),
    confirmDryRun: async () => {
      log.push("confirm");
      return script.confirm ?? true;
    },
    writeLabeling: async (name, text) => {
      labeling.push({ name, text });
    },
    proposable: (state, now) => (script.realRules ? proposablePatterns(patternViews(state, now), state, now) : (script.views ?? [])),
    isAccepted: async (proposal) => (script.accepted ?? []).includes(proposal.id),
    bank: {
      resolve: async (skill) => {
        resolved.push(skill);
        const error = script.resolveError?.[skill];
        if (error !== undefined) throw new Error(error);
        return script.bank ?? null;
      },
      select: async () => {
        const selection = script.selection ?? { kind: "pending", reason: "too few" };
        return selection.kind === "ready" ? { kind: "ready", selection: { cwd: selection.cwd, episodes: [] } } : selection;
      },
      generate: async ({ skill }) => {
        generated.push(skill);
        return script.generate ?? { ok: false, error: "no" };
      },
      promote: async (draft) => {
        log.push(`promote:${draft}`);
        if (script.promoteError !== undefined) throw new Error(script.promoteError);
        return `banks/${draft}`;
      },
    },
    propose: async ({ gate, bankPath }) => {
      log.push("propose");
      proposed.push({ gate, bankPath });
      if (script.proposal === null) return { ok: false, error: "refused" };
      candidates += 1;
      const draft = script.freshCandidates
        ? { stagingPath: `staging/c${candidates}`, candidateHash: `c${candidates}` }
        : (script.proposal ?? { stagingPath: "staging/x", candidateHash: "h1" });
      return { ok: true, value: { skillContentHash: sha256Digest("SKILL.md of alpha"), ...draft } };
    },
    discardArtifacts: async (skill) => {
      discarded.push(skill);
    },
    runGate: async ({ proposal, bankPath }) => {
      log.push("gate");
      gateRuns.push({ proposalId: proposal.id, bankPath });
      if (script.realisticGate && concluded.has(proposal.stagingPath)) {
        return { class: "retryable", status: "refused", reason: "already-concluded" };
      }
      concluded.add(proposal.stagingPath);
      return script.gate ?? { class: "accepted", status: "gate-accepted", reason: null };
    },
    offerA: async () => {
      shown.push("a");
      return script.answerA ?? "approve";
    },
    offerB: async () => {
      shown.push("b");
      return script.answerB ?? "accept";
    },
    dispatchReview: (id) => {
      dispatched.push(id);
    },
  };
  return { deps, stored, cursor, written, labeling, judged, dispatched, gateRuns, shown, log, prefiltered, proposed, discarded, resolved, generated };
}

function input(overrides: Partial<CycleInput> = {}): CycleInput {
  return {
    mode: "background",
    config: { enabled: true, judgeModel: null, judgeCallsPerDay: 20, replayAllow: [] },
    now: NOW,
    currentSessionFile: null,
    ctxCwd: "/work/ctx",
    ...overrides,
  };
}

const CORRECTION = (anchor = "anchor-1") => [{ kind: "correction" as const, anchorEntryId: anchor, detail: "no, use a table" }];
const typesOf = (events: readonly ObserveEvent[]) => events.map((event) => event.type);

// ---------------------------------------------------------------------------------------------
// Gates before anything runs
// ---------------------------------------------------------------------------------------------

test("a disabled observer does nothing: no lock, no read, no write", async () => {
  const h = harness({ events: [], files: { a: { episodes: [episode("e1")] } } });
  const report = await runObserveCycle(input({ config: { enabled: false, judgeModel: null, judgeCallsPerDay: 20, replayAllow: [] } }), h.deps);
  assert.equal(report.status, "disabled");
  assert.deepEqual(h.stored, []);
  assert.deepEqual(h.log, []);
});

test("a contended scan lock reports locked and writes nothing", async () => {
  const h = harness({ events: [], locked: true, files: { a: { episodes: [episode("e1")] } } });
  const report = await runObserveCycle(input(), h.deps);
  assert.equal(report.status, "locked");
  assert.deepEqual(h.stored, []);
});

// ---------------------------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------------------------

test("the first enabled cycle writes the opt-in marker before anything else, once", async () => {
  const h = harness({ events: [], files: { a: { episodes: [episode("e1")] } } });
  await runObserveCycle(input(), h.deps);
  assert.equal(h.stored[0]!.type, "opt-in");
  assert.equal(h.stored[0]!.at, NOW.toISOString());
  assert.equal(h.stored.filter((event) => event.type === "opt-in").length, 1);
  await runObserveCycle(input(), h.deps);
  assert.equal(h.stored.filter((event) => event.type === "opt-in").length, 1);
});

test("a clean unflagged episode is persisted as clean, without a judge call", async () => {
  const h = harness({ files: { a: { episodes: [episode("e1")] } } });
  const report = await runObserveCycle(input(), h.deps);
  const stored = h.stored.find((event) => event.type === "episode");
  assert.ok(stored && stored.type === "episode");
  assert.equal(stored.clean, true);
  assert.deepEqual(stored.flags, []);
  assert.deepEqual(h.judged, []);
  assert.equal(report.episodes, 1);
  assert.equal(report.judgeCalls, 0);
});

test("a flagged episode is judged; findings become judge observations weighted 0.6 x confidence", async () => {
  const h = harness({
    files: { a: { episodes: [episode("e1")], flags: { e1: CORRECTION() } } },
    verdicts: { e1: { outcome: "findings", model: "m/x", findings: [finding({ confidence: 0.5 })] } },
  });
  const report = await runObserveCycle(input(), h.deps);
  assert.deepEqual(typesOf(h.stored), ["opt-in", "episode", "judged", "observation"]);
  const observation = h.stored.find((event) => event.type === "observation");
  assert.ok(observation && observation.type === "observation");
  assert.equal(observation.source, "judge");
  assert.equal(observation.weight, 0.3);
  assert.equal(observation.confidence, 0.5);
  assert.equal(observation.episodeId, "e1");
  assert.match(observation.patternId, /^pt-[0-9a-f]{12}$/);
  assert.match(observation.id, /^ob-[0-9a-f]{12}$/);
  const stored = h.stored.find((event) => event.type === "episode");
  assert.ok(stored && stored.type === "episode");
  assert.equal(stored.clean, false);
  assert.deepEqual(stored.flags, ["correction"]);
  assert.equal(report.observations, 1);
  assert.equal(report.judgeCalls, 1);
});

test("a finding joins the existing pattern the assignment names", async () => {
  const h = harness({
    files: { a: { episodes: [episode("e1")], flags: { e1: CORRECTION() } } },
    verdicts: { e1: { outcome: "findings", model: "m/x", findings: [finding({ patternRef: "pt-old" })] } },
  });
  h.deps.assignPattern = () => "pt-old";
  await runObserveCycle(input(), h.deps);
  const observation = h.stored.find((event) => event.type === "observation");
  assert.ok(observation && observation.type === "observation");
  assert.equal(observation.patternId, "pt-old");
});

test("mechanical flags become mechanical observations of weight 0.3 without a judge call", async () => {
  const flags = [{ kind: "tool-error" as const, anchorEntryId: "tool-1", detail: "exit 1" }];
  const h = harness({ files: { a: { episodes: [episode("e1")], flags: { e1: flags } } } });
  await runObserveCycle(input(), h.deps);
  assert.deepEqual(h.judged, []);
  const observation = h.stored.find((event) => event.type === "observation");
  assert.ok(observation && observation.type === "observation");
  assert.equal(observation.source, "mechanical");
  assert.equal(observation.weight, 0.3);
  assert.equal(observation.confidence, null);
  assert.equal(observation.kind, "tool-error");
});

test("summaries are redacted and cut to the cap before they are stored", async () => {
  const summary = `token ${FAKE_SECRETS.githubToken} ${"x".repeat(500)}`;
  const h = harness({
    files: { a: { episodes: [episode("e1")], flags: { e1: CORRECTION() } } },
    verdicts: { e1: { outcome: "findings", model: "m/x", findings: [finding({ summary })] } },
  });
  await runObserveCycle(input(), h.deps);
  const observation = h.stored.find((event) => event.type === "observation");
  assert.ok(observation && observation.type === "observation");
  assert.ok(!observation.summary.includes(FAKE_SECRETS.githubToken));
  assert.match(observation.summary, /\[REDACTED\]/);
  assert.equal(Array.from(observation.summary).length, 300);
});

test("a judge that found nothing leaves the episode clean", async () => {
  const h = harness({ files: { a: { episodes: [episode("e1")], flags: { e1: CORRECTION() } } } });
  await runObserveCycle(input(), h.deps);
  const stored = h.stored.find((event) => event.type === "episode");
  assert.ok(stored && stored.type === "episode");
  assert.equal(stored.clean, true);
});

test("a failed judge does not consume the episode: no episode event, the file stays in the backlog, the failure counts against the budget", async () => {
  const h = harness({
    files: { a: { episodes: [episode("e1")], flags: { e1: CORRECTION() } } },
    verdicts: { e1: { outcome: "failed", model: "m/x", findings: [], reason: "bad json" } },
  });
  const report = await runObserveCycle(input(), h.deps);
  assert.equal(h.stored.some((event) => event.type === "episode" || event.type === "observation"), false);
  const failedEvent = h.stored.find((event) => event.type === "judged");
  assert.ok(failedEvent && failedEvent.type === "judged");
  assert.deepEqual([failedEvent.episodeId, failedEvent.outcome, failedEvent.reason], ["e1", "failed", "bad json"]);
  assert.deepEqual(h.cursor.files, {});
  assert.equal(report.blocked, 1);
  assert.equal(report.episodes, 0);

  // The next start judges it again, and this time it settles.
  const retry = harness({ events: h.stored, files: { a: { episodes: [episode("e1")], flags: { e1: CORRECTION() } } } });
  await runObserveCycle(input(), retry.deps);
  assert.deepEqual(retry.judged, ["e1"]);
  assert.equal(retry.stored.filter((event) => event.type === "episode").length, 1);
  assert.deepEqual(Object.keys(retry.cursor.files), ["hdr-a"]);
});

test("a skipped judgement leaves no trace: no episode, no judged event, no cursor", async () => {
  const h = harness({
    files: { a: { episodes: [episode("e1")], flags: { e1: CORRECTION() } } },
    verdicts: { e1: { outcome: "skipped", model: "", findings: [], reason: "no model" } },
  });
  const report = await runObserveCycle(input(), h.deps);
  assert.deepEqual(typesOf(h.stored), ["opt-in"]);
  assert.deepEqual(h.cursor.files, {});
  assert.equal(report.blocked, 1);
});

test("a judge that throws is recorded as failed, leaves its episode for later and does not stop the cycle", async () => {
  const h = harness({ files: { a: { episodes: [episode("e1"), episode("e2")], flags: { e1: CORRECTION() } } } });
  h.deps.judge = async () => {
    throw new Error("network down");
  };
  const report = await runObserveCycle(input(), h.deps);
  assert.equal(report.status, "done");
  const judged = h.stored.find((event) => event.type === "judged");
  assert.ok(judged && judged.type === "judged");
  assert.equal(judged.outcome, "failed");
  assert.match(judged.reason ?? "", /network down/);
  assert.deepEqual(h.stored.filter((event) => event.type === "episode").map((event) => (event as { id: string }).id), ["e2"]);
});

test("an episode of a forgotten skill is skipped before the prefilter and the judge, whichever file it comes back in", async () => {
  const forgotAt = "2026-11-13T00:00:00.000Z";
  const h = harness({
    events: [
      { format: OBSERVE_FORMAT, type: "opt-in", at: OPT_IN_AT },
      { format: OBSERVE_FORMAT, type: "forget", at: forgotAt, skill: "alpha" },
    ],
    realRules: true,
    files: {
      a: {
        episodes: [
          episode("old", { startedAt: "2026-11-12T09:00:00.000Z" }),
          episode("at", { startedAt: forgotAt }),
          episode("after", { startedAt: "2026-11-14T09:00:00.000Z" }),
          episode("other", { skill: "beta", startedAt: "2026-11-12T09:00:00.000Z" }),
        ],
        flags: { old: CORRECTION(), at: CORRECTION(), after: CORRECTION(), other: CORRECTION() },
      },
    },
  });
  await runObserveCycle(input(), h.deps);
  assert.deepEqual(h.prefiltered.sort(), ["after", "other"]);
  assert.deepEqual(h.judged.sort(), ["after", "other"]);
  assert.deepEqual(h.stored.filter((event) => event.type === "episode").map((event) => (event as { id: string }).id).sort(), ["after", "other"]);
});

test("a stored episode whose end moved is processed again; the latest episode event wins and earlier findings are not duplicated", async () => {
  const first = episode("e1", { endEntryId: "end-1" });
  const grown = episode("e1", { endEntryId: "end-2" });
  const h = harness({
    realRules: true,
    files: { a: { episodes: [first], flags: { e1: CORRECTION() } } },
    verdicts: { e1: { outcome: "findings", model: "m/x", findings: [finding()] } },
  });
  await runObserveCycle(input(), h.deps);
  assert.equal(h.stored.filter((event) => event.type === "observation").length, 1);

  // Same file read again: nothing to do.
  h.cursor.files = {};
  await runObserveCycle(input(), h.deps);
  assert.deepEqual(h.judged, ["e1"]);

  // The session grew: the episode ends later now.
  const later = harness({
    events: h.stored,
    realRules: true,
    files: { a: { episodes: [grown], flags: { e1: CORRECTION() } } },
    verdicts: { e1: { outcome: "findings", model: "m/y", findings: [finding(), finding({ kind: "extra", anchorEntryId: "anchor-9" })] } },
  });
  await runObserveCycle(input(), later.deps);
  assert.deepEqual(later.judged, ["e1"]);
  const state = foldObserveState(later.stored, NOW);
  assert.deepEqual(state.episodes.map((item) => [item.id, item.endEntryId, item.clean]), [["e1", "end-2", false]]);
  assert.equal(state.observations.length, 2);
});

test("a re-processed episode that found nothing new does not turn clean over what an earlier pass found", async () => {
  const h = harness({
    realRules: true,
    files: { a: { episodes: [episode("e1", { endEntryId: "end-1" })], flags: { e1: CORRECTION() } } },
    verdicts: { e1: { outcome: "findings", model: "m/x", findings: [finding()] } },
  });
  await runObserveCycle(input(), h.deps);
  const later = harness({
    events: h.stored,
    realRules: true,
    files: { a: { episodes: [episode("e1", { endEntryId: "end-2" })], flags: { e1: CORRECTION() } } },
    verdicts: { e1: { outcome: "findings", model: "m/y", findings: [finding()] } },
  });
  await runObserveCycle(input(), later.deps);
  const state = foldObserveState(later.stored, NOW);
  assert.deepEqual(state.episodes.map((item) => [item.endEntryId, item.clean]), [["end-2", false]]);
});

test("episodes that started before the opt-in are dropped, never judged", async () => {
  const h = harness({
    events: [{ format: OBSERVE_FORMAT, type: "opt-in", at: OPT_IN_AT }],
    files: { a: { episodes: [episode("old", { startedAt: BEFORE_OPT_IN_AT }), episode("new")], flags: { old: CORRECTION(), new: CORRECTION() } } },
  });
  await runObserveCycle(input(), h.deps);
  assert.deepEqual(h.judged, ["new"]);
  assert.deepEqual(h.stored.filter((event) => event.type === "episode").map((event) => (event as { id: string }).id), ["new"]);
});

test("--since drops earlier episodes", async () => {
  const h = harness({
    events: [{ format: OBSERVE_FORMAT, type: "opt-in", at: OPT_IN_AT }],
    files: { a: { episodes: [episode("early", { startedAt: "2026-11-11T09:00:00.000Z" }), episode("late", { startedAt: "2026-11-14T09:00:00.000Z" })] } },
  });
  await runObserveCycle(input({ mode: "scan", since: "2026-11-13" }), h.deps);
  assert.deepEqual(h.stored.filter((event) => event.type === "episode").map((event) => (event as { id: string }).id), ["late"]);
});

test("an episode already stored is not judged or stored again", async () => {
  const h = harness({ files: { a: { episodes: [episode("e1")], flags: { e1: CORRECTION() } } } });
  await runObserveCycle(input(), h.deps);
  h.cursor.files = {};
  await runObserveCycle(input(), h.deps);
  assert.deepEqual(h.judged, ["e1"]);
  assert.equal(h.stored.filter((event) => event.type === "episode").length, 1);
});

test("the cursor advances for a settled file, and a second cycle reads nothing", async () => {
  const h = harness({ files: { a: { episodes: [episode("e1")] } } });
  await runObserveCycle(input(), h.deps);
  assert.deepEqual(Object.keys(h.cursor.files), ["hdr-a"]);
  const report = await runObserveCycle(input(), h.deps);
  assert.equal(report.files, 0);
});

test("an episode on a mismatched provider stays unjudged and unstored, and its file stays in the backlog", async () => {
  const h = harness({
    files: { a: { episodes: [episode("e1")], flags: { e1: CORRECTION() } } },
    providerBlocked: ["e1"],
  });
  const report = await runObserveCycle(input(), h.deps);
  assert.deepEqual(h.judged, []);
  assert.equal(h.stored.some((event) => event.type === "episode"), false);
  assert.deepEqual(h.cursor.files, {});
  assert.equal(report.blocked, 1);
});

test("the daily judge budget counts today's judged events and blocks the rest into the backlog", async () => {
  const used = Array.from({ length: 19 }, (_, index): ObserveEvent => ({ format: OBSERVE_FORMAT, type: "judged", at: "2026-11-16T08:00:00.000Z", episodeId: `p${index}`, model: "m/x", outcome: "clean" }));
  const stale: ObserveEvent = { format: OBSERVE_FORMAT, type: "judged", at: "2026-11-10T08:00:00.000Z", episodeId: "old", model: "m/x", outcome: "clean" };
  const h = harness({
    events: [{ format: OBSERVE_FORMAT, type: "opt-in", at: OPT_IN_AT }, stale, ...used],
    files: { a: { episodes: [episode("e1"), episode("e2")], flags: { e1: CORRECTION(), e2: CORRECTION() } } },
  });
  const report = await runObserveCycle(input(), h.deps);
  assert.deepEqual(h.judged, ["e1"]);
  assert.equal(report.blocked, 1);
  assert.deepEqual(h.cursor.files, {});
});

test("an unreadable file is skipped and left for the next cycle", async () => {
  const h = harness({ files: { a: { episodes: [episode("e1")] }, b: { episodes: [episode("e2")] } }, unreadable: ["/sessions/a.jsonl"] });
  const report = await runObserveCycle(input(), h.deps);
  assert.deepEqual(Object.keys(h.cursor.files), ["hdr-b"]);
  assert.equal(report.blocked, 1);
});

test("an abort during the judge stores nothing of that episode and does not advance its file", async () => {
  const controller = new AbortController();
  const h = harness({ files: { a: { episodes: [episode("e1")], flags: { e1: CORRECTION() } } } });
  h.deps.judge = async () => {
    controller.abort();
    return { outcome: "findings", model: "m/x", findings: [finding()] };
  };
  const report = await runObserveCycle(input({ signal: controller.signal }), h.deps);
  assert.equal(report.status, "interrupted");
  assert.equal(h.stored.some((event) => event.type === "episode" || event.type === "observation"), false);
  assert.deepEqual(h.cursor.files, {});
});

// ---------------------------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------------------------

test("dry-run writes no store event, no cursor and takes no lock; it judges unflagged episodes too and writes the labeling file", async () => {
  const h = harness({
    events: [],
    files: { a: { episodes: [episode("flagged", { startedAt: "2026-11-14T00:00:00.000Z" }), episode("quiet", { startedAt: "2026-11-13T00:00:00.000Z" })], flags: { flagged: CORRECTION() } } },
    verdicts: { flagged: { outcome: "findings", model: "m/x", findings: [finding()] } },
  });
  let locked = false;
  h.deps.store.withLock = async () => {
    locked = true;
    return { ok: false, error: "locked" };
  };
  const report = await runObserveCycle(input({ mode: "dry-run" }), h.deps);
  assert.equal(report.status, "done");
  assert.deepEqual(h.stored, []);
  assert.deepEqual(h.written, []);
  assert.equal(locked, false);
  assert.deepEqual(h.judged.sort(), ["flagged", "quiet"]);
  assert.equal(h.labeling.length, 1);
  assert.equal(h.labeling[0]!.name, "2026-11-16T12-00-00-000Z.jsonl");
  const records = h.labeling[0]!.text.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => [record.episodeId, record.flagged, record.judgeFound, record.label]), [
    ["flagged", true, true, null],
    ["quiet", false, false, null],
  ]);
  assert.equal(report.labeling?.records, 2);
});

test("dry-run estimates and asks before the first judge call; a refusal judges and writes nothing", async () => {
  const h = harness({ files: { a: { episodes: [episode("e1")] } }, confirm: false });
  const report = await runObserveCycle(input({ mode: "dry-run" }), h.deps);
  assert.equal(report.status, "declined");
  assert.deepEqual(h.judged, []);
  assert.deepEqual(h.labeling, []);
  assert.deepEqual(h.log, ["confirm"]);
});

test("dry-run works with the observer disabled: that is how it is measured before enabling", async () => {
  const h = harness({ files: { a: { episodes: [episode("e1")] } } });
  const report = await runObserveCycle(input({ mode: "dry-run", config: { enabled: false, judgeModel: null, judgeCallsPerDay: 20, replayAllow: [] } }), h.deps);
  assert.equal(report.status, "done");
  assert.equal(h.judged.length, 1);
});

test("dry-run samples the most recent episodes up to sampleSize, and honours --since", async () => {
  const eps = ["d1", "d2", "d3", "d4"].map((id, index) => episode(id, { startedAt: `2026-11-1${index + 1}T00:00:00.000Z` }));
  const h = harness({ files: { a: { episodes: eps } } });
  await runObserveCycle(input({ mode: "dry-run", sampleSize: 2 }), h.deps);
  assert.deepEqual(h.judged.sort(), ["d3", "d4"]);
  const h2 = harness({ files: { a: { episodes: eps } } });
  await runObserveCycle(input({ mode: "dry-run", since: "2026-11-13" }), h2.deps);
  assert.deepEqual(h2.judged.sort(), ["d3", "d4"]);
});

test("dry-run leaves failed judgements out of the labeling records and skips provider-mismatched episodes", async () => {
  const h = harness({
    files: { a: { episodes: [episode("ok", { startedAt: "2026-11-14T00:00:00.000Z" }), episode("bad", { startedAt: "2026-11-13T00:00:00.000Z" }), episode("mm", { startedAt: "2026-11-12T00:00:00.000Z" })] } },
    verdicts: { bad: { outcome: "failed", model: "m/x", findings: [] } },
    providerBlocked: ["mm"],
  });
  await runObserveCycle(input({ mode: "dry-run" }), h.deps);
  assert.deepEqual(h.judged.sort(), ["bad", "ok"]);
  const records = h.labeling[0]!.text.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.episodeId), ["ok"]);
});

// ---------------------------------------------------------------------------------------------
// Select, prepare, offer
// ---------------------------------------------------------------------------------------------

test("nothing proposable: no proposal step", async () => {
  const h = harness();
  const report = await runObserveCycle(input(), h.deps);
  assert.equal(report.proposal, "none");
  assert.deepEqual(h.shown, []);
});

test("a skill not in replayAllow goes to probation: no bank, no gate, prompt (a) then prompt (b) then dispatch", async () => {
  const h = harness({ views: [view()], gate: { class: "accepted", status: "gate-accepted", reason: null } });
  const report = await runObserveCycle(input(), h.deps);
  assert.equal(report.proposal, "review-dispatched");
  assert.deepEqual(h.shown, ["a", "b"]);
  assert.deepEqual(h.gateRuns, []);
  const proposal = h.stored.find((event) => event.type === "proposal");
  assert.ok(proposal && proposal.type === "proposal");
  assert.equal(proposal.gate, "probation");
  assert.equal(proposal.bankPath, null);
  assert.equal(proposal.provenance, null);
  assert.equal(proposal.cwd, "/work/ctx");
  assert.match(proposal.id, /^pr-[0-9a-f]{12}$/);
  const outcome = h.stored.find((event) => event.type === "gate-outcome");
  assert.ok(outcome && outcome.type === "gate-outcome");
  assert.equal(outcome.status, "probation");
  assert.equal(outcome.class, "not-measurable");
  assert.deepEqual(h.dispatched, [proposal.id]);
  assert.deepEqual(
    h.stored.filter((event) => event.type === "prompt").map((event) => event.type === "prompt" && [event.stage, event.answer]),
    [["a", "approve"], ["b", "accept"]],
  );
});

test("a replay-allowed skill with an existing bank gates against it, then asks (b)", async () => {
  const h = harness({ views: [view()], bank: { path: "banks/alpha.json", provenance: "user" } });
  const report = await runObserveCycle(input({ config: { enabled: true, judgeModel: null, judgeCallsPerDay: 20, replayAllow: ["alpha"] } }), h.deps);
  assert.equal(report.proposal, "review-dispatched");
  assert.equal(h.gateRuns.length, 1);
  assert.equal(h.gateRuns[0]!.bankPath, "banks/alpha.json");
  const proposal = h.stored.find((event) => event.type === "proposal");
  assert.ok(proposal && proposal.type === "proposal");
  assert.equal(proposal.gate, "bank");
  assert.equal(proposal.provenance, "user");
  const order = h.log.filter((entry) => entry === "propose" || entry === "gate");
  assert.deepEqual(order, ["propose", "gate"]);
});

test("an auto bank is generated before the lesson, promoted only after approval, and the gate reads the promoted path", async () => {
  const h = harness({
    views: [view()],
    selection: { kind: "ready", cwd: "/work/bank-cwd" },
    generate: { ok: true, value: "staging/draft-bank.json" },
  });
  const report = await runObserveCycle(input({ config: { enabled: true, judgeModel: null, judgeCallsPerDay: 20, replayAllow: ["alpha"] } }), h.deps);
  assert.equal(report.proposal, "review-dispatched");
  const proposal = h.stored.find((event) => event.type === "proposal");
  assert.ok(proposal && proposal.type === "proposal");
  assert.equal(proposal.provenance, "auto");
  assert.equal(proposal.bankPath, "staging/draft-bank.json");
  assert.equal(proposal.cwd, "/work/bank-cwd");
  assert.deepEqual(h.gateRuns[0]!.bankPath, "banks/staging/draft-bank.json");
  const promoteAt = h.log.indexOf("promote:staging/draft-bank.json");
  assert.ok(promoteAt > h.log.indexOf("append:proposal"));
  assert.ok(promoteAt < h.log.indexOf("gate"));
});

test("declining prompt (a) never promotes the bank nor runs the gate", async () => {
  const h = harness({ views: [view()], selection: { kind: "ready", cwd: "/w" }, generate: { ok: true, value: "staging/d.json" }, answerA: "later" });
  const report = await runObserveCycle(input({ config: { enabled: true, judgeModel: null, judgeCallsPerDay: 20, replayAllow: ["alpha"] } }), h.deps);
  assert.equal(report.proposal, "later");
  assert.deepEqual(h.gateRuns, []);
  assert.ok(!h.log.some((entry) => entry.startsWith("promote")));
  assert.deepEqual(h.shown, ["a"]);
});

test("a pending bank (too few cases) waits for 14 days, then falls to probation", async () => {
  const observation = (at: string): ObserveEvent => ({
    format: OBSERVE_FORMAT, type: "observation", at, id: "ob-1", episodeId: "e1", sessionId: "s", skill: "alpha", source: "judge", kind: "k", summary: "s", confidence: 0.5, weight: 0.3, anchorEntryId: "a", patternId: "pt-1",
  });
  const config = { enabled: true, judgeModel: null, judgeCallsPerDay: 20, replayAllow: ["alpha"] };
  const young = harness({ views: [view({ observationIds: ["ob-1"] })], events: [observation("2026-11-10T00:00:00.000Z")] });
  const waiting = await runObserveCycle(input({ config }), young.deps);
  assert.equal(waiting.proposal, "pending");
  assert.ok(!young.log.includes("propose"));

  const old = harness({ views: [view({ observationIds: ["ob-1"] })], events: [observation("2026-10-30T00:00:00.000Z")] });
  const fallen = await runObserveCycle(input({ config }), old.deps);
  assert.equal(fallen.proposal, "review-dispatched");
  const proposal = old.stored.find((event) => event.type === "proposal");
  assert.ok(proposal && proposal.type === "proposal");
  assert.equal(proposal.gate, "probation");
  assert.deepEqual(old.gateRuns, []);
});

test("a failed bank generation or a refused proposal ends the step without prompting", async () => {
  const config = { enabled: true, judgeModel: null, judgeCallsPerDay: 20, replayAllow: ["alpha"] };
  const noBank = harness({ views: [view()], selection: { kind: "ready", cwd: "/w" }, generate: { ok: false, error: "invalid" } });
  assert.equal((await runObserveCycle(input({ config }), noBank.deps)).proposal, "failed");
  assert.deepEqual(noBank.shown, []);
  const refused = harness({ views: [view()], proposal: null });
  assert.equal((await runObserveCycle(input(), refused.deps)).proposal, "failed");
  assert.deepEqual(refused.shown, []);
  assert.equal(refused.stored.some((event) => event.type === "proposal"), false);
});

test("a candidate the user or the gate already rejected is not offered again (same candidateHash)", async () => {
  const h = harness({
    views: [view()],
    events: [{ format: OBSERVE_FORMAT, type: "tombstone", at: AFTER_OPT_IN_AT, patternId: "pt-1", skill: "alpha", reason: "user-rejected", candidateHash: "h1" }],
    proposal: { stagingPath: "staging/x", candidateHash: "h1" },
  });
  const report = await runObserveCycle(input(), h.deps);
  assert.equal(report.proposal, "failed");
  assert.deepEqual(h.shown, []);
});

test("rejecting prompt (a) records a user-rejected tombstone with the candidate hash and stops", async () => {
  const h = harness({ views: [view()], answerA: "reject" });
  const report = await runObserveCycle(input(), h.deps);
  assert.equal(report.proposal, "rejected");
  const tombstone = h.stored.find((event) => event.type === "tombstone");
  assert.ok(tombstone && tombstone.type === "tombstone");
  assert.equal(tombstone.reason, "user-rejected");
  assert.equal(tombstone.candidateHash, "h1");
  assert.equal(tombstone.patternId, "pt-1");
  assert.deepEqual(h.dispatched, []);
});

for (const answer of ["later", "timeout"] as const) {
  test(`prompt (a) answered ${answer}: recorded, no tombstone, no gate`, async () => {
    const h = harness({ views: [view()], answerA: answer });
    const report = await runObserveCycle(input(), h.deps);
    assert.equal(report.proposal, "later");
    assert.equal(h.stored.some((event) => event.type === "tombstone"), false);
    const recorded = h.stored.find((event) => event.type === "prompt");
    assert.ok(recorded && recorded.type === "prompt");
    assert.equal(recorded.answer, answer);
  });
}

test("a gate that rejects records the outcome and a gate-rejected tombstone, and never asks (b)", async () => {
  const h = harness({ views: [view()], bank: { path: "banks/alpha.json", provenance: "user" }, gate: { class: "rejected", status: "below-threshold", reason: "no gain" } });
  const report = await runObserveCycle(input({ config: { enabled: true, judgeModel: null, judgeCallsPerDay: 20, replayAllow: ["alpha"] } }), h.deps);
  assert.equal(report.proposal, "gate-rejected");
  assert.deepEqual(h.shown, ["a"]);
  const tombstone = h.stored.find((event) => event.type === "tombstone");
  assert.ok(tombstone && tombstone.type === "tombstone");
  assert.equal(tombstone.reason, "gate-rejected");
  assert.equal(tombstone.candidateHash, "h1");
});

test("a retryable gate records the outcome, writes no tombstone and asks nothing more", async () => {
  const h = harness({ views: [view()], bank: { path: "banks/alpha.json", provenance: "user" }, gate: { class: "retryable", status: "interrupted", reason: "aborted" } });
  const report = await runObserveCycle(input({ config: { enabled: true, judgeModel: null, judgeCallsPerDay: 20, replayAllow: ["alpha"] } }), h.deps);
  assert.equal(report.proposal, "gate-retryable");
  assert.deepEqual(h.shown, ["a"]);
  assert.equal(h.stored.some((event) => event.type === "tombstone"), false);
  const outcome = h.stored.find((event) => event.type === "gate-outcome");
  assert.ok(outcome && outcome.type === "gate-outcome");
  assert.equal(outcome.class, "retryable");
  assert.deepEqual(h.dispatched, []);
});

const BANK_CONFIG = { enabled: true, judgeModel: null, judgeCallsPerDay: 20, replayAllow: ["alpha"] };

// The gate refuses a record that is no longer not-run (`already-concluded`), so a retryable answer cannot be retried on
// the same staged candidate: the fake below refuses it too, and the cycle must stage a fresh one.
test("a retryable gate stages a fresh candidate each time, twice at most, then offers the lesson as probation", async () => {
  const h = harness({
    views: [view()],
    bank: { path: "banks/alpha.json", provenance: "user" },
    freshCandidates: true,
    realisticGate: true,
    gate: { class: "retryable", status: "gate-abstained", reason: "interrupted" },
  });

  const steps: string[] = [];
  for (let start = 0; start < 3; start += 1) steps.push((await runObserveCycle(input({ config: BANK_CONFIG }), h.deps)).proposal);
  assert.deepEqual(steps, ["gate-retryable", "gate-retryable", "gate-retryable"]);
  assert.equal(new Set(h.stored.filter((event) => event.type === "proposal").map((event) => event.type === "proposal" && event.stagingPath)).size, 3);
  assert.equal(h.gateRuns.length, 3);
  const outcomes = h.stored.filter((event) => event.type === "gate-outcome");
  assert.deepEqual(outcomes.map((event) => event.type === "gate-outcome" && event.reason), ["interrupted", "interrupted", "interrupted"]);
  assert.deepEqual(h.dispatched, []);

  const report = await runObserveCycle(input({ config: BANK_CONFIG }), h.deps);
  assert.equal(report.proposal, "review-dispatched");
  assert.deepEqual(h.proposed.at(-1), { gate: "probation", bankPath: null });
  assert.equal(h.gateRuns.length, 3);
  const proposals = h.stored.filter((event) => event.type === "proposal");
  assert.equal(proposals.length, 4);
  const last = proposals.at(-1);
  assert.ok(last && last.type === "proposal");
  assert.deepEqual([last.gate, last.bankPath, last.provenance], ["probation", null, null]);
  const concluded = h.stored.filter((event) => event.type === "gate-outcome").at(-1);
  assert.ok(concluded && concluded.type === "gate-outcome");
  assert.deepEqual([concluded.class, concluded.status, concluded.reason, concluded.proposalId], [PROBATION_OUTCOME.class, PROBATION_OUTCOME.status, PROBATION_OUTCOME.reason, last.id]);
  assert.deepEqual(h.dispatched, [last.id]);
  assert.deepEqual(h.shown, ["a", "a", "a", "a", "b"]);
});

test("a retryable gate writes no tombstone, and no staged candidate is gated twice", async () => {
  const h = harness({ views: [view()], bank: { path: "banks/alpha.json", provenance: "user" }, freshCandidates: true, realisticGate: true, gate: { class: "retryable", status: "gate-abstained", reason: "interrupted" } });
  await runObserveCycle(input({ config: BANK_CONFIG }), h.deps);
  await runObserveCycle(input({ config: BANK_CONFIG }), h.deps);
  assert.equal(h.stored.some((event) => event.type === "tombstone"), false);
  assert.deepEqual(h.gateRuns.map((run) => run.proposalId).length, new Set(h.gateRuns.map((run) => run.proposalId)).size);
});

// The stager answers the same candidateHash for a restaged lesson (harness default "h1"), but at a staging path of its own:
// the proposal id must follow the path, or the fold (first by id) shows the new candidate the old retryable outcome.
test("a same-day restage with an identical candidateHash but a new stagingPath is a new proposal: its gate runs and (b) is not decided by the old retryable result", async () => {
  const h = harness({ views: [view()], bank: { path: "banks/alpha.json", provenance: "user" }, realisticGate: true, gate: { class: "retryable", status: "gate-abstained", reason: "interrupted" } });
  h.deps.fold = (events, now) => foldObserveState(events, now);
  const runGate = h.deps.runGate;
  h.deps.runGate = async (...args) => {
    const outcome = await runGate(...args);
    return h.gateRuns.length > 1 ? { class: "accepted", status: "gate-accepted", reason: null } : outcome;
  };

  const first = await runObserveCycle(input({ config: BANK_CONFIG }), h.deps);
  assert.equal(first.proposal, "gate-retryable");

  const propose = h.deps.propose;
  h.deps.propose = async (...args) => {
    const drafted = await propose(...args);
    return drafted.ok ? { ok: true, value: { ...drafted.value, stagingPath: "staging/y" } } : drafted;
  };
  const second = await runObserveCycle(input({ config: BANK_CONFIG }), h.deps);

  const proposals = h.stored.filter((event) => event.type === "proposal");
  assert.equal(proposals.length, 2);
  assert.deepEqual(proposals.map((event) => event.type === "proposal" && event.candidateHash), ["h1", "h1"]);
  assert.notEqual(proposals[0]!.type === "proposal" && proposals[0]!.id, proposals[1]!.type === "proposal" && proposals[1]!.id);
  assert.equal(second.proposalId, proposals[1]!.type === "proposal" ? proposals[1]!.id : null);
  assert.equal(h.gateRuns.length, 2);
  assert.notEqual(h.gateRuns[0]!.proposalId, h.gateRuns[1]!.proposalId);
  assert.equal(second.proposal, "review-dispatched");
  assert.deepEqual(h.shown, ["a", "a", "b"]);
  assert.deepEqual(h.dispatched, [second.proposalId]);
});

// ---------------------------------------------------------------------------------------------
// A collaborator that throws does not take the cycle down
// ---------------------------------------------------------------------------------------------

test("a discardArtifacts that throws is reported in discardFailed and the cycle goes on with the next pattern", async () => {
  const h = harness({ views: [view({ id: "pt-1", skill: "alpha" }), view({ id: "pt-2", skill: "beta" })] });
  const propose = h.deps.propose;
  let proposes = 0;
  h.deps.propose = async (...args) => {
    const drafted = await propose(...args);
    proposes += 1;
    if (proposes === 1) forgetNow(h);
    return drafted;
  };
  h.deps.discardArtifacts = async () => {
    throw new Error("scan lock busy");
  };
  const report = await runObserveCycle(input(), h.deps);

  assert.equal(report.status, "done");
  assert.deepEqual(report.discardFailed, ["alpha"]);
  assert.equal(proposes, 2);
  assert.equal(report.proposal, "review-dispatched");
  const proposals = h.stored.filter((event) => event.type === "proposal");
  assert.deepEqual(proposals.map((event) => event.type === "proposal" && event.patternId), ["pt-2"]);
  assert.deepEqual(h.dispatched, [report.proposalId]);

  const quiet = await runObserveCycle(input(), harness({ views: [view()] }).deps);
  assert.deepEqual(quiet.discardFailed, []);
});

test("a judge that throws is stored with the model \"unknown\" and the event validates against the observe-event schema", async () => {
  const id = "ep-0123456789ab";
  const h = harness({ files: { a: { episodes: [episode(id)], flags: { [id]: CORRECTION() } } } });
  h.deps.judge = async () => {
    throw new Error("network down");
  };
  await runObserveCycle(input(), h.deps);
  const judged = h.stored.find((event) => event.type === "judged");
  assert.ok(judged && judged.type === "judged");
  assert.equal(judged.model, "unknown");
  assert.deepEqual(validateAgainstObserveEventSchema(judged), []);
});

test("the proposable patterns are tried in order until one reaches a dialog; each failed preparation is persisted", async () => {
  const h = harness({ views: [view({ id: "pt-1" }), view({ id: "pt-2" })] });
  const propose = h.deps.propose;
  let calls = 0;
  h.deps.propose = async (request, signal) => {
    calls += 1;
    return calls === 1 ? { ok: false, error: "refused" } : propose(request, signal);
  };
  const report = await runObserveCycle(input(), h.deps);
  assert.equal(report.proposal, "review-dispatched");
  const proposal = h.stored.find((event) => event.type === "proposal");
  assert.ok(proposal && proposal.type === "proposal");
  assert.equal(proposal.patternId, "pt-2");
  const failed = h.stored.filter((event) => event.type === "prepare-failed");
  assert.equal(failed.length, 1);
  assert.ok(failed[0] && failed[0].type === "prepare-failed");
  assert.deepEqual([failed[0].patternId, failed[0].skill], ["pt-1", "alpha"]);
  assert.match(failed[0].reason, /proposal refused: refused/);
  assert.deepEqual(h.shown, ["a", "b"]);
});

test("a pattern whose bank is still pending does not hold back the next one", async () => {
  const h = harness({ views: [view({ id: "pt-1" }), view({ id: "pt-2", skill: "beta" })] });
  const report = await runObserveCycle(input({ config: BANK_CONFIG }), h.deps);
  assert.equal(report.proposal, "review-dispatched");
  const failed = h.stored.find((event) => event.type === "prepare-failed");
  assert.ok(failed && failed.type === "prepare-failed");
  assert.equal(failed.patternId, "pt-1");
  assert.match(failed.reason, /bank pending: too few/);
  const proposal = h.stored.find((event) => event.type === "proposal");
  assert.ok(proposal && proposal.type === "proposal");
  assert.equal(proposal.patternId, "pt-2");
});

test("when no pattern reaches a dialog the cycle reports the first failure and persists one prepare-failed per pattern", async () => {
  const h = harness({ views: [view({ id: "pt-1" }), view({ id: "pt-2" })], proposal: null });
  const report = await runObserveCycle(input(), h.deps);
  assert.equal(report.proposal, "failed");
  assert.equal(report.proposalId, null);
  assert.deepEqual(h.stored.filter((event) => event.type === "prepare-failed").map((event) => event.type === "prepare-failed" && event.patternId), ["pt-1", "pt-2"]);
  assert.deepEqual(h.shown, []);
});

function seededPattern(patternId = "pt-seed"): ObserveEvent[] {
  return ["2026-11-13T09:00:00.000Z", "2026-11-15T09:00:00.000Z"].flatMap((startedAt, index): ObserveEvent[] => {
    const owner = episode(`seed-${index}`, { startedAt, sessionId: `seed-session-${index}` });
    return [
      { format: OBSERVE_FORMAT, type: "episode", at: startedAt, ...owner, flags: [], clean: false },
      {
        format: OBSERVE_FORMAT,
        type: "observation",
        at: startedAt,
        id: `ob-seed-${index}`,
        episodeId: owner.id,
        sessionId: owner.sessionId,
        skill: "alpha",
        source: "user-note",
        kind: "note",
        summary: "use a table",
        confidence: null,
        weight: 1,
        anchorEntryId: `anchor-seed-${index}`,
        patternId,
      },
    ];
  });
}

const HOUR = 60 * 60 * 1000;

test("a pattern whose proposal failed to prepare is not tried again for 24h, then 72h", async () => {
  const h = harness({ events: [{ format: OBSERVE_FORMAT, type: "opt-in", at: OPT_IN_AT }, ...seededPattern()], realRules: true, proposal: null });
  const at = (hours: number) => input({ now: new Date(NOW.getTime() + hours * HOUR) });

  assert.equal((await runObserveCycle(at(0), h.deps)).proposal, "failed");
  assert.equal(h.proposed.length, 1);
  assert.equal((await runObserveCycle(at(23), h.deps)).proposal, "none");
  assert.equal(h.proposed.length, 1);
  assert.equal((await runObserveCycle(at(25), h.deps)).proposal, "failed");
  assert.equal(h.proposed.length, 2);
  assert.equal((await runObserveCycle(at(25 + 71), h.deps)).proposal, "none");
  assert.equal(h.proposed.length, 2);
  assert.equal((await runObserveCycle(at(25 + 73), h.deps)).proposal, "failed");
  assert.equal(h.proposed.length, 3);
});

const UNUSABLE = "banks/alpha.json exists and cannot be used as a bank: unreadable";

test("a bank that exists and cannot be used fails that pattern's preparation and the next pattern still reaches its dialog", async () => {
  const h = harness({
    views: [view({ id: "pt-1", skill: "alpha" }), view({ id: "pt-2", skill: "beta" })],
    bank: { path: "banks/beta.json", provenance: "user" },
    resolveError: { alpha: UNUSABLE },
    selection: { kind: "ready", cwd: "/w" },
    generate: { ok: true, value: "staging/d.json" },
  });
  const report = await runObserveCycle(input({ config: { ...BANK_CONFIG, replayAllow: ["alpha", "beta"] } }), h.deps);
  assert.equal(report.status, "done");
  assert.equal(report.proposal, "review-dispatched");
  const failed = h.stored.filter((event) => event.type === "prepare-failed");
  assert.equal(failed.length, 1);
  assert.ok(failed[0] && failed[0].type === "prepare-failed");
  assert.deepEqual([failed[0].patternId, failed[0].skill], ["pt-1", "alpha"]);
  assert.equal(failed[0].reason, UNUSABLE);
  const proposal = h.stored.find((event) => event.type === "proposal");
  assert.ok(proposal && proposal.type === "proposal");
  assert.equal(proposal.patternId, "pt-2");
  assert.deepEqual(h.shown, ["a", "b"]);
  assert.deepEqual(h.generated, []);
});

test("an unusable bank alone is reported as a failed preparation with its reason, redacted", async () => {
  const h = harness({ views: [view()], resolveError: { alpha: `exists and cannot be used as a bank ${FAKE_SECRETS.githubToken}` } });
  const report = await runObserveCycle(input({ config: BANK_CONFIG }), h.deps);
  assert.equal(report.status, "done");
  assert.equal(report.proposal, "failed");
  const failed = h.stored.find((event) => event.type === "prepare-failed");
  assert.ok(failed && failed.type === "prepare-failed");
  assert.match(failed.reason, /cannot be used as a bank \[REDACTED\]/);
  assert.deepEqual(h.generated, []);
  assert.deepEqual(h.shown, []);
});

test("a pattern with an unusable bank is skipped for 24h and no bank is ever generated over it", async () => {
  const h = harness({
    events: [{ format: OBSERVE_FORMAT, type: "opt-in", at: OPT_IN_AT }, ...seededPattern()],
    realRules: true,
    resolveError: { alpha: UNUSABLE },
    selection: { kind: "ready", cwd: "/w" },
    generate: { ok: true, value: "staging/d.json" },
  });
  const at = (hours: number) => input({ config: BANK_CONFIG, now: new Date(NOW.getTime() + hours * HOUR) });

  assert.equal((await runObserveCycle(at(0), h.deps)).proposal, "failed");
  assert.equal(h.resolved.length, 1);
  assert.equal((await runObserveCycle(at(23), h.deps)).proposal, "none");
  assert.equal(h.resolved.length, 1);
  assert.equal(h.stored.filter((event) => event.type === "prepare-failed").length, 1);
  assert.equal((await runObserveCycle(at(25), h.deps)).proposal, "failed");
  assert.equal(h.resolved.length, 2);
  assert.deepEqual(h.generated, []);
});

test("a bank promotion that conflicts marks the proposal failed instead of throwing, and the pattern backs off", async () => {
  const h = harness({
    views: [view()],
    selection: { kind: "ready", cwd: "/w" },
    generate: { ok: true, value: "staging/d.json" },
    promoteError: "banks/alpha.json already exists with other content",
  });
  const report = await runObserveCycle(input({ config: BANK_CONFIG }), h.deps);
  assert.equal(report.status, "done");
  assert.equal(report.proposal, "failed");
  assert.deepEqual(h.gateRuns, []);
  assert.deepEqual(h.shown, ["a"]);
  const failed = h.stored.find((event) => event.type === "prepare-failed");
  assert.ok(failed && failed.type === "prepare-failed");
  assert.equal(failed.patternId, "pt-1");
  assert.match(failed.reason, /bank promotion failed: banks\/alpha\.json already exists/);
  assert.equal(h.dispatched.length, 0);
});

test("an accepted lesson is not offered again at any later start, and a new observation after the acceptance reopens the pattern", async () => {
  const staged: ObserveEvent = {
    format: OBSERVE_FORMAT,
    type: "proposal",
    at: "2026-11-15T10:00:00.000Z",
    id: "pr-aaaaaaaaaaaa",
    patternId: "pt-seed",
    skill: "alpha",
    stagingPath: "staging/accepted",
    candidateHash: "h-accepted",
    gate: "probation",
    bankPath: null,
    provenance: null,
    cwd: "/work/ctx",
    skillContentHash: "c".repeat(64),
  };
  const h = harness({
    events: [{ format: OBSERVE_FORMAT, type: "opt-in", at: OPT_IN_AT }, ...seededPattern(), staged],
    realRules: true,
    accepted: ["pr-aaaaaaaaaaaa"],
    proposal: { stagingPath: "staging/next", candidateHash: "h-next" },
  });

  for (let start = 0; start < 3; start += 1) {
    const report = await runObserveCycle(input(), h.deps);
    assert.equal(report.proposal, "none");
  }
  assert.deepEqual(h.shown, []);
  assert.deepEqual(h.proposed, []);
  const closed = h.stored.filter((event) => event.type === "tombstone");
  assert.equal(closed.length, 1);
  assert.ok(closed[0] && closed[0].type === "tombstone");
  assert.deepEqual([closed[0].reason, closed[0].candidateHash, closed[0].patternId], ["accepted", "h-accepted", "pt-seed"]);

  // Something new is seen after the acceptance.
  const startedAt = "2026-11-17T08:00:00.000Z";
  const fresh = episode("seed-new", { startedAt, sessionId: "seed-session-new" });
  h.stored.push(
    { format: OBSERVE_FORMAT, type: "episode", at: startedAt, ...fresh, flags: [], clean: false },
    { format: OBSERVE_FORMAT, type: "observation", at: startedAt, id: "ob-seed-new", episodeId: fresh.id, sessionId: fresh.sessionId, skill: "alpha", source: "user-note", kind: "note", summary: "use a table again", confidence: null, weight: 1, anchorEntryId: "anchor-new", patternId: "pt-seed" },
  );
  const reopened = await runObserveCycle(input({ now: new Date("2026-11-17T12:00:00.000Z") }), h.deps);
  assert.equal(reopened.proposal, "review-dispatched");
  assert.equal(h.proposed.length, 1);
  const proposals = h.stored.filter((event) => event.type === "proposal");
  assert.equal(proposals.length, 2);
  assert.equal(proposals[1]!.type === "proposal" && proposals[1]!.candidateHash, "h-next");
});

test("a lesson the ledger does not show as accepted stays on offer", async () => {
  const staged: ObserveEvent = {
    format: OBSERVE_FORMAT,
    type: "proposal",
    at: "2026-11-15T10:00:00.000Z",
    id: "pr-bbbbbbbbbbbb",
    patternId: "pt-seed",
    skill: "alpha",
    stagingPath: "staging/open",
    candidateHash: "h-open",
    gate: "probation",
    bankPath: null,
    provenance: null,
    cwd: "/work/ctx",
    skillContentHash: "c".repeat(64),
  };
  const h = harness({ events: [{ format: OBSERVE_FORMAT, type: "opt-in", at: OPT_IN_AT }, ...seededPattern(), staged], realRules: true, answerB: "later" });
  const report = await runObserveCycle(input(), h.deps);
  assert.equal(report.proposal, "awaiting-review");
  assert.equal(report.proposalId, "pr-bbbbbbbbbbbb");
  assert.equal(h.stored.some((event) => event.type === "tombstone"), false);
});

test("a re-offer of a snoozed proposal with its gate concluded goes straight to (b), without a new proposal or gate", async () => {
  const h = harness({ views: [view()], answerB: "later" });
  await runObserveCycle(input(), h.deps);
  h.shown.length = 0;
  h.log.length = 0;
  const report = await runObserveCycle(input(), h.deps);
  assert.equal(report.proposal, "awaiting-review");
  assert.deepEqual(h.shown, ["b"]);
  assert.ok(!h.log.includes("propose"));
  assert.ok(!h.log.includes("gate"));
});

test("not-measurable and accepted outcomes both reach prompt (b), carrying the outcome", async () => {
  for (const klass of ["accepted", "not-measurable"] as const) {
    const h = harness({ views: [view()], bank: { path: "banks/alpha.json", provenance: "user" }, gate: { class: klass, status: "x", reason: null } });
    let seen: GateOutcomeView | undefined;
    h.deps.offerB = async (offer) => {
      seen = offer.outcome;
      return "accept";
    };
    await runObserveCycle(input({ config: { enabled: true, judgeModel: null, judgeCallsPerDay: 20, replayAllow: ["alpha"] } }), h.deps);
    assert.equal(seen?.class, klass);
  }
});

test("prompt (b): later and timeout leave the review to the user; reject tombstones; none dispatches", async () => {
  for (const answer of ["later", "timeout"] as const) {
    const h = harness({ views: [view()], answerB: answer });
    const report = await runObserveCycle(input(), h.deps);
    assert.equal(report.proposal, "awaiting-review");
    assert.deepEqual(h.dispatched, []);
    assert.equal(h.stored.some((event) => event.type === "tombstone"), false);
  }
  const rejected = harness({ views: [view()], answerB: "reject" });
  assert.equal((await runObserveCycle(input(), rejected.deps)).proposal, "rejected");
  assert.equal(rejected.stored.some((event) => event.type === "tombstone"), true);
  assert.deepEqual(rejected.dispatched, []);
});

test("an abort while a dialog is open records no answer and dispatches nothing", async () => {
  const controller = new AbortController();
  const h = harness({ views: [view()] });
  h.deps.offerA = async () => {
    controller.abort();
    return "timeout";
  };
  const report = await runObserveCycle(input({ signal: controller.signal }), h.deps);
  assert.equal(report.status, "interrupted");
  assert.equal(h.stored.some((event) => event.type === "prompt"), false);
  assert.deepEqual(h.dispatched, []);
});

test("the gate and the dialogs never run under the scan lock", async () => {
  const h = harness({ views: [view()], bank: { path: "banks/alpha.json", provenance: "user" } });
  let inLock = false;
  const seen: boolean[] = [];
  const withLock = h.deps.store.withLock;
  h.deps.store.withLock = async (fn) => withLock(async (signal) => {
    inLock = true;
    try {
      return await fn(signal);
    } finally {
      inLock = false;
    }
  });
  const gate = h.deps.runGate;
  h.deps.runGate = async (request, signal) => {
    seen.push(inLock);
    return gate(request, signal);
  };
  h.deps.offerA = async () => {
    seen.push(inLock);
    return "approve";
  };
  await runObserveCycle(input({ config: { enabled: true, judgeModel: null, judgeCallsPerDay: 20, replayAllow: ["alpha"] } }), h.deps);
  assert.deepEqual(seen, [false, false]);
});

test("at most one proposal is offered per cycle even when several are proposable", async () => {
  const h = harness({ views: [view({ id: "pt-1" }), view({ id: "pt-2" })] });
  await runObserveCycle(input(), h.deps);
  assert.equal(h.stored.filter((event) => event.type === "proposal").length, 1);
  const proposal = h.stored.find((event) => event.type === "proposal");
  assert.ok(proposal && proposal.type === "proposal");
  assert.equal(proposal.patternId, "pt-1");
});

// ---------------------------------------------------------------------------------------------
// A forget while the offer phase awaits something
// ---------------------------------------------------------------------------------------------

type Harness = ReturnType<typeof harness>;

const FORGET_AT = new Date(NOW.getTime() + 1000).toISOString();

// The user runs `--forget alpha` while the cycle is waiting on a collaborator: the event lands in the store at that moment.
function forgetNow(h: Harness): void {
  h.stored.push({ format: OBSERVE_FORMAT, type: "forget", at: FORGET_AT, skill: "alpha" });
}

const OFFER_PHASE_TYPES: ObserveEvent["type"][] = ["proposal", "prompt", "gate-outcome", "tombstone", "prepare-failed"];
const writtenInOfferPhase = (h: Harness) => h.stored.filter((event) => OFFER_PHASE_TYPES.includes(event.type)).map((event) => event.type);

test("a forget during bank.generate leaves nothing: the artifacts are discarded, nothing is proposed, no dialog shows", async () => {
  const h = harness({ views: [view()], selection: { kind: "ready", cwd: "/w" }, generate: { ok: true, value: "staging/d.json" } });
  const generate = h.deps.bank.generate;
  h.deps.bank.generate = async (...args) => {
    const generated = await generate(...args);
    forgetNow(h);
    return generated;
  };
  const report = await runObserveCycle(input({ config: BANK_CONFIG }), h.deps);

  assert.equal(report.proposal, "none");
  assert.deepEqual(h.discarded, ["alpha"]);
  assert.deepEqual(h.proposed, []);
  assert.deepEqual(h.shown, []);
  assert.deepEqual(h.gateRuns, []);
  assert.deepEqual(writtenInOfferPhase(h), []);
});

test("a forget during propose leaves nothing: the staged candidate is discarded, no proposal is written, no dialog shows", async () => {
  const h = harness({ views: [view()] });
  const propose = h.deps.propose;
  h.deps.propose = async (...args) => {
    const drafted = await propose(...args);
    forgetNow(h);
    return drafted;
  };
  const report = await runObserveCycle(input(), h.deps);

  assert.equal(report.proposal, "none");
  assert.equal(h.proposed.length, 1);
  assert.deepEqual(h.discarded, ["alpha"]);
  assert.deepEqual(h.shown, []);
  assert.deepEqual(writtenInOfferPhase(h), []);
});

test("a forget during runGate records no outcome, shows no further dialog and discards what was made", async () => {
  const h = harness({ views: [view()], bank: { path: "banks/alpha.json", provenance: "user" } });
  const runGate = h.deps.runGate;
  h.deps.runGate = async (...args) => {
    const outcome = await runGate(...args);
    forgetNow(h);
    return outcome;
  };
  const report = await runObserveCycle(input({ config: BANK_CONFIG }), h.deps);

  assert.equal(report.proposal, "none");
  assert.deepEqual(h.shown, ["a"]);
  assert.deepEqual(h.dispatched, []);
  assert.deepEqual(h.discarded, ["alpha"]);
  assert.equal(h.stored.some((event) => event.type === "gate-outcome"), false);
  // What the proposal wrote before the forget is folded away with the skill.
  const folded = foldObserveState(h.stored, NOW);
  assert.deepEqual([folded.proposals.length, folded.prompts.length, folded.gateOutcomes.length], [0, 0, 0]);
});

test("a forget before the auto bank is promoted promotes nothing and runs no gate", async () => {
  const h = harness({ views: [view()], selection: { kind: "ready", cwd: "/w" }, generate: { ok: true, value: "staging/d.json" } });
  const offerA = h.deps.offerA;
  h.deps.offerA = async (...args) => {
    const answer = await offerA(...args);
    forgetNow(h);
    return answer;
  };
  await runObserveCycle(input({ config: BANK_CONFIG }), h.deps);

  assert.ok(!h.log.some((entry) => entry.startsWith("promote")));
  assert.deepEqual(h.gateRuns, []);
  assert.deepEqual(h.discarded, ["alpha"]);
  assert.equal(h.stored.some((event) => event.type === "prompt"), false);
});

test("a forget while prompt (b) is open records no answer and dispatches no review", async () => {
  const h = harness({ views: [view()] });
  const offerB = h.deps.offerB;
  h.deps.offerB = async (...args) => {
    const answer = await offerB(...args);
    forgetNow(h);
    return answer;
  };
  await runObserveCycle(input(), h.deps);

  assert.deepEqual(h.dispatched, []);
  assert.deepEqual(h.discarded, ["alpha"]);
  assert.equal(h.stored.some((event) => event.type === "prompt" && event.stage === "b"), false);
});

test("a forget that happened before this cycle started does not stop a proposal of the skill's new patterns", async () => {
  const before = new Date(NOW.getTime() - HOUR).toISOString();
  const h = harness({
    views: [view()],
    events: [
      { format: OBSERVE_FORMAT, type: "opt-in", at: OPT_IN_AT },
      { format: OBSERVE_FORMAT, type: "forget", at: before, skill: "alpha" },
    ],
  });
  const report = await runObserveCycle(input(), h.deps);

  assert.equal(report.proposal, "review-dispatched");
  assert.deepEqual(h.discarded, []);
});

// ---------------------------------------------------------------------------------------------
// Only the latest proposal of a pattern is live
// ---------------------------------------------------------------------------------------------

function stagedProbation(id: string, at: string, candidateHash: string, patternId = "pt-1"): ObserveEvent {
  return {
    format: OBSERVE_FORMAT,
    type: "proposal",
    at,
    id,
    patternId,
    skill: "alpha",
    stagingPath: `staging/${id}`,
    candidateHash,
    gate: "probation",
    bankPath: null,
    provenance: null,
    cwd: "/work/ctx",
    skillContentHash: sha256Digest("SKILL.md of alpha"),
  };
}

test("two restaged proposals of one pattern: only the latest is reused; the earlier one is never offered, gated or dispatched again", async () => {
  const earlier = stagedProbation("pr-111111111111", "2026-11-14T10:00:00.000Z", "h-1");
  const latest = stagedProbation("pr-222222222222", "2026-11-15T10:00:00.000Z", "h-2");
  const h = harness({
    // Listed latest first: the order of the log does not decide.
    events: [
      { format: OBSERVE_FORMAT, type: "opt-in", at: OPT_IN_AT },
      latest,
      earlier,
      { format: OBSERVE_FORMAT, type: "prompt", at: "2026-11-14T10:10:00.000Z", proposalId: "pr-111111111111", stage: "a", answer: "approve" },
      { format: OBSERVE_FORMAT, type: "gate-outcome", at: "2026-11-14T10:11:00.000Z", proposalId: "pr-111111111111", class: "accepted", status: "gate-accepted", reason: null },
    ],
    views: [view()],
    answerA: "later",
  });
  const report = await runObserveCycle(input(), h.deps);

  assert.equal(report.proposalId, "pr-222222222222");
  assert.equal(report.proposal, "later");
  assert.deepEqual(h.shown, ["a"]);
  assert.deepEqual(h.proposed, []);
  assert.deepEqual(h.gateRuns, []);
  assert.deepEqual(h.dispatched, []);
});

// ---------------------------------------------------------------------------------------------
// A stale proposal does not come back every day at prompt (b)
// ---------------------------------------------------------------------------------------------

const PROPOSAL_VIEW: ProposalView = {
  skill: "alpha",
  patternSummary: "use a table",
  observations: ["use a table"],
  sessions: 2,
  days: 2,
  realRuns: 0,
  lesson: "Use a table.",
  gate: "probation",
  cwd: "/work/ctx",
  bank: null,
};

test("an acceptance refused as skill-drift closes the proposal for good: prompt (b) is not offered again at any later start", async () => {
  const staged = stagedProbation("pr-dddddddddddd", "2026-11-15T10:00:00.000Z", sha256Digest("candidate"), "pt-seed");
  const events: ObserveEvent[] = [
    { format: OBSERVE_FORMAT, type: "opt-in", at: OPT_IN_AT },
    ...seededPattern(),
    staged,
    { format: OBSERVE_FORMAT, type: "prompt", at: "2026-11-15T10:10:00.000Z", proposalId: "pr-dddddddddddd", stage: "a", answer: "approve" },
    { format: OBSERVE_FORMAT, type: "gate-outcome", at: "2026-11-15T10:11:00.000Z", proposalId: "pr-dddddddddddd", class: "not-measurable", status: "probation", reason: "not measured" },
  ];

  // Control: with the proposal still open, the start offers (b).
  const open = harness({ events: [...events], realRules: true });
  await runObserveCycle(input(), open.deps);
  assert.deepEqual(open.shown, ["b"]);

  // The user accepts at (b); the skill was edited since staging, so the real review refuses and closes the proposal.
  const store = [...events];
  const reviewDeps: ReviewDeps = {
    now: () => NOW,
    readState: async () => foldObserveState(store, NOW),
    isAccepted: async () => false,
    viewOf: async () => PROPOSAL_VIEW,
    promoteBank: async () => null,
    runGate: async () => {
      throw new Error("a probation proposal is never gated");
    },
    accept: async () => ({ ok: false, error: { reason: "skill-drift", detail: "SKILL.md changed" } }),
    append: async (appended) => {
      store.push(...appended);
    },
  };
  const ui = fakeUi([{ kind: "select", answer: "Accept" }]);
  assert.equal(await reviewProposal("pr-dddddddddddd", { ui: ui.ui }, reviewDeps), "retryable");

  // Every later start, the same day and the days after, shows nothing and stages nothing.
  for (const hours of [0, 25, 49]) {
    const closed = harness({ events: [...store], realRules: true, proposal: { stagingPath: "staging/next", candidateHash: "h-next" } });
    const report = await runObserveCycle(input({ now: new Date(NOW.getTime() + hours * HOUR) }), closed.deps);
    assert.equal(report.proposal, "none", `start +${hours}h`);
    assert.deepEqual(closed.shown, [], `start +${hours}h`);
    assert.deepEqual(closed.proposed, [], `start +${hours}h`);
  }

  // A session that started after the closing is new evidence and reopens the pattern.
  const startedAt = "2026-11-17T08:00:00.000Z";
  const fresh = episode("seed-new", { startedAt, sessionId: "seed-session-new" });
  store.push(
    { format: OBSERVE_FORMAT, type: "episode", at: startedAt, ...fresh, flags: [], clean: false },
    { format: OBSERVE_FORMAT, type: "observation", at: startedAt, id: "ob-seed-new", episodeId: fresh.id, sessionId: fresh.sessionId, skill: "alpha", source: "user-note", kind: "note", summary: "use a table again", confidence: null, weight: 1, anchorEntryId: "anchor-new", patternId: "pt-seed" },
  );
  const reopened = harness({ events: [...store], realRules: true });
  assert.equal((await runObserveCycle(input({ now: new Date("2026-11-17T12:00:00.000Z") }), reopened.deps)).proposal, "review-dispatched");
});

test("a session that ended before a closed proposal and is ingested after it does not reopen the pattern", async () => {
  const staged = stagedProbation("pr-eeeeeeeeeeee", "2026-11-15T10:00:00.000Z", sha256Digest("candidate"), "pt-seed");
  const closing = { format: OBSERVE_FORMAT, type: "tombstone", at: "2026-11-16T11:00:00.000Z", patternId: "pt-seed", skill: "alpha", reason: "stale", candidateHash: sha256Digest("candidate") } as const;
  const late = episode("late", { startedAt: "2026-11-14T08:00:00.000Z", sessionId: "late-session" });
  const h = harness({
    events: [
      { format: OBSERVE_FORMAT, type: "opt-in", at: OPT_IN_AT },
      ...seededPattern(),
      staged,
      closing,
    ],
    realRules: true,
    files: { a: { episodes: [late], flags: { late: CORRECTION() } } },
    verdicts: { late: { outcome: "findings", model: "m/x", findings: [finding({ patternRef: "pt-seed" })] } },
    proposal: { stagingPath: "staging/next", candidateHash: "h-next" },
  });
  h.deps.assignPattern = () => "pt-seed";

  const report = await runObserveCycle(input(), h.deps);

  // The old session is read now (after the closing) and joins the pattern, but it is evidence from before it.
  assert.equal(h.stored.filter((event) => event.type === "observation" && event.patternId === "pt-seed").length >= 3, true);
  assert.equal(report.proposal, "none");
  assert.deepEqual(h.shown, []);
  assert.deepEqual(h.proposed, []);
});

// ---------------------------------------------------------------------------------------------
// A skill the user no longer allows is not replayed
// ---------------------------------------------------------------------------------------------

test("a bank proposal of a skill no longer in replayAllow: no dialog, no promotion, no gate; retryable, and the restage is probation", async () => {
  const staged: ObserveEvent = {
    ...(stagedProbation("pr-ffffffffffff", "2026-11-15T10:00:00.000Z", "h-bank") as Extract<ObserveEvent, { type: "proposal" }>),
    gate: "bank",
    bankPath: "staging/observer-banks/alpha-x/case-bank.json",
    provenance: "auto",
  };
  const h = harness({ events: [{ format: OBSERVE_FORMAT, type: "opt-in", at: OPT_IN_AT }, staged], views: [view()] });

  const first = await runObserveCycle(input(), h.deps);

  assert.equal(first.proposal, "gate-retryable");
  assert.deepEqual(h.shown, []);
  assert.ok(!h.log.some((entry) => entry.startsWith("promote")));
  assert.deepEqual(h.gateRuns, []);
  const outcome = h.stored.find((event) => event.type === "gate-outcome");
  assert.ok(outcome && outcome.type === "gate-outcome");
  assert.deepEqual([outcome.proposalId, outcome.class, outcome.reason], ["pr-ffffffffffff", "retryable", "replay-not-allowed"]);

  const second = await runObserveCycle(input(), h.deps);
  assert.equal(second.proposal, "review-dispatched");
  assert.deepEqual(h.proposed.at(-1), { gate: "probation", bankPath: null });
  assert.deepEqual(h.gateRuns, []);
});

// ---------------------------------------------------------------------------------------------
// What the cycle writes is what the schema describes
// ---------------------------------------------------------------------------------------------

test("every event of the offer phase the cycle builds validates against the observe-event schema, with production-form hashes", async () => {
  const pattern = observeId("pt", ["alpha", "p"]);
  const h = harness({
    views: [view({ id: pattern })],
    selection: { kind: "ready", cwd: "/work/bank-cwd" },
    generate: { ok: true, value: "staging/observer-banks/alpha-x/case-bank.json" },
    proposal: { stagingPath: "staging/20261116T120000000Z/alpha", candidateHash: sha256Digest("candidate lesson") },
  });
  await runObserveCycle(input({ config: BANK_CONFIG }), h.deps);

  const proposal = h.stored.find((event) => event.type === "proposal");
  assert.ok(proposal && proposal.type === "proposal");
  assert.match(proposal.skillContentHash, /^sha256:[0-9a-f]{64}$/);
  const lines = h.stored.filter((event) => OFFER_PHASE_TYPES.includes(event.type));
  assert.deepEqual(lines.map((event) => event.type), ["proposal", "prompt", "gate-outcome", "prompt"]);
  for (const line of lines) assert.deepEqual(validateAgainstObserveEventSchema(line), [], line.type);
});
