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


class CrossRepoLookup(unittest.TestCase):
    def test_current_passes(self):
        self.assertTrue(c.check_cross_repo_lookup(c.SKILL_MD.read_text(encoding="utf-8")))

    def test_coordinator_phrase_dropped_fails(self):
        text = c.SKILL_MD.read_text(encoding="utf-8").replace("another repo's code on the diff's call path", "x")
        self.assertFalse(c.check_cross_repo_lookup(text))

    def test_qa_phrase_dropped_fails(self):
        qa = c.LENS_SKILLS[0]
        orig = qa.read_text(encoding="utf-8")
        self.assertIn("on the changed call path and readable", orig)
        self.assertFalse(c.check_cross_repo_lookup(c.SKILL_MD.read_text(encoding="utf-8"), qa_text=orig.replace("on the changed call path and readable", "x")))


SKILL_PHRASES = ("Apply lessons", "scripts/select_lessons.py", "--shadow", "Demoted by lessons:",
                 "[NEVER] drop an item", "[NEVER] let a lesson delete an item", "more than one tier", "never-suppress")
LOOP_TERMS = ("duplication-reuse", "type-modelling", "assertion_loosened", "security", "data-loss", "credentials",
              "asked", "static", "qa-adversary", "protect")


def skill():
    return c.SKILL_MD.read_text(encoding="utf-8")


class patched:
    """Temporarily replace a module attribute."""
    def __init__(self, obj, name, value):
        self.obj, self.name, self.value = obj, name, value

    def __enter__(self):
        self.old = getattr(self.obj, self.name)
        setattr(self.obj, self.name, self.value)

    def __exit__(self, *exc):
        setattr(self.obj, self.name, self.old)


def _import_select():
    sys.path.insert(0, str(c.SKILL_MD.parent / "scripts"))
    import select_lessons
    return select_lessons


class LessonsNeverDelete(unittest.TestCase):
    def test_current_passes(self):
        self.assertTrue(c.check_lessons_never_delete(skill()))

    def test_removing_each_skill_phrase_fails(self):
        for phrase in SKILL_PHRASES:
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, c._norm(skill()))
                self.assertFalse(c.check_lessons_never_delete(c._norm(skill()).replace(phrase, "xx")))

    def test_missing_learning_loop_section_fails(self):
        self.assertFalse(_with_read("check_lessons_never_delete", "## Merge-time application", "## Other", lambda r: r))

    def test_wrong_collapsed_prefix_fails(self):
        with patched(_import_select(), "COLLAPSED_PREFIX", "Demoted: "):
            self.assertFalse(c.check_lessons_never_delete(skill()))

    def test_wrong_step_down_fails(self):
        with patched(_import_select(), "STEP_DOWN", {"B": "I", "M": "I"}):
            self.assertFalse(c.check_lessons_never_delete(skill()))

    def test_spanish_collapsed_label_anywhere_fails(self):
        self.assertFalse(c.check_lessons_never_delete(skill() + "\nBajado por lecciones: I1\n"))


class NeverSuppressList(unittest.TestCase):
    def test_current_passes(self):
        self.assertTrue(c.check_never_suppress_list(skill()))

    def test_dropping_each_term_from_the_section_fails(self):
        section = c._read(c.LEARNING_LOOP).split("## Merge-time application", 1)[1]
        for term in LOOP_TERMS:
            with self.subTest(term=term):
                self.assertIn(term, section)
                self.assertFalse(_with_read("check_never_suppress_list", term, "xx", lambda r: r))

    def test_missing_section_fails(self):
        self.assertFalse(_with_read("check_never_suppress_list", "## Merge-time application", "## Other", lambda r: r))

    def test_never_suppress_returning_none_fails(self):
        with patched(_import_select(), "never_suppress", lambda *a, **k: None):
            self.assertFalse(c.check_never_suppress_list(skill()))

    def test_over_eager_never_suppress_fails(self):
        with patched(_import_select(), "never_suppress", lambda *a, **k: "always"):
            self.assertFalse(c.check_never_suppress_list(skill()))


class CheckCount(unittest.TestCase):
    def test_thirty_four_checks(self):
        self.assertEqual(len(c.CHECKS), 34)


if __name__ == "__main__":
    unittest.main()
