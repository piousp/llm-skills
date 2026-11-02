"""Unit tests for scripts/replay.py: fold splitting, lesson building, PASS/FAIL criteria, narrowing.

Synthetic ledgers only (fake repo acme-widget-svc). Literal expected values, no mocks.

Run: cd pablo-code-review && python3 -m unittest discover -s evals -p 'test_*.py' -v
"""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import replay  # noqa: E402
import tally  # noqa: E402
from test_lessons import finding, make_report, outcome  # noqa: E402
from test_select import put_lesson  # noqa: E402

REPO = "acme-widget-svc"
SEEN = "wrong"  # an explicit reason: the reviewer read the item and skipped it


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def report(self, pr, specs, day=None):
        """specs: (id, tier, category, code_kind, outcome kind). Not-posted items carry a seen reason."""
        fs = [finding(i, tier=t, category=c, code_kind=k, rank=n, premise="1-hop")
              for n, (i, t, c, k, _) in enumerate(specs, 1)]
        os_ = [outcome(i, kind, SEEN if kind == "not-posted" else None) for i, _, _, _, kind in specs]
        make_report(self.root, REPO, pr, 1, day or pr, fs, os_)

    def ledger(self, n=5):
        """n train PRs, each with 3 not-posted Major scenario items on prod code."""
        for pr in range(1, n + 1):
            self.report(pr, [(f"M{k}", "M", "correctness-scenario", "prod", "not-posted") for k in (1, 2, 3)])

    def demote_lesson(self, lid="d-scenario"):
        put_lesson(self.root, f"ml-lessons/{lid}.md", lid, status="candidate", category="correctness-scenario",
                   tier_in=["M"])

    def fold(self, keys, floor=False):
        return replay.run_fold("t", keys, replay.load_ledger(self.root), tally.load_lessons(self.root), {},
                               floor=floor)


class Splitting(unittest.TestCase):
    keys = [("acme", str(n)) for n in range(1, 19)]

    def test_parse_keys(self):
        self.assertEqual(replay.parse_keys("a-b#12, c#3"), [("a-b", "12"), ("c", "3")])
        with self.assertRaises(ValueError):
            replay.parse_keys("nohash")

    def test_folds_slice_the_sorted_remainder(self):
        folds = replay.split_folds(self.keys, [("acme", "1"), ("acme", "2"), ("acme", "3"), ("acme", "4")], 4)
        self.assertEqual([n for n, _ in folds], ["1", "2", "3", "4"])
        rest = sorted((f"acme#{n}" for n in range(5, 19)))
        names = [[f"{r}#{p}" for r, p in k] for _, k in folds[1:]]
        self.assertEqual(names, [rest[0:4], rest[4:8], rest[8:12]])

    def test_alt_fold_is_labelled_1b(self):
        folds = replay.split_folds(self.keys, [("acme", "1")], 2, alt_keys=[("acme", "2")])
        self.assertEqual([n for n, _ in folds], ["1", "1b", "2"])

    def test_unknown_key_is_an_error(self):
        with self.assertRaises(ValueError):
            replay.split_folds(self.keys, [("acme", "99")], 4)


class Narrowing(unittest.TestCase):
    lesson = {"fm": {}}

    def m(self, posted, **kw):
        return {"category": "c", "code_kind": "prod", "premise": "in-diff", "tier": "M", "posted": posted, **kw}

    def test_picks_the_facet_that_excludes_the_lost_item(self):
        matched = [self.m(False), self.m(False, code_kind="build"), self.m(True, code_kind="test")]
        out = replay.narrow_trigger(self.lesson, {"code_kind": "test"}, matched)
        self.assertEqual(out, {"restrict": {"code_kind": ["build", "prod"]}, "keeps_non_posted": "2/2",
                               "still_matches_posted": 0})

    def test_no_separating_facet(self):
        out = replay.narrow_trigger(self.lesson, self.m(True), [self.m(False), self.m(True)])
        self.assertIsNone(out["restrict"])

    def test_weak_when_posted_items_still_match(self):
        matched = [self.m(False, premise="1-hop"), self.m(True, premise="1-hop"), self.m(True)]
        out = replay.narrow_trigger(self.lesson, self.m(True), matched)
        self.assertEqual((out["restrict"], out["weak"]), ({"premise": ["1-hop"]}, True))


