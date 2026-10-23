"""Unit tests for scripts/store.py: pure-function seams, literal expected values, no mocks.

Run: cd pablo-code-review && python3 -m unittest discover -s evals -p 'test_*.py' -v
"""

import contextlib
import copy
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import store  # noqa: E402

FIXTURES = HERE / "fixtures"
SLUGS = store.taxonomy()


def load(name):
    return store.split_report((FIXTURES / name).read_text(encoding="utf-8"))


def errors_for(name):
    fm, body = load(name)
    return store.validate_report(fm, body, SLUGS)


class ReviewId(unittest.TestCase):
    def test_pr_literal(self):
        # printf 'github.example.com/acme/widget#42#1' | shasum | cut -c1-8
        self.assertEqual(store.review_id("github.example.com", "acme", "widget", 42, 1), "b076db44")

    def test_branch_literal(self):
        # printf 'github.example.com/acme/widget#branch:feature/x#2' | shasum | cut -c1-8
        self.assertEqual(
            store.review_id("github.example.com", "acme", "widget", "branch:feature/x", 2), "68523e74"
        )

    def test_pr_ref(self):
        self.assertEqual(store.pr_ref(7, "b"), 7)
        self.assertEqual(store.pr_ref(None, "feature/x"), "branch:feature/x")


class Taxonomy(unittest.TestCase):
    def test_fifteen_slugs_in_order(self):
        self.assertEqual(
            SLUGS,
            [
                "correctness-scenario", "contract-compat", "concurrency", "error-handling",
                "ops-runtime", "build-metadata", "domain-assumption", "test-oracle",
                "coverage-gap", "duplication-reuse", "type-modelling", "encapsulation",
                "abstraction-structure", "complexity-size", "naming-docs-style",
            ],
        )


class Rounds(unittest.TestCase):
    def test_first_round(self):
        self.assertEqual(store.next_round([], "pr42"), 1)

    def test_max_plus_one_ignores_other_prs(self):
        names = ["pr42-r1-2026-01-15.md", "pr42-r3-2026-01-20.md", "pr420-r9-2026-01-21.md", "pr7-r5-2026-01-01.md"]
        self.assertEqual(store.next_round(names, "pr42"), 4)

    def test_branch_slug(self):
        self.assertEqual(store.branch_slug("Feature/Retry_Budget!"), "feature-retry-budget")
        self.assertEqual(store.file_prefix(None, "feature/x"), "feature-x")
        self.assertEqual(store.file_prefix(42, "feature/x"), "pr42")


class Verdict(unittest.TestCase):
    def test_rule(self):
        self.assertEqual(store.expected_verdict({"B": 1, "M": 5, "Q": 0, "I": 0, "G": 0}), "BLOCK")
        self.assertEqual(store.expected_verdict({"B": 0, "M": 1, "Q": 9, "I": 0, "G": 0}), "NEEDS WORK")
        self.assertEqual(store.expected_verdict({"B": 0, "M": 0, "Q": 2, "I": 3, "G": 1}), "PASS")


class Validate(unittest.TestCase):
    def test_valid_fixture(self):
        self.assertEqual(errors_for("report_valid.md"), [])

    def test_missing_key(self):
        self.assertEqual(errors_for("report_invalid_missing_key.md"), ["skill_sha: missing key"])

    def test_bad_tier(self):
        self.assertEqual(errors_for("report_invalid_bad_tier.md"), ["findings[4].tier: 'X' not in B|M|Q|I|G|T|O|F"])

    def test_unknown_category(self):
        self.assertEqual(
            errors_for("report_invalid_unknown_category.md"),
            ["findings[2].category: 'spaghetti' is not in the taxonomy"],
        )

    def test_tally_mismatch(self):
        self.assertEqual(
            errors_for("report_invalid_tally_mismatch.md"),
            ["tally: {'B': 0, 'M': 2, 'Q': 1, 'I': 1, 'G': 1} does not match findings "
             "{'B': 0, 'M': 1, 'Q': 1, 'I': 1, 'G': 1}"],
        )

    def test_block_without_blocker(self):
        self.assertEqual(
            errors_for("report_invalid_block_without_blocker.md"),
            ["verdict: BLOCK but tally {'B': 0, 'M': 1, 'Q': 1, 'I': 1, 'G': 1} gives NEEDS WORK"],
        )

    def test_id_missing_from_body(self):
        self.assertEqual(
            errors_for("report_invalid_id_not_in_body.md"),
            ["findings[1].id: 'Q1' does not appear in the report body"],
        )

    def test_backfill_skips_verdict_consistency_and_allows_null_shas(self):
        fm, body = load("report_valid.md")
        fm["backfill"] = True
        fm["verdict"] = "BLOCK"
        fm["skill_sha"] = "backfill"
        fm["lens_versions"] = {k: None for k in store.LENSES}
        fm["head_sha"] = None
        self.assertEqual(store.validate_report(fm, body, SLUGS), [])

    def test_without_backfill_null_sha_is_rejected(self):
        fm, body = load("report_valid.md")
        fm["head_sha"] = None
        self.assertEqual(store.validate_report(fm, body, SLUGS), ["head_sha: must be a 7-40 char hex sha"])


