import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModelCall } from "../../src/model-call.ts";
import { scanSkillEffects, runSetup, writeReplayAllow } from "../../src/observe/setup.ts";
import type { SetupContext, SetupDeps, SetupReport } from "../../src/observe/setup.ts";
import type { SkillRef } from "../../src/types.ts";
import { fakeRegistry, fakeUi, installFixtureSkill, makeAgentDir, readFixture, skillFixture } from "./observe-fixtures.ts";
import type { AgentDirFixture, FakeUi, UiStep } from "./observe-fixtures.ts";

const MODEL = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-4-5" } as unknown as Model<Api>;

function skillMd(body: string): { path: string; text: string }[] {
  return [{ path: "SKILL.md", text: `---\nname: x\ndescription: d\n---\n\n${body}\n` }];
}

// ---------------------------------------------------------------------------------------------------------------
// scanSkillEffects
// ---------------------------------------------------------------------------------------------------------------

const EFFECT_CASES: readonly (readonly [indicator: string, text: string])[] = [
  ["write-tool", "Save the report with the `write` tool."],
  ["edit-tool", "Fix the typo with the edit tool, then read it again."],
  ["git-push", "Run `git push origin HEAD`."],
  ["git-commit", "Run `git commit -m fix`."],
  ["gh-write", "Run `gh pr comment 12 --body hi`."],
  ["gh-write", "Run `gh issue create --title t`."],
  ["http-write", "Run `curl -s -X POST https://example.test/hook`."],
  ["http-write", "Run `curl --request DELETE https://example.test/x`."],
  ["rm", "Clean up with `rm -rf build`."],
  ["npm-publish", "Then `npm publish`."],
  ["kubectl-apply", "Deploy with `kubectl apply -f deploy.yaml`."],
  ["ssh", "Log in with `ssh deploy@host`."],
  ["mcp-write", "Call mcp__github__create_issue to file it."],
  ["mv-cp", "Move it with `mv build/out.txt dist/`."],
  ["mv-cp", "Back it up with `cp -r src backup`."],
  ["docker", "Start the service with `docker run -p 80:80 web`."],
  ["aws-write", "Upload with `aws s3 cp report.txt s3://bucket/`."],
  ["aws-write", "Run `aws dynamodb put-item --table-name t`."],
  ["aws-write", "Run `aws lambda update-function-code --function-name f`."],
  ["aws-write", "Run `aws ec2 terminate-instances --instance-ids i-1`."],
  ["terraform-apply", "Roll it out with `terraform apply -auto-approve`."],
  ["posts-message", "Post a comment with the findings."],
  ["posts-message", "Then send the message to the channel."],
  ["posts-message", "Reply to the thread when you are done."],
  ["chat-mail-send", "Send a message on Teams."],
  ["chat-mail-send", "Send the summary through Outlook."],
];

for (const [indicator, text] of EFFECT_CASES) {
  test(`scanSkillEffects: ${JSON.stringify(text)} is has-effects with ${indicator}`, () => {
    const result = scanSkillEffects(skillMd(text));
    assert.equal(result.class, "has-effects");
    assert.ok(result.indicators.includes(indicator), `indicators: ${result.indicators.join(",")}`);
  });
}

const READ_ONLY_TEXTS: readonly string[] = [
  "Read the files with the `read` tool.",
  "This skill is read-only.",
  "Inspect the change with `git diff HEAD~1`.",
  "List them with `gh pr list`.",
  "Look at the file with `cat notes.md`.",
  "Search with `grep -rn TODO src`.",
  "Search with `rg TODO`.",
  "Run:\n\n$ cat notes.md",
];

for (const text of READ_ONLY_TEXTS) {
  test(`scanSkillEffects: ${JSON.stringify(text)} is a read signal`, () => {
    assert.deepEqual(scanSkillEffects(skillMd(text)), { class: "read-only", indicators: [] });
  });
}

const NOT_A_READ_SIGNAL: readonly string[] = [
  "The cat sat on the mat.",
  "Read the diff with `cat`.",
  "You may grep the logs and then tidy things up.",
  "Use rg or cat as you like.",
  "Concatenate with cat and report.",
];

