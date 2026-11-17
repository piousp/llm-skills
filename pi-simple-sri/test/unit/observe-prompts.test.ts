import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GATE_PROOF_NOTICE,
  offerAcceptance,
  offerProposal,
  promptAText,
  promptBText,
  type ProposalView,
} from "../../src/observe/prompts.ts";
import { PROBATION_OUTCOME, type GateClassification } from "../../src/observe/outcome.ts";
import { PROMPT_TIMEOUT_MS } from "../../src/observe/types.ts";
import { HANG, TIMEOUT, fakeUi } from "./observe-fixtures.ts";

const BANK_VIEW: ProposalView = {
  skill: "mde-pending-reviews",
  patternSummary: "lists drafts as pending reviews",
  observations: ["user: drafts are not pending reviews", "judge: repeated the request"],
  sessions: 3,
  days: 4,
  realRuns: 5,
  lesson: "Exclude draft pull requests.",
  gate: "bank",
  cwd: "/work/proj-a",
  bank: {
    provenance: "auto",
    cases: [{ id: "case-1", prompt: "list my pending reviews", checks: ["regex: /draft/i (must not match)", "contains: ready"] }],
  },
};

const PROBATION_VIEW: ProposalView = { ...BANK_VIEW, gate: "probation", bank: null };

const PASSED: GateClassification = { class: "accepted", status: "gate-accepted", reason: null };
const NOT_MEASURED: GateClassification = { class: "not-measurable", status: "gate-abstained", reason: "no-improvement" };

test("promptAText: states the gate proves the lesson works, not that the pattern is real", () => {
  const text = promptAText(BANK_VIEW);

  assert.ok(text.includes(GATE_PROOF_NOTICE));
  assert.match(text.toLowerCase(), /it does not prove the pattern is real/);
  assert.match(text.toLowerCase(), /makes these cases pass/);
});

test("promptAText: shows skill, pattern, observations, counts, real runs, cwd and lesson", () => {
  const text = promptAText(BANK_VIEW);

  for (const part of [
    "mde-pending-reviews",
    "lists drafts as pending reviews",
    "user: drafts are not pending reviews",
    "judge: repeated the request",
    "3 sessions",
    "4 days",
    "up to 5 real runs of the skill in /work/proj-a",
    "/work/proj-a",
    "Exclude draft pull requests.",
  ]) {
    assert.ok(text.includes(part), `missing ${part}`);
  }
});

test("promptAText: the real runs are the runs the gate will spend, said apart from how often the pattern was seen", () => {
  const text = promptAText({ ...BANK_VIEW, sessions: 3, days: 4, realRuns: 24 });

  assert.match(text, /Seen in 3 sessions over 4 days\./);
  assert.match(text, /The gate will spend up to 24 real runs of the skill in \/work\/proj-a \(arms x repetitions x items\)\./);
  assert.doesNotMatch(text, /sessions over 4 days, /);
});

test("promptAText: a probation proposal plans no gate runs", () => {
  assert.doesNotMatch(promptAText(PROBATION_VIEW), /real runs/);
  assert.doesNotMatch(promptAText({ ...PROBATION_VIEW, realRuns: 0 }), /runs of the skill/);
});

test("promptBText: the probation outcome is labeled not measured whatever the view says", () => {
  for (const view of [PROBATION_VIEW, BANK_VIEW]) {
    const text = promptBText(view, PROBATION_OUTCOME);

    assert.match(text, /Not measured\. The lesson was not compared against any case\./);
    assert.ok(!text.includes(GATE_PROOF_NOTICE));
  }
});

test("promptAText: a bank gate lists the cases, their checks and the bank provenance", () => {
  const text = promptAText(BANK_VIEW);

  assert.ok(text.includes("auto"));
  assert.ok(text.includes("case-1"));
  assert.ok(text.includes("list my pending reviews"));
  assert.ok(text.includes("contains: ready"));
});

test("promptAText: a probation proposal says it is not measured and lists no cases", () => {
  const text = promptAText(PROBATION_VIEW);

  assert.match(text.toLowerCase(), /probation: not measured/);
  assert.ok(!text.includes("case-1"));
});

test("promptAText: shows at most three distinct observations and counts the rest as more", () => {
  const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
  const many = { ...BANK_VIEW, observations: names.map((name) => `the user corrected ${name} output`) };
  const text = promptAText(many);

  assert.ok(text.includes("alpha output"));
  assert.ok(text.includes("charlie output"));
  assert.ok(!text.includes("delta output"));
  assert.match(text, /^ {2}\+3 more$/m);
  assert.doesNotMatch(text, /similar/);
  assert.doesNotMatch(text, /and \d+ more/);
});

test("promptAText: near-identical observations (token Jaccard >= 0.7) show once and are counted", () => {
  const view = {
    ...BANK_VIEW,
    observations: [
      "the user asked for prose only",
      "the user asked for prose only please",
      "the user asked for prose only, again",
      "judge: the reply used bullets",
    ],
  };
  const lines = promptAText(view).split("\n");

  assert.deepEqual(
    lines.filter((line) => line.startsWith("  - ")).slice(0, 2),
    ["  - the user asked for prose only", "  - judge: the reply used bullets"],
  );
  assert.ok(!lines.some((line) => line.includes("please")));
  assert.ok(lines.includes("  +2 more"));
});