class FourLenses(unittest.TestCase):
    def test_lens_list(self):
        self.assertEqual(
            store.LENSES,
            ("qa-adversary", "code-review-checklist", "refactor-identification", "pablo-test-review"),
        )

    def test_finding_accepts_test_lens(self):
        fm, body = load("report_valid.md")
        self.assertIn("pablo-test-review", [l for f in fm["findings"] for l in f["lens"]])
        self.assertEqual(store.validate_report(fm, body, SLUGS), [])

    def test_unknown_lens_rejected(self):
        fm, body = load("report_valid.md")
        fm["findings"][0]["lens"] = ["qa-adversary", "pablo-vibes"]
        errs = store.validate_report(fm, body, SLUGS)
        self.assertEqual(len(errs), 1)
        self.assertTrue(errs[0].startswith("findings[0].lens: must be a non-empty list of"))

    def test_legacy_three_lens_versions_still_valid(self):
        fm, body = load("report_valid.md")
        del fm["lens_versions"]["pablo-test-review"]
        self.assertEqual(store.validate_report(fm, body, SLUGS), [])

    def test_two_lens_versions_rejected(self):
        fm, body = load("report_valid.md")
        del fm["lens_versions"]["pablo-test-review"]
        del fm["lens_versions"]["refactor-identification"]
        self.assertEqual(len(store.validate_report(fm, body, SLUGS)), 1)

    def test_null_version_needs_a_reason(self):
        fm, body = load("report_valid.md")
        fm["lens_versions"]["pablo-test-review"] = None
        self.assertEqual(
            store.validate_report(fm, body, SLUGS),
            ["lens_versions.pablo-test-review: must be 8 hex chars (null only with a lens_versions_missing reason)"],
        )
        fm["lens_versions_missing"] = {"pablo-test-review": "lens directory not found: /x"}
        self.assertEqual(store.validate_report(fm, body, SLUGS), [])

    def test_lens_versions_for_records_four_and_flags_missing_dir(self):
        with tempfile.TemporaryDirectory() as d:
            for name in store.LENSES[:3]:
                (Path(d) / name).mkdir()
                (Path(d) / name / "SKILL.md").write_bytes(b"abc")
            versions, missing = store.lens_versions_for(d)
            self.assertEqual(list(versions), list(store.LENSES))
            self.assertEqual(versions["qa-adversary"], "ba7816bf")
            self.assertIsNone(versions["pablo-test-review"])
            self.assertEqual(list(missing), ["pablo-test-review"])
            self.assertIn("lens directory not found", missing["pablo-test-review"])

    def test_write_report_records_all_four_lenses(self):
        with tempfile.TemporaryDirectory() as d:
            p = store.write_report(META, "M1\n", root=d)
            fm, _ = store.split_report(p.read_text(encoding="utf-8"))
            self.assertEqual(list(fm["lens_versions"]), list(store.LENSES))


class RoundTrip(unittest.TestCase):
    def test_render_then_split_keeps_frontmatter_and_body(self):
        fm, body = load("report_valid.md")
        fm2, body2 = store.split_report(store.render_report(fm, body))
        self.assertEqual(fm2, fm)
        self.assertEqual(body2, body)


