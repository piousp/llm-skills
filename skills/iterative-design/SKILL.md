---
name: iterative-design
description: >
  Pablo's coordinator method for building code: goal discovery, a planner
  subagent that designs, a mandatory TDD loop, then optional refactor and QA
  phases. Durable design artifacts live in .design/. The lead agent is a
  coordinator — it never writes code or runs tests itself; that always goes
  to a subagent.
---

# Iterative Design

Always invoked by name (no auto-trigger).

# *CRITICAL*

**Never advance to the next phase until the user confirms so**
**ALWAYS resist the urge to start coding; value precision and good software development practices over speed**

## The coordinator rule

The lead agent running this skill is a **coordinator, not an executor**. It may explore and read
freely — files, history, existing code — to understand context and drive the conversation. It
must never itself write code, edit tests, run a build/test command, or apply a refactor. Every one
of those actions is delegated to one of the subagent roles below. If your harness has no
subagent/delegation mechanism, say so explicitly before proceeding rather than doing the work
yourself.

One explicit carve-out: the coordinator itself writes and maintains the `.design/` artifacts
(`goal.md`, `plan.md`, `technical.md`, `spec.md`, `decisions.md`). This is not a document-vs-code
distinction — it's ownership of shared durable state. Subagents run forked/isolated with no view
of the full thread or prior-phase decisions; they return proposals in text, never truth. The
coordinator is the only party with the global view, so it is the single writer that serializes
writes, validates a subagent's output (e.g. the planner's markers) before persisting it, and
appends to `decisions.md` as the one durable, auditable log. The carve-out also covers checkpoint
tags/commits (e.g. `phase3-green`) — not code, a build, or a test.

If marker-parsing fidelity from a subagent's text response ever proves fragile in practice, the
established alternative is role-scoped staging (e.g. `.design/.staging/planner/`) that the
subagent writes and the coordinator promotes after validation — this keeps single-writer
ownership of the canonical `.design/` state while dropping the chat round-trip. Not adopted by
default; only worth it if the marker-based re-delegate/fallback in `stages/planner.md` turns out
to be insufficient.

## Subagent cast

Two roles and two concrete subagents, used across the phases below. `pablo-planner`,
`pablo-implementer`, `code-review-checklist`, and `qa-adversary` are all specific, named
subagents — invoke them by name when your harness has them configured. If a named agent isn't
available, fall back to the generic role description and delegate however your harness does work
(a subagent tool, a task/agent call, etc.) — the role is what matters, not the syntax.

- **planner** (concrete: **`pablo-planner`**) — the most capable model/subagent available.
  Read-only: explores the codebase and designs, but never implements. In Phase 2 it returns **one
  document with two delimited sections** (Plan / Technical) that the **coordinator** splits and
  persists as `.design/plan.md` and `.design/technical.md`. Later it surfaces refactor candidates
  via `refactor-identification` (Phase 4, if run). Never edits code. `pablo-planner` embeds
  `pablo-code-philosophy` and runs in a fresh context — invocation prompts don't need to
  repeat the philosophy, only the design inputs (goal, constraints, prior decisions).
- **implementer** (concrete: **`pablo-implementer`**) — writes tests and code, applies refactors;
  the coordinator runs the build/test cycle separately (via your harness's build/test subagent or
  tool), never the implementer itself. Used in Phase 3 (TDD mode, plus **repair mode** when a
  seam's test/implementation doesn't go green as predicted) and Phase 4 (refactor mode, applying
  accepted candidates and the standalone simplification pass). Exactly one mode per invocation,
  stated in the prompt. `pablo-implementer` embeds `tdd` and `pablo-code-philosophy` and runs
  in a fresh context — invocation prompts don't need to repeat either skill, only the mode,
  the seam/candidates, and any required file lists (it has no git/shell to compute a diff itself).
- **`code-review-checklist`** — a concrete subagent, not a generic role. Invoke it by name in
  Phase 4.
- **`qa-adversary`** — a concrete subagent, not a generic role. Invoke it by name in Phase 5:
  read-only, never runs tests, never edits.

## Phase 0 — TODO list

Before anything else, set up a durable task list for the phases ahead (Phase 1 through 5, plus
their sub-steps). If your harness exposes a native TODO/task-tracking tool, use it. If it doesn't,
create a portable `todo.md` checklist file in the repo (or working directory) as the source of
truth, and keep it updated as phases and sub-steps complete.

## The `.design/` directory

