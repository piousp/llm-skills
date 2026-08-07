# Refactor — Candidates, Apply, Simplify, One Combined Review

Optional phase — enter only on an explicit "run" at the Phase 4 gate (`SKILL.md`), with the
answer already recorded in `$DESIGN_DIR/decisions.md`. If the user chose "skip", none of this file
runs: no candidates, no simplification, no combined review pass — Phase 5 (if run) reviews the
files Phase 3 touched — the file list in the `phase3-green` freeze entry of
`$DESIGN_DIR/decisions.md`.

Single refactor phase over the green implementation (Phase 3). The **planner** detects candidates
(read-only); the **implementer** applies them and simplifies (delegate to **`code-implementer`**,
`Mode: refactor`, with `lens/code-implementer-lens.md` as its lens;
`tools: ["read", "grep", "find", "ls", "write", "edit"]`, `skills: []` per invocation — see
`SKILL.md`'s Subagent cast for why, same reinforcement rule); one
frozen-test re-run and one combined review pass (**`analyst`** applying the `code-review-checklist`
skill) close the phase.

## Preflight

1. Use `pablo-code-philosophy` as the standard both the candidates and the simplification pass are
   validated against.

## How to run

1. **Detect.** Delegate to the **`planner`** subagent (`skills: []`) to run `refactor-identification`
   (read-only) against the green implementation and the frozen tests (Phase 3 artifacts) — do not
   modify tests. Self-contained prompt:

   > Lens: read and apply `lens/planner-lens.md` before analyzing;
   > if you cannot read it, make no changes and say so. This invocation is the lens's
   > refactor-candidate detection mode, not initial design.
   >
   > Base method: this code passes its frozen tests (Phase 3) and follows the Phase 2 design
   > (`$DESIGN_DIR/plan.md` + `$DESIGN_DIR/technical.md`). Apply `refactor-identification` to the files
   > Phase 3 touched (the file list recorded in the `phase3-green` freeze entry of
   > `$DESIGN_DIR/decisions.md`): missing/misplaced abstractions, weak encapsulation, poor data types, flag/enum-
   > modeled variants that a sealed alternative fits better. File:line evidence required for
   > every candidate. Do not edit anything.

2. **Decide.** Review the candidates with the user. Each needs file:line evidence and a case for why
   it isn't over-engineering (YAGNI/KISS gate) — reject speculative ones. Surface every load-bearing
   decision explicitly. Present a synthesis of the candidates (and, at exit, of what was applied)
   in the chat before asking for confirmation (coordinator rule, `SKILL.md`). Append every rejected
   candidate (and why — YAGNI/KISS, out of scope, too
   risky) to `$DESIGN_DIR/decisions.md`: the record of what was deliberately not refactored is
   load-bearing for QA and for resuming the session.
3. **Apply.** Delegate to the **implementer** (refactor mode) to apply the accepted candidates
   only, re-validating each against `pablo-code-philosophy` (data-structures-first, composition
   over inheritance, low complexity) as it goes. No behavior change. Compartmentalize: apply
   **the first bucket only**, then stop at a checkpoint for review. Prompt:

   > Mode: refactor. Lens: lens/code-implementer-lens.md. Accepted
   > candidates (user-approved, file:line evidence each): <paste>. Frozen tests (do not modify):
   > <selector>. Simplification pass: NOT in scope for this invocation. Apply the first bucket
   > only, then stop.

Append the implementer's "Changed files" output to the running `## Phase 4 — files touched` entry
in `$DESIGN_DIR/decisions.md` after each bucket delegation.

4. **Simplify.** Once accepted candidates are applied, delegate to the **implementer** for one
   more simplification/cleanup pass on the result: dead code, redundant indirection, naming,
   altitude mismatches — still `pablo-code-philosophy`, still no behavior change. This is a
   standalone refactor-mode invocation — the prompt must explicitly list the files this phase
   touched (it cannot compute that itself, no git/shell). Prompt:

   > Mode: refactor. Lens: lens/code-implementer-lens.md. No
   > candidates in this invocation — standalone simplification pass over exactly these files this
   > phase touched: <explicit list>.

Append the implementer's "Changed files" output to the running `## Phase 4 — files touched` entry
in `$DESIGN_DIR/decisions.md` after this simplification delegation.

## Verify (once, combined)

1. Delegate the frozen-test selector (Phase 3 artifact) to your build/test subagent — a regression
   here must be fixed before moving to Phase 5.
2. Delegate once to **`analyst`** (`skills: []` — the lens
   arrives by path below, not by skill discovery; no `tools` param, analyst's own frontmatter is
   right for this and its read-only discipline is doctrine, not a tool filter):

   > Lens: read and apply `code-review-checklist/SKILL.md`; if unreadable, stop
   > and report — run no default review. Review the files this phase touched — the Phase 4
   > files-touched record in `$DESIGN_DIR/decisions.md` — the single combined review covering the
   > applied candidates and the simplification pass together. Use the lens's output format and
   > verdict scheme (READY | NEEDS WORK) exactly.

   Do not run it twice.
3. If the combined review's findings are addressed with further edits, re-run the frozen tests
   again before Phase 5 — do not carry forward a green status from before those edits.

## Exit criteria

Refactored implementation: evidence-backed candidates applied, simplified, `pablo-code-philosophy`
conformant, behavior unchanged. Frozen tests still green and the combined review passes (or its
violations are addressed, with a re-run confirming green per step 3 above) for the combined diff —
a single gate before Phase 5. Accepted/rejected candidates are logged in `$DESIGN_DIR/decisions.md`.

Before moving to Phase 5, append a completion entry to `$DESIGN_DIR/decisions.md`: `## Phase 4 —
complete (<date>)` with a one-line `Decision:` summarizing what was applied. Present a synthesis of
the candidates (and, at exit, of what was applied) in the chat before asking for confirmation
(coordinator rule, `SKILL.md`). This is not a
routine per-seam confirmation (the kind `decisions.md` otherwise discourages) — it's the single
signal `scripts/state.py` reads to know Phase 4 is done rather than still in progress; omitting
it leaves the pipeline reporting Phase 4 as active indefinitely.
