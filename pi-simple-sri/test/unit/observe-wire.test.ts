import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { attemptSignature, buildAttemptLine } from "../../src/attempts.ts";
import type { AttemptEvent } from "../../src/attempts.ts";
import { readCaseBank } from "../../src/case-bank.ts";
import { withScanLock } from "../../src/observe/lock.ts";
import { appendAttemptLine } from "../../src/writer.ts";
import { PROBATION_REASON } from "../../src/gate/probation.ts";
import { sha256Digest } from "../../src/hash.ts";
import { DECISION_FILE, LESSONS_DIR, OBSERVE_FILE, OBSERVE_CURSOR_FILE, SETTINGS_FILE, SKILL_FILE } from "../../src/names.ts";
import type { DecisionRecord, GateBlock } from "../../src/types.ts";
import { validateAgainstSchema } from "./schema-reader.ts";
import { bankPathOf } from "../../src/observe/banks.ts";
import { runObserveCycle, type CycleDeps, type CycleInput, type CycleReport } from "../../src/observe/cycle.ts";
import type { GateClassification } from "../../src/observe/outcome.ts";
import { patternViews } from "../../src/observe/patterns.ts";
import { readSessionFile } from "../../src/observe/session-file.ts";
import { appendObserveEvents, foldObserveState, readObserveLog } from "../../src/observe/store.ts";
import {
  JUDGE_TRANSCRIPT_MAX_CODE_POINTS,
  NO_HASH_REASON,
  createObserveRuntime,
  isObserveContext,
  productionCycleDeps,
  productionReviewDeps,
  proposalViewOf,
  type ObserveContext,
  type ObserveSeams,
  type ObserveStartContext,
} from "../../src/observe/wire.ts";
import {
  MAX_SUMMARY_CHARS,
  OBSERVE_FORMAT,
  type Episode,
  type ObservationEvent,
  type ObserveConfig,
  type ObserveEvent,
  type PatternView,
  type ProposalEvent,
  type TombstoneEvent,
} from "../../src/observe/types.ts";
import { labelingDir, stagingDir, stateDir } from "../../src/write-base.ts";
import {
  AFTER_OPT_IN_AT,
  FAKE_SECRETS,
  FIXTURE_NOW,
  OPT_IN_AT,
  explicitCorrection,
  fakeRegistry,
  fakeUi,
  fixturePath,
  groupedDirNameOf,
  installFixtureSkill,
  makeAgentDir,
  missingCwdEpisode,
  providerMismatchEpisode,
  secretsEpisode,
  tmpCwdEpisode,
  writeSessionsTree,
  type AgentDirFixture,
  type FakeRegistryHandle,
  type FakeUiHandle,
  type SessionSpec,
  type UiStep,
} from "./observe-fixtures.ts";

// WP14a: the live wiring of the observer. The runtime (when a cycle starts, what stops it, which surface the command binds)
// is driven with fake seams; the production dependencies are driven for real over a mkdtemp agent directory, a tree of
// fixture sessions, a scripted dialog and a scripted model registry, so that what is asserted is what the binding does and
// not what a fake says it does. Nothing here reaches a provider, a process or a real skill.
//
// The proposal (`propose`), the gate guard (`runGate`) and the acceptance (`accept`) bindings are driven for real at the end of
// the file: a scripted model, a tmp agent directory, the real staging, ledger and acceptance. What nothing here checks by running:
// a gate that replays (it spawns pi runs) and the wording of the dialogs.

const NOW = new Date(FIXTURE_NOW);
const ENABLED: ObserveConfig = { enabled: true, judgeModel: null, judgeCallsPerDay: 20, replayAllow: [] };

const MODEL: Model<Api> = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  input: ["text"],
  cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  contextWindow: 200_000,
  maxTokens: 8_192,
};
const OTHER_MODEL: Model<Api> = { ...MODEL, id: "gpt-5", name: "GPT-5", api: "openai-responses", provider: "openai" };

const SESSION_FILE = "/sessions/--work-reports--/2026-11-02_live.jsonl";
const SESSION_DIR = "/sessions/--work-reports--";

// The user's words in the fixture scenarios: the args of the skill invocation, and the correction after the answer.
const REQUEST = "summarise the changelog";
const CORRECTION = "No, that is wrong";

// ---------------------------------------------------------------------------------------------------------------
// The runtime: when a cycle starts and what stops it
// ---------------------------------------------------------------------------------------------------------------

const DONE_REPORT: CycleReport = {
  mode: "background",
  status: "done",
  files: 0,
  episodes: 0,
  judgeCalls: 0,
  observations: 0,
  blocked: 0,
  proposal: "none",
  proposalId: null,
  discardFailed: [],
  labeling: null,
};
// The cycle seam below never reads its dependencies: the run seam stands in for the cycle.
const NO_DEPS = {} as CycleDeps;

interface Notice {
  message: string;
  type: string;
}

function fakeContext(overrides: Partial<ObserveStartContext> = {}, notices: Notice[] = []): ObserveStartContext {
  return {
    ui: {
      notify: (message, type) => {
        notices.push({ message, type: type ?? "info" });
      },
      select: async () => undefined,
      confirm: async () => false,
    },
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "live",
      getSessionDir: () => SESSION_DIR,
      getSessionFile: () => SESSION_FILE,
    },
    mode: "tui",
    cwd: "/work/reports",
    model: undefined,
    modelRegistry: {
      complete: async () => {
        throw new Error("no model call in this test");
      },
    },
    isIdle: () => true,
    ...overrides,
  };
}

interface RuntimeHarness {
  runs: CycleInput[];
  reads: string[];
  deferrals: ((callback: () => void) => void)[];
  runtime: ReturnType<typeof createObserveRuntime>;
  userMessages: string[];
}

// `run` answers at once unless `hang` is set, in which case the cycle lasts until it is aborted (a cycle waiting on a dialog).
function runtimeHarness(options: { config?: ObserveConfig | Error; hang?: boolean; run?: ObserveSeams["run"] } = {}): RuntimeHarness {
  const harness: RuntimeHarness = { runs: [], reads: [], deferrals: [], userMessages: [], runtime: undefined as never };
  const seams: ObserveSeams = {
    agentDir: () => "/agent",
    readConfig: (agentDir) => {
      harness.reads.push(agentDir);
      const config = options.config ?? ENABLED;
      if (config instanceof Error) throw config;
      return config;
    },
    now: () => NOW,
    cycleDeps: async (_ctx, _api, wire) => {
      harness.deferrals.push(wire.onSettled);
      return NO_DEPS;
    },
    run:
      options.run ??
      (async (input) => {
        harness.runs.push(input);
        const signal = input.signal;
        if (options.hang === true && signal !== undefined) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        return DONE_REPORT;
      }),
  };
  harness.runtime = createObserveRuntime(
    {
      sendUserMessage: async (content) => {
        harness.userMessages.push(content);
      },
    },
    seams,
  );
  return harness;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("isObserveContext: only a context with dialogs, session files, a registry and an idle check can host the observer", () => {
  assert.equal(isObserveContext(fakeContext()), true);
  assert.equal(isObserveContext(fakeContext({ ui: { notify: () => undefined } })), false);
  assert.equal(isObserveContext(fakeContext({ modelRegistry: undefined })), false);
  assert.equal(isObserveContext(fakeContext({ isIdle: undefined })), false);
  assert.equal(isObserveContext(fakeContext({ cwd: undefined })), false);
  assert.equal(
    isObserveContext(fakeContext({ sessionManager: { getBranch: () => [], getSessionId: () => "live" } })),
    false,
  );
});

test("start: a top-level TUI session opened with startup or new runs one background cycle over the session files", async () => {
  for (const reason of ["startup", "new"]) {
    const harness = runtimeHarness();

    harness.runtime.start({ reason }, fakeContext());
    await settle();

    assert.equal(harness.runs.length, 1, `reason ${reason}`);
    const [input] = harness.runs;
    assert.equal(input.mode, "background");
    assert.deepEqual(input.config, ENABLED);
    assert.equal(input.now.toISOString(), FIXTURE_NOW);
    assert.equal(input.currentSessionFile, SESSION_FILE);
    assert.equal(input.ctxCwd, "/work/reports");
    assert.equal(input.signal?.aborted, false);
    assert.deepEqual(harness.reads, ["/agent"]);
  }
});

test("start: resume, fork and reload never start a cycle, and neither do they read the settings", async () => {
  for (const reason of ["resume", "fork", "reload"]) {
    const harness = runtimeHarness();

    harness.runtime.start({ reason }, fakeContext());
    await settle();

    assert.deepEqual(harness.runs, [], reason);
    assert.deepEqual(harness.reads, [], `${reason} must stop before the settings are read`);
  }
});

test("start: only the TUI hosts a cycle", async () => {
  for (const mode of ["rpc", "json", "print", undefined]) {
    const harness = runtimeHarness();

    harness.runtime.start({ reason: "startup" }, fakeContext({ mode }));
    await settle();

    assert.deepEqual(harness.runs, [], String(mode));
    assert.deepEqual(harness.reads, [], `${String(mode)} must stop before the settings are read`);
  }
});

test("start: a context that cannot ask, or a session with no file, hosts no cycle", async () => {
  const noDialogs = runtimeHarness();
  noDialogs.runtime.start({ reason: "startup" }, fakeContext({ ui: { notify: () => undefined } }));

  const inMemory = runtimeHarness();
  inMemory.runtime.start(
    { reason: "startup" },
    fakeContext({ sessionManager: { getBranch: () => [], getSessionId: () => "live", getSessionDir: () => SESSION_DIR, getSessionFile: () => undefined } }),
  );
  await settle();

  assert.deepEqual(noDialogs.runs, []);
  assert.deepEqual(inMemory.runs, []);
});

test("start: observation off is the default, and the settings are read to find out", async () => {
  const harness = runtimeHarness({ config: { ...ENABLED, enabled: false } });

  harness.runtime.start({ reason: "startup" }, fakeContext());
  await settle();

  assert.deepEqual(harness.reads, ["/agent"]);
  assert.deepEqual(harness.runs, []);
});

test("start: a subagent run nested under the project directory is not a top-level session", async () => {
  const nested = runtimeHarness();
  nested.runtime.start(
    { reason: "startup" },
    fakeContext({ sessionManager: { getBranch: () => [], getSessionId: () => "live", getSessionDir: () => SESSION_DIR, getSessionFile: () => `${SESSION_DIR}/run-0/session.jsonl` } }),
  );
  // The flat layout, where the session directory is the root itself.
  const flat = runtimeHarness();
  flat.runtime.start(
    { reason: "startup" },
    fakeContext({ sessionManager: { getBranch: () => [], getSessionId: () => "live", getSessionDir: () => "/sessions", getSessionFile: () => "/sessions/2026-11-02_live.jsonl" } }),
  );
  await settle();

  assert.deepEqual(nested.runs, []);
  assert.equal(flat.runs.length, 1);
});

test("start: settings that cannot be read warn the user and start nothing", async () => {
  const notices: Notice[] = [];
  const harness = runtimeHarness({ config: new Error("settings.json: pi-simple-sri.observe.enabled must be a boolean") });

  harness.runtime.start({ reason: "startup" }, fakeContext({}, notices));
  await settle();

  assert.deepEqual(harness.runs, []);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, "warning");
  assert.equal(notices[0].message.includes("must be a boolean"), true);
});

