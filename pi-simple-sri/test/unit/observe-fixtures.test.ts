import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseSessionEntries, parseSkillBlock } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  FIXTURE_CWD,
  FIXTURE_SKILLS_DIR,
  HANG,
  TIMEOUT,
  beforeOptInEpisode,
  cleanEpisode,
  compactionEpisode,
  explicitCorrection,
  fakeRegistry,
  fakeUi,
  forkPair,
  groupedDirNameOf,
  implicitRead,
  makeAgentDir,
  manySkillReads,
  providerMismatchEpisode,
  sessionEntriesOf,
  sessionFileNameOf,
  sessionJsonl,
  skillBlockText,
  steeringMidTurn,
  toolErrorEpisode,
  twoAgentRuns,
  writeSessionsTree,
  type SessionSpec,
} from "./observe-fixtures.ts";

type Entry = Record<string, unknown>;

function parsed(text: string): Entry[] {
  return parseSessionEntries(text) as unknown as Entry[];
}

function messageOf(entry: Entry): Entry {
  return entry["message"] as Entry;
}

const SCENARIOS: [string, SessionSpec][] = [
  ["explicitCorrection", explicitCorrection()],
  ["cleanEpisode", cleanEpisode()],
  ["implicitRead", implicitRead()],
  ["manySkillReads", manySkillReads()],
  ["steeringMidTurn", steeringMidTurn()],
  ["twoAgentRuns", twoAgentRuns()],
  ["toolErrorEpisode", toolErrorEpisode()],
  ["providerMismatchEpisode", providerMismatchEpisode()],
  ["compactionEpisode", compactionEpisode()],
  ["beforeOptInEpisode", beforeOptInEpisode()],
];

for (const [name, spec] of SCENARIOS) {
  test(`parseSessionEntries reads the ${name} session: header first, one entry per step, chained parents`, () => {
    const entries = parsed(sessionJsonl(spec));
    assert.equal(entries.length, spec.steps.length + 1);
    assert.deepEqual(entries[0], {
      type: "session",
      version: 3,
      id: spec.id,
      timestamp: spec.startedAt,
      cwd: spec.cwd,
    });
    assert.equal(entries[1]?.["parentId"], null);
    for (let index = 2; index < entries.length; index += 1) {
      assert.equal(entries[index]?.["parentId"], entries[index - 1]?.["id"], `entry ${index}`);
    }
    assert.equal(new Set(entries.slice(1).map((entry) => entry["id"])).size, spec.steps.length);
  });
}

test("parseSessionEntries reads a session with a parentSession and a version override in the header", () => {
  const spec: SessionSpec = { ...explicitCorrection(), version: 2, parentSession: "/sessions/p.jsonl" };
  const header = parsed(sessionJsonl(spec))[0];
  assert.equal(header?.["version"], 2);
  assert.equal(header?.["parentSession"], "/sessions/p.jsonl");
});

test("sessionJsonl output ends with a newline and has one JSON object per line", () => {
  const text = sessionJsonl(explicitCorrection());
  assert.ok(text.endsWith("\n"));
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, explicitCorrection().steps.length + 1);
  for (const line of lines) JSON.parse(line);
});

test("the tool-error scenario carries a failed toolResult and the compaction one keeps from the named step", () => {
  const toolEntries = parsed(sessionJsonl(toolErrorEpisode()));
  const failed = toolEntries
    .filter((entry) => entry["type"] === "message")
    .map(messageOf)
    .filter((message) => message["role"] === "toolResult");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.["isError"], true);

  const spec = compactionEpisode();
  const entries = parsed(sessionJsonl(spec));
  const compaction = entries.find((entry) => entry["type"] === "compaction");
  assert.equal(compaction?.["firstKeptEntryId"], entries[2]?.["id"]);
});

test("the provider-mismatch scenario puts the other provider on every assistant message", () => {
  const assistants = parsed(sessionJsonl(providerMismatchEpisode()))
    .filter((entry) => entry["type"] === "message")
    .map(messageOf)
    .filter((message) => message["role"] === "assistant");
  assert.ok(assistants.length > 0);
  for (const message of assistants) assert.equal(message["provider"], "openai");
});

