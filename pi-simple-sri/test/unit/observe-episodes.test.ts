import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionEntries, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { segmentEpisodes, userAuthoredTurns } from "../../src/observe/episodes.ts";
import { EPISODE_USER_MESSAGE_CAP, observeId, type SessionRead } from "../../src/observe/types.ts";
import type { SkillRef } from "../../src/types.ts";
import {
  FIXTURE_CWD,
  FIXTURE_SKILLS_DIR,
  cleanEpisode,
  compactionEpisode,
  explicitCorrection,
  forkPair,
  implicitRead,
  implicitReadAndEdit,
  improvingSkillsEpisode,
  manySkillReads,
  providerMismatchEpisode,
  sessionEntriesOf,
  sessionJsonl,
  steeringMidTurn,
  type SessionSpec,
  type Step,
} from "./observe-fixtures.ts";

function skillRef(name: string, dir = `${FIXTURE_SKILLS_DIR}/${name}`, realDir = dir): SkillRef {
  return { name, description: `${name} skill`, dir, realDir, hasLessons: false, kind: "declared" };
}

const SKILLS = ["demo-skill", "other-skill", "third-skill", "improving-skills"].map((name) => skillRef(name));
const ANY = (): boolean => true;
const FILE = { path: "/sessions/--work-proj-a--/s.jsonl" };

function readOf(spec: SessionSpec): SessionRead {
  const [header, ...entries] = parseSessionEntries(sessionJsonl(spec));
  return { header: header as SessionHeader, entries, endOffset: 0 };
}

// Entry id of step `index` of the spec (the header is not a step).
function idOf(spec: SessionSpec, index: number): string {
  return String(sessionEntriesOf(spec)[index + 1]?.["id"]);
}

function readCall(id: string, file: string): Step {
  return { kind: "assistant", calls: [{ id, name: "read", arguments: { path: file } }] };
}

test("explicit: one episode from the skill-block message to the end, with pointers and no content", () => {
  const spec = explicitCorrection();

  const episodes = segmentEpisodes(readOf(spec), FILE, SKILLS, ANY);

  assert.equal(episodes.length, 1);
  const [episode] = episodes;
  assert.deepEqual(episode, {
    id: observeId("ep", ["demo-skill", idOf(spec, 0)]),
    skill: "demo-skill",
    sessionId: spec.id,
    sessionFile: FILE.path,
    cwd: FIXTURE_CWD,
    startEntryId: idOf(spec, 0),
    endEntryId: idOf(spec, 3),
    anchorEntryIds: [idOf(spec, 0), idOf(spec, 2)],
    startedAt: String(sessionEntriesOf(spec)[1]?.["timestamp"]),
    attribution: "explicit",
    providers: ["anthropic"],
  });
});

test("explicit: a clean episode is still an episode, and a plain session without any skill has none", () => {
  assert.equal(segmentEpisodes(readOf(cleanEpisode()), FILE, SKILLS, ANY).length, 1);

  const plain: SessionSpec = {
    ...cleanEpisode(),
    steps: [{ kind: "user", text: "hello" }, { kind: "assistant", text: "hi" }],
  };
  assert.deepEqual(segmentEpisodes(readOf(plain), FILE, SKILLS, ANY), []);
});

test("explicit: a block of a skill the inventory does not list still opens an episode when it is observable", () => {
  const spec = explicitCorrection({ skill: "unlisted-skill" });

  const episodes = segmentEpisodes(readOf(spec), FILE, SKILLS, ANY);

  assert.deepEqual(episodes.map((episode) => episode.skill), ["unlisted-skill"]);
});

test("explicit: improving-skills never opens an episode, even when the settings would allow it", () => {
  assert.deepEqual(segmentEpisodes(readOf(improvingSkillsEpisode()), FILE, SKILLS, ANY), []);
});

test("explicit and implicit: a skill the settings do not make observable opens no episode, and the predicate gets the name", () => {
  const asked: string[] = [];
  const deny = (name: string): boolean => {
    asked.push(name);
    return false;
  };

  assert.deepEqual(segmentEpisodes(readOf(explicitCorrection()), FILE, SKILLS, deny), []);
  assert.deepEqual(segmentEpisodes(readOf(implicitRead()), FILE, SKILLS, deny), []);
  assert.deepEqual(asked, ["demo-skill", "demo-skill"]);
});

