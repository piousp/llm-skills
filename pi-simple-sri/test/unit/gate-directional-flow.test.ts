import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CASE_BANK_FORMAT, type CaseBankCase } from "../../src/case-bank.ts";
import {
  gateDirectionalCandidate,
  type DirectionalGateDeps,
  type DirectionalGateRequest,
  type DirectionalGateResult,
  type DirectionalJudgeFn,
  type JudgeAnswer,
  type JudgeFailure,
} from "../../src/gate/directional-flow.ts";
import type { GateConcludedResult } from "../../src/gate/flow.ts";
import type { JudgeRequest } from "../../src/gate/judge.ts";
import type { ReplayRun, ReplayRunRequest } from "../../src/gate/types.ts";
import { sha256Digest } from "../../src/hash.ts";
import { serializeLesson } from "../../src/lesson-frontmatter.ts";
import { ATTEMPTS_FILE, CASE_BANK_FILE, DECISION_FILE, LESSONS_DIR, SKILL_FILE } from "../../src/names.ts";
import type {
  AttemptLine,
  DecisionRecord,
  GateBlock,
  GateCaseBankConcluded,
  GatePreregistration,
  GateTokens,
  Result,
  SkillRef,
} from "../../src/types.ts";
import { stateDir, stagingDir } from "../../src/write-base.ts";
import { lessonHashes } from "../../src/writer.ts";
import { validateAgainstSchema } from "./schema-reader.ts";

// The directional gate (M1c, S9): a bank of cases the user wrote, the preregistration of the bank and of the rule before the
// first run, the paired budget of the replay base spent over the cases, the mechanical rule as a necessary condition and the
// preregistered judge as the second one.
//
// Everything runs on a skill, a bank and a staging tree built in mkdtemp: no test names a real skill, nothing outside the
// temporary directory is read or written, and neither seam reaches a process or a provider. `runReplay` answers every run of
// the eight the design plans, and `judge` answers the calls the second condition asks for, so the cost of the suite is zero
// tokens and the verdict of every case is what the test says.

const SKILL_NAME = "git-helpers";
const SLUG = "name-the-flag-that-does-not-exist";
const TITLE = "Name only the flags git rebase has";
// OA5: the model of the session, in the spelling a replay and the judge pin.
const MODEL = "anthropic/claude-sonnet-4-5";
// The failure signature of the attempt: a directional run has no failing turn, so its diagnosis signs the ask.
const SIGNATURE = `sha256:${"c".repeat(64)}`;
const STAGING_TIMESTAMP = "20261105T031244Z";
const BANK_FILE = "cases.json";
// The clock of the harness starts here and advances one second per reading, so every moment of a run is distinct and ordered.
const CLOCK_START = new Date("2026-11-05T03:20:00.000Z");
const CLOCK_STEP_MS = 1000;
// What one run of the budget and one call to the judge cost, small enough to add up in an assertion.
const RUN_USAGE: GateTokens = { input: 10, output: 2 };
const JUDGE_USAGE: GateTokens = { input: 30, output: 5 };
// The case whose reply nobody can read, and the cause the seam reports for it: the two facts the abstention of the second
// condition has to name, next to the cost of the call that produced that reply.
const UNREADABLE_CASE = "no-squash-all";
const CAUSE = "the provider answered 500";
// The tokens the generation that produced the candidate already spent, as the record arrived with them.
const PROPOSAL_TOKENS: GateTokens = { input: 412, output: 137 };
// The design of §8 over two cases: two repetitions of each case in two arms.
const PLANNED_RUNS = 8;
const RUNS_PER_ARM = 4;
// One case is replayed in two repetitions and two arms, so it carries four runs in the record.
const RUNS_PER_CASE = 4;

const RUBRIC = "PASS when the answer names `git rebase --onto` and no flag that git rebase does not have.";

// The two cases of the bank. The first is a `regex` that a correct answer opens with; the second is the `not-contains` that
// closes the vacuous pass of the fourth class -- an answer that still recommends the flag the case rejects fails it, and an
// answer with no text at all fails it too (src/gate/expectation.ts).
const CASES: readonly CaseBankCase[] = [
  {
    id: "onto-needs-a-base",
    prompt: "How do I move a branch onto another commit?",
    checks: [{ kind: "regex", pattern: "^git rebase --onto" }],
  },
  {
    id: "no-squash-all",
    prompt: "Which flags does `git rebase` accept?",
    checks: [{ kind: "not-contains", value: "--squash-all" }],
  },
];

// What each arm answers to each case. The candidate answers both correctly; the incumbent is the skill as it stands, so it
// knows how to move a branch and still recommends the flag the second case rejects: two runs of four.
const CANDIDATE_ANSWERS: readonly string[] = ["git rebase --onto main topic", "git rebase --interactive"];
const INCUMBENT_ANSWERS: readonly string[] = ["git rebase --onto main topic", "git rebase --squash-all to fold it"];

const SKILL_TEXT = ["---", `name: ${SKILL_NAME}`, "description: Questions about rebasing a branch", "---", "", `# ${SKILL_NAME}`, "", "Answer from the scripts in this directory.", ""].join("\n");

// The candidate lesson, in the format src/lesson-frontmatter.ts owns: src/writer.ts reads the staged bytes back with the
// parser of that module before it lets a record be replaced, so the fixture is built by the writer of the format.
const LESSON_TEXT = fixtureLesson();

// The pair of hashes the record declares, from the same function the writer uses.
const HASHES = fixtureHashes();

