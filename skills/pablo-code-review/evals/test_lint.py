"""Unit tests for scripts/lint_ml_lessons.py (planted leaks use FAKE names only).

Run: cd pablo-code-review && python3 -m unittest discover -s evals -p 'test_*.py' -v
"""

import contextlib
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import lint_ml_lessons as lint  # noqa: E402
import store  # noqa: E402

LEAKY = HERE / "fixtures" / "ml_lesson_leaky.md"
REF = "rv-0123abcd#M1"


def lesson_text(body="one line\n", status="candidate", refs=(REF,), extra=""):
    fm = ["id: x", "kind: precision", "trigger:", "  category: correctness-scenario", f"status: {status}"]
    if refs:
        fm += ["evidence:", "  refs:"] + [f"  - {r}" for r in refs]
    return "---\n" + "\n".join(fm) + "\n" + extra + "---\n" + body


def write(root, name, text):
    p = Path(root) / "ml-lessons" / f"{name}.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


def add_report(root, repo="acme-widget-svc", org="acme-corp", host="h.example", dirname=None):
    fm = {"review_id": "0123abcd", "host": host, "org": org, "repo": repo, "pr": 1, "round": 1, "findings": []}
    p = Path(root) / "reviews" / (dirname or repo) / "pr1-r1-2026-01-01.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(store.render_report(fm, "body\n"), encoding="utf-8")


def body_line(text, n=1):
    """1-based line number of the n-th line after the closing frontmatter delimiter."""
    lines = text.splitlines()
    return lines.index("---", 1) + 1 + n


def run(root):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = lint.main(["--root", str(root)])
    return rc, out.getvalue().splitlines(), err.getvalue()


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def reasons(self, text, ledger=True):
        if ledger:
            add_report(self.root)
        write(self.root, "x", text)
        rc, lines, _ = run(self.root)
        return rc, lines


class TestClean(Base):
    def test_clean_lesson_exits_0_with_no_output(self):
        add_report(self.root)
        write(self.root, "x", lesson_text())
        self.assertEqual(run(self.root), (0, [], ""))

    def test_allowlisted_public_names_pass(self):
        rc, lines = self.reasons(lesson_text(body="JavaScript, TypeScript and GitHub are fine\n"))
        self.assertEqual((rc, lines), (0, []))

    def test_missing_ml_lessons_dir_is_exit_2(self):
        rc, lines, err = run(self.root)
        self.assertEqual(rc, 2)
        self.assertIn("no ml-lessons/", err)

    def test_no_ledger_is_not_an_error(self):
        write(self.root, "x", lesson_text())
        self.assertEqual(run(self.root)[0], 0)


