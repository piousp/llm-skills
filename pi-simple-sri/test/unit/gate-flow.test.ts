import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  gateStagedCandidate,
  resolveStagedCandidate,
  type CandidateRejection,
  type GateConcludedResult,
  type GateDeps,
  type GateFlowResult,
  type GateRequest,
  type StagedCandidateResult,
} from "../../src/gate/flow.ts";
import type { ReplayRun, ReplayRunRequest } from "../../src/gate/types.ts";
import type { CaseCheck } from "../../src/checks.ts";
import { sha256Digest } from "../../src/hash.ts";
import { serializeLesson } from "../../src/lesson-frontmatter.ts";
import { ATTEMPTS_FILE, DECISION_FILE, LESSONS_DIR, SKILL_FILE } from "../../src/names.ts";
import type { ListSkillsOptions } from "../../src/skills-inventory.ts";
import { LESSON_GATE_ACCEPTED } from "../../src/types.ts";
import type {
  AttemptLine,
  DecisionRecord,
  EvidenceItem,
  GateBlock,
  GateConcluded,
  ReplayItem,
  SkillRef,
} from "../../src/types.ts";
import { stateDir, stagingDir } from "../../src/write-base.ts";
import { lessonHashes } from "../../src/writer.ts";
import { validateAgainstSchema } from "./schema-reader.ts";

// The flow of the gate (S8), in the two halves it has: the candidate a run is pointed at -- the record or the
// typed refusal that says why there is none -- and the gate over it, from the preregistration to the one line
// of the index.
//
// Everything runs on a staging tree and a skill built in mkdtemp: no test names a real skill, nothing outside
// the temporary directory is read or written, and no run starts a process. `runReplay` is the seam the whole
// budget goes through, so the twelve runs of a 2x2x3 design cost nothing and answer exactly what a test says.

const SKILL_NAME = "pdf-tools";
const OTHER_SKILL = "pdf-images";
const SLUG = "merged-cells";
const TITLE = "Extract merged cells with the lattice strategy";
const TOOL = "bash";
// OA5: the model of the failing turn, in the spelling a replay pins.
const MODEL = "opencode-go/deepseek-v4.1-flash";
// The failure signature of the diagnosis, which every line of this candidate's index names (OA4).
const SIGNATURE = `sha256:${"c".repeat(64)}`;
const STAGING_TIMESTAMP = "20261102T140322481Z";
// The clock of the harness starts here and advances one second per reading, so every moment of a run is
// distinct and ordered.
const CLOCK_START = new Date("2026-11-02T14:10:00.000Z");
const CLOCK_STEP_MS = 1000;
// What one run of the budget costs, small enough to add up in an assertion.
const RUN_USAGE = { input: 10, output: 2 };
// The design of §8: two repetitions of each of the three items, in two arms.
const PLANNED_RUNS = 12;
const RUNS_PER_ARM = 6;

// The evidence of the diagnosis: a failed tool call per replay item, with the two fields the two halves of the
// gate read -- the excerpt the intrinsic-failure exclusion reads (OA7) and the id whose digest names the
// failure of the item.
const EVIDENCE: readonly EvidenceItem[] = [
  {
    id: "ev-3f9a1c02",
    kind: "tool_error",
    toolName: TOOL,
    timestamp: 1762082602481,
    source: "transcript",
    excerpt: "pdftotext: cannot open report.pdf",
  },
  {
    id: "ev-4a8b2d11",
    kind: "tool_error",
    toolName: TOOL,
    timestamp: 1762082603492,
    source: "transcript",
    excerpt: "pdftotext: the table of page 3 stops after the first column",
  },
  {
    id: "ev-5b7c3e22",
    kind: "tool_error",
    toolName: TOOL,
    timestamp: 1762082604503,
    source: "transcript",
    excerpt: "pdftotext: merged cells come out as two columns",
  },
];

// OA7: the failure of the task and not of the skill. A `read` of a file that is not there fails the same way
// whatever the skill says, so the item it names measures nothing about the candidate -- and the tool and the
// excerpt are the two fields the exclusion reads.
const READ_TOOL = "read";
const INTRINSIC_EVIDENCE: EvidenceItem = {
  id: "ev-6c8d4f33",
  kind: "tool_error",
  toolName: READ_TOOL,
  timestamp: 1762082605514,
  source: "transcript",
  excerpt: "read /work/reports/missing.pdf: ENOENT: no such file or directory",
};

// The candidate lesson, in the format src/lesson-frontmatter.ts owns: src/writer.ts reads the staged bytes back
// with the parser of that module before it lets a record be replaced, so the fixture is built by the writer of
// the format and not by hand.
const LESSON_TEXT = fixtureLesson();

// M1c, S8: the branch of the defect. The artifact lives in the base of the run and never in the skill, the record keeps the
// digest of the bytes it was read from, and the two cases of the bank are the items the replay measures.
const ARTIFACT_FILE = "review.md";
const ARTIFACT_TEXT = "rebase with --squash-all to leave one commit\n";
const DEFECT_EXCERPT = "rebase with --squash-all";
const DEFECT_EVIDENCE_ID = "ev-7d1e2f44";
// The predicate of every case of the bank: one check, so a run that still does what the finding rejected fails it.
const DEFECT_CHECKS: readonly CaseCheck[] = [{ kind: "not-contains", value: "--squash-all" }];
const DEFECT_PROMPTS: readonly string[] = [
  "rebase the branch onto main",
  "rebase the branch onto main keeping both commits",
];

// The pair of hashes the record declares, from the same function the writer uses: the fixture is a candidate
// whose bytes and record agree, which is what the gate checks before it writes anything (and what one test
// breaks on purpose).
const HASHES = fixtureHashes();

function fixtureLesson(): string {
  const lesson = serializeLesson({
    slug: SLUG,
    title: TITLE,
    date: "2026-11-02",
    status: "accepted",
    sourceEvidence: [EVIDENCE[0].id],
    gate: LESSON_GATE_ACCEPTED,
    body: "Use pdfplumber with the lattice strategy so merged cells stay apart.",
  });
  if (!lesson.ok) throw new Error(`the fixture lesson is not a lesson file: ${lesson.error}`);
  return lesson.value;
}

function fixtureHashes(): { contentHash: string; bodyHash: string } {
  const hashes = lessonHashes(LESSON_TEXT);
  if (!hashes.ok) throw new Error(`the fixture lesson has no hashes: ${hashes.error}`);
  return hashes.value;
}

// The hashes of this suite are computed here and not with src/hash.ts: what the gate records has to agree with an
// independent computation of the same bytes.
function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
}

// One replay item of the diagnosis. Its failure signature is the digest of one evidence id, which is the rule
// src/diagnosis.ts applies and the reason the flow can pair an item with the excerpt it came from.
function replayItem(
  index: number,
  skills: readonly string[],
  evidence: EvidenceItem = EVIDENCE[index] ?? EVIDENCE[0],
): ReplayItem {
  return {
    prompt: `extract the merged-cell table of report ${index}.pdf`,
    cwd: "/work/reports",
    // The tool of the failure the item replays: every item of this suite watches `bash` except the one the
    // intrinsic-failure exclusion drops, which watches the `read` of a file that is not there.
    expectation: { class: "tool_error", version: 1, tool: evidence.toolName ?? TOOL },
    model: MODEL,
    skills: [...skills],
    failureSignature: sha256Digest(evidence.id),
  };
}