All durable design artifacts this skill controls live in `.design/` at the repo root (or working
directory root). The coordinator creates the directory on first write and owns every file in it.
Artifacts are files, never chat messages. Whether `.design/` is committed or gitignored is the
user's call — the coordinator never edits `.gitignore`.

| File                  | Written by  | When                                                        | Content |
|-----------------------|-------------|--------------------------------------------------------------|---------|
| `.design/goal.md`     | coordinator | Closing Phase 1, on user confirmation                       | The user's original prompt **verbatim**, then the Phase 1 discovery outcome: decisions made, constraints, relevant facts found |
| `.design/plan.md`     | coordinator | Phase 2, split from the planner's returned document         | Logistical plan: work sequence, buckets, dependencies, order of seams |
| `.design/technical.md`| coordinator | Phase 2, split from the planner's returned document         | Technical design: public interfaces, contracts, data structures, gotchas for the implementer |
| `.design/spec.md`     | coordinator | Phase 3, before the first seam is delegated                 | The co-designed spec (as today, relocated) |
| `.design/decisions.md`| coordinator | **Append-only**, across all phases                          | Load-bearing decisions only: gate answers (phases skipped and why), tradeoffs chosen, refactor candidates rejected, plan divergences reconciled — not routine per-seam confirmations |

`decisions.md` entry format — append, never rewrite or delete:

    ## Phase <N> — <short title> (<date>)
    - Decision: <what was decided>
    - Why: <rationale, in the user's words where given>
    - Rejected: <alternatives or candidates not taken, if any>

`decisions.md` exists for auditability and for resuming a session: a fresh coordinator reading
`.design/` must be able to tell which phases ran, which were skipped and why, and what was
deliberately not done.

## Phase 1 — Goal discovery

Interview the user relentlessly about every aspect of this until we reach a shared understanding for
the goal (the decision this work drives, not the task named). Walk down each branch of the decision tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a *fact* can be found by exploring the environment (filesystem, tools, etc.), look it up rather than asking the user. The *decisions*, though, are the user's — put each one to them and wait for their answer.

Do not act on it until the user confirms we have reached a shared understanding.

The exit condition: Goal is discovered and 100% understood and unambiguous.

On confirmation, the coordinator writes `.design/goal.md` — the original prompt verbatim plus
the discovery outcome — and seeds `.design/decisions.md` with its first entry (goal confirmed,
plus any load-bearing decisions taken during discovery). Phase 2 must not start before
`goal.md` exists.

## Phase 2 — Planner

Read [stages/planner.md](stages/planner.md)

Delegate to the **planner** subagent for the design (seams, interfaces, sequencing, tradeoffs) —
read-only, no implementation. Produces `.design/plan.md` + `.design/technical.md` (details in the
stage file).

## Phase 3 — TDD (spec, RED, GREEN)

Read [stages/tdd.md](stages/tdd.md)

One vertical TDD loop over the Phase 2 design (details in the stage file). Freezes tests and
tags `phase3-green` at the end. **Mandatory** — never skipped.

## Optional phases — the gate

Phases 4 (refactor) and 5 (QA) are **optional**. Phase 3 is **not** — it produces the code, the
spec, and the frozen tests; it is the mandatory core of the method and is never skipped.

On reaching each optional phase, the coordinator stops and asks the user, using exactly this
shape, and does nothing until answered:

- **Phase 4 gate** — immediately after Phase 3's freeze and the `phase3-green` tag:

  > Phase 3 is green, frozen, and tagged `phase3-green`. Phase 4 (refactor + one
  > `code-review-checklist` pass) is optional. Run Phase 4, or skip to Phase 5? [run / skip]

- **Phase 5 gate** — after Phase 4 completes, or immediately after a Phase 4 skip:

  > Phase 5 (`qa-adversary` final QA gate) is optional. Run Phase 5, or finish here?
  > [run / finish]

