#!/usr/bin/env python3
"""Layer 1 (offline, free) tests for scripts/mistakes_path.py.

The script owns the cwd-key sanitization and path resolution - the one piece
of the skill with real branching. Pure-markdown flows are covered by L2/L3.

Run:
    cd <skill-dir>
    python3 -m unittest evals.test_layer1_mistakes_path -v
"""
import os
import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import mistakes_path  # noqa: E402


class CwdKeyTest(unittest.TestCase):
    def test_regular_path_mirrors_pi_project_key(self):
        self.assertEqual(
            mistakes_path.cwd_key("/Users/pabloperaza/LLMs"),
            "--Users-pabloperaza-LLMs--",
        )

    def test_trailing_slash_ignored(self):
        self.assertEqual(
            mistakes_path.cwd_key("/Users/pabloperaza/LLMs/"),
            "--Users-pabloperaza-LLMs--",
        )

    def test_segment_with_hyphen_is_accepted(self):
        # A literal '-' inside a segment collides with the separator by design
        # (KISS, Q6b): the key is a label, never reversed.
        self.assertEqual(mistakes_path.cwd_key("/A/b-c/d"), "--A-b-c-d--")

    def test_root_path(self):
        self.assertEqual(mistakes_path.cwd_key("/"), "----")

    def test_single_segment(self):
        self.assertEqual(mistakes_path.cwd_key("/tmp"), "--tmp--")


class MistakesFileTest(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get("PI_MISTAKES_ROOT")

    def tearDown(self):
        if self._saved is None:
            os.environ.pop("PI_MISTAKES_ROOT", None)
        else:
            os.environ["PI_MISTAKES_ROOT"] = self._saved

    def test_default_root_is_home_pi_agent_mistakes(self):
        os.environ.pop("PI_MISTAKES_ROOT", None)
        expected = Path.home() / ".pi" / "agent" / "mistakes"
        self.assertEqual(mistakes_path.mistakes_root(), expected)

    def test_env_override_isolates_root(self):
        os.environ["PI_MISTAKES_ROOT"] = "/tmp/iso-root"
        got = mistakes_path.mistakes_file("/Users/pabloperaza/LLMs")
        self.assertEqual(
            got, Path("/tmp/iso-root/--Users-pabloperaza-LLMs--/mistakes.md")
        )

    def test_file_name_is_mistakes_md(self):
        os.environ["PI_MISTAKES_ROOT"] = "/tmp/iso-root"
        self.assertEqual(
            mistakes_path.mistakes_file("/x").name, "mistakes.md"
        )


if __name__ == "__main__":
    unittest.main()