class Sha(unittest.TestCase):
    def test_lens_sha_literal(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "references" / "sub").mkdir(parents=True)
            (root / "SKILL.md").write_text("a", encoding="utf-8")
            (root / "references" / "b.md").write_text("b", encoding="utf-8")
            (root / "references" / "sub" / "c.md").write_text("c", encoding="utf-8")
            (root / "references" / "ignored.txt").write_text("zzz", encoding="utf-8")
            # printf abc | shasum -a 256 | cut -c1-8
            self.assertEqual(store.lens_sha(root), "ba7816bf")


META = {
    "host": "github.example.com", "org": "acme", "repo": "widget", "pr": 42,
    "branch": "feature/retry-budget", "base_sha": "1a2b3c4", "head_sha": "9f8e7d6",
    "date": "2026-02-01T08:00:00Z", "context_prs": [],
    "diff_stats": {"files": 1, "additions": 5, "deletions": 1}, "verdict": "NEEDS WORK",
    "findings": [{
        "id": "M1", "lens": ["qa-adversary"], "lens_sev": ["HIGH"], "tier": "M",
        "category": "correctness-scenario", "code_kind": "prod", "premise": "in-diff",
        "kind": "finding", "location": {"path": "src/A.java", "lines": "10-12"},
        "title": "Budget not decremented on first failure", "rank": 1,
    }],
}


class WriteReport(unittest.TestCase):
    def test_end_to_end_into_temp_root(self):
        with tempfile.TemporaryDirectory() as d:
            p1 = store.write_report(META, "## Review\nM1 is wrong\n", root=d)
            self.assertEqual(p1.relative_to(d).as_posix(), "reviews/widget/pr42-r1-2026-02-01.md")
            p2 = store.write_report(META, "## Review\nM1 is wrong\n", root=d)
            self.assertEqual(p2.name, "pr42-r2-2026-02-01.md")
            fm, body = store.split_report(p2.read_text(encoding="utf-8"))
            self.assertEqual(store.validate_report(fm, body, SLUGS), [])
            self.assertEqual(fm["round"], 2)
            self.assertEqual(fm["review_id"], store.review_id("github.example.com", "acme", "widget", 42, 2))
            self.assertEqual(fm["tally"], {"B": 0, "M": 1, "Q": 0, "I": 0, "G": 0})
            self.assertEqual((fm["items_shown_full"], fm["items_shown_total"]), (1, 1))
            self.assertEqual(fm["findings"][0]["shown_as"], "normal")

    def test_branch_review_without_pr(self):
        meta = dict(META, pr=None)
        with tempfile.TemporaryDirectory() as d:
            p = store.write_report(meta, "M1\n", root=d)
            self.assertEqual(p.name, "feature-retry-budget-r1-2026-02-01.md")

    def test_invalid_meta_writes_nothing(self):
        bad = copy.deepcopy(META)
        bad["verdict"] = "PASS"
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError) as cm:
                store.write_report(bad, "M1\n", root=d)
            self.assertIn("verdict: PASS but tally", str(cm.exception))
            self.assertFalse((Path(d) / "reviews").exists())

    def test_missing_host_is_reported_not_defaulted(self):
        bad = {k: v for k, v in META.items() if k != "host"}
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError) as cm:
                store.write_report(bad, "M1\n", root=d)
            self.assertEqual(str(cm.exception), "host: missing key in meta")

    def test_backfill_marks_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = store.write_report(META, "M1\n", root=d, backfill=True)
            fm, _ = store.split_report(p.read_text(encoding="utf-8"))
            self.assertEqual((fm["skill_sha"], fm["backfill"]), ("backfill", True))
            self.assertEqual(fm["lens_versions"]["qa-adversary"], None)


def fb(**over):
    base = {
        "harvested_at": "2026-02-03T10:00:00Z",
        "outcomes": [{"id": "M1", "outcome": "posted", "form": "question", "comment_ids": [101],
                      "match": "auto", "reason": None}],
        "recall_misses": [], "this_pr_only": [], "wiki_proposals": [],
    }
    return dict(base, **over)