interface RecordOverrides {
  // The pair of hashes the record declares. The honest pair is the default; a test that wants a candidate whose
  // lesson moved since it was staged passes another one.
  contentHash?: string;
  bodyHash?: string;
  // How many replay items the diagnosis carries, which is what decides the plan.
  items?: number;
  // One item more, of the failure the gate cannot measure: a `read` of a file that is not there (OA7), appended
  // after the ones the count above declares.
  intrinsicItem?: boolean;
  // The skills the session of every item had (OA6).
  itemSkills?: readonly string[];
  // M1c, S8: the record of the branch of the defect -- one evidence item of the fourth class, with the artifact it was read
  // from, and one replay item per case of its bank. `artifactPath` is where that artifact is; the digest the evidence records
  // is the one of the bytes on disk when the candidate was staged.
  defect?: boolean;
  artifactPath?: string;
}

// The record writeStagingCandidate publishes next to the lesson: schema @1, the candidate the gate will rewrite
// and the diagnosis its index line names. It is a literal because nothing in this suite runs the propose flow --
// what is under test is the reading, the rewriting and the gating of a file that flow already wrote.
function decisionRecord(overrides: RecordOverrides = {}): DecisionRecord {
  if (overrides.defect === true) return defectRecord(overrides.artifactPath);

  const evidence = fixtureEvidence(overrides);
  const itemSkills = overrides.itemSkills ?? [SKILL_NAME];

  return {
    schema: "pi-simple-sri/decision@1",
    createdAt: "2026-11-02T14:03:22.481Z",
    trigger: { surface: "command", focus: "merged cells" },
    skill: {
      name: SKILL_NAME,
      dir: "/skills/pdf-tools",
      realDir: "/skills/pdf-tools",
      wasSymlink: false,
      eligible: true,
    },
    eligibility: { allow: [], deny: [] },
    evidence,
    diagnosis: {
      summary: "Table extraction loses merged cells",
      failureSignature: SIGNATURE,
      // One item per evidence entry, in the order the diagnosis measured them: the signature of each item is the
      // digest of the id of its entry, which is how the flow pairs the two back together (OA7).
      replayItems: evidence.map((item, index) => replayItem(index, itemSkills, item)),
    },
    candidate: {
      kind: "new-lesson",
      slug: SLUG,
      title: TITLE,
      targetLesson: null,
      lessonPath: `lessons/${SLUG}.md`,
      contentHash: overrides.contentHash ?? HASHES.contentHash,
      bodyHash: overrides.bodyHash ?? HASHES.bodyHash,
    },
    gate: {
      basis: "replay",
      status: "not-run",
      budget: { plannedRuns: 0, usedRuns: 0, interruptedAt: null },
      tokens: {
        proposal: { input: 412, output: 137 },
        incumbent: { input: 0, output: 0 },
        candidate: { input: 0, output: 0 },
        total: { input: 412, output: 137 },
      },
      preregistration: null,
      replay: null,
    },
    outcome: { status: "proposed", reason: null, decidedAt: null },
  };
}

// The evidence the record carries, in the order the diagnosis measured it: the count of the fixture and, when a
// test asks for it, the item the intrinsic-failure exclusion drops.
function fixtureEvidence(overrides: RecordOverrides): EvidenceItem[] {
  const count = overrides.items ?? 3;
  const evidence = EVIDENCE.slice(0, count).map((item) => ({ ...item }));

  if (overrides.intrinsicItem === true) evidence.push({ ...INTRINSIC_EVIDENCE });

  return evidence;
}

// The record of the branch of the defect (M1c, S8): one evidence item of the fourth class, with the artifact it was read
// from, and one replay item per case of its bank. The digest the evidence records is the one of the bytes on disk when the
// candidate was staged, which is what the gate re-verifies before it spends a run.
function defectRecord(artifactPath: string | undefined): DecisionRecord {
  if (artifactPath === undefined) throw new Error("the record of a defect needs the artifact it was read from");

  const evidence: EvidenceItem = {
    id: DEFECT_EVIDENCE_ID,
    kind: "quality_defect",
    timestamp: 1762082606625,
    source: "persisted",
    excerpt: DEFECT_EXCERPT,
    origin: { kind: "review-finding", path: artifactPath, contentHash: digestOf(ARTIFACT_TEXT) },
  };

  return {
    ...decisionRecord(),
    evidence: [evidence],
    diagnosis: {
      summary: "A review finding rejected the answer of the skill",
      // The signature of the one evidence item, which is the rule the flow pairs an item with its excerpt by.
      failureSignature: sha256Digest(evidence.id),
      replayItems: DEFECT_PROMPTS.map(
        (prompt): ReplayItem => ({
          prompt,
          cwd: "/work/reports",
          expectation: { class: "quality_defect", version: 1, checks: DEFECT_CHECKS },
          model: MODEL,
          skills: [SKILL_NAME],
          failureSignature: sha256Digest(evidence.id),
        }),
      ),
    },
  };
}

// A declared skill the way a user writes one: frontmatter, a body, and a script next to it. The `## Lessons`
// section is absent on purpose -- the overlay completes it in both arms, which is the case of the first lesson
// of a skill.
function skillFile(): string {
  return [
    "---",
    `name: ${SKILL_NAME}`,
    "description: Extract tables from PDFs",
    "---",
    "",
    `# ${SKILL_NAME}`,
    "",
    "Use the scripts in this directory.",
    "",
  ].join("\n");
}

interface FixtureOptions extends RecordOverrides {
  // A symlink inside the skill: the overlay refuses to copy it, so the gate abstains before spending a run.
  symlink?: boolean;
}

interface Fixture {
  base: string; // the write base of the run: <base>/staging holds the candidate
  candidateDir: string; // <base>/staging/<ts>/<skill>
  decisionPath: string;
  // M1c: the artifact a defect was read from. It lives in the base and never in the skill, and it is written only for the
  // record of that branch -- the one a test changes after the candidate was staged.
  artifactPath: string;
  skill: SkillRef; // the skill the candidate was written for, as the inventory resolves it
  skillFilePath: string; // <base>/skills/<skill>/SKILL.md
}

function createFixture(t: TestContext, options: FixtureOptions = {}): Fixture {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-gate-flow-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const skillDir = path.join(base, "skills", SKILL_NAME);
  fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  const skillFilePath = path.join(skillDir, SKILL_FILE);
  fs.writeFileSync(skillFilePath, skillFile(), "utf8");
  fs.writeFileSync(path.join(skillDir, "scripts", "extract.sh"), "#!/bin/sh\npdftotext \"$1\" -\n", "utf8");
  if (options.symlink === true) {
    fs.symlinkSync(SKILL_FILE, path.join(skillDir, "linked-skill.md"));
  }

  const skill: SkillRef = {
    name: SKILL_NAME,
    description: "Extract tables from PDFs",
    dir: skillDir,
    realDir: skillDir,
    hasLessons: false,
    kind: "declared",
  };

  const candidateDir = path.join(stagingDir(base), STAGING_TIMESTAMP, SKILL_NAME);
  const lessonsDir = path.join(candidateDir, LESSONS_DIR);
  fs.mkdirSync(lessonsDir, { recursive: true });
  fs.writeFileSync(path.join(lessonsDir, `${SLUG}.md`), LESSON_TEXT, "utf8");

  const artifactPath = path.join(base, ARTIFACT_FILE);
  if (options.defect === true) fs.writeFileSync(artifactPath, ARTIFACT_TEXT, "utf8");

  const decisionPath = path.join(candidateDir, DECISION_FILE);
  fs.writeFileSync(decisionPath, `${JSON.stringify(decisionRecord({ ...options, artifactPath }), null, 2)}\n`, "utf8");

  return { base, candidateDir, decisionPath, artifactPath, skill, skillFilePath };
}

