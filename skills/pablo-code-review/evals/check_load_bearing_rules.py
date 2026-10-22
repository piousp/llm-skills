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

# Spanish headers are intentional, never translated: match them literally.
SPANISH_HEADERS = [
    "Qué hace este código",
    "Observaciones (no accionables)",
]


def check_merge_by_file_line(text: str) -> bool:
    """Lenses reporting the same file:line + root cause merge into one finding."""
    return "Same `file:line`" in text and "one finding" in text


def check_file_line_inside_diff(text: str) -> bool:
    """Merge-time rule: every finding's file:line must fall inside the diff."""
    return "cited file:line" in text and "falls inside the diff" in text


def check_severity_vocabulary(text: str) -> bool:
    """B/M/I/G prefixes are defined exactly once, unambiguously."""
    return bool(
        re.search(
            r"B = blocking, M = major, I = minor, G = coverage gap", text
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
        for part in ("blocking", "major", "minor", "coverage gaps")
    )


def check_step3_tasks_align_scope_law(text: str) -> bool:
    """All three lens tasks carry the unified scope instruction and the old,
    too-strict 'Do not analyze code outside the diff' is gone."""
    tasks = [l for l in text.splitlines() if l.strip().startswith('{"agent"')]
    if len(tasks) != 3:
        return False
    required = (
        "Analyze only the changed lines of the diff",
        "1-hop context per your own Scope law",
        "Do not tighten your Scope boundaries",
    )
    return all(all(r in t for r in required) for t in tasks) and all(
        "Do not analyze code outside the diff" not in t for t in tasks
    )


def check_spanish_headers_rule(text: str) -> bool:
    """A transversal rule pins report headers/labels to Spanish; headers themselves
    must still appear literally in the output template."""
    rule_ok = "headers and finding labels in Spanish" in text and (
        "[NEVER] translate them" in text
    )
    literals_ok = all(h in text for h in SPANISH_HEADERS)
    return rule_ok and literals_ok


def check_never_delegate_merge(text: str) -> bool:
    """The merge step stays with the coordinator."""
    return "[NEVER] delegate the merge" in text


CHECKS = [
    ("merge_by_file_line", check_merge_by_file_line),
    ("file_line_inside_diff", check_file_line_inside_diff),
    ("severity_vocabulary", check_severity_vocabulary),
    ("summary_tally_all_severities", check_summary_tally_all_severities),
    ("step3_tasks_align_scope_law", check_step3_tasks_align_scope_law),
    ("spanish_headers_rule", check_spanish_headers_rule),
    ("never_delegate_merge", check_never_delegate_merge),
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
