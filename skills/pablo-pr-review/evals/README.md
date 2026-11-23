# Evals for `pablo-pr-review`

Minimal offline guardrail only. `pablo-pr-review` is a coordinator/orchestration
skill (four live `analyst` subagent calls + a coordinator merge); a full trajectory
eval would cost real tokens and multiple minutes per trial. This directory
deliberately does NOT build that. It guards the skill's **load-bearing rules**:
if a future edit to `SKILL.md` drops or contradicts one of them, this fails in
under a second, offline.

## What it covers

`check_load_bearing_rules.py` asserts that `SKILL.md`, `references/*.md`, `.gitignore`, `scripts/store.py`, `scripts/select_lessons.py` and the lens SKILL.md files it names still contain:

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
| `root_cause_single_source` | `merge-rules.md` holds the one `## Root cause` definition, "keep the higher severity" is gone, and the 3 lens SKILL.md files (`qa-adversary`, `code-review-checklist`, `refactor-identification`) point to `merge-rules.md`; `pablo-test-review` is not checked. |
| `four_part_b_m_only` | Four-part shape is for Blocking/Major only; Question/Minor are one-liners. Pins the owner's default; flip it if the owner decides otherwise. |
| `minor_has_suggestion` | A Minor is one line carrying at least one concrete suggestion. |
| `test_lens_dispatched` | A dispatch task runs the `pablo-test-review` lens (`skills: ["pablo-test-review"]`). |
| `gap_cap_rule` | `merge-rules.md` merges qa and test-lens coverage gaps into one list capped at 3. |
| `persist_report_rule` | The report is persisted per `learning-loop.md` § Report file (old chat-only rule gone). |
| `gitignore_private_dirs` | `reviews/` and `repo-lessons/` stay git-ignored. |
| `taxonomy_15` | `taxonomy.md` (parsed by `scripts/store.py`) lists exactly 15 slugs. |
| `strengths_note` | The optional, uncounted Strengths note is in the template and in the merge rules. |
| `harvest_section` | SKILL.md has `## Harvest (user-triggered)`, the `"harvest PR <url>"` trigger in the description, stays <= 290 lines; `learning-loop.md` has the `## Harvest` procedure (fetch, `set-feedback`, pre-skill, praise, seen/unseen, partial = 0.5). |
| `full_report_final_message` | The final assistant message is the COMPLETE report: no recap, preamble or closing note. |
| `persist_printed_verbatim` | Persistence writes the printed text as the body through a `mktemp` file and `--body`; every temp file (incl. diff files) is deleted. |
| `item_id_shape` | Every item head is `**<id> [<tier> - <lens(es)>] <location>: <text>**` for B/M/Q/I/G/T/O; ids numbered by tier then rank; the old `[tier] ... (id)` shape is gone. |
| `rebase_rule` | `merge-rules.md` § Re-review: rebased PR says "PR was rebased; no incremental diff", matches by file path and root cause, carries over unchanged open items. |
| `no_change_rule` | `merge-rules.md` § Re-review "No new commits": unchanged head and no full re-run asked → only the `No changes since round r<k> (head <sha7>).` line plus the status table, no lenses, no new ledger round; a full re-run request still runs the whole pipeline; prior items cited as `r<k>:<id>`; SKILL.md points to it. |
| `status_table_columns` | Re-review status table has EXACTLY three columns `Prior item \| Title \| Status` (resolved/open/outdated, optional reason after a colon); a full re-run adds no column and no prose line before the first file; SKILL.md template says so. |
| `no_trailing_after_table` | `merge-rules.md` § No new commits: nothing printed after the status table (no notes, status-source explanations, offers, questions). |
| `mktemp_rule` | SKILL.md Persist: temp files MUST be created with `mktemp` (never fixed `/tmp/<name>.diff`) and deleted at the end. |
| `lessons_never_delete` | SKILL.md step 5b runs `scripts/select_lessons.py --shadow` and pins the `Demoted by lessons:` line; a lesson never deletes an item, never moves it more than one tier, never touches a never-suppress item; `select_lessons.py` keeps the English prefix and the one-step ladder; no Spanish collapsed label remains. |
| `never_suppress_list` | `learning-loop.md` § Merge-time application lists the never-suppress items (qa-adversary Blocking, `duplication-reuse`, `type-modelling`, `assertion_loosened`, the five `protect` values) and `select_lessons.never_suppress` protects exactly those. |
| `test_lens_na_line` | `Test lens: not applicable.` is its own line, first in the Summary. |
| `coordinator_lookups` | The coordinator may resolve a Question with read-only lookups; one `Resolved by lookup:` line each (max 3). |
| `cross_repo_lookup` | A lens Question that needs another repo's code on the diff's call path is looked up by the coordinator (cap 3, overflow dropped, never printed as a Question), and `qa-adversary` reads that repo read-only first. |
| `other_files_one_line` | Files without findings are one line under "Other files". |
| `four_lens_store` | `store.py` knows the 4 lenses, `pablo-test-review` included. |
| `approval_message_shape` | `learning-loop.md` pins the English approval message: header line, max 3 questions, answers a-f, proposals line, reply grammar, nothing written before the reply. |
| `blocking_validation_step` | SKILL.md has step 5a and points to `merge-rules.md` § Blocking validation. |
| `blocking_validation_rules` | `merge-rules.md` has `## Blocking validation`: CONFIRMED / REFUTED / UNVERIFIABLE handling, and timeout, failed call or no verdict counts as UNVERIFIABLE. |
| `draft_comment_line` | B/M/Q/I/T/O items end with a `> Draft comment:` blockquote line; `draft-comments.md` exists and the coordinator drafts, never a subagent. |
| `existing_comments_match` | SKILL.md step 5c points to `references/existing-comments.md`, pins the `Already raised by <author> (<link>, <open\|resolved\|outdated>)` marker, the `Existing comments: not checked (<reason>)` failure line and the never-change-tier rule; the reference says the coordinator matches (no subagent) and tiers, verdict and tally never change. |

