import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { prefilterEpisode } from "../../src/observe/prefilter.ts";
import type { Episode, PrefilterResult } from "../../src/observe/types.ts";
import {
  FAKE_SECRETS,
  FIXTURE_CWD,
  FIXTURE_NOW,
  cleanEpisode,
  explicitCorrection,
  rewrittenDraftLaterPrompt,
  rewrittenDraftSamePrompt,
  secretsEpisode,
  sessionJsonl,
  steeringMidTurn,
  toolErrorEpisode,
  twoAgentRuns,
  type SessionSpec,
  type Step,
} from "./observe-fixtures.ts";

interface Run {
  result: PrefilterResult;
  // Entry id of step `n`.
  ids: string[];
  entries: FileEntry[];
  episode: Episode;
}

// The episode spans steps `from`..`to` (default: the whole session).
function run(spec: SessionSpec, range: { from?: number; to?: number } = {}, cwd = FIXTURE_CWD): Run {
  const entries = parseSessionEntries(sessionJsonl(spec));
  const ids = entries.flatMap((entry) => (entry.type === "session" ? [] : [entry.id]));
  const episode: Episode = {
    id: "ep-test",
    skill: "demo-skill",
    sessionId: spec.id,
    sessionFile: "/sessions/test.jsonl",
    cwd: spec.cwd,
    startEntryId: ids[range.from ?? 0],
    endEntryId: ids[range.to ?? ids.length - 1],
    anchorEntryIds: [],
    startedAt: FIXTURE_NOW,
    attribution: "explicit",
    providers: [],
  };
  return { result: prefilterEpisode(episode, entries, cwd), ids, entries, episode };
}

function specOf(name: string, steps: Step[]): SessionSpec {
  return { id: `pf-${name}`, cwd: FIXTURE_CWD, startedAt: "2026-11-12T09:00:00.000Z", steps };
}

function kinds(result: PrefilterResult): string[] {
  return result.flags.map((flag) => flag.kind);
}

test("a clean episode raises nothing and does not need the judge", () => {
  const { result } = run(cleanEpisode());
  assert.deepEqual(result.flags, []);
  assert.equal(result.needsJudge, false);
  assert.equal(result.episodeId, "ep-test");
});

test("a user correction after the skill block is flagged on the user entry and needs the judge", () => {
  const { result, ids } = run(explicitCorrection());
  assert.deepEqual(result.flags, [{ kind: "correction", anchorEntryId: ids[2], detail: "no" }]);
  assert.equal(result.needsJudge, true);
});

test("a message sent while the agent was running (a steer) is a correction too", () => {
  const { result, ids } = run(steeringMidTurn());
  assert.deepEqual(result.flags, [{ kind: "correction", anchorEntryId: ids[3], detail: "instead" }]);
  assert.equal(result.needsJudge, true);
});

test("the lexicon reads Spanish", () => {
  const spec = specOf("es", [
    { kind: "user", text: "Resume el changelog" },
    { kind: "assistant", text: "Aquí está." },
    { kind: "user", text: "Hazlo en vez de eso con una lista" },
    { kind: "assistant", text: "Hecho." },
  ]);
  const { result, ids } = run(spec);
  assert.deepEqual(result.flags, [{ kind: "correction", anchorEntryId: ids[2], detail: "en vez de" }]);
});

test("only user-authored text counts: the skill body and the assistant's own words never flag", () => {
  const spec = specOf("authorship", [
    { kind: "skill", name: "demo-skill", location: "/work/skills/demo-skill/SKILL.md", body: "Never do the wrong thing. Do not stop. Revert nothing.", args: "go ahead" },
    { kind: "assistant", text: "No, that is wrong: I stop and undo everything instead." },
    { kind: "user", text: "Thanks, looks good" },
  ]);
  const { result } = run(spec);
  assert.deepEqual(result.flags, []);
  assert.equal(result.needsJudge, false);
});

test("the message that opens the episode is the request, not a correction of it", () => {
  const spec = specOf("opening", [
    { kind: "user", text: "No changes to the API please, summarise the changelog" },
    { kind: "assistant", text: "Here it is." },
  ]);
  assert.deepEqual(run(spec).result.flags, []);
});

test("a word that merely starts with 'no' is not a refusal", () => {
  const spec = specOf("no-prefix", [
    { kind: "user", text: "Summarise the changelog" },
    { kind: "assistant", text: "Done." },
    { kind: "user", text: "Notes look good. Now write the migration guide, nothing else" },
    { kind: "assistant", text: "Writing." },
  ]);
  assert.deepEqual(run(spec).result.flags, []);
});

