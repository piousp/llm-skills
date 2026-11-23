#!/usr/bin/env python3
"""Offline guardrail for pablo-code-simplify: checks that the load-bearing rules
of SKILL.md are still present and that its gate table matches
refactor-identification's fowler-catalog.md.

No model calls. Pure string checks, stdlib only.

Usage:
    cd <skills-dir>/pablo-code-simplify && python3 -B evals/check_load_bearing_rules.py

Exit code 0 if every check passes, 1 otherwise.
"""

import json
import re
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
CATALOG = SKILL_DIR.parent / "refactor-identification" / "references" / "fowler-catalog.md"
MAX_LINES = 300
FIELD_LABELS = ("- Lens:", "- Principle:", "- Operation:", "- Tier:", "- References:",
                "- Behavior-preservation argument:", "- Verify:")


def _norm(text: str) -> str:
    """Collapse whitespace so re-wrapping cannot break a match."""
    return " ".join(text.split())


def _has_all(text: str, *parts: str) -> bool:
    text = _norm(text)
    return all(p in text for p in parts)


def _frontmatter(skill: str) -> str:
    return skill.split("---", 2)[1] if skill.startswith("---") else ""


def _between(text: str, start: str, end: str) -> str:
    """Text from the first `start` up to the first later `end`; "" if either is missing."""
    i = text.find(start)
    if i < 0:
        return ""
    j = text.find(end, i + len(start))
    return "" if j < 0 else text[i:j]


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _catalog_rows(catalog: str) -> list[tuple[str, str]]:
    """(operation, owner cell) of catalog rows whose owner cell names `pablo-code-simplify`."""
    out = []
    for line in catalog.splitlines():
        if not line.startswith("| "):
            continue
        c = _cells(line)
        if len(c) >= 2 and "`pablo-code-simplify`" in c[1]:
            out.append((c[0], c[1]))
    return out


def _gate_rows(skill: str) -> list[tuple[str, str]]:
    """(1st cell, 2nd cell) of the gate table rows, header excluded."""
    sec = _between(skill, "## The mechanical-change gate", "## Failure handling")
    out = []
    for line in sec.splitlines():
        if not line.startswith("| "):
            continue
        c = _cells(line)
        if len(c) >= 2 and c[0] != "Operation" and not set(c[0]) <= set("-: "):
            out.append((c[0], c[1]))
    return out


def check_name_matches_dir(skill, catalog):
    m = re.search(r"^name:\s*(\S+)\s*$", _frontmatter(skill), re.M)
    return bool(m) and m.group(1) == SKILL_DIR.name


def check_description_routing(skill, catalog):
    fm = _norm(_frontmatter(skill))
    return (_has_all(fm, '"simplify this code"', '"clean up this function"', '"clean up this code"',
                     "[NEVER]", "[DO NOT]", "refactor-identification", "qa-adversary",
                     "pablo-code-review", "pablo-pr-review", "Java, Scala, JS and TS")
            and '"clean this up"' not in fm)


def check_line_cap(skill, catalog):
    return len(skill.splitlines()) <= MAX_LINES


def check_no_em_dash(skill, catalog):
    return "—" not in skill


def check_scope_intake(skill, catalog):
    return _has_all(skill, "Take it from the request when it names exactly one",
                    "[NEVER] auto-detect", "`pasted.<ext>`", "`Read at`",
                    "`Read at` must be the checked-out HEAD")


def check_synthetic_diff(skill, catalog):
    return (_has_all(skill, "git diff --no-index /dev/null", "[NEVER] reframe non-diff content")
            and "Treat this supplied content as the diff in full" not in _norm(skill))


def check_two_lens_dispatch(skill, catalog):
    lines = [l for l in skill.splitlines() if l.lstrip().startswith('{"agent"')]
    if len(lines) != 2:
        return False
    try:
        calls = [json.loads(l.strip()) for l in lines]
    except ValueError:
        return False
    return (all(c.get("agent") == "analyst" and c.get("timeoutMs") == 1200000
                and "<diff>" in str(c.get("task", "")) for c in calls)
            and calls[0].get("skills") == ["refactor-identification"]
            and calls[1].get("skills") == ["pablo-code-philosophy"]
            and _has_all(skill, "in the same turn", "refactor-identification: out of language scope"))


def check_philosophy_contract(skill, catalog):
    line = next((l for l in skill.splitlines() if '"skills": ["pablo-code-philosophy"]' in l), "")
    return (_has_all(line, "Read at most 1 hop", "Anchor every finding on an added or modified line",
                     "`file:line | axis | principle | evidence`", "misleading name",
                     "test, spec or fixture code")
            and "Both subagents stay capped at 1 hop" not in _norm(skill))


def check_merge_rules(skill, catalog):
    return _has_all(skill, "merge-rules.md", "§ Root cause",
                    "`refactor-identification` P3 → Not mechanical",
                    "P1 and P2 enter the gate",
                    "Drop a philosophy finding that is not anchored")