test("implicit: a read of SKILL.md starts at the read and anchors on the user message before it", () => {
  const spec = implicitRead();

  const episodes = segmentEpisodes(readOf(spec), FILE, SKILLS, ANY);

  assert.equal(episodes.length, 1);
  const [episode] = episodes;
  assert.equal(episode?.attribution, "implicit");
  assert.equal(episode?.skill, "demo-skill");
  assert.equal(episode?.startEntryId, idOf(spec, 1));
  assert.equal(episode?.endEntryId, idOf(spec, 5));
  assert.deepEqual(episode?.anchorEntryIds, [idOf(spec, 0), idOf(spec, 4)]);
  assert.equal(episode?.id, observeId("ep", ["demo-skill", idOf(spec, 1)]));
});

test("implicit: the read is recognised through realDir of a symlinked skill and through a path relative to the header cwd", () => {
  const linked = skillRef("demo-skill", "/link/demo-skill", `${FIXTURE_SKILLS_DIR}/demo-skill`);
  assert.equal(segmentEpisodes(readOf(implicitRead()), FILE, [linked], ANY).length, 1);

  const relative: SessionSpec = {
    ...implicitRead(),
    steps: [
      { kind: "user", text: "Summarise the changelog" },
      readCall("call-1", "../skills/demo-skill/SKILL.md"),
      { kind: "assistant", text: "Done." },
    ],
  };
  assert.equal(segmentEpisodes(readOf(relative), FILE, SKILLS, ANY).length, 1);
});

test("implicit: a read of a SKILL.md that is not in the inventory, or of another file, starts nothing", () => {
  assert.deepEqual(segmentEpisodes(readOf(implicitRead()), FILE, [skillRef("other-skill")], ANY), []);

  const other: SessionSpec = {
    ...implicitRead(),
    steps: [
      { kind: "user", text: "look at the readme" },
      readCall("call-1", `${FIXTURE_SKILLS_DIR}/demo-skill/README.md`),
    ],
  };
  assert.deepEqual(segmentEpisodes(readOf(other), FILE, SKILLS, ANY), []);
});

test("implicit: improving-skills is never observed", () => {
  const spec: SessionSpec = {
    ...implicitRead(),
    steps: [{ kind: "user", text: "how do I improve skills" }, readCall("call-1", `${FIXTURE_SKILLS_DIR}/improving-skills/SKILL.md`)],
  };

  assert.deepEqual(segmentEpisodes(readOf(spec), FILE, SKILLS, ANY), []);
});

test("implicit: an episode that edits the SKILL.md it read is excluded, but an edit of another file is not", () => {
  assert.deepEqual(segmentEpisodes(readOf(implicitReadAndEdit()), FILE, SKILLS, ANY), []);

  const spec: SessionSpec = {
    ...implicitRead(),
    steps: [
      { kind: "user", text: "Summarise the changelog" },
      readCall("call-1", `${FIXTURE_SKILLS_DIR}/demo-skill/SKILL.md`),
      { kind: "assistant", calls: [{ id: "call-2", name: "write", arguments: { path: `${FIXTURE_CWD}/out.md`, content: "x" } }] },
    ],
  };
  assert.equal(segmentEpisodes(readOf(spec), FILE, SKILLS, ANY).length, 1);
});

test("implicit: more than two SKILL.md reads in one turn is a survey and starts nothing", () => {
  assert.deepEqual(segmentEpisodes(readOf(manySkillReads()), FILE, SKILLS, ANY), []);
});

test("implicit: two SKILL.md reads in one turn are still a use, attributed to the first skill", () => {
  const spec: SessionSpec = {
    ...implicitRead(),
    steps: [
      { kind: "user", text: "Summarise the changelog" },
      {
        kind: "assistant",
        calls: [
          { id: "r1", name: "read", arguments: { path: `${FIXTURE_SKILLS_DIR}/other-skill/SKILL.md` } },
          { id: "r2", name: "read", arguments: { path: `${FIXTURE_SKILLS_DIR}/demo-skill/SKILL.md` } },
        ],
      },
    ],
  };

  assert.deepEqual(segmentEpisodes(readOf(spec), FILE, SKILLS, ANY).map((episode) => episode.skill), ["other-skill"]);
});

