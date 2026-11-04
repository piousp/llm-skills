import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStagedCandidate, type CandidateRejection, type StagedCandidateResult } from "../../src/gate/flow.ts";
import { DECISION_FILE, LESSONS_DIR } from "../../src/names.ts";
import type { DecisionRecord } from "../../src/types.ts";
import { stagingDir } from "../../src/write-base.ts";

// What this suite covers today is the step every gate run begins with: the record of the candidate the run
// was pointed at, or the typed refusal that says why there is none. The orchestration around it --
// preregistration, overlays, runs, verdict, index line -- is not written yet and belongs to the same module.
//
// Everything runs on a staging tree built in mkdtemp: no test names a real skill, and no directory outside
// the temporary one is read or written.

const SKILL_NAME = "pdf-tools";
const SLUG = "merged-cells";
const TITLE = "Extract merged cells with the lattice strategy";
const SIGNATURE = `sha256:${"c".repeat(64)}`;
const CONTENT_HASH = `sha256:${"a".repeat(64)}`;
const BODY_HASH = `sha256:${"b".repeat(64)}`;
const STAGING_TIMESTAMP = "20261102T140322481Z";

// The record writeStagingCandidate publishes next to the lesson: schema @1, the candidate the gate will
// rewrite and the diagnosis its index line names. It is a literal because nothing in this suite runs the
// propose flow -- what is under test is the reading of a file that flow already wrote.
function decisionRecord(): DecisionRecord {
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
    evidence: [
      {
        id: "ev-3f9a1c02",
        kind: "tool_error",
        toolName: "bash",
        timestamp: 1762082602481,
        source: "transcript",
        excerpt: "pdftotext: cannot open report.pdf",
      },
    ],
    diagnosis: {
      summary: "Table extraction loses merged cells",
      failureSignature: SIGNATURE,
      replayItems: [
        {
          prompt: "extract the merged-cell table from report.pdf",
          cwd: "/work/reports",
          expectation: { class: "tool_error", version: 1, tool: "bash" },
        },
      ],
    },
    candidate: {
      kind: "new-lesson",
      slug: SLUG,
      title: TITLE,
      targetLesson: null,
      lessonPath: `lessons/${SLUG}.md`,
      contentHash: CONTENT_HASH,
      bodyHash: BODY_HASH,
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

interface Fixture {
  base: string; // the write base of the run: <base>/staging holds the candidate
  candidateDir: string; // <base>/staging/<ts>/<skill>
  decisionPath: string;
}

function createFixture(t: TestContext): Fixture {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sri-gate-flow-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const candidateDir = path.join(stagingDir(base), STAGING_TIMESTAMP, SKILL_NAME);
  const lessonsDir = path.join(candidateDir, LESSONS_DIR);
  fs.mkdirSync(lessonsDir, { recursive: true });
  fs.writeFileSync(path.join(lessonsDir, `${SLUG}.md`), "the lesson the candidate carries\n", "utf8");

  const decisionPath = path.join(candidateDir, DECISION_FILE);
  fs.writeFileSync(decisionPath, `${JSON.stringify(decisionRecord(), null, 2)}\n`, "utf8");

  return { base, candidateDir, decisionPath };
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
    predicate: { class: "tool_error", version: 1, tool: "bash" },
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