// The record a successful resolution answers with, or the reason the test expected none.
function recordOf(result: StagedCandidateResult): DecisionRecord {
  if (!result.ok) assert.fail(`the candidate must resolve: ${result.error.reason} (${result.error.detail})`);
  return result.value;
}

function rejectionOf(result: StagedCandidateResult): CandidateRejection {
  if (result.ok) assert.fail("the candidate must be refused");
  return result.error;
}

// The same reading for the gate: a refused candidate is a failure of the test, because none of the assertions
// below is about the refusal.
function concluded(result: GateFlowResult): GateConcludedResult {
  if (result.kind === "refused") {
    assert.fail(`the candidate was refused: ${result.rejection.reason} (${result.rejection.detail})`);
  }
  return result;
}

// The concluded gate block of a record, or a failure naming the state the gate is in instead. It is the one
// narrowing the assertions below share: a record whose gate did not conclude has no `replay` to read.
//
// M1c: the block has six variants in two bases, and `status` alone no longer names one, because a gate of the case-bank
// base concludes with the same three statuses a replay does. The basis is checked first, which is what narrows this to
// the replay family and makes the return type below the compile error a variant this helper forgot would produce.
function concludedGate(record: DecisionRecord): GateConcluded {
  const gate = record.gate;
  if (gate.basis !== "replay") assert.fail(`the record of this suite holds a gate of the ${gate.basis} base`);
  if (gate.status !== "gate-accepted" && gate.status !== "gate-rejected" && gate.status !== "gate-abstained") {
    assert.fail(`the gate did not conclude: ${gate.status}`);
  }
  return gate;
}

function readRecord(decisionPath: string): DecisionRecord {
  return JSON.parse(fs.readFileSync(decisionPath, "utf8")) as DecisionRecord;
}

function attemptsPath(base: string): string {
  return path.join(stateDir(base), ATTEMPTS_FILE);
}

// The lines of state/attempts.jsonl, in the order they were appended. An index nobody wrote answers with no
// lines, which is what a gate that passes has to leave behind.
function readLines(base: string): AttemptLine[] {
  const indexPath = attemptsPath(base);
  if (!fs.existsSync(indexPath)) return [];

  return fs
    .readFileSync(indexPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AttemptLine);
}

// The clock the flow reads: one second per reading, so the preregistration of a run is older than every run that
// followed it, which is what makes "recorded before the first run" checkable.
function createClock(start: Date = CLOCK_START): () => Date {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(start.getTime() + tick * CLOCK_STEP_MS);
  };
}

// One completed run of the budget: the process answered, the skill loaded, and the tool of the item reported an
// error exactly when `toolFails`. The verdict of the run is the reading of the expectation, so the arm that
// fails is the one thing a test controls.
function completedRun(request: ReplayRunRequest, toolFails: boolean): ReplayRun {
  return {
    request,
    outcome: "pass",
    stopReason: "stop",
    toolCalls: [
      {
        toolName: TOOL,
        isError: toolFails,
        argsHash: sha256Digest(`${request.item}:${request.rep}:${request.arm}`),
      },
    ],
    usage: RUN_USAGE,
    durationMs: 5,
    exitCode: 0,
    skillLoaded: true,
    // M1c: the answer of the turn. The item of this fixture is a tool class, which is judged on its calls and never on
    // the text, so the value is empty and the record's own `checkFailures` stays absent.
    finalText: "",
    rawStream: `${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } })}\n`,
  };
}

// The shape of the budget that accepts: the incumbent reproduces its failure in every run and the candidate
// passes every one, which is the only difference the preregistered rule accepts.
function incumbentFails(request: ReplayRunRequest): ReplayRun {
  return completedRun(request, request.arm === "incumbent");
}

// What one run answers. The behaviour receives the request and returns the whole run, so a test writes a
// budget without a process, a provider or a token.
type RunBehaviour = (request: ReplayRunRequest) => ReplayRun;

interface HarnessOptions {
  behaviour?: RunBehaviour;
  listSkills?: (options: ListSkillsOptions) => Promise<SkillRef[]>;
}

interface Harness {
  deps: GateDeps;
  // Every run the flow asked for, with the moment the executor was entered: the timestamps the preregistration
  // is compared against.
  runs: { at: string; request: ReplayRunRequest }[];
}

function createHarness(options: HarnessOptions = {}): Harness {
  const clock = createClock();
  const behaviour = options.behaviour ?? incumbentFails;
  const runs: Harness["runs"] = [];

  const deps: GateDeps = {
    now: clock,
    // The seam the whole budget goes through: the gate resolves its executor here and a test answers every run
    // of the twelve without a child.
    runReplay: async (request) => {
      runs.push({ at: clock().toISOString(), request });
      return behaviour(request);
    },
    ...(options.listSkills === undefined ? {} : { listSkills: options.listSkills }),
  };

  return { deps, runs };
}

function gateRequest(fixture: Fixture): GateRequest {
  return {
    base: fixture.base,
    agentDir: path.join(fixture.base, "agent"),
    cwd: fixture.base,
    stagingPath: fixture.candidateDir,
    skill: fixture.skill,
  };
}

test("resolveStagedCandidate: a staged candidate answers the record it carries", async (t) => {
  const fixture = createFixture(t);

  const result = await resolveStagedCandidate(fixture.base, SKILL_NAME, fixture.candidateDir);

  assert.deepEqual(recordOf(result), decisionRecord());
});

// Every path this package publishes names a candidate relative to the base of the run, so a caller keeping
// one of those spellings is the ordinary case and not an error.
test("resolveStagedCandidate: the relative spelling of the candidate is the same candidate", async (t) => {
  const fixture = createFixture(t);
  const relative = path.relative(fixture.base, fixture.candidateDir);

  const result = await resolveStagedCandidate(fixture.base, SKILL_NAME, relative);

  assert.deepEqual(recordOf(result), decisionRecord());
});

// Guard 1: a stagingPath of the caller's choosing must not turn the gate into a reader of any decision.json
// on the machine. The file outside staging is deliberately unreadable JSON: the reason below proves the
// refusal happened before it was opened, not after.
test("resolveStagedCandidate: a path outside staging is refused before it is read", async (t) => {
  const fixture = createFixture(t);
  const outside = path.join(fixture.base, "elsewhere", SKILL_NAME);
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, DECISION_FILE), "not JSON at all", "utf8");

  const rejection = rejectionOf(await resolveStagedCandidate(fixture.base, SKILL_NAME, outside));

  assert.equal(rejection.reason, "outside-staging");
  assert.equal(rejection.detail.includes(stagingDir(fixture.base)), true);
});

