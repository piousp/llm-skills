# pablo-code-review evals

`check_load_bearing_rules.py` is an offline guardrail. It makes no model calls and
uses only the standard library. It runs string-level checks on `SKILL.md` and
`references/merge-rules.md` to confirm the load-bearing rules are still there:

- Frontmatter: name matches the directory; description has the trigger phrases,
  `[DO NOT]` and the `pablo-pr-review` pointer.
- Diff resolution: `git merge-base`, `origin/HEAD`, untracked files, `+uncommitted`, no `fetch`.
- Dispatch: four lenses in one concurrent turn, no fifth call, print-only (no ledger or harvest).
- Tier map: strict bump and its exemption, refactor P1/P2/P3, failed Blocker gate becomes a Question.
- Merge order, verdict rule and the caps on Questions, Coverage gaps and Observations.
- Output template headers and the Rule/Evidence/Impact/Fix shape; no walkthrough.

## Run

```
cd ~/LLMs/skills/pablo-code-review && python3 -B evals/check_load_bearing_rules.py
```

Prints one PASS/FAIL line per check and `N/N passed`. Exit code is 1 if any check fails.
