# Check-registry dispatch pattern

Each `expected_checks` entry in a prompt (see `templates/prompt_set.json`) is a
string `check_id`. Keep every check as a small, pure function with a uniform
signature so the harness can dispatch by name instead of branching per prompt.

## Shape

```python
# CHECK_REGISTRY: check_id -> function(tool_calls, final_text, **ctx) -> bool
CHECK_REGISTRY = {
    "no_repo_mutation": check_no_repo_mutation,
    "mentions_missing_delegation": check_mentions_missing_delegation,
    "gate_wording_faithful": check_gate_wording_faithful,
}

def check_no_repo_mutation(tool_calls, final_text, **ctx) -> bool:
    protected = ctx.get("protected_files", [])
    for tc in tool_calls:
        if tc["name"] in ("edit", "write"):
            path = str(tc["arguments"].get("path", ""))
            if any(f in path for f in protected):
                return False
    return True
```

Dispatch:

```python
def grade(prompt_case: dict, tool_calls: list[dict], final_text: str, **ctx) -> dict:
    return {
        check_id: CHECK_REGISTRY[check_id](tool_calls, final_text, **ctx)
        for check_id in prompt_case["expected_checks"]
    }
```

## Why this shape

- **Composable across prompts** — the same `check_id` (e.g.
  `no_repo_mutation`) can appear in many prompt cases with different `ctx`
  (different `protected_files`), without duplicating the check function.
- **Deterministic-first** — every check here is regex/structural, no LLM
  call. Reach for `judge.py` (L3) only for what these genuinely can't grade
  (see SKILL.md step 4).
- **Outcome over transcript** — prefer checks that inspect files on disk
  (`Path(...).exists()`, file contents) over checks that only inspect
  `final_text`. The chat response is the least trustworthy signal (Anthropic:
  grade the environment's final state, not the sentence describing it).
- **One check, one concern** — don't fold two unrelated assertions into one
  function; a failing check name should tell you exactly what broke.

## Checklist when adding a new check

- [ ] Pure function: same inputs → same output, no side effects.
- [ ] Named after what it verifies, not how (`gate_wording_faithful`, not
      `regex_match_1`).
- [ ] Prefers filesystem/tool-call evidence over `final_text` string matching
      when both are available.
- [ ] Registered in `CHECK_REGISTRY` under the exact `check_id` used in
      `prompt_set.json`.