test("an episode ends at the next episode start: a second explicit invocation, or the implicit read of another skill", () => {
  const twice: SessionSpec = {
    ...explicitCorrection(),
    steps: [
      { kind: "skill", name: "demo-skill", location: `${FIXTURE_SKILLS_DIR}/demo-skill/SKILL.md`, args: "first" },
      { kind: "assistant", text: "one" },
      { kind: "skill", name: "demo-skill", location: `${FIXTURE_SKILLS_DIR}/demo-skill/SKILL.md`, args: "second" },
      { kind: "assistant", text: "two" },
    ],
  };
  const episodes = segmentEpisodes(readOf(twice), FILE, SKILLS, ANY);
  assert.deepEqual(episodes.map((episode) => [episode.startEntryId, episode.endEntryId]), [
    [idOf(twice, 0), idOf(twice, 1)],
    [idOf(twice, 2), idOf(twice, 3)],
  ]);
  assert.notEqual(episodes[0]?.id, episodes[1]?.id);

  const switching: SessionSpec = {
    ...explicitCorrection(),
    steps: [
      { kind: "skill", name: "demo-skill", location: `${FIXTURE_SKILLS_DIR}/demo-skill/SKILL.md`, args: "first" },
      { kind: "assistant", text: "one" },
      readCall("call-1", `${FIXTURE_SKILLS_DIR}/other-skill/SKILL.md`),
      { kind: "assistant", text: "two" },
    ],
  };
  const switched = segmentEpisodes(readOf(switching), FILE, SKILLS, ANY);
  assert.deepEqual(switched.map((episode) => [episode.skill, episode.attribution, episode.endEntryId]), [
    ["demo-skill", "explicit", idOf(switching, 1)],
    ["other-skill", "implicit", idOf(switching, 3)],
  ]);
});

test("a read of the SKILL.md of the skill whose episode is open does not start a new episode", () => {
  const spec: SessionSpec = {
    ...explicitCorrection(),
    steps: [
      { kind: "skill", name: "demo-skill", location: `${FIXTURE_SKILLS_DIR}/demo-skill/SKILL.md`, args: "go" },
      readCall("call-1", `${FIXTURE_SKILLS_DIR}/demo-skill/SKILL.md`),
      { kind: "assistant", text: "done" },
    ],
  };

  const episodes = segmentEpisodes(readOf(spec), FILE, SKILLS, ANY);

  assert.deepEqual(episodes.map((episode) => episode.attribution), ["explicit"]);
  assert.equal(episodes[0]?.endEntryId, idOf(spec, 2));
});

test("cap: an episode spans at most EPISODE_USER_MESSAGE_CAP user messages and ends before the next one", () => {
  const extra: Step[] = [];
  for (let index = 0; index < EPISODE_USER_MESSAGE_CAP + 2; index += 1) {
    extra.push({ kind: "user", text: `more ${index}` }, { kind: "assistant", text: `answer ${index}` });
  }
  const spec: SessionSpec = {
    ...explicitCorrection(),
    steps: [{ kind: "skill", name: "demo-skill", location: `${FIXTURE_SKILLS_DIR}/demo-skill/SKILL.md`, args: "go" }, ...extra],
  };

  const [episode] = segmentEpisodes(readOf(spec), FILE, SKILLS, ANY);

  assert.equal(episode?.anchorEntryIds.length, EPISODE_USER_MESSAGE_CAP);
  // Step 0 is the block (anchor 1), then pairs (user, assistant): the last anchor is the user message of step
  // 2 * cap - 3, and the episode ends at its answer, before the next user message.
  assert.equal(episode?.anchorEntryIds.at(-1), idOf(spec, 2 * EPISODE_USER_MESSAGE_CAP - 3));
  assert.equal(episode?.endEntryId, idOf(spec, 2 * EPISODE_USER_MESSAGE_CAP - 2));
});

