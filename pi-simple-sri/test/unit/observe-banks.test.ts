import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MIN_CASES } from "../../src/case-bank.ts";
import { bankPathOf, resolveBank, selectBankEpisodes } from "../../src/observe/banks.ts";
import type { EpisodeEvent, ObservationEvent, ObserveState, PatternView } from "../../src/observe/types.ts";
import { OBSERVE_FORMAT } from "../../src/observe/types.ts";
import { FAKE_SECRETS, FIXTURE_NOW, fixturePath, installFixtureSkill, makeAgentDir } from "./observe-fixtures.ts";

// WP9: which bank measures a skill, and which episodes may become the cases of a missing one. Banks are real files in a
// mkdtemp; the state is built by hand, because selection only reads it.

function putBank(base: string, skill: string, fixture: string): string {
  const target = bankPathOf(base, skill);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(fixturePath("banks", fixture), target);
  return target;
}

test("resolveBank: the bank of the user wins over the one the skill ships, and a bank without provenance is the user's", async (t) => {
  const env = makeAgentDir(t);
  const realDir = installFixtureSkill(env.skillsDir, "ships-bank");
  const own = putBank(env.base, "ships-bank", "user.json");

  const resolved = await resolveBank(env.base, { name: "ships-bank", realDir });

  assert.equal(resolved.kind, "found");
  assert.equal(resolved.kind === "found" && resolved.path, own);
  assert.equal(resolved.kind === "found" && resolved.provenance, "user");
  assert.equal(resolved.kind === "found" && resolved.bank.cases[0]?.id, "breaking-only");
});

test("resolveBank: the provenance of the file is kept", async (t) => {
  const env = makeAgentDir(t);
  putBank(env.base, "demo-skill", "auto.json");

  const resolved = await resolveBank(env.base, { name: "demo-skill", realDir: env.skillsDir });

  assert.equal(resolved.kind === "found" && resolved.provenance, "auto");
});

test("resolveBank: without a bank of the user, the one the skill ships is read as skill-shipped", async (t) => {
  const env = makeAgentDir(t);
  const realDir = installFixtureSkill(env.skillsDir, "ships-bank");

  const resolved = await resolveBank(env.base, { name: "ships-bank", realDir });

  assert.equal(resolved.kind === "found" && resolved.path, path.join(realDir, "case-bank.json"));
  assert.equal(resolved.kind === "found" && resolved.provenance, "skill-shipped");
  assert.equal(resolved.kind === "found" && resolved.bank.cases.length, 2);
});

test("resolveBank: no bank anywhere is absent", async (t) => {
  const env = makeAgentDir(t);
  const realDir = installFixtureSkill(env.skillsDir, "read-only");

  assert.deepEqual(await resolveBank(env.base, { name: "read-only", realDir }), { kind: "absent" });
});

test("resolveBank: a shipped bank that cannot be read is unusable, not absent", async (t) => {
  const env = makeAgentDir(t);
  const realDir = installFixtureSkill(env.skillsDir, "read-only");
  const legacy = path.join(realDir, "case-bank.json");
  fs.writeFileSync(legacy, "{ not json", "utf8");

  assert.deepEqual(await resolveBank(env.base, { name: "read-only", realDir }), { kind: "unusable", path: legacy });
});

test("resolveBank: a bank of the user that cannot be read is unusable and does not fall back to the shipped one", async (t) => {
  const env = makeAgentDir(t);
  const realDir = installFixtureSkill(env.skillsDir, "ships-bank");
  const own = bankPathOf(env.base, "ships-bank");
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, "{ not json", "utf8");

  assert.deepEqual(await resolveBank(env.base, { name: "ships-bank", realDir }), { kind: "unusable", path: own });
});

test("resolveBank: a bank of the user that is invalid (parses, fails the format) is unusable too", async (t) => {
  const env = makeAgentDir(t);
  const own = putBank(env.base, "demo-skill", "invalid-no-positive-check.json");
  fs.writeFileSync(own, '{"format":"nope","cases":[]}', "utf8");

  assert.deepEqual(await resolveBank(env.base, { name: "demo-skill", realDir: env.skillsDir }), { kind: "unusable", path: own });
});

test("resolveBank: a name that is a path is refused instead of read", async (t) => {
  const env = makeAgentDir(t);
  putBank(env.base, "demo-skill", "user.json");

  assert.deepEqual(await resolveBank(env.base, { name: "../banks/demo-skill", realDir: env.skillsDir }), { kind: "absent" });
});

// ---------------------------------------------------------------------------------------------------------------

const SKILL = "demo-skill";

function episode(id: string, sessionId: string, cwd: string, startedAt = "2026-11-12T09:00:00.000Z"): EpisodeEvent {
  return {
    format: OBSERVE_FORMAT,
    at: FIXTURE_NOW,
    type: "episode",
    id,
    skill: SKILL,
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    cwd,
    startEntryId: `${id}-start`,
    endEntryId: `${id}-end`,
    anchorEntryIds: [`${id}-anchor`],
    startedAt,
    attribution: "explicit",
    providers: ["anthropic"],
    flags: ["correction"],
    clean: false,
  };
}

function observationOf(episodeId: string, sessionId: string): ObservationEvent {
  return {
    format: OBSERVE_FORMAT,
    at: FIXTURE_NOW,
    type: "observation",
    id: `ob-${episodeId}`,
    episodeId,
    sessionId,
    skill: SKILL,
    source: "user-note",
    kind: "correction",
    summary: "wanted the breaking changes only",
    confidence: null,
    weight: 1,
    anchorEntryId: `${episodeId}-anchor`,
    patternId: "pt-1",
  };
}