class Criteria(Base):
    def test_pass_when_demotion_spares_posted_items(self):
        self.ledger()
        self.demote_lesson()
        self.report(9, [("M1", "M", "correctness-scenario", "prod", "not-posted"),
                        ("M2", "M", "correctness-scenario", "prod", "not-posted"),
                        ("M3", "M", "correctness-scenario", "prod", "not-posted"),
                        ("M4", "M", "contract-compat", "prod", "posted")])
        r = self.fold([(REPO, "9")])
        self.assertEqual((r["full_baseline"], r["full_after"], r["full_drop_pct"]), (4, 1, 75.0))
        self.assertEqual((r["posted_lost"], r["partial_lost"], r["demoted_categories_empty"], r["pass"]), (0, 0, [], True))
        self.assertEqual(r["lessons_treated_as_approved"], ["d-scenario"])

    def test_fail_when_a_posted_item_is_demoted_and_names_the_culprit_and_a_narrowing(self):
        self.ledger()
        self.demote_lesson()
        self.report(9, [("M1", "M", "correctness-scenario", "prod", "not-posted"),
                        ("M2", "M", "correctness-scenario", "test", "posted")])
        r = self.fold([(REPO, "9")])
        self.assertFalse(r["pass"])
        self.assertEqual((r["posted_lost"], r["checks"]["posted_kept"]), (1, False))
        v = r["violations"][0]
        self.assertEqual((v["kind"], v["finding"], v["from"], v["to"], v["lessons"]), ("posted-lost", "M2", "M", "I", ["d-scenario"]))
        self.assertEqual(v["narrowed"]["d-scenario"]["restrict"], {"code_kind": ["prod"]})

    def test_one_partial_is_allowed_two_are_not(self):
        self.ledger()
        self.demote_lesson()
        one = [("M1", "M", "correctness-scenario", "prod", "partial"),
               ("M2", "M", "correctness-scenario", "prod", "not-posted"),
               ("M3", "M", "correctness-scenario", "prod", "not-posted")]
        self.report(9, one)
        self.assertTrue(self.fold([(REPO, "9")])["checks"]["posted_kept"])
        self.report(8, [("M1", "M", "correctness-scenario", "prod", "partial"),
                        ("M2", "M", "correctness-scenario", "prod", "partial"),
                        ("M3", "M", "correctness-scenario", "prod", "not-posted")])
        self.assertFalse(self.fold([(REPO, "8")])["checks"]["posted_kept"])

    def test_fail_when_the_full_format_drop_is_under_30_percent(self):
        self.ledger()
        self.report(9, [("M1", "M", "contract-compat", "prod", "not-posted"),
                        ("M2", "M", "contract-compat", "prod", "not-posted")])
        r = self.fold([(REPO, "9")])  # no lesson matches: nothing drops
        self.assertEqual((r["full_drop_pct"], r["checks"]["drop_ge_30"], r["pass"]), (0.0, False, False))

    def test_fail_when_a_demoted_category_loses_every_visible_line(self):
        self.ledger()
        put_lesson(self.root, "ml-lessons/d-nit.md", "d-nit", status="candidate", category="naming-docs-style", tier_in=["I"])
        self.report(9, [("I1", "I", "naming-docs-style", "prod", "not-posted"),
                        ("M1", "M", "contract-compat", "prod", "not-posted")])
        r = self.fold([(REPO, "9")])
        self.assertEqual(r["demoted_categories_empty"], ["naming-docs-style"])
        v = [x for x in r["violations"] if x["kind"] == "category-empty"][0]
        self.assertEqual((v["items"], v["lessons"]), (["I1"], ["d-nit"]))
        self.assertFalse(r["checks"]["categories_visible"])

    def test_never_suppress_list_is_honoured(self):
        self.ledger()
        self.demote_lesson()
        self.report(9, [("M1", "M", "correctness-scenario", "prod", "posted")])
        r = replay.run_fold("t", [(REPO, "9")], replay.load_ledger(self.root), tally.load_lessons(self.root),
                            {"categories": [{"repo": REPO, "category": "correctness-scenario", "premise": None}]})
        self.assertEqual((r["posted_lost"], r["full_after"]), (0, 1))

    def test_codified_retired_and_recall_lessons_are_left_out(self):
        self.ledger()
        put_lesson(self.root, "ml-lessons/a.md", "a", status="codified")
        put_lesson(self.root, "ml-lessons/b.md", "b", status="retired")
        put_lesson(self.root, "ml-lessons/c.md", "c", status="candidate", kind="recall", action="none")
        self.demote_lesson()
        self.report(9, [("M1", "M", "contract-compat", "prod", "not-posted")])
        self.assertEqual(self.fold([(REPO, "9")])["lessons_treated_as_approved"], ["d-scenario"])

    def test_uncovered_cells_the_train_tally_would_add_are_treated_as_approved(self):
        for pr in (1, 2):  # 4 seen, never acted on, 2 PRs: an ADD proposal for this cell
            self.report(pr, [(f"M{k}", "M", "error-handling", "prod", "not-posted") for k in (1, 2)])
        self.report(9, [("M1", "M", "error-handling", "prod", "not-posted")])
        r = self.fold([(REPO, "9")])
        self.assertEqual(r["added_by_tally"], ["error-handling-prod-1-hop-m"])
        self.assertEqual(r["full_after"], 0)

    def test_test_reports_never_train_their_own_fold(self):
        self.ledger(2)
        self.report(9, [("M1", "M", "error-handling", "prod", "not-posted"),
                        ("M2", "M", "error-handling", "prod", "not-posted"),
                        ("M3", "M", "error-handling", "prod", "not-posted")])
        r = self.fold([(REPO, "9")])
        # the 3 error-handling obs come from ONE PR (the test one) and the train ledger has none: no ADD for it
        self.assertEqual((r["train_reports"], r["added_by_tally"]), (2, ["correctness-scenario-prod-1-hop-m"]))

    def test_exploration_counter_is_threaded_across_test_reviews(self):
        self.ledger()
        self.demote_lesson()
        for pr in (8, 9):
            self.report(pr, [("M1", "M", "correctness-scenario", "prod", "not-posted"),
                             ("M2", "M", "correctness-scenario", "prod", "not-posted"),
                             ("M3", "M", "correctness-scenario", "prod", "not-posted")])
        r = self.fold([(REPO, "8"), (REPO, "9")])
        self.assertEqual((r["full_baseline"], r["full_after"]), (6, 1))  # the 4th trigger is explored once


