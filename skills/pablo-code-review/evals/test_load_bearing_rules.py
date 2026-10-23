"""Self-test: merge-rules checks tolerate re-wrapping but still catch changed values."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_load_bearing_rules as c  # noqa: E402

BASE = "- Coverage gaps: pablo-test-review and qa-adversary gaps form one list, at most 3.\n"


class GapCapRule(unittest.TestCase):
    def test_original_passes(self):
        self.assertTrue(c._gap_cap_ok(BASE))

    def test_rewrapped_passes(self):
        wrapped = "- Coverage gaps: pablo-test-review and qa-adversary gaps form one\n  list,   at most 3.\n"
        self.assertTrue(c._gap_cap_ok(wrapped))

    def test_changed_number_fails(self):
        self.assertFalse(c._gap_cap_ok(BASE.replace("at most 3", "at most 5")))

    def test_norm_collapses_whitespace(self):
        self.assertEqual(c._norm("a\n  b \t c"), "a b c")


class ItemIdShape(unittest.TestCase):
    def test_current_skill_passes(self):
        self.assertTrue(c.check_item_id_shape(c.SKILL_MD.read_text(encoding="utf-8")))

    def test_old_head_shape_fails(self):
        text = c.SKILL_MD.read_text(encoding="utf-8")
        self.assertFalse(c.check_item_id_shape(text + "\n**[Question - qa-adversary] a.py:1: why?**\n"))

    def test_missing_id_in_head_fails(self):
        text = c.SKILL_MD.read_text(encoding="utf-8").replace("**I1 [Minor - ", "**[Minor - ")
        self.assertFalse(c.check_item_id_shape(text))


class FinalMessage(unittest.TestCase):
    def test_dropping_the_rule_fails(self):
        text = c.SKILL_MD.read_text(encoding="utf-8").replace("COMPLETE report", "report")
        self.assertFalse(c.check_full_report_final_message(text))


class NoChangeRule(unittest.TestCase):
    def test_current_skill_passes(self):
        self.assertTrue(c.check_no_change_rule(c.SKILL_MD.read_text(encoding="utf-8")))

    def test_missing_skill_pointer_fails(self):
        text = c.SKILL_MD.read_text(encoding="utf-8").replace("No changes since round", "Nothing new")
        self.assertFalse(c.check_no_change_rule(text))

    def test_dropping_full_rerun_clause_fails(self):
        orig = c._read
        c._read = lambda p: orig(p).replace("even when the head is unchanged", "")
        try:
            self.assertFalse(c.check_no_change_rule(c.SKILL_MD.read_text(encoding="utf-8")))
        finally:
            c._read = orig


def _with_read(fn_name, old, new, test):
    orig = c._read
    c._read = lambda p: orig(p).replace(old, new)
    try:
        return test(getattr(c, fn_name)(c.SKILL_MD.read_text(encoding="utf-8")))
    finally:
        c._read = orig


class StatusTableColumns(unittest.TestCase):
    def test_current_passes(self):
        self.assertTrue(c.check_status_table_columns(c.SKILL_MD.read_text(encoding="utf-8")))

    def test_extra_column_wording_fails(self):
        self.assertFalse(_with_read("check_status_table_columns", "EXACTLY three columns", "several columns", lambda r: r))

    def test_skill_template_without_columns_fails(self):
        text = c.SKILL_MD.read_text(encoding="utf-8").replace("exactly 3 columns", "a table")
        self.assertFalse(c.check_status_table_columns(text))


class NoTrailingAfterTable(unittest.TestCase):
    def test_current_passes(self):
        self.assertTrue(c.check_no_trailing_after_table(""))

    def test_clause_removed_fails(self):
        self.assertFalse(_with_read("check_no_trailing_after_table", "Print nothing after the status table", "Notes may follow", lambda r: r))


class MktempRule(unittest.TestCase):
    def test_current_passes(self):
        self.assertTrue(c.check_mktemp_rule(c.SKILL_MD.read_text(encoding="utf-8")))

    def test_fixed_path_allowance_fails(self):
        text = c.SKILL_MD.read_text(encoding="utf-8").replace("MUST be\n   created with `mktemp`", "may be\n   created in /tmp")
        self.assertFalse(c.check_mktemp_rule(text))

    def test_cleanup_dropped_fails(self):
        text = c.SKILL_MD.read_text(encoding="utf-8").replace("deleted at the end", "kept")
        self.assertFalse(c.check_mktemp_rule(text))


if __name__ == "__main__":
    unittest.main()