test("start: a cycle that fails warns, unless the session that started it is already gone", async () => {
  const notices: Notice[] = [];
  const failing = runtimeHarness({
    run: async () => {
      throw new Error("the lock directory is read-only");
    },
  });
  failing.runtime.start({ reason: "startup" }, fakeContext({}, notices));
  await settle();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].message.includes("the lock directory is read-only"), true);

  const silent: Notice[] = [];
  const aborted = runtimeHarness({
    run: async (input) => {
      await new Promise<void>((resolve) => input.signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("the dialog was dismissed");
    },
  });
  aborted.runtime.start({ reason: "startup" }, fakeContext({}, silent));
  await settle();
  aborted.runtime.stop();
  await settle();
  assert.deepEqual(silent, []);
});

test("stop: aborts the running cycle, is idempotent, and forgets what was waiting for the idle agent", async () => {
  const harness = runtimeHarness({ hang: true });
  harness.runtime.start({ reason: "startup" }, fakeContext());
  await settle();
  const signal = harness.runs[0]?.signal;
  assert.equal(signal?.aborted, false);

  const ran: string[] = [];
  harness.deferrals[0]?.(() => ran.push("review"));
  harness.runtime.stop();
  harness.runtime.stop();

  assert.equal(signal?.aborted, true);
  harness.runtime.settled();
  assert.deepEqual(ran, [], "a review deferred by a session that ended is not dispatched into the next one");
});

test("start: a second session aborts the cycle of the first", async () => {
  const harness = runtimeHarness({ hang: true });

  harness.runtime.start({ reason: "startup" }, fakeContext());
  await settle();
  harness.runtime.start({ reason: "new" }, fakeContext());
  await settle();

  assert.equal(harness.runs.length, 2);
  assert.equal(harness.runs[0].signal?.aborted, true);
  assert.equal(harness.runs[1].signal?.aborted, false);
  harness.runtime.stop();
});

test("settled: runs each deferred callback once, in order, and one that throws does not keep the others from running", async () => {
  const harness = runtimeHarness({ hang: true });
  harness.runtime.start({ reason: "startup" }, fakeContext());
  await settle();

  const ran: string[] = [];
  const defer = harness.deferrals[0];
  defer?.(() => ran.push("first"));
  defer?.(() => {
    throw new Error("the send failed");
  });
  defer?.(() => ran.push("third"));
  assert.deepEqual(ran, []);

  harness.runtime.settled();
  harness.runtime.settled();

  assert.deepEqual(ran, ["first", "third"]);
  harness.runtime.stop();
});

test("surface: none for a context that cannot ask; scan completes the cycle input from the session and the flags", async () => {
  const harness = runtimeHarness();
  assert.equal(harness.runtime.surface(fakeContext({ ui: { notify: () => undefined } })), undefined);

  const surface = harness.runtime.surface(fakeContext());
  assert.ok(surface !== undefined);
  const report = await surface.scan({ mode: "dry-run", since: "2026-11-01", sampleSize: 5 });

  assert.deepEqual(report, DONE_REPORT);
  assert.equal(harness.runs.length, 1);
  const [input] = harness.runs;
  assert.equal(input.mode, "dry-run");
  assert.equal(input.since, "2026-11-01");
  assert.equal(input.sampleSize, 5);
  assert.equal(input.currentSessionFile, SESSION_FILE);
  assert.equal(input.signal?.aborted, false);
  // A scan from the command is a run of the session like the background one: the shutdown aborts it too.
  const hanging = runtimeHarness({ hang: true });
  const pending = hanging.runtime.surface(fakeContext())?.scan({ mode: "scan" });
  await settle();
  hanging.runtime.stop();
  assert.deepEqual(await pending, DONE_REPORT);
  assert.equal(hanging.runs[0].signal?.aborted, true);
});

// ---------------------------------------------------------------------------------------------------------------
// The production dependencies over a real agent directory
// ---------------------------------------------------------------------------------------------------------------

// The session of the live process: its directory names the sessions root, so the fixture sessions written next to it are
// the ones the cycle finds. The header cwd of the fixtures is the repository itself: a directory that exists and is not scratch.
const FIXTURE_CWD = process.cwd();

interface Live {
  fx: AgentDirFixture;
  ui: FakeUiHandle;
  model: FakeRegistryHandle;
  ctx: ObserveContext;
}

function liveContext(
  t: TestContext,
  script: readonly UiStep[],
  answers: readonly (string | Error)[],
  overrides: { model?: Model<Api> | undefined; find?: (provider: string, id: string) => Model<Api> | undefined } = {},
): Live {
  const fx = makeAgentDir(t);
  installFixtureSkill(fx.skillsDir, "read-only");
  const ui = fakeUi(script);
  const model = fakeRegistry(answers);
  const ctx: ObserveContext = {
    cwd: FIXTURE_CWD,
    model: "model" in overrides ? overrides.model : MODEL,
    modelRegistry: overrides.find === undefined ? model.registry : { ...model.registry, find: overrides.find },
    ui: ui.ui,
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "live",
      getSessionDir: () => path.join(fx.sessionsDir, groupedDirNameOf(FIXTURE_CWD)),
      getSessionFile: () => undefined,
    },
    isIdle: () => true,
  };
  return { fx, ui, model, ctx };
}

async function depsOf(live: Live, config: ObserveConfig = ENABLED): Promise<CycleDeps> {
  return await productionCycleDeps(live.ctx, { sendUserMessage: async () => undefined }, {
    agentDir: live.fx.agentDir,
    config,
    now: () => NOW,
    onSettled: () => undefined,
    // The fixtures live in the temp directory of the machine; the header cwd is what decides.
    tmpdirs: [],
  });
}

function inputOf(overrides: Partial<CycleInput> = {}): CycleInput {
  return { mode: "scan", config: ENABLED, now: NOW, currentSessionFile: null, ctxCwd: FIXTURE_CWD, ...overrides };
}

// Entry ids that name the session, so two sessions never share the id of an episode (it hashes the start entry).
function withStepIds(spec: SessionSpec): SessionSpec {
  return { ...spec, steps: spec.steps.map((step, index) => ({ ...step, id: `${spec.id}-e${index}` })) };
}

function correctionOf(id: string, startedAt: string): SessionSpec {
  return withStepIds(explicitCorrection({ id, startedAt, skill: "read-only", skillsDir: "/work/skills", cwd: FIXTURE_CWD }));
}

function findingAnswer(anchorEntryId: string): string {
  return JSON.stringify({
    findings: [
      {
        kind: "verbose-output",
        summary: "The user wanted only the breaking changes.",
        confidence: 0.9,
        anchorEntryId,
        patternRef: "new",
        typeTokens: ["verbose", "output"],
      },
    ],
  });
}

function optIn(live: Live): Promise<void> {
  return appendObserveEvents(live.fx.base, [{ format: OBSERVE_FORMAT, type: "opt-in", at: OPT_IN_AT }]);
}

