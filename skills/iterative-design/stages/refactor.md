# Refactor — Candidates, Apply, Simplify, One Combined Review

Single refactor phase over the green implementation (Phase 3). Replaces the old two-phase split.
The **planner** detects candidates (read-only); the **implementer** applies them and simplifies;
one frozen-test re-run and one `code-review-checklist` pass close the phase.

## Preflight

1. Use `pablo-code-philosophy` as the standard both the candidates and the simplification pass are
   validated against.

## How to run

1. **Detect.** Delegate to the **planner** subagent to run `refactor-identification` (read-only)
   against the green implementation and the frozen tests (Phase 3 artifacts) — do not modify tests.
   Self-contained prompt:

   > Base method: this code passes its frozen tests (Phase 3) and follows `plan.md`. Apply
   > `refactor-identification` to the branch diff: missing/misplaced abstractions, weak
   > encapsulation, poor data types, flag/enum-modeled variants that a sealed alternative fits
   > better. File:line evidence required for every candidate. Do not edit anything.

2. **Decide.** Review the candidates with the user. Each needs file:line evidence and a case for why
   it isn't over-engineering (YAGNI/KISS gate) — reject speculative ones. Surface every load-bearing
   decision explicitly.
3. **Apply.** Delegate to the **implementer** to apply the accepted candidates only, re-validating
   each against `pablo-code-philosophy` (data-structures-first, composition over inheritance, low
   complexity) as it goes. No behavior change. Compartmentalize: apply **the first bucket only**,
   then stop at a checkpoint for review.
4. **Simplify.** Once accepted candidates are applied, have the **implementer** do one more
   simplification/cleanup pass on the result: dead code, redundant indirection, naming, altitude
   mismatches — still `pablo-code-philosophy`, still no behavior change.

## Verify (once, combined)

1. Delegate the frozen-test selector (Phase 3 artifact) to your build/test subagent — a regression
   here must be fixed before moving to Phase 5.
2. Run `code-review-checklist` **once**, against the cumulative diff since Phase 3's GREEN
   checkpoint — the single combined review covering both the applied candidates and the
   simplification pass together. Do not run it twice.

## Exit criteria

Refactored implementation: evidence-backed candidates applied, simplified, `pablo-code-philosophy`
conformant, behavior unchanged. Frozen tests still green and `code-review-checklist` passes (or its
violations are addressed) for the combined diff — a single gate before Phase 5.
