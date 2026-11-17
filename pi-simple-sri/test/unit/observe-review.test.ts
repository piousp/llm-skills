import { test } from "node:test";
import assert from "node:assert/strict";
import { latestProposals } from "../../src/observe/cycle.ts";
import {
  dispatchReview,
  reviewProposal,
  type ReviewApi,
  type ReviewDeps,
  type ReviewResult,
} from "../../src/observe/review.ts";
import type { GateClassification } from "../../src/observe/outcome.ts";
import { PROBATION_OUTCOME } from "../../src/observe/outcome.ts";
import { promptAText, promptBText, type ProposalView } from "../../src/observe/prompts.ts";
import {
  OBSERVE_FORMAT,
  type GateOutcomeEvent,
  type ObserveEvent,
  type ObserveState,
  type PromptEvent,
  type ProposalEvent,
  type TombstoneEvent,
} from "../../src/observe/types.ts";
import type { GateConcludedResult, GateFlowResult } from "../../src/gate/flow.ts";
import type { DirectionalGateResult } from "../../src/gate/directional-flow.ts";
import type { AcceptOutcome } from "../../src/gate/acceptance.ts";
import { HANG, TIMEOUT, fakeUi, type UiStep } from "./observe-fixtures.ts";

const AT = "2026-11-16T12:00:00.000Z";

function proposal(over: Partial<ProposalEvent> = {}): ProposalEvent {
  return {
    format: OBSERVE_FORMAT,
    at: AT,
    type: "proposal",
    id: "pr-aaaaaaaaaaaa",
    patternId: "pt-bbbbbbbbbbbb",
    skill: "mde-pending-reviews",
    stagingPath: "staging/mde-pending-reviews/c1",
    candidateHash: "sha256:cand",
    gate: "bank",
    bankPath: "banks/mde-pending-reviews.json",
    provenance: "user",
    cwd: "/work/proj-a",
    skillContentHash: "b".repeat(64),
    ...over,
  };
}

function approvalA(over: Partial<PromptEvent> = {}): PromptEvent {
  return { format: OBSERVE_FORMAT, at: AT, type: "prompt", proposalId: "pr-aaaaaaaaaaaa", stage: "a", answer: "approve", ...over };
}

function outcomeEvent(over: Partial<GateOutcomeEvent> = {}): GateOutcomeEvent {
  return {
    format: OBSERVE_FORMAT,
    at: AT,
    type: "gate-outcome",
    proposalId: "pr-aaaaaaaaaaaa",
    class: "accepted",
    status: "gate-accepted",
    reason: null,
    ...over,
  };
}

function stateOf(parts: Partial<ObserveState>): ObserveState {
  return {
    optInAt: null,
    episodes: [],
    judged: [],
    observations: [],
    proposals: [],
    prepareFailures: [],
    prompts: [],
    gateOutcomes: [],
    tombstones: [],
    forgets: {},
    ...parts,
  };
}


function concluded(kind: GateConcludedResult["kind"], reason: GateConcludedResult["reason"]): GateConcludedResult {
  return {
    kind,
    reason,
    stagingPath: "staging/s/c",
    decisionPath: "staging/s/c/decision.json",
    plannedRuns: 12,
    usedRuns: 12,
    overlays: null,
  };
}

interface Harness {
  deps: ReviewDeps;
  appended: ObserveEvent[];
  calls: string[];
  acceptedWith: GateClassification[];
  gatedAt: (string | null)[];
}

interface HarnessOptions {
  state: ObserveState;
  gateResult?: GateFlowResult | DirectionalGateResult;
  acceptResult?: AcceptOutcome;
  alreadyAccepted?: boolean;
  // By default the user approved the lesson and the bank at prompt (a) before the review; true: they did not.
  unapproved?: boolean;
  // The path promoteBank answers; null: the proposal has no bank.
  promoted?: string | null;
  promoteError?: string;
  // Behaves like the real gate: a record that is no longer not-run is refused `already-concluded`.
  concludedRecord?: boolean;
}

