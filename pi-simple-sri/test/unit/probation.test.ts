import { test } from "node:test";
import assert from "node:assert/strict";
import { PROBATION_REASON, probationRecordOf, recordedSkillHashOf } from "../../src/gate/probation.ts";
import { feedbackNoticeText, gatePassedText, gateRejectedText, metricsText } from "../../src/messages.ts";
import { metricsOf } from "../../src/metrics.ts";
import { SriFailClosedError } from "../../src/errors.ts";
import type { DecisionRecord, GateBlock, GateCaseBankConcluded, GateTokenTally, SkillRef } from "../../src/types.ts";
import { validateAgainstSchema } from "./schema-reader.ts";

// Probation (WP10a): a candidate no gate measured, accepted by the user as it is. The record is the one the proposal wrote
// with the gate block replaced, and the three things that must hold are the block it leaves, the records it refuses to
// rewrite, and the hash the acceptance reads back. The records are validated against the schema on disk, so the block and
// the contract cannot drift apart.

const NOW = new Date("2026-11-16T10:00:00.000Z");
const HASH = `sha256:${"a".repeat(64)}`;
const OTHER_HASH = `sha256:${"b".repeat(64)}`;
const SKILL_HASH = `sha256:${"c".repeat(64)}`;

const TOKENS: GateTokenTally = {
  proposal: { input: 412, output: 137 },
  incumbent: { input: 0, output: 0 },
  candidate: { input: 0, output: 0 },
  total: { input: 412, output: 137 },
};

function notRunGate(): GateBlock {
  return {
    basis: "replay",
    status: "not-run",
    budget: { plannedRuns: 0, usedRuns: 0, interruptedAt: null },
    tokens: TOKENS,
    preregistration: null,
    replay: null,
  };
}

// The record a proposal from the observer writes: the surface is the observer's, nothing was gated and the candidate is
// only proposed.
function proposedRecord(gate: GateBlock = notRunGate()): DecisionRecord {
  return {
    schema: "pi-simple-sri/decision@1",
    createdAt: "2026-11-16T09:00:00.000Z",
    trigger: { surface: "observer", focus: "the user keeps correcting the date format" },
    skill: { name: "pdf-tools", dir: "/skills/pdf-tools", realDir: "/skills/pdf-tools", wasSymlink: false, eligible: true },
    eligibility: { allow: [], deny: [] },
    evidence: [
      {
        id: "ev-3f9a1c02",
        kind: "user_correction",
        timestamp: 1_763_283_600_000,
        source: "transcript",
        excerpt: "no, use ISO dates",
      },
    ],
    diagnosis: { summary: "dates", failureSignature: HASH, replayItems: [] },
    candidate: {
      kind: "new-lesson",
      slug: "use-iso-dates",
      title: "Use ISO dates",
      targetLesson: null,
      lessonPath: "lessons/use-iso-dates.md",
      contentHash: HASH,
      bodyHash: OTHER_HASH,
    },
    gate,
    outcome: { status: "proposed", reason: null, decidedAt: null },
  };
}

test("probationRecordOf: the gate block says nothing ran and keeps the digest of the skill at the moment of staging", () => {
  const record = probationRecordOf(proposedRecord(), SKILL_HASH, NOW);

  assert.deepEqual(record.gate, {
    basis: "replay",
    status: "probation",
    budget: { plannedRuns: 0, usedRuns: 0, interruptedAt: null },
    tokens: TOKENS,
    preregistration: null,
    replay: null,
    probation: { recordedAt: NOW.toISOString(), skillContentHash: SKILL_HASH },
  });
});

test("probationRecordOf: the outcome is probation, decided now, with the reason a reader sees instead of an empty block", () => {
  const record = probationRecordOf(proposedRecord(), SKILL_HASH, NOW);

  assert.deepEqual(record.outcome, { status: "probation", reason: PROBATION_REASON, decidedAt: NOW.toISOString() });
  // A candidate on probation is not a verdict of any gate: neither word of an accepted gate appears in the record.
  assert.notEqual(record.outcome.status, "gate-accepted");
  assert.notEqual(record.gate.status, "gate-accepted");
});

test("probationRecordOf: everything but the gate and the outcome is the record it was given, which is not mutated", () => {
  const staged = proposedRecord();
  const before = structuredClone(staged);

  const record = probationRecordOf(staged, SKILL_HASH, NOW);

  assert.deepEqual({ ...record, gate: null, outcome: null }, { ...staged, gate: null, outcome: null });
  assert.deepEqual(staged, before);
});

