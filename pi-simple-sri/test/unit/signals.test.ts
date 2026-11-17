import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { MAX_EXCERPT_CODE_POINTS } from "../../src/evidence.ts";
import { SIGNALS_FILE } from "../../src/names.ts";
import {
  createSignalCollector,
  detectSignals,
  emptySignalState,
  foldObservation,
  OPEN_CAP,
  REMEMBERED_PROMPTS,
  SIGNAL_FORMAT,
  SIGNAL_KINDS,
  TRACKED_PATHS,
  turnObservationOf,
  type RaisedSignalLine,
  type SignalCollector,
  type SignalState,
  type TurnObservation,
  type WriteCall,
} from "../../src/signals.ts";
import { stateDir } from "../../src/write-base.ts";
import { skillBlockText } from "./observe-fixtures.ts";

// The collector of silent signals (M3, S5, Q25). Two halves are tested apart, the way the module is split: the detection is
// a function of an observation and a state, and the collector is the half that names a suspicion, remembers it and writes
// it. Every test names a base in mkdtemp -- the file of signals lands under it -- and none reads or writes the state of a
// real installation.
//
// What this suite cannot check by running it is whether the two signals are the ones Q25 wanted: the rule of a rewritten
// draft and the rule of a repeated request are transcribed from the lens, and the cases below fix the reading, not the
// judgement that this reading is the right one.

const SESSION = "session-signals";
const NOTES = "/work/notes.md";

interface Fixture {
  base: string;
}

function createFixture(t: TestContext): Fixture {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-signals-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base };
}

function signalsPath(fixture: Fixture): string {
  return path.join(stateDir(fixture.base), SIGNALS_FILE);
}

// The collector as the wiring uses it: created over the base of the run and hydrated once for the session.
async function hydratedCollector(fixture: Fixture): Promise<SignalCollector> {
  const collector = createSignalCollector(() => fixture.base);
  await collector.hydrate(fixture.base, SESSION);
  return collector;
}

function observation(turnIndex: number, overrides: Partial<TurnObservation> = {}): TurnObservation {
  return { turnIndex, writes: [], userPrompt: null, ...overrides };
}

function writeCall(target: string, argsHash: string): WriteCall {
  return { path: target, argsHash };
}

function raisedLine(overrides: Partial<RaisedSignalLine> = {}): RaisedSignalLine {
  return {
    format: SIGNAL_FORMAT,
    event: "raised",
    id: "sg-00000000",
    kind: "rewritten-draft",
    createdAt: "2026-11-02T14:03:22.481Z",
    sessionId: SESSION,
    turnIndex: 2,
    subject: NOTES,
    excerpt: `turn 1: ${NOTES}`,
    prompt: "",
    ...overrides,
  };
}