function harness(options: HarnessOptions): Harness {
  const appended: ObserveEvent[] = [];
  const calls: string[] = [];
  const acceptedWith: GateClassification[] = [];
  const gatedAt: (string | null)[] = [];
  const view: ProposalView = {
    skill: "mde-pending-reviews",
    patternSummary: "lists drafts",
    observations: ["user: no drafts"],
    sessions: 2,
    days: 2,
    realRuns: 3,
    lesson: "Skip drafts.",
    gate: "bank",
    cwd: "/work/proj-a",
    bank: { provenance: "user", cases: [] },
  };
  const deps: ReviewDeps = {
    now: () => new Date(AT),
    readState: async () => (options.unapproved ? options.state : { ...options.state, prompts: [approvalA(), ...options.state.prompts] }),
    isAccepted: async () => options.alreadyAccepted ?? false,
    viewOf: async (p) => ({ ...view, gate: p.gate }),
    promoteBank: async () => {
      calls.push("promote");
      if (options.promoteError !== undefined) throw new Error(options.promoteError);
      return options.promoted === undefined ? "banks/promoted.json" : options.promoted;
    },
    runGate: async (_p, bankPath): Promise<GateFlowResult | DirectionalGateResult> => {
      calls.push("gate");
      gatedAt.push(bankPath);
      if (options.concludedRecord) return { kind: "refused", rejection: { reason: "already-concluded", detail: "the record already holds a verdict" } };
      return options.gateResult ?? concluded("gate-accepted", null);
    },
    accept: async (_p, outcome) => {
      calls.push("accept");
      acceptedWith.push(outcome);
      return options.acceptResult ?? { ok: true, value: { historyPath: "h", lessonPath: "l", referenceAdded: true } };
    },
    append: async (events) => {
      appended.push(...events);
    },
  };
  return { deps, appended, calls, acceptedWith, gatedAt };
}

async function review(h: Harness, script: UiStep[], signal?: AbortSignal) {
  const ui = fakeUi(script);
  const result: ReviewResult = await reviewProposal("pr-aaaaaaaaaaaa", { ui: ui.ui, ...(signal ? { signal } : {}) }, h.deps);
  return { result, ui };
}

function ofType<T extends ObserveEvent["type"]>(events: ObserveEvent[], type: T) {
  return events.filter((e): e is Extract<ObserveEvent, { type: T }> => e.type === type);
}

test("reviewProposal: an unknown proposal id has nothing to review and asks nothing", async () => {
  const h = harness({ state: stateOf({}) });
  const { result, ui } = await review(h, []);

  assert.equal(result, "nothing-to-review");
  assert.equal(ui.shown.length, 0);
  assert.deepEqual(h.calls, []);
});

test("reviewProposal: an already accepted proposal has nothing to review", async () => {
  const h = harness({ state: stateOf({ proposals: [proposal()] }), alreadyAccepted: true });

  assert.equal((await review(h, [])).result, "nothing-to-review");
  assert.deepEqual(h.calls, []);
});

test("reviewProposal: a rejected pattern has nothing to review when the tombstone covers this candidate", async () => {
  const tomb = (candidateHash: string | null): TombstoneEvent => ({
    format: OBSERVE_FORMAT,
    at: AT,
    type: "tombstone",
    patternId: "pt-bbbbbbbbbbbb",
    skill: "mde-pending-reviews",
    reason: "user-rejected",
    candidateHash,
  });

  for (const hash of [null, "sha256:cand"]) {
    const h = harness({ state: stateOf({ proposals: [proposal()], tombstones: [tomb(hash)] }) });
    assert.equal((await review(h, [])).result, "nothing-to-review");
  }

  const other = harness({
    state: stateOf({ proposals: [proposal()], tombstones: [tomb("sha256:older")], gateOutcomes: [outcomeEvent()] }),
  });
  assert.equal((await review(other, [{ kind: "select", answer: "Later" }])).result, "declined");
});

test("reviewProposal: a persisted gate rejection has nothing to review", async () => {
  const h = harness({
    state: stateOf({ proposals: [proposal()], gateOutcomes: [outcomeEvent({ class: "rejected", status: "gate-rejected" })] }),
  });

  assert.equal((await review(h, [])).result, "nothing-to-review");
});