test("probationRecordOf: the record it writes satisfies schemas/decision.schema.json", () => {
  assert.deepEqual(validateAgainstSchema(probationRecordOf(proposedRecord(), SKILL_HASH, NOW)), []);
});

// The record a case-bank gate leaves when it ran, could not tell the lesson from its absence and said so.
function concludedBankGate(verdict: GateCaseBankConcluded["status"], reason: string | null): GateCaseBankConcluded {
  const arm = { passes: 1, runs: 4, tokens: { input: 0, output: 0 } };
  return {
    basis: "case-bank",
    status: verdict,
    budget: { plannedRuns: 8, usedRuns: 8, interruptedAt: null },
    tokens: TOKENS,
    preregistration: {
      recordedAt: NOW.toISOString(),
      threshold: { rule: "unanimous-and-strictly-better", candidatePasses: 4, incumbentPassesMax: 3, version: 1 },
      design: { reps: 2, items: 2, plannedRuns: 8, arms: ["incumbent", "candidate"] },
      mde: { basis: "case-bank", runsPerArm: 4, resolution: 0.25, requiredDifference: 1 },
      skillContentHash: OTHER_HASH,
      caseBank: { path: "/work/cases.json", contentHash: HASH, copy: "staging/x/pdf-tools/case-bank.json", cases: 2, rubricHash: null },
    },
    replay: null,
    caseBank: {
      completedAt: NOW.toISOString(),
      verdict,
      reason,
      cases: [],
      arms: { incumbent: arm, candidate: arm },
      interval: {
        method: "wilson",
        alpha: 0.05,
        incumbent: { low: 0, high: 1 },
        candidate: { low: 0, high: 1 },
        difference: { low: -1, high: 1 },
      },
      regressions: 0,
      judge: null,
      overlays: { incumbent: "staging/x/pdf-tools/arms/incumbent/pdf-tools", candidate: "staging/x/pdf-tools/arms/candidate/pdf-tools", skillContentHash: OTHER_HASH, manifestHash: HASH },
    },
  };
}

test("probationRecordOf: a case-bank gate that abstained for no-improvement goes on probation and keeps its basis and its result", () => {
  const gate = concludedBankGate("gate-abstained", "no-improvement");
  const staged = proposedRecord(gate);
  const before = structuredClone(staged);

  const record = probationRecordOf(staged, SKILL_HASH, NOW);

  assert.deepEqual(record.gate, { ...gate, status: "probation", probation: { recordedAt: NOW.toISOString(), skillContentHash: SKILL_HASH } });
  assert.deepEqual(record.outcome, { status: "probation", reason: PROBATION_REASON, decidedAt: NOW.toISOString() });
  assert.deepEqual(staged, before);
  assert.equal(recordedSkillHashOf(record.gate), SKILL_HASH);
  assert.deepEqual(validateAgainstSchema(record), []);
});

// Only the verdict "the bank cannot tell" is a reason to accept unmeasured: any other concluded gate said something else.
test("probationRecordOf: a case-bank gate that concluded for any other reason is refused", () => {
  const refused: [string, GateCaseBankConcluded][] = [
    ["accepted", concludedBankGate("gate-accepted", null)],
    ["rejected", concludedBankGate("gate-rejected", "below-threshold")],
    ["abstained: invalid-run", concludedBankGate("gate-abstained", "invalid-run")],
    ["abstained: interrupted", concludedBankGate("gate-abstained", "interrupted")],
    ["abstained: no reason", concludedBankGate("gate-abstained", null)],
    ["rejected: no-improvement", concludedBankGate("gate-rejected", "no-improvement")],
  ];

  for (const [name, gate] of refused) {
    assert.throws(() => probationRecordOf(proposedRecord(gate), SKILL_HASH, NOW), SriFailClosedError, name);
  }
});