Append the answer (and the user's reason, when given) to `.design/decisions.md` **before** acting
on it. Skipping is never the coordinator's own call: no explicit gate answer, no skip. If the
reply is not unambiguously "run" or "skip"/"finish" (e.g. a conditional or partial answer),
re-ask for a clear choice — never infer skip from an ambiguous reply. Skipping
Phase 4 also skips its `code-review-checklist` — do not run the checklist standalone; in that
case Phase 5's `qa-adversary` is the first and only reviewer of the implementation. If both
optional phases are skipped, the run ends at the `phase3-green` state; the Handoff reflects that.

## Phase 4 — Refactor (candidates, apply, simplify, one combined review)

Read [stages/refactor.md](stages/refactor.md)

Enter only on an explicit "run" at the Phase 4 gate above (details in the stage file).

## Phase 5 — QA (final gate)

Optional — enter only on an explicit "run" at the Phase 5 gate, already recorded in
`.design/decisions.md`.

Delegate to `qa-adversary` by name — read-only, never runs tests, never edits. Self-contained
prompt; pick the variant matching the Phase 4 gate decision:

**If Phase 4 ran:**

> Frozen tests (Phase 3 artifact): <selector>. Current implementation (after Phase 4's refactor):
> <path>. Diff since the `phase3-green` tag (cumulative Phase 4 diff — the same diff
> `code-review-checklist` reviewed): <diff or commit range>. QA this change: hunt for correctness
> bugs, data-handling mistakes, business-rule violations, regressions, and check integration test
> coverage. Give your PASS or BLOCK verdict with findings.

**If Phase 4 was skipped:**

> Frozen tests (Phase 3 artifact): <selector>. Current implementation (Phase 3 output — Phase 4
> was skipped): <path>. Implementation diff, anchored on the full change since before Phase 3
> began: `<base>..phase3-green`, where `<base>` is the pre-work baseline recorded in
> `.design/decisions.md` at the Phase 3 freeze (merge-base with the main branch; if unavailable,
> the commit before Phase 3 began) — not `phase3-green..HEAD`, which would be empty. This code
> has NOT been through `code-review-checklist` — you are its first reviewer. QA
> this change: hunt for correctness bugs, data-handling mistakes, business-rule violations,
> regressions, and check integration test coverage. Give your PASS or BLOCK verdict with
> findings.

Report its verdict **verbatim** to the user first, then your own comments. A BLOCK is not "done" —
fix and re-run from the relevant phase; do not silently patch past its objection. If Phase 4 was
skipped and the BLOCK findings are refactor-shaped, reopening Phase 4 is allowed — append the
reversal to `.design/decisions.md`. Counts toward the shared iteration budget below — do not
cycle Phase 3/4 → 5 → 3/4 indefinitely.

## Iteration budget & escalation

Cap retries everywhere a fix-and-recheck loop could otherwise run unbounded: max 2 attempts per
seam (Phase 3 red→green), per refactor candidate (Phase 4), and per `qa-adversary` BLOCK re-run
cycle (Phase 5) — an attempt is one full delegation cycle; max 2 = the original try plus one
retry. On hitting the cap, stop and escalate to the user with what was tried, the exact failure,
and the options — never loop silently past it, and never let the coordinator "help" by patching
it directly.

## Anti-patterns

- Running Phases 0–5 as isolated one-shots instead of a single confirmed thread — each phase
  builds on the previous one's confirmed output.
- The coordinator writing code, editing tests, running builds/tests, or applying a refactor itself
  instead of delegating to **implementer** — even "just a quick fix."
- Splitting Phase 3 back into a bulk "write all tests" pass followed by a bulk "write all
  implementation" pass — horizontal slicing. Stay vertical: one seam, one test, one minimal
  implementation.
- Skipping the `.design/` artifacts or treating any of them (`goal.md`, `plan.md`,
  `technical.md`, `spec.md`, `decisions.md`) as a chat message instead of a file — later phases
  and session resumes need them as durable artifacts.
- Letting the **planner** implement or edit code directly, in Phase 2 or Phase 4 — it only designs
  and surfaces candidates; the **implementer** applies, you decide what's in scope.
- Skipping the frozen-test re-run or the single combined `code-review-checklist` at the end of
  Phase 4 **when Phase 4 runs** before moving to Phase 5 — a regression must surface and be
  isolated to Phase 4, since `qa-adversary` never runs tests itself.
- Skipping Phase 4 or Phase 5 without the user's explicit gate answer and a
  `.design/decisions.md` entry — optional means user-gated, not coordinator-decided. Phase 3 is
  never skippable.
- Letting the planner (or any subagent) write `.design/` files directly — the coordinator owns
  the split of the planner document and every write into `.design/`.

## Handoff

TODO list (Phase 0) → confirmed goal + `.design/goal.md` (Phase 1) → `.design/plan.md` +
`.design/technical.md` (Phase 2, split by the coordinator from the planner's single document) →
`.design/spec.md` + frozen tests + green implementation + `phase3-green` tag (Phase 3, mandatory,
one vertical TDD loop) → [gate] candidates applied + simplification + combined review (Phase 4,
optional) → [gate] `qa-adversary` verdict reported verbatim (Phase 5, optional) — every gate
answer and load-bearing decision appended to `.design/decisions.md`.
