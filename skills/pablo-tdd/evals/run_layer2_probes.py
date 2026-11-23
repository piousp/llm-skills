#!/usr/bin/env python3
"""
Layer 2 (trajectory/tool-call probe) harness for pablo-tdd. Closes D15: the
three test-planning probes that pablo-code-philosophy moved here after the
split (trigger_write_new_service, trigger_suggest_tests,
trigger_implement_scala_function), plus edge_changed_behavior_red_first for the
verified red -> green loop.

Each case runs `pi -ne --skill <this skill> --mode json -p <prompt>` in a fresh
temp directory and grades the final reply, the tool calls and the files left
behind. `--skill` forces the load: there are no trigger probes and no negative
controls.

Gated behind PI_LIVE_EVAL=1 (costs real LLM tokens). One trial per case; repeat
the run 3 to 5 times before trusting a result.

Usage:
    cd <skills-dir>/pablo-tdd && PI_LIVE_EVAL=1 python3 -B evals/run_layer2_probes.py
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
PROMPT_SET_PATH = Path(__file__).resolve().parent / "prompt_set.json"


def run_pi(cwd: Path, prompt: str, timeout: int = 240) -> tuple[list[dict], str]:
    """Runs bare pi non-interactively against the skill, returns
    (tool_calls, final_response_text). tool_calls is a list of
    {"name": str, "arguments": dict}."""
    proc = subprocess.run(
        ["pi", "-ne", "--skill", str(SKILL_DIR), "--mode", "json", "-p", prompt],
        cwd=str(cwd), capture_output=True, text=True, timeout=timeout,
    )
    tool_calls: list[dict] = []
    final_text = ""
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            continue
        if evt.get("type") != "message_end":
            continue
        msg = evt.get("message", {})
        if msg.get("role") != "assistant":
            continue
        texts = [c["text"] for c in msg.get("content", []) if c.get("type") == "text"]
        if texts:
            final_text = " ".join(texts)
        for c in msg.get("content", []):
            if c.get("type") == "toolCall":
                tool_calls.append({"name": c.get("name"), "arguments": c.get("arguments", {})})
    return tool_calls, final_text


# --- Seeds: one isolated fixture per trial ---------------------------------

CALC_PY = "def divide(x, y):\n    return x / y\n"

TEST_CALC_PY = '''import unittest

from calc import divide


class DivideTest(unittest.TestCase):
    def test_divide(self):
        self.assertEqual(divide(10, 2), 5)

    def test_divide_by_zero_raises(self):
        with self.assertRaises(ZeroDivisionError):
            divide(1, 0)


if __name__ == "__main__":
    unittest.main()
'''

MESSY_PY = "def shipping_cost(weight):\n    return 5.0\n"

MESSY_PY_CHANGED = '''def shipping_cost(weight):
    if weight is None:
        raise ValueError("weight is required")
    if weight > 20:
        return 15.0
    return 5.0
'''

TEST_MESSY_PY = '''import unittest

from messy_module import shipping_cost


class ShippingCostTest(unittest.TestCase):
    def test_flat_rate(self):
        self.assertEqual(shipping_cost(1), 5.0)


if __name__ == "__main__":
    unittest.main()
'''


def _seed_empty(tmp: Path) -> Path:
    repo = tmp / "repo"
    repo.mkdir()
    return repo


def _seed_python_repo(tmp: Path) -> Path:
    repo = _seed_empty(tmp)
    files = {
        "calc.py": CALC_PY,
        "test_calc.py": TEST_CALC_PY,
        "messy_module.py": MESSY_PY,
        "test_messy_module.py": TEST_MESSY_PY,
    }
    for name, content in files.items():
        (repo / name).write_text(content, encoding="utf-8")
    git = ["git", "-c", "user.name=eval", "-c", "user.email=eval@example.invalid"]
    for args in (["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "seed"]):
        subprocess.run(git + args, cwd=str(repo), check=True, capture_output=True)
    (repo / "messy_module.py").write_text(MESSY_PY_CHANGED, encoding="utf-8")
    return repo


SEEDS = {
    "empty": _seed_empty,
    "python_repo": _seed_python_repo,
}


def seed_env(tmp: Path, seed: str) -> Path:
    """Builds the fixture for one trial and returns the cwd for pi.
    An unknown seed raises KeyError."""
    return SEEDS[seed](tmp)


# --- CHECK_REGISTRY: (tool_calls, final_text, **ctx) -> bool ---------------

def _is_write(tc: dict) -> bool:
    return tc["name"] in ("write", "edit")


def _path(tc: dict) -> str:
    return str(tc.get("arguments", {}).get("path", ""))


def _is_test_path(path: str) -> bool:
    """True for a test file name (test_*.py, *_test.*, *Test/*Tests/*Spec/*Suite with .java/.scala/.kt, *.test.* or *.spec.* with a JS/TS extension) or a path with a test, tests, __tests__ or spec directory."""
    parts = re.split(r"[\\/]+", path)
    base = parts[-1]
    if any(d.lower() in ("test", "tests", "__tests__", "spec") for d in parts[:-1]):
        return True
    return bool(
        re.match(r"test_.*\.py$", base)
        or "_test." in base
        or re.search(r"(Test|Tests|Spec|Suite)\.(java|scala|kt)$", base)
        or re.search(r"\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$", base))


def _first_write_index(tool_calls, basename: str):
    for i, tc in enumerate(tool_calls):
        if _is_write(tc) and os.path.basename(_path(tc)) == basename:
            return i
    return None


def _last_write_index(tool_calls, basename: str):
    last = None
    for i, tc in enumerate(tool_calls):
        if _is_write(tc) and os.path.basename(_path(tc)) == basename:
            last = i
    return last


def _is_test_run(tc: dict) -> bool:
    return tc["name"] == "bash" and bool(
        re.search(r"unittest|pytest", str(tc.get("arguments", {}).get("command", ""))))


def mentions_keywords(tool_calls, final_text, keywords=(), **ctx) -> bool:
    """The response names at least one of the keywords. Each term is a
    case-insensitive regex (any-of, re.search)."""
    text = final_text.lower()
    return any(re.search(kw.lower(), text) for kw in keywords)


def tests_planned(tool_calls, final_text, **ctx) -> bool:
    """A reply line has at least four | and the word boundary or branch: a test-plan line in the format of references/tests.md (Plan the tests)."""
    return any(line.count("|") >= 4 and re.search(r"(?i)\b(boundary|branch)\b", line)
               for line in final_text.splitlines())


def no_test_files_written(tool_calls, final_text, **ctx) -> bool:
    """No write/edit call targets a test file (_is_test_path)."""
    return not any(_is_write(tc) and _is_test_path(_path(tc)) for tc in tool_calls)


def asks_seam_confirmation(tool_calls, final_text, **ctx) -> bool:
    """The reply asks about seams: seam or seams and a ? in the same sentence."""
    return bool(re.search(r"(?i)\bseams?\b[^.!?\n]*\?", final_text))


def ran_tests_before_prod_edit(tool_calls, final_text, **ctx) -> bool:
    """A test run sits strictly between the first edit of test_calc.py and the
    first edit of calc.py (red verified before production code changes)."""
    t = _first_write_index(tool_calls, "test_calc.py")
    p = _first_write_index(tool_calls, "calc.py")
    if t is None or p is None:
        return False
    return any(_is_test_run(tool_calls[i]) for i in range(t + 1, p))


def ran_tests_after_prod_edit(tool_calls, final_text, **ctx) -> bool:
    """A test run comes after the last edit of calc.py (green verified)."""
    p = _last_write_index(tool_calls, "calc.py")
    if p is None:
        return False
    return any(_is_test_run(tc) for tc in tool_calls[p + 1:])


def new_behavior_asserted(tool_calls, final_text, cwd=None, **ctx) -> bool:
    """test_calc.py in the trial directory asserts the new ValueError."""
    if cwd is None:
        return False
    path = Path(cwd) / "test_calc.py"
    if not path.is_file():
        return False
    content = path.read_text(encoding="utf-8")
    return "ValueError" in content and "assertRaises" in content


CHECK_REGISTRY = {
    "tests_planned": tests_planned,
    "mentions_keywords": mentions_keywords,
    "no_test_files_written": no_test_files_written,
    "asks_seam_confirmation": asks_seam_confirmation,
    "ran_tests_before_prod_edit": ran_tests_before_prod_edit,
    "ran_tests_after_prod_edit": ran_tests_after_prod_edit,
    "new_behavior_asserted": new_behavior_asserted,
}


def resolve_check(check_id: str):
    """Supports "mentions_keywords:<kw1>|<kw2>|..." (each term a
    case-insensitive regex; no single term may contain `|`). Bare check_ids
    come from the registry."""
    if check_id.startswith("mentions_keywords:"):
        _, kws = check_id.split(":", 1)
        keywords = kws.split("|")
        return lambda tc, ft, **ctx: mentions_keywords(tc, ft, keywords=keywords, **ctx)
    return CHECK_REGISTRY[check_id]


def run_probe(case: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        cwd = seed_env(tmp, case["seed"])
        tool_calls, final_text = run_pi(cwd, case["prompt"])
        # Checks run while the temp directory still exists.
        checks = {
            check_id: resolve_check(check_id)(tool_calls, final_text, cwd=str(cwd))
            for check_id in case["expected_checks"]
        }
        return {
            "id": case["id"],
            "checks": checks,
            "passed": all(checks.values()) if checks else True,
            "tool_calls": [tc["name"] for tc in tool_calls],
            "response": final_text,
        }


def main() -> int:
    if os.environ.get("PI_LIVE_EVAL") != "1":
        print("Skipped (set PI_LIVE_EVAL=1 to run; costs real LLM tokens).")
        return 0

    prompt_set = json.loads(PROMPT_SET_PATH.read_text(encoding="utf-8"))
    all_passed = True
    for case in prompt_set:
        result = run_probe(case)
        status = "PASS" if result["passed"] else "FAIL"
        if not result["passed"]:
            all_passed = False
        print(f"[{status}] {result['id']}")
        for check, ok in result["checks"].items():
            print(f"    {'ok' if ok else 'FAIL'}: {check}")
        print(f"    tool_calls: {result['tool_calls']}")
        print(f"    response: {result['response'][:300]!r}")
        print()

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