// A record that a gate already touched is a verdict a reader may have acted on: probation never rewrites it.
test("probationRecordOf: a record whose gate ran, preregistered or is of another basis is refused", () => {
  const refused: { name: string; gate: GateBlock }[] = [
    {
      name: "preregistered",
      gate: {
        basis: "replay",
        status: "preregistered",
        budget: { plannedRuns: 8, usedRuns: 0, interruptedAt: null },
        tokens: TOKENS,
        preregistration: {
          recordedAt: NOW.toISOString(),
          threshold: { rule: "unanimous-and-strictly-better", candidatePasses: 4, incumbentPassesMax: 3, version: 1 },
          design: { reps: 2, items: 2, plannedRuns: 8, arms: ["incumbent", "candidate"] },
          mde: { basis: "replay", runsPerArm: 4, resolution: 0.25, requiredDifference: 1 },
        },
        replay: null,
      },
    },
    {
      name: "case-bank not-run",
      gate: {
        basis: "case-bank",
        status: "not-run",
        budget: { plannedRuns: 0, usedRuns: 0, interruptedAt: null },
        tokens: TOKENS,
        preregistration: null,
        replay: null,
        caseBank: null,
      },
    },
    {
      name: "already on probation",
      gate: {
        basis: "replay",
        status: "probation",
        budget: { plannedRuns: 0, usedRuns: 0, interruptedAt: null },
        tokens: TOKENS,
        preregistration: null,
        replay: null,
        probation: { recordedAt: NOW.toISOString(), skillContentHash: SKILL_HASH },
      },
    },
  ];

  for (const { name, gate } of refused) {
    assert.throws(() => probationRecordOf(proposedRecord(gate), SKILL_HASH, NOW), SriFailClosedError, name);
  }
});

test("recordedSkillHashOf: a probation block answers its own digest and a gate answers the one it preregistered", () => {
  const probation = probationRecordOf(proposedRecord(), SKILL_HASH, NOW);
  assert.equal(recordedSkillHashOf(probation.gate), SKILL_HASH);

  const preregistered: GateBlock = {
    basis: "replay",
    status: "preregistered",
    budget: { plannedRuns: 8, usedRuns: 0, interruptedAt: null },
    tokens: TOKENS,
    preregistration: {
      recordedAt: NOW.toISOString(),
      threshold: { rule: "unanimous-and-strictly-better", candidatePasses: 4, incumbentPassesMax: 3, version: 1 },
      design: { reps: 2, items: 2, plannedRuns: 8, arms: ["incumbent", "candidate"] },
      mde: { basis: "replay", runsPerArm: 4, resolution: 0.25, requiredDifference: 1 },
      skillContentHash: OTHER_HASH,
    },
    replay: null,
  };
  assert.equal(recordedSkillHashOf(preregistered), OTHER_HASH);
});

test("recordedSkillHashOf: a block that recorded no digest answers null and never a guess", () => {
  assert.equal(recordedSkillHashOf(notRunGate()), null);
});

// The observer is the third surface, and the sentences a surface closes are the tool's for it: it never accepts, so a
// verdict is "not accepted, which belongs to the command", exactly as the tool says it.
const SKILL: SkillRef = {
  name: "pdf-tools",
  description: "Extract tables from PDFs",
  dir: "/skills/pdf-tools",
  realDir: "/skills/pdf-tools",
  hasLessons: false,
  kind: "declared",
};

test("messages: the observer closes a verdict with the clause of the tool and not with the command's", () => {
  assert.equal(gatePassedText("observer", SKILL, 8, 8), gatePassedText("tool", SKILL, 8, 8));
  assert.notEqual(gatePassedText("observer", SKILL, 8, 8), gatePassedText("command", SKILL, 8, 8));
  assert.equal(gatePassedText("observer", SKILL, 8, 8).includes("not accepted"), true);
  assert.equal(
    gateRejectedText("observer", SKILL, "below-threshold", 8),
    gateRejectedText("tool", SKILL, "below-threshold", 8),
  );
});

// The notice promised that a tool "registers a correction". The tool records a note and nothing else, so the sentence says
// that and says it edits and accepts nothing.
test("feedbackNoticeText: the tool is described as recording a note, never as registering a correction or accepting", () => {
  const text = feedbackNoticeText();

  assert.equal(text.includes("registers a correction"), false);
  assert.equal(text.includes("a correction or a rejection"), false);
  assert.equal(
    text.includes(
      "When `pi-simple-sri.observe.enabled` is on, the skill_improve tool records a correction the user made as a note for a later review, without editing any skill or accepting anything.",
    ),
    true,
  );
});

test("metricsText: a lesson accepted on probation is reported on its own line, and a series without one prints nothing of it", () => {
  const withoutProbation = metricsText(metricsOf({ lines: [], damaged: null }));
  assert.equal(withoutProbation.includes("probation"), false);

  const metrics = { ...metricsOf({ lines: [], damaged: null }), probation: 2 };
  const text = metricsText(metrics);
  assert.equal(text.includes("2 lessons were accepted on probation: no gate measured them, so they are in no rate above."), true);
  assert.equal(metricsText({ ...metrics, probation: 1 }).includes("1 lesson was accepted on probation: no gate measured it, so it is in no rate above."), true);
});