for (const text of NOT_A_READ_SIGNAL) {
  test(`scanSkillEffects: ${JSON.stringify(text)} is not enough to call a skill read-only`, () => {
    assert.deepEqual(scanSkillEffects(skillMd(text)), { class: "unknown", indicators: [] });
  });
}

test("scanSkillEffects: a script in the skill is an indicator, whatever it holds", () => {
  const result = scanSkillEffects([...skillMd("Read the diff with `cat` and report."), { path: "scripts/run.sh", text: "echo hi\n" }]);
  assert.equal(result.class, "has-effects");
  assert.deepEqual(result.indicators, ["script:scripts/run.sh"]);
});

test("scanSkillEffects: the indicators of every file are scanned, not only SKILL.md", () => {
  const result = scanSkillEffects([...skillMd("Read the diff with `cat`."), { path: "references/post.md", text: "Run `git push`." }]);
  assert.equal(result.class, "has-effects");
  assert.deepEqual(result.indicators, ["git-push"]);
});

test("scanSkillEffects: indicators are unique and sorted", () => {
  const result = scanSkillEffects(skillMd("`git push`, then `git push --force`, then `git commit`."));
  assert.deepEqual(result.indicators, ["git-commit", "git-push"]);
});

test("scanSkillEffects: prose that forbids changes is not an indicator (read-only fixture)", () => {
  const result = scanSkillEffects([{ path: "SKILL.md", text: readFixture("skills", "read-only", "SKILL.md") }]);
  assert.deepEqual(result, { class: "read-only", indicators: [] });
});

test("scanSkillEffects: has-effects fixture", () => {
  const result = scanSkillEffects([{ path: "SKILL.md", text: readFixture("skills", "has-effects", "SKILL.md") }]);
  assert.equal(result.class, "has-effects");
  assert.deepEqual(result.indicators, ["gh-write", "git-push"]);
});

test("scanSkillEffects: no indicator and no evidence of reading is unknown, never read-only (unknown fixture)", () => {
  const result = scanSkillEffects([{ path: "SKILL.md", text: readFixture("skills", "unknown", "SKILL.md") }]);
  assert.deepEqual(result, { class: "unknown", indicators: [] });
});

test("scanSkillEffects: no files is unknown", () => {
  assert.deepEqual(scanSkillEffects([]), { class: "unknown", indicators: [] });
});

// ---------------------------------------------------------------------------------------------------------------
// writeReplayAllow
// ---------------------------------------------------------------------------------------------------------------

function settingsPathOf(fx: AgentDirFixture): string {
  return path.join(fx.agentDir, "settings.json");
}

function readSettings(fx: AgentDirFixture): unknown {
  return JSON.parse(fs.readFileSync(settingsPathOf(fx), "utf8"));
}

test("writeReplayAllow creates settings.json when there is none, with only the allow key", async (t) => {
  const fx = makeAgentDir(t);
  const result = await writeReplayAllow(fx.agentDir, ["a"], null);
  assert.deepEqual(result, { written: true });
  assert.deepEqual(readSettings(fx), { "pi-simple-sri": { observe: { replay: { allow: ["a"] } } } });
});

test("writeReplayAllow keeps every other key and merges with the existing list without dropping an entry", async (t) => {
  const fx = makeAgentDir(t);
  const original = {
    theme: "dark",
    "other-extension": { x: 1 },
    "pi-simple-sri": {
      skills: { deny: ["z"] },
      observe: { enabled: true, judgeModel: "anthropic/claude", replay: { allow: ["old", "b"], other: 1 } },
    },
  };
  const text = JSON.stringify(original, null, 2);
  fs.writeFileSync(settingsPathOf(fx), text);

  const result = await writeReplayAllow(fx.agentDir, ["b", "new"], text);
  assert.deepEqual(result, { written: true });
  assert.deepEqual(readSettings(fx), {
    ...original,
    "pi-simple-sri": {
      ...original["pi-simple-sri"],
      observe: { ...original["pi-simple-sri"].observe, replay: { allow: ["old", "b", "new"], other: 1 } },
    },
  });
});