// What the record of a preregistered gate of this base carries, for the one test that gates a candidate twice. It is a
// literal because nothing in this suite runs the propose flow: what is under test is the refusal of a record another run
// already answered.
const PREREGISTRATION: GatePreregistration = {
  recordedAt: "2026-11-05T03:15:00.000Z",
  threshold: {
    rule: "unanimous-and-strictly-better",
    candidatePasses: RUNS_PER_ARM,
    incumbentPassesMax: RUNS_PER_ARM - 1,
    version: 1,
    judge: { required: "pass", rubricHash: sha256Digest(RUBRIC) },
  },
  design: { reps: 2, items: 2, plannedRuns: PLANNED_RUNS, arms: ["incumbent", "candidate"] },
  mde: { basis: "case-bank", runsPerArm: RUNS_PER_ARM, resolution: 1 / RUNS_PER_ARM, requiredDifference: 1 },
  skillContentHash: digestOf(SKILL_TEXT),
  caseBank: {
    path: "/work/cases.json",
    contentHash: sha256Digest(CASE_BANK_FORMAT),
    copy: path.join("staging", STAGING_TIMESTAMP, SKILL_NAME, CASE_BANK_FILE),
    cases: 2,
    rubricHash: sha256Digest(RUBRIC),
  },
};

function fixtureLesson(): string {
  const lesson = serializeLesson({
    slug: SLUG,
    title: TITLE,
    date: "2026-11-05",
    status: "proposed",
    sourceEvidence: ["ev-00000000"],
    gate: "pending",
    body: "Only `git rebase --onto` with a base; the flag `--squash-all` does not exist.",
  });
  if (!lesson.ok) throw new Error(`the fixture lesson is not a lesson file: ${lesson.error}`);
  return lesson.value;
}

function fixtureHashes(): { contentHash: string; bodyHash: string } {
  const hashes = lessonHashes(LESSON_TEXT);
  if (!hashes.ok) throw new Error(`the fixture lesson has no hashes: ${hashes.error}`);
  return hashes.value;
}

// The hashes of this suite are computed here and not with src/hash.ts: what the gate records has to agree with an independent
// computation of the same bytes.
function digestOf(text: string | Buffer): string {
  return `sha256:${createHash("sha256").update(Buffer.from(text)).digest("hex")}`;
}

type BankKind = "rubric" | "no-rubric" | "one-case" | "broken" | "absent";

interface FixtureOptions {
  // What the bank of the run is. `absent` writes no file at all, which is the state of an attempt that has no base yet.
  bank?: BankKind;
  // The base the record announces: a gate over a bank reads only its own, and a record of the other is refused.
  basis?: "replay" | "case-bank";
  // The status of the gate of the record: a candidate is gated once.
  status?: "not-run" | "preregistered";
}

interface Fixture {
  base: string; // the write base of the run: <base>/staging holds the candidate and <base>/state the index
  candidateDir: string; // <base>/staging/<ts>/<skill>
  decisionPath: string;
  bankPath: string; // <base>/cases.json, the file the user wrote
  skill: SkillRef; // the skill the candidate was written for, as the inventory resolves it
  skillFilePath: string; // <base>/skills/<skill>/SKILL.md
}

function createFixture(t: TestContext, options: FixtureOptions = {}): Fixture {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-gate-directional-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const skillDir = path.join(base, "skills", SKILL_NAME);
  fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  const skillFilePath = path.join(skillDir, SKILL_FILE);
  fs.writeFileSync(skillFilePath, SKILL_TEXT, "utf8");
  fs.writeFileSync(path.join(skillDir, "scripts", "rebase.sh"), "#!/bin/sh\ngit rebase --onto \"$1\" HEAD\n", "utf8");

  const skill: SkillRef = {
    name: SKILL_NAME,
    description: "Questions about rebasing a branch",
    dir: skillDir,
    realDir: skillDir,
    hasLessons: false,
    kind: "declared",
  };

  const candidateDir = path.join(stagingDir(base), STAGING_TIMESTAMP, SKILL_NAME);
  const lessonsDir = path.join(candidateDir, LESSONS_DIR);
  fs.mkdirSync(lessonsDir, { recursive: true });
  fs.writeFileSync(path.join(lessonsDir, `${SLUG}.md`), LESSON_TEXT, "utf8");

  const bankPath = path.join(base, BANK_FILE);
  writeBank(bankPath, options.bank ?? "rubric");

  const decisionPath = path.join(candidateDir, DECISION_FILE);
  fs.writeFileSync(
    decisionPath,
    `${JSON.stringify(decisionRecord({ basis: options.basis, status: options.status }), null, 2)}\n`,
    "utf8",
  );

  return { base, candidateDir, decisionPath, bankPath, skill, skillFilePath };
}

// The bank as the user writes it. The broken one is a file that is not JSON, and the one of a single case is a valid document
// the reader refuses as a bank: fewer cases than a paired design compares.
function writeBank(bankPath: string, kind: BankKind): void {
  switch (kind) {
    case "rubric":
      fs.writeFileSync(bankPath, `${JSON.stringify({ format: CASE_BANK_FORMAT, description: "Two questions about rebasing.", rubric: RUBRIC, cases: CASES }, null, 2)}\n`, "utf8");
      return;
    case "no-rubric":
      fs.writeFileSync(bankPath, `${JSON.stringify({ format: CASE_BANK_FORMAT, cases: CASES }, null, 2)}\n`, "utf8");
      return;
    case "one-case":
      fs.writeFileSync(bankPath, `${JSON.stringify({ format: CASE_BANK_FORMAT, cases: [CASES[0]] }, null, 2)}\n`, "utf8");
      return;
    case "broken":
      fs.writeFileSync(bankPath, "{\n", "utf8");
      return;
    case "absent":
      return;
  }
}

