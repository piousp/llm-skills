#!/usr/bin/env python3
"""
Layer 1 (offline, free) regression guard for this eval suite's own harness —
not for a skill script (refactor-identification ships no scripts/*.py, it's
pure markdown, so there is nothing else to unit-test here). Confirms every
script imports cleanly, both prompt sets have the required schema, and both
live-gated scripts respect the PI_LIVE_EVAL skip convention (SKILL.md step 5)
without needing to actually invoke `pi`.

Run directly, no env var gate:
    cd <this-skill-dir>
    python3 -m unittest evals.test_harness -v
"""
import json
import subprocess
import sys
import unittest
from pathlib import Path

EVALS_DIR = Path(__file__).resolve().parent
REQUIRED_KEYS = {"id", "prompt", "should_trigger", "expected_checks"}


class PromptSetSchemaTest(unittest.TestCase):
    def _check_schema(self, path: Path):
        cases = json.loads(path.read_text())
        self.assertIsInstance(cases, list)
        self.assertGreaterEqual(len(cases), 1)
        ids = [c["id"] for c in cases]
        self.assertEqual(len(ids), len(set(ids)), f"duplicate ids in {path.name}")
        for case in cases:
            self.assertEqual(set(case.keys()), REQUIRED_KEYS, f"{path.name}:{case.get('id')}")
            self.assertIsInstance(case["should_trigger"], bool)
            self.assertIsInstance(case["expected_checks"], list)

    def test_prompt_set_schema(self):
        self._check_schema(EVALS_DIR / "prompt_set.json")

    def test_trigger_prompt_set_schema(self):
        self._check_schema(EVALS_DIR / "trigger_prompt_set.json")


class CheckIdCoverageTest(unittest.TestCase):
    """Every expected_checks id referenced by a prompt set must exist in that
    script's CHECK_REGISTRY — catches a typo before it silently no-ops."""

    def test_layer2_checks_registered(self):
        sys.path.insert(0, str(EVALS_DIR))
        import run_layer2_probes as l2  # noqa: E402
        cases = json.loads((EVALS_DIR / "prompt_set.json").read_text())
        for case in cases:
            self.assertIn(case["id"], l2.SEED_REGISTRY, f"missing seed fixture for {case['id']}")
            for check_id in case["expected_checks"]:
                self.assertIn(check_id, l2.CHECK_REGISTRY, f"unregistered check {check_id}")

    def test_trigger_checks_registered(self):
        sys.path.insert(0, str(EVALS_DIR))
        import run_trigger_probes as trig  # noqa: E402
        cases = json.loads((EVALS_DIR / "trigger_prompt_set.json").read_text())
        for case in cases:
            for check_id in case["expected_checks"]:
                self.assertIn(check_id, trig.CHECK_REGISTRY, f"unregistered check {check_id}")


class LiveGateSkipTest(unittest.TestCase):
    """Every live-gated script must exit 0 with a skip message when
    PI_LIVE_EVAL is unset — must never shell out to `pi` by accident."""

    def _assert_skips(self, script: str):
        proc = subprocess.run(
            [sys.executable, str(EVALS_DIR / script)],
            cwd=str(EVALS_DIR), capture_output=True, text=True,
            env={"PATH": "/usr/bin:/bin"},  # deliberately no PI_LIVE_EVAL
        )
        self.assertEqual(proc.returncode, 0, f"{script} did not exit 0 when ungated")
        self.assertIn("Skipped", proc.stdout, f"{script} missing skip message")

    def test_run_layer2_probes_skips(self):
        self._assert_skips("run_layer2_probes.py")

    def test_run_trigger_probes_skips(self):
        self._assert_skips("run_trigger_probes.py")

    def test_judge_skips(self):
        self._assert_skips("judge.py")


if __name__ == "__main__":
    unittest.main()
