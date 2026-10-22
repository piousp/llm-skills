# Evals for `pablo-code-review`

Minimal offline guardrail only. `pablo-code-review` is a coordinator/orchestration
skill (three live `analyst` subagent calls + a coordinator merge); a full trajectory
eval would cost real tokens and multiple minutes per trial. This directory
deliberately does NOT build that. It guards the skill's **load-bearing rules**:
if a future edit to `SKILL.md` drops or contradicts one of them, this fails in
under a second, offline.

## What it covers

`check_load_bearing_rules.py` asserts that `SKILL.md` still contains:

| check | load-bearing rule it guards |
|---|---|
| `merge_by_file_line` | Same `file:line` + root cause across lenses → one finding (the anti-audit-report merge). |
| `file_line_inside_diff` | Merge-time rule: every finding's cited `file:line` must fall inside the diff. |
| `severity_vocabulary` | The B/M/I/G identifier vocabulary is defined (B = blocking, M = major, I = minor, G = coverage gap). |
| `summary_tally_all_severities` | The Summary verdict line counts all four: blocking, major, minor, coverage gaps. |
| `step3_tasks_align_scope_law` | All three lens task templates carry the unified scope instruction (changed lines only, 1-hop context per each lens's own Scope law, no boundary tightening) and the old contradictory "Do not analyze code outside the diff" is gone. |
| `spanish_headers_rule` | Transversal rule pins report headers/labels to Spanish, and the headers themselves still appear literally in the output template (never translated). |
| `never_delegate_merge` | The merge step stays with the coordinator. |

## How to run it

```bash
cd /home/pablo/.pi/agent/skills/pablo-code-review
python3 evals/check_load_bearing_rules.py
```

Stdlib only, no network, no tokens, no subagents. Prints `[PASS|FAIL]` per
check and exits 0 (all pass) or 1 (any failure).

## Not covered (on purpose)

- Trigger/description tuning: like `qa-adversary`, this skill is invoked by
  name, so there is no auto-trigger path to regress.
- Live trajectory evals (lens dispatch quality, merge narrative quality):
  expensive and semantically judged; out of scope for this guardrail.
  See `references/lessons-learned.md` for the manual calibration process
  that backs the current format.