test("dry-run: the judge reads what the user typed and never the skill's own block, and only the labeling file is written", async (t) => {
  const spec = withStepIds(explicitCorrection({ skill: "read-only", skillsDir: "/work/skills", cwd: FIXTURE_CWD }));
  const live = liveContext(t, [{ kind: "confirm", answer: true }], [findingAnswer(`${spec.id}-e2`)]);
  writeSessionsTree(live.fx.sessionsDir, "grouped", [{ spec }]);

  const report = await runObserveCycle(inputOf({ mode: "dry-run" }), await depsOf(live));

  assert.equal(report.status, "done");
  assert.equal(report.files, 1);
  assert.equal(report.episodes, 1);
  assert.equal(report.judgeCalls, 1);
  // The user confirmed a cost estimate that names the model that will read their sessions.
  assert.equal(live.ui.shown.length, 1);
  assert.equal(live.ui.shown[0].kind, "confirm");
  assert.equal(live.ui.shown[0].message?.includes("anthropic/claude-sonnet-4-5"), true);

  // One call, over the words of the user: the request and the correction, not the body of the skill.
  assert.equal(live.model.calls.length, 1);
  const prompt = JSON.stringify(live.model.calls[0].context);
  assert.equal(prompt.includes(REQUEST), true);
  assert.equal(prompt.includes(CORRECTION), true);
  assert.equal(prompt.includes("Follow the instructions."), false, "the <skill> block is the skill's text, not the user's");

  assert.ok(report.labeling !== null);
  const file = path.join(labelingDir(live.fx.base), report.labeling.file);
  const [record] = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(record.flagged, true);
  assert.equal(record.judgeFound, true);
  assert.equal(record.label, null);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // A dry run measures: the store, the cursor and the lock were never touched.
  assert.equal(fs.existsSync(path.join(stateDir(live.fx.base), OBSERVE_FILE)), false);
  assert.equal(fs.existsSync(path.join(stateDir(live.fx.base), OBSERVE_CURSOR_FILE)), false);
});

test("dry-run: a secret in the user's words or in the tool output never reaches the model", async (t) => {
  const live = liveContext(t, [{ kind: "confirm", answer: true }], [JSON.stringify({ findings: [] })]);
  writeSessionsTree(live.fx.sessionsDir, "grouped", [{ spec: secretsEpisode({ skillsDir: "/work/skills", cwd: FIXTURE_CWD }) }]);

  const report = await runObserveCycle(inputOf({ mode: "dry-run" }), await depsOf(live));

  assert.equal(report.judgeCalls, 1);
  const prompt = JSON.stringify(live.model.calls[0].context);
  for (const secret of [FAKE_SECRETS.awsKey, FAKE_SECRETS.githubToken, FAKE_SECRETS.bearer.replace("Bearer ", "")]) {
    assert.equal(prompt.includes(secret), false, "a secret travelled to the model");
  }
  // The rest of the transcript is there: the redaction cuts the secret and not the sentence around it.
  assert.equal(prompt.includes("deploy with"), true);
});

test("dry-run: sessions in a scratch or a missing directory are not read, and an episode on another provider waits unjudged", async (t) => {
  const live = liveContext(t, [], []);
  writeSessionsTree(live.fx.sessionsDir, "grouped", [
    { spec: tmpCwdEpisode({ skill: "read-only", skillsDir: "/work/skills" }) },
    { spec: missingCwdEpisode({ skill: "read-only", skillsDir: "/work/skills" }) },
    { spec: providerMismatchEpisode({ skill: "read-only", skillsDir: "/work/skills", cwd: FIXTURE_CWD }) },
  ]);

  const report = await runObserveCycle(inputOf({ mode: "dry-run" }), await depsOf(live));

  // Three files read; the first two are excluded by their cwd and the third is blocked by the provider gate (D2): nothing
  // to confirm, nothing judged, no model call.
  assert.equal(report.files, 3);
  assert.equal(report.episodes, 0);
  assert.equal(report.blocked, 1);
  assert.equal(report.judgeCalls, 0);
  assert.deepEqual(live.ui.shown, []);
  assert.deepEqual(live.model.calls, []);
});

test("providerOk: the provider of the session model judges, and a pinned judge model lifts the gate (D2)", async (t) => {
  const mismatch: Episode = {
    id: "ep-x",
    skill: "read-only",
    sessionId: "s",
    sessionFile: "/sessions/s.jsonl",
    cwd: FIXTURE_CWD,
    startEntryId: "a",
    endEntryId: "b",
    anchorEntryIds: ["a"],
    startedAt: AFTER_OPT_IN_AT,
    attribution: "explicit",
    providers: ["openai"],
  };
  const sameProvider: Episode = { ...mismatch, providers: ["anthropic"] };

  const session = await depsOf(liveContext(t, [], []));
  assert.equal(session.providerOk(sameProvider), true);
  assert.equal(session.providerOk(mismatch), false);

  const pinnedLive = liveContext(t, [], [], { find: (provider, id) => (provider === "openai" && id === "gpt-5" ? OTHER_MODEL : undefined) });
  const pinned = await depsOf(pinnedLive, { ...ENABLED, judgeModel: { provider: "openai", id: "gpt-5" } });
  assert.equal(pinned.providerOk(mismatch), true);

  // No model at all: there is nothing to judge with, so no episode is eligible.
  const none = await depsOf(liveContext(t, [], [], { model: undefined }));
  assert.equal(none.providerOk(sameProvider), false);
});

test("judge: with no model the verdict is skipped and no call is made; with a pinned model that is unknown, the same", async (t) => {
  const live = liveContext(t, [], [], { model: undefined });
  const [file] = writeSessionsTree(live.fx.sessionsDir, "grouped", [{ spec: correctionOf("fx-j1", AFTER_OPT_IN_AT) }]);
  const read = await readSessionFile(file);
  assert.ok(read.ok);
  const deps = await depsOf(live);
  const [episode] = deps.segment(read.value, { path: file, headerId: "fx-j1", size: 0, mtimeMs: 0 });
  assert.ok(episode !== undefined);

  const verdict = await deps.judge({ episode, read: read.value, state: foldObserveState([], NOW) });

  assert.equal(verdict.outcome, "skipped");
  assert.deepEqual(live.model.calls, []);

  const unknown = await depsOf(live, { ...ENABLED, judgeModel: { provider: "openai", id: "nope" } });
  assert.equal((await unknown.judge({ episode, read: read.value, state: foldObserveState([], NOW) })).outcome, "skipped");
});

test("judge: a reply that is not the answer asked for is a failed verdict, not a finding", async (t) => {
  const live = liveContext(t, [], ["I could not decide."]);
  const [file] = writeSessionsTree(live.fx.sessionsDir, "grouped", [{ spec: correctionOf("fx-j2", AFTER_OPT_IN_AT) }]);
  const read = await readSessionFile(file);
  assert.ok(read.ok);
  const deps = await depsOf(live);
  const [episode] = deps.segment(read.value, { path: file, headerId: "fx-j2", size: 0, mtimeMs: 0 });
  assert.ok(episode !== undefined);

  const verdict = await deps.judge({ episode, read: read.value, state: foldObserveState([], NOW) });

  assert.equal(verdict.outcome, "failed");
  assert.equal(verdict.model, "anthropic/claude-sonnet-4-5");
  assert.deepEqual(verdict.findings, []);
});

test("estimateCost: an upper bound over the transcript budget, priced with the model that will judge", async (t) => {
  const live = liveContext(t, [], []);
  const deps = await depsOf(live);
  const episode = (id: string): Episode => ({
    id,
    skill: "read-only",
    sessionId: id,
    sessionFile: `/sessions/${id}.jsonl`,
    cwd: FIXTURE_CWD,
    startEntryId: "a",
    endEntryId: "b",
    anchorEntryIds: ["a"],
    startedAt: AFTER_OPT_IN_AT,
    attribution: "explicit",
    providers: ["anthropic"],
  });

  const estimate = deps.estimateCost([episode("ep-1"), episode("ep-2")]);

  assert.equal(estimate.calls, 2);
  // At least the whole transcript budget per call (4 characters a token), and the output the call may spend.
  assert.equal(estimate.inTokens >= (2 * JUDGE_TRANSCRIPT_MAX_CODE_POINTS) / 4, true);
  assert.equal(estimate.outTokens > 0, true);
  assert.equal(estimate.usd, (estimate.inTokens * MODEL.cost.input + estimate.outTokens * MODEL.cost.output) / 1_000_000);

  const unpriced = await depsOf(liveContext(t, [], [], { model: undefined }));
  assert.equal(unpriced.estimateCost([episode("ep-1")]).usd, null);
});