test("writeReplayAllow does not write when the file changed since the snapshot, and hands the snippet over", async (t) => {
  const fx = makeAgentDir(t);
  const snapshot = '{"theme":"dark"}';
  const concurrent = '{"theme":"light"}';
  fs.writeFileSync(settingsPathOf(fx), concurrent);

  const result = await writeReplayAllow(fx.agentDir, ["a"], snapshot);
  assert.equal(result.written, false);
  assert.equal(fs.readFileSync(settingsPathOf(fx), "utf8"), concurrent);
  if (result.written) return;
  assert.match(result.snippet, /"allow": \[\s*"a"\s*\]/);
  assert.match(result.reason, /changed/);
});

test("writeReplayAllow does not write when the file appeared after a snapshot of no file", async (t) => {
  const fx = makeAgentDir(t);
  fs.writeFileSync(settingsPathOf(fx), "{}");
  const result = await writeReplayAllow(fx.agentDir, ["a"], null);
  assert.equal(result.written, false);
  assert.equal(fs.readFileSync(settingsPathOf(fx), "utf8"), "{}");
});

test("writeReplayAllow refuses invalid JSON, a non-object file and a malformed allow, leaving the file as it was", async (t) => {
  const fx = makeAgentDir(t);
  const bad = ["{not json", "[]", JSON.stringify({ "pi-simple-sri": { observe: { replay: { allow: "a" } } } }), JSON.stringify({ "pi-simple-sri": 3 })];
  for (const text of bad) {
    fs.writeFileSync(settingsPathOf(fx), text);
    const result = await writeReplayAllow(fx.agentDir, ["a"], text);
    assert.equal(result.written, false, text);
    assert.equal(fs.readFileSync(settingsPathOf(fx), "utf8"), text);
    if (!result.written) assert.match(result.snippet, /replay/);
  }
});

test("writeReplayAllow leaves a failed write as a snippet and not as an exception", async (t) => {
  const fx = makeAgentDir(t);
  const result = await writeReplayAllow(path.join(fx.root, "missing-agent-dir"), ["a"], null);
  assert.equal(result.written, false);
});

// ---------------------------------------------------------------------------------------------------------------
// runSetup
// ---------------------------------------------------------------------------------------------------------------

interface Harness {
  fx: AgentDirFixture;
  skills: SkillRef[];
  deps: SetupDeps;
  listed: { cwd: string; agentDir: string }[];
}

function refOf(name: string, dir: string): SkillRef {
  return { name, description: `${name} skill`, dir, realDir: dir, hasLessons: false, kind: "declared" };
}

// The three fixture skills, in the order the inventory answers them.
function harness(t: Parameters<typeof makeAgentDir>[0], extra: Partial<SetupDeps> = {}): Harness {
  const fx = makeAgentDir(t);
  const skills = (["read-only", "has-effects", "unknown"] as const).map((name) => refOf(name, installFixtureSkill(fx.skillsDir, name)));
  const listed: { cwd: string; agentDir: string }[] = [];
  const deps: SetupDeps = {
    listSkills: async (options) => {
      listed.push(options);
      return skills;
    },
    ...extra,
  };
  return { fx, skills, deps, listed };
}

function contextOf(h: Harness, ui: FakeUi, signal?: AbortSignal): SetupContext {
  return { agentDir: h.fx.agentDir, cwd: h.fx.cwd, ui, ...(signal === undefined ? {} : { signal }) };
}

const YES: UiStep = { kind: "confirm", answer: true };
const NO: UiStep = { kind: "confirm", answer: false };

function allowOf(fx: AgentDirFixture): unknown {
  const settings = readSettings(fx) as { "pi-simple-sri"?: { observe?: { replay?: { allow?: unknown } } } };
  return settings["pi-simple-sri"]?.observe?.replay?.allow;
}