// The record writeStagingCandidate publishes next to the lesson: schema @1, the candidate the gate rewrites and the diagnosis
// its index line names. The base of the bank replays no turn of a transcript, so its diagnosis carries no replay item and its
// evidence is empty (OA2 of M1c).
function decisionRecord(options: FixtureOptions = {}): DecisionRecord {
  const budget = { plannedRuns: 0, usedRuns: 0, interruptedAt: null };
  const tokens = {
    proposal: PROPOSAL_TOKENS,
    incumbent: { input: 0, output: 0 },
    candidate: { input: 0, output: 0 },
    total: PROPOSAL_TOKENS,
  };

  const record = {
    schema: "pi-simple-sri/decision@1" as const,
    createdAt: "2026-11-05T03:12:44.000Z",
    trigger: { surface: "command" as const, focus: "rebase without inventing flags" },
    skill: {
      name: SKILL_NAME,
      dir: "/skills/git-helpers",
      realDir: "/skills/git-helpers",
      wasSymlink: false,
      eligible: true,
    },
    eligibility: { allow: [], deny: [] },
    evidence: [],
    diagnosis: {
      summary: "The ask is to name the flags git rebase has",
      failureSignature: SIGNATURE,
      replayItems: [],
    },
    candidate: {
      kind: "new-lesson" as const,
      slug: SLUG,
      title: TITLE,
      targetLesson: null,
      lessonPath: `lessons/${SLUG}.md`,
      contentHash: HASHES.contentHash,
      bodyHash: HASHES.bodyHash,
    },
  };

  if (options.basis === "replay") {
    return {
      ...record,
      gate: { basis: "replay", status: "not-run", budget, tokens, preregistration: null, replay: null },
      outcome: { status: "proposed", reason: null, decidedAt: null },
    };
  }

  if (options.status === "preregistered") {
    return {
      ...record,
      gate: {
        basis: "case-bank",
        status: "preregistered",
        budget: { plannedRuns: PLANNED_RUNS, usedRuns: 0, interruptedAt: null },
        tokens,
        preregistration: PREREGISTRATION,
        replay: null,
        caseBank: null,
      },
      outcome: { status: "proposed", reason: null, decidedAt: null },
    };
  }

  return {
    ...record,
    gate: { basis: "case-bank", status: "not-run", budget, tokens, preregistration: null, replay: null, caseBank: null },
    outcome: { status: "proposed", reason: null, decidedAt: null },
  };
}

function readRecord(decisionPath: string): DecisionRecord {
  return JSON.parse(fs.readFileSync(decisionPath, "utf8")) as DecisionRecord;
}

function attemptsPath(base: string): string {
  return path.join(stateDir(base), ATTEMPTS_FILE);
}

// The lines of state/attempts.jsonl, in the order they were appended. An index nobody wrote answers with no lines, which is
// what a gate that accepts has to leave behind.
function readLines(base: string): AttemptLine[] {
  const indexPath = attemptsPath(base);
  if (!fs.existsSync(indexPath)) return [];

  return fs
    .readFileSync(indexPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AttemptLine);
}

// The concluded block of a record of the bank, or a failure naming the state the gate is in instead.
function concludedCaseBank(record: DecisionRecord): GateCaseBankConcluded {
  const gate = record.gate;
  if (gate.basis !== "case-bank") assert.fail(`the record of this suite holds a gate of the ${gate.basis} base`);
  if (gate.status !== "gate-accepted" && gate.status !== "gate-rejected" && gate.status !== "gate-abstained") {
    assert.fail(`the gate did not conclude: ${gate.status}`);
  }
  return gate;
}

// The concluded answer of a gate, or a failure naming the answer it gave instead. It is the one narrowing the assertions of
// this suite share: a refused candidate and one without a baseline have no verdict, no budget and no overlays to read.
function concluded(result: DirectionalGateResult): GateConcludedResult {
  if (result.kind === "refused") {
    assert.fail(`the candidate was refused: ${result.rejection.reason} (${result.rejection.detail})`);
  }
  if (result.kind === "no-baseline") assert.fail(`the gate answered no baseline: ${result.reason}`);
  return result;
}

// The clock the flow reads: one second per reading, so the preregistration of a run is older than every run that followed it.
function createClock(start: Date = CLOCK_START): () => Date {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(start.getTime() + tick * CLOCK_STEP_MS);
  };
}

// One completed run of the budget: the process answered, the skill loaded and the turn ended on its own. What decides the
// verdict of a case is the text, which is the reading of the fourth class.
function completedRun(request: ReplayRunRequest, finalText: string): ReplayRun {
  return {
    request,
    outcome: "pass",
    stopReason: "stop",
    toolCalls: [],
    finalText,
    usage: RUN_USAGE,
    durationMs: 5,
    exitCode: 0,
    skillLoaded: true,
    rawStream: `${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } })}\n`,
  };
}

// A run that proved nothing: the gate abstains instead of counting it either way (OA3).
function invalidRun(request: ReplayRunRequest): ReplayRun {
  return {
    ...completedRun(request, ""),
    outcome: "invalid",
    invalidReason: "timeout",
    exitCode: null,
    rawStream: "",
  };
}

// The judge that accepts every case, with the cost of the call next to the verdict: the record keeps both.
const acceptingJudge: DirectionalJudgeFn = async (request) => ({
  ok: true,
  value: { verdict: "pass", reason: `the answer of ${request.caseId} meets the rubric`, usage: JUDGE_USAGE },
});

// The judge that rejects one case and accepts the rest.
function judgeRejecting(caseId: string): DirectionalJudgeFn {
  return async (request) => ({
    ok: true,
    value: {
      verdict: request.caseId === caseId ? "fail" : "pass",
      reason: request.caseId === caseId ? "the answer still recommends the flag the rubric rejects" : "the answer meets the rubric",
      usage: JUDGE_USAGE,
    },
  });
}