class WhatIfVariants(Base):
    """Two PRs' worth of postable-looking Q lines plus a posted volume item, to tell A, B and C apart."""

    def lessons(self):
        put_lesson(self.root, "ml-lessons/postable.md", "postable-suggestion", status="candidate",
                   category="domain-assumption", tier_in=["Q"])
        put_lesson(self.root, "ml-lessons/volume.md", "volume", status="candidate", tier_in=["M"])
        put_lesson(self.root, "ml-lessons/race.md", "race-spec", status="candidate", category="concurrency",
                   tier_in=["M"])

    def test_variant_pools(self):
        pool = [{"id": i, "fm": {"trigger": {"category": "x", "code_kind": None}}}
                for i in ("volume", "nit-exact", "race-spec", "postable-suggestion", "other")]
        ids = lambda v: [l["id"] for l in replay.variant_pool(pool, v)[0]]  # noqa: E731
        self.assertEqual((ids(None), replay.variant_pool(pool, None)[1]), (ids("A"), True))
        self.assertEqual(replay.variant_pool(pool, "A")[1], True)
        self.assertEqual(ids("B"), ["race-spec", "postable-suggestion", "other"])
        self.assertEqual(ids("C"), ["postable-suggestion", "other"])
        narrowed = [l for l in replay.variant_pool(pool, "C")[0] if l["id"] == "postable-suggestion"][0]
        self.assertEqual(narrowed["fm"]["trigger"], {"category": "x", "code_kind": ["build", "script", "test"]})
        self.assertIsNone(pool[3]["fm"]["trigger"].get("code_kind"))  # the input pool is never edited
        self.assertEqual(replay.variant_pool(pool, "none"), ([], True))
        with self.assertRaises(ValueError):
            replay.variant_pool(pool, "Z")

    def test_a_keeps_one_question_visible_where_default_empties_the_category(self):
        self.ledger()
        self.lessons()
        self.report(9, [("Q1", "Q", "domain-assumption", "prod", "posted"),
                        ("Q2", "Q", "domain-assumption", "prod", "not-posted"),
                        ("M1", "M", "contract-compat", "prod", "not-posted")])
        base = self.fold([(REPO, "9")])
        self.assertEqual(base["demoted_categories_empty"], ["domain-assumption"])
        a = replay.run_fold("t", [(REPO, "9")], replay.load_ledger(self.root), tally.load_lessons(self.root), {}, "A")
        self.assertEqual((a["demoted_categories_empty"], a["variant"], a["checks"]["categories_visible"]), ([], "A", True))
        d = replay.run_fold("t", [(REPO, "9")], replay.load_ledger(self.root), tally.load_lessons(self.root), {})  # default
        self.assertEqual(d["demoted_categories_empty"], [])

    def test_b_and_c_spare_the_posted_item_volume_would_demote(self):
        self.ledger(2)
        self.lessons()
        specs = [(f"M{n}", "M", "contract-compat", "prod", "posted" if n == 9 else "not-posted") for n in range(1, 10)]
        self.report(9, specs + [("Q1", "Q", "domain-assumption", "prod", "posted")])
        keys, led, les = [(REPO, "9")], replay.load_ledger(self.root), tally.load_lessons(self.root)
        a, b, c = (replay.run_fold("t", keys, led, les, {}, v) for v in "ABC")
        self.assertEqual((a["posted_lost"], b["posted_lost"], c["posted_lost"]), (1, 0, 0))
        self.assertEqual([v["lessons"] for v in a["violations"] if v["kind"] == "posted-lost"], [["volume"]])
        self.assertNotIn("volume", b["lessons_treated_as_approved"])
        self.assertNotIn("race-spec", c["lessons_treated_as_approved"])

    def test_default_run_is_unchanged_by_the_new_parameters(self):
        self.ledger()
        self.demote_lesson()
        self.report(9, [("M1", "M", "correctness-scenario", "prod", "not-posted")])
        keys, led, les = [(REPO, "9")], replay.load_ledger(self.root), tally.load_lessons(self.root)
        a = replay.run_fold("t", keys, led, les, {})
        b = replay.run_fold("t", keys, led, les, {}, None, False)
        self.assertEqual(a, b)
        self.assertEqual((a["variant"], a["static_baseline"], a["full_baseline"], a["recorded_full"]), (None, False, 1, 1))


