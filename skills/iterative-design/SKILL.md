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
appends to `decisions.md` as the one durable, auditable log. The carve-out also covers recording
the checkpoint hash (e.g. the Phase 3 freeze) into `decisions.md` — not code, a build, or a test.

**The coordinator never runs a git command that mutates repo state** — no `git commit`, `git add`,
`git tag`, `git stash`, `git reset`, `git checkout -b`, or any other write. It may only use
read-only git (`git rev-parse HEAD`, `git diff`, `git log`, `git merge-base`) to *read* the hash
the user's own workflow already produced. Checkpoints are recorded as **hashes read from existing
HEAD**, never created by tagging or committing on the coordinator's behalf. If HEAD has
uncommitted changes at a checkpoint, the coordinator tells the user and asks them to commit (or
confirms proceeding uncommitted) — it never commits for them.

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

## Control flow: `scripts/state.py`

Phase sequencing, gate status, and checkpoint bookkeeping are mechanical — a
pure function of what's on disk in `.design/` and git HEAD, not a judgment
call. Rather than re-deriving "what phase are we in" from context every turn,
run `python3 <skill-dir>/scripts/state.py next --dir <repo-root>` at phase
boundaries (after closing a phase, or when unsure what comes next). It reads
`.design/*.md` and git HEAD **read-only** and prints JSON: `phase`,
`next_action`, `actor`, `required_inputs`, `gate_status`, `blocked_reason`.

This script is advisory, not enforcing: it never prompts the user, never
writes anything, and never invokes a subagent itself — it only reports what
the artifacts already say. The coordinator remains the sole executor and
sole writer of `.design/`.

It also returns `stage_file`: an absolute path to the `stages/*.md` file for
the reported phase, or `null` when there's nothing to execute (an unanswered
gate, or `phase: "done"`). Run the loop:

1. Run `state.py next`.
2. If `gate_status: "unanswered"` — ask the user the gate question (wording
   in "Optional phases — the gate" below), do nothing until answered
   unambiguously, append the answer to `.design/decisions.md`, go to 1.
3. Elif `stage_file` is non-null — `read` it and execute it (its own
   user-confirmation points still apply), go to 1.
4. Elif `phase: "done"` — do the handoff (below) and stop.

Phases 1–3 are mandatory (the script always reports them while their
artifacts are missing, never gates them); phases 4–5 are gated per "Optional
phases — the gate" below.

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

`scripts/state.py` also parses `decisions.md` (and `phase3-green` in particular) to derive
pipeline state mechanically — this makes three specific strings a **contract**, not just
audit-trail prose, and drifting from them silently breaks phase detection rather than just the
record: (1) the `phase3-green` token recorded at the Phase 3 freeze; (2) a gate entry's `## `
header must contain both the phase label ("Phase 4" / "Phase 5") and the word "gate" — e.g.
`## Phase 4 — gate: skip (<date>)`, fitting the general format above; (3) Phase 4's completion
entry must contain "Phase 4" and either "complete" or "combined review" in its header (see
`stages/refactor.md`'s exit criteria); (4) Phase 5's completion entry must contain "Phase 5" and
"complete" in its header, written only on a PASS verdict (see `stages/qa.md`'s exit criteria).

## Optional phases — the gate

Phases 4 (refactor) and 5 (QA) are **optional**. Phase 3 is **not** — it produces the code, the
spec, and the frozen tests; it is the mandatory core of the method and is never skipped.

When `scripts/state.py next` reports `gate_status: "unanswered"` for a phase, stop and ask the
user, using exactly this shape, and do nothing until answered:

- **Phase 4 gate**:

  > Phase 3 is green, frozen, and checkpointed at `phase3-green` (commit `<hash>`). Phase 4
  > (refactor + one `code-review-checklist` pass) is optional. Run Phase 4, or skip to Phase 5?
  > [run / skip]

- **Phase 5 gate**:

  > Phase 5 (`qa-adversary` final QA gate) is optional. Run Phase 5, or finish here?
  > [run / finish]

Append the answer (and the user's reason, when given) to `.design/decisions.md` **before** acting
on it, using the gate-header contract above. Skipping is never the coordinator's own call: no
explicit gate answer, no skip. If the
reply is not unambiguously "run" or "skip"/"finish" (e.g. a conditional or partial answer),
re-ask for a clear choice — never infer skip from an ambiguous reply. Skipping
Phase 4 also skips its `code-review-checklist` — do not run the checklist standalone; in that
case Phase 5's `qa-adversary` is the first and only reviewer of the implementation.

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

Run `scripts/state.py next` at any point for the current pipeline position — it derives the
phase sequence from `.design/` directly, so it isn't restated here. When the run reaches its end
(Phase 5 complete, or an earlier phase skipped to completion), report to the user: the final
`.design/` artifacts produced, every gate answer and load-bearing decision from `decisions.md`,
and — if Phase 5 ran — its verdict reported verbatim.