test("scan: the sessions are ingested into the store through the production dependencies, and a second scan reads nothing again", async (t) => {
  const live = liveContext(t, [], [findingAnswer("fx-s1-e2")]);
  await optIn(live);
  writeSessionsTree(live.fx.sessionsDir, "grouped", [{ spec: correctionOf("fx-s1", "2026-11-12T09:00:00.000Z") }]);
  const deps = await depsOf(live);

  const first = await runObserveCycle(inputOf(), deps);

  assert.equal(first.status, "done");
  assert.equal(first.files, 1);
  assert.equal(first.episodes, 1);
  assert.equal(first.judgeCalls, 1);
  assert.equal(first.observations, 1);
  // One pattern with one session is below the threshold: nothing to offer, so no dialog.
  assert.equal(first.proposal, "none");
  assert.deepEqual(live.ui.shown, []);

  const events = await readObserveLog(live.fx.base);
  assert.deepEqual(events.map((event) => event.type), ["opt-in", "episode", "judged", "observation"]);
  const observation = events.find((event) => event.type === "observation");
  assert.ok(observation?.type === "observation");
  assert.equal(observation.source, "judge");
  assert.equal(observation.skill, "read-only");
  assert.equal(observation.anchorEntryId, "fx-s1-e2");
  assert.equal(fs.existsSync(path.join(stateDir(live.fx.base), OBSERVE_CURSOR_FILE)), true);
  // The lock is released when the cycle ends.
  assert.equal(fs.existsSync(path.join(stateDir(live.fx.base), "observe.lock")), false);

  const second = await runObserveCycle(inputOf(), deps);

  assert.equal(second.files, 0, "the cursor says the file did not change");
  assert.equal(live.model.calls.length, 1, "no second call was spent on the same episode");
});

test("a pattern seen in two sessions on two days flows through select, generate and promote into a bank the next cycle resolves", async (t) => {
  const bankChecks = JSON.stringify({
    cases: [
      { case: 1, checks: [{ kind: "contains", value: "breaking" }] },
      { case: 2, checks: [{ kind: "regex", pattern: "breaking", flags: "i" }] },
    ],
  });
  const live = liveContext(t, [], [findingAnswer("fx-s1-e2"), findingAnswer("fx-s2-e2"), bankChecks]);
  await optIn(live);
  writeSessionsTree(live.fx.sessionsDir, "grouped", [
    { spec: correctionOf("fx-s1", "2026-11-12T09:00:00.000Z") },
    { spec: correctionOf("fx-s2", "2026-11-13T09:00:00.000Z") },
  ]);
  allowReplay(live);
  const deps = await depsOf(live, { ...ENABLED, replayAllow: ["read-only"] });

  const report = await runObserveCycle(inputOf(), deps);
  assert.equal(report.observations, 2);

  const state = foldObserveState(await readObserveLog(live.fx.base), NOW);
  const views = patternViews(state, NOW);
  // The second finding joined the pattern of the first: the judge named no pattern and the tokens agree.
  assert.equal(views.length, 1);
  assert.equal(views[0].sessions, 2);
  assert.equal(views[0].days, 2);

  assert.equal(await deps.bank.resolve("read-only"), null, "there is no bank yet");

  const selected = await deps.bank.select(views[0], state, FIXTURE_CWD);
  assert.equal(selected.kind, "ready");
  if (selected.kind !== "ready") return;
  assert.equal(selected.selection.cwd, FIXTURE_CWD);
  assert.equal(selected.selection.episodes.length, 2);

  const generated = await deps.bank.generate({ skill: "read-only", view: views[0], selection: selected.selection });
  assert.ok(generated.ok, generated.ok ? "" : generated.error);
  // The draft waits in staging until the user approves it, private, with the words of the users as the prompts.
  assert.equal(generated.value.startsWith(stagingDir(live.fx.base) + path.sep), true);
  if (process.platform !== "win32") assert.equal(fs.statSync(generated.value).mode & 0o777, 0o600);
  const draft = await readCaseBank(generated.value, "baseline");
  assert.ok(draft.ok);
  assert.equal(draft.value.bank.provenance, "auto");
  assert.deepEqual(draft.value.bank.cases.map((entry) => entry.prompt), [REQUEST, REQUEST]);
  // The generator was handed the user's words and the summaries, not the skill block.
  assert.equal(JSON.stringify(live.model.calls[2].context).includes("Follow the instructions."), false);

  const promoted = await deps.bank.promote(generated.value, "read-only");
  assert.equal(promoted, bankPathOf(live.fx.base, "read-only"));
  assert.equal(fs.readFileSync(promoted, "utf8"), fs.readFileSync(generated.value, "utf8"));
  // Asked again for the same approved bank (the gate was retryable), it is the same file and not an error.
  assert.equal(await deps.bank.promote(generated.value, "read-only"), promoted);

  assert.deepEqual(await deps.bank.resolve("read-only"), { path: promoted, provenance: "auto" });

  // A different bank in the way is never overwritten.
  fs.writeFileSync(promoted, "{}\n");
  await assert.rejects(deps.bank.promote(generated.value, "read-only"), /different bank already exists/);
});

test("select: a single session is not enough for a bank, and the answer is pending", async (t) => {
  const live = liveContext(t, [], [findingAnswer("fx-s1-e2")]);
  await optIn(live);
  writeSessionsTree(live.fx.sessionsDir, "grouped", [{ spec: correctionOf("fx-s1", "2026-11-12T09:00:00.000Z") }]);
  const deps = await depsOf(live);
  await runObserveCycle(inputOf(), deps);
  const state = foldObserveState(await readObserveLog(live.fx.base), NOW);

  const selected = await deps.bank.select(patternViews(state, NOW)[0], state, FIXTURE_CWD);

  assert.equal(selected.kind, "pending");
});

test("generate: fewer usable cases than a bank needs is a failure, and nothing is written to staging", async (t) => {
  const live = liveContext(t, [], []);
  const deps = await depsOf(live);
  const view = { id: "pt-x", skill: "read-only", observationIds: [], sessions: 1, days: 1, weight: 0, alpha: 1, beta: 1, pAbove: 0, mechanicalOnly: false, proposable: false };

  const generated = await deps.bank.generate({
    skill: "read-only",
    view,
    selection: { cwd: FIXTURE_CWD, episodes: [{ episodeId: "ep-1", prompt: REQUEST, expectation: "only breaking changes" }] },
  });

  assert.equal(generated.ok, false);
  assert.deepEqual(live.model.calls, []);
  assert.equal(fs.existsSync(stagingDir(live.fx.base)), false);
});

test("bank.resolve: a bank that exists and cannot be read is a refusal and not the absence of a bank", async (t) => {
  const live = liveContext(t, [], []);
  const deps = await depsOf(live);
  assert.equal(await deps.bank.resolve("ghost-skill"), null, "a skill that is not installed has no bank");

  const target = bankPathOf(live.fx.base, "read-only");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "{not json");
  await assert.rejects(deps.bank.resolve("read-only"), /exists and cannot be used as a bank/);

  const userBank = JSON.parse(fs.readFileSync(fixturePath("banks", "user.json"), "utf8"));
  fs.writeFileSync(target, JSON.stringify({ ...userBank, format: "pi-simple-sri/case-bank@0" }));
  await assert.rejects(deps.bank.resolve("read-only"), /exists and cannot be used as a bank/);

  fs.copyFileSync(fixturePath("banks", "user.json"), target);
  assert.deepEqual(await deps.bank.resolve("read-only"), { path: target, provenance: "user" });
});

test("bank.resolve: a user bank with only negative checks is legal and is returned", async (t) => {
  const live = liveContext(t, [], []);
  const deps = await depsOf(live);
  const target = bankPathOf(live.fx.base, "read-only");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const negativeOnly = JSON.parse(fs.readFileSync(fixturePath("banks", "invalid-no-positive-check.json"), "utf8"));
  delete negativeOnly.provenance;
  fs.writeFileSync(target, JSON.stringify(negativeOnly));

  assert.deepEqual(await deps.bank.resolve("read-only"), { path: target, provenance: "user" });
});

test("bank.promote: a draft outside the staging directory is refused", async (t) => {
  const live = liveContext(t, [], []);
  allowReplay(live);
  const deps = await depsOf(live);
  const outside = path.join(live.fx.root, "elsewhere.json");
  fs.copyFileSync(fixturePath("banks", "auto.json"), outside);

  await assert.rejects(deps.bank.promote(outside, "read-only"), /not inside the staging directory/);
  assert.equal(fs.existsSync(bankPathOf(live.fx.base, "read-only")), false);
});

test("the dialogs of the cycle are the ones of the context, and a review is dispatched only once the agent is idle", async (t) => {
  const sent: string[] = [];
  const deferred: (() => void)[] = [];
  let idle = false;
  const live = liveContext(t, [], []);
  const deps = await productionCycleDeps(
    { ...live.ctx, isIdle: () => idle },
    { sendUserMessage: async (content, options) => void sent.push(`${content}|${String(options?.expandPromptTemplates)}`) },
    { agentDir: live.fx.agentDir, config: ENABLED, now: () => NOW, onSettled: (callback) => void deferred.push(callback), tmpdirs: [] },
  );

  deps.dispatchReview("pr-abc123");
  assert.deepEqual(sent, [], "the agent is streaming: nothing is sent now");
  assert.equal(deferred.length, 1);

  // Still busy when it settles: a command run while streaming drops its reload, so the dispatch falls back to a notice.
  deferred[0]();
  assert.deepEqual(sent, []);
  assert.equal(live.ui.notices.some((notice) => notice.message.includes("/skill-improve --review=pr-abc123")), true);

  deps.dispatchReview("pr-abc123");
  idle = true;
  deferred[1]();
  await settle();
  assert.deepEqual(sent, ["/skill-improve --review=pr-abc123|true"]);
});