Unit tests (synthetic data, no network):

- `test_scripts.py`: `scripts/store.py` (taxonomy parsing, report validation against `evals/fixtures/`, `set-feedback`).
- `test_fetch_comments.py`: the pure functions of `scripts/fetch_comments.py` (`parse_pr_url`, `filter_login`, `mark_pre_skill`, `location_candidates`, the `--all-authors` helpers), with `gh` mocked.
- `test_lessons.py`: `scripts/tally.py` (Beta math, outcome derivation, cells, lesson evidence, proposals).
- `test_select.py`: `scripts/select_lessons.py` (demotion ladder, never-suppress, exploration, shadow, conflicts).
- `test_replay.py`: `scripts/replay.py` (fold splitting, lesson building, PASS/FAIL criteria, narrowing).
- `test_lint.py`: `scripts/lint_ml_lessons.py`, with planted leaks that use fake names.
- `test_seeds.py`: the `ml-lessons/` seeds (`provenance: seeded`, planned status in `SEEDS`) and the lessons `tally.py` adds (`provenance: observed`); schema and trigger contract for every lesson.
- `test_load_bearing_rules.py`: self-test of `check_load_bearing_rules.py` (re-wrapping passes, changed values fail, 38 checks).
- `repo-lessons/test_repo_lessons.py` (skill root): the private, git-ignored repo lessons; runs only where `repo-lessons/` exists.
- `check_backfill.py`: compares backfilled harvest feedback with the expected per-PR counts in the git-ignored `reviews/_meta/backfill_expected.json`.

## How to run it

From this skill's directory:

```bash
python3 evals/check_load_bearing_rules.py
python3 -m unittest discover -s evals -p 'test_*.py'
python3 -m unittest discover -s repo-lessons -p 'test_*.py'   # only where repo-lessons/ exists
python3 scripts/lint_ml_lessons.py
python3 evals/check_backfill.py --expected reviews/_meta/backfill_expected.json   # only where reviews/ exists
```

Stdlib plus PyYAML; no network, no tokens, no subagents. `check_load_bearing_rules.py` prints
`[PASS|FAIL]` per check and exits 0 (all pass) or 1 (any failure); `lint_ml_lessons.py` exits 0 when clean.

## Not covered (on purpose)

- Trigger/description tuning: the description auto-triggers on PR-review requests; trigger evals
  are not built here (use the `evaluating-agent-skills` skill for that).
- Live trajectory evals (lens dispatch quality, merge narrative quality):
  expensive and semantically judged; out of scope for this guardrail.
  See `references/lessons-learned.md` for the manual calibration process
  that backs the current format.