function seedSignalsFile(fixture: Fixture, lines: readonly RaisedSignalLine[]): void {
  fs.mkdirSync(stateDir(fixture.base), { recursive: true });
  fs.writeFileSync(signalsPath(fixture), lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");
}

// The id of a suspicion, computed here and not with the collector's own function: the expected identity of a suspicion is
// the one an independent computation produces.
function expectedId(kind: string, turnIndex: number, subject: string): string {
  const material = JSON.stringify([kind, SESSION, turnIndex, subject]);
  return `sg-${createHash("sha256").update(material).digest("hex").slice(0, 8)}`;
}

// The consumption of a suspicion is recorded without making the caller wait (see `take`), so the assertion waits for the
// line instead of racing the append: a bounded spin on the file, and the failure names what it was waiting for.
async function waitForLine(file: string, needle: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (fs.existsSync(file)) {
      const line = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .find((candidate) => candidate.includes(needle));
      if (line !== undefined) return line;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`${file} never carried a line with ${needle}`);
}

function linesOf(file: string): string[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

test("detectSignals: two writes of one file in different turns with other arguments raise one rewritten-draft", async (t) => {
  const fixture = createFixture(t);
  const collector = await hydratedCollector(fixture);

  const first = await collector.observe(
    observation(1, { writes: [writeCall(NOTES, "sha256:one")], userPrompt: "write the notes of the meeting" }),
  );
  const second = await collector.observe(observation(2, { writes: [writeCall(NOTES, "sha256:two")] }));

  assert.deepEqual(first, []);
  assert.equal(second.length, 1);
  const [suspicion] = second;
  assert.equal(suspicion.kind, "rewritten-draft");
  assert.equal(suspicion.subject, NOTES);
  assert.equal(suspicion.turnIndex, 2);
  assert.equal(suspicion.sessionId, SESSION);
  // The prompt travels as the turn had it, and a turn without a user message says so with the empty string.
  assert.equal(suspicion.prompt, "");
  assert.equal(suspicion.model, undefined);
  assert.equal(suspicion.excerpt, `turn 1: ${NOTES}`);
  assert.equal(suspicion.id, expectedId("rewritten-draft", 2, NOTES));
  assert.match(suspicion.id, /^sg-[0-9a-f]{8}$/);
  // The moment is a date-time of the one clock, not a counter.
  assert.equal(suspicion.createdAt, new Date(suspicion.createdAt).toISOString());

  // The suspicion is open, and the file carries its `raised` line: the memory survives the session that raised it.
  assert.deepEqual(
    collector.pending().map((open) => open.id),
    [suspicion.id],
  );
  assert.deepEqual(linesOf(signalsPath(fixture)), [JSON.stringify(raisedLine({ id: suspicion.id, createdAt: suspicion.createdAt }))]);
});

test("detectSignals: two writes of one file in the same turn raise nothing", async (t) => {
  const fixture = createFixture(t);
  const collector = await hydratedCollector(fixture);

  const raised = await collector.observe(
    observation(1, { writes: [writeCall(NOTES, "sha256:one"), writeCall(NOTES, "sha256:two")] }),
  );

  assert.deepEqual(raised, []);
  assert.deepEqual(collector.pending(), []);
  // Two calls of one turn are the model refining its own draft, so the file is never created.
  assert.equal(fs.existsSync(signalsPath(fixture)), false);
});

test("detectSignals: the same arguments in two turns raise nothing", async (t) => {
  const fixture = createFixture(t);
  const collector = await hydratedCollector(fixture);

  await collector.observe(observation(1, { writes: [writeCall(NOTES, "sha256:one")] }));
  const raised = await collector.observe(observation(2, { writes: [writeCall(NOTES, "sha256:one")] }));

  assert.deepEqual(raised, []);
});

test("detectSignals: a prompt that repeats three significant tokens of the one before raises a repeated-request", async (t) => {
  const fixture = createFixture(t);
  const collector = await hydratedCollector(fixture);
  const current = "revisa el informe trimestral completo";

  await collector.observe(observation(1, { userPrompt: "revisa el informe trimestral completo del cliente" }));
  const raised = await collector.observe(observation(2, { userPrompt: current }));

  assert.equal(raised.length, 1);
  const [suspicion] = raised;
  assert.equal(suspicion.kind, "repeated-request");
  // The subject is the prompt normalized -- lowercased tokens of five code points or more, in order -- and the excerpt is
  // the prompt as the user wrote it.
  assert.equal(suspicion.subject, "revisa informe trimestral completo");
  assert.equal(suspicion.excerpt, current);
  assert.equal(suspicion.prompt, current);
  assert.equal(suspicion.id, expectedId("repeated-request", 2, "revisa informe trimestral completo"));
});

test("detectSignals: two prompts with no significant token in common raise nothing", async (t) => {
  const fixture = createFixture(t);
  const collector = await hydratedCollector(fixture);

  await collector.observe(observation(1, { userPrompt: "revisa el informe trimestral completo" }));
  const raised = await collector.observe(observation(2, { userPrompt: "corrige las rutas absolutas del despliegue" }));

  assert.deepEqual(raised, []);
});

test("detectSignals: two shared tokens are below the floor and raise nothing", async (t) => {
  const fixture = createFixture(t);
  const collector = await hydratedCollector(fixture);

  await collector.observe(observation(1, { userPrompt: "revisa el informe trimestral completo" }));
  const raised = await collector.observe(observation(2, { userPrompt: "revisa el informe" }));

  assert.deepEqual(raised, []);
});

// The agent loop runs several turns under one prompt, so the prompt of a turn is often the one of the turn before. That is
// the same user message and not a second request: the detection lets it go, which is the one reading this rule costs.
test("detectSignals: the prompt of the previous turn is the same message and raises nothing", async (t) => {
  const fixture = createFixture(t);
  const collector = await hydratedCollector(fixture);
  const prompt = "revisa el informe trimestral completo del cliente";

  await collector.observe(observation(1, { userPrompt: prompt }));
  const raised = await collector.observe(observation(2, { userPrompt: prompt }));

  assert.deepEqual(raised, []);
});

// The three constants of the memory are named and capped because the collector runs in every turn of every session. The
// oldest value is the one dropped, so what a session keeps is what it was doing last.
test("the state of the collector stops at TRACKED_PATHS files and REMEMBERED_PROMPTS prompts", () => {
  let state: SignalState = emptySignalState();
  for (let index = 0; index < 40; index++) {
    state = foldObservation(state, observation(index, { writes: [writeCall(`/work/file-${index}.md`, "sha256:x")] }));
  }

  assert.equal(state.paths.length, TRACKED_PATHS);
  assert.equal(state.paths[0].path, "/work/file-39.md");
  assert.equal(state.paths.at(-1)?.path, `/work/file-${40 - TRACKED_PATHS}.md`);

  let prompts: SignalState = emptySignalState();
  for (let index = 0; index < 40; index++) {
    // One token of its own per prompt, so the 40 are distinct and the cap is the only thing that trims them.
    prompts = foldObservation(prompts, observation(index, { userPrompt: `prompt number${index}` }));
  }
  assert.equal(prompts.prompts.length, REMEMBERED_PROMPTS);
});

// The other cap: a session that raised more suspicions than the collector keeps open loses the oldest one, and the file is
// what keeps it.
test("the open suspicions of the collector stop at OPEN_CAP", async (t) => {
  const fixture = createFixture(t);
  const collector = await hydratedCollector(fixture);

  for (let index = 0; index < OPEN_CAP + 4; index++) {
    const target = `/work/file-${index}.md`;
    await collector.observe(observation(2 * index, { writes: [writeCall(target, "sha256:one")] }));
    await collector.observe(observation(2 * index + 1, { writes: [writeCall(target, "sha256:two")] }));
  }

  const open = collector.pending();
  assert.equal(open.length, OPEN_CAP);
  // Newest first: the ones kept are the last OPEN_CAP raised.
  assert.equal(open[0].subject, `/work/file-${OPEN_CAP + 3}.md`);
  assert.equal(open.at(-1)?.subject, `/work/file-${4}.md`);
});

// The id is the identity of one occurrence, so a suspicion the file already carries -- raised by another session start of
// the same session, or simply hydrated -- is not raised a second time.
test("observe answers only the new ones: an id the file already carries is not raised again", async (t) => {
  const fixture = createFixture(t);
  const id = expectedId("rewritten-draft", 2, NOTES);
  seedSignalsFile(fixture, [raisedLine({ id })]);
  const collector = await hydratedCollector(fixture);

  assert.deepEqual(
    collector.pending().map((open) => open.id),
    [id],
  );

  await collector.observe(observation(1, { writes: [writeCall(NOTES, "sha256:one")] }));
  const raised = await collector.observe(observation(2, { writes: [writeCall(NOTES, "sha256:two")] }));

  assert.deepEqual(raised, []);
  // The line of the file is the only one the file has: nothing was appended for an id that was already there.
  assert.equal(linesOf(signalsPath(fixture)).length, 1);
});

// The fold reads the last event of every id: `raised` opens and `consumed` closes, so a suspicion someone confirmed is not
// pending in the next session.
test("hydrate folds the file: a consumed id is not pending and an unknown line is skipped", async (t) => {
  const fixture = createFixture(t);
  fs.mkdirSync(stateDir(fixture.base), { recursive: true });
  fs.writeFileSync(
    signalsPath(fixture),
    [
      `${JSON.stringify(raisedLine({ id: "sg-11111111" }))}`,
      // A line of another format, a line that is not JSON and a line without its fields: skipped and counted, never thrown.
      `${JSON.stringify({ format: "pi-simple-sri/signal@2", event: "raised", id: "sg-22222222" })}`,
      "not json at all",
      `${JSON.stringify({ format: SIGNAL_FORMAT, event: "raised", id: "sg-33333333" })}`,
      `${JSON.stringify({ format: SIGNAL_FORMAT, event: "consumed", id: "sg-11111111", at: "2026-11-02T15:00:00.000Z" })}`,
      // A truncated tail: the last line was never finished, so it is discarded instead of read as the event it almost was.
      '{"format":"pi-simple-sri/signal@1","event":"raised","id":"sg-44444',
    ].join("\n"),
    "utf8",
  );

  const collector = await hydratedCollector(fixture);

  assert.deepEqual(collector.pending(), []);
});

// The fold of the file answers `open` and `known` together: the file is rewritten past its ceiling with the last event of
// every id, oldest first (B3: the reader folds from the tail, so the tail has to be the newest end), and every id survives
// the rewrite.
test("hydrate rewrites a file over its ceiling with the last event of every id, oldest first", async (t) => {
  const fixture = createFixture(t);
  const ids = 20;
  const rounds = 7;
  const lines: string[] = [];
  // 140 lines over 20 ids, one round of every id after the other: 140 is over the ceiling of the file, so the hydration
  // folds it, and the last round is the one that decides the last event of every id.
  for (let round = 0; round < rounds; round++) {
    for (let index = 0; index < ids; index++) {
      const id = `sg-${index.toString(16).padStart(8, "0")}`;
      lines.push(
        `${JSON.stringify(
          round % 2 === 0
            ? raisedLine({ id })
            : { format: SIGNAL_FORMAT, event: "consumed", id, at: "2026-11-02T15:00:00.000Z" },
        )}`,
      );
    }
  }
  fs.mkdirSync(stateDir(fixture.base), { recursive: true });
  fs.writeFileSync(signalsPath(fixture), `${lines.join("\n")}\n`, "utf8");

  const collector = await hydratedCollector(fixture);

  const rewritten = linesOf(signalsPath(fixture));
  assert.equal(rewritten.length, ids);
  // Oldest first, one line per id: the id whose last event was the oldest is the first line, the newest one is the last.
  assert.equal(JSON.parse(rewritten[0]).id, "sg-00000000");
  assert.equal(JSON.parse(rewritten.at(-1) ?? "{}").id, `sg-${(ids - 1).toString(16).padStart(8, "0")}`);
  // The last event of every id is `raised`, so all of them are open and the fold keeps no more than OPEN_CAP, newest first.
  assert.equal(collector.pending().length, OPEN_CAP);
  assert.equal(collector.pending()[0].id, `sg-${(ids - 1).toString(16).padStart(8, "0")}`);

  // The point of the order: a session that reads the rewritten file sees the same open suspicions, in the same order, as the
  // one that rewrote it. A file written newest first would have made the next fold take the oldest ones for the newest.
  const next = await hydratedCollector(fixture);
  assert.deepEqual(
    next.pending().map((open) => open.id),
    collector.pending().map((open) => open.id),
  );
});

// B3: the ceiling is of lines, and the rewrite keeps the newest ones: ids that outnumber the ceiling lose the oldest, and the
// ones that stay are the last MAX_SIGNAL_LINES of the file, still in chronological order.
test("hydrate keeps the newest 128 ids when the file holds more, in chronological order", async (t) => {
  const fixture = createFixture(t);
  const total = 140;
  const seeded: RaisedSignalLine[] = [];
  for (let index = 0; index < total; index++) {
    seeded.push(raisedLine({ id: `sg-${index.toString(16).padStart(8, "0")}`, subject: `/work/file-${index}.md` }));
  }
  seedSignalsFile(fixture, seeded);

  const collector = await hydratedCollector(fixture);

  const rewritten = linesOf(signalsPath(fixture)).map((line) => JSON.parse(line).id);
  assert.equal(rewritten.length, 128);
  assert.equal(rewritten[0], `sg-${(total - 128).toString(16).padStart(8, "0")}`);
  assert.equal(rewritten.at(-1), `sg-${(total - 1).toString(16).padStart(8, "0")}`);
  assert.equal(collector.pending()[0].id, `sg-${(total - 1).toString(16).padStart(8, "0")}`);
});

function idOf(index: number): string {
  return `sg-${index.toString(16).padStart(8, "0")}`;
}

// B3 under concurrency: another session appends between this session's read and its rename. The hook runs exactly there.
test("compaction carries a line another session appended between the read and the rename, in order", async (t) => {
  const fixture = createFixture(t);
  const total = 140;
  seedSignalsFile(
    fixture,
    Array.from({ length: total }, (_, index) => raisedLine({ id: idOf(index), subject: `/work/file-${index}.md` })),
  );
  const appendedId = idOf(0xabc);
  const collector = createSignalCollector(() => fixture.base, {
    afterRead: () => {
      fs.appendFileSync(signalsPath(fixture), `${JSON.stringify(raisedLine({ id: appendedId }))}\n`, "utf8");
    },
  });
  await collector.hydrate(fixture.base, SESSION);

  const ids = linesOf(signalsPath(fixture)).map((line) => JSON.parse(line).id);
  // The newest 128 of what was read, oldest first, and the concurrent line after them.
  assert.equal(ids.length, 129);
  assert.deepEqual(ids.slice(0, 128), Array.from({ length: 128 }, (_, index) => idOf(total - 128 + index)));
  assert.equal(ids[128], appendedId);
});

// Another session compacted first: the file is shorter than the number of lines this session read, and what it appended after
// that compaction must not be skipped by a count of lines.
test("compaction carries lines appended after another session compacted the file first", async (t) => {
  const fixture = createFixture(t);
  const total = 140;
  seedSignalsFile(
    fixture,
    Array.from({ length: total }, (_, index) => raisedLine({ id: idOf(index), subject: `/work/file-${index}.md` })),
  );
  const afterCompactionIds = [idOf(0xaaa), idOf(0xbbb)];
  const collector = createSignalCollector(() => fixture.base, {
    afterRead: () => {
      const kept = Array.from({ length: 128 }, (_, index) =>
        raisedLine({ id: idOf(total - 128 + index), subject: `/work/file-${total - 128 + index}.md` }),
      );
      const appended = afterCompactionIds.map((id) => raisedLine({ id }));
      fs.writeFileSync(signalsPath(fixture), [...kept, ...appended].map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");
    },
  });
  await collector.hydrate(fixture.base, SESSION);

  const ids = linesOf(signalsPath(fixture)).map((line) => JSON.parse(line).id);
  assert.equal(ids.length, 130);
  assert.deepEqual(ids.slice(128), afterCompactionIds);
  assert.equal(new Set(ids).size, 130);
});

test("take consumes the suspicion, records it and a second take does not find it", async (t) => {
  const fixture = createFixture(t);
  const collector = await hydratedCollector(fixture);
  await collector.observe(observation(1, { writes: [writeCall(NOTES, "sha256:one")] }));
  const [raised] = await collector.observe(observation(2, { writes: [writeCall(NOTES, "sha256:two")] }));

  assert.deepEqual(
    collector.take(raised.id),
    raised,
  );
  assert.deepEqual(collector.pending(), []);
  assert.equal(collector.take(raised.id), undefined);

  const consumed: Record<string, unknown> = JSON.parse(await waitForLine(signalsPath(fixture), '"consumed"'));
  assert.deepEqual(Object.keys(consumed).sort(), ["at", "event", "format", "id"]);
  assert.equal(consumed.format, SIGNAL_FORMAT);
  assert.equal(consumed.event, "consumed");
  assert.equal(consumed.id, raised.id);
  assert.equal(consumed.at, new Date(String(consumed.at)).toISOString());
});

// M3, S6: the confirmation of a suspicion names the skill the attempt was opened for, and the line keeps it when the caller
// knows it. The absence is the other half and not an oversight: a caller that consumes a suspicion without opening an attempt
// has no name to give, and the id is still closed by the moment alone.
test("take records the skill on the consumed line when the caller names it", async (t) => {
  const fixture = createFixture(t);
  const collector = await hydratedCollector(fixture);
  await collector.observe(observation(1, { writes: [writeCall(NOTES, "sha256:one")] }));
  const [raised] = await collector.observe(observation(2, { writes: [writeCall(NOTES, "sha256:two")] }));

  assert.deepEqual(
    collector.take(raised.id, "my-skill"),
    raised,
  );
  assert.deepEqual(collector.pending(), []);
  // The second take of the same id does not find it, whatever skill it names.
  assert.equal(collector.take(raised.id, "my-skill"), undefined);

  const consumed: Record<string, unknown> = JSON.parse(await waitForLine(signalsPath(fixture), '"consumed"'));
  assert.deepEqual(Object.keys(consumed).sort(), ["at", "event", "format", "id", "skill"]);
  assert.equal(consumed.format, SIGNAL_FORMAT);
  assert.equal(consumed.event, "consumed");
  assert.equal(consumed.id, raised.id);
  assert.equal(consumed.skill, "my-skill");
  assert.equal(consumed.at, new Date(String(consumed.at)).toISOString());
});

test("detectSignals does not modify the state it is given", () => {
  const state: SignalState = {
    paths: [{ path: NOTES, turnIndex: 1, argsHash: "sha256:one" }],
    prompts: [{ tokens: ["revisa", "informe", "trimestral"] }],
  };
  const before = structuredClone(state);

  const detected = detectSignals(
    observation(2, { writes: [writeCall(NOTES, "sha256:two")], userPrompt: "revisa el informe trimestral completo" }),
    state,
  );

  assert.equal(detected.length, 2);
  assert.deepEqual(detected.map((signal) => signal.kind), ["rewritten-draft", "repeated-request"]);
  assert.deepEqual(state, before);
});

// The vocabulary is closed: the schema of the file declares the same two kinds and the manual teaches both.
test("SIGNAL_KINDS declares the two kinds of the format", () => {
  assert.deepEqual([...SIGNAL_KINDS], ["rewritten-draft", "repeated-request"]);
  assert.equal(SIGNAL_FORMAT, "pi-simple-sri/signal@1");
});

// ---------------------------------------------------------------------------------------------------------------------
// B1 (the prompt is what the user typed) and B2 (the turn is the user prompt, not pi's turn counter)
// ---------------------------------------------------------------------------------------------------------------------

const USAGE: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const SOURCES = { cwd: "/work", model: undefined };
function invocation(args?: string): string {
  return skillBlockText("pdf-tools", "/skills/pdf-tools/SKILL.md", "SKILL BODY", args);
}

function userEntry(id: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-11-02T14:00:00.000Z",
    message: { role: "user", content: text, timestamp: 0 },
  };
}

function assistantMessage(content: ToolCall[]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: USAGE,
    stopReason: "toolUse",
    timestamp: 0,
  };
}

function assistantEntry(id: string, message: AssistantMessage): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: "2026-11-02T14:00:01.000Z", message };
}

