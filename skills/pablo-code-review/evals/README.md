# pablo-code-review evals

`check_load_bearing_rules.py` is an offline guardrail. It makes no model calls and
uses only the standard library. It runs string-level checks on `SKILL.md` and
`references/merge-rules.md`, plus one mirror check against `pablo-pr-review`
`references/merge-rules.md`, to confirm the load-bearing rules are still there:

- Frontmatter: name matches the directory; description has the English and Spanish trigger
  phrases, `[DO NOT]` and the `pablo-pr-review` and `codeiq` pointers.
- Diff resolution: `git merge-base`, `origin/HEAD`, untracked files, `+uncommitted`, no `fetch`.
- Dispatch: four lenses in one concurrent turn, no fifth call, the test-lens skip rule, the
  optional domain-context skill on the qa-adversary call, one retry and a `not run`
  line for a failed lens, print-only (no ledger or harvest).
- Tier map: strict bump, its scope (no other lens item is bumped) and its exemption, refactor
  P1/P2/P3, failed Blocker gate becomes a Question, lens skip lines.
- Merge order and the verdict rule live only in `references/merge-rules.md`; anchors are
  checked before merging; a failed lens rules out PASS; caps on Questions (with their rank),
  Coverage gaps (no invented test name) and Observations.
- Output template headers, the Rule/Evidence/Impact/Fix shape, `Alt: none (single sensible
  fix)`, items in English and the `<lens>: skipped` line; no walkthrough.
- Mirror: `## Blocker gate` matches and `## Root cause` is contained in `pablo-pr-review`
  `references/merge-rules.md`.

## Run

```
cd <skills-dir>/pablo-code-review && python3 -B evals/check_load_bearing_rules.py
```

Prints one PASS/FAIL line per check and `N/N passed`. Exit code is 1 if any check fails.