// Guard 2: the candidate directory is named after the skill it belongs to, so a directory of another skill is
// not gated as this one.
test("resolveStagedCandidate: a candidate of another skill is refused", async (t) => {
  const fixture = createFixture(t);

  const rejection = rejectionOf(await resolveStagedCandidate(fixture.base, "other-skill", fixture.candidateDir));

  assert.equal(rejection.reason, "skill-mismatch");
  assert.equal(rejection.detail.includes(SKILL_NAME), true);
  assert.equal(rejection.detail.includes("other-skill"), true);
});

// Guard 3, first half: a candidate without its record describes nothing to gate.
test("resolveStagedCandidate: a candidate without decision.json is refused", async (t) => {
  const fixture = createFixture(t);
  fs.rmSync(fixture.decisionPath);

  const rejection = rejectionOf(await resolveStagedCandidate(fixture.base, SKILL_NAME, fixture.candidateDir));

  assert.equal(rejection.reason, "incomplete-candidate");
  assert.equal(rejection.detail.includes(DECISION_FILE), true);
});

// Guard 3, second half: a record with no lesson directory describes a candidate nobody can replay, and the
// overlay of it would fail one step later -- after the preregistration had already been written.
test("resolveStagedCandidate: a candidate without lessons/ is refused", async (t) => {
  const fixture = createFixture(t);
  fs.rmSync(path.join(fixture.candidateDir, LESSONS_DIR), { recursive: true, force: true });

  const rejection = rejectionOf(await resolveStagedCandidate(fixture.base, SKILL_NAME, fixture.candidateDir));

  assert.equal(rejection.reason, "incomplete-candidate");
  assert.equal(rejection.detail.includes(LESSONS_DIR), true);
});

test("resolveStagedCandidate: a decision.json that is not JSON is refused", async (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(fixture.decisionPath, "{\n", "utf8");

  const rejection = rejectionOf(await resolveStagedCandidate(fixture.base, SKILL_NAME, fixture.candidateDir));

  assert.equal(rejection.reason, "unreadable-record");
  assert.equal(rejection.detail.includes(DECISION_FILE), true);
});

// OA12: a candidate written by 0.0.1 is a decision@0, where the rule of the gate is a `predicate` and not an
// `expectation`. Without this guard the gate would rewrite it with the block of another version or fail
// halfway through its own sequence, so the record is refused as a version and nothing is written into it.
test("resolveStagedCandidate: a record of another schema is refused and left untouched", async (t) => {
  const fixture = createFixture(t);
  // The record of 0.0.1 as that version wrote it: the same envelope, a `predicate` where this version has an
  // `expectation`.
  const old = {
    ...decisionRecord(),
    schema: "pi-simple-sri/decision@0",
    predicate: { class: "tool_error", version: 1, tool: TOOL },
  };
  const before = `${JSON.stringify(old, null, 2)}\n`;
  fs.writeFileSync(fixture.decisionPath, before, "utf8");

  const rejection = rejectionOf(await resolveStagedCandidate(fixture.base, SKILL_NAME, fixture.candidateDir));

  assert.equal(rejection.reason, "unsupported-schema");
  assert.equal(rejection.detail.includes("pi-simple-sri/decision@0"), true);
  assert.equal(rejection.detail.includes("pi-simple-sri/decision@1"), true);
  // The record the gate could not read is exactly the record that was there.
  assert.equal(fs.readFileSync(fixture.decisionPath, "utf8"), before);
});

// ---------------------------------------------------------------------------------------------
// The gate over the candidate
// ---------------------------------------------------------------------------------------------