function writeMessage(callId: string, target: string, content: string): AssistantMessage {
  return assistantMessage([{ type: "toolCall", id: callId, name: "write", arguments: { path: target, content } }]);
}

function expectedAnchoredId(kind: string, anchorEntryId: string, subject: string): string {
  const material = JSON.stringify([kind, SESSION, anchorEntryId, subject]);
  return `sg-${createHash("sha256").update(material).digest("hex").slice(0, 8)}`;
}

test("turnObservationOf: the prompt of a skill invocation is what follows the <skill> block, not the block", () => {
  const typed = "extract the merged-cell table from report.pdf";
  const branch = [userEntry("u1", invocation(typed))];

  const observed = turnObservationOf({ turnIndex: 0, message: writeMessage("c1", NOTES, "one") }, branch, SOURCES);

  assert.equal(observed.userPrompt, typed);
  assert.equal(observed.userPrompt?.includes("SKILL BODY"), false);
});

test("turnObservationOf: a message that is only the <skill> block is not a prompt", () => {
  const branch = [userEntry("u1", invocation())];

  const observed = turnObservationOf({ turnIndex: 0, message: writeMessage("c1", NOTES, "one") }, branch, SOURCES);

  assert.equal(observed.userPrompt, null);
  assert.equal(observed.anchorEntryId, undefined);
});

