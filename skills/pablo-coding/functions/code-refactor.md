# code-refactor function — pablo-coding method

Function spec for the `pablo-coding` skill. Invoked when the user names
`code-refactor` (or the dispatch ladder maps a strong keyword to it and the
user confirms). Standalone: no chaining required, no plan or spec required.

## Purpose

Detect and/or apply structural refactor candidates on an explicit scope.
Detection always goes through the `planner` with `refactor-identification` as
the methodology (read by path); the user is the only one who accepts
candidates; the implementer applies accepted candidates in `refactor` mode.
Git is read-only for analysis (`git diff`, `git log`, `git show`) — never for
bookkeeping.

## Entry conditions

- **Explicit scope is mandatory:** a branch name, a path, or a file list.
  [ALWAYS] ask before any delegation if the scope is missing — [NEVER] infer
  scope from the conversation or the diff.
- The user chooses a sub-mode (`detect-only` / `detect-then-apply` /
  `apply-only`). Ask if missing.
- The coordinator confirms in the same turn what the function will do and what
  artifacts it will write.

## Three sub-modes

**detect-only** — `planner` + `lens/planner-lens.md` in `refactor-candidates`
mode against the explicit scope, applying `refactor-identification` (read by
path) — read-only, `file:line` evidence per candidate, no implementation.
Output: `refactor-candidates.md` (the candidate set, with the user's
accept/reject recorded).

**detect-then-apply** — detect as above; the user accepts/rejects candidates
with rationale; the implementer applies the accepted candidates in `refactor`
mode; a simplification pass is a follow-up invocation, not bundled; then the
build/test re-run (the coordinator's build/test agent) and the post-apply
review by `analyst` with `code-review-checklist/SKILL.md` as lens.

**apply-only** — the user supplies already-accepted candidates; the implementer
applies them in `refactor` mode (no detection), then the build/test re-run and
the post-apply review as above.

## Coordinator steps per sub-mode

1. Gate scope: ask if the user did not provide a branch / path / file list.
2. Gate sub-mode: ask if the user did not pick one.
3. **detect-only:** delegate to `planner` with `lens/planner-lens.md`
   (`refactor-candidates` mode) and the scope verbatim. Persist the findings to
   `$DESIGN_DIR/refactor-candidates.md` (carve-out). Present the candidates to
   the user for acceptance.
4. **detect-then-apply:** run detection, collect the user's accept/reject with
   rationale (append to `decisions.md`), delegate to `code-implementer` with
   `lens/code-implementer-lens.md` in `refactor` mode, passing the accepted
   candidates. Then
   run the build/test re-run (build/test agent) and the post-apply review.
5. **apply-only:** skip detection; delegate to the implementer in `refactor`
   mode with the user-supplied candidates, then the
   re-run and the review.

## Subagent cast

- `planner` + `lens/planner-lens.md` (`refactor-candidates` mode) — detection.
  The planner reads `refactor-identification/SKILL.md` by path; if unreadable,
  it says so and stops rather than improvising the methodology.
- `code-implementer` + `lens/code-implementer-lens.md` (`refactor` mode) —
  apply. Accepted candidates only; never self-generated.
- `analyst` + `code-review-checklist/SKILL.md` — post-apply review in the apply
  sub-modes (style/quality lane, distinct from `qa-adversary`).
- Resolve every lens/skill path to an absolute path once at session start; pass
  verbatim.

## Artifact writes (coordinator carve-outs)

- `$DESIGN_DIR/refactor-candidates.md` — created/updated: the candidate set and
  the user's accept/reject with rationale.
- `$DESIGN_DIR/decisions.md` — appended: accepted/rejected candidates and why.
- `$DESIGN_DIR/state.md` — history entry per invocation (S4).
- Subagents never write into `$DESIGN_DIR`.

## Reporting

- Synthesis of the candidates; accepted/rejected with rationale; tree-view of
  changed files (S2); the build/test verdict (S3, reported first).
- Anti-noise (S5): single-candidate trivial refactors collapse to one line.

## Anti-patterns

- The implementer self-generating candidates — detection is the planner's,
  acceptance is the user's.
- The implementer changing behavior "while refactoring" — same inputs → same
  outputs, same error semantics, same public contracts.
- Skipping the build/test re-run after applying refactors.
- Using git for bookkeeping (commits, hashes, freeze) — read-only analysis
  only.

## When to chain

The natural follow-up is `qa-adversary` (hunt for bugs in the refactored code).
On BLOCK from `qa-adversary`, reopen `code-refactor` if the findings are
refactor-shaped. [DO NOT] auto-dispatch — the user names the next function.
