#!/usr/bin/env python3
"""Offline guardrail for pablo-test-review: checks that the load-bearing rules
of SKILL.md (routing description, R1 guarantees, unit-only wait silencing and
the integration-test definition) are still present.

No model calls. Pure string checks, stdlib only.

Usage:
    cd <skills-dir>/pablo-test-review && python3 -B evals/check_load_bearing_rules.py

Exit code 0 if every check passes, 1 otherwise.
"""

import re
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
EM_DASH = "\u2014"


def _norm(text: str) -> str:
    """Collapse whitespace so re-wrapping cannot break a match."""
    return " ".join(text.split())


def _has_all(text: str, *parts: str) -> bool:
    text = _norm(text)
    return all(p in text for p in parts)


def _frontmatter(skill: str) -> str:
    return skill.split("---", 2)[1] if skill.startswith("---") else ""


def _description(skill: str) -> str:
    """Frontmatter description without the `>-` indicator, whitespace collapsed."""
    fm = _frontmatter(skill)
    m = re.search(r"^description:\s*(?:[>|][-+]?)?\s*(.*?)(?=^\S|\Z)", fm, re.M | re.S)
    return _norm(m.group(1)) if m else ""


def check_name_matches_dir(docs):
    m = re.search(r"^name:\s*(\S+)\s*$", _frontmatter(docs["skill"]), re.M)
    return bool(m) and m.group(1) == SKILL_DIR.name


def check_description_routing(docs):
    desc = _description(docs["skill"])
    return (_has_all(desc, '"review the tests"', '"can these tests fail"',
                     '"what tests are missing"', "[DO NOT]", "(use pablo-tdd)")
            and len(desc) < 1024)


def check_skill_under_500_lines(docs):
    return len(docs["skill"].splitlines()) < 500


def check_r1_skips_gc_gd(docs):
    return _has_all(docs["skill"], "G-C and G-D never apply to R1")


def check_r1_is_m(docs):
    return _has_all(docs["skill"], "Needs a removed oracle (R1)")


def check_unit_waits_only(docs):
    return _has_all(docs["skill"], "`after(N).never()` in unit tests",
                    "integration-test waits go to R6 and the Waits rule")


def check_integration_definition(docs):
    return _has_all(docs["skill"], "Every other test is a unit test", "`tests/integration/`",
                    "`@pytest.mark.integration`", "`//go:build integration`")


def check_no_em_dash(docs):
    return not any(EM_DASH in docs[k] for k in ("skill", "rubric", "examples", "readme"))


CHECKS = [
    check_name_matches_dir, check_description_routing, check_skill_under_500_lines,
    check_r1_skips_gc_gd, check_r1_is_m, check_unit_waits_only,
    check_integration_definition, check_no_em_dash,
]


def _read(rel: str) -> str:
    return (SKILL_DIR / rel).read_text(encoding="utf-8")


def main() -> int:
    docs = {
        "skill": _read("SKILL.md"),
        "rubric": _read("references/rubric.md"),
        "examples": _read("references/postable-examples.md"),
        "readme": _read("evals/README.md"),
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
