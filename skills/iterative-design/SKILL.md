---
name: iterative-design
description: >
  Pablo's coordinator method for building code: a TODO list, goal discovery,
  a planner subagent that designs (no implementation) and writes plan.md, a
  single vertical TDD loop applying pablo-code-philosophy directly, one
  combined refactor phase (refactor-identification candidates, then
  simplification/cleanup, verified once), and a final qa-adversary gate.
  Fully interactive — no background workflow. The lead agent is a
  coordinator: it explores and reads freely but never writes code, runs
  tests, or refactors itself — that work always goes to a subagent.
---

# Iterative Design

Always invoked by name (no auto-trigger). Every phase is synchronous and confirmed by you —
there is no autonomous background stage.

# *CRITICAL*

Never advance to the next phase until the user confirms so.
ALWAYS resist the urge to start coding; value precision and good software development practices
over speed. Speed is irrelevant.

## The coordinator rule

The lead agent running this skill is a **coordinator, not an executor**. It may explore and read
freely — files, history, existing code — to understand context and drive the conversation. It
must never itself write code, edit tests, run a build/test command, or apply a refactor. Every one
of those actions is delegated to one of the subagent roles below. If your harness has no
subagent/delegation mechanism, say so explicitly before proceeding rather than doing the work
yourself.

## Subagent cast

Two generic roles and two concrete subagents, used across the phases below. Invoke the generic
roles however your harness delegates work (a subagent tool, a task/agent call, etc.) — the role is
what matters, not the syntax. `code-review-checklist` and `qa-adversary` are specific, named
subagents — invoke them by name.

- **planner** — the most capable model/subagent available. Read-only: explores the codebase and
  designs, but never implements. Produces `plan.md` (Phase 2) and, later, refactor candidates via
  `refactor-identification` (Phase 4). Never edits code.
- **implementer** — writes tests and code, applies refactors, and runs the build/test cycle (via
  your harness's build/test subagent or tool if that's a separate delegation). Used in Phase 3 and
  to apply Phase 4's refactor candidates. Generic role — name it to whatever implementation
  subagent your harness provides.
- **`code-review-checklist`** — a concrete subagent, not a generic role. Invoke it by name in
  Phase 4.
- **`qa-adversary`** — a concrete subagent, not a generic role. Invoke it by name in Phase 5:
  read-only, never runs tests, never edits.

## Phase 0 — TODO list

Before anything else, set up a durable task list for the phases ahead (Phase 1 through 5, plus
their sub-steps). If your harness exposes a native TODO/task-tracking tool, use it. If it doesn't,
create a portable `todo.md` checklist file in the repo (or working directory) as the source of
truth, and keep it updated as phases and sub-steps complete.

## Phase 1 — Goal discovery

Interview me relentlessly about every aspect of this until we reach a shared understanding for
the goal (the decision this work drives, not the task named). Walk down each branch of the decision tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a *fact* can be found by exploring the environment (filesystem, tools, etc.), look it up rather than asking me. The *decisions*, though, are mine — put each one to me and wait for my answer.

Do not act on it until I confirm we have reached a shared understanding.

The exit condition: Goal is discovered and 100% understood and unambiguous. Tasks are the steps to reach the goal.

## Phase 2 — Planner

Read [stages/planner.md](stages/planner.md)

Delegate to the **planner** subagent: given the confirmed goal (Phase 1), explore the codebase and
design a solution — seams, interfaces, sequencing, tradeoffs — without implementing anything.
Output is `plan.md`, a durable artifact other subagents (and phases) implement against. Planner is
read-only end to end.

## Phase 3 — TDD (spec, RED, GREEN)

Read [stages/tdd.md](stages/tdd.md)

One vertical loop, not two bulk phases: agree the seams (anchored on `plan.md`), then per seam
write the failing test, confirm it fails for the right reason, write the minimal code to pass,
confirm green, next seam. `pablo-code-philosophy` is applied directly while co-designing and
implementing each seam — not deferred to a later review. Freezes the test set at the end.

## Phase 4 — Refactor (candidates, apply, simplify, one combined review)

Read [stages/refactor.md](stages/refactor.md)

Single refactor phase, replacing the old two-phase split. The **planner** runs
`refactor-identification` (read-only) against the green implementation to surface evidence-backed
candidates. The **implementer** applies the accepted candidates, then does a simplification/cleanup
pass. Ends with a frozen-test re-run and ONE `code-review-checklist` pass (invoked by name) over
the cumulative diff.

## Phase 5 — QA (final gate)

Delegate to `qa-adversary` by name — read-only, never runs tests, never edits. Self-contained
prompt:

> Frozen tests (Phase 3 artifact): <selector>. Current implementation (after Phase 4's refactor):
> <path>. Diff since Phase 3's GREEN checkpoint (cumulative Phase 4 diff — the same diff
> code-review-checklist reviewed): <diff or commit range>. QA this change: hunt for correctness
> bugs, data-handling mistakes, business-rule violations, regressions, and check integration test
> coverage. Give your PASS or BLOCK verdict with findings.

Report its verdict **verbatim** to the user first, then your own comments. A BLOCK is not "done" —
fix and re-run from the relevant phase; do not silently patch past its objection.

## Anti-patterns

- Running Phases 0–5 as isolated one-shots instead of a single confirmed thread — each phase
  builds on the previous one's confirmed output.
- The coordinator writing code, editing tests, running builds/tests, or applying a refactor itself
  instead of delegating to **implementer** — even "just a quick fix."
- Splitting Phase 3 back into a bulk "write all tests" pass followed by a bulk "write all
  implementation" pass — that's the `tdd` skill's "horizontal slicing" anti-pattern this method
  was restructured to avoid. Stay vertical: one seam, one test, one minimal implementation.
- Skipping `plan.md` or treating it (or the Phase 3 spec) as a chat message instead of a file —
  later phases need them as durable artifacts.
- Letting the **planner** implement or edit code directly, in Phase 2 or Phase 4 — it only designs
  and surfaces candidates; the **implementer** applies, you decide what's in scope.
- Skipping the frozen-test re-run or the single combined `code-review-checklist` at the end of
  Phase 4 before moving to Phase 5 — a regression must surface and be isolated to Phase 4, since
  `qa-adversary` never runs tests itself.

## Handoff

TODO list (Phase 0) → confirmed goal (Phase 1) → plan.md (Phase 2) → spec + frozen tests + green
implementation (Phase 3, one vertical TDD loop) → refactor-identification candidates applied +
simplification + combined review (Phase 4) → `qa-adversary` verdict reported verbatim (Phase 5).
