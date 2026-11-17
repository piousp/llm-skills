import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { ImproveFlowContext } from "../../src/improve-flow.ts";
import { recordObservation, type ObservationDeps } from "../../src/observe/note.ts";
import { OBSERVE_FORMAT, observeId, type ObservationEvent, type ObserveEvent } from "../../src/observe/types.ts";
import type { SkillRef, SriConfig } from "../../src/types.ts";

// recordObservation is the one place a user note and a self-report become an observation, so the tests call it directly
// with doubles for every seam: no settings file, no skill walk and no log on disk.

const NOW = new Date("2026-11-02T14:03:22.481Z");
const NOW_ISO = "2026-11-02T14:03:22.481Z";
const BASE_MS = Date.parse("2026-11-02T14:00:00.000Z");

const SKILL: SkillRef = {
  name: "pdf-tools",
  description: "Extract tables from PDFs",
  dir: "/skills/pdf-tools",
  realDir: "/skills/pdf-tools",
  hasLessons: false,
  kind: "declared",
};

function userEntry(seconds: number, text: string): SessionMessageEntry {
  return {
    type: "message",
    id: `entry-${seconds}`,
    parentId: null,
    timestamp: new Date(BASE_MS + seconds * 1000).toISOString(),
    message: { role: "user", content: text, timestamp: BASE_MS + seconds * 1000 },
  };
}

interface Options {
  branch?: readonly SessionEntry[];
  config?: SriConfig;
  observeEnabled?: boolean;
  skills?: readonly SkillRef[];
  observed?: readonly ObserveEvent[];
}

function createHarness(options: Options = {}) {
  const stored: ObserveEvent[] = [...(options.observed ?? [])];
  const appended: ObserveEvent[] = [];

  const ctx = {
    cwd: "/work/reports",
    sessionManager: {
      getBranch: () => [...(options.branch ?? [userEntry(0, "no, use lattice")])],
      getSessionId: () => "session-test",
    },
  } as unknown as ImproveFlowContext;

  const deps: ObservationDeps = {
    now: () => NOW,
    agentDir: "/agent",
    base: "/pkg",
    readConfig: () => options.config ?? { allow: [], deny: [] },
    listSkills: async () => [...(options.skills ?? [SKILL])],
    readObserveConfig: () => ({
      enabled: options.observeEnabled ?? true,
      judgeModel: null,
      judgeCallsPerDay: 20,
      replayAllow: [],
    }),
    observeLog: {
      read: async () => [...stored],
      append: async (_base, events) => {
        stored.push(...events);
        appended.push(...events);
      },
    },
  };

  return { ctx, deps, appended };
}

function observationOf(event: ObserveEvent | undefined): ObservationEvent {
  assert.ok(event !== undefined && event.type === "observation", "the run must append an observation");
  return event;
}

test("recordObservation: a user note weighs 1, is anchored on the last user message and opens a pattern", async () => {
  const { ctx, deps, appended } = createHarness({ branch: [userEntry(0, "first ask"), userEntry(3, "no, use lattice")] });

  const result = await recordObservation({ source: "user-note", skillName: "pdf-tools", text: "  merged cells  " }, ctx, deps);

  assert.equal(result.kind, "recorded");
  const observation = observationOf(appended[0]);
  assert.equal(appended.length, 1);
  assert.equal(observation.format, OBSERVE_FORMAT);
  assert.equal(observation.at, NOW_ISO);
  assert.equal(observation.source, "user-note");
  assert.equal(observation.weight, 1);
  assert.equal(observation.skill, "pdf-tools");
  assert.equal(observation.sessionId, "session-test");
  assert.equal(observation.anchorEntryId, "entry-3");
  assert.equal(observation.summary, "merged cells");
  assert.equal(observation.patternId, observeId("pt", ["pdf-tools", observation.id]));
});

test("recordObservation: a self-report weighs 0.4 and a secret is redacted before it is stored", async () => {
  const { ctx, deps, appended } = createHarness();

  await recordObservation(
    { source: "self-report", skillName: "pdf-tools", text: "it used sk-ant-abcdefghijklmnopqrstuvwxyz0123 again" },
    ctx,
    deps,
  );

  const observation = observationOf(appended[0]);
  assert.equal(observation.weight, 0.4);
  assert.equal(observation.summary.includes("sk-ant-"), false);
  assert.equal(observation.summary.includes("[REDACTED]"), true);
});

test("recordObservation: the text is cut to the summary limit", async () => {
  const { ctx, deps, appended } = createHarness();

  await recordObservation({ source: "user-note", skillName: "pdf-tools", text: "x".repeat(400) }, ctx, deps);

  assert.equal(observationOf(appended[0]).summary.length, 300);
});

test("recordObservation: observation off writes nothing", async () => {
  const { ctx, deps, appended } = createHarness({ observeEnabled: false });

  const result = await recordObservation({ source: "user-note", skillName: "pdf-tools", text: "x" }, ctx, deps);

  assert.deepEqual(result, { kind: "observe-disabled" });
  assert.deepEqual(appended, []);
});

test("recordObservation: a branch without a user message has nothing to anchor on", async () => {
  const { ctx, deps, appended } = createHarness({ branch: [] });

  const result = await recordObservation({ source: "user-note", skillName: "pdf-tools", text: "x" }, ctx, deps);

  assert.deepEqual(result, { kind: "no-user-message" });
  assert.deepEqual(appended, []);
});

test("recordObservation: an unknown skill and an ineligible one write nothing", async () => {
  const unknown = createHarness();
  const unknownResult = await recordObservation({ source: "user-note", skillName: "no-such-skill", text: "x" }, unknown.ctx, unknown.deps);
  assert.equal(unknownResult.kind, "unknown-skill");
  assert.deepEqual(unknown.appended, []);

  const denied = createHarness({ config: { allow: [], deny: ["pdf-tools"] } });
  const deniedResult = await recordObservation({ source: "user-note", skillName: "pdf-tools", text: "x" }, denied.ctx, denied.deps);
  assert.equal(deniedResult.kind, "not-eligible");
  assert.deepEqual(denied.appended, []);
});

test("recordObservation: the same note is recorded once and a second note joins the pattern of the first", async () => {
  const { ctx, deps, appended } = createHarness();

  await recordObservation({ source: "user-note", skillName: "pdf-tools", text: "use lattice" }, ctx, deps);
  await recordObservation({ source: "user-note", skillName: "pdf-tools", text: "use lattice" }, ctx, deps);
  await recordObservation({ source: "user-note", skillName: "pdf-tools", text: "keep the header row" }, ctx, deps);

  assert.equal(appended.length, 2);
  const [first, second] = appended.map(observationOf);
  assert.notEqual(first.id, second.id);
  assert.equal(second.patternId, first.patternId);
});

test("recordObservation: a pattern of another source is not joined", async () => {
  const other: ObserveEvent = {
    format: OBSERVE_FORMAT,
    type: "observation",
    at: NOW_ISO,
    id: "ob-000000000001",
    episodeId: null,
    sessionId: "session-other",
    skill: "pdf-tools",
    source: "user-note",
    kind: "user-note:x",
    summary: "a note",
    confidence: null,
    weight: 1,
    anchorEntryId: "entry-0",
    patternId: "pt-000000000001",
  };
  const { ctx, deps, appended } = createHarness({ observed: [other] });

  await recordObservation({ source: "self-report", skillName: "pdf-tools", text: "use lattice" }, ctx, deps);

  assert.notEqual(observationOf(appended[0]).patternId, "pt-000000000001");
});