// The block is the skill's own text: it repeats at every invocation, so a collector that read it as a prompt would flag the
// second invocation of any skill as a repeated request.
test("a second invocation of a skill with a different request is not a repeated request", async (t) => {
  const fixture = createFixture(t);
  const collector = await hydratedCollector(fixture);
  const first = [userEntry("u1", invocation("extract the table from report.pdf"))];
  const second = [
    ...first,
    assistantEntry("a1", writeMessage("c1", NOTES, "one")),
    userEntry("u2", invocation("summarize the invoice from march")),
  ];

  await collector.observe(turnObservationOf({ turnIndex: 0, message: writeMessage("c1", NOTES, "one") }, first, SOURCES));
  const raised = await collector.observe(
    turnObservationOf({ turnIndex: 0, message: writeMessage("c2", "/work/other.md", "two") }, second, SOURCES),
  );

  assert.deepEqual(raised, []);
});

test("turnObservationOf: the index is the ordinal of the user prompt in the branch, whatever pi's turnIndex says", () => {
  const branch = [
    userEntry("u1", "write the notes of the meeting"),
    assistantEntry("a1", writeMessage("c1", NOTES, "one")),
    userEntry("u2", "now rewrite them as a list"),
    assistantEntry("a2", writeMessage("c2", NOTES, "two")),
    userEntry("u3", "and add the decisions"),
  ];

  // pi starts its turn counter again at every agent run: the same value for three different prompts.
  const first = turnObservationOf({ turnIndex: 0, message: writeMessage("c", NOTES, "x") }, branch.slice(0, 1), SOURCES);
  const second = turnObservationOf({ turnIndex: 0, message: writeMessage("c", NOTES, "x") }, branch.slice(0, 3), SOURCES);
  const third = turnObservationOf({ turnIndex: 0, message: writeMessage("c", NOTES, "x") }, branch, SOURCES);

  assert.deepEqual([first.turnIndex, second.turnIndex, third.turnIndex], [0, 1, 2]);
  assert.deepEqual([first.anchorEntryId, second.anchorEntryId, third.anchorEntryId], ["u1", "u2", "u3"]);
});

