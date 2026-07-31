# TDD — Spec, Red, Green

Anchors on `$DESIGN_DIR/plan.md` (sequencing, buckets) and `$DESIGN_DIR/technical.md` (interfaces,
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

1. Anchor everything on `$DESIGN_DIR/plan.md` and `$DESIGN_DIR/technical.md` (Phase 2) — the seams,
   interfaces, and sequencing they specify.
2. Co-design the spec from `$DESIGN_DIR/plan.md` and `$DESIGN_DIR/technical.md`: the public interface,
   which seams get tested, check placement, reuse, explicit business rules, cohesion, surface
   area. Apply `pablo-code-philosophy` to these choices as you make them — not as a later pass.
   **The coordinator writes the spec to `$DESIGN_DIR/spec.md`** (a design doc — coordinator carve-out
   applies), not just chat. Confirm the spec with the user before delegating the first seam.
3. Before writing anything new, search the codebase (via the coordinator's free exploration, or a
   delegated search subagent) for existing implementations. Flag duplication: "this already exists
   at X — reuse it."
4. Delegate implementation to the **`code-implementer`** subagent (TDD mode), one seam at a time
   (vertical slice, per the `tdd` skill). On every invocation pass:
   `model: "anthropic/claude-sonnet-5"` (or your harness's strong coding model),
   `tools: ["read", "grep", "find", "ls", "write", "edit"]`, and `skills: []`. The `tools` list
   mirrors the agent's own frontmatter on purpose — it is redundant reinforcement of the execution
   boundary (the agent's `disallowedTools` still denies `bash`/`subagent` even if a caller widens
   `tools`), and the call display shows the effective set so you can see the boundary held.
   `skills: []` is deliberate: the lens is delivered by path in the prompt, never via skill
   discovery — an empty whitelist keeps unrelated skills from auto-triggering. If your harness's
   subagent mechanism predates per-invocation `tools`/`skills` (pi-simple-agents < 0.9.0 ignores
   them silently — verify once, don't assume), omit both; the agent's frontmatter remains the
   boundary. Self-contained prompt per seam:

   > Mode: TDD. Lens: read and apply `~/.pi/agent/skills/iterative-design/lens/code-implementer-lens.md`
   > before touching anything; if you cannot read it, make no changes and say so. Technical design
   > (Phase 2): `$DESIGN_DIR/technical.md` <paste>. Spec (this phase):
   > `$DESIGN_DIR/spec.md` <paste>. Current seam: <name/description>.
   > First write one failing test for this seam. Then write the minimal code to make it pass —
   > correct and green, not gold-plated. Do not apply anything beyond this seam.

   (`$DESIGN_DIR/plan.md` stays coordinator-side for bucket sequencing — the code-implementer only
   needs the contracts and the spec, not the logistics.)

   a. Delegate the test run to your build/test subagent or tool and confirm it fails for the
      **right reason** (not a compile error, unless that's the intended red). Check the actual
      failure against the stated Predicted RED (defined in the lens).
   b. Confirm the minimal implementation is green. If it isn't, re-delegate to `code-implementer`
      in **repair mode**: same seam, plus the actual failure output pasted verbatim (counts toward
      the iteration budget: max 2 attempts total for this seam). Same `model`/`tools`/`skills`
      params. Prompt:

      > Mode: repair. Lens: `~/.pi/agent/skills/iterative-design/lens/code-implementer-lens.md`.
      > Seam: <name/description>. Actual failure output (verbatim): <paste>.
   c. Confirm green with the user, then move to the next seam.
5. Compartmentalize: **the first bucket only**, then stop at a checkpoint for review — repeat step 4
   per bucket.
6. Surface every load-bearing decision and make the user verify it explicitly; flag guesses as open
   questions. If a seam decision conflicts with the confirmed Phase 2 design (either
   `$DESIGN_DIR/plan.md` or `$DESIGN_DIR/technical.md`), stop and reconcile with the user before
   continuing — don't silently diverge from the confirmed design. Append the reconciliation to
   `$DESIGN_DIR/decisions.md`.

## Freeze

Freeze the test set and persist the test selector in `$DESIGN_DIR/spec.md` (append a "Frozen tests"
section) — it travels to Phase 4 and Phase 5 as a file, not a chat message. Record the checkpoint
named `phase3-green` as a **hash read from the existing HEAD** — read-only via `git rev-parse
HEAD`; never `git commit` or `git tag`. Append that hash and the pre-work base commit (merge-base
with the main branch, or the commit before Phase 3 began, also read-only) to
`$DESIGN_DIR/decisions.md` — Phase 4 and Phase 5 diffs are defined relative to these recorded hashes.
If HEAD has uncommitted changes when freezing, tell the user and ask them to commit or explicitly
confirm proceeding with an uncommitted checkpoint — never commit on their behalf.

After recording the `phase3-green` checkpoint hash, apply the **Phase 4 gate** from `SKILL.md` —
Phase 4 is optional.
Do not open `stages/refactor.md` without the user's explicit gate answer, recorded in
`$DESIGN_DIR/decisions.md`.

## Exit criteria

`$DESIGN_DIR/spec.md` + frozen tests (written RED-first) + green implementation for all agreed seams,
produced as a single vertical TDD loop instead of two bulk phases, already conforming to
`pablo-code-philosophy`. No code review run yet — deferred to Phase 4.