class StaticBaseline(Base):
    def codified(self):
        put_lesson(self.root, "ml-lessons/gap.md", "gap-volume", action="cap_full:1", status="codified",
                   category="coverage-gap", tier_in=["G"])
        put_lesson(self.root, "ml-lessons/ro.md", "refactor-only", status="codified",
                   category="abstraction-structure", tier_in=["M"])

    def refactor_report(self, pr, lens):
        fs = [finding("M1", category="abstraction-structure", rank=1, premise="1-hop"),
              finding("M2", category="contract-compat", rank=2, premise="1-hop")]
        fs[0]["lens"] = lens
        make_report(self.root, REPO, pr, 1, pr, fs, [outcome("M1", "posted"), outcome("M2", "not-posted", SEEN)])

    def test_codified_pool_restricts_refactor_only_to_one_lens_and_is_in_memory(self):
        self.codified()
        put_lesson(self.root, "ml-lessons/old.md", "old", status="retired")
        pool = replay.codified_pool(tally.load_lessons(self.root))
        self.assertEqual([l["id"] for l in pool], ["gap-volume", "refactor-only"])
        self.assertEqual(pool[1]["fm"]["trigger"]["lens_only"], "refactor-identification")
        self.assertNotIn("lens_count", pool[1]["fm"]["trigger"])
        self.assertEqual({l["fm"]["status"] for l in pool}, {"approved"})
        self.assertNotIn("lens_only", tally.load_lessons(self.root)[1]["fm"]["trigger"])

    def test_regret_lists_refactor_lens_only_items_not_checklist_only(self):
        self.codified()
        self.refactor_report(1, ["refactor-identification"])
        self.refactor_report(2, ["code-review-checklist"])
        rows = replay.codified_regret(replay.load_ledger(self.root), tally.load_lessons(self.root), {})
        self.assertEqual([r["review"] for r in rows], ["acme-widget-svc/pr1-r1-2026-01-01"])

    def premise_report(self, pr, form, tier="M"):
        fs = [finding("M1", tier=tier, category="correctness-scenario", rank=1, premise="external-unverified")]
        o = outcome("M1", "posted")
        o["form"] = form
        make_report(self.root, REPO, pr, 1, pr, fs, [o])

    def codified_premise(self):
        put_lesson(self.root, "ml-lessons/pe.md", "premise-external", status="codified", premise="external-unverified",
                   tier_in=["B", "M"])

    def test_static_target_lands_premise_external_on_q(self):
        self.assertEqual(replay.STATIC_TARGET, {"premise-external": "Q"})
        self.codified_premise()
        self.premise_report(1, "assertion")
        rows = replay.codified_regret(replay.load_ledger(self.root), tally.load_lessons(self.root), {})
        self.assertEqual([(r["lesson"], r["to"]) for r in rows], [("premise-external", "Q")])

    def test_question_item_on_q_is_kept_when_the_owner_posted_a_question(self):
        self.codified_premise()
        self.premise_report(1, "question")
        self.assertEqual(replay.codified_regret(replay.load_ledger(self.root), tally.load_lessons(self.root), {}), [])

    def test_fold_counts_a_posted_question_on_q_as_kept_but_not_an_assertion(self):
        self.codified_premise()
        self.premise_report(1, "question")
        self.premise_report(2, "assertion")
        led, les = replay.load_ledger(self.root), tally.load_lessons(self.root)
        kept = replay.run_fold("t", [(REPO, "1")], led, les, {}, "none", True)
        lost = replay.run_fold("t", [(REPO, "2")], led, les, {}, "none", True)
        self.assertEqual((kept["posted_or_partial_lost_vs_recorded"], kept["posted_lost"]), ([], 0))
        self.assertEqual(lost["posted_or_partial_lost_vs_recorded"], ["acme-widget-svc/pr2-r1-2026-01-02:M1"])

    def test_regret_lists_single_lens_posted_item_only(self):
        self.codified()
        self.refactor_report(1, ["refactor-identification"])
        self.refactor_report(2, ["refactor-identification", "code-review-checklist"])
        rows = replay.codified_regret(replay.load_ledger(self.root), tally.load_lessons(self.root), {})
        self.assertEqual([(r["lesson"], r["review"], r["finding"], r["tier"], r["to"], r["outcome"], r["lens"])
                          for r in rows],
                         [("refactor-only", "acme-widget-svc/pr1-r1-2026-01-01", "M1", "M", "I", "posted",
                           ["refactor-identification"])])

    def test_regret_blames_only_lessons_that_demote(self):
        self.codified()
        put_lesson(self.root, "ml-lessons/qf.md", "question-form", action="question_form", status="codified",
                   tier_in=["M"])
        self.refactor_report(1, ["refactor-identification"])
        rows = replay.codified_regret(replay.load_ledger(self.root), tally.load_lessons(self.root), {})
        self.assertEqual([r["lesson"] for r in rows], ["refactor-only"])

    def test_static_baseline_is_what_the_codified_rules_leave(self):
        self.codified()
        self.ledger(2)
        self.refactor_report(9, ["refactor-identification"])
        r = replay.run_fold("t", [(REPO, "9")], replay.load_ledger(self.root), tally.load_lessons(self.root), {},
                            "none", True)
        self.assertEqual((r["recorded_full"], r["full_baseline"], r["full_after"], r["full_drop_pct"]), (2, 1, 1, 0.0))
        self.assertEqual((r["posted_lost"], r["posted_or_partial_lost_vs_recorded"]),
                         (0, ["acme-widget-svc/pr9-r1-2026-01-09:M1"]))

    def test_variant_runs_on_top_of_the_static_baseline(self):
        self.codified()
        self.ledger()
        self.demote_lesson()
        self.refactor_report(9, ["a", "b"])  # two lenses: refactor-only does not fire
        put_lesson(self.root, "ml-lessons/d2.md", "d-contract", status="candidate", category="contract-compat",
                   tier_in=["M"])
        r = replay.run_fold("t", [(REPO, "9")], replay.load_ledger(self.root), tally.load_lessons(self.root), {},
                            "A", True)
        self.assertEqual((r["recorded_full"], r["full_baseline"], r["full_after"]), (2, 2, 1))  # d-contract demotes M2
        self.assertEqual((r["pass"], r["variant"], r["static_baseline"]), (True, "A", True))

    def test_static_stage_has_no_exploration(self):
        put_lesson(self.root, "ml-lessons/dq.md", "gap-volume", action="cap_full:0", status="codified",
                   category="coverage-gap", tier_in=["G"])
        for pr in range(1, 7):
            make_report(self.root, REPO, pr, 1, pr, [finding("G1", tier="G", category="coverage-gap", rank=1)],
                        [outcome("G1", "not-posted", SEEN)])
        out = replay.codified_pool(tally.load_lessons(self.root))
        res = replay.sel.select([{**finding("G1", tier="G", category="coverage-gap"), "rank": 1}], REPO, out, [],
                                {}, explore=False, floor=False)
        self.assertEqual(res["findings"][0]["shown_as"], "demoted")