test("reviewProposal: with no outcome it gates in the foreground, records it, confirms, then accepts", async () => {
  const h = harness({ state: stateOf({ proposals: [proposal()] }) });
  const { result, ui } = await review(h, [{ kind: "select", answer: "Accept" }]);

  assert.equal(result, "accepted");
  assert.deepEqual(h.calls, ["promote", "gate", "accept"]);
  assert.deepEqual(h.gatedAt, ["banks/promoted.json"]);
  const outcomes = ofType(h.appended, "gate-outcome");
  assert.equal(outcomes.length, 1);
  assert.deepEqual(
    { class: outcomes[0]!.class, status: outcomes[0]!.status, reason: outcomes[0]!.reason, proposalId: outcomes[0]!.proposalId },
    { class: "accepted", status: "gate-accepted", reason: null, proposalId: "pr-aaaaaaaaaaaa" },
  );
  const prompts = ofType(h.appended, "prompt");
  assert.deepEqual(
    prompts.map((p) => [p.proposalId, p.stage, p.answer]),
    [["pr-aaaaaaaaaaaa", "b", "accept"]],
  );
  assert.equal(ui.shown.length, 1);
  assert.equal(
    ui.shown[0]?.title,
    promptBText(
      { skill: "mde-pending-reviews", patternSummary: "lists drafts", observations: ["user: no drafts"], sessions: 2, days: 2, realRuns: 3, lesson: "Skip drafts.", gate: "bank", cwd: "/work/proj-a", bank: { provenance: "user", cases: [] } },
      { class: "accepted", status: "gate-accepted", reason: null },
    ),
  );
  assert.equal(h.appended.every((e) => e.format === OBSERVE_FORMAT && e.at === AT), true);
});

test("reviewProposal: nothing is accepted when the user answers anything but Accept", async () => {
  for (const [answer, prompt] of [
    ["Later", "later"],
    [TIMEOUT, "timeout"],
  ] as const) {
    const h = harness({ state: stateOf({ proposals: [proposal()], gateOutcomes: [outcomeEvent()] }) });
    const { result } = await review(h, [{ kind: "select", answer }]);

    assert.equal(result, "declined");
    assert.deepEqual(h.calls, []);
    assert.deepEqual(ofType(h.appended, "prompt").map((p) => p.answer), [prompt]);
    assert.equal(ofType(h.appended, "tombstone").length, 0);
  }
});

test("reviewProposal: Reject records a user-rejected tombstone for this candidate", async () => {
  const h = harness({ state: stateOf({ proposals: [proposal()], gateOutcomes: [outcomeEvent()] }) });
  const { result } = await review(h, [{ kind: "select", answer: "Reject" }]);

  assert.equal(result, "rejected");
  assert.deepEqual(h.calls, []);
  const tombs = ofType(h.appended, "tombstone");
  assert.equal(tombs.length, 1);
  assert.deepEqual(
    { patternId: tombs[0]!.patternId, skill: tombs[0]!.skill, reason: tombs[0]!.reason, candidateHash: tombs[0]!.candidateHash },
    { patternId: "pt-bbbbbbbbbbbb", skill: "mde-pending-reviews", reason: "user-rejected", candidateHash: "sha256:cand" },
  );
  assert.deepEqual(ofType(h.appended, "prompt").map((p) => p.answer), ["reject"]);
});

test("reviewProposal: a gate rejection tombstones the candidate, asks nothing and accepts nothing", async () => {
  const h = harness({
    state: stateOf({ proposals: [proposal()] }),
    gateResult: concluded("gate-rejected", "below-threshold"),
  });
  const { result, ui } = await review(h, []);

  assert.equal(result, "rejected");
  assert.equal(ui.shown.length, 0);
  assert.deepEqual(h.calls, ["promote", "gate"]);
  assert.deepEqual(ofType(h.appended, "gate-outcome").map((o) => o.class), ["rejected"]);
  const tombs = ofType(h.appended, "tombstone");
  assert.deepEqual(tombs.map((t) => [t.reason, t.candidateHash]), [["gate-rejected", "sha256:cand"]]);
});

