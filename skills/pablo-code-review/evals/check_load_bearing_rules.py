#!/usr/bin/env python3
"""Offline guardrail for pablo-code-review: verifies that the load-bearing
rules of SKILL.md are still present and mutually consistent.

No live model calls, no tokens, no subagents. Pure string checks on SKILL.md.

Usage:
    python3 check_load_bearing_rules.py

Exit code 0 if every check passes, 1 otherwise.
"""

import re
import sys
from pathlib import Path

SKILL_MD = Path(__file__).resolve().parent.parent / "SKILL.md"
MERGE_RULES = SKILL_MD.parent / "references" / "merge-rules.md"
LEARNING_LOOP = SKILL_MD.parent / "references" / "learning-loop.md"
TAXONOMY = SKILL_MD.parent / "references" / "taxonomy.md"
GITIGNORE = SKILL_MD.parent / ".gitignore"
LENS_SKILLS = [
    SKILL_MD.parent.parent / n / "SKILL.md"
    for n in ("qa-adversary", "code-review-checklist", "refactor-identification")
]

# Report headers/labels are English (public skill): match them literally.
ENGLISH_HEADERS = [
    "What this code does",
    "Question",
    "Nits (optional)",
    "Observations (not actionable)",
    "Unverified business assumptions",
    "Strengths",
]


def check_merge_by_file_line(text: str) -> bool:
    """Lenses reporting the same file:line + root cause merge into one finding."""
    return "Same `file:line`" in text and "one finding" in text


def check_file_line_inside_diff(text: str) -> bool:
    """Merge-time rule: every finding's file:line must fall inside the diff."""
    return "cited file:line" in text and "falls inside the diff" in text


def check_severity_vocabulary(text: str) -> bool:
    """B/M/Q/I/G prefixes are defined exactly once, unambiguously."""
    return bool(
        re.search(
            r"B = blocking, M = major, Q = question, I = minor, G = coverage gap", text
        )
    )


def check_summary_tally_all_severities(text: str) -> bool:
    """Verdict tally counts every actionable severity: blocking, major, minor, gaps."""
    m = re.search(r"Verdict: PASS \| NEEDS WORK \| BLOCK - (.+)", text)
    if not m:
        return False
    tally = m.group(1)
    return all(
        part in tally
        for part in ("blocking", "major", "minor", "questions", "coverage gaps")
    )


def check_step3_tasks_align_scope_law(text: str) -> bool:
    """All four lens tasks carry the unified scope instruction and the old,
    too-strict 'Do not analyze code outside the diff' is gone."""
    tasks = [l for l in text.splitlines() if l.strip().startswith('{"agent"')]
    if len(tasks) != 4:
        return False
    required = (
        "Analyze only the changed lines of the diff",
        "1-hop context per your own Scope law",
        "Do not tighten your Scope boundaries",
    )
    return all(all(r in t for r in required) for t in tasks) and all(
        "Do not analyze code outside the diff" not in t for t in tasks
    )


def check_english_headers_rule(text: str) -> bool:
    """A transversal rule pins report headers/labels to English; headers themselves
    must still appear literally in the output template, and no Spanish literal remains."""
    rule_ok = "headers and finding labels in English" in text
    literals_ok = all(h in text for h in ENGLISH_HEADERS)
    no_spanish = not any(
        w in text
        for w in ("Qué hace", "Por qué pasa", "Consecuencias", "Soluciones", "Observaciones")
    )
    return rule_ok and literals_ok and no_spanish


def check_never_delegate_merge(text: str) -> bool:
    """The merge step stays with the coordinator."""
    return "[NEVER] delegate the merge" in text


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def _norm(text: str) -> str:
    """Collapse every whitespace run to one space so re-wrapping cannot break a match."""
    return " ".join(text.split())


def _gap_cap_ok(rules: str) -> bool:
    rules = _norm(rules)
    return "Coverage gaps:" in rules and "one list, at most 3" in rules and "pablo-test-review" in rules