test("parseSkillBlock recognises the explicit skill block of the fixture session", () => {
  const entries = parsed(sessionJsonl(explicitCorrection()));
  const content = messageOf(entries[1] as Entry)["content"] as { type: string; text: string }[];
  const block = parseSkillBlock(content[0]?.text ?? "");
  assert.ok(block !== null);
  assert.equal(block.name, "demo-skill");
  assert.equal(block.location, `${FIXTURE_SKILLS_DIR}/demo-skill/SKILL.md`);
  assert.equal(block.userMessage, "summarise the changelog");
  assert.match(block.content, /^References are relative to /);
  assert.match(block.content, /# demo-skill/);
});

test("parseSkillBlock answers an undefined userMessage when the block has no args, and null for plain user text", () => {
  const noArgs = parseSkillBlock(skillBlockText("s", "/x/s/SKILL.md", "body"));
  assert.ok(noArgs !== null);
  assert.equal(noArgs.userMessage, undefined);

  const implicit = parsed(sessionJsonl(implicitRead()));
  const text = ((messageOf(implicit[1] as Entry)["content"] as { text: string }[])[0] as { text: string }).text;
  assert.equal(parseSkillBlock(text), null);
});

test("forkPair: parent and child share the ids of the first three steps and diverge in content after them", () => {
  const { parent, child } = forkPair();
  const parentEntries = sessionEntriesOf(parent);
  const childEntries = sessionEntriesOf(child);
  assert.equal(child.steps.length, 4);
  for (let index = 1; index <= 3; index += 1) {
    assert.equal(childEntries[index]?.["id"], parentEntries[index]?.["id"], `shared entry ${index}`);
    assert.equal(childEntries[index]?.["parentId"], parentEntries[index]?.["parentId"], `shared parent ${index}`);
  }
  assert.notDeepEqual(childEntries[4], parentEntries[4]);
  assert.notEqual(childEntries[4]?.["id"], parentEntries[4]?.["id"]);
  assert.equal(childEntries[4]?.["parentId"], childEntries[3]?.["id"]);
  assert.equal(childEntries[4]?.["parentId"], parentEntries[3]?.["id"]);
  assert.notEqual(childEntries[0]?.["id"], parentEntries[0]?.["id"]);
  assert.equal(childEntries[0]?.["parentSession"], `/sessions/${parent.id}.jsonl`);
});

test("forkPair ids survive the parse of both files", () => {
  const { parent, child } = forkPair();
  const parentIds = parsed(sessionJsonl(parent)).slice(1, 4).map((entry) => entry["id"]);
  const childIds = parsed(sessionJsonl(child)).slice(1, 4).map((entry) => entry["id"]);
  assert.deepEqual(childIds, parentIds);
});

test("forkPair parsed: diverging entries have new ids, and dedupe by entryId over the union keeps them distinct", () => {
  const { parent, child } = forkPair();
  const parentEntries = parsed(sessionJsonl(parent)).slice(1);
  const childEntries = parsed(sessionJsonl(child)).slice(1);
  assert.equal(parentEntries.length, 4);
  assert.equal(childEntries.length, 4);
  assert.deepEqual(childEntries.slice(0, 3), parentEntries.slice(0, 3));
  assert.notEqual(childEntries[3]?.["id"], parentEntries[3]?.["id"]);
  assert.equal(childEntries[3]?.["parentId"], parentEntries[2]?.["id"]);

  const byId = new Map<unknown, Entry>();
  for (const entry of [...parentEntries, ...childEntries]) if (!byId.has(entry["id"])) byId.set(entry["id"], entry);
  assert.equal(byId.size, 5);
  assert.deepEqual(byId.get(parentEntries[3]?.["id"]), parentEntries[3]);
  assert.deepEqual(byId.get(childEntries[3]?.["id"]), childEntries[3]);
});

test("forkPair divergeSeed picks the id of the diverging step", () => {
  const a = sessionEntriesOf(forkPair({ divergeSeed: "seed-a" }).child)[4]?.["id"];
  const b = sessionEntriesOf(forkPair({ divergeSeed: "seed-b" }).child)[4]?.["id"];
  assert.notEqual(a, b);
});

test("sessions with different seeds and the same shape do not share entry ids", () => {
  const a = sessionEntriesOf(explicitCorrection({ id: "fx-a" }));
  const b = sessionEntriesOf(explicitCorrection({ id: "fx-b" }));
  assert.notEqual(a[1]?.["id"], b[1]?.["id"]);
});

test("sessionJsonl truncateTail drops the last line: parseSessionEntries skips the half line", () => {
  const spec = explicitCorrection();
  const full = parsed(sessionJsonl(spec));
  const cut = sessionJsonl(spec, { truncateTail: true });
  assert.ok(!cut.endsWith("\n"));
  assert.throws(() => JSON.parse(cut.slice(cut.lastIndexOf("\n") + 1)));
  const entries = parsed(cut);
  assert.equal(entries.length, full.length - 1);
  assert.deepEqual(entries, full.slice(0, -1));
});

test("writeSessionsTree grouped: one project directory per cwd, file named by timestamp and id", (t) => {
  const { sessionsDir } = makeAgentDir(t);
  const a = explicitCorrection({ id: "s-a" });
  const b = cleanEpisode({ id: "s-b", cwd: "/work/proj-b" });
  const [fileA, fileB] = writeSessionsTree(sessionsDir, "grouped", [{ spec: a }, { spec: b }]);
  assert.equal(groupedDirNameOf(FIXTURE_CWD), "--work-proj-a--");
  assert.equal(fileA, path.join(sessionsDir, "--work-proj-a--", sessionFileNameOf(a)));
  assert.equal(fileB, path.join(sessionsDir, "--work-proj-b--", sessionFileNameOf(b)));
  assert.equal(fs.readFileSync(fileA as string, "utf8"), sessionJsonl(a));
  assert.match(path.basename(fileA as string), /^2026-11-12T09-00-00-000Z_s-a\.jsonl$/);
});

test("writeSessionsTree flat: every session sits directly under the root", (t) => {
  const { sessionsDir } = makeAgentDir(t);
  const a = explicitCorrection({ id: "s-a" });
  const b = cleanEpisode({ id: "s-b", cwd: "/work/proj-b" });
  const files = writeSessionsTree(sessionsDir, "flat", [{ spec: a }, { spec: b }]);
  for (const file of files) assert.equal(path.dirname(file), sessionsDir);
  assert.deepEqual(fs.readdirSync(sessionsDir).sort(), [sessionFileNameOf(a), sessionFileNameOf(b)].sort());
});

test("writeSessionsTree nested: run-0/session.jsonl under the project dir (grouped) or the root (flat)", (t) => {
  const { sessionsDir } = makeAgentDir(t);
  const spec = explicitCorrection({ id: "s-nested" });
  const [grouped] = writeSessionsTree(path.join(sessionsDir, "g"), "grouped", [{ spec, nested: true }]);
  const [flat] = writeSessionsTree(path.join(sessionsDir, "f"), "flat", [{ spec, nested: true }]);
  assert.equal(grouped, path.join(sessionsDir, "g", "--work-proj-a--", "run-0", "session.jsonl"));
  assert.equal(flat, path.join(sessionsDir, "f", "run-0", "session.jsonl"));
  assert.equal(fs.readFileSync(flat as string, "utf8"), sessionJsonl(spec));
});

test("writeSessionsTree mtimes: default is one hour after the session start, an explicit mtime wins", (t) => {
  const { sessionsDir } = makeAgentDir(t);
  const spec = explicitCorrection({ id: "s-default" });
  const pinned = new Date("2026-11-16T11:55:00.000Z");
  const [byDefault, explicit] = writeSessionsTree(sessionsDir, "flat", [
    { spec },
    { spec: cleanEpisode({ id: "s-pinned" }), mtime: pinned },
  ]);
  const defaultMs = fs.statSync(byDefault as string).mtimeMs;
  const explicitMs = fs.statSync(explicit as string).mtimeMs;
  assert.ok(Math.abs(defaultMs - (Date.parse(spec.startedAt) + 3_600_000)) < 1000);
  assert.ok(Math.abs(explicitMs - pinned.getTime()) < 1000);
});

test("writeSessionsTree writes a truncated tail when the entry asks for it", (t) => {
  const { sessionsDir } = makeAgentDir(t);
  const spec = explicitCorrection({ id: "s-trunc" });
  const [file] = writeSessionsTree(sessionsDir, "flat", [{ spec, options: { truncateTail: true } }]);
  assert.equal(fs.readFileSync(file as string, "utf8"), sessionJsonl(spec, { truncateTail: true }));
});

test("fakeUi answers scripted select and confirm in order and records what was shown", async () => {
  const handle = fakeUi([
    { kind: "select", answer: "Accept" },
    { kind: "confirm", answer: true },
  ]);
  assert.equal(await handle.ui.select("T", ["Accept", "Later"]), "Accept");
  assert.equal(await handle.ui.confirm("C", "sure?"), true);
  assert.deepEqual(
    handle.shown.map((dialog) => [dialog.kind, dialog.title]),
    [["select", "T"], ["confirm", "C"]],
  );
  assert.deepEqual(handle.shown[0]?.options, ["Accept", "Later"]);
  assert.equal(handle.remaining(), 0);
});

test("fakeUi TIMEOUT dismisses the dialog at once: undefined for select, false for confirm", async () => {
  const handle = fakeUi([
    { kind: "select", answer: TIMEOUT },
    { kind: "confirm", answer: TIMEOUT },
  ]);
  assert.equal(await handle.ui.select("T", ["a"], { timeout: 1000 }), undefined);
  assert.equal(await handle.ui.confirm("C", "m", { timeout: 1000 }), false);
});

test("fakeUi HANG stays open until the signal aborts, then dismisses (undefined / false)", async () => {
  const handle = fakeUi([
    { kind: "select", answer: HANG },
    { kind: "confirm", answer: HANG },
  ]);
  const selectController = new AbortController();
  const confirmController = new AbortController();
  let selectSettled = false;
  let confirmSettled = false;
  const selecting = handle.ui.select("T", ["a"], { signal: selectController.signal }).then((answer) => {
    selectSettled = true;
    return answer;
  });
  const confirming = handle.ui.confirm("C", "m", { signal: confirmController.signal }).then((answer) => {
    confirmSettled = true;
    return answer;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(selectSettled, false);
  assert.equal(confirmSettled, false);
  selectController.abort();
  confirmController.abort();
  assert.equal(await selecting, undefined);
  assert.equal(await confirming, false);
});

test("fakeUi HANG with an already aborted signal dismisses at once", async () => {
  const handle = fakeUi([{ kind: "select", answer: HANG }]);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await handle.ui.select("T", ["a"], { signal: controller.signal }), undefined);
});

test("fakeUi: an unscripted dialog rejects, and so does one of the wrong kind", async () => {
  const empty = fakeUi([]);
  await assert.rejects(empty.ui.select("T", ["a"]), /unscripted select dialog "T"/);
  await assert.rejects(empty.ui.confirm("C", "m"), /unscripted confirm dialog "C"/);

  const wrong = fakeUi([{ kind: "confirm", answer: true }]);
  await assert.rejects(wrong.ui.select("T", ["a"]), /scripted confirm but select "T" was asked/);
});

test("fakeUi remaining counts the scripted steps the code never asked for; notify records notices", () => {
  const handle = fakeUi([{ kind: "select", answer: "x" }]);
  assert.equal(handle.remaining(), 1);
  handle.ui.notify("hello");
  handle.ui.notify("careful", "warning");
  assert.deepEqual(handle.notices, [
    { message: "hello", type: "info" },
    { message: "careful", type: "warning" },
  ]);
});

const MODEL = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-4-5" } as unknown as Model<never>;

test("fakeRegistry answers scripted text in order, throws a scripted Error, and records calls", async () => {
  const handle = fakeRegistry(["first", new Error("boom"), "third"]);
  const first = (await handle.registry.complete(MODEL as never, { messages: [] } as never, undefined as never)) as AssistantMessage;
  assert.deepEqual(first.content, [{ type: "text", text: "first" }]);
  assert.equal(first.provider, "anthropic");
  assert.equal(first.model, "claude-sonnet-4-5");
  await assert.rejects(handle.registry.complete(MODEL as never, {} as never, undefined as never), /boom/);
  assert.equal(handle.remaining(), 1);
  assert.equal(handle.calls.length, 2);
});

test("fakeRegistry: a call nobody scripted throws", async () => {
  const handle = fakeRegistry(["only"]);
  await handle.registry.complete(MODEL as never, {} as never, undefined as never);
  await assert.rejects(handle.registry.complete(MODEL as never, {} as never, undefined as never), /fakeRegistry: unscripted model call/);
  assert.equal(handle.calls.length, 2);
});