// The judge that cannot answer one case: the call failed, which is the abstention of the second condition.
function judgeFailing(caseId: string): DirectionalJudgeFn {
  return async (request): Promise<Result<JudgeAnswer, JudgeFailure>> =>
    request.caseId === caseId
      ? { ok: false, error: { error: "unavailable" } }
      : { ok: true, value: { verdict: "pass", reason: "the answer meets the rubric", usage: JUDGE_USAGE } };
}

interface HarnessOptions {
  // The answer of one arm to one case, which is the only thing that decides the mechanical verdict.
  answer?: (request: ReplayRunRequest) => string;
  judge?: DirectionalJudgeFn;
  // Every run is one nobody can read, so the gate abstains before the second condition is asked.
  invalid?: boolean;
}

interface Harness {
  deps: DirectionalGateDeps;
  // Every run the flow asked for, with the moment the executor was entered: the timestamps the preregistration is compared
  // against.
  runs: { at: string; request: ReplayRunRequest }[];
  // The record's gate block as every run saw it on disk, which is the only place the order of the writes is observable.
  blocks: GateBlock[];
  // Every call the judge received, in the order the second condition asked them.
  judged: JudgeRequest[];
}

function createHarness(fixture: Fixture, options: HarnessOptions = {}): Harness {
  const clock = createClock();
  const runs: Harness["runs"] = [];
  const blocks: Harness["blocks"] = [];
  const judged: Harness["judged"] = [];
  const answer =
    options.answer ??
    ((request: ReplayRunRequest) => (request.arm === "candidate" ? CANDIDATE_ANSWERS[request.item] : INCUMBENT_ANSWERS[request.item]));
  const judge = options.judge ?? acceptingJudge;

  const deps: DirectionalGateDeps = {
    now: clock,
    // The seam the whole budget goes through: the gate resolves its executor here and a test answers every run of the eight.
    runReplay: async (request) => {
      runs.push({ at: clock().toISOString(), request });
      blocks.push(readRecord(fixture.decisionPath).gate);
      return options.invalid === true ? invalidRun(request) : completedRun(request, answer(request));
    },
    // The second condition, and the only seam of this suite that stands in for a model call: it answers a verdict and the
    // cost of the call, and no test reaches a provider.
    judge: async (request) => {
      judged.push(request);
      return await judge(request);
    },
  };

  return { deps, runs, blocks, judged };
}

function gateRequest(fixture: Fixture): DirectionalGateRequest {
  return {
    base: fixture.base,
    agentDir: path.join(fixture.base, "agent"),
    cwd: fixture.base,
    stagingPath: fixture.candidateDir,
    skill: fixture.skill,
    bankPath: fixture.bankPath,
    model: MODEL,
  };
}

// ---------------------------------------------------------------------------------------------
// The preregistration, before the first run
// ---------------------------------------------------------------------------------------------