test("runSetup suggests only the read-only skill, asks per skill and then once to write, and writes only that name", async (t) => {
  const h = harness(t);
  const handle = fakeUi([YES, YES]);
  const report = await runSetup(contextOf(h, handle.ui), h.deps);

  assert.deepEqual(h.listed, [{ cwd: h.fx.cwd, agentDir: h.fx.agentDir }]);
  assert.equal(handle.shown.length, 2);
  assert.match(handle.shown[0]?.title ?? "", /read-only/);
  assert.match(handle.shown[1]?.title ?? "", /settings\.json/);
  assert.equal(handle.remaining(), 0);
  assert.deepEqual(report.suggested, ["read-only"]);
  assert.deepEqual(report.accepted, ["read-only"]);
  assert.equal(report.written, true);
  assert.deepEqual(allowOf(h.fx), ["read-only"]);
  assert.deepEqual(
    report.classified.map((entry) => [entry.skill, entry.class, entry.source]),
    [
      ["read-only", "read-only", "static"],
      ["has-effects", "has-effects", "static"],
      ["unknown", "unknown", "static"],
    ],
  );
  assert.deepEqual(report.classified[1]?.indicators, ["gh-write", "git-push"]);
});

test("runSetup: the final confirmation says that only the allow list changes and that the formatting of the file is lost", async (t) => {
  const h = harness(t);
  const handle = fakeUi([YES, NO]);
  await runSetup(contextOf(h, handle.ui), h.deps);

  const message = handle.shown[1]?.message ?? "";
  assert.match(message, /pi-simple-sri\.observe\.replay\.allow/);
  assert.ok(
    message.includes("Nothing else in the settings changes; the file is rewritten as 2-space JSON and its formatting is lost."),
    message,
  );
});

test("runSetup: declining the only suggestion writes nothing and asks no final question", async (t) => {
  const h = harness(t);
  const handle = fakeUi([NO]);
  const report = await runSetup(contextOf(h, handle.ui), h.deps);

  assert.equal(handle.remaining(), 0);
  assert.deepEqual(report.accepted, []);
  assert.equal(report.written, false);
  assert.equal(fs.existsSync(path.join(h.fx.agentDir, "settings.json")), false);
});

test("runSetup: declining the final confirmation writes nothing", async (t) => {
  const h = harness(t);
  const handle = fakeUi([YES, NO]);
  const report = await runSetup(contextOf(h, handle.ui), h.deps);

  assert.deepEqual(report.accepted, ["read-only"]);
  assert.equal(report.written, false);
  assert.equal(fs.existsSync(path.join(h.fx.agentDir, "settings.json")), false);
});

test("runSetup: a skill that is already allowed, denied, or the published one is not asked about", async (t) => {
  const h = harness(t);
  const published = refOf("improving-skills", installFixtureSkill(h.fx.skillsDir, "read-only"));
  const denied = refOf("denied-one", installFixtureSkill(h.fx.skillsDir, "read-only"));
  h.skills.push(published, denied);
  fs.writeFileSync(
    path.join(h.fx.agentDir, "settings.json"),
    JSON.stringify({ "pi-simple-sri": { skills: { deny: ["denied-one"] }, observe: { replay: { allow: ["read-only"] } } } }),
  );
  const handle = fakeUi([]);
  const report = await runSetup(contextOf(h, handle.ui), h.deps);

  assert.equal(handle.shown.length, 0);
  assert.deepEqual(report.suggested, []);
  assert.deepEqual(report.alreadyAllowed, ["read-only"]);
  assert.deepEqual(
    report.classified.map((entry) => entry.skill),
    ["has-effects", "unknown"],
  );
});

test("runSetup ignores a standalone skill: it has no directory of its own to scan", async (t) => {
  const h = harness(t);
  h.skills.push({ ...refOf("standalone", h.fx.skillsDir), kind: "standalone" });
  const handle = fakeUi([NO]);
  const report = await runSetup(contextOf(h, handle.ui), h.deps);
  assert.equal(report.classified.some((entry) => entry.skill === "standalone"), false);
});

