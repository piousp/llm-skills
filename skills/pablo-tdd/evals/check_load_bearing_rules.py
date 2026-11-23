#!/usr/bin/env python3
"""Offline guardrail for pablo-tdd: checks that the load-bearing rules of
SKILL.md, references/ and the mocking examples are still present.

No model calls. Pure string checks, stdlib only.

Usage:
    cd <skills-dir>/pablo-tdd && python3 -B evals/check_load_bearing_rules.py

Exit code 0 if every check passes, 1 otherwise.
"""

import re
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent


def _norm(text: str) -> str:
    """Collapse whitespace so re-wrapping cannot break a match."""
    return " ".join(text.split())


def _has_all(text: str, *parts: str) -> bool:
    text = _norm(text)
    return all(p in text for p in parts)


def _has_none(text: str, *parts: str) -> bool:
    text = _norm(text)
    return not any(p in text for p in parts)


def _frontmatter(skill: str) -> str:
    return skill.split("---", 2)[1] if skill.startswith("---") else ""


def check_name_matches_dir(docs):
    m = re.search(r"^name:\s*(\S+)\s*$", _frontmatter(docs["skill"]), re.M)
    return bool(m) and m.group(1) == SKILL_DIR.name


def check_description_routing(docs):
    return _has_all(_frontmatter(docs["skill"]), "TDD", '"write tests"', '"add tests"',
                    '"test plan for this change"', "[DO NOT]", '"what tests are missing"',
                    "pablo-test-review", "bare snippet")


def check_skill_under_500_lines(docs):
    return len(docs["skill"].splitlines()) < 500


def check_red_green_verified(docs):
    return (_has_all(docs["skill"], "Run the new test before touching production code",
                     "fail or error because of the behavior under test", "quote the failure",
                     "is not red yet", "Run the test and the affected suite", "quote the result",
                     "[NEVER] report red or green without a run")
            and _has_none(docs["skill"], "fail on its assertion"))


def check_first_run_pass(docs):
    return (_has_all(docs["skill"],
                     "A new test that passes on its first run stays only if breaking the logic it covers turns it red",
                     "restore the code",
                     "Characterization tests, which pin behavior the code already has before a refactor, are the exception: they pass on their first run")
            and _has_none(docs["skill"], "passes before any production change pins nothing"))


def check_no_loosening(docs):
    return _has_all(docs["skill"],
                    "[NEVER] delete a test or loosen an assertion to reach green",
                    "stop and report it with its output")


def check_cycles_and_done(docs):
    return (_has_all(docs["skill"], "until its boundaries and branches are covered", "**Done**")
            and _has_none(docs["tests"],
                          "then the minimal implementation to pass it, then the next seam"))


def check_seam_confirmation(docs):
    return (_has_all(docs["skill"], "confirm the list with the user once",
                     "[MUST] stop after each seam", "Without a user to ask",
                     "[NEVER] self-confirm seams")
            and _has_none(docs["tests"], "Confirm each seam with the user before writing its tests"))


def check_refactor_pointers(docs):
    return (_has_all(docs["skill"], "refactor-identification", "pablo-code-simplify")
            and _has_none(docs["skill"], "code-review-checklist"))


def check_snippet_exception(docs):
    return _has_all(docs["skill"],
                    "bare snippet request with no repo/change context → Surgical Changes wins, no test plan")


def check_mocking_boundary(docs):
    return (_has_all(docs["skill"],
                     "verifying that call and its arguments on the boundary mock is the assertion")
            and _has_all(docs["mocking"], "the repository or DAO")
            and all(_has_all(docs[k], "CartValidator") and _has_none(docs[k], "CartRepository")
                    for k in ("mock_java", "mock_scala")))


def check_relative_refs_resolve(docs):
    pattern = re.compile(r"(?:references|examples)/[\w.-]+\.md")
    refs = set()
    for key in ("skill", "tests", "mocking"):
        refs.update(pattern.findall(docs[key]))
    return all((SKILL_DIR / ref).is_file() for ref in refs)


CHECKS = [
    check_name_matches_dir, check_description_routing, check_skill_under_500_lines,
    check_red_green_verified, check_first_run_pass, check_no_loosening,
    check_cycles_and_done,
    check_seam_confirmation, check_refactor_pointers, check_snippet_exception,
    check_mocking_boundary, check_relative_refs_resolve,
]


def _read(rel: str) -> str:
    return (SKILL_DIR / rel).read_text(encoding="utf-8")


def main() -> int:
    docs = {
        "skill": _read("SKILL.md"),
        "tests": _read("references/tests.md"),
        "mocking": _read("references/mocking.md"),
        "mock_java": _read("examples/mocking.java.md"),
        "mock_scala": _read("examples/mocking.scala.md"),
    }
    passed = 0
    for check in CHECKS:
        ok = check(docs)
        passed += ok
        print(f"{'PASS' if ok else 'FAIL'} {check.__name__}")
    print(f"{passed}/{len(CHECKS)} passed")
    return 0 if passed == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
