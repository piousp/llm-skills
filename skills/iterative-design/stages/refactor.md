# Refactor — Candidates, Apply, Simplify, One Combined Review

Optional phase — enter only on an explicit "run" at the Phase 4 gate (`SKILL.md`), with the
answer already recorded in `.design/decisions.md`. If the user chose "skip", none of this file
runs: no candidates, no simplification, no `code-review-checklist` — Phase 5 (if run) diffs
directly from the `phase3-green` tag.

Single refactor phase over the green implementation (Phase 3). The **planner** detects candidates
(read-only); the **implementer** applies them and simplifies (delegate to **`pablo-implementer`**
by name if configured, refactor mode; otherwise fall back to the generic **implementer** role);
one frozen-test re-run and one `code-review-checklist` pass close the phase.

## Preflight

1. Use `pablo-code-philosophy` as the standard both the candidates and the simplification pass are
   validated against.

## How to run

1. **Detect.** Delegate to the **planner** subagent to run `refactor-identification` (read-only)
   against the green implementation and the frozen tests (Phase 3 artifacts) — do not modify tests.
   Self-contained prompt:

   > Base method: this code passes its frozen tests (Phase 3) and follows the Phase 2 design
   > (`.design/plan.md` + `.design/technical.md`). Apply `refactor-identification` to the diff
   > `<base>..<phase3-green hash>` (same `<base>` and hash recorded in `.design/decisions.md` at
   > the Phase 3 freeze): missing/misplaced abstractions, weak encapsulation, poor data types, flag/enum-
   > modeled variants that a sealed alternative fits better. File:line evidence required for
   > every candidate. Do not edit anything.

2. **Decide.** Review the candidates with the user. Each needs file:line evidence and a case for why
   it isn't over-engineering (YAGNI/KISS gate) — reject speculative ones. Surface every load-bearing
   decision explicitly. Append every rejected candidate (and why — YAGNI/KISS, out of scope, too
   risky) to `.design/decisions.md`: the record of what was deliberately not refactored is
   load-bearing for QA and for resuming the session.
3. **Apply.** Delegate to the **implementer** (refactor mode) to apply the accepted candidates
   only, re-validating each against `pablo-code-philosophy` (data-structures-first, composition
   over inheritance, low complexity) as it goes. No behavior change. Compartmentalize: apply
   **the first bucket only**, then stop at a checkpoint for review.
4. **Simplify.** Once accepted candidates are applied, delegate to the **implementer** for one
   more simplification/cleanup pass on the result: dead code, redundant indirection, naming,
   altitude mismatches — still `pablo-code-philosophy`, still no behavior change. This is a
   standalone refactor-mode invocation — with `pablo-implementer`, the prompt must explicitly
   list the files this phase touched (it cannot compute that itself, no git/shell).

## Verify (once, combined)

1. Delegate the frozen-test selector (Phase 3 artifact) to your build/test subagent — a regression
   here must be fixed before moving to Phase 5.
2. Run `code-review-checklist` **once**, against the cumulative diff since the `phase3-green`
   checkpoint hash — the single combined review covering both the applied candidates and the
   simplification pass together. Do not run it twice.
3. If `code-review-checklist` findings are addressed with further edits, re-run the frozen tests
   again before Phase 5 — do not carry forward a green status from before those edits.

## Exit criteria

Refactored implementation: evidence-backed candidates applied, simplified, `pablo-code-philosophy`
conformant, behavior unchanged. Frozen tests still green and `code-review-checklist` passes (or its
violations are addressed, with a re-run confirming green per step 3 above) for the combined diff —
a single gate before Phase 5. Accepted/rejected candidates are logged in `.design/decisions.md`.
