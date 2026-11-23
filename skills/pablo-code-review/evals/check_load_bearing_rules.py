#!/usr/bin/env python3
"""Offline guardrail for pablo-code-review: checks that the load-bearing rules
of SKILL.md and references/merge-rules.md are still present, and that the
Blocker gate and Root cause sections still mirror pablo-pr-review's
references/merge-rules.md.

No model calls. Pure string checks, stdlib only.

Usage:
    cd <skills-dir>/pablo-code-review && python3 -B evals/check_load_bearing_rules.py

Exit code 0 if every check passes, 1 otherwise.
"""

import re
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
LENSES = ("qa-adversary", "code-review-checklist", "refactor-identification", "pablo-test-review")
PR_RULES = SKILL_DIR.parent / "pablo-pr-review" / "references" / "merge-rules.md"


def _norm(text: str) -> str:
    """Collapse whitespace so re-wrapping cannot break a match."""
    return " ".join(text.split())


def _has_all(text: str, *parts: str) -> bool:
    text = _norm(text)
    return all(p in text for p in parts)


def _row_maps(rules: str, key: str, target: str) -> bool:
    """A tier-map line containing `key` also contains `target`."""
    return any(key in l and target in l for l in rules.splitlines())


def _section(text: str, heading: str) -> str:
    """Lines after the exact `## <heading>` line up to the next `## ` line, exclusive."""
    out, inside = [], False
    for line in text.splitlines():
        if inside and line.startswith("## "):
            break
        if inside:
            out.append(line)
        elif line == f"## {heading}":
            inside = True
    return "\n".join(out)


def _frontmatter(skill: str) -> str:
    return skill.split("---", 2)[1] if skill.startswith("---") else ""


def check_name_matches_dir(skill, rules):
    m = re.search(r"^name:\s*(\S+)\s*$", _frontmatter(skill), re.M)
    return bool(m) and m.group(1) == SKILL_DIR.name


def check_description_triggers(skill, rules):
    return _has_all(_frontmatter(skill), "[DO NOT]", '"review my code"', '"review my branch"',
                    '"before I open the PR"', "pablo-pr-review", "(use codeiq)")


def check_diff_resolution(skill, rules):
    return _has_all(skill, "git merge-base", "refs/remotes/origin/HEAD",
                    "git diff --no-index /dev/null", "+uncommitted", "no `fetch`") and "git fetch" not in skill


def check_four_lenses_no_fifth(skill, rules):
    return (_has_all(skill, "Dispatch the four lenses", "[NEVER] make a fifth call")
            and all(l in skill for l in LENSES)
            and skill.count('{"agent"') == 1
            and '"skills": ["<lens>"]' in skill)


def check_concurrent_and_print_only(skill, rules):
    return (_has_all(skill, "concurrently", "all in the same turn", "no ledger, no lessons")
            and "harvest step" in skill)


def check_strict_bump_rows(skill, rules):
    return (_row_maps(rules, "checklist Minor with a principle tag", "Major (M)")
            and _row_maps(rules, "checklist Minor without a tag", "Minor (I)"))


def check_refactor_rows(skill, rules):
    return (_row_maps(rules, "refactor-identification P1", "Major (M)")
            and _row_maps(rules, "refactor-identification P2", "Minor (I)")
            and _row_maps(rules, "refactor-identification P3", "Observation (O)"))


def check_blocker_failing_gate_is_question(skill, rules):
    return _row_maps(rules, "checklist Blocker passing the Blocker gate", "failing it: Question (Q)")


def check_strict_bump_exemption(skill, rules):
    return _has_all(rules, "predates the diff is exempt and stays Minor", "no other lens item is bumped")


def check_merge_order(skill, rules):
    r = _norm(rules)
    return ("Merge order:" in r
            and "1. Map each lens item" in r
            and "and so does a part anchored outside the diff" in r
            and "2. A lens part whose premise is outside the diff becomes its own Question" in r
            and "3. Merge the in-diff parts by root cause" in r
            and "4. Blocking requires the Blocker gate" in r)


def check_merge_order_single_source(skill, rules):
    s = _norm(skill)
    return "follow its Merge order" in s and "1. Map each lens item" not in s


def check_skip_line(skill, rules):
    line = "<lens>: skipped <files or checks> (<reason>)"
    return (_has_all(skill, line)
            and _has_all(rules, "`Out of language scope:`", "(out of language scope)",
                         "`Skipped:`", line))


def check_verdict_rule(skill, rules):
    s = _norm(skill)
    return (_has_all(rules, "BLOCK iff at least one B; NEEDS WORK iff at least one M")
            and "its `Verdict:` rule" in s
            and "NEEDS WORK iff" not in s
            and "turns PASS into NEEDS WORK" not in s)


def check_caps(skill, rules):
    return _has_all(rules, "Questions: at most 3", "gate a B or M first", "one list, at most 3",
                    "Observations: at most 3", "[NEVER] invent a test name")


def check_output_template(skill, rules):
    return (_has_all(skill, "Verdict: PASS | NEEDS WORK | BLOCK", "Objective:", "Rules hit:",
                     "none (single sensible fix)", "every item in English")
            and all(f"**{k}:**" in skill for k in ("Rule", "Evidence", "Impact", "Fix")))


def check_no_walkthrough(skill, rules):
    return "What this code does" not in skill and "[NEVER] print a walkthrough" in _norm(skill)


def check_test_lens_skip(skill, rules):
    return _has_all(skill, "no test files AND no production source files", "Test lens: not applicable.")


def check_mirror_pr_review(skill, rules):
    if not PR_RULES.exists():
        return False
    pr = PR_RULES.read_text(encoding="utf-8")
    gate = _norm(_section(rules, "Blocker gate"))
    root = _norm(_section(rules, "Root cause"))
    return (bool(gate) and gate == _norm(_section(pr, "Blocker gate"))
            and bool(root) and root in _norm(_section(pr, "Root cause")))


def check_domain_context(skill, rules):
    return _has_all(skill, "Domain context:", "<domain-context-skill>",
                    '"skills": ["qa-adversary", "<domain-context-skill>"]',
                    "domain context: none loaded")


def check_lens_failure(skill, rules):
    return (_has_all(skill, "one retry", "not run (<reason>)", "[NEVER] print PASS with a failed lens")
            and _has_all(rules, "turns PASS into NEEDS WORK"))


CHECKS = [
    check_name_matches_dir, check_description_triggers, check_diff_resolution,
    check_four_lenses_no_fifth, check_concurrent_and_print_only, check_strict_bump_rows,
    check_refactor_rows, check_blocker_failing_gate_is_question, check_strict_bump_exemption,
    check_merge_order, check_verdict_rule, check_caps, check_output_template, check_no_walkthrough,
    check_test_lens_skip, check_mirror_pr_review, check_lens_failure,
    check_merge_order_single_source, check_skip_line, check_domain_context,
]


def main() -> int:
    skill = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
    rules = (SKILL_DIR / "references" / "merge-rules.md").read_text(encoding="utf-8")
    passed = 0
    for check in CHECKS:
        ok = check(skill, rules)
        passed += ok
        print(f"{'PASS' if ok else 'FAIL'} {check.__name__}")
    print(f"{passed}/{len(CHECKS)} passed")
    return 0 if passed == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