test("promptAText: the similarity boundary is inclusive at 0.7 and a pair under it is two observations", () => {
  const base = "one two three four five six seven";
  const atBoundary = { ...BANK_VIEW, observations: [`${base} eight`, `${base} nine ten`] };
  // 7 shared of 10 distinct tokens
  assert.ok(promptAText(atBoundary).split("\n").includes("  +1 more"));

  const under = { ...BANK_VIEW, observations: ["one two three four", "one two three five"] };
  // 3 shared of 5
  const text = promptAText(under);
  assert.ok(text.includes("  - one two three five"));
  assert.doesNotMatch(text, /\+\d+ more/);
});

test("promptAText: the pattern is one line and the observations of a view with no duplicates are listed whole", () => {
  const text = promptAText(BANK_VIEW);

  assert.equal(text.split("\n").filter((line) => line.startsWith("Pattern:")).length, 1);
  assert.doesNotMatch(text, /\+\d+ more/);
});

test("promptBText: shows the gate result and the lesson", () => {
  const text = promptBText(BANK_VIEW, PASSED);

  assert.ok(text.includes("gate-accepted"));
  assert.ok(text.includes("Exclude draft pull requests."));
  assert.ok(text.includes(GATE_PROOF_NOTICE));
});

test("promptBText: a not-measurable outcome and a probation proposal are labeled not measured", () => {
  assert.match(promptBText(BANK_VIEW, NOT_MEASURED).toLowerCase(), /not measured/);
  assert.match(
    promptBText(PROBATION_VIEW, { class: "not-measurable", status: "probation", reason: null }).toLowerCase(),
    /not measured/,
  );
});

test("promptBText: a measured pass is not labeled not measured", () => {
  assert.doesNotMatch(promptBText(BANK_VIEW, PASSED).toLowerCase(), /not measured/);
});

test("offerProposal: lists Later first and maps each label to its answer", async () => {
  for (const [label, expected] of [
    ["Approve", "approve"],
    ["Reject", "reject"],
    ["Later", "later"],
  ] as const) {
    const h = fakeUi([{ kind: "select", answer: label }]);

    assert.equal(await offerProposal(BANK_VIEW, h.ui, {}), expected);
    assert.equal(h.shown[0]?.options?.[0], "Later");
    assert.equal(h.shown[0]?.title, promptAText(BANK_VIEW));
  }
});

test("offerProposal: asks with the prompt timeout and the signal", async () => {
  const controller = new AbortController();
  const h = fakeUi([{ kind: "select", answer: "Later" }]);

  await offerProposal(BANK_VIEW, h.ui, { signal: controller.signal });

  assert.equal(h.shown[0]?.opts?.timeout, PROMPT_TIMEOUT_MS);
  assert.equal(h.shown[0]?.opts?.signal, controller.signal);
});

test("offerProposal: a dismissed dialog without abort is a timeout", async () => {
  const h = fakeUi([{ kind: "select", answer: TIMEOUT }]);

  assert.equal(await offerProposal(BANK_VIEW, h.ui, {}), "timeout");
});

test("offerProposal: an abort dismisses the dialog and counts as later, not timeout", async () => {
  const controller = new AbortController();
  const h = fakeUi([{ kind: "select", answer: HANG }]);
  const pending = offerProposal(BANK_VIEW, h.ui, { signal: controller.signal });
  controller.abort();

  assert.equal(await pending, "later");
});

test("offerProposal: an already aborted signal opens no dialog", async () => {
  const controller = new AbortController();
  controller.abort();
  const h = fakeUi([]);

  assert.equal(await offerProposal(BANK_VIEW, h.ui, { signal: controller.signal }), "later");
  assert.equal(h.shown.length, 0);
});

test("offerProposal: an answer that is none of the options is later, never approve", async () => {
  const h = fakeUi([{ kind: "select", answer: "whatever" }]);

  assert.equal(await offerProposal(BANK_VIEW, h.ui, {}), "later");
});

test("offerAcceptance: lists Later first and maps Accept, Reject and Later", async () => {
  for (const [label, expected] of [
    ["Accept", "accept"],
    ["Reject", "reject"],
    ["Later", "later"],
  ] as const) {
    const h = fakeUi([{ kind: "select", answer: label }]);

    assert.equal(await offerAcceptance(BANK_VIEW, PASSED, h.ui, {}), expected);
    assert.equal(h.shown[0]?.options?.[0], "Later");
    assert.equal(h.shown[0]?.title, promptBText(BANK_VIEW, PASSED));
  }
});

test("offerAcceptance: timeout, abort and an already aborted signal never accept", async () => {
  const timeout = fakeUi([{ kind: "select", answer: TIMEOUT }]);
  assert.equal(await offerAcceptance(BANK_VIEW, PASSED, timeout.ui, {}), "timeout");

  const controller = new AbortController();
  const hang = fakeUi([{ kind: "select", answer: HANG }]);
  const pending = offerAcceptance(BANK_VIEW, PASSED, hang.ui, { signal: controller.signal });
  controller.abort();
  assert.equal(await pending, "later");

  const none = fakeUi([]);
  assert.equal(await offerAcceptance(BANK_VIEW, PASSED, none.ui, { signal: controller.signal }), "later");
  assert.equal(none.shown.length, 0);
});
