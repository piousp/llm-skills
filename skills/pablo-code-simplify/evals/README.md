# pablo-code-simplify evals

`check_load_bearing_rules.py` is an offline guardrail. It makes no model calls and uses only
the standard library. It runs string-level checks on `SKILL.md` and reads
`../refactor-identification/references/fowler-catalog.md` to confirm the load-bearing rules
are still there:

- Frontmatter: name matches the directory; description has the trigger phrases, `[NEVER]`,
  `[DO NOT]`, the routing targets and the supported languages. SKILL.md stays at or under
  300 lines, with no em-dash.
- Scope: taken from the request or asked once, pasted code accepted, `Read at` recorded and,
  for a PR, branch or range, required to be the checked-out HEAD; file, function and paste
  normalized to a synthetic diff with `git diff --no-index /dev/null`.
- Dispatch: exactly two `analyst` calls in the same turn, each a valid JSON line with
  `timeoutMs` 1200000; the philosophy task carries the 1-hop limit, the changed-line anchor
  and the one-line format.
- Merge: same root per `pablo-pr-review` § Root cause, P3 to Not mechanical, unanchored
  philosophy findings dropped.
- Gate: reference resolution (step 5) with the hop definition and the reflection and
  serialization exclusion; pinning-test search (step 6); every `pablo-code-simplify` row of
  the Fowler catalog present in the gate table with the same tier; the Rename, Remove Dead
  Code and Move Statements rows limited to non-exported symbols, and no row that folds a
  duplicated side effect (it always fails N3).
- Failure handling, including the stops when `Read at` is not checked out or no dispatched
  lens succeeds; output template headings and field labels; Lens, Principle, Operation and
  Tier values kept in English; the mini example following the template, with Operation values
  taken from the gate; seam confirmation left to `pablo-tdd`; the citation of its Red, verified
  rule; read-only and chat-only rules.

`check_gate_synced_with_catalog` also fails when the catalog's `pablo-code-simplify` rows
change: update the gate table in the same change.

Live trajectory probes (L2/L2b in `evaluating-agent-skills`) are not built: this skill
dispatches subagents, which needs the real subagent pipeline.

## Run

```
cd <skills-dir>/pablo-code-simplify && python3 -B evals/check_load_bearing_rules.py
```

Prints one PASS/FAIL line per check and `N/N passed`. Exit code is 1 if any check fails.