// The case B2 exists for: two prompts, and pi's counter at 0 in both runs. Keyed on the counter, the rewrite under the second
// prompt was read as the same turn and raised nothing.
test("a rewrite under a later prompt raises a rewritten-draft although pi's turn index restarted", async (t) => {
  const fixture = createFixture(t);
  const collector = await hydratedCollector(fixture);
  const firstBranch = [userEntry("u1", "write the notes of the meeting")];
  const secondBranch = [
    ...firstBranch,
    assistantEntry("a1", writeMessage("c1", NOTES, "one")),
    userEntry("u2", "rewrite them as a bullet list"),
  ];

  await collector.observe(turnObservationOf({ turnIndex: 0, message: writeMessage("c1", NOTES, "one") }, firstBranch, SOURCES));
  const raised = await collector.observe(
    turnObservationOf({ turnIndex: 0, message: writeMessage("c2", NOTES, "two") }, secondBranch, SOURCES),
  );

  assert.equal(raised.length, 1);
  assert.equal(raised[0].kind, "rewritten-draft");
  assert.equal(raised[0].turnIndex, 1);
  assert.equal(raised[0].id, expectedAnchoredId("rewritten-draft", "u2", NOTES));
});

// The other half: several turns under one prompt are the model refining its draft, and pi's counter says 0, 1, 2 inside one
// run. The anchor is the same entry for all of them.
test("a rewrite under the same prompt raises nothing, in every turn of the run", async (t) => {
  const fixture = createFixture(t);
  const collector = await hydratedCollector(fixture);
  const branch = [userEntry("u1", "write the notes of the meeting")];

  const raised = [
    ...(await collector.observe(turnObservationOf({ turnIndex: 0, message: writeMessage("c1", NOTES, "one") }, branch, SOURCES))),
    ...(await collector.observe(turnObservationOf({ turnIndex: 1, message: writeMessage("c2", NOTES, "two") }, branch, SOURCES))),
    ...(await collector.observe(turnObservationOf({ turnIndex: 2, message: writeMessage("c3", NOTES, "three") }, branch, SOURCES))),
  ];

  assert.deepEqual(raised, []);
});

