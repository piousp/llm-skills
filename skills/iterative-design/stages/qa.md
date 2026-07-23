# QA — Final Gate

Entered only on an explicit "run" at the Phase 5 gate, already recorded in `.design/decisions.md`
(see `SKILL.md`'s "Optional phases — the gate" for the gate question itself).

Delegate to `qa-adversary` by name — read-only, never runs tests, never edits. Self-contained
prompt; pick the variant matching the Phase 4 gate decision:

**If Phase 4 ran:**

> Frozen tests (Phase 3 artifact): <selector>. Current implementation (after Phase 4's refactor):
> <path>. Diff since the `phase3-green` checkpoint hash (cumulative Phase 4 diff — the same diff
> `code-review-checklist` reviewed): <diff or commit range>. QA this change: hunt for correctness
> bugs, data-handling mistakes, business-rule violations, regressions, and check integration test
> coverage. Give your PASS or BLOCK verdict with findings.

**If Phase 4 was skipped:**

> Frozen tests (Phase 3 artifact): <selector>. Current implementation (Phase 3 output — Phase 4
> was skipped): <path>. Implementation diff, anchored on the full change since before Phase 3
> began: `<base>..<phase3-green hash>`, where `<base>` is the pre-work baseline recorded in
> `.design/decisions.md` at the Phase 3 freeze (merge-base with the main branch; if unavailable,
> the commit before Phase 3 began) — both read-only via `git rev-parse`/`git merge-base`, never a
> tag or commit created for this purpose — not `<phase3-green hash>..HEAD`, which would be empty.
> This code
> has NOT been through `code-review-checklist` — you are its first reviewer. QA
> this change: hunt for correctness bugs, data-handling mistakes, business-rule violations,
> regressions, and check integration test coverage. Give your PASS or BLOCK verdict with
> findings.

## Exit criteria

Report its verdict **verbatim** to the user first, then your own comments. A BLOCK is not "done" —
fix and re-run from the relevant phase; do not silently patch past its objection. If Phase 4 was
skipped and the BLOCK findings are refactor-shaped, reopening Phase 4 is allowed — append the
reversal to `.design/decisions.md`. Counts toward the shared iteration budget below — do not
cycle Phase 3/4 → 5 → 3/4 indefinitely.

On a **PASS** verdict, append `## Phase 5 — complete (<date>)` to `.design/decisions.md` —
`scripts/state.py` keys on this marker to report `phase: "done"`; without it the pipeline keeps
reporting Phase 5 as active forever. On BLOCK, do NOT write this marker.
