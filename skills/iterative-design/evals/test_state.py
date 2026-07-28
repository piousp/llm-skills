"""
Layer 1 eval (code-based, offline, free) for scripts/state.py.

Covers the phase-derivation contract the skill itself calls load-bearing:
- Phase 1->2->3 derivation from goal.md/plan.md/technical.md/spec.md presence.
- The 4 contract strings: `phase3-green`, gate headers (phase label + "gate"),
  Phase 4 completion ("complete"/"combined review"), Phase 5 completion
  ("complete").
- `sessions` keyed by basename(cwd), never by --dir/repo_root.
- decisions.md gate-block isolation (an incidental "Phase 4" mention in prose
  must not be mistaken for the gate's own entry).

Run: python3 -m unittest evals.test_state -v   (from the skill's root dir)
  or: python3 evals/test_state.py
"""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
STATE_PY = SKILL_DIR / "scripts" / "state.py"

spec = importlib.util.spec_from_file_location("state", STATE_PY)
state = importlib.util.module_from_spec(spec)
sys.modules["state"] = state
spec.loader.exec_module(state)


class DeriveStateTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.design_dir = Path(self._tmp.name) / "design"
        self.design_dir.mkdir()
        self.repo_root = Path(self._tmp.name)  # no .git -> git_head() returns None, fine

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, name: str, content: str = "x"):
        (self.design_dir / name).write_text(content, encoding="utf-8")

    def next(self):
        return state.derive_state(self.repo_root, self.design_dir)

    # --- phase 1 -> 2 -> 3 ---

    def test_no_goal_reports_phase1(self):
        s = self.next()
        self.assertEqual(s["phase"], 1)
        self.assertEqual(s["phase_name"], "goal-discovery")
        self.assertTrue(s["stage_file"].endswith("goal-discovery.md"))

    def test_goal_only_reports_phase2(self):
        self.write("goal.md")
        s = self.next()
        self.assertEqual(s["phase"], 2)
        self.assertIn("$DESIGN_DIR/goal.md", s["required_inputs"])

    def test_plan_without_technical_stays_phase2(self):
        self.write("goal.md")
        self.write("plan.md")
        s = self.next()
        self.assertEqual(s["phase"], 2)

    def test_plan_and_technical_reports_phase3(self):
        self.write("goal.md")
        self.write("plan.md")
        self.write("technical.md")
        s = self.next()
        self.assertEqual(s["phase"], 3)
        self.assertEqual(s["actor"], "pablo-implementer")

    def test_spec_without_phase3_green_token_stays_phase3(self):
        for f in ("goal.md", "plan.md", "technical.md", "spec.md"):
            self.write(f)
        self.write("decisions.md", "## Some note\nNothing about freezing yet.\n")
        s = self.next()
        self.assertEqual(s["phase"], 3)

    def test_phase3_green_token_without_spec_stays_phase3(self):
        for f in ("goal.md", "plan.md", "technical.md"):
            self.write(f)
        self.write("decisions.md", "phase3-green at abc123\n")
        s = self.next()
        self.assertEqual(s["phase"], 3)

    # --- Phase 4 gate ---

    def test_phase3_green_plus_spec_opens_phase4_gate_unanswered(self):
        for f in ("goal.md", "plan.md", "technical.md", "spec.md"):
            self.write(f)
        self.write("decisions.md", "phase3-green at abc123\n")
        s = self.next()
        self.assertEqual(s["phase"], 4)
        self.assertEqual(s["gate_status"], "unanswered")
        self.assertIsNone(s["stage_file"])

    def test_phase4_header_missing_gate_word_does_not_count_as_answered(self):
        # Regression net for the header contract: label + "gate" both required.
        for f in ("goal.md", "plan.md", "technical.md", "spec.md"):
            self.write(f)
        self.write(
            "decisions.md",
            "phase3-green at abc123\n\n## Phase 4 (2026-01-02)\nDecision: skip\n",
        )
        s = self.next()
        self.assertEqual(s["gate_status"], "unanswered", "header lacks the word 'gate'")

    def test_phase4_gate_skip_jumps_to_phase5_gate(self):
        for f in ("goal.md", "plan.md", "technical.md", "spec.md"):
            self.write(f)
        self.write(
            "decisions.md",
            "phase3-green at abc123\n\n## Phase 4 gate: skip (2026-01-02)\nDecision: skip\n",
        )
        s = self.next()
        self.assertEqual(s["phase"], 5)
        self.assertEqual(s["gate_status"], "unanswered")

    def test_phase4_run_without_completion_marker_stays_active(self):
        for f in ("goal.md", "plan.md", "technical.md", "spec.md"):
            self.write(f)
        self.write(
            "decisions.md",
            "phase3-green at abc123\n\n## Phase 4 gate: run (2026-01-02)\nDecision: run\n",
        )
        s = self.next()
        self.assertEqual(s["phase"], 4)
        self.assertEqual(s["phase_name"], "refactor")
        self.assertEqual(s["gate_status"], "run")

    def test_phase4_run_with_wrong_completion_word_stays_active(self):
        # Regression net: only "complete" / "combined review" close Phase 4.
        for f in ("goal.md", "plan.md", "technical.md", "spec.md"):
            self.write(f)
        self.write(
            "decisions.md",
            "phase3-green at abc123\n\n## Phase 4 gate: run (2026-01-02)\nDecision: run\n\n"
            "## Phase 4 finished (2026-01-03)\nDecision: n/a\n",
        )
        s = self.next()
        self.assertEqual(s["phase"], 4, "'finished' must not satisfy the completion contract")

    def test_phase4_run_with_completion_marker_opens_phase5_gate(self):
        for f in ("goal.md", "plan.md", "technical.md", "spec.md"):
            self.write(f)
        self.write(
            "decisions.md",
            "phase3-green at abc123\n\n## Phase 4 gate: run (2026-01-02)\nDecision: run\n\n"
            "## Phase 4 complete (2026-01-03)\nDecision: n/a\n",
        )
        s = self.next()
        self.assertEqual(s["phase"], 5)
        self.assertEqual(s["gate_status"], "unanswered")

    # --- Phase 5 gate ---

    def test_phase5_run_without_completion_stays_active(self):
        for f in ("goal.md", "plan.md", "technical.md", "spec.md"):
            self.write(f)
        self.write(
            "decisions.md",
            "phase3-green at abc123\n\n## Phase 4 gate: skip (2026-01-02)\nDecision: skip\n\n"
            "## Phase 5 gate: run (2026-01-03)\nDecision: run\n",
        )
        s = self.next()
        self.assertEqual(s["phase"], 5)
        self.assertEqual(s["phase_name"], "qa")
        self.assertEqual(s["gate_status"], "run")

    def test_phase5_complete_reports_done(self):
        for f in ("goal.md", "plan.md", "technical.md", "spec.md"):
            self.write(f)
        self.write(
            "decisions.md",
            "phase3-green at abc123\n\n## Phase 4 gate: skip (2026-01-02)\nDecision: skip\n\n"
            "## Phase 5 gate: run (2026-01-03)\nDecision: run\n\n"
            "## Phase 5 complete (2026-01-04)\nDecision: n/a\n",
        )
        s = self.next()
        self.assertEqual(s["phase"], "done")

    def test_incidental_prose_mention_does_not_leak_into_gate_block(self):
        # A gate must be anchored on its own '## ' header; mentioning "Phase 4"
        # inside a different section's prose must not be read as its answer.
        for f in ("goal.md", "plan.md", "technical.md", "spec.md"):
            self.write(f)
        self.write(
            "decisions.md",
            "phase3-green at abc123\n\n"
            "## Phase 1 note (2026-01-01)\n"
            "Decision: kept scope narrow, deferred Phase 4 concerns to later.\n",
        )
        s = self.next()
        self.assertEqual(s["phase"], 4)
        self.assertEqual(s["gate_status"], "unanswered", "prose mention must not count as the gate answer")


class SessionsTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._tmp_root = Path(self._tmp.name)
        self._orig_environ_tmpdir = None
        import os
        self._os = os
        self._orig_environ_tmpdir = os.environ.get("TMPDIR")
        os.environ["TMPDIR"] = str(self._tmp_root)
        self._orig_cwd = Path.cwd()
        self.repo_dir = self._tmp_root / "myrepo"
        self.repo_dir.mkdir()
        self._os.chdir(self.repo_dir)

    def tearDown(self):
        self._os.chdir(self._orig_cwd)
        if self._orig_environ_tmpdir is None:
            self._os.environ.pop("TMPDIR", None)
        else:
            self._os.environ["TMPDIR"] = self._orig_environ_tmpdir
        self._tmp.cleanup()

    def test_sessions_keyed_by_basename_cwd_not_dir_arg(self):
        base = self._tmp_root / "iterative-design" / "myrepo"
        pid_dir = base / "12345"
        pid_dir.mkdir(parents=True)
        (pid_dir / "goal.md").write_text("x")

        # --dir points somewhere unrelated; the session key must still be
        # basename(cwd) == "myrepo", never derived from --dir.
        unrelated_dir = self._tmp_root / "unrelated-repo-name"
        unrelated_dir.mkdir()
        sessions = state.list_sessions(unrelated_dir)

        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]["pid"], "12345")
        self.assertEqual(sessions[0]["phase"], 2)  # goal.md exists, plan/technical don't

    def test_sessions_empty_when_no_prior_launches(self):
        sessions = state.list_sessions(self._tmp_root)
        self.assertEqual(sessions, [])

    def test_sessions_sorted_newest_first(self):
        import time
        base = self._tmp_root / "iterative-design" / "myrepo"
        older = base / "111"
        newer = base / "222"
        older.mkdir(parents=True)
        (older / "goal.md").write_text("x")
        time.sleep(0.01)
        newer.mkdir(parents=True)
        (newer / "goal.md").write_text("x")

        sessions = state.list_sessions(self._tmp_root)
        self.assertEqual([s["pid"] for s in sessions], ["222", "111"])


if __name__ == "__main__":
    unittest.main()