// A steering message is a user message: the turn that follows it answers a new prompt, so a rewrite after it is flagged.
test("a steering message opens a new prompt: a rewrite after it is flagged", async (t) => {
  const fixture = createFixture(t);
  const collector = await hydratedCollector(fixture);
  const before = [userEntry("u1", "write the notes of the meeting")];
  const after = [...before, assistantEntry("a1", writeMessage("c1", NOTES, "one")), userEntry("u-steer", "no, use a table")];

  await collector.observe(turnObservationOf({ turnIndex: 0, message: writeMessage("c1", NOTES, "one") }, before, SOURCES));
  const raised = await collector.observe(
    turnObservationOf({ turnIndex: 1, message: writeMessage("c2", NOTES, "two") }, after, SOURCES),
  );

  assert.equal(raised.length, 1);
  assert.equal(raised[0].id, expectedAnchoredId("rewritten-draft", "u-steer", NOTES));
});

test("the id of a suspicion hashes the anchor entry: the same rewrite under another entry is another suspicion", async (t) => {
  const first = createFixture(t);
  const second = createFixture(t);
  const idUnder = async (fixture: Fixture, anchor: string): Promise<string> => {
    const collector = await hydratedCollector(fixture);
    const branch = [userEntry("u0", "start"), assistantEntry("a0", writeMessage("c0", NOTES, "one")), userEntry(anchor, "again please")];
    await collector.observe(turnObservationOf({ turnIndex: 0, message: writeMessage("c0", NOTES, "one") }, branch.slice(0, 1), SOURCES));
    const raised = await collector.observe(turnObservationOf({ turnIndex: 0, message: writeMessage("c1", NOTES, "two") }, branch, SOURCES));
    return raised[0].id;
  };

  assert.notEqual(await idUnder(first, "u-a"), await idUnder(second, "u-b"));
});