test("cap: a skill read after the capped episode starts a new implicit one anchored on the latest user message", () => {
  const extra: Step[] = [];
  for (let index = 0; index < EPISODE_USER_MESSAGE_CAP; index += 1) extra.push({ kind: "user", text: `more ${index}` });
  const spec: SessionSpec = {
    ...explicitCorrection(),
    steps: [
      { kind: "skill", name: "demo-skill", location: `${FIXTURE_SKILLS_DIR}/demo-skill/SKILL.md`, args: "go" },
      ...extra,
      readCall("call-1", `${FIXTURE_SKILLS_DIR}/demo-skill/SKILL.md`),
    ],
  };

  const episodes = segmentEpisodes(readOf(spec), FILE, SKILLS, ANY);

  assert.deepEqual(episodes.map((episode) => episode.attribution), ["explicit", "implicit"]);
  assert.equal(episodes[1]?.anchorEntryIds[0], idOf(spec, EPISODE_USER_MESSAGE_CAP));
});

test("steering: a user message sent while the agent was working is an anchor of the episode", () => {
  const spec = steeringMidTurn();

  const [episode] = segmentEpisodes(readOf(spec), FILE, SKILLS, ANY);

  assert.deepEqual(episode?.anchorEntryIds, [idOf(spec, 0), idOf(spec, 3)]);
});

test("providers: every provider of the assistant messages of the episode, once, in order of appearance", () => {
  assert.deepEqual(segmentEpisodes(readOf(providerMismatchEpisode()), FILE, SKILLS, ANY)[0]?.providers, ["openai"]);

  const spec: SessionSpec = {
    ...explicitCorrection(),
    steps: [
      { kind: "skill", name: "demo-skill", location: `${FIXTURE_SKILLS_DIR}/demo-skill/SKILL.md`, args: "go" },
      { kind: "assistant", text: "a", provider: "anthropic" },
      { kind: "user", text: "again" },
      { kind: "assistant", text: "b", provider: "openai" },
      { kind: "user", text: "again" },
      { kind: "assistant", text: "c", provider: "anthropic" },
    ],
  };
  assert.deepEqual(segmentEpisodes(readOf(spec), FILE, SKILLS, ANY)[0]?.providers, ["anthropic", "openai"]);
});

test("compaction: a compaction entry inside the episode does not split it", () => {
  const spec = compactionEpisode();

  const episodes = segmentEpisodes(readOf(spec), FILE, SKILLS, ANY);

  assert.equal(episodes.length, 1);
  assert.equal(episodes[0]?.endEntryId, idOf(spec, spec.steps.length - 1));
});

test("fork: parent and child segment to the same episode id for the shared prefix, so the fold dedupes them", () => {
  const { parent, child } = forkPair();

  const [fromParent] = segmentEpisodes(readOf(parent), FILE, SKILLS, ANY);
  const [fromChild] = segmentEpisodes(readOf(child), { path: "/sessions/child.jsonl" }, SKILLS, ANY);

  assert.ok(fromParent !== undefined && fromChild !== undefined);
  assert.equal(fromParent.id, fromChild.id);
  assert.equal(fromParent.startEntryId, fromChild.startEntryId);
  assert.notEqual(fromParent.sessionId, fromChild.sessionId);
});

test("userAuthoredTurns: user text only, skill block stripped, steering included, assistant and tool output left out", () => {
  const explicit = explicitCorrection();
  const [, ...explicitEntries] = parseSessionEntries(sessionJsonl(explicit));
  assert.deepEqual(userAuthoredTurns(explicitEntries), [
    { anchorEntryId: idOf(explicit, 0), text: "summarise the changelog" },
    { anchorEntryId: idOf(explicit, 2), text: "No, that is wrong: list only the breaking changes." },
  ]);

  const steering = steeringMidTurn();
  const [, ...steeringEntries] = parseSessionEntries(sessionJsonl(steering));
  assert.deepEqual(userAuthoredTurns(steeringEntries).map((turn) => turn.anchorEntryId), [idOf(steering, 0), idOf(steering, 3)]);
});

test("userAuthoredTurns: a block without args holds nothing the user wrote, and the header is never a turn", () => {
  const spec: SessionSpec = {
    ...explicitCorrection(),
    steps: [{ kind: "skill", name: "demo-skill", location: `${FIXTURE_SKILLS_DIR}/demo-skill/SKILL.md` }, { kind: "assistant", text: "ok" }],
  };

  assert.deepEqual(userAuthoredTurns(parseSessionEntries(sessionJsonl(spec))), []);
});