// Step 3 of the sequence, which is the one a record can be checked against: the threshold, the design and the
// floor are on disk before the first run, and the moment they were recorded is older than every run that
// followed. A rule recorded after the runs would be a rule chosen with the result in hand.
test("gateStagedCandidate: the preregistration is written before the first run", async (t) => {
  const fixture = createFixture(t);
  // The bytes of the SKILL.md the arms will be copied from: the hash the acceptance compares later is this one.
  const skillBefore = fs.readFileSync(fixture.skillFilePath, "utf8");
  // What every run saw on disk at the moment it was entered, which is the only place the order is observable.
  const gates: GateBlock[] = [];

  const harness = createHarness({
    behaviour: (request) => {
      gates.push(readRecord(fixture.decisionPath).gate);
      return incumbentFails(request);
    },
  });

  const result = concluded(await gateStagedCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-accepted");
  assert.equal(harness.runs.length, PLANNED_RUNS);
  assert.equal(gates.length, PLANNED_RUNS);

  for (const [index, gate] of gates.entries()) {
    assert.equal(gate.status, "preregistered");
    const preregistration = gate.preregistration;
    if (preregistration === null) assert.fail(`the run ${index} started without a preregistration`);

    assert.equal(preregistration.design.plannedRuns, PLANNED_RUNS);
    assert.equal(preregistration.design.reps, 2);
    assert.equal(preregistration.design.items, 3);
    assert.equal(preregistration.threshold.rule, "unanimous-and-strictly-better");
    assert.equal(preregistration.threshold.candidatePasses, RUNS_PER_ARM);
    assert.equal(preregistration.threshold.incumbentPassesMax, RUNS_PER_ARM - 1);
    assert.equal(preregistration.mde.runsPerArm, RUNS_PER_ARM);
    // M1c: the hash of the SKILL.md the arms were copied from is already in the preregistration when the runs start, and
    // it is the field neutral to the basis -- where the acceptance of either base reads it, instead of the result of one
    // basis, which is null in the record of the other.
    assert.equal(preregistration.skillContentHash, digestOf(skillBefore));
    // The one assertion this test exists for: the moment recorded for the rule is older than the run.
    assert.ok(
      Date.parse(preregistration.recordedAt) < Date.parse(harness.runs[index].at),
      `the preregistration of ${preregistration.recordedAt} is not older than the run at ${harness.runs[index].at}`,
    );
  }

  // The record it concluded with keeps the preregistration it was judged by, so one file carries both.
  const gate = concludedGate(readRecord(fixture.decisionPath));
  assert.equal(gate.preregistration.recordedAt, gates[0].preregistration?.recordedAt);
});

// A gate that passes is a state of decision.json and never an event of the index: the line of an accepted
// candidate is the `accepted` event the acceptance writes, and the gate neither writes it nor touches the skill.
test("gateStagedCandidate: an accepted gate rewrites the record and writes no line", async (t) => {
  const fixture = createFixture(t);
  const skillBefore = fs.readFileSync(fixture.skillFilePath, "utf8");
  const harness = createHarness();

  const result = concluded(await gateStagedCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-accepted");
  assert.equal(result.reason, null);
  assert.equal(result.plannedRuns, PLANNED_RUNS);
  assert.equal(result.usedRuns, PLANNED_RUNS);
  assert.equal(result.stagingPath, path.join("staging", STAGING_TIMESTAMP, SKILL_NAME));
  assert.equal(result.decisionPath, path.join("staging", STAGING_TIMESTAMP, SKILL_NAME, DECISION_FILE));
  assert.notEqual(result.overlays, null);

  const record = readRecord(fixture.decisionPath);
  // The record the gate leaves behind is a record of the schema, not only of the types.
  assert.deepEqual(validateAgainstSchema(record), []);

  const gate = concludedGate(record);
  assert.equal(gate.status, "gate-accepted");
  assert.equal(record.outcome.status, "gate-accepted");
  assert.equal(record.outcome.reason, null);
  assert.notEqual(record.outcome.decidedAt, null);

  // The two hashes of the overlay, each of the bytes its own name says: `skillContentHash` is the SKILL.md the
  // gate measured, computed here from the bytes the fixture wrote, and `manifestHash` is the digest of the
  // manifest of the two copies and therefore not it. Swapped, the record would hand the acceptance the hash of a
  // manifest as the preregistered hash of the skill (src/command-skill-improve.ts copies this field into
  // `expectedSkillContentHash`), and every acceptance of a real gate would be refused as drift.
  assert.equal(gate.replay.overlays.skillContentHash, digestOf(skillBefore));
  assert.notEqual(gate.replay.overlays.manifestHash, gate.replay.overlays.skillContentHash);
  // The same hash in the preregistration, which is the block the two bases share: the acceptance reads it from there and
  // not from the result of a basis.
  assert.equal(gate.preregistration.skillContentHash, gate.replay.overlays.skillContentHash);

  assert.equal(gate.replay.items.length, 3);
  for (const item of gate.replay.items) {
    assert.equal(item.reps.length, 4);
    assert.equal(item.reps.filter((run) => run.arm === "incumbent").length, 2);
    assert.equal(item.reps.filter((run) => run.arm === "candidate").length, 2);
    assert.equal(item.model, MODEL);
    // OA10: every run kept its stream under the candidate, where the record says it is.
    for (const run of item.reps) {
      const stream = run.stream;
      if (stream === undefined) assert.fail(`the run ${item.index}/${run.rep}/${run.arm} kept no stream`);
      assert.equal(stream.startsWith(path.join("staging", STAGING_TIMESTAMP, SKILL_NAME, "gate", "runs")), true);
      assert.equal(fs.existsSync(path.join(fixture.base, stream)), true);
    }
  }

  // §8, the order of the budget: item -> rep -> (incumbent, candidate), so the two arms of one pair are adjacent
  // in time and the arms of an item are the copy of the skill and the skill plus the lesson.
  assert.deepEqual(
    harness.runs.map((run) => `${run.request.item}:${run.request.rep}:${run.request.arm}`),
    [
      "0:1:incumbent",
      "0:1:candidate",
      "0:2:incumbent",
      "0:2:candidate",
      "1:1:incumbent",
      "1:1:candidate",
      "1:2:incumbent",
      "1:2:candidate",
      "2:1:incumbent",
      "2:1:candidate",
      "2:2:incumbent",
      "2:2:candidate",
    ],
  );

  // What one run is given: the prompt and the cwd of its item, the model of the failing turn (OA5), the cap of a
  // run, and the arm of the pair as the first directory the child loads (OA6).
  const [first] = harness.runs;
  assert.equal(first.request.prompt, replayItem(0, [SKILL_NAME]).prompt);
  assert.equal(first.request.cwd, "/work/reports");
  assert.equal(first.request.model, MODEL);
  assert.equal(first.request.timeoutMs, 180_000);
  assert.deepEqual(first.request.skillDirs, [path.join(fixture.candidateDir, "arms", "incumbent", SKILL_NAME)]);
  assert.deepEqual(harness.runs[1].request.skillDirs, [
    path.join(fixture.candidateDir, "arms", "candidate", SKILL_NAME),
  ]);

  assert.equal(gate.replay.arms.incumbent.passes, 0);
  assert.equal(gate.replay.arms.candidate.passes, RUNS_PER_ARM);
  assert.equal(gate.replay.regressions, 0);
  assert.deepEqual(gate.replay.arms.candidate.tokens, { input: 60, output: 12 });
  // Q6: the two arms and the proposal add up, and the total is recorded so nobody adds them again.
  assert.deepEqual(record.gate.tokens.incumbent, { input: 60, output: 12 });
  assert.deepEqual(record.gate.tokens.total, { input: 412 + 120, output: 137 + 24 });
  assert.deepEqual(gate.budget, { plannedRuns: PLANNED_RUNS, usedRuns: PLANNED_RUNS, interruptedAt: null });

  // No line of the index, and no byte written inside the skill: the acceptance is the slice that writes it.
  assert.equal(fs.existsSync(attemptsPath(fixture.base)), false);
  assert.equal(fs.readFileSync(fixture.skillFilePath, "utf8"), skillBefore);
});

// The other side of the rule: a candidate that misses one run of an arm is refused, and the refusal is the one
// event of the gate the index carries.
test("gateStagedCandidate: a rejected gate writes the line of the index", async (t) => {
  const fixture = createFixture(t);
  // The candidate passes the second repetition of every item and fails the first, so three of six.
  const harness = createHarness({
    behaviour: (request) => completedRun(request, request.arm === "incumbent" || request.rep === 1),
  });

  const result = concluded(await gateStagedCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-rejected");
  assert.equal(result.reason, "below-threshold");
  assert.equal(result.usedRuns, PLANNED_RUNS);

  const record = readRecord(fixture.decisionPath);
  assert.deepEqual(validateAgainstSchema(record), []);
  const gate = concludedGate(record);
  assert.equal(gate.status, "gate-rejected");
  assert.equal(gate.replay.reason, "below-threshold");
  assert.equal(gate.replay.arms.candidate.passes, 3);

  const lines = readLines(fixture.base);
  assert.equal(lines.length, 1);
  // OA4: the line says which failure it is about, and it is the one the diagnosis declares.
  assert.equal(lines[0].failureSignature, record.diagnosis.failureSignature);
  assert.equal(lines[0].event, "gate-rejected");
  assert.equal(lines[0].targetSkill, SKILL_NAME);
  // The pair of the record, so the lines of one candidate group on candidateHash.
  assert.equal(lines[0].candidateHash, record.candidate.contentHash);
  assert.equal(lines[0].bodyHash, record.candidate.bodyHash);
  assert.equal(lines[0].stagingPath, path.join("staging", STAGING_TIMESTAMP, SKILL_NAME));
  assert.equal(lines[0].decisionPath, path.join("staging", STAGING_TIMESTAMP, SKILL_NAME, DECISION_FILE));
});

// OA9: an interruption stops the budget before the next child, keeps the run that was in flight with its partial
// stream, and abstains instead of reading a short budget as a verdict.
test("gateStagedCandidate: an interrupted gate keeps the partial run and abstains", async (t) => {
  const fixture = createFixture(t);
  const controller = new AbortController();
  const partial = `${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } })}\n`;

  const harness = createHarness({
    behaviour: (request) => {
      // The caller gives up while the first run is in flight.
      controller.abort();
      return {
        ...completedRun(request, true),
        outcome: "invalid",
        invalidReason: "interrupted",
        exitCode: null,
        rawStream: partial,
      };
    },
  });

  const result = concluded(
    await gateStagedCandidate({ ...gateRequest(fixture), signal: controller.signal }, harness.deps),
  );

  assert.equal(result.kind, "gate-abstained");
  assert.equal(result.reason, "interrupted");
  assert.equal(result.usedRuns, 1);
  // One run was in flight and the eleven of the rest were never started.
  assert.equal(harness.runs.length, 1);

  const record = readRecord(fixture.decisionPath);
  assert.deepEqual(validateAgainstSchema(record), []);
  const gate = concludedGate(record);
  assert.equal(gate.status, "gate-abstained");
  assert.equal(gate.replay.reason, "interrupted");
  assert.equal(gate.budget.usedRuns, 1);
  assert.equal(typeof gate.budget.interruptedAt, "number");

  // What the interruption kept: the partial run, its verdict and the bytes it wrote.
  const [item] = gate.replay.items;
  assert.equal(item.reps.length, 1);
  assert.equal(item.reps[0].outcome, "invalid");
  assert.equal(item.reps[0].invalidReason, "interrupted");
  const stream = item.reps[0].stream;
  if (stream === undefined) assert.fail("the partial run kept no stream");
  assert.equal(fs.readFileSync(path.join(fixture.base, stream), "utf8"), partial);
  assert.equal(readLines(fixture.base)[0].event, "gate-abstained");
});

// OA3: a run nobody can read abstains the whole gate, so the rest of the budget is not spent on a comparison the
// scorer has already refused.
test("gateStagedCandidate: a broken run abstains without spending the rest of the budget", async (t) => {
  const fixture = createFixture(t);

  const harness = createHarness({
    behaviour: (request) => ({
      ...completedRun(request, true),
      outcome: "invalid",
      invalidReason: "cwd-missing",
      // M2: what the process said about a run that never started, which the record keeps.
      invalidDetail: "spawn pi ENOENT",
      exitCode: null,
      rawStream: "",
    }),
  });

  const result = concluded(await gateStagedCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-abstained");
  assert.equal(result.reason, "invalid-run");
  assert.equal(result.usedRuns, 1);
  assert.equal(harness.runs.length, 1);

  const gate = concludedGate(readRecord(fixture.decisionPath));
  assert.equal(gate.replay.reason, "invalid-run");
  assert.equal(gate.budget.usedRuns, 1);
  assert.equal(gate.budget.interruptedAt, null);
  // A run that wrote nothing points at no stream.
  assert.equal(gate.replay.items[0].reps[0].stream, undefined);
  // M2: and the cause of the run it could not read is on the record instead of thrown away with the process.
  assert.equal(gate.replay.items[0].reps[0].invalidDetail, "spawn pi ENOENT");
});

// OA10, fail-closed: a run whose stream the cap cut lost bytes, so it proved nothing about the skill and the
// gate abstains instead of counting a prefix that reads green. The record keeps the reason and how long the
// stream was before it was cut, which is what makes the loss explainable after the fact.
test("gateStagedCandidate: a truncated run is invalid and the record says how much was lost", async (t) => {
  const fixture = createFixture(t);
  // The runner is the one that cuts the stream; what this test drives is the flow, so the run reports the length
  // the cap produced and the bytes it was allowed to keep.
  const truncatedAt = 3 * 1024 * 1024 + 17;

  const harness = createHarness({
    behaviour: (request) => ({
      ...completedRun(request, false),
      outcome: "invalid",
      invalidReason: "stream-truncated",
      truncatedAt,
    }),
  });

  const result = concluded(await gateStagedCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-abstained");
  assert.equal(result.reason, "invalid-run");
  assert.equal(result.usedRuns, 1);
  assert.equal(harness.runs.length, 1);

  const record = readRecord(fixture.decisionPath);
  // The two fields the run gained are additive, so the record of a truncated run is a record of the schema.
  assert.deepEqual(validateAgainstSchema(record), []);
  const gate = concludedGate(record);
  assert.equal(gate.budget.usedRuns, 1);

  const [run] = gate.replay.items[0].reps;
  assert.equal(run.outcome, "invalid");
  assert.equal(run.invalidReason, "stream-truncated");
  assert.equal(run.truncatedAt, truncatedAt);
  // The bytes it did write are still on disk: the prefix is the audit trail of a run whose tail is gone.
  assert.equal(typeof run.stream, "string");
});

// The overlay is the fourth step and the last one before a run: a skill it cannot copy abstains the gate with the
// rule already recorded, so the record says the gate is preregistered and the index says it answered nothing.
test("gateStagedCandidate: a skill the overlay cannot copy abstains before the first run", async (t) => {
  const fixture = createFixture(t, { symlink: true });
  const harness = createHarness();

  const result = concluded(await gateStagedCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-abstained");
  assert.equal(result.reason, "overlay-failed");
  assert.equal(result.usedRuns, 0);
  assert.equal(result.overlays, null);
  assert.equal(harness.runs.length, 0);

  const record = readRecord(fixture.decisionPath);
  assert.equal(record.gate.status, "preregistered");
  const lines = readLines(fixture.base);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "gate-abstained");
  assert.equal(lines[0].failureSignature, SIGNATURE);
  // M4: the detail the overlay computed -- the file it could not copy, with its path -- is not dropped. The line
  // of the index names it after the reason, and the answer carries the same text.
  const reason = lines[0].reason;
  if (reason === undefined) assert.fail("the abstention of the overlay kept no reason in the index");
  assert.equal(reason.startsWith("overlay-failed: "), true);
  assert.equal(reason.includes("linked-skill.md"), true);
  const detail = result.detail;
  if (detail === undefined) assert.fail("the abstention of the overlay answered without a detail");
  assert.equal(reason, `overlay-failed: ${detail}`);
});

// Step 2: the candidate is the bytes its record declares, and a lesson that moved since it was staged is the one
// abstention that writes nothing at all -- the rewrite would refuse it, and neither the record nor the index may
// describe a candidate whose bytes disagree with their own record.
test("gateStagedCandidate: a lesson that no longer matches the record abstains and writes nothing", async (t) => {
  const fixture = createFixture(t, { contentHash: `sha256:${"a".repeat(64)}` });
  const before = fs.readFileSync(fixture.decisionPath, "utf8");
  const harness = createHarness();

  const result = concluded(await gateStagedCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-abstained");
  assert.equal(result.reason, "candidate-mismatch");
  assert.equal(result.usedRuns, 0);
  assert.equal(harness.runs.length, 0);

  assert.equal(fs.readFileSync(fixture.decisionPath, "utf8"), before);
  assert.equal(fs.existsSync(attemptsPath(fixture.base)), false);
  // M4: this is the one abstention that writes no line, so the detail of the bytes that moved lives in the
  // answer and nowhere else -- which is where a reader of the run finds it.
  const detail = result.detail;
  if (detail === undefined) assert.fail("the mismatch answered without the detail of the lesson");
  assert.equal(detail.includes(`${SLUG}.md`), true);
});

// OA6 in the positive: a run loads the arm's copy of the skill first and then the real directories of the rest of
// the set the session had, which is the set the failure was measured in.
test("gateStagedCandidate: a run loads the arm first and then the rest of the session's skills", async (t) => {
  const fixture = createFixture(t, { itemSkills: [SKILL_NAME, OTHER_SKILL] });
  const other: SkillRef = {
    ...fixture.skill,
    name: OTHER_SKILL,
    dir: path.join(fixture.base, "skills", OTHER_SKILL),
    realDir: path.join(fixture.base, "skills", OTHER_SKILL),
  };
  const harness = createHarness({ listSkills: async () => [fixture.skill, other] });

  const result = concluded(await gateStagedCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-accepted");
  const [first] = harness.runs;
  assert.deepEqual(first.request.skillDirs, [
    path.join(fixture.candidateDir, "arms", "incumbent", SKILL_NAME),
    other.realDir,
  ]);
});

// OA6: a replay loads the set of skills the session had. One of them missing is an abstention before the first
// run, because the same item replayed with a smaller set is a different task.
test("gateStagedCandidate: an item whose skill no longer resolves abstains without a run", async (t) => {
  const fixture = createFixture(t, { itemSkills: [SKILL_NAME, OTHER_SKILL] });
  // The inventory holds the skill under test and nothing else.
  const harness = createHarness({ listSkills: async () => [fixture.skill] });

  const result = concluded(await gateStagedCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-abstained");
  assert.equal(result.reason, "skill-unavailable");
  assert.equal(result.usedRuns, 0);
  assert.equal(harness.runs.length, 0);

  // Nothing was spent and nothing was rewritten: the gate has not run, and the index says the attempt abstained.
  assert.equal(readRecord(fixture.decisionPath).gate.status, "not-run");
  const lines = readLines(fixture.base);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "gate-abstained");
  assert.equal(lines[0].failureSignature, SIGNATURE);
  // M4: the skill that no longer resolves is named in the line of the index and in the answer.
  const reason = lines[0].reason;
  if (reason === undefined) assert.fail("the abstention kept no reason in the index");
  assert.equal(reason.startsWith("skill-unavailable: "), true);
  assert.equal(reason.includes(OTHER_SKILL), true);
  const detail = result.detail;
  if (detail === undefined) assert.fail("the abstention answered without a detail");
  assert.equal(reason, `skill-unavailable: ${detail}`);
});

// §8: fewer than two eligible items is not a smaller gate, it is a gate that cannot measure, so it answers before
// spending anything and still leaves the event of the abstention in the index.
test("gateStagedCandidate: fewer than two items abstains with zero runs", async (t) => {
  const fixture = createFixture(t, { items: 1 });
  const harness = createHarness();

  const result = concluded(await gateStagedCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-abstained");
  assert.equal(result.reason, "insufficient-items");
  assert.equal(result.plannedRuns, 0);
  assert.equal(result.usedRuns, 0);
  assert.equal(harness.runs.length, 0);

  const record = readRecord(fixture.decisionPath);
  assert.equal(record.gate.status, "not-run");
  assert.equal(readLines(fixture.base)[0].event, "gate-abstained");
  // M4: the line names the reason even when there is no detail to append, so the index alone says why the gate
  // answered nothing.
  assert.equal(readLines(fixture.base)[0].reason, "insufficient-items");
});

// OA7, end to end: the item whose failure is intrinsic to the task is dropped before the plan, and the pairing
// that drops it is the excerpt of the evidence its signature names. Two of the three items are left, so the plan
// is the eight runs of a two-item design and the record says which item did not run.
test("gateStagedCandidate: an item whose failure is intrinsic is excluded before the plan", async (t) => {
  const fixture = createFixture(t, { items: 2, intrinsicItem: true });
  const harness = createHarness();

  const result = concluded(await gateStagedCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-accepted");
  assert.equal(result.reason, null);
  assert.equal(result.plannedRuns, 8);
  assert.equal(result.usedRuns, 8);
  assert.equal(harness.runs.length, 8);

  // The order of §8 over the two items that were eligible: item -> rep -> (incumbent, candidate).
  assert.deepEqual(
    harness.runs.map((run) => `${run.request.item}:${run.request.rep}:${run.request.arm}`),
    [
      "0:1:incumbent",
      "0:1:candidate",
      "0:2:incumbent",
      "0:2:candidate",
      "1:1:incumbent",
      "1:1:candidate",
      "1:2:incumbent",
      "1:2:candidate",
    ],
  );

  const gate = concludedGate(readRecord(fixture.decisionPath));
  assert.equal(gate.preregistration.design.items, 2);
  assert.equal(gate.preregistration.design.plannedRuns, 8);
  assert.equal(gate.preregistration.threshold.candidatePasses, 4);
  assert.deepEqual(gate.budget, { plannedRuns: 8, usedRuns: 8, interruptedAt: null });

  // The item that did not run is the one of the `read`, named by the failure of its own evidence. The exclusion
  // happened because the excerpt paired with that signature carries the marker an intrinsic failure carries, so
  // the item never took a slot of the plan and never spent a run.
  assert.deepEqual(gate.replay.excluded, [
    { failureSignature: sha256Digest(INTRINSIC_EVIDENCE.id), reason: "intrinsic-failure" },
  ]);
  assert.deepEqual(
    gate.replay.items.map((item) => item.failureSignature),
    [sha256Digest(EVIDENCE[0].id), sha256Digest(EVIDENCE[1].id)],
  );
});

// OA12, on the gate itself: a candidate of another version is refused before anything is read from it, so the
// record is exactly the record that was there and no run was spent.
test("gateStagedCandidate: a decision@0 candidate is refused before it is read", async (t) => {
  const fixture = createFixture(t);
  const old = {
    ...decisionRecord(),
    schema: "pi-simple-sri/decision@0",
    predicate: { class: "tool_error", version: 1, tool: TOOL },
  };
  const before = `${JSON.stringify(old, null, 2)}\n`;
  fs.writeFileSync(fixture.decisionPath, before, "utf8");
  const harness = createHarness();

  const result = await gateStagedCandidate(gateRequest(fixture), harness.deps);

  if (result.kind !== "refused") assert.fail(`the candidate must be refused, the gate answered ${result.kind}`);
  assert.equal(result.rejection.reason, "unsupported-schema");
  assert.equal(harness.runs.length, 0);
  assert.equal(fs.readFileSync(fixture.decisionPath, "utf8"), before);
  assert.equal(fs.existsSync(attemptsPath(fixture.base)), false);
});

// M1c, S8: the branch of the defect does not add a base to the gate. The record carries items of the fourth class and the
// gate spends the paired budget of M1 over them -- the same design, the same rule, the same order -- and the exclusion of
// OA7 drops nothing: it needs a tool name, and the class carries none, so the cases the user wrote all run.
test("gateStagedCandidate: a record of the defect branch is gated by the same budget", async (t) => {
  const fixture = createFixture(t, { defect: true });
  // The answer each arm gives: the incumbent still does what the finding rejected and the candidate answers what the check
  // asks for. The fourth class is judged on the text of the turn and on nothing else.
  const harness = createHarness({
    behaviour: (request) => ({
      ...completedRun(request, false),
      finalText: request.arm === "incumbent" ? "rebase with --squash-all" : "rebase with --interactive",
    }),
  });

  const result = concluded(await gateStagedCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-accepted");
  // Two cases of the bank, two repetitions of each, in two arms.
  assert.equal(result.plannedRuns, 8);
  assert.equal(result.usedRuns, 8);
  assert.equal(harness.runs.length, 8);

  const record = readRecord(fixture.decisionPath);
  assert.deepEqual(validateAgainstSchema(record), []);
  const gate = concludedGate(record);
  assert.equal(gate.status, "gate-accepted");
  // The items are the cases of the bank, and the record says which predicate each run was judged by.
  assert.deepEqual(
    gate.replay.items.map((item) => item.expectation.class),
    ["quality_defect", "quality_defect"],
  );
  assert.deepEqual(
    gate.replay.items.map((item) => item.expectation.checks),
    [DEFECT_CHECKS, DEFECT_CHECKS],
  );
  // The exclusion by intrinsic failure needs the name of a tool and this class has none: nothing of the diagnosis was dropped.
  assert.deepEqual(gate.replay.excluded, []);
  assert.equal(gate.replay.arms.candidate.passes, 4);
  assert.equal(gate.replay.arms.incumbent.passes, 0);
  // The order of the budget is the one of M1: item -> rep -> (incumbent, candidate).
  assert.deepEqual(
    harness.runs.map((run) => `${run.request.item}:${run.request.rep}:${run.request.arm}`),
    [
      "0:1:incumbent",
      "0:1:candidate",
      "0:2:incumbent",
      "0:2:candidate",
      "1:1:incumbent",
      "1:1:candidate",
      "1:2:incumbent",
      "1:2:candidate",
    ],
  );
});

// M1c, S8: the one guard the branch adds. The record keeps the digest of the bytes the artifact had when the candidate was
// staged, and a file that moved since then describes a failure nobody measured, so the gate abstains before the plan, spends
// no run and writes nothing inside the skill.
test("gateStagedCandidate: an artifact that moved since the proposal abstains with zero runs", async (t) => {
  const fixture = createFixture(t, { defect: true });
  const skillBefore = fs.readFileSync(fixture.skillFilePath, "utf8");
  const decisionBefore = fs.readFileSync(fixture.decisionPath, "utf8");
  // The finding was edited after the candidate was staged: the bytes are no longer the ones the evidence records.
  fs.writeFileSync(fixture.artifactPath, "rebase with --interactive\n", "utf8");
  const harness = createHarness();

  const result = concluded(await gateStagedCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-abstained");
  assert.equal(result.reason, "origin-moved");
  assert.equal(result.plannedRuns, 0);
  assert.equal(result.usedRuns, 0);
  assert.equal(result.overlays, null);
  assert.equal(harness.runs.length, 0);

  // Nothing inside the skill and nothing in the record: a gate that refused before the plan leaves the state it found.
  assert.equal(fs.readFileSync(fixture.skillFilePath, "utf8"), skillBefore);
  assert.equal(fs.readFileSync(fixture.decisionPath, "utf8"), decisionBefore);

  // The line of the index says what moved, after the reason every reader groups on.
  const lines = readLines(fixture.base);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "gate-abstained");
  assert.equal(lines[0].failureSignature, sha256Digest(DEFECT_EVIDENCE_ID));
  const reason = lines[0].reason;
  if (reason === undefined) assert.fail("the abstention of the artifact kept no reason in the index");
  assert.equal(reason.startsWith("origin-moved: "), true);
  assert.equal(reason.includes(fixture.artifactPath), true);
  const detail = result.detail;
  if (detail === undefined) assert.fail("the abstention answered without a detail");
  assert.equal(reason, `origin-moved: ${detail}`);
});

// The other half of the same guard: an artifact that was deleted is not the bytes the evidence read either, and the detail
// says that it could not be read instead of claiming a digest nobody computed.
test("gateStagedCandidate: an artifact that is gone abstains as moved", async (t) => {
  const fixture = createFixture(t, { defect: true });
  fs.rmSync(fixture.artifactPath);
  const harness = createHarness();

  const result = concluded(await gateStagedCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-abstained");
  assert.equal(result.reason, "origin-moved");
  assert.equal(harness.runs.length, 0);
  const detail = result.detail;
  if (detail === undefined) assert.fail("the abstention answered without a detail");
  assert.equal(detail.includes(fixture.artifactPath), true);
  assert.equal(detail.includes("ENOENT"), true);
});

// M1c: the record says which base would measure the candidate, and this flow reads a record of the replay base. A candidate of
// the case-bank base carries the cases of its bank and not a replay item of the diagnosis, so a gate over it would plan from a
// `diagnosis.replayItems` the bank base never filled, abstain `insufficient-items` and leave a line about a gate that measured
// nothing. It is refused instead: no run, no line, and the record exactly as it was.
test("gateStagedCandidate: a record of the case-bank base is refused as another base", async (t) => {
  const fixture = createFixture(t);
  const record = decisionRecord();
  // The block of a bank that was proposed and not gated yet: the base of the other flow, in the state that makes this refusal
  // the only one it could answer -- the status is the one a record of this base starts in.
  const before = `${JSON.stringify(
    {
      ...record,
      gate: {
        basis: "case-bank",
        status: "not-run",
        budget: { plannedRuns: 0, usedRuns: 0, interruptedAt: null },
        tokens: record.gate.tokens,
        preregistration: null,
        replay: null,
        caseBank: null,
      },
    },
    null,
    2,
  )}\n`;
  fs.writeFileSync(fixture.decisionPath, before, "utf8");
  const harness = createHarness();

  const result = await gateStagedCandidate(gateRequest(fixture), harness.deps);

  if (result.kind !== "refused") assert.fail(`the candidate must be refused, the gate answered ${result.kind}`);
  assert.equal(result.rejection.reason, "basis-mismatch");
  assert.equal(result.rejection.detail.includes("case-bank"), true);
  assert.equal(result.rejection.detail.includes("replay"), true);
  assert.equal(harness.runs.length, 0);
  assert.equal(fs.readFileSync(fixture.decisionPath, "utf8"), before);
  assert.deepEqual(readLines(fixture.base), []);
});

// The other guard of the base: a candidate the gate already answered is not gated twice. The verdict of the first run is the
// one a reader may already have acted on, so the second call is refused instead of preregistering a rule over it again -- and
// neither a run nor a line of the index comes out of the refusal.
test("gateStagedCandidate: a candidate whose gate already answered is refused", async (t) => {
  const fixture = createFixture(t);
  const first = createHarness();

  const accepted = concluded(await gateStagedCandidate(gateRequest(fixture), first.deps));
  assert.equal(accepted.kind, "gate-accepted");
  assert.equal(first.runs.length, PLANNED_RUNS);
  assert.equal(readRecord(fixture.decisionPath).gate.status, "gate-accepted");
  // An accepted gate is a state of the record and no event of the index, so the emptiness below is the one the second call has
  // to leave alone.
  assert.deepEqual(readLines(fixture.base), []);
  const before = fs.readFileSync(fixture.decisionPath, "utf8");

  const second = createHarness();
  const result = await gateStagedCandidate(gateRequest(fixture), second.deps);

  if (result.kind !== "refused") assert.fail(`the candidate must be refused, the gate answered ${result.kind}`);
  assert.equal(result.rejection.reason, "already-concluded");
  assert.equal(result.rejection.detail.includes("gate-accepted"), true);
  assert.equal(second.runs.length, 0);
  // The verdict is the one of the first run: the record is not rewritten and the index gained nothing.
  assert.equal(fs.readFileSync(fixture.decisionPath, "utf8"), before);
  assert.deepEqual(readLines(fixture.base), []);
});