test("reviewProposal: a retryable gate answer is recorded, reported and never accepted", async () => {
  const h = harness({
    state: stateOf({ proposals: [proposal()] }),
    gateResult: concluded("gate-abstained", "interrupted"),
  });
  const { result, ui } = await review(h, []);

  assert.equal(result, "retryable");
  assert.equal(ui.shown.length, 0);
  assert.deepEqual(h.calls, ["promote", "gate"]);
  assert.deepEqual(ofType(h.appended, "gate-outcome").map((o) => [o.class, o.reason]), [["retryable", "interrupted"]]);
  assert.equal(ofType(h.appended, "tombstone").length, 0);
  assert.equal(ui.notices.length, 1);
  assert.match(ui.notices[0]!.message, /interrupted/);
});

const RETRYABLE = outcomeEvent({ class: "retryable", status: "gate-abstained", reason: "interrupted" });

// The real gate refuses a record that is no longer not-run, and an interrupted run leaves it concluded: the review of such
// a proposal cannot be unstuck by gating it again. It reports it and leaves the restaging to the next cycle.
test("reviewProposal: a retryable outcome whose record is concluded is refused by the gate: nothing is accepted, the refusal is recorded and reported", async () => {
  const h = harness({ state: stateOf({ proposals: [proposal()], gateOutcomes: [RETRYABLE] }), concludedRecord: true });
  const { result, ui } = await review(h, []);

  assert.equal(result, "retryable");
  assert.deepEqual(h.calls, ["promote", "gate"]);
  assert.equal(ui.shown.length, 0);
  assert.deepEqual(ofType(h.appended, "gate-outcome").map((o) => [o.class, o.status, o.reason]), [["retryable", "refused", "already-concluded"]]);
  assert.equal(ofType(h.appended, "tombstone").length, 0);
  assert.match(ui.notices[0]!.message, /already-concluded/);
});

test("reviewProposal: a retryable outcome whose record is still not-run is gated again", async () => {
  const h = harness({ state: stateOf({ proposals: [proposal()], gateOutcomes: [RETRYABLE] }) });

  assert.equal((await review(h, [{ kind: "select", answer: "Accept" }])).result, "accepted");
  assert.deepEqual(h.calls, ["promote", "gate", "accept"]);
});

test("reviewProposal: a concluded outcome is not gated again, and no bank is promoted for it", async () => {
  const done = harness({ state: stateOf({ proposals: [proposal()], gateOutcomes: [outcomeEvent()] }), concludedRecord: true });
  assert.equal((await review(done, [{ kind: "select", answer: "Accept" }])).result, "accepted");
  assert.deepEqual(done.calls, ["accept"]);
  assert.equal(ofType(done.appended, "gate-outcome").length, 0);
});

test("reviewProposal: the newest outcome by `at` decides even when an older one is listed after it", async () => {
  const h = harness({
    state: stateOf({
      proposals: [proposal()],
      gateOutcomes: [outcomeEvent({ at: "2026-11-16T13:00:00.000Z" }), outcomeEvent({ class: "retryable", status: "gate-abstained", reason: "interrupted" })],
    }),
  });

  assert.equal((await review(h, [{ kind: "select", answer: "Accept" }])).result, "accepted");
  assert.deepEqual(h.calls, ["accept"]);
});

test("reviewProposal: the latest outcome of the proposal decides, not an older one or another proposal's", async () => {
  const h = harness({
    state: stateOf({
      proposals: [proposal()],
      gateOutcomes: [
        outcomeEvent({ class: "retryable", status: "gate-abstained", reason: "interrupted" }),
        outcomeEvent({ proposalId: "pr-other", class: "retryable" }),
        outcomeEvent(),
      ],
    }),
  });

  assert.equal((await review(h, [{ kind: "select", answer: "Accept" }])).result, "accepted");
  assert.deepEqual(h.calls, ["accept"]);
});