def cli(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = replay.main(list(argv))
    return rc, out.getvalue(), err.getvalue()


class Cli(Base):
    def setUp(self):
        super().setUp()
        self.ledger()
        self.demote_lesson()
        self.report(9, [("M1", "M", "correctness-scenario", "prod", "not-posted"),
                        ("M2", "M", "contract-compat", "prod", "posted")])

    def test_json_output_and_exit_code(self):
        rc, out, _ = cli("--root", str(self.root), "--test", f"{REPO}#9", "--folds", "2", "--json")
        data = json.loads(out)
        self.assertEqual((rc, [f["fold"] for f in data], data[0]["pass"]), (0, ["1", "2"], True))

    def test_failure_exits_2_and_text_names_the_fold(self):
        self.report(10, [("M1", "M", "contract-compat", "prod", "not-posted")])  # no lesson matches: no drop
        rc, out, _ = cli("--root", str(self.root), "--test", f"{REPO}#10", "--folds", "1")
        self.assertEqual(rc, 2)
        self.assertIn("## Fold 1: FAIL", out)

    def test_unknown_key_exits_1(self):
        rc, _, err = cli("--root", str(self.root), "--test", f"{REPO}#99")
        self.assertEqual(rc, 1)
        self.assertIn("unknown PR key", err)

    def test_whatif_and_static_flags_are_wired(self):
        rc, out, _ = cli("--root", str(self.root), "--test", f"{REPO}#9", "--whatif", "A", "--baseline", "static",
                         "--json")
        d = json.loads(out)[0]
        self.assertEqual((d["variant"], d["static_baseline"]), ("A", True))
        rc, text, _ = cli("--root", str(self.root), "--test", f"{REPO}#9", "--whatif", "B")
        self.assertIn("what-if: variant B, baseline recorded", text)

    def test_regret_mode_needs_no_test_keys(self):
        rc, out, _ = cli("--root", str(self.root), "--regret")
        self.assertEqual((rc, "none" in out), (0, True))

    def test_nothing_is_written(self):
        before = sorted(p.name for p in self.root.rglob("*"))
        cli("--root", str(self.root), "--test", f"{REPO}#9")
        self.assertEqual(sorted(p.name for p in self.root.rglob("*")), before)


if __name__ == "__main__":
    unittest.main()
