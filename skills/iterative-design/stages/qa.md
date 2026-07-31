# QA — Final Gate

Entered only on an explicit "run" at the Phase 5 gate, already recorded in `$DESIGN_DIR/decisions.md`
(see `SKILL.md`'s "Optional phases — the gate" for the gate question itself).

Delegate to **`analyst`** with the `qa-adversary` skill as its lens (`model:
"anthropic/claude-opus-4-8"`, or your harness's most capable reasoning model, `skills: []`) — the
lens is read-only doctrine: never runs or delegates tests, never edits. `skills: []` on this
invocation is load-bearing: domain context (e.g. `mde-qa-context`) reaches the analyst only as an
explicit path in this prompt, never via skill auto-triggering — if it matters, pass the path.
Self-contained prompt; pick the variant matching the Phase 4 gate decision:

**If Phase 4 ran:**

> Lens: read and apply `~/.pi/agent/skills/qa-adversary/SKILL.md` first; if you cannot read it,
> stop and report — run no default review. [If the working repo has a domain QA-context skill
> (e.g. `mde-qa-context` for MDE repos), add: "Additional context lens: `<path>` — read after the
> main lens."] Frozen tests (Phase 3 artifact): <selector>. Current implementation (after Phase 4's
> refactor):
> <path>. Diff since the `phase3-green` checkpoint hash (cumulative Phase 4 diff — the same diff
> `code-review-checklist` reviewed): <diff or commit range>. QA this change: hunt for correctness
> bugs, data-handling mistakes, business-rule violations, regressions, and check integration test
> coverage. Give your PASS or BLOCK verdict with findings.

**If Phase 4 was skipped:**

> Lens: read and apply `~/.pi/agent/skills/qa-adversary/SKILL.md` first; if you cannot read it,
> stop and report — run no default review. [If the working repo has a domain QA-context skill
> (e.g. `mde-qa-context` for MDE repos), add: "Additional context lens: `<path>` — read after the
> main lens."] Frozen tests (Phase 3 artifact): <selector>. Current implementation (Phase 3 output — Phase 4
> was skipped): <path>. Implementation diff, anchored on the full change since before Phase 3
> began: `<base>..<phase3-green hash>`, where `<base>` is the pre-work baseline recorded in
> `$DESIGN_DIR/decisions.md` at the Phase 3 freeze (merge-base with the main branch; if unavailable,
> the commit before Phase 3 began) — both read-only via `git rev-parse`/`git merge-base`, never a
> tag or commit created for this purpose — not `<phase3-green hash>..HEAD`, which would be empty.
> This code
> has NOT been through the `code-review-checklist` lens — you are its first reviewer. QA
> this change: hunt for correctness bugs, data-handling mistakes, business-rule violations,
> regressions, and check integration test coverage. Give your PASS or BLOCK verdict with
> findings.

## Exit criteria

Report its verdict **verbatim** to the user first, then your own comments. A BLOCK is not "done" —
fix and re-run from the relevant phase; do not silently patch past its objection. If Phase 4 was
skipped and the BLOCK findings are refactor-shaped, reopening Phase 4 is allowed — append the
reversal to `$DESIGN_DIR/decisions.md`. Counts toward the shared iteration budget (see `SKILL.md`'s
"Iteration budget & escalation" section) — do not cycle Phase 3/4 → 5 → 3/4 indefinitely.

On a **PASS** verdict, append `## Phase 5 — complete (<date>)` to `$DESIGN_DIR/decisions.md` —
`scripts/state.py` keys on this marker to report `phase: "done"`; without it the pipeline keeps
reporting Phase 5 as active forever. On BLOCK, do NOT write this marker.