// B1: what is persisted is cut at the cap of an excerpt, the subject of a repeated request included, and the id is taken
// over the cut subject so the next session computes the same one.
test("the prompt and the subject of a suspicion are cut at MAX_EXCERPT_CODE_POINTS when they are persisted", async (t) => {
  const fixture = createFixture(t);
  const collector = await hydratedCollector(fixture);
  const words = Array.from({ length: 60 }, (_, index) => `distinctword${index}`);
  const prompt = `please ${words.join(" ")}`;
  const longer = `${prompt} and then something more`;

  await collector.observe(observation(0, { userPrompt: prompt }));
  const raised = await collector.observe(observation(1, { userPrompt: longer }));

  assert.equal(raised.length, 1);
  const [suspicion] = raised;
  assert.equal(suspicion.kind, "repeated-request");
  assert.equal([...suspicion.prompt].length, MAX_EXCERPT_CODE_POINTS);
  assert.equal([...suspicion.subject].length, MAX_EXCERPT_CODE_POINTS);
  assert.equal(suspicion.id, expectedId("repeated-request", 1, suspicion.subject));

  const line = JSON.parse(linesOf(signalsPath(fixture))[0]);
  assert.equal([...line.prompt].length, MAX_EXCERPT_CODE_POINTS);
  assert.equal([...line.subject].length, MAX_EXCERPT_CODE_POINTS);
});