test("a failed tool call is a mechanical flag on the tool result and does not need the judge on its own", () => {
  const { result, ids } = run(toolErrorEpisode());
  assert.deepEqual(result.flags, [{ kind: "tool-error", anchorEntryId: ids[3], detail: "bash" }]);
  assert.equal(result.needsJudge, false);
});

test("a rewrite of a file under the same prompt is the model refining its draft and is not flagged", () => {
  assert.deepEqual(run(rewrittenDraftSamePrompt()).result.flags, []);
});

test("writes of different files under different prompts are not a rewrite", () => {
  assert.deepEqual(run(twoAgentRuns()).result.flags, []);
});

test("a rewrite of a file with other arguments under a later prompt is flagged on that prompt", () => {
  const { result, ids } = run(rewrittenDraftLaterPrompt());
  const rewrite = result.flags.find((flag) => flag.kind === "rewritten-draft");
  assert.deepEqual(rewrite, { kind: "rewritten-draft", anchorEntryId: ids[4], detail: `${FIXTURE_CWD}/notes.md` });
});

test("a rewrite alone is mechanical and does not need the judge", () => {
  const spec = specOf("rewrite-alone", [
    { kind: "user", text: "Write the release notes" },
    { kind: "assistant", calls: [{ id: "c1", name: "write", arguments: { path: "notes.md", content: "v1" } }] },
    { kind: "tool-result", callId: "c1", tool: "write", text: "written" },
    { kind: "assistant", text: "Done." },
    { kind: "user", text: "Thanks, one more version of the file" },
    { kind: "assistant", calls: [{ id: "c2", name: "write", arguments: { path: "notes.md", content: "v2" } }] },
    { kind: "tool-result", callId: "c2", tool: "write", text: "written" },
    { kind: "assistant", text: "Done again." },
  ]);
  const { result } = run(spec);
  assert.deepEqual(kinds(result), ["rewritten-draft"]);
  assert.equal(result.needsJudge, false);
});

test("a prompt that repeats an earlier one is flagged on the repeating prompt and needs the judge", () => {
  const spec = specOf("repeat", [
    { kind: "user", text: "Please summarise the changelog thoroughly" },
    { kind: "assistant", text: "Here is a summary." },
    { kind: "user", text: "Please summarise the changelog thoroughly, with details" },
    { kind: "assistant", text: "Here is a longer summary." },
  ]);
  const { result, ids } = run(spec);
  assert.deepEqual(result.flags, [{ kind: "repeated-request", anchorEntryId: ids[2], detail: "repeated user prompt" }]);
  assert.equal(result.needsJudge, true);
});

test("the repeat is judged on what the user typed, not on the skill block that precedes it", () => {
  const body = "Summarise the changelog thoroughly. Summarise every release. Please include details.";
  const spec = specOf("repeat-block", [
    { kind: "skill", name: "demo-skill", location: "/work/skills/demo-skill/SKILL.md", body, args: "go" },
    { kind: "assistant", text: "Done." },
    { kind: "skill", name: "demo-skill", location: "/work/skills/demo-skill/SKILL.md", body, args: "go again" },
    { kind: "assistant", text: "Done again." },
  ]);
  assert.deepEqual(run(spec).result.flags, []);
});

test("entries outside the episode are ignored", () => {
  const spec = explicitCorrection();
  const inside = run(spec, { from: 0, to: 1 });
  assert.deepEqual(inside.result.flags, []);

  const after = run(spec, { from: 3, to: 3 });
  assert.deepEqual(after.result.flags, []);
});

test("an episode whose pointers are not in the file raises nothing", () => {
  const { entries, episode } = run(explicitCorrection());
  const missingStart = prefilterEpisode({ ...episode, startEntryId: "gone" }, entries, FIXTURE_CWD);
  const missingEnd = prefilterEpisode({ ...episode, endEntryId: "gone" }, entries, FIXTURE_CWD);
  assert.deepEqual([missingStart.flags, missingStart.needsJudge], [[], false]);
  assert.deepEqual([missingEnd.flags, missingEnd.needsJudge], [[], false]);
});

test("a flag never carries user text or a secret", () => {
  const { result } = run(secretsEpisode());
  assert.deepEqual(kinds(result), ["correction"]);
  const serialized = JSON.stringify(result);
  for (const secret of Object.values(FAKE_SECRETS)) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("other account"), false);
});