test("reviewProposal: a probation proposal runs no gate and the dialog says it is not measured", async () => {
  const h = harness({ state: stateOf({ proposals: [proposal({ gate: "probation", bankPath: null, provenance: null })] }) });
  const { result, ui } = await review(h, [{ kind: "select", answer: "Accept" }]);

  assert.equal(result, "accepted");
  assert.deepEqual(h.calls, ["accept"]);
  assert.match(ui.shown[0]!.title.toLowerCase(), /not measured/);
  assert.deepEqual(h.acceptedWith, [PROBATION_OUTCOME]);
});

test("reviewProposal: a not-measurable gate answer reaches the dialog labeled not measured", async () => {
  const h = harness({
    state: stateOf({ proposals: [proposal()] }),
    gateResult: concluded("gate-abstained", "no-improvement"),
  });
  const { result, ui } = await review(h, [{ kind: "select", answer: "Accept" }]);

  assert.equal(result, "accepted");
  assert.match(ui.shown[0]!.title.toLowerCase(), /not measured/);
  assert.equal(h.acceptedWith[0]?.class, "not-measurable");
});

test("reviewProposal: an abort during the dialog persists nothing and accepts nothing", async () => {
  const controller = new AbortController();
  const h = harness({ state: stateOf({ proposals: [proposal()], gateOutcomes: [outcomeEvent()] }) });
  const pending = review(h, [{ kind: "select", answer: HANG }], controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const { result } = await pending;

  assert.equal(result, "declined");
  assert.deepEqual(h.appended, []);
  assert.deepEqual(h.calls, []);
});

test("reviewProposal: an abort during the gate records the outcome but opens no dialog", async () => {
  const controller = new AbortController();
  const h = harness({
    state: stateOf({ proposals: [proposal()] }),
    gateResult: concluded("gate-abstained", "interrupted"),
  });
  const inner = h.deps.runGate;
  h.deps.runGate = async (p, bankPath, signal) => {
    controller.abort();
    return inner(p, bankPath, signal);
  };
  const { result, ui } = await review(h, [], controller.signal);

  assert.equal(result, "retryable");
  assert.equal(ui.shown.length, 0);
  assert.deepEqual(ofType(h.appended, "gate-outcome").map((o) => o.class), ["retryable"]);
});

test("reviewProposal: a refused acceptance is retryable and reports why", async () => {
  const h = harness({
    state: stateOf({ proposals: [proposal()], gateOutcomes: [outcomeEvent()] }),
    acceptResult: { ok: false, error: { reason: "skill-drift", detail: "SKILL.md changed" } },
  });
  const { result, ui } = await review(h, [{ kind: "select", answer: "Accept" }]);

  assert.equal(result, "retryable");
  assert.equal(ui.notices.length, 1);
  assert.match(ui.notices[0]!.message, /skill-drift/);
  assert.match(ui.notices[0]!.message, /SKILL\.md changed/);
});

test("reviewProposal: its dependencies offer no reload, so a review can never reload", () => {
  const h = harness({ state: stateOf({}) });

  assert.deepEqual(Object.keys(h.deps).sort(), ["accept", "append", "isAccepted", "now", "promoteBank", "readState", "runGate", "viewOf"]);
});

const A_VIEW: ProposalView = {
  skill: "mde-pending-reviews",
  patternSummary: "lists drafts",
  observations: ["user: no drafts"],
  sessions: 2,
  days: 2,
  realRuns: 3,
  lesson: "Skip drafts.",
  gate: "bank",
  cwd: "/work/proj-a",
  bank: { provenance: "user", cases: [] },
};

test("reviewProposal: without an approved prompt (a) it asks (a) first, records it, and only then gates and asks (b)", async () => {
  const h = harness({ state: stateOf({ proposals: [proposal()] }), unapproved: true });
  const { result, ui } = await review(h, [
    { kind: "select", answer: "Approve" },
    { kind: "select", answer: "Accept" },
  ]);

  assert.equal(result, "accepted");
  assert.deepEqual(h.calls, ["promote", "gate", "accept"]);
  assert.equal(ui.shown[0]?.title, promptAText(A_VIEW));
  assert.equal(ui.shown[1]?.title, promptBText(A_VIEW, { class: "accepted", status: "gate-accepted", reason: null }));
  assert.deepEqual(ofType(h.appended, "prompt").map((p) => [p.stage, p.answer]), [["a", "approve"], ["b", "accept"]]);
});

test("reviewProposal: a probation proposal is also asked (a) before it can be accepted", async () => {
  const h = harness({ state: stateOf({ proposals: [proposal({ gate: "probation", bankPath: null, provenance: null })] }), unapproved: true });
  const { result, ui } = await review(h, [
    { kind: "select", answer: "Approve" },
    { kind: "select", answer: "Accept" },
  ]);

  assert.equal(result, "accepted");
  assert.equal(ui.shown.length, 2);
  assert.deepEqual(h.calls, ["accept"]);
});

test("reviewProposal: an (a) the user did not approve stops the review before any bank is promoted, any run is spent, or anything is accepted", async () => {
  for (const [answer, recorded, expected] of [
    ["Later", "later", "declined"],
    [TIMEOUT, "timeout", "declined"],
    ["Reject", "reject", "rejected"],
  ] as const) {
    const h = harness({ state: stateOf({ proposals: [proposal()] }), unapproved: true });
    const { result, ui } = await review(h, [{ kind: "select", answer }]);

    assert.equal(result, expected);
    assert.deepEqual(h.calls, []);
    assert.equal(ui.shown.length, 1);
    assert.deepEqual(ofType(h.appended, "prompt").map((p) => [p.stage, p.answer]), [["a", recorded]]);
    assert.deepEqual(ofType(h.appended, "tombstone").map((t) => t.reason), expected === "rejected" ? ["user-rejected"] : []);
  }
});

test("reviewProposal: an abort during (a) records nothing", async () => {
  const controller = new AbortController();
  const h = harness({ state: stateOf({ proposals: [proposal()] }), unapproved: true });
  const pending = review(h, [{ kind: "select", answer: HANG }], controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  assert.equal((await pending).result, "declined");
  assert.deepEqual(h.appended, []);
  assert.deepEqual(h.calls, []);
});

test("reviewProposal: a (a) approved for another proposal does not count", async () => {
  const h = harness({
    state: stateOf({ proposals: [proposal()], prompts: [approvalA({ proposalId: "pr-other" })] }),
    unapproved: true,
  });
  const { result, ui } = await review(h, [{ kind: "select", answer: "Later" }]);

  assert.equal(result, "declined");
  assert.equal(ui.shown[0]?.title, promptAText(A_VIEW));
});

test("reviewProposal: the gate runs against the path the bank was promoted to, and a proposal without a bank gates with null", async () => {
  const promoted = harness({ state: stateOf({ proposals: [proposal({ provenance: "auto", bankPath: "staging/bank-draft.json" })] }), promoted: "banks/mde-pending-reviews.json" });
  await review(promoted, [{ kind: "select", answer: "Later" }]);
  assert.deepEqual(promoted.calls, ["promote", "gate"]);
  assert.deepEqual(promoted.gatedAt, ["banks/mde-pending-reviews.json"]);

  const none = harness({ state: stateOf({ proposals: [proposal({ bankPath: null })] }), promoted: null });
  await review(none, [{ kind: "select", answer: "Later" }]);
  assert.deepEqual(none.gatedAt, [null]);
});

test("reviewProposal: a bank that cannot be promoted is reported and nothing is gated, asked or accepted", async () => {
  const h = harness({ state: stateOf({ proposals: [proposal()] }), promoteError: "banks/x.json already exists with other content" });
  const { result, ui } = await review(h, []);

  assert.equal(result, "retryable");
  assert.deepEqual(h.calls, ["promote"]);
  assert.equal(ui.shown.length, 0);
  assert.match(ui.notices[0]!.message, /already exists with other content/);
  assert.deepEqual(h.appended, []);
});

test("reviewProposal: an accepted lesson closes its pattern with an accepted tombstone for this candidate", async () => {
  const h = harness({ state: stateOf({ proposals: [proposal()], gateOutcomes: [outcomeEvent()] }) });
  assert.equal((await review(h, [{ kind: "select", answer: "Accept" }])).result, "accepted");

  const tombs = ofType(h.appended, "tombstone");
  assert.deepEqual(
    tombs.map((t) => [t.patternId, t.skill, t.reason, t.candidateHash]),
    [["pt-bbbbbbbbbbbb", "mde-pending-reviews", "accepted", "sha256:cand"]],
  );
});

test("reviewProposal: a refusal that may mend itself leaves the pattern open", async () => {
  for (const reason of ["no-longer-eligible", "slug-already-referenced", "history-exists", "reference-failed"] as const) {
    const h = harness({
      state: stateOf({ proposals: [proposal()], gateOutcomes: [outcomeEvent()] }),
      acceptResult: { ok: false, error: { reason, detail: "x" } },
    });
    assert.equal((await review(h, [{ kind: "select", answer: "Accept" }])).result, "retryable", reason);

    assert.equal(ofType(h.appended, "tombstone").length, 0, reason);
  }
});

test("reviewProposal: an acceptance refused as skill-drift closes this proposal with a stale tombstone carrying its candidate hash", async () => {
  const h = harness({
    state: stateOf({ proposals: [proposal()], gateOutcomes: [outcomeEvent()] }),
    acceptResult: { ok: false, error: { reason: "skill-drift", detail: "SKILL.md changed" } },
  });
  const { result } = await review(h, [{ kind: "select", answer: "Accept" }]);

  assert.equal(result, "retryable");
  assert.deepEqual(
    ofType(h.appended, "tombstone").map((t) => [t.patternId, t.skill, t.reason, t.candidateHash]),
    [["pt-bbbbbbbbbbbb", "mde-pending-reviews", "stale", "sha256:cand"]],
  );
});

test("reviewProposal: once closed as stale the proposal is not reviewed again", async () => {
  const closed = harness({
    state: stateOf({ proposals: [proposal()], gateOutcomes: [outcomeEvent()] }),
    acceptResult: { ok: false, error: { reason: "skill-drift", detail: "SKILL.md changed" } },
  });
  await review(closed, [{ kind: "select", answer: "Accept" }]);

  const again = harness({ state: stateOf({ proposals: [proposal()], gateOutcomes: [outcomeEvent()], tombstones: ofType(closed.appended, "tombstone") }) });
  const { result, ui } = await review(again, []);
  assert.equal(result, "nothing-to-review");
  assert.equal(ui.shown.length, 0);
  assert.deepEqual(again.calls, []);
});

test("reviewProposal: a legacy proposal without the hash of its skill is closed as stale, asks nothing and accepts nothing", async () => {
  for (const legacy of [undefined, ""]) {
    const old = { ...proposal(), skillContentHash: legacy } as unknown as ProposalEvent;
    const h = harness({ state: stateOf({ proposals: [old], gateOutcomes: [outcomeEvent()] }) });
    const { result, ui } = await review(h, []);

    assert.equal(result, "nothing-to-review");
    assert.equal(ui.shown.length, 0);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(
      ofType(h.appended, "tombstone").map((t) => [t.reason, t.candidateHash]),
      [["stale", "sha256:cand"]],
    );
    assert.equal(ui.notices.length, 1);
  }
});

test("reviewProposal: only the latest proposal of a pattern is live; an older one is not reviewed, gated or asked about", async () => {
  const older = proposal({ id: "pr-aaaaaaaaaaaa", at: "2026-11-15T12:00:00.000Z", candidateHash: "sha256:older" });
  const latest = proposal({ id: "pr-cccccccccccc", at: "2026-11-16T11:00:00.000Z", candidateHash: "sha256:latest" });
  // Listed latest first: the order of the list does not decide.
  const state = stateOf({ proposals: [latest, older], gateOutcomes: [outcomeEvent()] });

  const stale = harness({ state });
  const { result, ui } = await review(stale, []);
  assert.equal(result, "nothing-to-review");
  assert.equal(ui.shown.length, 0);
  assert.deepEqual(stale.calls, []);

  const live = harness({ state });
  const ofLatest = fakeUi([{ kind: "select", answer: "Later" }]);
  assert.equal(await reviewProposal("pr-cccccccccccc", { ui: ofLatest.ui }, live.deps), "declined");
  assert.equal(ofLatest.shown.length, 1);
});

test("latestProposals: the latest proposal of each pattern, by `at`, whatever the order of the list", () => {
  const p1a = proposal({ id: "pr-111111111111", patternId: "pt-1", at: "2026-11-14T00:00:00.000Z" });
  const p1b = proposal({ id: "pr-222222222222", patternId: "pt-1", at: "2026-11-15T00:00:00.000Z" });
  const p2 = proposal({ id: "pr-333333333333", patternId: "pt-2", at: "2026-11-13T00:00:00.000Z" });

  assert.deepEqual(
    latestProposals(stateOf({ proposals: [p1b, p2, p1a] })).map((p) => p.id).sort(),
    ["pr-222222222222", "pr-333333333333"],
  );
});

function apiOf(onSend?: () => unknown) {
  const sent: { text: string; options: unknown }[] = [];
  const notices: { message: string; type: string | undefined }[] = [];
  const api: ReviewApi = {
    sendUserMessage(text, options) {
      sent.push({ text, options });
      return onSend?.();
    },
    notify(message, type) {
      notices.push({ message, type });
    },
  };
  return { api, sent, notices };
}

test("dispatchReview: command sends the review command with template expansion at once", () => {
  const { api, sent, notices } = apiOf();

  dispatchReview(api, () => false, () => assert.fail("must not defer"), "pr-x", "command");

  assert.deepEqual(sent, [{ text: "/skill-improve --review=pr-x", options: { expandPromptTemplates: true } }]);
  assert.equal(notices.length, 0);
});

test("dispatchReview: deferred-command sends at once when idle", () => {
  const { api, sent } = apiOf();

  dispatchReview(api, () => true, () => assert.fail("must not defer"), "pr-x", "deferred-command");

  assert.equal(sent.length, 1);
});

test("dispatchReview: deferred-command waits for the settle callback when streaming, then re-checks idle", () => {
  const { api, sent, notices } = apiOf();
  let settled: (() => void) | undefined;
  let idle = false;

  dispatchReview(api, () => idle, (cb) => (settled = cb), "pr-x", "deferred-command");
  assert.equal(sent.length, 0);
  assert.notEqual(settled, undefined);

  idle = true;
  settled!();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.text, "/skill-improve --review=pr-x");
  assert.equal(notices.length, 0);
});

test("dispatchReview: if the session is busy again at settle time it only shows a notice", () => {
  const { api, sent, notices } = apiOf();
  let settled: (() => void) | undefined;

  dispatchReview(api, () => false, (cb) => (settled = cb), "pr-x", "deferred-command");
  settled!();

  assert.equal(sent.length, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.message, /\/skill-improve --review=pr-x/);
});

test("dispatchReview: notice mode sends nothing and names the command to run", () => {
  const { api, sent, notices } = apiOf();

  dispatchReview(api, () => true, () => assert.fail("must not defer"), "pr-x", "notice");

  assert.equal(sent.length, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.message, /\/skill-improve --review=pr-x/);
});

test("dispatchReview: a sender that throws or rejects becomes a notice, never an exception", async () => {
  const thrower = apiOf(() => {
    throw new Error("boom");
  });
  assert.doesNotThrow(() => dispatchReview(thrower.api, () => true, () => {}, "pr-x", "command"));
  assert.equal(thrower.notices.length, 1);
  assert.match(thrower.notices[0]!.message, /boom/);

  const rejecter = apiOf(() => Promise.reject(new Error("later boom")));
  dispatchReview(rejecter.api, () => true, () => {}, "pr-x", "command");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejecter.notices.length, 1);
  assert.match(rejecter.notices[0]!.message, /later boom/);
});
