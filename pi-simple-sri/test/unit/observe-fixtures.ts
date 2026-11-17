import type { TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { sha256Hex } from "../../src/hash.ts";
import type { ModelCallRegistry } from "../../src/model-call.ts";

// The shared material of the observe suites: session files in the real pi format (CURRENT_SESSION_VERSION 3), the
// scenarios the plan lists, a temp agent directory, a scripted ui and a scripted model registry. It is not a
// *.test.ts, so the runner does not execute it; tsconfig includes test/**/*, so it is typechecked like everything else.
//
// Sessions are built here and not stored as files because the interesting ones differ by one entry and a fork pair
// has to share ids: a builder keeps that difference visible. The skills, banks and labeled episodes are plain files
// under test/fixtures, and the only session file stored as bytes is the v2 one, because a v2 header is the point of it.

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export function fixturePath(...segments: string[]): string {
  return path.join(FIXTURES_DIR, ...segments);
}

export function readFixture(...segments: string[]): string {
  return fs.readFileSync(fixturePath(...segments), "utf8");
}

// ---------------------------------------------------------------------------------------------------------------
// Session files
// ---------------------------------------------------------------------------------------------------------------

export const FIXTURE_CWD = "/work/proj-a";
export const FIXTURE_SKILLS_DIR = "/work/skills";
// The moment of the "run": a session file touched a few minutes before it is inside the 30 minute idle window.
export const FIXTURE_NOW = "2026-11-16T12:00:00.000Z";
export const OPT_IN_AT = "2026-11-10T00:00:00.000Z";
export const BEFORE_OPT_IN_AT = "2026-11-05T09:00:00.000Z";
export const AFTER_OPT_IN_AT = "2026-11-12T09:00:00.000Z";

// Made of pieces so that no secret scanner flags this file: each value has the shape of a credential and none of
// them is one.
export const FAKE_SECRETS = {
  awsKey: `AKIA${"IOSFODNN7EXAMPLE"}`,
  githubToken: `ghp_${"0123456789abcdefghijklmnopqrstuvwxyzAB"}`,
  bearer: `Bearer ${"abcdefghijklmnopqrstuvwxyz0123456789"}`,
} as const;

export interface CallSpec {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// One entry of the session, in the order it was appended. The id is derived from the seed and the position unless
// the step names one, so two sessions with the same seed and the same prefix share entry ids, which is what a fork
// does.
export type Step =
  | { kind: "user"; text: string; id?: string }
  | { kind: "skill"; name: string; location: string; body?: string; args?: string; id?: string }
  | { kind: "assistant"; text?: string; calls?: CallSpec[]; provider?: string; model?: string; id?: string }
  | { kind: "tool-result"; callId: string; tool: string; text: string; isError?: boolean; id?: string }
  | { kind: "model-change"; provider: string; modelId: string; id?: string }
  // `keepFromStep` is the position of the first step the compaction keeps.
  | { kind: "compaction"; summary: string; keepFromStep: number; id?: string };

export interface SessionSpec {
  id: string;
  cwd: string;
  startedAt: string;
  steps: Step[];
  version?: number;
  parentSession?: string;
  // Seed of the entry ids; defaults to the session id.
  idSeed?: string;
}

const STEP_SECONDS = 1;

function entryIdOf(seed: string, index: number): string {
  return sha256Hex(`${seed}:${index}`).slice(0, 8);
}

function assistantMessageOf(step: Extract<Step, { kind: "assistant" }>, ms: number): Record<string, unknown> {
  const content: unknown[] = [];
  if (step.text !== undefined) content.push({ type: "text", text: step.text });
  for (const call of step.calls ?? []) {
    content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
  }
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: step.provider ?? "anthropic",
    model: step.model ?? "claude-sonnet-4-5",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: (step.calls ?? []).length > 0 ? "toolUse" : "stop",
    timestamp: ms,
  };
}

// The `<skill>` block pi injects for /skill:name, and the args after it (agent-session.ts of pi).
export function skillBlockText(name: string, location: string, body: string, args?: string): string {
  const block = `<skill name="${name}" location="${location}">\nReferences are relative to ${path.dirname(location)}.\n\n${body}\n</skill>`;
  return args === undefined ? block : `${block}\n\n${args}`;
}

export interface SessionJsonlOptions {
  // Cuts the last line in half and drops the final newline: a file pi is still appending to.
  truncateTail?: boolean;
}

export function sessionEntriesOf(spec: SessionSpec): Record<string, unknown>[] {
  const seed = spec.idSeed ?? spec.id;
  const startMs = Date.parse(spec.startedAt);
  const ids = spec.steps.map((step, index) => step.id ?? entryIdOf(seed, index));
  const entries: Record<string, unknown>[] = [
    {
      type: "session",
      version: spec.version ?? 3,
      id: spec.id,
      timestamp: spec.startedAt,
      cwd: spec.cwd,
      ...(spec.parentSession === undefined ? {} : { parentSession: spec.parentSession }),
    },
  ];

  spec.steps.forEach((step, index) => {
    const ms = startMs + (index + 1) * STEP_SECONDS * 1000;
    const base = {
      id: ids[index],
      parentId: index === 0 ? null : ids[index - 1],
      timestamp: new Date(ms).toISOString(),
    };
    switch (step.kind) {
      case "user":
        entries.push({ type: "message", ...base, message: { role: "user", content: [{ type: "text", text: step.text }], timestamp: ms } });
        return;
      case "skill":
        entries.push({
          type: "message",
          ...base,
          message: {
            role: "user",
            content: [{ type: "text", text: skillBlockText(step.name, step.location, step.body ?? `# ${step.name}\n\nFollow the instructions.`, step.args) }],
            timestamp: ms,
          },
        });
        return;
      case "assistant":
        entries.push({ type: "message", ...base, message: assistantMessageOf(step, ms) });
        return;
      case "tool-result":
        entries.push({
          type: "message",
          ...base,
          message: {
            role: "toolResult",
            toolCallId: step.callId,
            toolName: step.tool,
            content: [{ type: "text", text: step.text }],
            isError: step.isError ?? false,
            timestamp: ms,
          },
        });
        return;
      case "model-change":
        entries.push({ type: "model_change", ...base, provider: step.provider, modelId: step.modelId });
        return;
      case "compaction":
        entries.push({
          type: "compaction",
          ...base,
          summary: step.summary,
          firstKeptEntryId: ids[step.keepFromStep],
          tokensBefore: 1000,
        });
        return;
    }
  });
  return entries;
}

export function sessionJsonl(spec: SessionSpec, options: SessionJsonlOptions = {}): string {
  const lines = sessionEntriesOf(spec).map((entry) => JSON.stringify(entry));
  if (options.truncateTail === true) {
    const last = lines.pop() ?? "";
    return `${lines.map((line) => `${line}\n`).join("")}${last.slice(0, Math.floor(last.length / 2))}`;
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios: one function per case the plan lists. Each returns a spec; the expectation is in its comment.
// ---------------------------------------------------------------------------------------------------------------

export interface ScenarioOptions {
  id?: string;
  cwd?: string;
  skillsDir?: string;
  startedAt?: string;
  skill?: string;
  idSeed?: string;
}

function skillFileOf(options: ScenarioOptions, name: string): string {
  return `${options.skillsDir ?? FIXTURE_SKILLS_DIR}/${name}/SKILL.md`;
}

function specOf(name: string, options: ScenarioOptions, steps: Step[]): SessionSpec {
  return {
    id: options.id ?? `fx-${name}`,
    cwd: options.cwd ?? FIXTURE_CWD,
    startedAt: options.startedAt ?? AFTER_OPT_IN_AT,
    steps,
    ...(options.idSeed === undefined ? {} : { idSeed: options.idSeed }),
  };
}

const CORRECTION = "No, that is wrong: list only the breaking changes.";

function explicitSteps(options: ScenarioOptions, tail: Step[]): Step[] {
  const skill = options.skill ?? "demo-skill";
  return [
    { kind: "skill", name: skill, location: skillFileOf(options, skill), args: "summarise the changelog" },
    { kind: "assistant", text: "Here is a full summary of the changelog." },
    ...tail,
  ];
}

// One explicit episode of demo-skill, followed by a user correction.
export function explicitCorrection(options: ScenarioOptions = {}): SessionSpec {
  return specOf("explicit-correction", options, explicitSteps(options, [
    { kind: "user", text: CORRECTION },
    { kind: "assistant", text: "Understood, only the breaking changes: none in this release." },
  ]));
}

// One explicit episode that ends well: nothing in the user text is a correction.
export function cleanEpisode(options: ScenarioOptions = {}): SessionSpec {
  return specOf("clean", options, explicitSteps(options, [{ kind: "user", text: "Thanks, perfect." }]));
}

// The same skill as an `improving-skills` explicit block: never eligible.
export function improvingSkillsEpisode(options: ScenarioOptions = {}): SessionSpec {
  return specOf("improving-skills", { ...options, skill: "improving-skills" }, explicitSteps({ ...options, skill: "improving-skills" }, [
    { kind: "user", text: CORRECTION },
  ]));
}

// No skill block: the skill is used because the assistant read its SKILL.md.
export function implicitRead(options: ScenarioOptions = {}): SessionSpec {
  const skill = options.skill ?? "demo-skill";
  return specOf("implicit-read", options, [
    { kind: "user", text: "Summarise the changelog" },
    { kind: "assistant", calls: [{ id: "call-read-1", name: "read", arguments: { path: skillFileOf(options, skill) } }] },
    { kind: "tool-result", callId: "call-read-1", tool: "read", text: `# ${skill}\n\nSummarise the input.` },
    { kind: "assistant", text: "Here is a full summary of the changelog." },
    { kind: "user", text: CORRECTION },
    { kind: "assistant", text: "Understood." },
  ]);
}

// Implicit read plus an edit of that same SKILL.md: the user was editing the skill, not using it. Excluded.
export function implicitReadAndEdit(options: ScenarioOptions = {}): SessionSpec {
  const skill = options.skill ?? "demo-skill";
  const file = skillFileOf(options, skill);
  return specOf("implicit-read-edit", options, [
    { kind: "user", text: "Tighten the wording of the demo-skill" },
    { kind: "assistant", calls: [{ id: "call-read-1", name: "read", arguments: { path: file } }] },
    { kind: "tool-result", callId: "call-read-1", tool: "read", text: `# ${skill}\n\nSummarise the input.` },
    { kind: "assistant", calls: [{ id: "call-edit-1", name: "edit", arguments: { path: file, oldText: "Summarise", newText: "Summarize" } }] },
    { kind: "tool-result", callId: "call-edit-1", tool: "edit", text: "edited" },
    { kind: "assistant", text: "Done." },
  ]);
}

// Three SKILL.md files read in one assistant turn: a survey, not a use. Excluded.
export function manySkillReads(options: ScenarioOptions = {}): SessionSpec {
  const names = ["demo-skill", "other-skill", "third-skill"];
  return specOf("many-skill-reads", options, [
    { kind: "user", text: "Which of my skills handles changelogs?" },
    {
      kind: "assistant",
      calls: names.map((name, index) => ({ id: `call-read-${index}`, name: "read", arguments: { path: skillFileOf(options, name) } })),
    },
    ...names.map((name, index): Step => ({ kind: "tool-result", callId: `call-read-${index}`, tool: "read", text: `# ${name}` })),
    { kind: "assistant", text: "demo-skill handles changelogs." },
  ]);
}

// A message the user sent while the agent was running a tool call (a steer): it is user-authored and a correction.
export function steeringMidTurn(options: ScenarioOptions = {}): SessionSpec {
  return specOf("steering", options, [
    { kind: "skill", name: "demo-skill", location: skillFileOf(options, "demo-skill"), args: "summarise the changelog" },
    { kind: "assistant", calls: [{ id: "call-bash-1", name: "bash", arguments: { command: "cat CHANGELOG.md" } }] },
    { kind: "tool-result", callId: "call-bash-1", tool: "bash", text: "# Changelog\n- 1.0.0" },
    { kind: "user", text: "Wait, use the staging branch changelog instead." },
    { kind: "assistant", text: "Using the staging branch changelog." },
  ]);
}

// B2: two agent runs in one session. pi resets turnIndex on every agent_start, so both writes sit at turn 0 of their run.
export function twoAgentRuns(options: ScenarioOptions = {}): SessionSpec {
  return specOf("two-agent-runs", options, [
    { kind: "user", text: "Write the draft of the release notes" },
    { kind: "assistant", calls: [{ id: "call-w-1", name: "write", arguments: { path: `${options.cwd ?? FIXTURE_CWD}/notes.md`, content: "v1" } }] },
    { kind: "tool-result", callId: "call-w-1", tool: "write", text: "written" },
    { kind: "assistant", text: "Draft written." },
    { kind: "user", text: "Now write the migration guide" },
    { kind: "assistant", calls: [{ id: "call-w-2", name: "write", arguments: { path: `${options.cwd ?? FIXTURE_CWD}/migration.md`, content: "v1" } }] },
    { kind: "tool-result", callId: "call-w-2", tool: "write", text: "written" },
    { kind: "assistant", text: "Guide written." },
  ]);
}

// The same file rewritten with other arguments inside one prompt: a rewritten draft under the same prompt, not a signal.
export function rewrittenDraftSamePrompt(options: ScenarioOptions = {}): SessionSpec {
  const file = `${options.cwd ?? FIXTURE_CWD}/notes.md`;
  return specOf("rewrite-same-prompt", options, [
    { kind: "user", text: "Write the release notes" },
    { kind: "assistant", calls: [{ id: "call-w-1", name: "write", arguments: { path: file, content: "v1" } }] },
    { kind: "tool-result", callId: "call-w-1", tool: "write", text: "written" },
    { kind: "assistant", calls: [{ id: "call-w-2", name: "write", arguments: { path: file, content: "v2" } }] },
    { kind: "tool-result", callId: "call-w-2", tool: "write", text: "written" },
    { kind: "assistant", text: "Notes written." },
  ]);
}

// The same file rewritten with other arguments under a later prompt: the user came back to it.
export function rewrittenDraftLaterPrompt(options: ScenarioOptions = {}): SessionSpec {
  const file = `${options.cwd ?? FIXTURE_CWD}/notes.md`;
  return specOf("rewrite-later-prompt", options, [
    { kind: "user", text: "Write the release notes" },
    { kind: "assistant", calls: [{ id: "call-w-1", name: "write", arguments: { path: file, content: "v1" } }] },
    { kind: "tool-result", callId: "call-w-1", tool: "write", text: "written" },
    { kind: "assistant", text: "Notes written." },
    { kind: "user", text: "Redo it, shorter" },
    { kind: "assistant", calls: [{ id: "call-w-2", name: "write", arguments: { path: file, content: "v2" } }] },
    { kind: "tool-result", callId: "call-w-2", tool: "write", text: "written" },
    { kind: "assistant", text: "Notes rewritten." },
  ]);
}

// A tool call that failed inside an explicit episode: mechanical evidence.
export function toolErrorEpisode(options: ScenarioOptions = {}): SessionSpec {
  return specOf("tool-error", options, explicitSteps(options, [
    { kind: "assistant", calls: [{ id: "call-bash-1", name: "bash", arguments: { command: "cat missing.md" } }] },
    { kind: "tool-result", callId: "call-bash-1", tool: "bash", text: "cat: missing.md: No such file or directory", isError: true },
    { kind: "assistant", text: "The file does not exist." },
  ]));
}

// Two sessions that share the entries of the first three steps (same seed, same prefix), as a fork does. The child's
// diverging step gets a NEW id (from `divergeSeed`), as in pi; its parentId is the last shared entry.
export function forkPair(options: ScenarioOptions & { divergeSeed?: string } = {}): { parent: SessionSpec; child: SessionSpec } {
  const divergeSeed = options.divergeSeed ?? "fx-fork-diverge-seed";
  const idSeed = options.idSeed ?? "fx-fork-seed";
  const parent = specOf("fork-parent", { ...options, idSeed }, explicitSteps(options, [
    { kind: "user", text: CORRECTION },
    { kind: "assistant", text: "Understood." },
  ]));
  const child: SessionSpec = {
    ...parent,
    id: "fx-fork-child",
    parentSession: `/sessions/${parent.id}.jsonl`,
    steps: [
      ...parent.steps.slice(0, 3),
      { kind: "assistant", text: "A different answer after the fork.", id: entryIdOf(divergeSeed, 3) },
    ],
  };
  return { parent, child };
}

// The header cwd is under a temp dir: never observed.
export function tmpCwdEpisode(options: ScenarioOptions = {}): SessionSpec {
  return explicitCorrection({ ...options, id: options.id ?? "fx-tmp-cwd", cwd: "/private/tmp/scratch" });
}

// The header cwd does not exist on disk: the `exists` the test hands to isExcludedCwd answers false for it.
export function missingCwdEpisode(options: ScenarioOptions = {}): SessionSpec {
  return explicitCorrection({ ...options, id: options.id ?? "fx-missing-cwd", cwd: "/work/gone-dir" });
}

// An episode whose assistant ran on another provider than the default judge.
export function providerMismatchEpisode(options: ScenarioOptions = {}): SessionSpec {
  const spec = explicitCorrection({ ...options, id: options.id ?? "fx-provider-mismatch" });
  return {
    ...spec,
    steps: spec.steps.map((step) => (step.kind === "assistant" ? { ...step, provider: "openai", model: "gpt-5" } : step)),
  };
}

// Secrets in the user text and in the tool output of an episode.
export function secretsEpisode(options: ScenarioOptions = {}): SessionSpec {
  return specOf("secrets", options, [
    { kind: "skill", name: "demo-skill", location: skillFileOf(options, "demo-skill"), args: `deploy with ${FAKE_SECRETS.awsKey}` },
    { kind: "assistant", calls: [{ id: "call-bash-1", name: "bash", arguments: { command: "env" } }] },
    { kind: "tool-result", callId: "call-bash-1", tool: "bash", text: `GITHUB_TOKEN=${FAKE_SECRETS.githubToken}` },
    { kind: "assistant", text: "Deployed." },
    { kind: "user", text: `No, use the other account: Authorization: ${FAKE_SECRETS.bearer}` },
    { kind: "assistant", text: "Redeploying." },
  ]);
}

// A compaction entry inside the episode, keeping everything from the first assistant answer on.
export function compactionEpisode(options: ScenarioOptions = {}): SessionSpec {
  return specOf("compaction", options, explicitSteps(options, [
    { kind: "compaction", summary: "The user asked for a changelog summary.", keepFromStep: 1 },
    { kind: "user", text: CORRECTION },
    { kind: "assistant", text: "Understood." },
  ]));
}

// An explicit episode started before the opt-in marker: ignored by the fold.
export function beforeOptInEpisode(options: ScenarioOptions = {}): SessionSpec {
  return explicitCorrection({ ...options, id: options.id ?? "fx-before-opt-in", startedAt: options.startedAt ?? BEFORE_OPT_IN_AT });
}

// The same session id at two moments of its life: the second is shorter, so the cursor must see a rewrite.
export function rewrittenFilePair(options: ScenarioOptions = {}): { before: SessionSpec; after: SessionSpec } {
  const before = explicitCorrection({ ...options, id: options.id ?? "fx-rewritten" });
  const after: SessionSpec = {
    ...before,
    steps: [{ kind: "user", text: "A different first message after the rewrite." }],
  };
  return { before, after };
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions on disk: grouped and flat layouts, a nested run, mtimes
// ---------------------------------------------------------------------------------------------------------------

export type SessionsLayout = "grouped" | "flat";

export interface TreeEntry {
  spec: SessionSpec;
  options?: SessionJsonlOptions;
  // Written under run-0/session.jsonl inside the project directory (grouped) or the root (flat): never top level.
  nested?: boolean;
  // Defaults to one hour after the session started, which is idle relative to FIXTURE_NOW.
  mtime?: Date;
}

// pi names the project directory `--<cwd with separators as dashes>--` and the file `<timestamp>_<id>.jsonl`.
export function groupedDirNameOf(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function sessionFileNameOf(spec: SessionSpec): string {
  return `${spec.startedAt.replace(/[:.]/g, "-")}_${spec.id}.jsonl`;
}

// Writes the sessions under `root` and answers the path of each one, in the order given.
export function writeSessionsTree(root: string, layout: SessionsLayout, entries: readonly TreeEntry[]): string[] {
  return entries.map((entry) => {
    const projectDir = layout === "grouped" ? path.join(root, groupedDirNameOf(entry.spec.cwd)) : root;
    const dir = entry.nested === true ? path.join(projectDir, "run-0") : projectDir;
    const file = path.join(dir, entry.nested === true ? "session.jsonl" : sessionFileNameOf(entry.spec));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, sessionJsonl(entry.spec, entry.options), "utf8");
    const mtime = entry.mtime ?? new Date(Date.parse(entry.spec.startedAt) + 3_600_000);
    fs.utimesSync(file, mtime, mtime);
    return file;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Agent directory, skills
// ---------------------------------------------------------------------------------------------------------------

export interface AgentDirFixture {
  root: string;
  agentDir: string;
  sessionsDir: string;
  skillsDir: string;
  cwd: string;
  // `<agentDir>/sri`: what writeBase(agentDir) answers.
  base: string;
}

// Under a canonical temp root: os.tmpdir() is a symlink on some platforms (macOS /var -> /private/var).
export function makeAgentDir(t: TestContext): AgentDirFixture {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-observe-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const agentDir = path.join(root, "agent");
  const sessionsDir = path.join(agentDir, "sessions");
  const skillsDir = path.join(agentDir, "skills");
  const cwd = path.join(root, "cwd");
  for (const dir of [sessionsDir, skillsDir, cwd]) fs.mkdirSync(dir, { recursive: true });
  return { root, agentDir, sessionsDir, skillsDir, cwd, base: path.join(agentDir, "sri") };
}

// A skill directory with the given files (relative path -> text); answers the directory.
export function skillFixture(root: string, name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
  }
  return dir;
}

export type FixtureSkillName = "read-only" | "has-effects" | "unknown" | "ships-bank";

// Copies test/fixtures/skills/<name> into `root`. `ships-bank` also gets banks/legacy-skill-shipped.json as its
// case-bank.json, so the bytes of that bank exist once (B4: the file copySkillTree must leave out).
export function installFixtureSkill(root: string, name: FixtureSkillName): string {
  const dir = path.join(root, name);
  fs.cpSync(fixturePath("skills", name), dir, { recursive: true });
  if (name === "ships-bank") {
    fs.copyFileSync(fixturePath("banks", "legacy-skill-shipped.json"), path.join(dir, "case-bank.json"));
  }
  return dir;
}

// ---------------------------------------------------------------------------------------------------------------
// Scripted ui and registry
// ---------------------------------------------------------------------------------------------------------------

// What the dialog does when the script reaches it besides answering.
export const HANG = Symbol("hang");
export const TIMEOUT = Symbol("timeout");

export type UiStep =
  | { kind: "select"; answer: string | undefined | typeof HANG | typeof TIMEOUT }
  | { kind: "confirm"; answer: boolean | typeof HANG | typeof TIMEOUT };

export interface DialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface ShownDialog {
  kind: "select" | "confirm";
  title: string;
  options?: readonly string[];
  message?: string;
  opts?: DialogOptions;
}

export interface FakeUi {
  select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: DialogOptions): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface FakeUiHandle {
  ui: FakeUi;
  shown: ShownDialog[];
  notices: { message: string; type: string }[];
  // Steps the test scripted and the code never asked for.
  remaining(): number;
}

// Answers the dialogs in the order scripted. A dialog of another kind than the next step throws, so a test fails
// instead of reading the wrong answer. HANG stays open until the signal aborts (an aborted signal dismisses it, as pi
// does); TIMEOUT dismisses it at once, as the countdown of `timeout` does. A dialog dismissed answers undefined / false.
export function fakeUi(script: readonly UiStep[]): FakeUiHandle {
  const queue = [...script];
  const shown: ShownDialog[] = [];
  const notices: { message: string; type: string }[] = [];

  function next(kind: UiStep["kind"], title: string): UiStep {
    const step = queue.shift();
    if (step === undefined) throw new Error(`fakeUi: unscripted ${kind} dialog ${JSON.stringify(title)}`);
    if (step.kind !== kind) throw new Error(`fakeUi: scripted ${step.kind} but ${kind} ${JSON.stringify(title)} was asked`);
    return step;
  }

  function untilAborted(signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
      if (signal === undefined) return; // never resolves: the test hung the dialog without a way out
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  const ui: FakeUi = {
    async select(title, options, opts) {
      shown.push({ kind: "select", title, options: [...options], ...(opts === undefined ? {} : { opts }) });
      const step = next("select", title);
      if (step.kind !== "select") throw new Error("unreachable");
      if (step.answer === HANG) {
        await untilAborted(opts?.signal);
        return undefined;
      }
      if (step.answer === TIMEOUT) return undefined;
      return step.answer;
    },
    async confirm(title, message, opts) {
      shown.push({ kind: "confirm", title, message, ...(opts === undefined ? {} : { opts }) });
      const step = next("confirm", title);
      if (step.kind !== "confirm") throw new Error("unreachable");
      if (step.answer === HANG) {
        await untilAborted(opts?.signal);
        return false;
      }
      if (step.answer === TIMEOUT) return false;
      return step.answer;
    },
    notify(message, type) {
      notices.push({ message, type: type ?? "info" });
    },
  };

  return { ui, shown, notices, remaining: () => queue.length };
}

export interface RegistryCall {
  context: unknown;
  options: unknown;
}

export interface FakeRegistryHandle {
  registry: ModelCallRegistry;
  calls: RegistryCall[];
  remaining(): number;
}

// Answers the calls in the order scripted: a string is the text of the reply, an Error is thrown. A call nobody
// scripted throws, so a test cannot pass by spending a call it did not expect.
export function fakeRegistry(answers: readonly (string | Error)[]): FakeRegistryHandle {
  const queue = [...answers];
  const calls: RegistryCall[] = [];
  const registry: ModelCallRegistry = {
    async complete(model, context, options) {
      calls.push({ context, options });
      const answer = queue.shift();
      if (answer === undefined) throw new Error("fakeRegistry: unscripted model call");
      if (answer instanceof Error) throw answer;
      const reply: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: answer }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.parse(FIXTURE_NOW),
      };
      return reply;
    },
  };
  return { registry, calls, remaining: () => queue.length };
}

// ---------------------------------------------------------------------------------------------------------------
// signals.jsonl over its ceiling (B3)
// ---------------------------------------------------------------------------------------------------------------

// `count` raised lines, oldest first, each with a distinct id and an increasing createdAt. The ceiling is
// MAX_SIGNAL_LINES (128) in src/signals.ts and is not exported, so the caller passes a count over it.
export function signalsFileText(count: number, sessionId = "fx-signals"): string {
  const base = Date.parse(AFTER_OPT_IN_AT);
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(
      JSON.stringify({
        format: "pi-simple-sri/signal@1",
        event: "raised",
        id: `sg-${sha256Hex(`${sessionId}:${index}`).slice(0, 8)}`,
        kind: "repeated-request",
        createdAt: new Date(base + index * 60_000).toISOString(),
        sessionId,
        turnIndex: index,
        subject: `request number ${index}`,
        excerpt: `request number ${index}`,
        prompt: `request number ${index}`,
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Labeled episodes (WP13 scoring)
// ---------------------------------------------------------------------------------------------------------------

export interface LabeledEpisode {
  episodeId: string;
  flagged: boolean; // the prefilter raised a flag
  judgeFound: boolean; // the judge reported a finding
  label: boolean; // a human says the episode holds a correction
}

export interface Ratio {
  num: number;
  den: number;
}

export interface LabelingExpectation {
  n: number;
  judgePrecision: Ratio;
  judgeRecall: Ratio;
  prefilterRecall: Ratio;
}

export function readLabeledEpisodes(): LabeledEpisode[] {
  return readFixture("labeling", "labeled-episodes.jsonl")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LabeledEpisode);
}

export function readLabelingExpectation(): LabelingExpectation {
  return JSON.parse(readFixture("labeling", "labeled-episodes.expected.json")) as LabelingExpectation;
}
