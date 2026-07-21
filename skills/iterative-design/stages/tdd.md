# TDD — Spec, Red, Green

Anchors on `plan.md` (Phase 2) and produces the spec, the frozen tests (RED), and a green
implementation as ONE vertical loop — never as two bulk phases (see Anti-patterns in `SKILL.md`:
"horizontal slicing"). `pablo-code-philosophy` is applied directly while co-designing and
implementing each seam, not deferred to a later review.

## Preflight

1. Use `pablo-code-philosophy`
2. Use `tdd`

Do NOT run `code-review-checklist` here — that's deferred to Phase 4. This phase's only job is a
correct, minimal, green implementation of agreed seams that already conforms to
`pablo-code-philosophy`.

## How to run

1. Anchor everything on `plan.md` (Phase 2) — the seams, interfaces, and sequencing it specifies.
2. Co-design the spec from `plan.md`: the public interface, which seams get tested, check
   placement, reuse, explicit business rules, cohesion, surface area. Apply `pablo-code-philosophy`
   to these choices as you make them — not as a later pass. Write the spec to a durable file
   (e.g. `spec.md` alongside `plan.md`), not just chat.
3. Before writing anything new, search the codebase (via the coordinator's free exploration, or a
   delegated search subagent) for existing implementations. Flag duplication: "this already exists
   at X — reuse it."
4. Delegate implementation to the **implementer**, one seam at a time (vertical slice, per the
   `tdd` skill). Self-contained prompt per seam:

   > `plan.md` (Phase 2): <paste or path>. Spec (this phase): <path>. Current seam: <name/
   > description>. Apply `tdd` (RED-first, one seam at a time) and `pablo-code-philosophy`
   > (data-structures-first, composition over inheritance, no speculative abstractions). First
   > write one failing test for this seam. Then write the minimal code to make it pass — correct
   > and green, not gold-plated. Do not apply anything beyond this seam.

   a. Delegate the test run to your build/test subagent or tool and confirm it fails for the
      **right reason** (not a compile error, unless that's the intended red).
   b. Confirm the minimal implementation is green.
   c. Confirm green with the user, then move to the next seam.
5. Compartmentalize: **the first bucket only**, then stop at a checkpoint for review — repeat step 4
   per bucket.
6. Surface every load-bearing decision and make the user verify it explicitly; flag guesses as open
   questions. If a seam decision conflicts with `plan.md`, stop and reconcile with the user before
   continuing — don't silently diverge from the confirmed design.

## Freeze

Freeze the test set at this point — it is the artifact (`testSelector`) that travels unchanged to
Phase 4 and Phase 5.

## Exit criteria

Spec + frozen tests (RED) + green implementation for all agreed seams, produced as a single
vertical TDD loop instead of two bulk phases, already conforming to `pablo-code-philosophy`. No
code review run yet — deferred to Phase 4.
