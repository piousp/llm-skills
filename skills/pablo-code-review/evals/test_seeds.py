"""Tests for the seed lessons in ml-lessons/ (and, when present, the git-ignored repo-lessons/).

They check the schema and the trigger/action contract select_lessons.py relies on, never the ledger
counts (those move with every harvest). Run: cd pablo-code-review && python3 -m unittest discover -s evals -p 'test_*.py'
"""

import json
import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import store  # noqa: E402
import tally  # noqa: E402

ROOT = store.SKILL_DIR
SEEDS = {  # plan section 4.1 (+ postable-suggestion, decision 32)
    "premise-external": "codified", "test-oracle-abstract": "codified", "test-assert-concrete": "candidate",
    "gap-volume": "codified", "oq-standalone": "codified", "scenario-boost": "approved",
    "question-form": "codified", "volume": "retired", "dup-reuse": "codified", "refactor-only": "codified",
    "race-spec": "candidate", "scope-question": "candidate", "type-model": "candidate", "nit-exact": "retired",
    "postable-suggestion": "candidate",
}
TIERS = {"B", "M", "Q", "I", "G", "T", "O", "F"}
CODE_KINDS = {"prod", "test", "build", "script", "dev-tool"}
PREMISES = {"in-diff", "1-hop", "external-unverified"}
KINDS = {"precision", "recall", "presentation"}
ACTION = re.compile(r"^(demote|promote|rank_first|question_form|cap_full:[1-9]\d*|none)$")
TRIGGER_KEYS = {"category", "code_kind", "premise", "tier_in", "pattern"}
OPTIONAL_TRIGGER_KEYS = {"lens_only"}
EVIDENCE_KEYS = {"accepted", "partial", "ignored_seen", "unseen", "repos_n", "refs"}


def lessons(scope):
    return {l["id"]: l for l in tally.load_lessons(ROOT) if l["scope"] == scope}


def as_list(v):
    return [] if v in (None, "*") else v if isinstance(v, list) else [v]


class LessonShape:
    """Shared checks for any lesson dict."""

    def check_trigger(self, fm):
        t = fm["trigger"]
        self.assertTrue(TRIGGER_KEYS <= set(t) <= TRIGGER_KEYS | OPTIONAL_TRIGGER_KEYS, fm["id"])
        slugs = set(store.taxonomy())
        self.assertLessEqual(set(as_list(t["category"])), slugs, fm["id"])
        self.assertLessEqual(set(as_list(t["code_kind"])), CODE_KINDS, fm["id"])
        self.assertLessEqual(set(as_list(t["premise"])), PREMISES, fm["id"])
        self.assertLessEqual(set(as_list(t["tier_in"])), TIERS, fm["id"])
        if t["pattern"]:
            re.compile(t["pattern"])
        self.assertTrue(any(t[k] for k in TRIGGER_KEYS), f"{fm['id']}: an empty trigger matches everything")

    def check_common(self, fm):
        self.assertTrue(set(tally.LESSON_ORDER) <= set(fm), f"{fm['id']}: missing {set(tally.LESSON_ORDER) - set(fm)}")
        self.assertIn(fm["kind"], KINDS)
        self.assertRegex(fm["action"], ACTION)
        self.assertEqual(fm["action"] == "none", fm["kind"] == "recall", fm["id"])
        self.assertIn(fm["category"], set(store.taxonomy()) | {"*"})
        self.assertTrue(fm["claim"].strip())
        self.assertEqual(fm["window"], 20)
        self.check_trigger(fm)
        self.assertEqual(set(fm["evidence"]), EVIDENCE_KEYS, fm["id"])
        post, ev = fm["posterior"], fm["evidence"]
        self.assertEqual(post["alpha"], round(post["prior"][0] + ev["accepted"] + 0.5 * ev["partial"], 4), fm["id"])
        self.assertEqual(post["beta"], round(post["prior"][1] + ev["ignored_seen"] + 0.5 * ev["partial"], 4), fm["id"])
        self.assertEqual(post["mean"], round(post["alpha"] / (post["alpha"] + post["beta"]), 4), fm["id"])
        self.assertEqual(fm["confidence"], "low" if fm["status"] == "candidate" else fm["confidence"])