test("runSetup without a model never offers the LLM pass", async (t) => {
  const h = harness(t);
  const handle = fakeUi([NO]);
  const report = await runSetup(contextOf(h, handle.ui), h.deps);
  assert.equal(report.llm.asked, false);
  assert.equal(report.llm.calls, 0);
});

function llmHarness(t: Parameters<typeof makeAgentDir>[0], answers: readonly (string | Error)[]) {
  const registry = fakeRegistry(answers);
  const complete = createModelCall({ registry: registry.registry, model: MODEL, sessionId: "setup-session" });
  return { registry, h: harness(t, { complete }) };
}

test("runSetup: the cost estimate and its confirmation come first, and declining spends nothing", async (t) => {
  const { registry, h } = llmHarness(t, []);
  const handle = fakeUi([NO, NO]);
  const report = await runSetup(contextOf(h, handle.ui), h.deps);

  assert.equal(handle.shown[0]?.kind, "confirm");
  assert.match(handle.shown[0]?.message ?? "", /1 call/);
  assert.match(handle.shown[0]?.message ?? "", /unknown/);
  assert.equal(registry.calls.length, 0);
  assert.equal(report.llm.asked, true);
  assert.equal(report.llm.calls, 0);
  // the only dialog left is the deterministic read-only skill
  assert.deepEqual(report.suggested, ["read-only"]);
});

test("runSetup: the LLM pass sees only the unknown skills and can promote one to a suggestion that is still confirmed", async (t) => {
  const { registry, h } = llmHarness(t, ['{"class":"read-only"}']);
  const handle = fakeUi([YES, NO, YES, YES]);
  const report = await runSetup(contextOf(h, handle.ui), h.deps);

  assert.equal(registry.calls.length, 1);
  const sent = JSON.stringify(registry.calls[0]?.context);
  assert.match(sent, /release/);
  assert.doesNotMatch(sent, /git push/);
  assert.equal(report.llm.calls, 1);
  assert.deepEqual(report.suggested, ["read-only", "unknown"]);
  assert.match(handle.shown[2]?.message ?? "", /LLM/);
  // read-only declined, unknown accepted
  assert.deepEqual(report.accepted, ["unknown"]);
  assert.deepEqual(allowOf(h.fx), ["unknown"]);
  assert.equal(report.classified.find((entry) => entry.skill === "unknown")?.source, "llm");
});

test("runSetup: an LLM answer of has-effects, garbage or a failed call never yields a suggestion", async (t) => {
  for (const answer of ['{"class":"has-effects"}', "no idea", '{"class":"maybe"}', new Error("provider down")]) {
    const { h } = llmHarness(t, [answer]);
    const handle = fakeUi([YES, NO]);
    const report = await runSetup(contextOf(h, handle.ui), h.deps);
    assert.deepEqual(report.suggested, ["read-only"], String(answer));
    assert.notEqual(report.classified.find((entry) => entry.skill === "unknown")?.class, "read-only");
  }
});

test("runSetup: an LLM answer wrapped in prose with a brace after the object is still read", async (t) => {
  const { h } = llmHarness(t, ['Verdict: {"class":"read-only"} (my call :-})']);
  const handle = fakeUi([YES, NO, YES, NO]);
  const report = await runSetup(contextOf(h, handle.ui), h.deps);

  assert.deepEqual(report.suggested, ["read-only", "unknown"]);
});

test("runSetup never lets the LLM reclassify a skill with a deterministic indicator", async (t) => {
  const { registry, h } = llmHarness(t, ['{"class":"read-only"}']);
  h.skills.splice(0, h.skills.length, refOf("has-effects", installFixtureSkill(h.fx.skillsDir, "has-effects")));
  const handle = fakeUi([]);
  const report = await runSetup(contextOf(h, handle.ui), h.deps);
  assert.equal(registry.calls.length, 0);
  assert.equal(handle.shown.length, 0);
  assert.equal(report.llm.asked, false);
});

