#!/usr/bin/env python3
"""
Layer 1 (offline, free) regression guard for this eval suite's own harness —
not for a skill script (refactor-identification ships no scripts/*.py, it's
pure markdown, so there is nothing else to unit-test here). Confirms every
script imports cleanly, both prompt sets have the required schema, all three
live-gated scripts respect the PI_LIVE_EVAL skip convention (evaluating-agent-skills
SKILL.md step 5), and the trigger fixture creates `main` whatever git's default
branch is, without needing to actually invoke `pi`.

Run directly, no env var gate:
    cd <this-skill-dir>
    python3 -m unittest evals.test_harness -v
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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


class CheckFunctionTest(unittest.TestCase):
    """Seams: the CHECK_REGISTRY functions, fed literal transcripts."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(EVALS_DIR))
        import run_layer2_probes as l2  # noqa: E402
        cls.l2 = l2

    def _check(self, name, text):
        return self.l2.CHECK_REGISTRY[name]([], text, repo=Path("/nonexistent"))

    def test_gate_note_rejects_boilerplate_phrase(self):
        self.assertFalse(self._check(
            "gate_note_present", "- Gate: checked N1–N10, passes; N3 is fine"))

    def test_gate_note_accepts_closest_row_with_reason(self):
        self.assertTrue(self._check(
            "gate_note_present",
            "- Gate: passes; closest row N2 doesn't apply because both apply the same rule"))

    def test_gate_note_accepts_curly_apostrophe(self):
        self.assertTrue(self._check(
            "gate_note_present",
            "- Gate: passes; closest row N2 doesn\u2019t apply because both apply the same rule"))

    def test_scope_has_coverage_line(self):
        self.assertTrue(self._check(
            "scope_has_coverage_line", "### Scope\n- Coverage: complete"))
        self.assertTrue(self._check(
            "scope_has_coverage_line", "- Coverage: partial (Big.java: truncated)"))
        self.assertFalse(self._check(
            "scope_has_coverage_line", "### Scope\n- Files in scope: 1"))

    def test_reports_blocked_without_findings(self):
        blocked = ("## Refactor Candidates: feature\n\n### Scope\n"
                   "- Blocked: fatal: ambiguous argument 'main...HEAD'")
        self.assertTrue(self._check("reports_blocked_without_findings", blocked))
        self.assertFalse(self._check(
            "reports_blocked_without_findings", blocked + "\n### Findings\n- (none)"))


class TriggerFixtureTest(unittest.TestCase):
    """The trigger fixture must create `main` whatever git's default branch is."""

    @unittest.skipUnless(shutil.which("git"), "git not on PATH")
    def test_trigger_fixture_has_main_even_when_git_defaults_to_master(self) -> None:
        env = {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "init.defaultBranch",
               "GIT_CONFIG_VALUE_0": "master"}
        sys.path.insert(0, str(EVALS_DIR))
        try:
            import run_trigger_probes as trig
        finally:
            sys.path.remove(str(EVALS_DIR))
        with mock.patch.dict(os.environ, env), tempfile.TemporaryDirectory() as tmp:
            repo, _ = trig.seed_branch_with_real_diff(Path(tmp), "{FIXTURE_WRITE_TARGET}")

            def git(*args):
                return subprocess.run(["git", "-C", str(repo), *args],
                                      capture_output=True, text=True)

            has_main = git("rev-parse", "--verify", "--quiet", "refs/heads/main")
            self.assertEqual(has_main.returncode, 0,
                             "trigger fixture has no main branch; "
                             "its docstring promises a diff against main")
            diff = git("diff", "--name-only", "main...feature")
            self.assertEqual(diff.returncode, 0, diff.stderr)
            self.assertIn("PaymentService.java", diff.stdout)


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
