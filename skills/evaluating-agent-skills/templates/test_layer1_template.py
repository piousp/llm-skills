#!/usr/bin/env python3
"""
TEMPLATE — Layer 1 (code-based, offline, free) tests for a target skill's own
scripts/*.py. Copy into <target-skill>/evals/test_layer1_<module>.py and:

  1. Import the real module under test from scripts/ (adjust sys.path).
  2. Replace ExampleTest with real unittest.TestCase classes covering the
     module's actual logic: parsing, derivation, path resolution — anything
     with real branching, not prose.

Only applies if the target skill ships a script with real logic (SKILL.md
step 4, L1 row). Skip this file entirely for pure-markdown skills.

Run directly, no env var gate — this layer is free and offline:
    cd <target-skill-dir>
    python3 -m unittest evals.test_layer1_<module> -v
"""
import sys
import unittest
from pathlib import Path

# TODO 1: point at the target skill's scripts/ dir and import the real module.
SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))
# import your_module  # noqa: E402


class ExampleTest(unittest.TestCase):
    """TODO 2: replace with real assertions against your_module's functions."""

    def test_placeholder(self):
        self.assertTrue(True, "replace this with a real assertion")


if __name__ == "__main__":
    unittest.main()