test("runSetup: a settings.json that changed during the dialogs is not overwritten, and the snippet is shown instead", async (t) => {
  const h = harness(t);
  const settings = path.join(h.fx.agentDir, "settings.json");
  fs.writeFileSync(settings, '{"theme":"dark"}');
  const scripted = fakeUi([YES, YES]);
  let asked = 0;
  const ui: FakeUi = {
    ...scripted.ui,
    async confirm(title, message, opts) {
      const answer = await scripted.ui.confirm(title, message, opts);
      asked += 1;
      if (asked === 2) fs.writeFileSync(settings, '{"theme":"light"}');
      return answer;
    },
  };
  const report = await runSetup(contextOf(h, ui), h.deps);

  assert.equal(fs.readFileSync(settings, "utf8"), '{"theme":"light"}');
  assert.equal(report.written, false);
  assert.match(report.snippet ?? "", /read-only/);
  assert.ok(scripted.notices.some((notice) => /read-only/.test(notice.message)));
});

test("runSetup: an aborted signal asks nothing and writes nothing", async (t) => {
  const h = harness(t);
  const controller = new AbortController();
  controller.abort();
  const handle = fakeUi([]);
  const report = await runSetup(contextOf(h, handle.ui, controller.signal), h.deps);
  assert.equal(report.aborted, true);
  assert.equal(handle.shown.length, 0);
  assert.equal(report.written, false);
});

test("runSetup: dialogs dismissed by an abort mid-run end it without a write", async (t) => {
  const h = harness(t);
  const controller = new AbortController();
  const scripted = fakeUi([YES, YES]);
  const ui: FakeUi = {
    ...scripted.ui,
    async confirm(title, message, opts) {
      controller.abort();
      return await scripted.ui.confirm(title, message, opts);
    },
  };
  const report = await runSetup(contextOf(h, ui, controller.signal), h.deps);
  assert.equal(report.aborted, true);
  assert.equal(report.written, false);
  assert.equal(fs.existsSync(path.join(h.fx.agentDir, "settings.json")), false);
});

test("runSetup passes the signal to every dialog", async (t) => {
  const h = harness(t);
  const controller = new AbortController();
  const handle = fakeUi([YES, YES]);
  await runSetup(contextOf(h, handle.ui, controller.signal), h.deps);
  assert.ok(handle.shown.every((dialog) => dialog.opts?.signal === controller.signal));
});

test("runSetup fails closed on a settings file it cannot read, before any dialog", async (t) => {
  const h = harness(t);
  fs.writeFileSync(path.join(h.fx.agentDir, "settings.json"), "{broken");
  const handle = fakeUi([]);
  await assert.rejects(runSetup(contextOf(h, handle.ui), h.deps), /invalid JSON/);
  assert.equal(handle.shown.length, 0);
});

test("runSetup reads the files of a skill from its realDir, so a script next to SKILL.md makes it has-effects", async (t) => {
  const h = harness(t);
  const dir = skillFixture(h.fx.skillsDir, "scripted", {
    "SKILL.md": "---\nname: scripted\ndescription: d\n---\nRead with `cat`.\n",
    "scripts/go.sh": "echo\n",
  });
  h.skills.splice(0, h.skills.length, refOf("scripted", dir));
  const handle = fakeUi([]);
  const report: SetupReport = await runSetup(contextOf(h, handle.ui), h.deps);
  assert.equal(report.classified[0]?.class, "has-effects");
  assert.deepEqual(report.classified[0]?.indicators, ["script:scripts/go.sh"]);
  assert.equal(handle.shown.length, 0);
});

test("runSetup does not read the history, the lessons' bank or the git dir as skill content", async (t) => {
  const h = harness(t);
  const dir = skillFixture(h.fx.skillsDir, "clean", {
    "SKILL.md": "---\nname: clean\ndescription: d\n---\nRead with `cat notes.md`.\n",
    ".history/old/SKILL.md": "Run `git push`.",
    "case-bank.json": '{"note":"git push"}',
    ".git/hooks/pre-push.sh": "x",
  });
  h.skills.splice(0, h.skills.length, refOf("clean", dir));
  const handle = fakeUi([NO]);
  const report = await runSetup(contextOf(h, handle.ui), h.deps);
  assert.equal(report.classified[0]?.class, "read-only");
});