test("surface.review: with no proposal in the store there is nothing to review, with or without an id", async (t) => {
  const live = liveContext(t, [], []);
  const runtime = createObserveRuntime(
    { sendUserMessage: async () => undefined },
    { agentDir: () => live.fx.agentDir, readConfig: () => ENABLED, now: () => NOW },
  );
  const surface = runtime.surface(live.ctx);
  assert.ok(surface !== undefined);
  const context = { ui: { select: async () => undefined, notify: () => undefined } };

  assert.equal(await surface.review("pr-000000000000", context), "nothing-to-review");
  assert.equal(await surface.review(undefined, context), "nothing-to-review");
});

// ---------------------------------------------------------------------------------------------------------------
// Proposal, gate and acceptance through the real bindings (R2)
// ---------------------------------------------------------------------------------------------------------------

// A scripted model answers the proposer; the staging, the skill, the ledger and the acceptance are the real ones.
const PROPOSER_ANSWER = JSON.stringify({
  title: "Print only the breaking changes",
  body: "- List the breaking changes first and leave out everything else.",
});
const PATTERN: PatternView = {
  id: "pt-0123456789ab",
  skill: "read-only",
  observationIds: [],
  sessions: 2,
  days: 2,
  weight: 0,
  alpha: 1,
  beta: 1,
  pAbove: 0,
  mechanicalOnly: false,
  proposable: true,
};
const NOT_MEASURED: GateClassification = { class: "not-measurable", status: "probation", reason: "not measured" };
const REPLAY_BANK = "case-bank.json";

function skillFileOf(live: Live): string {
  return path.join(live.fx.skillsDir, "read-only", SKILL_FILE);
}

// Proposes through the production `propose` and builds the proposal event the cycle would have stored for it.
async function proposeThroughWire(live: Live, gate: "probation" | "bank"): Promise<ProposalEvent> {
  const deps = await depsOf(live, { ...ENABLED, replayAllow: ["read-only"] });
  const bankPath = gate === "bank" ? fixturePath("banks", "user.json") : null;
  const drafted = await deps.propose({ view: PATTERN, state: foldObserveState([], NOW), gate, bankPath });
  assert.ok(drafted.ok, drafted.ok ? "" : drafted.error);
  return {
    format: OBSERVE_FORMAT,
    type: "proposal",
    at: NOW.toISOString(),
    id: "pr-0123456789ab",
    patternId: PATTERN.id,
    skill: "read-only",
    stagingPath: drafted.value.stagingPath,
    candidateHash: drafted.value.candidateHash,
    skillContentHash: drafted.value.skillContentHash,
    gate,
    bankPath,
    provenance: gate === "bank" ? "user" : null,
    cwd: FIXTURE_CWD,
  };
}

test("propose: the digest of SKILL.md is recorded at the staging and is the digest of the file as it was then", async (t) => {
  const live = liveContext(t, [], [PROPOSER_ANSWER]);
  const before = fs.readFileSync(skillFileOf(live));

  const proposal = await proposeThroughWire(live, "probation");

  assert.equal(proposal.skillContentHash, sha256Digest(before));
  assert.equal(live.model.calls.length, 1);
});

test("accept: a SKILL.md edited after a probation candidate was staged is refused as skill-drift through the real accept", async (t) => {
  const live = liveContext(t, [], [PROPOSER_ANSWER]);
  const proposal = await proposeThroughWire(live, "probation");
  const reviewDeps = productionReviewDeps(live.ctx, { agentDir: live.fx.agentDir, now: () => NOW });

  fs.appendFileSync(skillFileOf(live), "\nAlso read the appendix.\n", "utf8");
  const edited = fs.readFileSync(skillFileOf(live), "utf8");
  const refused = await reviewDeps.accept(proposal, NOT_MEASURED);

  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.error.reason, "skill-drift");
  assert.equal(refused.error.detail.includes(proposal.skillContentHash), true, "the digest compared is the one recorded at the staging");
  assert.equal(fs.readFileSync(skillFileOf(live), "utf8"), edited);
  assert.equal(fs.existsSync(path.join(live.fx.skillsDir, "read-only", LESSONS_DIR)), false);
  assert.equal(await reviewDeps.isAccepted(proposal), false);
});

test("accept: an untouched SKILL.md accepts the probation candidate, the record says probation and the ledger says accepted", async (t) => {
  const live = liveContext(t, [], [PROPOSER_ANSWER]);
  const proposal = await proposeThroughWire(live, "probation");
  const reviewDeps = productionReviewDeps(live.ctx, { agentDir: live.fx.agentDir, now: () => NOW });
  assert.equal(await reviewDeps.isAccepted(proposal), false);

  const accepted = await reviewDeps.accept(proposal, NOT_MEASURED);

  assert.ok(accepted.ok, accepted.ok ? "" : accepted.error.detail);
  assert.equal(fs.existsSync(accepted.value.lessonPath), true);
  const record = JSON.parse(fs.readFileSync(accepted.value.historyPath, "utf8"));
  assert.equal(record.gate.status, "probation");
  assert.equal(record.gate.probation.skillContentHash, proposal.skillContentHash);
  assert.equal(record.outcome.status, "accepted");
  assert.equal(await reviewDeps.isAccepted(proposal), true);
  assert.equal(await (await depsOf(live)).isAccepted(proposal), true, "the cycle reads the same ledger");
});

test("accept: a proposal stored without the digest of its staging is refused and nothing is written", async (t) => {
  const live = liveContext(t, [], [PROPOSER_ANSWER]);
  const proposal = await proposeThroughWire(live, "probation");
  const { skillContentHash: _dropped, ...legacy } = proposal;
  const reviewDeps = productionReviewDeps(live.ctx, { agentDir: live.fx.agentDir, now: () => NOW });

  const refused = await reviewDeps.accept(legacy as ProposalEvent, NOT_MEASURED);

  // A typed refusal, not a throw: the review closes the proposal on it, as it does on skill-drift.
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.error.reason, NO_HASH_REASON);
  assert.match(refused.error.detail, /no skillContentHash/);
  assert.equal(fs.existsSync(path.join(live.fx.skillsDir, "read-only", LESSONS_DIR)), false);
});

// What a case-bank gate writes into the record when it ran and could not tell the lesson from its absence.
function writeNoImprovementRecord(live: Live, proposal: ProposalEvent): void {
  const decisionPath = path.join(live.fx.base, proposal.stagingPath, DECISION_FILE);
  const staged: DecisionRecord = JSON.parse(fs.readFileSync(decisionPath, "utf8"));
  assert.equal(staged.gate.basis, "case-bank");
  assert.equal(staged.gate.status, "not-run");
  const hash = `sha256:${"e".repeat(64)}`;
  const arm = { passes: 1, runs: 4, tokens: { input: 0, output: 0 } };
  const gate: GateBlock = {
    basis: "case-bank",
    status: "gate-abstained",
    budget: { plannedRuns: 8, usedRuns: 8, interruptedAt: null },
    tokens: staged.gate.tokens,
    preregistration: {
      recordedAt: NOW.toISOString(),
      threshold: { rule: "unanimous-and-strictly-better", candidatePasses: 4, incumbentPassesMax: 3, version: 1 },
      design: { reps: 2, items: 2, plannedRuns: 8, arms: ["incumbent", "candidate"] },
      mde: { basis: "case-bank", runsPerArm: 4, resolution: 0.25, requiredDifference: 1 },
      skillContentHash: proposal.skillContentHash,
      caseBank: { path: fixturePath("banks", "user.json"), contentHash: hash, copy: `${proposal.stagingPath}/${REPLAY_BANK}`, cases: 2, rubricHash: null },
    },
    replay: null,
    caseBank: {
      completedAt: NOW.toISOString(),
      verdict: "gate-abstained",
      reason: "no-improvement",
      cases: [],
      arms: { incumbent: arm, candidate: arm },
      interval: { method: "wilson", alpha: 0.05, incumbent: { low: 0, high: 1 }, candidate: { low: 0, high: 1 }, difference: { low: -1, high: 1 } },
      regressions: 0,
      judge: null,
      overlays: { incumbent: "arms/incumbent", candidate: "arms/candidate", skillContentHash: proposal.skillContentHash, manifestHash: hash },
    },
  };
  const concluded: DecisionRecord = { ...staged, gate, outcome: { status: "gate-abstained", reason: "no-improvement", decidedAt: NOW.toISOString() } };
  fs.writeFileSync(decisionPath, `${JSON.stringify(concluded)}\n`, "utf8");
}