function stateOf(episodes: EpisodeEvent[], observed: EpisodeEvent[] = episodes): ObserveState {
  return {
    optInAt: "2026-11-10T00:00:00.000Z",
    episodes,
    judged: [],
    observations: observed.map((entry) => observationOf(entry.id, entry.sessionId)),
    proposals: [],
    prompts: [],
    gateOutcomes: [],
    tombstones: [],
    prepareFailures: [],
    forgets: {},
  };
}

function patternOf(state: ObserveState): PatternView {
  return {
    id: "pt-1",
    skill: SKILL,
    observationIds: state.observations.map((observation) => observation.id),
    sessions: 2,
    days: 2,
    weight: 2,
    alpha: 2,
    beta: 1,
    pAbove: 0.9,
    mechanicalOnly: false,
    proposable: true,
  };
}

const everywhere = () => true;

test("selectBankEpisodes: episodes of two sessions in one cwd are the cases, oldest first", () => {
  const late = episode("ep-b", "s-2", "/work/a", "2026-11-13T09:00:00.000Z");
  const early = episode("ep-a", "s-1", "/work/a");
  const state = stateOf([late, early]);

  const selection = selectBankEpisodes(patternOf(state), state, "/work/a", everywhere);

  assert.deepEqual(selection, { cwd: "/work/a", episodes: [early, late] });
});

test("selectBankEpisodes: the cwd of the open session wins over one with more sessions", () => {
  const state = stateOf([
    episode("ep-1", "s-1", "/work/a"),
    episode("ep-2", "s-2", "/work/a"),
    episode("ep-3", "s-3", "/work/a"),
    episode("ep-4", "s-4", "/work/b"),
    episode("ep-5", "s-5", "/work/b"),
  ]);

  const selection = selectBankEpisodes(patternOf(state), state, "/work/b", everywhere);

  assert.ok("cwd" in selection);
  assert.equal(selection.cwd, "/work/b");
});

test("selectBankEpisodes: without the open cwd, the one with the most sessions wins", () => {
  const state = stateOf([
    episode("ep-1", "s-1", "/work/b"),
    episode("ep-2", "s-2", "/work/b"),
    episode("ep-3", "s-3", "/work/a"),
    episode("ep-4", "s-4", "/work/a"),
    episode("ep-5", "s-5", "/work/a"),
  ]);

  const selection = selectBankEpisodes(patternOf(state), state, "/elsewhere", everywhere);

  assert.ok("cwd" in selection);
  assert.equal(selection.cwd, "/work/a");
});

test("selectBankEpisodes: one session is pending however many episodes it has", () => {
  const state = stateOf([episode("ep-1", "s-1", "/work/a"), episode("ep-2", "s-1", "/work/a")]);

  const selection = selectBankEpisodes(patternOf(state), state, "/work/a", everywhere);

  assert.ok("pending" in selection);
  assert.match(selection.reason, new RegExp(`${MIN_CASES} usable episodes`));
});

test("selectBankEpisodes: sessions in different cwds are not combined", () => {
  const state = stateOf([episode("ep-1", "s-1", "/work/a"), episode("ep-2", "s-2", "/work/b")]);

  assert.ok("pending" in selectBankEpisodes(patternOf(state), state, "/work/a", everywhere));
});

test("selectBankEpisodes: a cwd that no longer exists is not a place to run the cases", () => {
  const state = stateOf([episode("ep-1", "s-1", "/gone"), episode("ep-2", "s-2", "/gone")]);

  assert.ok("pending" in selectBankEpisodes(patternOf(state), state, "/gone", (cwd) => cwd !== "/gone"));
});

test("selectBankEpisodes: only episodes the pattern observed count", () => {
  const observed = episode("ep-1", "s-1", "/work/a");
  const bystander = episode("ep-2", "s-2", "/work/a");
  const state = stateOf([observed, bystander], [observed]);

  assert.ok("pending" in selectBankEpisodes(patternOf(state), state, "/work/a", everywhere));
});

test("selectBankEpisodes: an episode whose prompt holds a secret is excluded, not redacted", () => {
  const clean = episode("ep-1", "s-1", "/work/a");
  const leaky = episode("ep-2", "s-2", "/work/a");
  const third = episode("ep-3", "s-3", "/work/a");
  const state = stateOf([clean, leaky, third]);
  const promptOf = (entry: EpisodeEvent) => (entry.id === "ep-2" ? `deploy with ${FAKE_SECRETS.awsKey}` : "summarise it");

  const selection = selectBankEpisodes(patternOf(state), state, "/work/a", everywhere, promptOf);

  assert.ok("cwd" in selection);
  assert.deepEqual(
    selection.episodes.map((entry) => entry.id),
    ["ep-1", "ep-3"],
  );
});

test("selectBankEpisodes: excluding the secret one can leave the pattern pending", () => {
  const state = stateOf([episode("ep-1", "s-1", "/work/a"), episode("ep-2", "s-2", "/work/a")]);
  const promptOf = (entry: EpisodeEvent) => (entry.id === "ep-2" ? `key ${FAKE_SECRETS.githubToken}` : "summarise it");

  assert.ok("pending" in selectBankEpisodes(patternOf(state), state, "/work/a", everywhere, promptOf));
});

test("selectBankEpisodes: an episode whose prompt cannot be read is excluded", () => {
  const state = stateOf([episode("ep-1", "s-1", "/work/a"), episode("ep-2", "s-2", "/work/a")]);

  assert.ok(
    "pending" in selectBankEpisodes(patternOf(state), state, "/work/a", everywhere, (entry) => (entry.id === "ep-1" ? null : "x")),
  );
});