class TestMlSeeds(unittest.TestCase, LessonShape):
    def setUp(self):
        self.ml = lessons("ml")

    def test_exactly_the_fifteen_seeds_with_planned_status(self):
        self.assertEqual({i: l["fm"]["status"] for i, l in self.ml.items()}, SEEDS)

    def test_file_name_matches_id(self):
        for i, l in self.ml.items():
            self.assertEqual(l["path"].stem, i)

    def test_schema_and_posterior_consistency(self):
        for l in self.ml.values():
            self.check_common(l["fm"])

    def test_provenance_seeded_and_codified_pointer(self):
        for i, l in self.ml.items():
            fm = l["fm"]
            self.assertEqual(fm["provenance"], "seeded", i)
            self.assertEqual(bool(fm["codified_in"]), fm["status"] == "codified", i)
            self.assertNotIn("/", str(fm["codified_in"]), i)

    def test_only_owner_confirmed_lessons_are_approved(self):
        approved = sorted(i for i, l in self.ml.items() if l["fm"]["status"] == "approved")
        self.assertEqual(approved, ["scenario-boost"])

    def test_recall_lessons_do_nothing_at_merge(self):
        recall = {i for i, l in self.ml.items() if l["fm"]["kind"] == "recall"}
        self.assertEqual(recall, {"type-model"})

    def test_actions_cover_every_expressible_effect(self):
        got = {re.sub(r":.*", "", l["fm"]["action"]) for l in self.ml.values()}
        self.assertEqual(got, {"demote", "rank_first", "question_form", "cap_full", "none"})

    def test_cap_values(self):
        caps = {i: l["fm"]["action"] for i, l in self.ml.items() if l["fm"]["action"].startswith("cap_full")}
        self.assertEqual(caps, {"gap-volume": "cap_full:3", "oq-standalone": "cap_full:3", "volume": "cap_full:8"})

    def test_triggers_select_the_intended_items(self):
        def hit(lid, **item):
            base = {"category": "x", "code_kind": "prod", "premise": "in-diff", "tier": "M", "title": "t"}
            return tally.trigger_matches(self.ml[lid]["fm"]["trigger"], {**base, **item})
        self.assertTrue(hit("premise-external", premise="external-unverified", tier="B"))
        self.assertFalse(hit("premise-external", premise="in-diff", tier="B"))
        self.assertTrue(hit("race-spec", category="concurrency", premise="external-unverified"))
        self.assertFalse(hit("race-spec", category="concurrency", premise="in-diff"))
        self.assertTrue(hit("scenario-boost", category="correctness-scenario", tier="B"))
        self.assertFalse(hit("scenario-boost", category="correctness-scenario", tier="I"))
        self.assertTrue(hit("test-oracle-abstract", category="test-oracle", code_kind="test"))
        self.assertTrue(hit("test-oracle-abstract", category="test-oracle", code_kind="test",
                            title="Test pins the exact message and only checks the supertype"))  # R4
        self.assertFalse(hit("test-oracle-abstract", category="test-oracle", code_kind="test",
                             title="'return live media' test no longer asserts originStatus"))  # R1
        self.assertFalse(hit("test-oracle-abstract", category="test-oracle", code_kind="test",
                             title="Test No Longer Checks the status"))
        self.assertTrue(hit("test-assert-concrete", category="test-oracle", code_kind="test", tier="I"))
        self.assertFalse(hit("test-assert-concrete", category="test-oracle", code_kind="test", tier="M"))
        self.assertTrue(hit("scope-question", tier="I", title="Two unrelated changes in one PR"))
        self.assertTrue(hit("scope-question", tier="I", title="Out-of-scope entry in a removal PR"))
        self.assertFalse(hit("scope-question", tier="I", title="Null check missing"))
        self.assertTrue(hit("refactor-only", category="encapsulation", lens=["refactor-identification"]))
        self.assertFalse(hit("refactor-only", category="encapsulation", lens=["code-review-checklist"]))
        self.assertFalse(hit("refactor-only", category="encapsulation", lens=["refactor-identification", "qa-adversary"]))
        self.assertTrue(hit("postable-suggestion", category="domain-assumption", tier="Q"))
        self.assertFalse(hit("postable-suggestion", category="domain-assumption", tier="M"))


@unittest.skipUnless((ROOT / "repo-lessons").is_dir(), "repo-lessons/ is git-ignored and absent here")
class TestRepoSeedsShape(unittest.TestCase, LessonShape):
    """Name-free checks; the checks that name real repos live in the git-ignored repo-lessons/test_repo_lessons.py."""

    def setUp(self):
        self.repo = lessons("repo")

    def test_schema_scope_and_repo_field(self):
        self.assertTrue(self.repo)
        for i, l in self.repo.items():
            fm, folder = l["fm"], l["path"].parent.name
            self.check_common(fm)
            self.assertEqual(fm["repo"], "*" if folder == "_org" else folder, i)
            self.assertIn(fm["scope"], {"repo", "until-merge", "this-pr-only"})
            self.assertIn("wiki_proposal", fm)
            self.assertIn(fm["provenance"], {"stated", "observed"})

    def test_protect_list_points_at_real_findings(self):
        data = json.loads((ROOT / "repo-lessons" / "_protect.json").read_text(encoding="utf-8"))
        self.assertTrue(data["findings"])
        ledger = {r["review_id"]: r for r in tally.load_reports(ROOT)}
        for f in data["findings"]:
            self.assertIn(f["id"], [x["id"] for x in ledger[f["review_id"]]["fm"]["findings"]])
        for c in data["categories"]:
            self.assertIn(c["category"], set(store.taxonomy()))


if __name__ == "__main__":
    unittest.main()