test("accept: a candidate the bank could not measure is accepted on probation through the real accept, keeping its basis and result", async (t) => {
  const live = liveContext(t, [], [PROPOSER_ANSWER]);
  const proposal = await proposeThroughWire(live, "bank");
  writeNoImprovementRecord(live, proposal);
  const reviewDeps = productionReviewDeps(live.ctx, { agentDir: live.fx.agentDir, now: () => NOW });

  const accepted = await reviewDeps.accept(proposal, { class: "not-measurable", status: "gate-abstained", reason: "no-improvement" });

  assert.ok(accepted.ok, accepted.ok ? "" : accepted.error.detail);
  assert.equal(fs.existsSync(accepted.value.lessonPath), true);
  const record = JSON.parse(fs.readFileSync(accepted.value.historyPath, "utf8"));
  assert.equal(record.gate.basis, "case-bank");
  assert.equal(record.gate.status, "probation");
  assert.equal(record.gate.caseBank.reason, "no-improvement");
  assert.equal(record.gate.probation.skillContentHash, proposal.skillContentHash);
  assert.equal(record.outcome.status, "accepted");
  assert.deepEqual(validateAgainstSchema({ ...record, outcome: { status: "probation", reason: PROBATION_REASON, decidedAt: NOW.toISOString() } }), []);
});

test("accept: a bank candidate whose gate has not concluded, or whose outcome is a rejection, is not accepted", async (t) => {
  const live = liveContext(t, [], [PROPOSER_ANSWER]);
  const proposal = await proposeThroughWire(live, "bank");
  const reviewDeps = productionReviewDeps(live.ctx, { agentDir: live.fx.agentDir, now: () => NOW });

  // The record still says not-run: no verdict exists, so nothing is turned into probation.
  await assert.rejects(reviewDeps.accept(proposal, { class: "not-measurable", status: "gate-abstained", reason: "no-improvement" }), /not-run/);
  await assert.rejects(reviewDeps.accept(proposal, { class: "rejected", status: "gate-rejected", reason: "below-threshold" }), /only a lesson the gate accepted/);
  assert.equal(fs.existsSync(path.join(live.fx.skillsDir, "read-only", LESSONS_DIR)), false);
});

test("runGate: a skill that is not in observe.replay.allow any more is never replayed, in the review and in the cycle", async (t) => {
  const live = liveContext(t, [], [PROPOSER_ANSWER]);
  const proposal = await proposeThroughWire(live, "bank");
  const callsAfterProposal = live.model.calls.length;
  const reviewDeps = productionReviewDeps(live.ctx, { agentDir: live.fx.agentDir, now: () => NOW });

  // The settings of the agent directory do not list the skill: the proposal was staged under a list that has changed since.
  await assert.rejects(reviewDeps.runGate(proposal, null), /replay\.allow/);
  const cycle = await depsOf(live);
  const outcome = await cycle.runGate({ proposal, bankPath: proposal.bankPath });

  assert.equal(outcome.class, "retryable");
  assert.equal(outcome.reason?.includes("replay.allow"), true);
  assert.equal(live.model.calls.length, callsAfterProposal, "no judge or replay call was made");
  assert.deepEqual(fs.readdirSync(path.join(live.fx.base, proposal.stagingPath)).filter((name) => name === "arms"), []);
});

test("promoteBank: the approved draft of an auto bank is promoted, any other bank is where it was, a probation has none", async (t) => {
  const live = liveContext(t, [], []);
  allowReplay(live);
  const reviewDeps = productionReviewDeps(live.ctx, { agentDir: live.fx.agentDir, now: () => NOW });
  const base: ProposalEvent = {
    format: OBSERVE_FORMAT,
    type: "proposal",
    at: NOW.toISOString(),
    id: "pr-0123456789ab",
    patternId: PATTERN.id,
    skill: "read-only",
    stagingPath: "staging/x/read-only",
    candidateHash: `sha256:${"a".repeat(64)}`,
    skillContentHash: `sha256:${"b".repeat(64)}`,
    gate: "bank",
    bankPath: null,
    provenance: "user",
    cwd: FIXTURE_CWD,
  };
  const draft = path.join(stagingDir(live.fx.base), "observer-banks", "read-only-abc", REPLAY_BANK);
  fs.mkdirSync(path.dirname(draft), { recursive: true });
  fs.copyFileSync(fixturePath("banks", "auto.json"), draft);

  assert.equal(await reviewDeps.promoteBank({ ...base, gate: "probation", provenance: null }), null);
  assert.equal(await reviewDeps.promoteBank({ ...base, bankPath: "/somewhere/bank.json" }), "/somewhere/bank.json");

  const promoted = await reviewDeps.promoteBank({ ...base, bankPath: draft, provenance: "auto" });
  assert.equal(promoted, bankPathOf(live.fx.base, "read-only"));
  assert.equal(fs.readFileSync(promoted as string, "utf8"), fs.readFileSync(draft, "utf8"));
  assert.equal(await reviewDeps.promoteBank({ ...base, bankPath: draft, provenance: "auto" }), promoted, "asked again, the same file");
});

test("proposalViewOf: a lesson erased from staging is said so, and a failure that is not a missing file is not hidden", async (t) => {
  const live = liveContext(t, [], []);
  const env = { base: live.fx.base, now: () => NOW };
  const proposal: ProposalEvent = {
    format: OBSERVE_FORMAT,
    type: "proposal",
    at: NOW.toISOString(),
    id: "pr-0123456789ab",
    patternId: PATTERN.id,
    skill: "read-only",
    stagingPath: "staging/gone/read-only",
    candidateHash: `sha256:${"a".repeat(64)}`,
    skillContentHash: `sha256:${"b".repeat(64)}`,
    gate: "probation",
    bankPath: null,
    provenance: null,
    cwd: FIXTURE_CWD,
  };
  const state = foldObserveState([], NOW);

  const erased = await proposalViewOf(env, state, proposal);
  assert.equal(erased.lesson, "(the text of the lesson is no longer on disk)");

  // A file where the candidate directory should be: the read fails with ENOTDIR and the failure reaches the caller.
  const blocker = path.join(live.fx.base, "staging", "blocked");
  fs.mkdirSync(path.dirname(blocker), { recursive: true });
  fs.writeFileSync(blocker, "not a directory");
  await assert.rejects(proposalViewOf(env, state, { ...proposal, stagingPath: "staging/blocked" }), /ENOTDIR/);
});

test("proposalViewOf: realRuns is the gate's planned runs (arms x repetitions x cases), not how often the pattern was seen", async (t) => {
  const live = liveContext(t, [], []);
  const env = { base: live.fx.base, now: () => NOW };
  const base: ProposalEvent = {
    format: OBSERVE_FORMAT,
    type: "proposal",
    at: NOW.toISOString(),
    id: "pr-0123456789ab",
    patternId: PATTERN.id,
    skill: "read-only",
    stagingPath: "staging/gone/read-only",
    candidateHash: `sha256:${"a".repeat(64)}`,
    skillContentHash: `sha256:${"b".repeat(64)}`,
    gate: "bank",
    bankPath: fixturePath("banks", "user.json"),
    provenance: "user",
    cwd: FIXTURE_CWD,
  };
  const state = foldObserveState([], NOW);

  const twoCases = await proposalViewOf(env, state, base);
  assert.equal(twoCases.bank?.cases.length, 2);
  assert.equal(twoCases.realRuns, 8);

  const bank = JSON.parse(fs.readFileSync(fixturePath("banks", "user.json"), "utf8"));
  bank.cases.push({ id: "third", prompt: "summarise the readme", checks: [{ kind: "contains", value: "readme" }] });
  const threeCasesPath = path.join(live.fx.base, "three-cases.json");
  fs.mkdirSync(live.fx.base, { recursive: true });
  fs.writeFileSync(threeCasesPath, JSON.stringify(bank));
  const threeCases = await proposalViewOf(env, state, { ...base, bankPath: threeCasesPath });
  assert.equal(threeCases.bank?.cases.length, 3);
  assert.equal(threeCases.realRuns, 12);

  const probation = await proposalViewOf(env, state, { ...base, gate: "probation", bankPath: null, provenance: null });
  assert.equal(probation.realRuns, 0);
});

test("proposalViewOf: the pattern is the shortest observation summary of at least 12 characters, capped, and the earliest one is not preferred", async (t) => {
  const live = liveContext(t, [], []);
  const env = { base: live.fx.base, now: () => NOW };
  const note = (id: string, at: string, summary: string): ObserveEvent => ({
    format: OBSERVE_FORMAT,
    type: "observation",
    at,
    id,
    episodeId: null,
    sessionId: `s-${id}`,
    skill: "read-only",
    source: "user-note",
    kind: "correction",
    summary,
    confidence: null,
    weight: 1,
    anchorEntryId: "e0",
    patternId: PATTERN.id,
  });
  const long = "a very long and wordy first description of what the user did not want in the reply";
  const state = foldObserveState(
    [
      note("ob-1", "2026-11-16T09:00:00.000Z", long),
      note("ob-2", "2026-11-16T09:10:00.000Z", "no bullets"),
      note("ob-3", "2026-11-16T09:20:00.000Z", "prose only, no bullets or lists"),
    ],
    NOW,
  );
  const proposal: ProposalEvent = {
    format: OBSERVE_FORMAT,
    type: "proposal",
    at: NOW.toISOString(),
    id: "pr-0123456789ab",
    patternId: PATTERN.id,
    skill: "read-only",
    stagingPath: "staging/gone/read-only",
    candidateHash: `sha256:${"a".repeat(64)}`,
    skillContentHash: `sha256:${"b".repeat(64)}`,
    gate: "probation",
    bankPath: null,
    provenance: null,
    cwd: FIXTURE_CWD,
  };

  const view = await proposalViewOf(env, state, proposal);
  assert.equal(view.patternSummary, "prose only, no bullets or lists");
  assert.equal(view.observations.length, 3);

  const empty = await proposalViewOf(env, foldObserveState([], NOW), proposal);
  assert.equal(empty.patternSummary, "(no observation left in the store)");
});

