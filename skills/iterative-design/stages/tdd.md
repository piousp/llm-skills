# TDD — Spec, Red, Green

Anchors on `.design/plan.md` (sequencing, buckets) and `.design/technical.md` (interfaces,
contracts, data structures) from Phase 2, and produces the spec, the frozen tests (RED), and a
green implementation as ONE vertical loop — never as two bulk phases (see Anti-patterns in `SKILL.md`:
"horizontal slicing"). `pablo-code-philosophy` is applied directly while co-designing and
implementing each seam, not deferred to a later review.

## Preflight

1. Use `pablo-code-philosophy`
2. Use `tdd`

Do NOT run `code-review-checklist` here — that's deferred to Phase 4. This phase's only job is a
correct, minimal, green implementation of agreed seams that already conforms to
`pablo-code-philosophy`.

## How to run

1. Anchor everything on `.design/plan.md` and `.design/technical.md` (Phase 2) — the seams,
   interfaces, and sequencing they specify.
2. Co-design the spec from `.design/plan.md` and `.design/technical.md`: the public interface,
   which seams get tested, check placement, reuse, explicit business rules, cohesion, surface
   area. Apply `pablo-code-philosophy` to these choices as you make them — not as a later pass.
   **The coordinator writes the spec to `.design/spec.md`** (a design doc — coordinator carve-out
   applies), not just chat. Confirm the spec with the user before delegating the first seam.
3. Before writing anything new, search the codebase (via the coordinator's free exploration, or a
   delegated search subagent) for existing implementations. Flag duplication: "this already exists
   at X — reuse it."
4. Delegate implementation to the **`pablo-implementer`** subagent by name if your harness has it
   configured (TDD mode), one seam at a time (vertical slice, per the `tdd` skill). Otherwise fall
   back to the generic **implementer** role. Self-contained prompt per seam:

   > Mode: TDD. Technical design (Phase 2): `.design/technical.md` <paste>. Spec (this phase):
   > `.design/spec.md` <paste>. Current seam: <name/description>. [Generic implementer fallback
   > only: Apply `tdd` (RED-first, one seam at a time) and `pablo-code-philosophy`
   > (data-structures-first, composition over inheritance, no speculative abstractions) — both
   > are already built into `pablo-implementer`, don't repeat them when invoking it by name.]
   > First write one failing test for this seam. Then write the minimal code to make it pass —
   > correct and green, not gold-plated. Do not apply anything beyond this seam.

   (`.design/plan.md` stays coordinator-side for bucket sequencing — the implementer only needs
   the contracts and the spec, not the logistics.)

   a. Delegate the test run to your build/test subagent or tool and confirm it fails for the
      **right reason** (not a compile error, unless that's the intended red). With
      `pablo-implementer`, check the actual failure against its stated Predicted RED.
   b. Confirm the minimal implementation is green. If it isn't, re-delegate to `pablo-implementer`
      in **repair mode**: same seam, plus the actual failure output pasted verbatim (counts toward
      the iteration budget: max 2 attempts total for this seam).
   c. Confirm green with the user, then move to the next seam.
5. Compartmentalize: **the first bucket only**, then stop at a checkpoint for review — repeat step 4
   per bucket.
6. Surface every load-bearing decision and make the user verify it explicitly; flag guesses as open
   questions. If a seam decision conflicts with the confirmed Phase 2 design (either
   `.design/plan.md` or `.design/technical.md`), stop and reconcile with the user before
   continuing — don't silently diverge from the confirmed design. Append the reconciliation to
   `.design/decisions.md`.

## Freeze

Freeze the test set and persist the test selector in `.design/spec.md` (append a "Frozen tests"
section) — it travels to Phase 4 and Phase 5 as a file, not a chat message. Record the checkpoint
named `phase3-green` as a **hash read from the existing HEAD** — read-only via `git rev-parse
HEAD`; never `git commit` or `git tag`. Append that hash and the pre-work base commit (merge-base
with the main branch, or the commit before Phase 3 began, also read-only) to
`.design/decisions.md` — Phase 4 and Phase 5 diffs are defined relative to these recorded hashes.
If HEAD has uncommitted changes when freezing, tell the user and ask them to commit or explicitly
confirm proceeding with an uncommitted checkpoint — never commit on their behalf.

After recording the `phase3-green` checkpoint hash, apply the **Phase 4 gate** from `SKILL.md` —
Phase 4 is optional.
Do not open `stages/refactor.md` without the user's explicit gate answer, recorded in
`.design/decisions.md`.

## Exit criteria

`.design/spec.md` + frozen tests (written RED-first) + green implementation for all agreed seams,
produced as a single vertical TDD loop instead of two bulk phases, already conforming to
`pablo-code-philosophy`. No code review run yet — deferred to Phase 4.