def check_question_tier(text: str) -> bool:
    """The Question tier exists and the merge rules file defines it and its cap."""
    rules = _norm(_read(MERGE_RULES))
    return (
        "Q = question" in text
        and "references/merge-rules.md" in text
        and "Question (Q)" in rules
        and "Questions: at most 3" in rules
    )


def check_root_cause_single_source(text: str) -> bool:
    """One root-cause definition (merge-rules.md); the old severity rule is gone and
    every lens SKILL.md points to merge-rules.md. Fails until WP-B/C/D add pointers."""
    return (
        "## Root cause" in _read(MERGE_RULES)
        and "keep the higher severity" not in text
        and all(p.is_file() and "merge-rules.md" in _read(p) for p in LENS_SKILLS)
    )


def check_four_part_b_m_only(text: str) -> bool:
    """Four-part shape only for Blocking/Major (open decision 3 default)."""
    return "Blocking and Major use this four-part shape" in text and "one-line shapes" in text


def check_minor_has_suggestion(text: str) -> bool:
    """A Minor is one line with at least one concrete suggestion."""
    return "Suggestion:" in text and "at least one concrete suggestion" in text


def check_strengths_note(text: str) -> bool:
    """Optional uncounted Strengths note is in the template and never counted."""
    rules = _norm(_read(MERGE_RULES))
    return "**Strengths:**" in text and "never counted" in text and "Strengths" in rules


def check_persist_report_rule(text: str) -> bool:
    """The old 'chat output only' rule is gone; the report is persisted per learning-loop.md."""
    return (
        "[NEVER] persist the report" not in text
        and "learning-loop.md" in text
        and "§ Report file" in text
        and "## Report file" in _read(LEARNING_LOOP)
    )


def check_harvest_section(text: str) -> bool:
    """SKILL.md has the harvest section and trigger phrase; learning-loop.md holds the procedure."""
    head = text.split("---", 2)[1] if text.startswith("---") else ""
    loop = _read(LEARNING_LOOP)
    return (
        '"harvest PR <url>"' in head
        and "## Harvest (user-triggered)" in text
        and "§ Harvest" in text
        and "## Harvest\n" in loop
        and all(k in loop for k in ("fetch_comments.py", "set-feedback", "pre_skill", "recall_misses",
                                    "Praise", "0.5", "unseen", "this_pr_only"))
        and len(text.splitlines()) <= 252
    )


def check_approval_message_shape(text: str) -> bool:
    """learning-loop.md pins the English approval message: header, max 3 questions, a-f, reply grammar."""
    loop = _read(LEARNING_LOOP)
    if "## Approval message" not in loop:
        return False
    section = loop.split("## Approval message", 1)[1]
    return all(
        k in section
        for k in (
            "Harvest <repo>#<N> r<k>:", "auto-matched (collapsed)", "recall misses",
            "Questions (max 3, by value):",
            "a) wrong", "b) right but not worth it", "c) business knowledge",
            "d) did not read it / too long", "e) this PR only", "f) skip",
            "Proposals:", "Reply: `1b 2d`",
            "ok | ok 1,3 | edit 2:<text> | reject 4 | scope 5: repo|org|ml|pr",
            "At most 3 questions", "nothing is written",
        )
    ) and not re.search(r"Preguntas|Propuestas|Responde", section)


def check_gitignore_private_dirs(text: str) -> bool:
    """Reports and repo lessons are private: both directories stay git-ignored."""
    lines = _read(GITIGNORE).splitlines()
    return "reviews/" in lines and "repo-lessons/" in lines


def check_taxonomy_15(text: str) -> bool:
    """taxonomy.md (the single source parsed by store.py) lists exactly 15 slugs."""
    sys.path.insert(0, str(SKILL_MD.parent / "scripts"))
    try:
        import store
        return len(store.taxonomy(TAXONOMY)) == 15
    except Exception:
        return False