test("proposalViewOf: the pattern line is the shortest observation summary, once and capped, while the list keeps every summary", async (t) => {
  const live = liveContext(t, [], []);
  const env = { base: live.fx.base, now: () => NOW };
  const proposal: ProposalEvent = {
    format: OBSERVE_FORMAT,
    type: "proposal",
    at: NOW.toISOString(),
    id: "pr-0123456789ab",
    patternId: PATTERN.id,
    skill: "read-only",
    stagingPath: "staging/gone/read-only",
    candidateHash: `sha256:${"a".repeat(64)}`,
    skillContentHash: `sha256:${"b".repeat(64)}`,
    gate: "probation",
    bankPath: null,
    provenance: null,
    cwd: FIXTURE_CWD,
  };
  const observationOf = (id: string, at: string, summary: string): ObservationEvent => ({
    format: OBSERVE_FORMAT,
    type: "observation",
    at,
    id,
    episodeId: null,
    sessionId: `s-${id}`,
    skill: "read-only",
    source: "judge",
    kind: "format",
    summary,
    confidence: 0.8,
    weight: 0.5,
    anchorEntryId: "e1",
    patternId: PATTERN.id,
  });
  const summaries = ["the user asked again for a plain prose answer without any bullet lists", "no bullets", "answers came as bulleted lists, the user wanted prose"];
  const state = foldObserveState(
    summaries.map((summary, index) => observationOf(`ob-${index}`, new Date(NOW.getTime() - (3 - index) * 60_000).toISOString(), summary)),
    NOW,
  );

  const view = await proposalViewOf(env, state, proposal);
  assert.equal(view.patternSummary, "answers came as bulleted lists, the user wanted prose");
  assert.deepEqual(view.observations, summaries);

  const long = foldObserveState([observationOf("ob-long", NOW.toISOString(), "x".repeat(MAX_SUMMARY_CHARS + 50))], NOW);
  assert.equal([...(await proposalViewOf(env, long, proposal)).patternSummary].length, MAX_SUMMARY_CHARS);

  // Exactly 12 characters qualifies; when every summary is under 12 the shortest one is still shown.
  const stateOf = (texts: string[]): ReturnType<typeof foldObserveState> =>
    foldObserveState(texts.map((summary, index) => observationOf(`ob-m${index}`, new Date(NOW.getTime() - (9 - index) * 60_000).toISOString(), summary)), NOW);
  assert.equal((await proposalViewOf(env, stateOf(["no bullets", "twelve chars", "a longer statement here"]), proposal)).patternSummary, "twelve chars");
  assert.equal((await proposalViewOf(env, stateOf(["no lists", "no bullets"]), proposal)).patternSummary, "no lists");
});

test("surface.scan: the cycle of the command sends no nested review message: the command reviews inline with its own context", async () => {
  const sent: string[] = [];
  const dispatched: string[] = [];
  const runtime = createObserveRuntime(
    { sendUserMessage: async (content) => void sent.push(content) },
    {
      agentDir: () => "/agent",
      readConfig: () => ENABLED,
      now: () => NOW,
      cycleDeps: async () => ({ dispatchReview: (id: string) => void dispatched.push(id) }) as unknown as CycleDeps,
      run: async (_input, deps) => {
        deps.dispatchReview("pr-0123456789ab");
        return { ...DONE_REPORT, mode: "scan", proposal: "review-dispatched", proposalId: "pr-0123456789ab" };
      },
    },
  );

  const report = await runtime.surface(fakeContext())?.scan({ mode: "scan" });

  assert.equal(report?.proposal, "review-dispatched");
  assert.equal(report?.proposalId, "pr-0123456789ab");
  assert.deepEqual(dispatched, [], "the cycle's own dispatch is replaced");
  assert.deepEqual(sent, []);
});

// ---------------------------------------------------------------------------------------------------------------
// Fix round 2: idempotent promotion, replay.allow before any write, live proposals, closed memory (R7b)
// ---------------------------------------------------------------------------------------------------------------

// The settings of the agent directory the gate and the promotion read again: the skill is on the replay list.
function allowReplay(live: Live): void {
  fs.writeFileSync(
    path.join(live.fx.agentDir, SETTINGS_FILE),
    JSON.stringify({ "pi-simple-sri": { observe: { replay: { allow: ["read-only"] } } } }),
  );
}

function optInEvent(): ObserveEvent {
  return { format: OBSERVE_FORMAT, type: "opt-in", at: OPT_IN_AT };
}

function tombstoneOf(proposal: ProposalEvent, reason: string, at = NOW.toISOString()): TombstoneEvent {
  return {
    format: OBSERVE_FORMAT,
    type: "tombstone",
    at,
    patternId: proposal.patternId,
    skill: proposal.skill,
    reason: reason as TombstoneEvent["reason"],
    candidateHash: proposal.candidateHash,
  };
}

test("bank: a bank already promoted for the skill reaches the gate as it is, and the cycle does not fail its preparation", async (t) => {
  const live = liveContext(t, [{ kind: "select", answer: "Approve" }], [PROPOSER_ANSWER]);
  allowReplay(live);
  const config: ObserveConfig = { ...ENABLED, replayAllow: ["read-only"] };
  const promoted = bankPathOf(live.fx.base, "read-only");
  fs.mkdirSync(path.dirname(promoted), { recursive: true });
  fs.copyFileSync(fixturePath("banks", "auto.json"), promoted);
  const real = await depsOf(live, config);

  // `resolve` answers the promoted bank with provenance auto, and the cycle promotes what an auto bank names.
  assert.deepEqual(await real.bank.resolve("read-only"), { path: promoted, provenance: "auto" });
  assert.equal(await real.bank.promote(promoted, "read-only"), promoted);

  const gated: (string | null)[] = [];
  const deps: CycleDeps = {
    ...real,
    proposable: () => [{ ...PATTERN }],
    runGate: async ({ bankPath }) => {
      gated.push(bankPath);
      return { class: "retryable", status: "error", reason: "the test stops at the gate" };
    },
  };
  const report = await runObserveCycle(inputOf({ config }), deps);

  assert.equal(report.proposal, "gate-retryable");
  assert.deepEqual(gated, [promoted]);
  assert.deepEqual(foldObserveState(await readObserveLog(live.fx.base), NOW).prepareFailures, []);
  assert.equal(fs.readFileSync(promoted, "utf8"), fs.readFileSync(fixturePath("banks", "auto.json"), "utf8"));

  // The review path answers the same: the promoted bank is the one to gate.
  const reviewDeps = productionReviewDeps(live.ctx, { agentDir: live.fx.agentDir, now: () => NOW });
  const proposal = foldObserveState(await readObserveLog(live.fx.base), NOW).proposals[0];
  assert.equal(await reviewDeps.promoteBank(proposal), promoted);
});

// The proposer is asked a second time for a pattern whose first candidate was closed with `reason`; answers what the model saw.
async function secondAskAfter(t: TestContext, reason: string): Promise<string> {
  const live = liveContext(
    t,
    [],
    [
      JSON.stringify({ title: "Zebra striped breaking changes", body: "- Stripe the breaking changes like a zebra." }),
      JSON.stringify({ title: "Quote the changelog heading", body: "- Quote the heading of each breaking change." }),
    ],
  );
  const first = await proposeThroughWire(live, "probation");
  await appendObserveEvents(live.fx.base, [optInEvent(), first, tombstoneOf(first, reason)]);
  const state = foldObserveState(await readObserveLog(live.fx.base), NOW);
  assert.equal(state.tombstones.length, 1);

  await (await depsOf(live)).propose({ view: PATTERN, state, gate: "probation", bankPath: null });

  assert.equal(live.model.calls.length, 2);
  return JSON.stringify(live.model.calls[1].context);
}

test("propose: the rejected-candidate memory holds what was refused and leaves out the lessons that were accepted or went stale", async (t) => {
  const refused = await secondAskAfter(t, "user-rejected");
  assert.equal(refused.includes("Zebra striped breaking changes"), true, "a refused lesson is shown so it is not proposed again");
  assert.equal(refused.includes("propose something different"), true);

  for (const reason of ["accepted", "stale"]) {
    const closed = await secondAskAfter(t, reason);
    assert.equal(closed.includes("Zebra striped breaking changes"), false, reason);
    assert.equal(closed.includes("propose something different"), false, reason);
  }
});