def check_reference_resolution(skill, catalog):
    return _has_all(skill, "**Resolve references.**", "One hop is one reference edge",
                    "up to 3 hops",
                    "reflection, serialization, DI, config strings or a framework naming convention")


def check_pinning_tests(skill, catalog):
    return _has_all(skill, "**Find pinning tests.**", "`test_file:line`", "only after opening it")


def check_gate_synced_with_catalog(skill, catalog):
    owners = _catalog_rows(catalog)
    gate = _gate_rows(skill)
    if not catalog or not owners or not gate:
        return False
    if any(tier not in ("mechanical", "internal-signature") for _, tier in gate):
        return False
    for op, owner in owners:
        rows = [(o, t) for o, t in gate if op in o]
        if not rows:
            return False
        want = ("internal-signature" if "internal-signature" in owner
                else "mechanical" if "mechanical" in owner else None)
        if want and any(t != want for _, t in rows):
            return False
    return True


def check_gate_rewrite_rows(skill, catalog):
    sec = _between(skill, "## The mechanical-change gate", "## Failure handling")
    return (bool(sec)
            and _has_all(sec,
                         "| Slide Statements, Split Loop | mechanical | No data dependency crossed, no side effect reordered |",
                         "| Move Statements into Function, Move Statements to Callers | mechanical | Non-exported function; references resolved (step 5);",
                         "| Rename Variable, Rename Field, rename of any non-exported symbol | mechanical | Non-exported symbol; references resolved (step 5) |",
                         "| Remove Dead Code: an unused non-exported symbol, import or variable | mechanical | Zero references (step 5) |",
                         "| Collapse duplicated branches | mechanical |",
                         "always fails N3")
            and "fold a duplicated effect" not in _norm(sec))


def check_failure_handling(skill, catalog):
    return _has_all(skill, "## Failure handling", "`No changes in <scope>.`",
                    "`Scope error: <command>: <error>`", "`<lens>: failed (<error>)`",
                    "`mktemp`", "[NEVER] invent a lens's candidates",
                    "[NEVER] run the lenses inline",
                    "`Scope error: Read at <sha7> is not checked out.`",
                    "[NEVER] check it out yourself",
                    "When no dispatched lens succeeds")


def check_output_template(skill, catalog):
    sec = _between(skill, "## Output format", "### Mini example")
    order = ["## Simplification Plan:", "### Scope", "### Steps",
             "### Not mechanical (follow-up)", "### Summary:"]
    pos = [sec.find(h) for h in order]
    return (bool(sec) and all(p >= 0 for p in pos) and pos == sorted(pos)
            and all(f in sec for f in FIELD_LABELS)
            and _has_all(skill, "Headings and field labels stay in English",
                         "Emit this template verbatim",
                         "and so do the Lens, Principle, Operation and Tier values"))


def check_example_follows_template(skill, catalog):
    sec = _between(skill, "### Mini example", "\n## Rules")
    ops = re.findall(r"^\s*- Operation: (.+?)\s*$", sec, re.M)
    firsts = [o for o, _ in _gate_rows(skill)]
    return (bool(sec) and all(f in sec for f in FIELD_LABELS)
            and _has_all(sec, "### Not mechanical (follow-up)", "### Summary:", "Order.java",
                         "- Operation: Inline Function - Tier: mechanical")
            and "order.py" not in skill
            and len(ops) >= 1
            and all(any(op in first for first in firsts) for op in ops))


def check_tdd_alignment(skill, catalog):
    return (_has_all(skill, "(seam to confirm per `pablo-tdd` before implementation)",
                     "`pablo-tdd`'s Red, verified rule exempts it",
                     "[NEVER] ask the user to confirm it during this skill")
            and "red-before-green" not in _norm(skill)
            and "seam confirmed with the user" not in _norm(skill))


def check_read_only_and_chat_only(skill, catalog):
    return _has_all(skill, "read-only on the repository",
                    "[NEVER] write, edit, or apply any code change",
                    "[NEVER] persist the plan to a file")


CHECKS = [
    check_name_matches_dir, check_description_routing, check_line_cap, check_no_em_dash,
    check_scope_intake, check_synthetic_diff, check_two_lens_dispatch,
    check_philosophy_contract, check_merge_rules, check_reference_resolution,
    check_pinning_tests, check_gate_synced_with_catalog, check_gate_rewrite_rows,
    check_failure_handling,
    check_output_template, check_example_follows_template, check_tdd_alignment,
    check_read_only_and_chat_only,
]


def main() -> int:
    skill = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
    catalog = CATALOG.read_text(encoding="utf-8") if CATALOG.exists() else ""
    passed = 0
    for check in CHECKS:
        ok = check(skill, catalog)
        passed += ok
        print(f"{'PASS' if ok else 'FAIL'} {check.__name__}")
    print(f"{passed}/{len(CHECKS)} passed")
    return 0 if passed == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