class TestLeaks(Base):
    def test_output_format_is_file_line_reason(self):
        text = lesson_text(body="see ACME-123\n")
        rc, lines = self.reasons(text)
        self.assertEqual(rc, 1)
        self.assertEqual(lines, [f"ml-lessons/x.md:{body_line(text)}: ticket key 'ACME-123'"])

    def test_repo_name_from_reviews_dir_case_insensitive(self):
        text = lesson_text(body="in acme-Widget-Svc only\n")
        rc, lines = self.reasons(text)
        self.assertEqual(rc, 1)
        self.assertEqual(lines, [f"ml-lessons/x.md:{body_line(text)}: internal name 'acme-Widget-Svc' (repo, org or host)"])

    def test_repo_name_with_suffix_is_flagged_but_embedded_in_word_is_not(self):
        rc, lines = self.reasons(lesson_text(body="acme-widget-svc-v2\n"))
        self.assertEqual(rc, 1)
        self.assertEqual(self.reasons(lesson_text(body="xacme-widget-svcx\n"), ledger=False)[0], 0)

    def test_org_and_host_from_report_frontmatter(self):
        text = lesson_text(body="owned by acme-corp\nreachable at h.example\n")
        rc, lines = self.reasons(text)
        self.assertEqual(rc, 1)
        self.assertEqual(lines, [f"ml-lessons/x.md:{body_line(text, 1)}: internal name 'acme-corp' (repo, org or host)",
                                 f"ml-lessons/x.md:{body_line(text, 2)}: internal name 'h.example' (repo, org or host)"])

    def test_repo_value_in_frontmatter_when_dir_name_differs(self):
        add_report(self.root, repo="beta-gadget-api", dirname="other-dir")
        write(self.root, "x", lesson_text(body="beta-gadget-api\n"))
        self.assertEqual(run(self.root)[0], 1)

    def test_repo_lessons_dir_names_are_denied_too(self):
        (self.root / "repo-lessons" / "gamma-thing-svc").mkdir(parents=True)
        write(self.root, "x", lesson_text(body="gamma-thing-svc\n"))
        self.assertEqual(run(self.root)[0], 1)

    def test_repo_lessons_themselves_are_not_linted(self):
        d = self.root / "repo-lessons" / "gamma-thing-svc"
        d.mkdir(parents=True)
        (d / "a.md").write_text("---\nid: a\n---\nACME-123 in FooBarService.java\n", encoding="utf-8")
        write(self.root, "x", lesson_text())
        self.assertEqual(run(self.root)[0], 0)

    def test_denylist_is_empty_without_ledger_and_ignores_short_values(self):
        add_report(self.root, repo="ab", org="x", host="y")
        self.assertEqual(lint.runtime_names(self.root), [])

    def test_slash_in_path_like_token(self):
        for text in ("src/main/Thing\n", "(see docs/readme)\n", "https://example.com\n"):
            with self.subTest(text=text):
                self.assertEqual(self.reasons(lesson_text(body=text), ledger=False)[0], 1)

    def test_ticket_keys(self):
        for key in ("ACME-123", "AB-1", "WIDGET-2992"):
            with self.subTest(key=key):
                self.assertEqual(self.reasons(lesson_text(body=f"{key}\n"), ledger=False)[0], 1)
        self.assertEqual(self.reasons(lesson_text(body="utf-8 and A-1\n"), ledger=False)[0], 0)

    def test_java_and_scala_file_names(self):
        for name in ("thing.java", "thing.scala,", "x.java."):
            with self.subTest(name=name):
                self.assertEqual(self.reasons(lesson_text(body=f"{name}\n"), ledger=False)[0], 1)
        self.assertEqual(self.reasons(lesson_text(body="javascript.json javanese\n"), ledger=False)[0], 0)

    def test_class_like_identifiers(self):
        for ident in ("FooBarService", "MediaItem", "HttpClient"):
            with self.subTest(ident=ident):
                self.assertEqual(self.reasons(lesson_text(body=f"{ident}\n"), ledger=False)[0], 1)
        self.assertEqual(self.reasons(lesson_text(body="hashCode URL JSON Foo plain\n"), ledger=False)[0], 0)

    def test_postgresql_style_product_names_are_flagged_not_allowlisted(self):
        self.assertEqual(self.reasons(lesson_text(body="PostgreSQL\n"), ledger=False)[0], 1)

    def test_refs_must_be_opaque_ids(self):
        good = ("rv-0123abcd", "rv-0123abcd#M1", "rv-ffffffff#T12")
        for ref in good:
            with self.subTest(ref=ref):
                self.assertEqual(self.reasons(lesson_text(refs=(ref,)), ledger=False)[0], 0)
        bad = ("rv-0123abc", "rv-0123abcde", "rv-0123ABCD", "rv-0123abcd#m1", "rv-0123abcd#M", "0123abcd",
               "rv-0123abcd#M1x")
        for ref in bad:
            with self.subTest(ref=ref):
                rc, lines = self.reasons(lesson_text(refs=(ref,)), ledger=False)
                self.assertEqual(rc, 1)
                self.assertIn("is not rv-<8 hex>", lines[0])

    def test_body_limit_counts_non_blank_lines(self):
        six = "".join(f"l{i}\n" for i in range(6))
        self.assertEqual(self.reasons(lesson_text(body=six), ledger=False)[0], 0)
        self.assertEqual(self.reasons(lesson_text(body=six + "\n\n"), ledger=False)[0], 0)
        text = lesson_text(body=six + "l6\n")
        rc, lines = self.reasons(text, ledger=False)
        self.assertEqual(rc, 1)
        self.assertEqual(lines, [f"ml-lessons/x.md:{body_line(text, 7)}: body has 7 non-blank lines (max 6)"])

    def test_frontmatter_missing_or_invalid(self):
        for text in ("no frontmatter\n", "---\nid: [unclosed\n---\nbody\n", "---\nid: x\n"):
            with self.subTest(text=text):
                rc, lines = self.reasons(text, ledger=False)
                self.assertEqual((rc, lines), (1, ["ml-lessons/x.md:1: missing or invalid YAML frontmatter"]))

    def test_approved_cap(self):
        for i in range(25):
            write(self.root, f"a{i:02d}", lesson_text(status="approved"))
        for i in range(5):
            write(self.root, f"c{i}", lesson_text(status="candidate"))
        write(self.root, "k", lesson_text(status="codified"))
        self.assertEqual(run(self.root)[0], 0)
        write(self.root, "a25", lesson_text(status="approved"))
        rc, lines, _ = run(self.root)
        self.assertEqual((rc, lines), (1, ["ml-lessons:1: 26 approved lessons (max 25)"]))


class TestPlantedLeakFixture(Base):
    def test_fixture_trips_every_check_with_fake_names(self):
        add_report(self.root)
        write(self.root, "leaky", LEAKY.read_text(encoding="utf-8"))
        rc, lines, _ = run(self.root)
        self.assertEqual(rc, 1)
        text = "\n".join(lines)
        for needle in ("internal name 'acme-widget-svc'", "internal name 'acme-corp'", "internal name 'h.example'",
                       "'/' inside token", "ticket key 'ACME-123'", "source file name '.java'",
                       "class-like identifier 'FooBarService'", "'not-an-opaque-ref' is not rv-",
                       "body has 7 non-blank lines"):
            self.assertIn(needle, text)

    def test_fixture_is_clean_without_a_ledger_except_structural_checks(self):
        write(self.root, "leaky", LEAKY.read_text(encoding="utf-8"))
        text = "\n".join(run(self.root)[1])
        self.assertNotIn("internal name", text)
        self.assertIn("ticket key", text)


class TestRealStore(unittest.TestCase):
    def test_real_ml_lessons_pass(self):
        rc, lines, _ = run(store.SKILL_DIR)
        self.assertEqual((rc, lines), (0, []))

    def test_cli_exit_code_through_subprocess(self):
        with tempfile.TemporaryDirectory() as tmp:
            write(tmp, "x", lesson_text(body="ACME-123\n"))
            r = subprocess.run([sys.executable, str(HERE.parent / "scripts" / "lint_ml_lessons.py"), "--root", tmp],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 1)
            self.assertIn("ml-lessons/x.md:", r.stdout)


if __name__ == "__main__":
    unittest.main()
