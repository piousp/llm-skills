# Evals for `pablo-code-review`

Minimal offline guardrail only. `pablo-code-review` is a coordinator/orchestration
skill (four live `analyst` subagent calls + a coordinator merge); a full trajectory
eval would cost real tokens and multiple minutes per trial. This directory
deliberately does NOT build that. It guards the skill's **load-bearing rules**:
if a future edit to `SKILL.md` drops or contradicts one of them, this fails in
under a second, offline.

## What it covers

`check_load_bearing_rules.py` asserts that `SKILL.md` (and `references/merge-rules.md`) still contains:

| check | load-bearing rule it guards |
|---|---|
| `merge_by_file_line` | Same `file:line` + root cause across lenses → one finding (the anti-audit-report merge). |
| `file_line_inside_diff` | Merge-time rule: every finding's cited `file:line` must fall inside the diff. |
| `severity_vocabulary` | The B/M/Q/I/G identifier vocabulary is defined (B = blocking, M = major, Q = question, I = minor, G = coverage gap). |
| `summary_tally_all_severities` | The Summary verdict line counts blocking, major, minor, and lists questions and coverage gaps outside the verdict. |
| `step3_tasks_align_scope_law` | All four lens task templates carry the unified scope instruction (changed lines only, 1-hop context per each lens's own Scope law, no boundary tightening) and the old contradictory "Do not analyze code outside the diff" is gone. |
| `english_headers_rule` | Transversal rule pins report headers/labels to English, the headers themselves appear literally in the output template, and no Spanish literal remains. |
| `never_delegate_merge` | The merge step stays with the coordinator. |
| `question_tier` | The Question tier (Q) exists; `references/merge-rules.md` defines it and caps Questions at 3. |
| `root_cause_single_source` | `merge-rules.md` holds the one `## Root cause` definition, "keep the higher severity" is gone, and all 3 lens SKILL.md files point to `merge-rules.md` (fails until every lens package adds its pointer). |
| `four_part_b_m_only` | Four-part shape is for Blocking/Major only; Question/Minor are one-liners. Pins the default of open decision 3; flip it if the owner decides otherwise. |
| `minor_has_suggestion` | A Minor is one line carrying at least one concrete suggestion. |
| `test_lens_dispatched` | A dispatch task runs the `pablo-test-review` lens (`skills: ["pablo-test-review"]`). |
| `gap_cap_rule` | `merge-rules.md` merges qa and test-lens coverage gaps into one list capped at 3. |
| `persist_report_rule` | The report is persisted per `learning-loop.md` § Report file (old chat-only rule gone). |
| `gitignore_private_dirs` | `reviews/` and `repo-lessons/` stay git-ignored. |
| `taxonomy_15` | `taxonomy.md` (parsed by `scripts/store.py`) lists exactly 15 slugs. |
| `strengths_note` | The optional, uncounted Strengths note is in the template and in the merge rules. |
| `harvest_section` | SKILL.md has `## Harvest (user-triggered)`, the `"harvest PR <url>"` trigger in the description, stays <= 252 lines; `learning-loop.md` has the `## Harvest` procedure (fetch, `set-feedback`, pre-skill, praise, seen/unseen, partial = 0.5). |
| `full_report_final_message` | The final assistant message is the COMPLETE report: no recap, preamble or closing note. |
| `persist_printed_verbatim` | Persistence writes the printed text as the body through a `mktemp` file and `--body`; every temp file (incl. diff files) is deleted. |
| `item_id_shape` | Every item head is `**<id> [<tier> - <lens(es)>] <location>: <text>**` for B/M/Q/I/G/T/O; ids numbered by tier then rank; the old `[tier] ... (id)` shape is gone. |
| `rebase_rule` | `merge-rules.md` § Re-review: rebased PR says "PR was rebased; no incremental diff", matches by file path and root cause, carries over unchanged open items. |
| `no_change_rule` | `merge-rules.md` § Re-review "No new commits": unchanged head and no full re-run asked → only the `No changes since round r<k> (head <sha7>).` line plus the status table, no lenses, no new ledger round; a full re-run request still runs the whole pipeline; prior items cited as `r<k>:<id>`; SKILL.md points to it. |
| `status_table_columns` | Re-review status table has EXACTLY three columns `Prior item \| Title \| Status` (resolved/open/outdated, optional reason after a colon); a full re-run adds no column and no prose line before the first file; SKILL.md template says so. |
| `no_trailing_after_table` | `merge-rules.md` § No new commits: nothing printed after the status table (no notes, status-source explanations, offers, questions). |
| `mktemp_rule` | SKILL.md Persist: temp files MUST be created with `mktemp` (never fixed `/tmp/<name>.diff`) and deleted at the end. |
| `test_lens_na_line` | `Test lens: not applicable.` is its own line, first in the Summary. |
| `coordinator_lookups` | The coordinator may resolve a Question with read-only lookups; one `Resolved by lookup:` line each (max 3). |
| `other_files_one_line` | Files without findings are one line under "Other files". |
| `four_lens_store` | `store.py` knows the 4 lenses, `pablo-test-review` included. |
| `approval_message_shape` | `learning-loop.md` pins the English approval message: header line, max 3 questions, answers a-f, proposals line, reply grammar, nothing written before the reply. |

Also: `test_scripts.py` holds the unit tests for `scripts/store.py` (taxonomy parsing, report
validation against `evals/fixtures/`, `set-feedback`); `test_fetch_comments.py` tests the pure
functions of `scripts/fetch_comments.py` (`parse_pr_url`, `filter_login`, `mark_pre_skill`,
`location_candidates`) on synthetic JSON. Neither touches the network. Run with the command below.

## How to run it

```bash
cd ~/LLMs/skills/pablo-code-review
python3 evals/check_load_bearing_rules.py
python3 -m unittest discover -s evals -p 'test_*.py'
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
