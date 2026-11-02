"""Unit tests for scripts/select_lessons.py: demotion ladder, never-suppress, exploration, shadow, conflicts.

Synthetic lessons and ledgers only (fake repo acme-widget-svc). Literal expected values, no mocks.

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

import select_lessons as sel  # noqa: E402
import store  # noqa: E402
import tally  # noqa: E402
from test_lessons import finding, make_report, outcome  # noqa: E402

REPO = "acme-widget-svc"


def item(iid, tier="M", rank=1, category="correctness-scenario", code_kind="prod", premise="in-diff",
         title="a title", lens=("code-review-checklist",), protect=None, **extra):
    return {"id": iid, "tier": tier, "rank": rank, "category": category, "code_kind": code_kind,
            "premise": premise, "title": title, "lens": list(lens), "protect": protect or [], **extra}


def put_lesson(root, rel, lid, action="demote", status="approved", kind="precision", repo=None,
               body="One line.", **trigger):
    fm = {"id": lid, "kind": kind, "category": trigger.get("category") or "*",
          "trigger": {"category": None, "code_kind": None, "premise": None, "tier_in": None, "pattern": None,
                      **trigger},
          "action": action, "status": status, "repo": repo, "provenance": "seeded"}
    path = Path(root) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(store.render_report(fm, body + "\n"), encoding="utf-8")


def run(root, items, repo=REPO, **kw):
    lessons = tally.load_lessons(root)
    reports = tally.load_reports(root)
    return sel.select(items, repo, lessons, reports, sel.load_protect(root), **kw)


def by_id(result):
    return {f["id"]: f for f in result["findings"]}


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)


class DemoteLadder(Base):
    def test_one_step_per_tier(self):
        for tier in "BMIQGT":  # one lesson per tier keeps every trigger count below the exploration floor
            put_lesson(self.root, f"ml-lessons/d{tier}.md", f"d{tier}", tier_in=[tier])
        items = [item("B1", "B", 1), item("M1", "M", 2), item("I1", "I", 3), item("Q1", "Q", 4),
                 item("G1", "G", 5), item("T1", "T", 6), item("O1", "O", 7)]
        r = by_id(run(self.root, items))
        self.assertEqual((r["B1"]["tier"], r["B1"]["shown_as"], r["B1"]["collapsed"]), ("M", "demoted", False))
        self.assertEqual((r["M1"]["tier"], r["M1"]["shown_as"], r["M1"]["collapsed"]), ("I", "demoted", False))
        for iid, tier in (("I1", "I"), ("Q1", "Q"), ("G1", "G"), ("T1", "T")):
            self.assertEqual((r[iid]["tier"], r[iid]["collapsed"], r[iid]["shown_as"]), (tier, True, "demoted"))
        self.assertEqual((r["O1"]["tier"], r["O1"]["shown_as"], r["O1"]["lessons"]), ("O", "normal", []))

    def test_two_demote_lessons_still_one_step(self):
        put_lesson(self.root, "ml-lessons/d1.md", "d1")
        put_lesson(self.root, "ml-lessons/d2.md", "d2")
        res = run(self.root, [item("M1", "M")])
        f = by_id(res)["M1"]
        self.assertEqual((f["tier"], f["lessons"]), ("I", ["d1", "d2"]))

    def test_promote_only_when_premise_in_diff(self):
        put_lesson(self.root, "ml-lessons/p.md", "p", action="promote", tier_in=["I"])
        items = [item("I1", "I", 1, premise="in-diff"), item("I2", "I", 2, premise="1-hop"),
                 item("Q1", "Q", 3, premise="in-diff")]
        r = by_id(run(self.root, items))
        self.assertEqual((r["I1"]["tier"], r["I1"]["lessons"]), ("M", ["p"]))
        self.assertEqual((r["I2"]["tier"], r["I2"]["lessons"]), ("I", []))
        self.assertEqual(r["Q1"]["tier"], "Q")

    def test_rank_first_and_question_form(self):
        put_lesson(self.root, "ml-lessons/r.md", "a-rank", action="rank_first", category="concurrency")
        put_lesson(self.root, "ml-lessons/q.md", "b-form", action="question_form", kind="presentation",
                   category="concurrency")
        items = [item("M1", "M", 1), item("M2", "M", 2, category="concurrency")]
        res = run(self.root, items)
        self.assertEqual([f["id"] for f in res["findings"]], ["M2", "M1"])
        self.assertEqual([f["rank"] for f in res["findings"]], [1, 2])
        f = by_id(res)["M2"]
        self.assertEqual((f["form"], f["lessons"], f["tier"]), ("question", ["a-rank", "b-form"], "M"))
        self.assertIsNone(by_id(res)["M1"]["form"])

    def test_cap_full_keeps_first_n(self):
        put_lesson(self.root, "ml-lessons/c.md", "c", action="cap_full:2", tier_in=["M"])
        items = [item(f"M{n}", "M", n) for n in (1, 2, 3, 4)]
        r = by_id(run(self.root, items))
        self.assertEqual([r[f"M{n}"]["tier"] for n in (1, 2, 3, 4)], ["M", "M", "I", "I"])

    def test_lesson_of_another_repo_is_not_applied(self):
        put_lesson(self.root, "repo-lessons/other-svc/x.md", "x", repo="other-svc")
        res = run(self.root, [item("M1", "M")])
        self.assertEqual(by_id(res)["M1"]["tier"], "M")
        self.assertEqual(res["lessons_applied"], [])


class WhatIfOptIns(Base):
    def setUp(self):
        super().setUp()
        put_lesson(self.root, "ml-lessons/dq.md", "dq", tier_in=["Q"], category="domain-assumption")

    def qs(self):
        return [item("Q1", "Q", 1, category="domain-assumption"), item("Q2", "Q", 2, category="domain-assumption"),
                item("Q3", "Q", 3, category="domain-assumption"), item("M1", "M", 4)]

    def test_no_floor_collapses_the_whole_category(self):
        r = by_id(run(self.root, self.qs(), floor=False))
        self.assertEqual([r[i]["collapsed"] for i in ("Q1", "Q2", "Q3")], [True, True, True])

    def test_default_keeps_the_highest_ranked_item_visible_and_unmarked(self):
        res = run(self.root, self.qs())
        r = by_id(res)
        self.assertEqual([r[i]["collapsed"] for i in ("Q1", "Q2", "Q3")], [False, True, True])
        self.assertEqual((r["Q1"]["shown_as"], r["Q1"]["lessons"], r["Q1"]["tier"]), ("normal", [], "Q"))
        self.assertEqual(res["collapsed_line"], "Demoted by lessons: Q2, Q3 (dq)")
        self.assertEqual(res["lessons_applied"], ["dq"])

    def test_floor_leaves_a_category_with_a_visible_item_alone(self):
        items = self.qs() + [item("I1", "I", 5, category="domain-assumption")]
        r = by_id(run(self.root, items))
        self.assertEqual([r[i]["collapsed"] for i in ("Q1", "Q2", "Q3", "I1")], [True, True, True, False])

    def test_floor_ignores_categories_nothing_collapsed(self):
        r = by_id(run(self.root, [item("M1", "M", 1)]))
        self.assertEqual((r["M1"]["collapsed"], r["M1"]["shown_as"]), (False, "normal"))

    def test_floor_applies_to_the_highest_ranked_even_when_listed_last(self):
        items = [item("Q9", "Q", 9, category="domain-assumption"), item("Q2", "Q", 2, category="domain-assumption")]
        r = by_id(run(self.root, items))
        self.assertEqual((r["Q2"]["collapsed"], r["Q9"]["collapsed"]), (False, True))

    def test_explore_off_never_shows_the_original_tier(self):
        items = [item(f"Q{n}", "Q", n, category="domain-assumption") for n in range(1, 9)]
        self.assertIn("explore", {f["shown_as"] for f in run(self.root, items)["findings"]})
        res = run(self.root, items, explore=False, floor=False)
        self.assertEqual({f["shown_as"] for f in res["findings"]}, {"demoted"})

    def test_lens_count_trigger_matches_only_that_many_lenses(self):
        put_lesson(self.root, "ml-lessons/ro.md", "ro", tier_in=["M"], lens_count=1)
        items = [item("M1", "M", 1, lens=("a",)), item("M2", "M", 2, lens=("a", "b"))]
        r = by_id(run(self.root, items))
        self.assertEqual((r["M1"]["tier"], r["M2"]["tier"]), ("I", "M"))

    def test_lens_only_trigger_matches_only_that_exact_lens(self):
        put_lesson(self.root, "ml-lessons/lo.md", "lo", tier_in=["M"], lens_only="refactor-identification")
        items = [item("M1", "M", 1, lens=("refactor-identification",)),
                 item("M2", "M", 2, lens=("refactor-identification", "code-review-checklist")),
                 item("M3", "M", 3, lens=("code-review-checklist",)), item("M4", "M", 4, lens=())]
        r = by_id(run(self.root, items))
        self.assertEqual([r[k]["tier"] for k in ("M1", "M2", "M3", "M4")], ["I", "M", "M", "M"])

    def test_targets_land_a_demotion_on_the_named_tier(self):
        put_lesson(self.root, "ml-lessons/pe.md", "pe", tier_in=["B", "M"])
        items = [item("B1", "B", 1, lens=("a",)), item("M1", "M", 2, lens=("a",))]
        res = run(self.root, items, targets={"pe": "Q"}, explore=False)
        got = by_id(res)
        self.assertEqual([(got[k]["tier"], got[k]["shown_as"], got[k]["collapsed"]) for k in ("B1", "M1")],
                         [("Q", "demoted", False)] * 2)
        self.assertEqual(by_id(run(self.root, items, explore=False))["B1"]["tier"], "M")

    def test_cli_no_floor_flag_is_wired(self):
        put_lesson(self.root, "ml-lessons/dq2.md", "dq2", tier_in=["Q"], category="domain-assumption")
        f = self.root / "items.json"
        f.write_text(json.dumps(self.qs()), encoding="utf-8")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(sel.main(["--repo", REPO, "--root", str(self.root), "--in", str(f), "--no-floor"]), 0)
        got = {x["id"]: x["collapsed"] for x in json.loads(out.getvalue())["findings"]}
        self.assertEqual((got["Q1"], got["Q2"]), (True, True))

    def test_cli_default_keeps_the_floor(self):
        put_lesson(self.root, "ml-lessons/dq3.md", "dq3", tier_in=["Q"], category="domain-assumption")
        f = self.root / "items.json"
        f.write_text(json.dumps(self.qs()), encoding="utf-8")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(sel.main(["--repo", REPO, "--root", str(self.root), "--in", str(f)]), 0)
        got = {x["id"]: x["collapsed"] for x in json.loads(out.getvalue())["findings"]}
        self.assertEqual((got["Q1"], got["Q2"]), (False, True))

    def test_retired_lessons_are_never_applied(self):
        put_lesson(self.root, "ml-lessons/old.md", "old", status="retired", tier_in=["M"])
        res = run(self.root, [item("M1", "M", 1)])
        self.assertEqual((by_id(res)["M1"]["tier"], res["lessons_applied"], res["lessons_shadow"]), ("M", [], []))


class NeverSuppress(Base):
    def setUp(self):
        super().setUp()
        put_lesson(self.root, "ml-lessons/all.md", "all")
        (self.root / "repo-lessons").mkdir(exist_ok=True)
        (self.root / "repo-lessons" / "_protect.json").write_text(json.dumps({
            "findings": [{"repo": REPO, "pr": 7, "review_id": "aaaaaaaa", "id": "M9", "title": "Guard is check-then-act, not atomic"}],
            "categories": [{"repo": REPO, "category": "concurrency", "premise": None}],
        }))

    def untouched(self, it, **kw):
        res = run(self.root, [it], **kw)
        f = by_id(res)[it["id"]]
        self.assertEqual((f["tier"], f["shown_as"], f["collapsed"], f["lessons"]), (it["tier"], "normal", False, []), it)

    def test_qa_sourced_blocker(self):
        self.untouched(item("B1", "B", lens=["qa-adversary", "code-review-checklist"]))

    def test_non_qa_blocker_is_demotable(self):
        r = by_id(run(self.root, [item("B1", "B", lens=["code-review-checklist"])]))
        self.assertEqual(r["B1"]["tier"], "M")

    def test_duplication_reuse(self):
        self.untouched(item("I1", "I", category="duplication-reuse"))

    def test_type_modelling_in_diff_only(self):
        self.untouched(item("M1", "M", category="type-modelling", premise="in-diff"))
        r = by_id(run(self.root, [item("M2", "M", category="type-modelling", premise="1-hop")]))
        self.assertEqual(r["M2"]["tier"], "I")

    def test_assertion_loosened(self):
        self.untouched(item("M1", "M", assertion_loosened=True))
        self.untouched(item("M2", "M", protect=["assertion_loosened"]))

    def test_coordinator_protect(self):
        for tag in ("security", "data-loss", "credentials", "asked", "static"):
            self.untouched(item("M1", "M", protect=[tag]))

    def test_protect_list_matches_by_repo_pr_title_when_ids_change(self):
        self.untouched(item("M3", "M", title="The guard is check-then-act, not atomic!", category="error-handling"),
                       pr=7)

    def test_protect_list_wrong_pr_does_not_match(self):
        r = by_id(run(self.root, [item("M3", "M", title="Guard is check-then-act, not atomic", category="error-handling")], pr=8))
        self.assertEqual(r["M3"]["tier"], "I")

    def test_protect_list_category_rule(self):
        self.untouched(item("M1", "M", category="concurrency", premise="external-unverified"))

    def test_protect_list_is_per_repo(self):
        r = by_id(run(self.root, [item("M1", "M", category="concurrency")], repo="other-svc"))
        self.assertEqual(r["M1"]["tier"], "I")

    def test_protected_item_still_gets_presentation_lessons(self):
        put_lesson(self.root, "ml-lessons/q.md", "q", action="question_form", kind="presentation")
        f = by_id(run(self.root, [item("M1", "M", protect=["security"])]))["M1"]
        self.assertEqual((f["tier"], f["form"], f["lessons"]), ("M", "question", ["q"]))


class Exploration(Base):
    def ledger(self, shown):
        """One ledger review whose findings carry lesson d1 with the given shown_as values."""
        fs = [finding(f"M{n}", shown_as=s, lessons=["d1"]) for n, s in enumerate(shown, 1)]
        make_report(self.root, "acme-old", 1, 1, 5, fs, [outcome(f["id"]) for f in fs])

    def test_fourth_trigger_is_explored(self):
        put_lesson(self.root, "ml-lessons/d1.md", "d1")
        self.ledger(["demoted", "demoted", "demoted"])
        f = by_id(run(self.root, [item("M1", "M")]))["M1"]
        self.assertEqual((f["shown_as"], f["tier"], f["collapsed"], f["lessons"]), ("explore", "M", False, ["d1"]))

    def test_third_trigger_is_still_demoted(self):
        put_lesson(self.root, "ml-lessons/d1.md", "d1")
        self.ledger(["demoted", "demoted"])
        f = by_id(run(self.root, [item("M1", "M")]))["M1"]
        self.assertEqual((f["shown_as"], f["tier"]), ("demoted", "I"))

    def test_explore_resets_the_count(self):
        put_lesson(self.root, "ml-lessons/d1.md", "d1")
        self.ledger(["demoted", "demoted", "demoted", "explore", "demoted"])
        f = by_id(run(self.root, [item("M1", "M")]))["M1"]
        self.assertEqual(f["shown_as"], "demoted")

    def test_within_one_review_the_fourth_item_explores(self):
        put_lesson(self.root, "ml-lessons/d1.md", "d1")
        r = by_id(run(self.root, [item(f"M{n}", "M", n) for n in range(1, 6)]))
        self.assertEqual([r[f"M{n}"]["shown_as"] for n in range(1, 6)],
                         ["demoted", "demoted", "demoted", "explore", "demoted"])

    def test_protected_items_do_not_count(self):
        put_lesson(self.root, "ml-lessons/d1.md", "d1")
        items = [item("M1", "M", 1, protect=["asked"]), item("M2", "M", 2), item("M3", "M", 3), item("M4", "M", 4)]
        r = by_id(run(self.root, items))
        self.assertEqual([r[i]["shown_as"] for i in ("M1", "M2", "M3", "M4")], ["normal", "demoted", "demoted", "demoted"])

    def test_since_dict_is_threaded_and_updated(self):
        put_lesson(self.root, "ml-lessons/d1.md", "d1")
        since = {}
        run(self.root, [item("M1", "M"), item("M2", "M", 2)], since=since)
        self.assertEqual(since, {"d1": 2})


REC_C = {"lesson": "c", "status": "candidate", "finding": "M1", "action": "demote", "from": "M", "to": "I"}


def rec(lesson, finding, action="demote", frm="M", to="I", status="approved"):
    return {"lesson": lesson, "status": status, "finding": finding, "action": action, "from": frm, "to": to}


class ShadowAndStatus(Base):
    def test_candidates_are_shadow_only(self):
        put_lesson(self.root, "ml-lessons/c.md", "c", status="candidate")
        res = run(self.root, [item("M1", "M")])
        f = by_id(res)["M1"]
        self.assertEqual((f["tier"], f["shown_as"], f["lessons"]), ("M", "normal", []))
        self.assertEqual(res["lessons_applied"], [])
        self.assertEqual(res["lessons_shadow"], [REC_C])

    def test_shadow_respects_never_suppress(self):
        put_lesson(self.root, "ml-lessons/c.md", "c", status="candidate")
        res = run(self.root, [item("M1", "M", protect=["security"])])
        self.assertEqual(res["lessons_shadow"], [])

    def test_codified_retired_recall_never_apply_or_shadow(self):
        put_lesson(self.root, "ml-lessons/a.md", "a", status="codified")
        put_lesson(self.root, "ml-lessons/b.md", "b", status="retired")
        put_lesson(self.root, "ml-lessons/c.md", "c", status="approved", kind="recall", action="none")
        put_lesson(self.root, "ml-lessons/d.md", "d", status="candidate", kind="recall", action="none")
        res = run(self.root, [item("M1", "M")])
        self.assertEqual((by_id(res)["M1"]["tier"], res["lessons_applied"], res["lessons_shadow"]), ("M", [], []))


class OrgPatternAndPrecedence(Base):
    def test_org_pattern_matches_title(self):
        put_lesson(self.root, "repo-lessons/_org/nr.md", "nr", repo="*", pattern="roll ?back")
        items = [item("M1", "M", 1, title="No rollback path if the migration fails"),
                 item("M2", "M", 2, title="Unrelated finding")]
        r = by_id(run(self.root, items))
        self.assertEqual((r["M1"]["tier"], r["M1"]["lessons"]), ("I", ["nr"]))
        self.assertEqual((r["M2"]["tier"], r["M2"]["lessons"]), ("M", []))

    def test_precedence_lists_repo_then_org_then_ml(self):
        put_lesson(self.root, "ml-lessons/a.md", "a-ml")
        put_lesson(self.root, f"repo-lessons/{REPO}/b.md", "b-repo", repo=REPO)
        put_lesson(self.root, "repo-lessons/_org/c.md", "c-org", repo="*")
        res = run(self.root, [item("M1", "M")])
        self.assertEqual(res["lessons_applied"], ["b-repo", "c-org", "a-ml"])
        self.assertEqual(res["findings"][0]["lessons"], ["b-repo", "c-org", "a-ml"])

    def test_conflict_applies_neither_and_alerts(self):
        put_lesson(self.root, "ml-lessons/d.md", "dem")
        put_lesson(self.root, f"repo-lessons/{REPO}/p.md", "pro", repo=REPO, action="promote")
        put_lesson(self.root, "ml-lessons/q.md", "qf", action="question_form", kind="presentation")
        res = run(self.root, [item("I1", "I", premise="in-diff")])
        f = by_id(res)["I1"]
        self.assertEqual((f["tier"], f["shown_as"], f["collapsed"], f["lessons"], f["form"]), ("I", "normal", False, ["qf"], "question"))
        self.assertIn({"kind": "conflict", "finding": "I1", "lessons": ["dem", "pro"]}, res["alerts"])

    def test_no_conflict_when_one_side_is_not_effective(self):
        put_lesson(self.root, "ml-lessons/d.md", "dem")
        put_lesson(self.root, "ml-lessons/p.md", "pro", action="promote")
        res = run(self.root, [item("I1", "I", premise="1-hop")], floor=False)  # promote needs in-diff
        self.assertEqual((by_id(res)["I1"]["collapsed"], res["lessons_applied"]), (True, ["dem"]))

    def test_per_level_caps(self):
        for n in range(12):
            put_lesson(self.root, f"repo-lessons/{REPO}/r{n:02d}.md", f"r{n:02d}", repo=REPO, action="rank_first")
        res = run(self.root, [item("M1", "M")])
        self.assertEqual(len(res["lessons_applied"]), 10)
        self.assertEqual(res["alerts"][0], {"kind": "cap", "lessons": ["r10", "r11"]})


class OutputShape(Base):
    def test_collapsed_line_wording(self):
        put_lesson(self.root, "ml-lessons/d1.md", "d1", tier_in=["I"])
        put_lesson(self.root, "ml-lessons/d2.md", "d2", tier_in=["T"])
        items = [item("I4", "I", 1), item("T2", "T", 2), item("I7", "I", 3, premise="1-hop"), item("M1", "M", 4)]
        res = run(self.root, items)
        self.assertEqual(res["collapsed_line"], "Demoted by lessons: I4, I7, T2 (d1, d2)")
        self.assertEqual([f["id"] for f in res["findings"]], ["M1", "I4", "I7", "T2"])

    def test_no_collapse_no_line(self):
        self.assertEqual(run(self.root, [item("M1", "M")])["collapsed_line"], "")

    def test_every_item_is_returned_once(self):
        put_lesson(self.root, "ml-lessons/d.md", "d")
        items = [item(f"I{n}", "I", n) for n in range(1, 6)]
        res = run(self.root, items)
        self.assertEqual(sorted(f["id"] for f in res["findings"]), ["I1", "I2", "I3", "I4", "I5"])

    def test_bodies_are_capped_at_150_lines(self):
        for n in range(3):
            put_lesson(self.root, f"ml-lessons/l{n}.md", f"l{n}", action="rank_first", body="\n".join(f"line {i}" for i in range(80)))
        res = run(self.root, [item("M1", "M")])
        lines = res["bodies"].splitlines()
        self.assertEqual(len(lines), 150)
        self.assertEqual(lines[-1], "[truncated]")
        self.assertEqual(lines[0], "## l0")

    def test_short_bodies_are_whole(self):
        put_lesson(self.root, "ml-lessons/l.md", "l", action="rank_first", body="Line a.\nLine b.")
        self.assertEqual(run(self.root, [item("M1", "M")])["bodies"], "## l\nLine a.\nLine b.")

    def test_streak_alert_when_a_category_reaches_five_reviews_without_full_items_after_having_had_some(self):
        # a lesson must have moved the category (shown_as demoted): plain I-only streaks no longer alert
        for n in range(1, 5):
            fs = [finding("I1", tier="I", category="naming-docs-style", shown_as="demoted" if n == 1 else "normal")]
            make_report(self.root, "acme-old", n, 1, n, fs, [outcome("I1")])
        res = run(self.root, [item("I1", "I", category="naming-docs-style")])
        self.assertIn("no-full-format", [a["kind"] for a in res["alerts"]])

    def test_missing_required_key_is_an_error(self):
        with self.assertRaises(ValueError):
            run(self.root, [{"id": "M1", "tier": "M"}])


def cli(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = sel.main(list(argv))
    return rc, out.getvalue(), err.getvalue()


class Cli(Base):
    def test_list_input_prints_json(self):
        put_lesson(self.root, "ml-lessons/d.md", "d")
        path = self.root / "items.json"
        path.write_text(json.dumps([item("M1", "M")]))
        rc, out, _ = cli("--repo", REPO, "--in", str(path), "--root", str(self.root))
        data = json.loads(out)
        self.assertEqual(rc, 0)
        self.assertEqual(sorted(data), ["alerts", "bodies", "collapsed_line", "findings", "lessons_applied",
                                        "lessons_shadow", "protected"])
        self.assertEqual(data["findings"][0]["tier"], "I")

    def test_wrapper_carries_pr_and_review_id_for_the_protect_list(self):
        put_lesson(self.root, "ml-lessons/d.md", "d")
        (self.root / "repo-lessons").mkdir(exist_ok=True)
        (self.root / "repo-lessons" / "_protect.json").write_text(json.dumps(
            {"findings": [{"repo": REPO, "pr": 7, "title": "Same title here"}]}))
        path = self.root / "items.json"
        path.write_text(json.dumps({"pr": 7, "findings": [item("M1", "M", title="Same title here")]}))
        rc, out, _ = cli("--repo", REPO, "--in", str(path), "--root", str(self.root))
        self.assertEqual(json.loads(out)["findings"][0]["tier"], "M")
        rc, out, _ = cli("--repo", REPO, "--in", str(path), "--root", str(self.root), "--pr", "8")
        self.assertEqual(json.loads(out)["findings"][0]["tier"], "I")

    def test_bad_input_exits_1(self):
        path = self.root / "items.json"
        path.write_text('{"nope": 1}')
        rc, _, err = cli("--repo", REPO, "--in", str(path), "--root", str(self.root))
        self.assertEqual(rc, 1)
        self.assertIn("findings", err)

    def test_nothing_is_written(self):
        put_lesson(self.root, "ml-lessons/d.md", "d")
        path = self.root / "items.json"
        path.write_text(json.dumps([item("M1", "M")]))
        before = sorted(p.name for p in self.root.rglob("*"))
        cli("--repo", REPO, "--in", str(path), "--root", str(self.root))
        self.assertEqual(sorted(p.name for p in self.root.rglob("*")), before)


class ShadowMode(Base):
    def test_output_is_static_and_effects_are_only_logged(self):
        put_lesson(self.root, "ml-lessons/d.md", "d", body="Body line.")
        items = [item("M1", "M", 1), item("I1", "I", 2)]
        res = run(self.root, items, shadow=True)
        self.assertEqual([(f["id"], f["tier"], f["rank"], f["shown_as"], f["lessons"], f["collapsed"], f["form"])
                          for f in res["findings"]],
                         [("M1", "M", 1, "normal", [], False, None), ("I1", "I", 2, "normal", [], False, None)])
        self.assertEqual((res["collapsed_line"], res["lessons_applied"], res["bodies"]), ("", [], ""))
        self.assertEqual(res["lessons_shadow"], [rec("d", "M1"), rec("d", "I1", frm="I", to="collapsed")])

    def test_live_mode_is_unchanged_by_the_flag_default(self):
        put_lesson(self.root, "ml-lessons/d.md", "d")
        res = run(self.root, [item("M1", "M")])
        self.assertEqual((by_id(res)["M1"]["tier"], res["lessons_applied"], res["lessons_shadow"]), ("I", ["d"], []))

    def test_exploration_is_off_so_every_trigger_is_recorded(self):
        put_lesson(self.root, "ml-lessons/d.md", "d")
        items = [item(f"M{n}", "M", n) for n in range(1, 6)]
        live = by_id(run(self.root, items))
        self.assertIn("explore", [f["shown_as"] for f in live.values()])
        res = run(self.root, items, shadow=True)
        self.assertEqual([r["finding"] for r in res["lessons_shadow"]], ["M1", "M2", "M3", "M4", "M5"])

    def test_approved_effects_use_the_category_floor(self):
        put_lesson(self.root, "ml-lessons/dq.md", "dq", tier_in=["Q"], category="domain-assumption")
        items = [item(f"Q{n}", "Q", n, category="domain-assumption") for n in (1, 2, 3)]
        res = run(self.root, items, shadow=True)
        self.assertEqual([(r["finding"], r["to"]) for r in res["lessons_shadow"]],
                         [("Q2", "collapsed"), ("Q3", "collapsed")])

    def test_never_suppress_items_have_no_record(self):
        put_lesson(self.root, "ml-lessons/d.md", "d")
        res = run(self.root, [item("M1", "M", protect=["security"])], shadow=True)
        self.assertEqual(res["lessons_shadow"], [])

    def test_action_forms_are_recorded(self):
        put_lesson(self.root, "ml-lessons/cap.md", "cap", action="cap_full:2", tier_in=["M"])
        put_lesson(self.root, "ml-lessons/rf.md", "rf", action="rank_first", category="concurrency")
        put_lesson(self.root, "ml-lessons/pr.md", "pr", action="promote", tier_in=["I"])
        items = [item("M1", "M", 1), item("M2", "M", 2), item("M3", "M", 3), item("I1", "I", 4),
                 item("M4", "M", 5, category="concurrency")]
        recs = run(self.root, items, shadow=True)["lessons_shadow"]
        self.assertEqual(recs, [rec("cap", "M3", "cap_full:2"), rec("pr", "I1", "promote", "I", "M"),
                                rec("cap", "M4", "cap_full:2"), rec("rf", "M4", "rank_first", "M", "M")])

    def test_candidates_run_through_the_composed_pipeline(self):
        put_lesson(self.root, "ml-lessons/a.md", "a")
        put_lesson(self.root, "ml-lessons/c.md", "c", status="candidate")
        res = run(self.root, [item("M1", "M")], shadow=True)
        # one step max: the candidate lands where the approved lesson already puts the item, not on collapsed
        self.assertEqual(res["lessons_shadow"], [rec("a", "M1"), rec("c", "M1", status="candidate")])

    def test_candidates_see_the_floor(self):
        put_lesson(self.root, "ml-lessons/c.md", "c", status="candidate", tier_in=["Q"], category="domain-assumption")
        items = [item(f"Q{n}", "Q", n, category="domain-assumption") for n in (1, 2, 3)]
        res = run(self.root, items, shadow=True)
        self.assertEqual([(r["finding"], r["from"], r["to"], r["status"]) for r in res["lessons_shadow"]],
                         [("Q2", "Q", "collapsed", "candidate"), ("Q3", "Q", "collapsed", "candidate")])

    def test_live_mode_records_candidates_only(self):
        put_lesson(self.root, "ml-lessons/a.md", "a")
        put_lesson(self.root, "ml-lessons/c.md", "c", status="candidate")
        res = run(self.root, [item("M1", "M")])
        self.assertEqual(res["lessons_shadow"], [rec("c", "M1", status="candidate")])

    def test_cli_flag(self):
        put_lesson(self.root, "ml-lessons/d.md", "d")
        path = self.root / "items.json"
        path.write_text(json.dumps([item("M1", "M")]))
        rc, out, _ = cli("--repo", REPO, "--in", str(path), "--root", str(self.root), "--shadow")
        data = json.loads(out)
        self.assertEqual((rc, data["findings"][0]["tier"], data["lessons_applied"], data["collapsed_line"]), (0, "M", [], ""))
        self.assertEqual(data["lessons_shadow"], [rec("d", "M1")])

    def test_shadow_output_becomes_a_valid_report(self):
        put_lesson(self.root, "ml-lessons/d.md", "d")
        put_lesson(self.root, "ml-lessons/c.md", "c", status="candidate", action="question_form", kind="presentation")
        items = [item("M1", "M", 1), item("I1", "I", 2)]
        res = run(self.root, items, shadow=True)
        by = {i["id"]: i for i in items}
        findings = [{"id": f["id"], "lens": by[f["id"]]["lens"], "lens_sev": ["MED"], "tier": f["tier"],
                     "category": by[f["id"]]["category"], "code_kind": "prod", "premise": "in-diff", "kind": "finding",
                     "location": {"path": "src/A.java", "lines": "1-2"}, "title": by[f["id"]]["title"],
                     "rank": f["rank"], "shown_as": f["shown_as"], "lessons": f["lessons"]} for f in res["findings"]]
        meta = {"host": "github.example.com", "org": "acme", "repo": REPO, "pr": 5, "branch": None,
                "base_sha": "1a2b3c4", "head_sha": "9f8e7d6", "date": "2026-02-01T08:00:00Z", "context_prs": [],
                "diff_stats": {"files": 1, "additions": 2, "deletions": 0}, "verdict": "NEEDS WORK",
                "findings": findings, "lessons_mode": "shadow", "lessons_applied": res["lessons_applied"],
                "lessons_shadow": res["lessons_shadow"]}
        fm = store.build_frontmatter(meta, 1, "0123abcd", {n: "11111111" for n in store.LENSES})
        self.assertEqual([r["to"] for r in fm["lessons_shadow"]], ["I", "collapsed", "M", "I"])
        self.assertEqual(store.validate_report(fm, "M1 I1\n", store.taxonomy()), [])


if __name__ == "__main__":
    unittest.main()