def check_test_lens_dispatched(text: str) -> bool:
    """A dispatch task runs the pablo-test-review lens."""
    return any(
        l.strip().startswith('{"agent"') and '"skills": ["pablo-test-review"]' in l
        for l in text.splitlines()
    )


def check_gap_cap_rule(text: str) -> bool:
    """Coverage gaps from qa and the test lens form one list capped at 3."""
    return _gap_cap_ok(_read(MERGE_RULES))


def check_full_report_final_message(text: str) -> bool:
    """The final assistant message is the COMPLETE report: no recap, preamble or closing note."""
    t = _norm(text)
    return all(
        k in t
        for k in ("final assistant message of a run is the COMPLETE report", "never a recap",
                  "never preceded by a preamble", 'closing note such as "Report saved to',
                  "nothing outside the template")
    )


def check_persist_printed_verbatim(text: str) -> bool:
    """Persistence writes the printed text as the body via a mktemp file and cleans up temp files."""
    t = _norm(text)
    loop = _norm(_read(LEARNING_LOOP))
    return (
        "`mktemp`" in t and "`--body`" in t and "stores it verbatim as the body" in t
        and "delete every temp file" in t and "diff files given to subagents" in t
        and "mktemp" in loop and "Delete every temp file" in loop
    )


def check_item_id_shape(text: str) -> bool:
    """Every item's head opens with id and tier in one shape; the old '[tier] ... (id)' shape is gone."""
    heads = (
        r"\*\*M1 \[Major - ", r"\*\*Q1 \[Question - ", r"\*\*I1 \[Minor - ",
        r"\*\*T1 \[Nit - ", r"\*\*O1 \[Observation - ", r"\*\*G1 \[Gap - ", r"B1 \[Blocking - ",
    )
    old_shape = re.search(r"^\*\*\[(Question|Minor|Major|Blocking) - ", text, flags=re.M)
    return (
        all(re.search(h, text) for h in heads)
        and not old_shape
        and "`**<id> [<tier> - <lens(es)>] <location>: <text>**`" in _norm(text)
        and "by tier, then rank, across the whole report" in _norm(text)
        and "every printed item's head is" in _norm(_read(MERGE_RULES)).lower()
    )


def check_rebase_rule(text: str) -> bool:
    """Re-review of a rebased PR: no incremental diff, carried-over rows, one pointer in SKILL.md."""
    rules = _norm(_read(MERGE_RULES))
    return (
        "## Re-review" in rules
        and "PR was rebased; no incremental diff" in rules
        and "by file path and root cause" in rules
        and "carried over" in rules
        and "textually unchanged" in rules
        and "rebased" in text and "carried over" in text
        and "## Root cause" in _read(MERGE_RULES)
    )


def check_no_change_rule(text: str) -> bool:
    """Re-review with an unchanged head prints only the 'No changes' line and the status table."""
    rules = _norm(_read(MERGE_RULES))
    return (
        "### No new commits" in rules
        and "`No changes since round r<k> (head <sha7>).`" in rules
        and "nothing else: no preamble, notes, decisions or extra tables" in rules
        and "Do not dispatch lenses and do not write a new ledger round" in rules
        and "run the complete pipeline as a new round even when the head is unchanged" in rules
        and "prior items are always cited as `r<k>:<id>`" in rules
        and "No changes since round" in text
    )


def check_test_lens_na_line(text: str) -> bool:
    """'Test lens: not applicable.' is its own line, first in the Summary."""
    t = _norm(text)
    return (
        "`Test lens: not applicable.` as its own line, the first line of the Summary section" in t
        and bool(re.search(r"### Summary\nTest lens: not applicable\.", text))
    )


def check_coordinator_lookups(text: str) -> bool:
    """The coordinator may resolve a lens Question with read-only lookups and prints one line."""
    t = _norm(text)
    return (
        "read-only lookups (`gh api`, `grep`)" in t
        and "`Resolved by lookup: <id> <one-line answer>` (max 3)" in t
        and "becomes a finding" in t
    )