test("surface.review: with no id only the latest proposal of a pattern is reviewed, a superseded one is never offered again", async (t) => {
  const live = liveContext(t, [], [PROPOSER_ANSWER]);
  const staged = await proposeThroughWire(live, "probation");
  const older: ProposalEvent = { ...staged, id: "pr-aaaaaaaaaaaa", at: "2026-11-15T10:00:00.000Z" };
  const latest: ProposalEvent = {
    ...staged,
    id: "pr-bbbbbbbbbbbb",
    at: "2026-11-15T11:00:00.000Z",
    candidateHash: `sha256:${"c".repeat(64)}`,
  };
  await appendObserveEvents(live.fx.base, [optInEvent(), older, latest]);
  const surface = createObserveRuntime(
    { sendUserMessage: async () => undefined },
    { agentDir: () => live.fx.agentDir, readConfig: () => ENABLED, now: () => NOW },
  ).surface(live.ctx);
  assert.ok(surface !== undefined);
  let asked = 0;
  const context = {
    ui: {
      select: async () => {
        asked += 1;
        return undefined;
      },
      notify: () => undefined,
    },
  };

  // Control: while the latest is open it is the one the user is asked about, once.
  assert.equal(await surface.review(undefined, context), "declined");
  assert.equal(asked, 1);

  // The latest is closed: the older one of the same pattern is superseded, not next in line.
  await appendObserveEvents(live.fx.base, [tombstoneOf(latest, "user-rejected")]);
  asked = 0;
  assert.equal(await surface.review(undefined, context), "nothing-to-review");
  assert.equal(asked, 0);
});

test("review: a skill taken out of observe.replay.allow gets no bank written and no replay, and the review stays retryable", async (t) => {
  const live = liveContext(t, [], [PROPOSER_ANSWER]);
  const staged = await proposeThroughWire(live, "bank");
  const draft = path.join(stagingDir(live.fx.base), "observer-banks", "read-only-0123456789ab", REPLAY_BANK);
  fs.mkdirSync(path.dirname(draft), { recursive: true });
  fs.copyFileSync(fixturePath("banks", "auto.json"), draft);
  const proposal: ProposalEvent = { ...staged, provenance: "auto", bankPath: draft };
  await appendObserveEvents(live.fx.base, [
    optInEvent(),
    proposal,
    { format: OBSERVE_FORMAT, type: "prompt", at: NOW.toISOString(), proposalId: proposal.id, stage: "a", answer: "approve" },
  ]);
  const surface = createObserveRuntime(
    { sendUserMessage: async () => undefined },
    { agentDir: () => live.fx.agentDir, readConfig: () => ENABLED, now: () => NOW },
  ).surface(live.ctx);
  assert.ok(surface !== undefined);
  const notices: string[] = [];
  const callsBefore = live.model.calls.length;

  // The settings of the agent directory do not list the skill.
  const result = await surface.review(proposal.id, {
    ui: {
      select: async () => {
        throw new Error("no dialog is expected: the review stops before the gate");
      },
      notify: (message) => void notices.push(message),
    },
  });

  assert.equal(result, "retryable");
  assert.equal(notices.some((notice) => notice.includes("replay.allow")), true, notices.join("|"));
  assert.equal(fs.existsSync(bankPathOf(live.fx.base, "read-only")), false, "no bank was written");
  assert.equal(foldObserveState(await readObserveLog(live.fx.base), NOW).gateOutcomes.length, 0, "no gate ran");
  assert.equal(live.model.calls.length, callsBefore, "nothing was replayed");

  // The cycle's promotion does not write either: the draft goes on to the gate, which refuses it as retryable.
  const cycle = await depsOf(live, { ...ENABLED, replayAllow: ["read-only"] });
  assert.equal(await cycle.bank.promote(draft, "read-only"), draft);
  assert.equal(fs.existsSync(bankPathOf(live.fx.base, "read-only")), false);
  const outcome = await cycle.runGate({ proposal, bankPath: draft });
  assert.equal(outcome.class, "retryable");
  assert.equal(outcome.reason?.includes("replay.allow"), true);
});

test("discardArtifacts: the draft bank and the generated bank of a forgotten skill are erased with the helpers of --forget", async (t) => {
  const live = liveContext(t, [], []);
  const draft = path.join(stagingDir(live.fx.base), "observer-banks", "read-only-0123456789ab", REPLAY_BANK);
  fs.mkdirSync(path.dirname(draft), { recursive: true });
  fs.copyFileSync(fixturePath("banks", "auto.json"), draft);
  const promoted = bankPathOf(live.fx.base, "read-only");
  fs.mkdirSync(path.dirname(promoted), { recursive: true });
  fs.copyFileSync(fixturePath("banks", "auto.json"), promoted);

  await (await depsOf(live)).discardArtifacts("read-only");

  assert.equal(fs.existsSync(path.dirname(draft)), false);
  assert.equal(fs.existsSync(promoted), false);
});

async function stageCandidate(live: Live, skill: string, stamp: string, event: AttemptEvent, candidate: string): Promise<{ lesson: string; bank: string }> {
  const relative = path.join("staging", stamp, skill);
  const dir = path.join(live.fx.base, relative);
  fs.mkdirSync(path.join(dir, LESSONS_DIR), { recursive: true });
  const lesson = path.join(dir, LESSONS_DIR, "a-lesson.md");
  const bank = path.join(dir, REPLAY_BANK);
  fs.writeFileSync(lesson, "lesson text\n");
  fs.writeFileSync(bank, "{}\n");
  const hash = attemptSignature(event, skill, candidate);
  await appendAttemptLine(
    live.fx.base,
    buildAttemptLine({
      now: NOW,
      event,
      targetSkill: skill,
      hashes: { candidateHash: hash, bodyHash: hash },
      failureSignature: null,
      stagingPath: relative,
    }),
  );
  return { lesson, bank };
}

test("discardArtifacts: erases the artifacts but never rewrites observe.jsonl: a note recorded after the forget survives and no second forget is appended", async (t) => {
  const live = liveContext(t, [], []);
  const skill = "read-only";
  const forgetAt = "2026-11-16T10:00:00.000Z";
  const noteAt = "2026-11-16T10:03:00.000Z";
  await appendObserveEvents(live.fx.base, [
    { format: OBSERVE_FORMAT, type: "opt-in", at: OPT_IN_AT },
    { format: OBSERVE_FORMAT, type: "forget", at: forgetAt, skill },
    {
      format: OBSERVE_FORMAT,
      type: "observation",
      at: noteAt,
      id: "ob-note",
      episodeId: null,
      sessionId: "s-note",
      skill,
      source: "user-note",
      kind: "correction",
      summary: "the user wants headers",
      confidence: null,
      weight: 1,
      anchorEntryId: "e0",
      patternId: "pt-note",
    },
  ]);
  const logPath = path.join(stateDir(live.fx.base), OBSERVE_FILE);
  const before = fs.readFileSync(logPath);

  const draft = path.join(stagingDir(live.fx.base), "observer-banks", `${skill}-0123456789ab`);
  fs.mkdirSync(draft, { recursive: true });
  fs.writeFileSync(path.join(draft, REPLAY_BANK), "{}\n");
  const rejected = await stageCandidate(live, skill, "20261101T000000000Z", "gate-rejected", "rejected");
  const accepted = await stageCandidate(live, skill, "20261102T000000000Z", "proposed", "kept");
  const acceptedHash = attemptSignature("proposed", skill, "kept");
  await appendAttemptLine(
    live.fx.base,
    buildAttemptLine({
      now: NOW,
      event: "accepted",
      targetSkill: skill,
      hashes: { candidateHash: acceptedHash, bodyHash: acceptedHash },
      failureSignature: null,
      historyPath: `skills/${skill}/.history/x/decision.json`,
    }),
  );
  const auto = bankPathOf(live.fx.base, skill);
  fs.mkdirSync(path.dirname(auto), { recursive: true });
  fs.copyFileSync(fixturePath("banks", "auto.json"), auto);
  const user = bankPathOf(live.fx.base, "other-skill");
  fs.copyFileSync(fixturePath("banks", "user.json"), user);

  await (await depsOf(live)).discardArtifacts(skill);

  assert.deepEqual(fs.readFileSync(logPath), before, "observe.jsonl is byte-identical");
  const events = await readObserveLog(live.fx.base);
  assert.equal(events.filter((event) => event.type === "forget").length, 1, "no second forget");
  assert.equal(events.some((event) => event.type === "observation" && event.id === "ob-note"), true, "the later note survives");

  assert.equal(fs.existsSync(draft), false, "the draft is erased");
  assert.equal(fs.existsSync(rejected.lesson), false);
  assert.equal(fs.existsSync(rejected.bank), false);
  assert.equal(fs.existsSync(auto), false, "the auto bank is erased");
  assert.equal(fs.existsSync(accepted.lesson), true, "an accepted candidate keeps its lesson");
  assert.equal(fs.existsSync(accepted.bank), false, "but its bank copy holds the user's prompts word for word, so it is erased");
  assert.equal(fs.existsSync(user), true, "a user bank stays");
});

test("discardArtifacts: works while the scan lock is held and does not throw", async (t) => {
  const live = liveContext(t, [], []);
  const skill = "read-only";
  const auto = bankPathOf(live.fx.base, skill);
  fs.mkdirSync(path.dirname(auto), { recursive: true });
  fs.copyFileSync(fixturePath("banks", "auto.json"), auto);
  const deps = await depsOf(live);

  const held = await withScanLock(live.fx.base, async () => {
    await deps.discardArtifacts(skill);
    return "done";
  });

  assert.deepEqual(held, { ok: true, value: "done" });
  assert.equal(fs.existsSync(auto), false);
});