// The milestone criterion of M1c, in the order it needs: the bank and the rubric are pinned before the first run, so the
// material and the second condition cannot be chosen once the result is known.
test("gateDirectionalCandidate: the bank and the rubric are preregistered before the first run", async (t) => {
  const fixture = createFixture(t);
  const skillBefore = fs.readFileSync(fixture.skillFilePath, "utf8");
  const bankBefore = fs.readFileSync(fixture.bankPath);
  const harness = createHarness(fixture);

  const result = concluded(await gateDirectionalCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-accepted");
  assert.equal(harness.runs.length, PLANNED_RUNS);
  assert.equal(harness.blocks.length, PLANNED_RUNS);

  for (const [index, gate] of harness.blocks.entries()) {
    assert.equal(gate.status, "preregistered");
    const preregistration = gate.preregistration;
    if (preregistration === null) assert.fail(`the run ${index} started without a preregistration`);

    // The design of §8 over two cases, and the rule that comes with it.
    assert.deepEqual(preregistration.design, { reps: 2, items: 2, plannedRuns: PLANNED_RUNS, arms: ["incumbent", "candidate"] });
    assert.equal(preregistration.threshold.rule, "unanimous-and-strictly-better");
    assert.equal(preregistration.threshold.candidatePasses, RUNS_PER_ARM);
    assert.equal(preregistration.threshold.incumbentPassesMax, RUNS_PER_ARM - 1);
    assert.equal(preregistration.mde.basis, "case-bank");

    // The materials of the bank: the digest of the bytes that were parsed and the digest of the rubric text, both present
    // before the first run.
    const caseBank = preregistration.caseBank;
    if (caseBank === undefined) assert.fail(`the run ${index} started without the materials of the bank`);
    assert.equal(caseBank.contentHash, digestOf(bankBefore));
    assert.equal(caseBank.rubricHash, digestOf(RUBRIC));
    assert.equal(caseBank.cases, 2);
    assert.equal(caseBank.path, fixture.bankPath);

    // The second condition travels inside the rule, pinned by the same digest.
    assert.deepEqual(preregistration.threshold.judge, { required: "pass", rubricHash: digestOf(RUBRIC) });

    // And the hash of the SKILL.md the arms were copied from, which is the field the acceptance reads.
    assert.equal(preregistration.skillContentHash, digestOf(skillBefore));

    // The one assertion this test exists for: the moment recorded for the rule is older than the run.
    assert.ok(
      Date.parse(preregistration.recordedAt) < Date.parse(harness.runs[index].at),
      `the preregistration of ${preregistration.recordedAt} is not older than the run at ${harness.runs[index].at}`,
    );
  }

  // The record it concluded with keeps the preregistration it was judged by, so one file carries both.
  const gate = concludedCaseBank(readRecord(fixture.decisionPath));
  assert.equal(gate.preregistration.recordedAt, harness.blocks[0].preregistration?.recordedAt);
});

// OA4: the bank travels with the candidate, byte for byte, under the path the preregistration names.
test("gateDirectionalCandidate: the bank is copied into the candidate byte for byte", async (t) => {
  const fixture = createFixture(t);
  const bankBefore = fs.readFileSync(fixture.bankPath);
  const harness = createHarness(fixture);

  await gateDirectionalCandidate(gateRequest(fixture), harness.deps);

  const gate = concludedCaseBank(readRecord(fixture.decisionPath));
  const copy = gate.preregistration.caseBank?.copy;
  if (copy === undefined) assert.fail("the preregistration names no copy of the bank");

  assert.equal(copy, path.join("staging", STAGING_TIMESTAMP, SKILL_NAME, CASE_BANK_FILE));
  const copied = fs.readFileSync(path.join(fixture.base, copy));
  assert.deepEqual(copied, bankBefore);
  // The digest of the record is the digest of that copy and of the file the user wrote, which is the point of pinning bytes.
  assert.equal(gate.preregistration.caseBank?.contentHash, digestOf(copied));
});

// ---------------------------------------------------------------------------------------------
// The verdicts
// ---------------------------------------------------------------------------------------------

// The exit criterion of the milestone: a candidate the mechanics and the judge both accept is accepted, and an acceptance is
// a state of decision.json and never a line of the index.
test("gateDirectionalCandidate: mechanics and judge accepting is an acceptance with no line", async (t) => {
  const fixture = createFixture(t);
  const skillBefore = fs.readFileSync(fixture.skillFilePath, "utf8");
  const harness = createHarness(fixture);

  const result = concluded(await gateDirectionalCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-accepted");
  assert.equal(result.reason, null);
  assert.equal(result.plannedRuns, PLANNED_RUNS);
  assert.equal(result.usedRuns, PLANNED_RUNS);
  // What the second condition said about the whole set travels in the answer, so no surface has to watch the judge it wired.
  assert.equal(result.judgeVerdict, "pass");
  assert.equal(result.stagingPath, path.join("staging", STAGING_TIMESTAMP, SKILL_NAME));
  assert.equal(result.decisionPath, path.join("staging", STAGING_TIMESTAMP, SKILL_NAME, DECISION_FILE));
  assert.notEqual(result.overlays, null);

  const record = readRecord(fixture.decisionPath);
  // The record the gate leaves behind is a record of the schema, not only of the types.
  assert.deepEqual(validateAgainstSchema(record), []);

  const gate = concludedCaseBank(record);
  assert.equal(gate.status, "gate-accepted");
  assert.equal(record.outcome.status, "gate-accepted");
  assert.equal(record.outcome.reason, null);
  assert.notEqual(record.outcome.decidedAt, null);

  // The budget of the pair, over the cases: eight runs, four per arm, and the two arms differ exactly where the checks say.
  assert.deepEqual(gate.budget, { plannedRuns: PLANNED_RUNS, usedRuns: PLANNED_RUNS, interruptedAt: null });
  assert.equal(gate.caseBank.arms.candidate.passes, RUNS_PER_ARM);
  assert.equal(gate.caseBank.arms.incumbent.passes, RUNS_PER_ARM / 2);
  assert.equal(gate.caseBank.regressions, 0);

  // One entry per case, with its id, the checks it was judged by and the runs of both arms.
  assert.deepEqual(
    gate.caseBank.cases.map((entry) => `${entry.index}:${entry.id}:${entry.model}`),
    ["0:onto-needs-a-base:" + MODEL, "1:no-squash-all:" + MODEL],
  );
  for (const [index, entry] of gate.caseBank.cases.entries()) {
    assert.deepEqual(entry.checks, CASES[index].checks);
    assert.equal(entry.reps.length, RUNS_PER_CASE);
    assert.equal(entry.reps.filter((run) => run.arm === "incumbent").length, 2);
    assert.equal(entry.reps.filter((run) => run.arm === "candidate").length, 2);
  }

  // The order of the budget: case (in the order of the file) -> rep -> (incumbent, candidate).
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

  // What one run is given: the prompt of its case, the cwd of the invocation, the model of the session (OA5), the cap of a
  // run, and the arm as the whole set of skills the child loads -- a bank has no session whose inventory it would resolve.
  const [first] = harness.runs;
  assert.equal(first.request.prompt, CASES[0].prompt);
  assert.equal(first.request.cwd, fixture.base);
  assert.equal(first.request.model, MODEL);
  assert.equal(first.request.timeoutMs, 180_000);
  assert.deepEqual(first.request.skillDirs, [path.join(fixture.candidateDir, "arms", "incumbent", SKILL_NAME)]);
  assert.deepEqual(harness.runs[1].request.skillDirs, [path.join(fixture.candidateDir, "arms", "candidate", SKILL_NAME)]);

  // The second condition: one call per case, on the answer of the candidate for that case, with the preregistered rubric.
  assert.equal(harness.judged.length, 2);
  assert.deepEqual(harness.judged.map((call) => call.caseId), ["onto-needs-a-base", "no-squash-all"]);
  assert.deepEqual(harness.judged.map((call) => call.response), CANDIDATE_ANSWERS);
  assert.deepEqual(harness.judged.map((call) => call.prompt), CASES.map((entry) => entry.prompt));
  assert.equal(harness.judged[0].rubric, RUBRIC);
  assert.equal(harness.judged[0].model, MODEL);

  const judge = gate.caseBank.judge;
  if (judge === null) assert.fail("the record of an accepted bank gate carries no judge");
  assert.equal(judge.model, MODEL);
  assert.equal(judge.rubricHash, digestOf(RUBRIC));
  assert.equal(judge.verdict, "pass");
  assert.equal(judge.calls.length, 2);
  assert.deepEqual(judge.calls.map((call) => call.caseId), ["onto-needs-a-base", "no-squash-all"]);

  // OA10: the tokens of the two arms and of the judge, and the total the record adds once.
  assert.deepEqual(record.gate.tokens.incumbent, { input: 40, output: 8 });
  assert.deepEqual(record.gate.tokens.candidate, { input: 40, output: 8 });
  assert.deepEqual(record.gate.tokens.judge, { input: 60, output: 10 });
  assert.deepEqual(judge.tokens, { input: 60, output: 10 });
  assert.deepEqual(record.gate.tokens.total, {
    input: PROPOSAL_TOKENS.input + 40 + 40 + 60,
    output: PROPOSAL_TOKENS.output + 8 + 8 + 10,
  });

  // No line of the index and no byte written inside the skill: the acceptance is the slice that writes it.
  assert.equal(fs.existsSync(attemptsPath(fixture.base)), false);
  assert.equal(fs.readFileSync(fixture.skillFilePath, "utf8"), skillBefore);
});

// A bank that declares no rubric announces no second condition: the rule is the only one the record carries, and the judge is
// neither called nor recorded.
test("gateDirectionalCandidate: a bank with no rubric accepts on the rule alone", async (t) => {
  const fixture = createFixture(t, { bank: "no-rubric" });
  const harness = createHarness(fixture);

  const result = concluded(await gateDirectionalCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-accepted");
  assert.equal(harness.judged.length, 0);

  const gate = concludedCaseBank(readRecord(fixture.decisionPath));
  assert.equal("judge" in gate.preregistration.threshold, false);
  assert.equal(gate.preregistration.caseBank?.rubricHash, null);
  // The block says the gate announced no second condition instead of recording a judge that never existed, and the tokens of the
  // decision keep the three components a replay gate already had.
  assert.equal(gate.caseBank.judge, null);
  assert.equal("judge" in gate.tokens, false);
});

// Q3, Q24: the mechanics are a necessary condition. A candidate below the rule is rejected and the judge is never asked, which
// is the cost OA6 promised not to spend on a comparison already refused.
test("gateDirectionalCandidate: a mechanical rejection never calls the judge", async (t) => {
  const fixture = createFixture(t);
  // The candidate misses the first repetition of the second case: three of four runs.
  const harness = createHarness(fixture, {
    answer: (request) =>
      request.arm === "candidate" && request.item === 1 && request.rep === 1
        ? "git rebase --squash-all to fold the branch"
        : request.arm === "candidate"
          ? CANDIDATE_ANSWERS[request.item]
          : INCUMBENT_ANSWERS[request.item],
  });

  const result = concluded(await gateDirectionalCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-rejected");
  assert.equal(result.reason, "below-threshold");
  assert.equal(harness.judged.length, 0);
  // The judge was never asked, and the answer says so in the word the record keeps for a condition that did not speak.
  assert.equal(result.judgeVerdict, "not-run");

  const record = readRecord(fixture.decisionPath);
  assert.deepEqual(validateAgainstSchema(record), []);
  const gate = concludedCaseBank(record);
  assert.equal(gate.caseBank.verdict, "gate-rejected");
  assert.equal(gate.caseBank.reason, "below-threshold");
  assert.equal(gate.caseBank.arms.candidate.passes, RUNS_PER_ARM - 1);

  const judge = gate.caseBank.judge;
  if (judge === null) assert.fail("the record of a bank gate that announced a rubric carries no judge");
  assert.equal(judge.verdict, "not-run");
  assert.deepEqual(judge.calls, []);
  assert.deepEqual(judge.tokens, { input: 0, output: 0 });

  const lines = readLines(fixture.base);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "gate-rejected");
  assert.equal(lines[0].reason, "below-threshold");
  assert.equal(lines[0].failureSignature, SIGNATURE);
});

// The other side of the conjunction: a candidate the mechanics accepted and one case the judge rejected is a rejection of the
// second condition, with its own reason, and the sentence of the judge travels in the line of the index.
test("gateDirectionalCandidate: a mechanical acceptance the judge does not accompany is rejected", async (t) => {
  const fixture = createFixture(t);
  const harness = createHarness(fixture, { judge: judgeRejecting("no-squash-all") });

  const result = concluded(await gateDirectionalCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-rejected");
  assert.equal(result.reason, "judge-failed");
  assert.equal(harness.judged.length, 2);
  assert.equal(result.judgeVerdict, "fail");

  const gate = concludedCaseBank(readRecord(fixture.decisionPath));
  const judge = gate.caseBank.judge;
  if (judge === null) assert.fail("the record of a rejected bank gate carries no judge");
  assert.equal(judge.verdict, "fail");
  assert.deepEqual(judge.calls.map((call) => call.caseId), ["onto-needs-a-base", "no-squash-all"]);
  assert.deepEqual(judge.calls.map((call) => call.verdict), ["pass", "fail"]);

  const detail = result.detail;
  if (detail === undefined) assert.fail("the rejection of the judge answered without its sentence");
  assert.equal(detail.startsWith("no-squash-all: "), true);

  const lines = readLines(fixture.base);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "gate-rejected");
  assert.equal(lines[0].reason, `judge-failed: ${detail}`);
});

// OA3: one broken run abstains the whole gate, and the second condition is not asked about a comparison that proved nothing.
test("gateDirectionalCandidate: an invalid run abstains without asking the judge", async (t) => {
  const fixture = createFixture(t);
  const harness = createHarness(fixture, { invalid: true });

  const result = concluded(await gateDirectionalCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-abstained");
  assert.equal(result.reason, "invalid-run");
  assert.equal(result.usedRuns, 1);
  assert.equal(harness.runs.length, 1);
  assert.equal(harness.judged.length, 0);

  const record = readRecord(fixture.decisionPath);
  assert.deepEqual(validateAgainstSchema(record), []);
  const gate = concludedCaseBank(record);
  assert.equal(gate.caseBank.reason, "invalid-run");
  assert.equal(gate.budget.usedRuns, 1);
  assert.equal(gate.caseBank.judge?.verdict, "not-run");
  assert.equal(readLines(fixture.base)[0].event, "gate-abstained");
});

// A judge nobody could read is the abstention of the second condition, and what it did answer is written into the record: the
// gate announced a condition it could not apply, and it cannot accept without it.
test("gateDirectionalCandidate: a judge that cannot answer abstains and keeps the partial result", async (t) => {
  const fixture = createFixture(t);
  const harness = createHarness(fixture, { judge: judgeFailing("no-squash-all") });

  const result = concluded(await gateDirectionalCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-abstained");
  assert.equal(result.reason, "judge-unavailable");
  assert.equal(harness.judged.length, 2);

  const record = readRecord(fixture.decisionPath);
  assert.deepEqual(validateAgainstSchema(record), []);
  const gate = concludedCaseBank(record);
  assert.equal(gate.caseBank.verdict, "gate-abstained");
  assert.equal(gate.caseBank.reason, "judge-unavailable");

  const judge = gate.caseBank.judge;
  if (judge === null) assert.fail("the record of an abstained bank gate carries no judge");
  // The set was never judged, so the verdict of the block says the judge did not speak -- and the call that did answer is there.
  assert.equal(judge.verdict, "not-run");
  assert.deepEqual(judge.calls.map((call) => call.caseId), ["onto-needs-a-base"]);
  assert.deepEqual(judge.tokens, JUDGE_USAGE);
  assert.deepEqual(record.gate.tokens.judge, JUDGE_USAGE);

  const lines = readLines(fixture.base);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "gate-abstained");
  assert.equal(String(lines[0].reason).startsWith("judge-unavailable: "), true);
});

// A call nobody could read is a call that was paid for (OA10, M1c review R1): the second condition does not stop speaking for
// free, so the cost of the reply that could not be read is in `tokens.judge` and in the total -- and the abstention names the
// cause the seam could tell, which is what a user has to act on.
test("gateDirectionalCandidate: a judge that cannot answer still pays for the call and says why", async (t) => {
  const fixture = createFixture(t);
  const unreadable: GateTokens = { input: 7, output: 3 };
  const harness = createHarness(fixture, {
    judge: async (request): Promise<Result<JudgeAnswer, JudgeFailure>> =>
      request.caseId === UNREADABLE_CASE
        ? { ok: false, error: { error: "unparseable", usage: unreadable, detail: CAUSE } }
        : { ok: true, value: { verdict: "pass", reason: "the answer meets the rubric", usage: JUDGE_USAGE } },
  });

  const result = concluded(await gateDirectionalCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-abstained");
  assert.equal(result.reason, "judge-unavailable");
  assert.equal(harness.judged.length, 2);

  // Both calls happened: the one that answered and the one nobody could read. The component is the two of them, and the total
  // adds it once.
  const record = readRecord(fixture.decisionPath);
  assert.deepEqual(validateAgainstSchema(record), []);
  const judged = {
    input: JUDGE_USAGE.input + unreadable.input,
    output: JUDGE_USAGE.output + unreadable.output,
  };
  assert.deepEqual(record.gate.tokens.judge, judged);
  assert.deepEqual(record.gate.tokens.total, {
    input: PROPOSAL_TOKENS.input + 40 + 40 + judged.input,
    output: PROPOSAL_TOKENS.output + 8 + 8 + judged.output,
  });

  // What the judge could not answer, with the case it was asked about and the cause it carried, in the answer and in the line
  // of the index alike.
  const detail = result.detail;
  if (detail === undefined) assert.fail("the abstention of the judge answered without its cause");
  assert.equal(detail.includes(UNREADABLE_CASE), true);
  assert.equal(detail.includes(CAUSE), true);

  const lines = readLines(fixture.base);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "gate-abstained");
  assert.equal(lines[0].reason, `judge-unavailable: ${detail}`);
});

// OA1, OA9: a bank that is not a baseline leaves the candidate staged and the record where it was, and the line of the index
// says which problem stopped the gate and with which candidate, so the attempt can be retried (Q23).
test("gateDirectionalCandidate: an absent, a broken and a one-case bank are no baseline", async (t) => {
  const kinds: readonly BankKind[] = ["absent", "broken", "one-case"];
  const reasons: string[] = [];

  for (const kind of kinds) {
    const fixture = createFixture(t, { bank: kind });
    const before = fs.readFileSync(fixture.decisionPath, "utf8");
    const harness = createHarness(fixture);

    const result = await gateDirectionalCandidate(gateRequest(fixture), harness.deps);

    if (result.kind !== "no-baseline") assert.fail(`the bank ${kind} answered ${result.kind}`);
    assert.equal(result.plannedRuns, 0);
    assert.equal(result.usedRuns, 0);
    assert.equal(result.overlays, null);
    assert.equal(result.stagingPath, path.join("staging", STAGING_TIMESTAMP, SKILL_NAME));
    // Zero runs and zero judgements: the gate never started.
    assert.equal(harness.runs.length, 0, `the bank ${kind} spent a run`);
    assert.equal(harness.judged.length, 0, `the bank ${kind} asked the judge`);
    // The record is exactly the record that was there: no verdict, no preregistration, no bytes of this base.
    assert.equal(fs.readFileSync(fixture.decisionPath, "utf8"), before);
    assert.equal(fs.existsSync(path.join(fixture.candidateDir, CASE_BANK_FILE)), false);

    // One line, with the hashes of the candidate so it groups with the `proposed` line of the same attempt.
    const lines = readLines(fixture.base);
    assert.equal(lines.length, 1, `the bank ${kind} wrote ${lines.length} lines`);
    assert.equal(lines[0].event, "no-baseline");
    assert.equal(lines[0].candidateHash, HASHES.contentHash);
    assert.equal(lines[0].bodyHash, HASHES.bodyHash);
    assert.equal(lines[0].failureSignature, SIGNATURE);
    assert.equal(lines[0].targetSkill, SKILL_NAME);
    assert.equal(lines[0].reason, result.reason);

    reasons.push(result.reason);
  }

  // The three reasons name three different problems, which is what makes the line actionable.
  assert.equal(reasons[0].startsWith("bank-absent: "), true);
  assert.equal(reasons[1].startsWith("bank-not-json: "), true);
  assert.equal(reasons[2].startsWith("bank-invalid: "), true);
  assert.equal(new Set(reasons).size, kinds.length);
});

// ---------------------------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------------------------

// A candidate of the other base was measured by a replay, and a gate over a bank does not decide on a material the record does
// not describe.
test("gateDirectionalCandidate: a record of the replay base is refused as a basis mismatch", async (t) => {
  const fixture = createFixture(t, { basis: "replay" });
  const before = fs.readFileSync(fixture.decisionPath, "utf8");
  const harness = createHarness(fixture);

  const result = await gateDirectionalCandidate(gateRequest(fixture), harness.deps);

  if (result.kind !== "refused") assert.fail(`the candidate was not refused: ${result.kind}`);
  assert.equal(result.rejection.reason, "basis-mismatch");
  assert.equal(result.rejection.detail.includes("replay"), true);
  assert.equal(harness.runs.length, 0);
  assert.equal(harness.judged.length, 0);
  assert.equal(fs.readFileSync(fixture.decisionPath, "utf8"), before);
  assert.equal(fs.existsSync(attemptsPath(fixture.base)), false);
});

// A candidate is gated once: the rule of a gate that already answered is not preregistered again, whether the record it left
// behind is one the flow concluded or one it was interrupted at.
test("gateDirectionalCandidate: a candidate the gate already answered is refused", async (t) => {
  // The record of a gate another run concluded: the gate itself wrote it, so the status is the one a real answer leaves.
  const concludedFixture = createFixture(t);
  await gateDirectionalCandidate(gateRequest(concludedFixture), createHarness(concludedFixture).deps);
  const concludedBefore = fs.readFileSync(concludedFixture.decisionPath, "utf8");
  const second = createHarness(concludedFixture);

  const again = await gateDirectionalCandidate(gateRequest(concludedFixture), second.deps);

  if (again.kind !== "refused") assert.fail(`the candidate was not refused: ${again.kind}`);
  assert.equal(again.rejection.reason, "already-concluded");
  assert.equal(again.rejection.detail.includes("gate-accepted"), true);
  assert.equal(second.runs.length, 0);
  assert.equal(second.judged.length, 0);
  // The verdict a reader may already have acted on is not rewritten by a second gate.
  assert.equal(fs.readFileSync(concludedFixture.decisionPath, "utf8"), concludedBefore);

  // And the same for a candidate an interruption left preregistered: the gate ended without a result, which is what a
  // preregistered record means, and it is not gated a second time either.
  const fixture = createFixture(t, { status: "preregistered" });
  const before = fs.readFileSync(fixture.decisionPath, "utf8");
  const harness = createHarness(fixture);

  const result = await gateDirectionalCandidate(gateRequest(fixture), harness.deps);

  if (result.kind !== "refused") assert.fail(`the candidate was not refused: ${result.kind}`);
  assert.equal(result.rejection.reason, "already-concluded");
  assert.equal(result.rejection.detail.includes("preregistered"), true);
  assert.equal(harness.runs.length, 0);
  assert.equal(fs.readFileSync(fixture.decisionPath, "utf8"), before);
  assert.equal(fs.existsSync(attemptsPath(fixture.base)), false);
});

// The guard of the candidate's bytes is the guard of the replay base: a lesson that moved since it was staged is the one
// abstention that writes nothing at all, not even its line.
test("gateDirectionalCandidate: a lesson that no longer matches the record abstains and writes nothing", async (t) => {
  const fixture = createFixture(t);
  const moved = LESSON_TEXT.replace("does not exist", "does not exist at all");
  fs.writeFileSync(path.join(fixture.candidateDir, LESSONS_DIR, `${SLUG}.md`), moved, "utf8");
  const before = fs.readFileSync(fixture.decisionPath, "utf8");
  const harness = createHarness(fixture);

  const result = concluded(await gateDirectionalCandidate(gateRequest(fixture), harness.deps));

  assert.equal(result.kind, "gate-abstained");
  assert.equal(result.reason, "candidate-mismatch");
  assert.equal(result.usedRuns, 0);
  assert.equal(harness.runs.length, 0);
  assert.equal(fs.readFileSync(fixture.decisionPath, "utf8"), before);
  assert.equal(fs.existsSync(attemptsPath(fixture.base)), false);
  assert.equal(fs.existsSync(path.join(fixture.candidateDir, CASE_BANK_FILE)), false);
});
