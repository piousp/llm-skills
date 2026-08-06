#!/usr/bin/env python3
"""Layer 1 (offline, free) tests for thesis-planning's scripts/state.py.

Covers the branching logic that decides phase and parses chapter status —
the only real logic this skill ships. No live/L2 layer built yet (see
evals/README.md).

Run:
    cd skills/thesis-planning
    python3 -m unittest evals.test_layer1_state -v
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))
import state  # noqa: E402


def write(path, content):
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


class ParseChaptersTest(unittest.TestCase):
    def test_explicit_status(self):
        text = "1. Chapter A: status=drafted\n2. Chapter B: status=pending\n"
        chapters = state.parse_chapters(text)
        self.assertEqual(
            chapters,
            [
                {"name": "Chapter A", "status": "drafted"},
                {"name": "Chapter B", "status": "pending"},
            ],
        )

    def test_missing_status_defaults_pending(self):
        text = "1. Introduccion\n"
        chapters = state.parse_chapters(text)
        self.assertEqual(chapters, [{"name": "Introduccion", "status": "pending"}])

    def test_numbered_style_with_inline_status(self):
        text = "3. Chapter A (status: revised)\n"
        chapters = state.parse_chapters(text)
        self.assertEqual(chapters, [{"name": "Chapter A", "status": "revised"}])

    def test_headers_and_bullets_are_never_chapters(self):
        # Regression for real dogfooding bug: an H1 title and an unrelated H2
        # note were previously misread as pending chapters because the old
        # matcher accepted any '#'/'-'/'*' line, not just numbered entries.
        text = (
            "# Indice de trabajo\n"
            "1. Introduccion: status=pending\n"
            "## Nota heredada\n"
            "- some prose bullet, not a chapter\n"
        )
        chapters = state.parse_chapters(text)
        self.assertEqual(chapters, [{"name": "Introduccion", "status": "pending"}])

    def test_empty_outline(self):
        self.assertEqual(state.parse_chapters(""), [])
        self.assertEqual(state.parse_chapters(None), [])


class FeedbackAndSnapshotHelpersTest(unittest.TestCase):
    def test_count_open_feedback_mixed_statuses(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "chapters"))
            write(
                os.path.join(d, "chapters", "chapter-a.feedback.md"),
                "## 2026-08-01 | Prof. X | v01 | open\n"
                "Scope: general\nComment: a\nResolution: \n\n"
                "## 2026-08-02 | Prof. X | v01 | addressed\n"
                "Scope: general\nComment: b\nResolution: fixed\n\n"
                "## 2026-08-03 | Prof. X | v02 | open\n"
                "Scope: general\nComment: c\nResolution: \n",
            )
            self.assertEqual(state.count_open_feedback(d, "chapter-a"), 2)

    def test_count_open_feedback_missing_file(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(state.count_open_feedback(d, "chapter-a"), 0)

    def test_count_snapshots(self):
        with tempfile.TemporaryDirectory() as d:
            history = os.path.join(d, "chapters", "history")
            os.makedirs(history)
            write(os.path.join(history, "chapter-a.v01.md"), "x\n")
            write(os.path.join(history, "chapter-a.v02.md"), "x\n")
            write(os.path.join(history, "chapter-b.v01.md"), "x\n")  # different chapter
            self.assertEqual(state.count_snapshots(d, "chapter-a"), 2)
            self.assertEqual(state.count_snapshots(d, "chapter-b"), 1)

    def test_count_snapshots_no_history_dir(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(state.count_snapshots(d, "chapter-a"), 0)


class PhaseDerivationTest(unittest.TestCase):
    def run_state(self, d):
        sys.argv = ["state.py", "--dir", d]
        import io
        import contextlib
        import json

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            state.main()
        return json.loads(buf.getvalue())

    def test_phase1_not_started(self):
        with tempfile.TemporaryDirectory() as d:
            result = self.run_state(d)
            self.assertEqual(result["phase"], 1)
            self.assertEqual(result["gate_status"], "not-started")

    def test_phase1_awaiting_gate(self):
        with tempfile.TemporaryDirectory() as d:
            write(os.path.join(d, "sources-initial.md"), "source 1\n")
            result = self.run_state(d)
            self.assertEqual(result["phase"], 1)
            self.assertEqual(result["gate_status"], "unanswered")

    def test_phase2_when_question_exists(self):
        with tempfile.TemporaryDirectory() as d:
            write(os.path.join(d, "research-question.md"), "Q\n")
            result = self.run_state(d)
            self.assertEqual(result["phase"], 2)

    def test_phase3_when_litmap_exists(self):
        with tempfile.TemporaryDirectory() as d:
            write(os.path.join(d, "research-question.md"), "Q\n")
            write(os.path.join(d, "literature-map.md"), "map\n")
            result = self.run_state(d)
            self.assertEqual(result["phase"], 3)

    def test_phase4_with_remaining_chapters(self):
        with tempfile.TemporaryDirectory() as d:
            write(os.path.join(d, "research-question.md"), "Q\n")
            write(os.path.join(d, "literature-map.md"), "map\n")
            write(
                os.path.join(d, "outline.md"),
                "1. Chapter A: status=drafted\n2. Chapter B: status=pending\n",
            )
            # Chapter A's file must actually exist for its "drafted" claim to
            # count — otherwise DR-4's check flags it inconsistent too.
            os.makedirs(os.path.join(d, "chapters"))
            write(os.path.join(d, "chapters", "chapter-a.md"), "draft\n")
            result = self.run_state(d)
            self.assertEqual(result["phase"], 4)
            self.assertEqual(
                [c["name"] for c in result["remaining_chapters"]], ["Chapter B"]
            )
            self.assertEqual(result["inconsistent_chapters"], [])

    def test_phase5_when_all_chapters_done_and_files_exist(self):
        # Chapter A is "drafted" (needs only the file). Chapter B is
        # "revised" (needs the file, a snapshot, and zero open feedback).
        with tempfile.TemporaryDirectory() as d:
            write(os.path.join(d, "research-question.md"), "Q\n")
            write(os.path.join(d, "literature-map.md"), "map\n")
            write(
                os.path.join(d, "outline.md"),
                "1. Chapter A: status=drafted\n2. Chapter B: status=revised\n",
            )
            os.makedirs(os.path.join(d, "chapters"))
            os.makedirs(os.path.join(d, "chapters", "history"))
            write(os.path.join(d, "chapters", "chapter-a.md"), "draft\n")
            write(os.path.join(d, "chapters", "chapter-b.md"), "draft\n")
            write(
                os.path.join(d, "chapters", "history", "chapter-b.v01.md"),
                "old draft\n",
            )
            write(
                os.path.join(d, "chapters", "chapter-b.feedback.md"),
                "## 2026-08-06 | Prof. X | v01 | addressed\n"
                "Scope: general\nComment: x\nResolution: fixed\n",
            )
            result = self.run_state(d)
            self.assertEqual(result["phase"], 5)
            self.assertEqual(result["gate_status"], "unanswered")
            self.assertEqual(result["remaining_chapters"], [])
            self.assertEqual(result["inconsistent_chapters"], [])

    def test_revised_without_snapshot_is_inconsistent(self):
        with tempfile.TemporaryDirectory() as d:
            write(os.path.join(d, "research-question.md"), "Q\n")
            write(os.path.join(d, "literature-map.md"), "map\n")
            write(os.path.join(d, "outline.md"), "1. Chapter A: status=revised\n")
            os.makedirs(os.path.join(d, "chapters"))
            write(os.path.join(d, "chapters", "chapter-a.md"), "draft\n")
            # No chapters/history/ snapshot at all.
            result = self.run_state(d)
            self.assertEqual(result["phase"], 4)
            self.assertIn("Chapter A", result["inconsistent_chapters"])

    def test_revised_with_open_feedback_is_inconsistent(self):
        with tempfile.TemporaryDirectory() as d:
            write(os.path.join(d, "research-question.md"), "Q\n")
            write(os.path.join(d, "literature-map.md"), "map\n")
            write(os.path.join(d, "outline.md"), "1. Chapter A: status=revised\n")
            os.makedirs(os.path.join(d, "chapters"))
            os.makedirs(os.path.join(d, "chapters", "history"))
            write(os.path.join(d, "chapters", "chapter-a.md"), "draft\n")
            write(
                os.path.join(d, "chapters", "history", "chapter-a.v01.md"), "old\n"
            )
            write(
                os.path.join(d, "chapters", "chapter-a.feedback.md"),
                "## 2026-08-06 | Prof. X | v01 | open\n"
                "Scope: general\nComment: still pending\nResolution: \n",
            )
            result = self.run_state(d)
            self.assertEqual(result["phase"], 4)
            self.assertIn("Chapter A", result["inconsistent_chapters"])

    def test_malformed_feedback_header_ignored_not_crash(self):
        with tempfile.TemporaryDirectory() as d:
            write(os.path.join(d, "research-question.md"), "Q\n")
            write(os.path.join(d, "literature-map.md"), "map\n")
            write(os.path.join(d, "outline.md"), "1. Chapter A: status=drafted\n")
            os.makedirs(os.path.join(d, "chapters"))
            write(os.path.join(d, "chapters", "chapter-a.md"), "draft\n")
            write(
                os.path.join(d, "chapters", "chapter-a.feedback.md"),
                "## not a valid header at all\nsome prose\n",
            )
            result = self.run_state(d)  # must not raise
            self.assertEqual(result["phase"], 5)

    def test_drafted_status_without_file_is_inconsistent_not_done(self):
        # Regression for DR-4 (dogfooding retrospective): outline.md claiming
        # status=drafted must not be trusted if chapters/ has no matching
        # file — grade the environment, not the claim.
        with tempfile.TemporaryDirectory() as d:
            write(os.path.join(d, "research-question.md"), "Q\n")
            write(os.path.join(d, "literature-map.md"), "map\n")
            write(
                os.path.join(d, "outline.md"),
                "1. Chapter A: status=drafted\n",
            )
            # No chapters/ directory at all, and no file for Chapter A.
            result = self.run_state(d)
            self.assertEqual(result["phase"], 4)
            self.assertIn("Chapter A", result["inconsistent_chapters"])
            self.assertEqual(
                [c["name"] for c in result["remaining_chapters"]], ["Chapter A"]
            )
            self.assertIn("WARNING", result["next_action"])


if __name__ == "__main__":
    unittest.main()
