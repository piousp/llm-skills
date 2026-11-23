#!/usr/bin/env python3
"""Offline guardrail for code-review-checklist: checks that load-bearing rules are still
present in SKILL.md and references/redflags.*.md.

No model calls. Pure string checks, stdlib only.

Usage:
    cd <this-skill-dir> && python3 -B evals/check_load_bearing_rules.py

Exit code 0 if every check passes, 1 otherwise.
"""

import sys
from pathlib import Path

SKILL_DIR: Path = Path(__file__).resolve().parent.parent
REDFLAGS: tuple[str, ...] = ("redflags.java.md", "redflags.scala.md", "redflags.ts.md")


def _norm(text: str) -> str:
    """Collapse every whitespace run to one space so re-wrapping lines keeps matches."""
    return " ".join(text.split())


def check_secrets_cover_untracked(skill: str, redflags: list[str]) -> bool:
    """The secrets Red Flag covers files under review, tracked or untracked."""
    s = _norm(skill)
    return (
        "Secrets, credentials, or tokens in a file under review, tracked or untracked" in s
        and "tokens in tracked files" not in s
    )


def check_repo_match_before_greps(skill: str, redflags: list[str]) -> bool:
    """Greps and 1-hop reads on a handed-in diff need a repo that matches the diff."""
    s = _norm(skill)
    return (
        "each file the diff modifies exists under it and contains the context lines of its "
        "first hunk" in s
        and "with no modified file, each added file exists under it" in s
        and "Skipped: caller and duplicate checks (repo not available)" in s
        and "at least one path from the diff's file headers" not in s
    )


def check_test_flakiness_out_of_scope(skill: str, redflags: list[str]) -> bool:
    """Test-side flakiness is out of scope here: G1 owns the rule, redflags files point to it."""
    s = _norm(skill)
    flags = [_norm(r) for r in redflags]
    return (
        'report only the secrets and "Test suite broken" Red Flags; drop every other candidate'
        in s
        and all("Test-side flakiness is out of scope here (gate G1)" in r for r in flags)
        and all("judged by" not in r for r in flags)
    )


CHECKS = (
    check_secrets_cover_untracked,
    check_repo_match_before_greps,
    check_test_flakiness_out_of_scope,
)


def main() -> int:
    skill = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
    redflags = [
        (SKILL_DIR / "references" / name).read_text(encoding="utf-8") for name in REDFLAGS
    ]
    passed = 0
    for check in CHECKS:
        ok = check(skill, redflags)
        passed += ok
        print(f"{'PASS' if ok else 'FAIL'} {check.__name__}")
    print(f"{passed}/{len(CHECKS)} passed")
    return 0 if passed == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
