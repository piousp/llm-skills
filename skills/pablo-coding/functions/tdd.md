# tdd function — pablo-coding method

Function spec for the `pablo-coding` skill. Invoked when the user names `tdd`
(or the dispatch ladder maps a strong keyword to it and the user confirms).
TDD with a plan and TDD without a plan are both this function; the entry
condition picks the branch.

## Purpose

Drive code implementation one seam at a time: one failing test, then the
minimal code to pass it, then build/test verification by the coordinator — per
seam, per the `tdd` skill's discipline embedded in
`lens/code-implementer-lens.md`.

## Entry conditions

- **With plan:** `plan.md` + `technical.md` + `spec.md` exist (or the user
  provides them).
- **Without plan:** a bare goal and gathered context, no `plan.md` /
  `technical.md` / `spec.md` on disk.
- The coordinator confirms in the same turn what the function will do and what
  artifacts it will write.

## Coordinator steps

**With plan:**

1. Derive the seams from `plan.md` (each seam = one TDD loop iteration; the
   seam-sizing discipline is inherited from the planner lens).
2. Co-design `spec.md` with the user: seam contracts, signatures, error
   semantics, invariants. The coordinator writes `spec.md` (carve-out); the
   implementer reads it but [NEVER] edits it. The user may add more seams to
   the spec between invocations.
3. Per seam: delegate to `code-implementer` with `lens/code-implementer-lens.md`
   in `tdd` mode; pass `spec.md` + the current seam. The mode flag in the
   prompt decides which mode applies — [ALWAYS] name it.
4. After the implementer returns: run build/test verification (see below).
5. Repeat for the next seam.

**Without plan (`tdd-no-plan` first invocation):**

1. Delegate to `code-implementer` in `tdd-no-plan` mode with the goal and the
   gathered context. `spec.md` and `technical.md` are **forbidden inputs** —
   their absence is the point: the implementer is the seam designer.
2. The implementer writes one failing test + minimal code and stops, reporting
   the "Discovered seam" block (seam name, contract, test file path,
   implementation file path, predicted RED, predicted GREEN).
3. Run build/test verification (frozen rule — see below).
4. Materialize `spec.md` from the "Discovered seam" report: seam name,
   contract, test file, implementation file, predicted RED/GREEN. [ALWAYS] the
   coordinator's first action after the implementer reports. The first call
   writes a single-seam `spec.md`; from seam 2 onward `spec.md` is
   appended-to, never rewritten.
5. Continue as the with-plan branch from the next seam.

## Subagent cast

- `code-implementer` + `lens/code-implementer-lens.md`. The mode flag
  (`tdd` | `tdd-no-plan` | `repair`) in the delegation prompt decides which
  mode's rules apply. Resolve the lens path to an absolute path once at session
  start; pass it verbatim.
- The implementer loads the embedded pablo-code-philosophy and the `tdd` skill
  reference from the lens.

## Build/test verification (frozen)

[ALWAYS] the coordinator — delegating to the harness's build/test agent (MCP or
equivalent). [NEVER] the implementer runs builds or tests. The relaxed
coordinator rule does not skip this, even in direct-execution mode — it is the
one rule the carve-out does not touch. The coordinator can observe the real RED
by setting the implementation file(s) aside and running the test alone, then
restoring them for the GREEN.

## Reporting

- The per-seam verdict from the build/test agent, reported first (S3), followed
  by the key finding.
- Tree-view of changed files per S2 (status + one-line reason each), as emitted
  by the implementer's "Changed files" section.
- Anti-noise (S5): if the seam is one line, the chat synthesis and the
  `state.md` history entry collapse to a single line.
- Mirror every verdict and synthesis into `state.md` history (S4); the
  implementer never touches `state.md`.

## Anti-patterns

- Horizontal slicing — all tests first, then all implementation (bulk tests
  verify imagined behavior).
- Refactoring adjacent code "while in there" — refactoring belongs to
  `code-refactor`, gated by the user.
- Weakening, deleting, or skipping existing tests to make code plausible-green
  — a conflicting existing test is a finding to report, not an obstacle to
  remove.
- The implementer editing `spec.md` or writing into `$DESIGN_DIR`.

## When to chain

The natural follow-ups are `code-refactor` (clean up the implemented code) and
`qa-adversary` (hunt for bugs in the change). [DO NOT] auto-dispatch — the user
names the next function.