def check_other_files_one_line(text: str) -> bool:
    """A file with no findings is one line under 'Other files'."""
    return "### Other files" in text and "one line per file with no findings" in _norm(text)


def check_four_lens_store(text: str) -> bool:
    """store.py accepts the 4 lenses, test lens included."""
    sys.path.insert(0, str(SKILL_MD.parent / "scripts"))
    try:
        import store
        return store.LENSES[-1] == "pablo-test-review" and len(store.LENSES) == 4
    except Exception:
        return False


def check_status_table_columns(text: str) -> bool:
    """Status table has exactly three columns, no extra column or prose line; SKILL.md says so."""
    rules = _norm(_read(MERGE_RULES))
    return (
        "EXACTLY three columns: `Prior item | Title | Status`" in rules
        and "`resolved` | `open` | `outdated`" in rules
        and "A full re-run adds no extra column and no prose line between the Summary and the first file section" in rules
        and "exactly 3 columns `Prior item | Title | Status`, no prose line" in _norm(text)
    )


def check_no_trailing_after_table(text: str) -> bool:
    """No-change output ends with the status table: no notes, explanations, offers or questions."""
    rules = _norm(_read(MERGE_RULES))
    return (
        "Print nothing after the status table: no notes, explanations of where statuses came from, offers or questions."
        in rules
    )


def check_mktemp_rule(text: str) -> bool:
    """Temp files MUST come from mktemp (no fixed /tmp paths) and be deleted at the end."""
    t = _norm(text)
    return (
        "Temp files MUST be created with `mktemp`" in t
        and "never fixed paths such as `/tmp/<name>.diff`" in t
        and "deleted at the end" in t
    )


CHECKS = [
    ("merge_by_file_line", check_merge_by_file_line),
    ("file_line_inside_diff", check_file_line_inside_diff),
    ("severity_vocabulary", check_severity_vocabulary),
    ("summary_tally_all_severities", check_summary_tally_all_severities),
    ("step3_tasks_align_scope_law", check_step3_tasks_align_scope_law),
    ("english_headers_rule", check_english_headers_rule),
    ("never_delegate_merge", check_never_delegate_merge),
    ("question_tier", check_question_tier),
    ("root_cause_single_source", check_root_cause_single_source),
    ("four_part_b_m_only", check_four_part_b_m_only),
    ("minor_has_suggestion", check_minor_has_suggestion),
    ("strengths_note", check_strengths_note),
    ("persist_report_rule", check_persist_report_rule),
    ("gitignore_private_dirs", check_gitignore_private_dirs),
    ("taxonomy_15", check_taxonomy_15),
    ("test_lens_dispatched", check_test_lens_dispatched),
    ("gap_cap_rule", check_gap_cap_rule),
    ("harvest_section", check_harvest_section),
    ("approval_message_shape", check_approval_message_shape),
    ("full_report_final_message", check_full_report_final_message),
    ("persist_printed_verbatim", check_persist_printed_verbatim),
    ("item_id_shape", check_item_id_shape),
    ("rebase_rule", check_rebase_rule),
    ("no_change_rule", check_no_change_rule),
    ("test_lens_na_line", check_test_lens_na_line),
    ("coordinator_lookups", check_coordinator_lookups),
    ("other_files_one_line", check_other_files_one_line),
    ("four_lens_store", check_four_lens_store),
    ("status_table_columns", check_status_table_columns),
    ("no_trailing_after_table", check_no_trailing_after_table),
    ("mktemp_rule", check_mktemp_rule),
]


def main() -> int:
    if not SKILL_MD.is_file():
        print(f"[FAIL] SKILL.md not found at {SKILL_MD}")
        return 1
    text = SKILL_MD.read_text(encoding="utf-8")
    failed = 0
    for name, fn in CHECKS:
        ok = fn(text)
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")
        failed += 0 if ok else 1
    print(f"\n{len(CHECKS) - failed}/{len(CHECKS)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