class SetFeedback(unittest.TestCase):
    def report(self, d):
        p = Path(d) / "r.md"
        p.write_text((FIXTURES / "report_valid.md").read_text(encoding="utf-8"), encoding="utf-8")
        return p

    def test_writes_block_and_report_stays_valid(self):
        with tempfile.TemporaryDirectory() as d:
            p = store.set_feedback(self.report(d), fb())
            fm, body = store.split_report(p.read_text(encoding="utf-8"))
            self.assertEqual(store.validate_report(fm, body, SLUGS), [])
            self.assertEqual(fm["feedback"]["outcomes"][0]["outcome"], "posted")
            self.assertEqual(fm["tally"], {"B": 0, "M": 1, "Q": 1, "I": 1, "G": 1})

    def test_second_harvest_merges_outcomes_by_id(self):
        with tempfile.TemporaryDirectory() as d:
            p = self.report(d)
            store.set_feedback(p, fb(recall_misses=[{"comment_id": 7}]))
            second = fb(outcomes=[
                {"id": "M1", "outcome": "partial", "form": "assertion", "comment_ids": [101], "match": "asked", "reason": None},
                {"id": "I1", "outcome": "not-posted", "form": None, "comment_ids": [], "match": "asked", "reason": "not-worth"},
            ], recall_misses=[{"comment_id": 7}, {"comment_id": 8}])
            store.set_feedback(p, second)
            fm, _ = store.split_report(p.read_text(encoding="utf-8"))
            got = {o["id"]: o["outcome"] for o in fm["feedback"]["outcomes"]}
            self.assertEqual(got, {"M1": "partial", "I1": "not-posted"})
            self.assertEqual(fm["feedback"]["recall_misses"], [{"comment_id": 7}, {"comment_id": 8}])

    def test_rejects_each_bad_enum_and_writes_nothing(self):
        good = fb()["outcomes"][0]
        cases = [
            ("outcome", "ignored"), ("form", "praise"), ("match", "guess"), ("reason", "lazy"),
        ]
        for key, bad in cases:
            with tempfile.TemporaryDirectory() as d:
                p = self.report(d)
                before = p.read_text(encoding="utf-8")
                with self.assertRaises(ValueError) as cm:
                    store.set_feedback(p, fb(outcomes=[dict(good, **{key: bad})]))
                self.assertIn(f"feedback.outcomes[0].{key}: {bad!r} not in", str(cm.exception))
                self.assertEqual(p.read_text(encoding="utf-8"), before)

    def test_rejects_unknown_finding_id_and_posted_without_comment(self):
        good = fb()["outcomes"][0]
        with tempfile.TemporaryDirectory() as d:
            p = self.report(d)
            with self.assertRaises(ValueError) as cm:
                store.set_feedback(p, fb(outcomes=[dict(good, id="M9")]))
            self.assertIn("'M9' is not a finding of this report", str(cm.exception))
            with self.assertRaises(ValueError) as cm:
                store.set_feedback(p, fb(outcomes=[dict(good, comment_ids=[])]))
            self.assertIn("comment_ids: required when outcome is posted or partial", str(cm.exception))

    def test_not_posted_needs_no_form(self):
        o = {"id": "I1", "outcome": "unseen", "form": None, "comment_ids": [], "match": "asked", "reason": "didnt-read"}
        with tempfile.TemporaryDirectory() as d:
            store.set_feedback(self.report(d), fb(outcomes=[o]))

    def test_this_pr_only_must_name_findings(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError) as cm:
                store.set_feedback(self.report(d), fb(this_pr_only=["T9"]))
            self.assertIn("this_pr_only: 'T9'", str(cm.exception))

    def test_cli_exit_codes(self):
        with tempfile.TemporaryDirectory() as d:
            p = self.report(d)
            f = Path(d) / "fb.json"
            f.write_text(json.dumps(fb()), encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(store.main(["set-feedback", str(p), str(f)]), 0)
                f.write_text(json.dumps(fb(harvested_at="yesterday")), encoding="utf-8")
                self.assertEqual(store.main(["set-feedback", str(p), str(f)]), 1)


if __name__ == "__main__":
    unittest.main()
