#!/usr/bin/env python3
"""
Layer 1 (code-based, offline, free) regression test for this skill's own
templates/. Formalizes what was validated manually when the skill was built:
every template parses, and the two live-gated harness templates return 0 on
the PI_LIVE_EVAL-unset skip path. Catches a future edit breaking template
syntax or the skip-gate convention.

No LLM calls, runs in under a second:
    python3 -m unittest evals.test_templates -v
"""
import ast
import os
import subprocess
import sys
import unittest
from pathlib import Path

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"


class TemplatesParseTest(unittest.TestCase):
    def test_all_python_templates_parse(self):
        py_files = sorted(TEMPLATES_DIR.glob("*.py"))
        self.assertTrue(py_files, "no .py templates found — did the layout change?")
        for f in py_files:
            with self.subTest(file=f.name):
                ast.parse(f.read_text())

    def test_prompt_set_template_is_valid_json_with_required_keys(self):
        import json
        data = json.loads((TEMPLATES_DIR / "prompt_set.json").read_text())
        self.assertIsInstance(data, list)
        for case in data:
            self.assertTrue({"id", "prompt", "should_trigger", "expected_checks"} <= case.keys())


class LiveGatedTemplatesSkipCleanlyTest(unittest.TestCase):
    """Both live-gated harness templates must exit 0 and print a skip message
    when PI_LIVE_EVAL is unset — never silently run real LLM calls."""

    def _run_without_gate(self, filename: str) -> subprocess.CompletedProcess:
        env = {k: v for k, v in os.environ.items() if k != "PI_LIVE_EVAL"}
        return subprocess.run(
            [sys.executable, str(TEMPLATES_DIR / filename)],
            capture_output=True, text=True, env=env, timeout=30,
        )

    def test_run_layer2_probes_skips_cleanly(self):
        result = self._run_without_gate("run_layer2_probes.py")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Skipped", result.stdout)

    def test_judge_skips_cleanly(self):
        result = self._run_without_gate("judge.py")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Skipped", result.stdout)


if __name__ == "__main__":
    unittest.main()
