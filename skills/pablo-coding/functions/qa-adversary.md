# qa-adversary function — pablo-coding method

Function spec for the `pablo-coding` skill. Invoked when the user names
`qa-adversary` (or the dispatch ladder maps a strong keyword like "review my
changes" to it and the user confirms). Standalone: no chaining required.

## Purpose

Adversarial QA on an explicit scope against an explicit intent source. The
`analyst` (with the `qa-adversary` skill as its lens) hunts for correctness
bugs, data-handling mistakes, business-rule violations, regressions, and
discrepancies vs intended behavior, and assesses integration-test coverage by
reading tests — never running them, never editing.

## Entry conditions

- **Explicit scope:** a diff range, a path, or a branch. Ask if missing.
- **Intent source:** a ticket, a wiki path, or a pre-change baseline. Ask if
  missing.
- The coordinator confirms in the same turn what the function will do and what
  artifacts it will write.

## Coordinator steps

1. Gate scope and intent source — [ALWAYS] ask before any delegation if either
   is missing. [NEVER] infer intent.
2. Delegate to `analyst` with `qa-adversary/SKILL.md` as the lens; pass the
   scope and the intent source verbatim. Resolve the lens path to an absolute
   path once at session start; pass it verbatim. Domain-context companions, if
   any, are passed as explicit paths — never via skill auto-triggering.
3. The analyst never runs tests and never edits; git usage is read-only (diff
   derivation only).
4. Handle the verdict (below).

## Verdict handling

- **PASS** — append `## QA — complete (<date>)` to `decisions.md`.
- **BLOCK** — [DO NOT] append the complete marker. Offer to reopen `tdd` or
  `code-refactor` (see When to chain); the user picks.
- **NEEDS CLARIFICATION** — ask the user; [DO NOT] loop silently and [DO NOT]
  guess.

## Reporting

- The verdict, reported verbatim, first (S3), followed by the key findings and
  the integration-coverage assessment per the `qa-adversary` skill's output
  format.
- Mirror into `state.md` history (S4); the analyst never touches `state.md`.

## Anti-patterns

- The analyst running tests — the function is read-only by design.
- The analyst writing style comments — that is `code-review-checklist`'s lane,
  not `qa-adversary`'s.
- The coordinator summarizing instead of reporting the verdict verbatim.

## When to chain

On PASS, the function cycle is done. On BLOCK, the coordinator proposes
reopening `tdd` for behavior/correctness fixes or `code-refactor` for
refactor-shaped findings — the user picks. [DO NOT] auto-dispatch.
