"""Unit tests for scripts/tally.py: Beta math, outcome derivation, cells, lesson evidence, proposals.

Synthetic ledgers only (fake repos like acme-widget-svc). Literal expected values, no mocks.

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

import store  # noqa: E402
import tally  # noqa: E402

TODAY = "2026-02-01"
CAT, KIND, PREM, TIER = "correctness-scenario", "prod", "in-diff", "M"
TRIGGER = {"category": CAT, "code_kind": KIND, "premise": PREM, "tier_in": [TIER], "pattern": None}


# --- builders ----------------------------------------------------------------

def finding(fid, tier=TIER, category=CAT, code_kind=KIND, premise=PREM, path="src/a.py", rank=1,
            title="a title", shown_as="normal", lessons=None):
    return {"id": fid, "lens": ["qa-adversary"], "lens_sev": ["HIGH"], "tier": tier, "category": category,
            "code_kind": code_kind, "premise": premise, "kind": "finding",
            "location": {"path": path, "lines": "1-2"}, "title": title, "rank": rank,
            "shown_as": shown_as, "lessons": lessons or []}


def outcome(fid, kind="not-posted", reason=None):
    posted = kind in ("posted", "partial")
    return {"id": fid, "outcome": kind, "form": "assertion" if posted else None,
            "comment_ids": [1] if posted else [], "match": "auto", "reason": reason}


def make_report(root, repo, pr, rnd, day, findings, outcomes, this_pr_only=None, applied=None, mode=None,
                harvested=True, shadow=None):
    pr_ref = store.pr_ref(pr, None)
    fm = {
        "review_id": store.review_id("h.example", "acme", repo, pr_ref, rnd),
        "repo": repo, "pr": pr, "round": rnd, "branch": None,
        "date": f"2026-01-{day:02d}T10:00:00Z",
        "lessons_applied": applied or [], "lessons_shadow": shadow or [],
        "findings": findings,
        "feedback": {"harvested_at": "2026-01-30T10:00:00Z", "outcomes": outcomes,
                     "recall_misses": [], "this_pr_only": this_pr_only or [], "wiki_proposals": []},
    }
    if mode:
        fm["lessons_mode"] = mode
    if not harvested:
        del fm["feedback"]
    path = Path(root) / "reviews" / repo / f"pr{pr}-r{rnd}-2026-01-{day:02d}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(store.render_report(fm, "body\n"), encoding="utf-8")
    return path


def make_cell_report(root, repo, pr, day, kind, rnd=1):
    """One report with a cell finding; 'ignored' adds a posted lower-ranked anchor so it counts as seen."""
    cell = finding("M1", rank=1)
    if kind == "posted":
        return make_report(root, repo, pr, rnd, day, [cell], [outcome("M1", "posted")])
    anchor = finding("I1", tier="I", category="naming-docs-style", path="src/z.py", rank=2)
    return make_report(root, repo, pr, rnd, day, [cell, anchor],
                       [outcome("M1"), outcome("I1", "posted")])


def make_lesson(root, lid, scope="ml", repo="*", **over):
    fm = {"id": lid, "kind": "precision", "category": CAT, "trigger": dict(TRIGGER), "claim": "c",
          "action": "demote", "provenance": "seeded", "status": "candidate", "created": "2026-01-01",
          "repo": repo, "window": 20}
    fm.update(over)
    d = Path(root) / ("ml-lessons" if scope == "ml" else f"repo-lessons/{repo}")
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{lid}.md"
    path.write_text(store.render_report(fm, "one line body\n"), encoding="utf-8")
    return path


def run_all(root, **kw):
    reports = tally.select_reports(tally.load_reports(root), kw.pop("only", None), kw.pop("exclude", None))
    obs = tally.all_observations(reports)
    lessons = tally.load_lessons(root)
    return reports, obs, lessons, tally.propose(root, reports, obs, lessons, today=TODAY,
                                                lens_shas=kw.pop("lens_shas", {}))


def ops(result, op):
    return [p for p in result["proposals"] if p["op"] == op]


class TmpRoot(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)


# --- Beta math ---------------------------------------------------------------

class BetaMath(TmpRoot):
    def test_tail_oracles(self):
        # prior Beta(1,4): alpha = 1 + accepted, beta = 4 + ignored; threshold P(p > 0.15)
        for acc, ign, want in [(0, 8, 0.1422), (1, 9, 0.3567), (1, 14, 0.1985), (2, 23, 0.1684)]:
            with self.subTest(acc=acc, ign=ign):
                self.assertAlmostEqual(tally.beta_tail(1 + acc, 4 + ign), want, places=4)

    def test_threshold_decisions(self):
        passes = lambda acc, ign: tally.beta_tail(1 + acc, 4 + ign) <= 0.15
        self.assertTrue(passes(0, 8))
        self.assertFalse(passes(1, 9))
        self.assertFalse(passes(1, 14))
        self.assertFalse(passes(2, 23))  # 2/25 FAILS: owner keeps the threshold as is

    def test_mean(self):
        self.assertEqual(tally.beta_mean(1, 4), 0.2)
        self.assertEqual(tally.beta_mean(4, 4), 0.5)

    def test_fractional_counts(self):
        # a partial weighs 0.5 in both alpha and beta; the tail stays a probability
        v = tally.beta_tail(1.5, 4.5)
        self.assertTrue(0.0 < v < 1.0)

    def test_posterior_counts(self):
        self.assertEqual(tally.posterior_counts(2, 1, 3), (1 + 2 + 0.5, 4 + 3 + 0.5))
        self.assertEqual(tally.posterior_counts(0, 0, 0, prior=(2.0, 3.0)), (2.0, 3.0))


# --- outcome derivation ------------------------------------------------------

def states(root, repo="acme-widget-svc", pr=1):
    reports = tally.load_reports(root)
    obs = [o for r in reports if r["repo"] == repo and r["pr_key"] == str(pr) for o in tally.observations(r)]
    return {o["id"]: o["state"] for o in obs}


class OutcomeDerivation(TmpRoot):
    def test_posted_and_partial(self):
        make_report(self.root, "acme-widget-svc", 1, 1, 5,
                    [finding("M1", rank=1), finding("M2", rank=2, path="b")],
                    [outcome("M1", "posted"), outcome("M2", "partial")])
        self.assertEqual(states(self.root), {"M1": "accepted", "M2": "partial"})

    def test_not_posted_seen_when_same_file_comment(self):
        make_report(self.root, "acme-widget-svc", 1, 1, 5,
                    [finding("M1", rank=2), finding("M2", rank=1, path="src/a.py")],
                    [outcome("M1"), outcome("M2", "posted")])
        # M2 (rank 1, same file) was commented: M1 was seen
        self.assertEqual(states(self.root)["M1"], "ignored_seen")

    def test_not_posted_seen_when_lower_ranked_comment(self):
        make_report(self.root, "acme-widget-svc", 1, 1, 5,
                    [finding("M1", rank=1, path="x"), finding("M2", rank=3, path="y")],
                    [outcome("M1"), outcome("M2", "posted")])
        self.assertEqual(states(self.root)["M1"], "ignored_seen")

    def test_not_posted_unseen_when_only_higher_ranked_other_file_comment(self):
        make_report(self.root, "acme-widget-svc", 1, 1, 5,
                    [finding("M1", rank=1, path="x"), finding("M2", rank=2, path="y")],
                    [outcome("M1", "posted"), outcome("M2")])
        self.assertEqual(states(self.root)["M2"], "unseen")

    def test_nothing_posted_all_unseen(self):
        make_report(self.root, "acme-widget-svc", 1, 1, 5,
                    [finding("M1", rank=1), finding("M2", rank=2)], [outcome("M1"), outcome("M2")])
        self.assertEqual(states(self.root), {"M1": "unseen", "M2": "unseen"})

    def test_excluded_outcomes(self):
        make_report(self.root, "acme-widget-svc", 1, 1, 5,
                    [finding("M1", rank=1), finding("M2", rank=2), finding("M3", rank=3)],
                    [outcome("M1", "changed-after"), outcome("M2", "superseded"), outcome("M3", "unseen")])
        self.assertEqual(states(self.root), {"M1": "excluded", "M2": "excluded", "M3": "unseen"})

    def test_demoted_excluded_explore_counts(self):
        make_report(self.root, "acme-widget-svc", 1, 1, 5,
                    [finding("M1", rank=1, shown_as="demoted"), finding("M2", rank=2, shown_as="explore")],
                    [outcome("M1", "posted"), outcome("M2", "posted")])
        self.assertEqual(states(self.root), {"M1": "excluded", "M2": "accepted"})

    def test_reasons(self):
        make_report(self.root, "acme-widget-svc", 1, 1, 5,
                    [finding("M1", rank=1, path="x"), finding("M2", rank=2, path="y"),
                     finding("M3", rank=3, path="z"), finding("M4", rank=4, path="w")],
                    [outcome("M1", reason="didnt-read"), outcome("M2", reason="wrong"),
                     outcome("M3", reason="this-pr-only"), outcome("M4", "posted")])
        got = states(self.root)
        self.assertEqual(got["M1"], "unseen")        # didn't read: unseen even if later items were commented
        self.assertEqual(got["M2"], "ignored_seen")  # explicit "wrong": the reviewer read it
        self.assertEqual(got["M3"], "excluded")      # this-pr-only never counts

    def test_this_pr_only_list_excludes_even_posted(self):
        make_report(self.root, "acme-widget-svc", 1, 1, 5, [finding("M1")], [outcome("M1", "posted")],
                    this_pr_only=["M1"])
        self.assertEqual(states(self.root), {"M1": "excluded"})

    def test_fyi_and_observation_tiers_excluded(self):
        make_report(self.root, "acme-widget-svc", 1, 1, 5,
                    [finding("F1", tier="F"), finding("O1", tier="O", rank=2)],
                    [outcome("F1", "posted"), outcome("O1", "posted")])
        self.assertEqual(states(self.root), {"F1": "excluded", "O1": "excluded"})

    def test_report_without_feedback_has_no_observations(self):
        path = make_report(self.root, "acme-widget-svc", 1, 1, 5, [finding("M1")], [outcome("M1")])
        fm, body = store.split_report(path.read_text())
        del fm["feedback"]
        path.write_text(store.render_report(fm, body))
        self.assertEqual(tally.all_observations(tally.load_reports(self.root)), [])

    def test_tf_code_kind_follows_ledger(self):
        make_report(self.root, "acme-widget-svc", 1, 1, 5,
                    [finding("M1", code_kind="prod", path="infra/main.tf")], [outcome("M1", "posted")])
        obs = tally.all_observations(tally.load_reports(self.root))
        self.assertEqual(obs[0]["code_kind"], "prod")  # never rewritten from the extension


# --- selection / exclusion ---------------------------------------------------

class Selection(TmpRoot):
    def setUp(self):
        super().setUp()
        for repo, pr, rnd in [("acme-widget-svc", 1, 1), ("acme-widget-svc", 1, 2), ("acme-gadget", 7, 1)]:
            make_report(self.root, repo, pr, rnd, 5, [finding("M1")], [outcome("M1", "posted")])

    def ids(self, **kw):
        reports = tally.select_reports(tally.load_reports(self.root), **kw)
        return sorted(f"{r['repo']}/pr{r['pr_key']}-r{r['fm']['round']}" for r in reports)

    def test_exclude_by_repo_stem(self):
        self.assertEqual(self.ids(exclude=["acme-widget-svc/pr1-r1"]),
                         ["acme-gadget/pr7-r1", "acme-widget-svc/pr1-r2"])

    def test_exclude_by_pr_all_rounds(self):
        self.assertEqual(self.ids(exclude=["acme-widget-svc#1"]), ["acme-gadget/pr7-r1"])

    def test_exclude_by_review_id_and_md_path(self):
        rid = store.review_id("h.example", "acme", "acme-gadget", 7, 1)
        self.assertEqual(self.ids(exclude=[rid, "acme-widget-svc/pr1-r2-2026-01-05.md"]),
                         ["acme-widget-svc/pr1-r1"])

    def test_stem_prefix_does_not_match_longer_pr_number(self):
        make_report(self.root, "acme-widget-svc", 10, 1, 5, [finding("M1")], [outcome("M1", "posted")])
        self.assertIn("acme-widget-svc/pr10-r1", self.ids(exclude=["acme-widget-svc/pr1"]))

    def test_only(self):
        self.assertEqual(self.ids(only=["acme-gadget#7"]), ["acme-gadget/pr7-r1"])

    def test_exclude_file_read(self):
        meta = self.root / "reviews" / "_meta"
        meta.mkdir(parents=True, exist_ok=True)
        (meta / "tally_exclude.json").write_text(json.dumps(["acme-gadget/pr7-r1"]))
        self.assertEqual(tally.read_exclude_file(self.root), ["acme-gadget/pr7-r1"])

    def test_exclude_file_missing_is_empty(self):
        self.assertEqual(tally.read_exclude_file(self.root / "nope"), [])

    def test_parse_ids(self):
        self.assertEqual(tally.parse_ids("a, b,,c"), ["a", "b", "c"])
        self.assertEqual(tally.parse_ids(None), None)


# --- cell table --------------------------------------------------------------

class CellTable(TmpRoot):
    def test_counts_beta_and_prs(self):
        make_cell_report(self.root, "acme-widget-svc", 1, 3, "posted")
        make_cell_report(self.root, "acme-widget-svc", 2, 4, "ignored")
        make_cell_report(self.root, "acme-gadget", 3, 5, "ignored")
        make_report(self.root, "acme-gadget", 4, 1, 6, [finding("M1", rank=1), finding("M2", rank=2, path="q")],
                    [outcome("M1"), outcome("M2")])  # nothing posted: unseen
        rows = {(r["category"], r["tier"]): r for r in tally.cell_table(tally.all_observations(tally.load_reports(self.root)))}
        r = rows[(CAT, "M")]
        self.assertEqual((r["accepted"], r["partial"], r["ignored_seen"], r["unseen"]), (1, 0, 2, 2))
        self.assertEqual((r["prs"], r["repos"]), (3, 2))
        self.assertEqual((r["alpha"], r["beta"]), (2, 6))
        self.assertEqual(r["mean"], 0.25)
        self.assertAlmostEqual(r["p_gt_015"], tally.beta_tail(2, 6), places=6)

    def test_partial_weighs_half(self):
        make_report(self.root, "acme-widget-svc", 1, 1, 3, [finding("M1")], [outcome("M1", "partial")])
        r = tally.cell_table(tally.all_observations(tally.load_reports(self.root)))[0]
        self.assertEqual((r["alpha"], r["beta"]), (1.5, 4.5))

    def test_excluded_only_cells_are_omitted(self):
        make_report(self.root, "acme-widget-svc", 1, 1, 3, [finding("M1")], [outcome("M1", "changed-after")])
        self.assertEqual(tally.cell_table(tally.all_observations(tally.load_reports(self.root))), [])

    def test_summary_counts(self):
        make_cell_report(self.root, "acme-widget-svc", 1, 3, "ignored")
        s = tally.summarize(tally.all_observations(tally.load_reports(self.root)))
        self.assertEqual(s["state"], {"accepted": 1, "ignored_seen": 1})
        self.assertEqual(s["raw"], {"not-posted": 1, "posted": 1})


# --- lesson evidence ---------------------------------------------------------

class LessonEvidence(TmpRoot):
    def test_trigger_matching(self):
        o = {"category": CAT, "code_kind": KIND, "premise": PREM, "tier": "M", "title": "Rollback plan missing"}
        self.assertTrue(tally.trigger_matches(TRIGGER, o))
        self.assertTrue(tally.trigger_matches({"category": None, "code_kind": None, "premise": None,
                                               "tier_in": [], "pattern": "rollback"}, o))
        self.assertFalse(tally.trigger_matches({**TRIGGER, "tier_in": ["I"]}, o))
        self.assertFalse(tally.trigger_matches({**TRIGGER, "pattern": "^queue"}, o))
        self.assertFalse(tally.trigger_matches({**TRIGGER, "code_kind": "test"}, o))

    def test_window_keeps_last_20_counted_observations(self):
        for i in range(25):  # 5 early posted, 20 later ignored
            make_cell_report(self.root, "acme-widget-svc", i + 1, 1 + i if i < 28 else 28,
                             "posted" if i < 5 else "ignored")
        reports = tally.load_reports(self.root)
        lesson = {"trigger": TRIGGER, "repo": "*"}
        ev = tally.lesson_evidence(lesson, tally.all_observations(reports))
        self.assertEqual((ev["accepted"], ev["ignored_seen"], ev["n"]), (0, 20, 20))
        self.assertEqual(len(ev["refs"]), 20)
        self.assertTrue(all(r.startswith("rv-") and "#M1" in r for r in ev["refs"]))

    def test_repo_scope_filters(self):
        make_cell_report(self.root, "acme-widget-svc", 1, 3, "posted")
        make_cell_report(self.root, "acme-gadget", 2, 4, "posted")
        obs = tally.all_observations(tally.load_reports(self.root))
        self.assertEqual(tally.lesson_evidence({"trigger": TRIGGER, "repo": "acme-gadget"}, obs)["n"], 1)
        self.assertEqual(tally.lesson_evidence({"trigger": TRIGGER, "repo": "*"}, obs)["n"], 2)

    def test_derived_fields(self):
        make_report(self.root, "acme-widget-svc", 1, 1, 3, [finding("M1")], [outcome("M1", "posted")],
                    applied=["L1"])
        for pr, day, kind in [(2, 4, "demoted"), (3, 5, "demoted"), (4, 6, "explore"), (5, 7, "demoted")]:
            make_report(self.root, "acme-widget-svc", pr, 1, day,
                        [finding("M1", shown_as=kind, lessons=["L1"])], [outcome("M1")])
        d = tally.derived_fields({"id": "L1", "trigger": TRIGGER, "repo": "*"}, tally.load_reports(self.root))
        self.assertEqual(d["last_used"], "2026-01-03")
        self.assertEqual(d["last_triggered"], "2026-01-07")
        self.assertEqual(d["triggers_since_explore"], 1)  # one demotion since the explore at day 6

    def test_derived_fields_null_when_never_seen(self):
        d = tally.derived_fields({"id": "L9", "trigger": TRIGGER, "repo": "*"}, [])
        self.assertEqual(d, {"last_used": None, "last_triggered": None, "triggers_since_explore": 0})


# --- proposals ---------------------------------------------------------------

class ProposalsAdd(TmpRoot):
    def cells(self, n, kind, prs=None):
        for i in range(n):
            make_cell_report(self.root, "acme-widget-svc", (prs or [i + 1] * n)[i], 3 + i, kind,
                             rnd=1 + (i if prs else 0))

    def target_adds(self, result):
        return [p for p in ops(result, "ADD") if p["frontmatter"]["category"] == CAT]

    def test_add_demote_for_ignored_cell(self):
        self.cells(4, "ignored")  # 0/4: P = 0.85^8 = 0.2725 <= 0.30
        *_, res = run_all(self.root)
        (add,) = self.target_adds(res)
        self.assertEqual(add["frontmatter"]["action"], "demote")
        self.assertEqual(add["frontmatter"]["status"], "candidate")
        self.assertEqual(add["frontmatter"]["provenance"], "observed")
        self.assertEqual(add["frontmatter"]["trigger"]["tier_in"], ["M"])
        self.assertEqual(add["path"], "ml-lessons/correctness-scenario-prod-in-diff-m.md")

    def test_no_add_at_three_ignored(self):
        self.cells(3, "ignored")  # 0/3: P = 0.85^7 = 0.3206 > 0.30
        *_, res = run_all(self.root)
        self.assertEqual(self.target_adds(res), [])

    def test_add_boost_for_accepted_cell(self):
        self.cells(3, "posted")  # mean 4/8 = 0.5
        *_, res = run_all(self.root)
        (add,) = self.target_adds(res)
        self.assertEqual(add["frontmatter"]["action"], "rank_first")

    def test_no_add_from_a_single_pr(self):
        self.cells(4, "ignored", prs=[1, 1, 1, 1])  # four rounds of one PR
        *_, res = run_all(self.root)
        self.assertEqual(self.target_adds(res), [])

    def test_no_add_when_cell_is_covered(self):
        self.cells(4, "ignored")
        make_lesson(self.root, "covered")
        *_, res = run_all(self.root)
        self.assertEqual(self.target_adds(res), [])

    def test_pattern_lesson_does_not_cover_the_cell(self):
        self.cells(4, "ignored")
        make_lesson(self.root, "narrow", trigger={**TRIGGER, "pattern": "rollback"})
        *_, res = run_all(self.root)
        self.assertEqual(len(self.target_adds(res)), 1)

    def test_retired_lesson_does_not_cover(self):
        self.cells(4, "ignored")
        make_lesson(self.root, "old", status="retired")
        *_, res = run_all(self.root)
        self.assertEqual(len(self.target_adds(res)), 1)

    def test_add_at_cap_pairs_with_retirement(self):
        self.cells(4, "ignored")
        for i in range(25):
            make_lesson(self.root, f"fill{i:02d}", trigger={"category": "naming-docs-style", "code_kind": "dev-tool",
                                                           "premise": "1-hop", "tier_in": ["T"], "pattern": f"p{i}"},
                        status="approved")
        *_, res = run_all(self.root)
        (add,) = self.target_adds(res)
        self.assertEqual(len(add["requires"]), 1)
        paired = [p for p in res["proposals"] if p["id"] == add["requires"][0]][0]
        self.assertEqual(paired["op"], "DELETE")

    def test_add_under_cap_needs_no_pairing(self):
        self.cells(4, "ignored")
        *_, res = run_all(self.root)
        self.assertEqual(self.target_adds(res)[0]["requires"], [])


class ProposalsLessons(TmpRoot):
    def ignored_in_repos(self, n, repos=("acme-a", "acme-b", "acme-c"), kind="ignored"):
        for i in range(n):
            make_cell_report(self.root, repos[i % len(repos)], i + 1, 3 + i, kind)

    def update_for(self, res, lid):
        return [p for p in ops(res, "UPDATE") if lid in [t["target"] for t in p["changes"]]]

    def test_promote_demote_lesson(self):
        self.ignored_in_repos(8)  # 0/8 in 3 repos: P = 0.1422
        make_lesson(self.root, "dem")
        *_, res = run_all(self.root)
        (p,) = [x for x in self.update_for(res, "dem") if "status" in x["changes"][0]["diff"]]
        self.assertEqual(p["changes"][0]["diff"]["status"], {"before": "candidate", "after": "approved"})

    def test_no_promote_with_seven_obs(self):
        self.ignored_in_repos(7)
        make_lesson(self.root, "dem")
        *_, res = run_all(self.root)
        self.assertFalse([x for x in self.update_for(res, "dem") if "status" in x["changes"][0]["diff"]])

    def test_no_promote_with_two_repos(self):
        self.ignored_in_repos(8, repos=("acme-a", "acme-b"))
        make_lesson(self.root, "dem")
        *_, res = run_all(self.root)
        self.assertFalse([x for x in self.update_for(res, "dem") if "status" in x["changes"][0]["diff"]])

    def test_repo_lesson_promotes_with_four_obs_and_two_prs(self):
        for i in range(4):
            make_cell_report(self.root, "acme-a", i + 1, 3 + i, "ignored")
        make_lesson(self.root, "rdem", scope="repo", repo="acme-a")
        *_, res = run_all(self.root)
        self.assertTrue([x for x in self.update_for(res, "rdem") if "status" in x["changes"][0]["diff"]])

    def test_promote_boost_lesson(self):
        for i in range(5):
            make_cell_report(self.root, "acme-a", i + 1, 3 + i, "posted")
        make_lesson(self.root, "boost", action="rank_first")
        *_, res = run_all(self.root)
        self.assertTrue([x for x in self.update_for(res, "boost") if "status" in x["changes"][0]["diff"]])

    def test_stated_lesson_is_not_auto_promoted(self):
        self.ignored_in_repos(8)
        make_lesson(self.root, "fact", provenance="stated")
        *_, res = run_all(self.root)
        self.assertFalse([x for x in self.update_for(res, "fact") if "status" in x["changes"][0]["diff"]])

    def test_repo_prior_is_rescaled_ml_posterior(self):
        for got, want in zip(tally.rescaled_prior(0, 8), (5 / 13, 60 / 13)):
            self.assertAlmostEqual(got, want, places=9)
        for got, want in zip(tally.rescaled_prior(0, 0), (1.0, 4.0)):
            self.assertAlmostEqual(got, want, places=9)

    def test_retire_when_p_above_040(self):
        for i in range(8):
            make_cell_report(self.root, "acme-a", i + 1, 3 + i, "posted" if i < 4 else "ignored")
        make_lesson(self.root, "bad", status="approved")
        *_, res = run_all(self.root)
        self.assertEqual([d["target"] for d in ops(res, "DELETE")], ["bad"])

    def test_no_retire_below_minimum_observations(self):
        make_cell_report(self.root, "acme-a", 1, 3, "posted")
        make_lesson(self.root, "young", status="approved")  # prior alone gives P = 0.52 > 0.40
        *_, res = run_all(self.root)
        self.assertEqual(ops(res, "DELETE"), [])

    def test_boost_lesson_never_retired_on_p(self):
        for i in range(8):
            make_cell_report(self.root, "acme-a", i + 1, 3 + i, "posted" if i < 4 else "ignored")
        make_lesson(self.root, "boost", status="approved", action="rank_first")
        *_, res = run_all(self.root)
        self.assertEqual(ops(res, "DELETE"), [])

    def test_regret_proposes_narrowing_first(self):
        make_report(self.root, "acme-a", 1, 1, 3, [finding("M1", shown_as="demoted", lessons=["reg"])],
                    [outcome("M1", "posted")])
        make_lesson(self.root, "reg", status="approved")
        *_, res = run_all(self.root)
        (p,) = [x for x in self.update_for(res, "reg") if "regret_refs" in x["changes"][0]["diff"]]
        self.assertEqual(p["changes"][0]["diff"]["regret_refs"]["after"], [f"rv-{store.review_id('h.example', 'acme', 'acme-a', 1, 1)}#M1"])
        self.assertEqual(ops(res, "DELETE"), [])

    def test_codified_regret_is_an_alert_not_a_retirement(self):
        make_report(self.root, "acme-a", 1, 1, 3, [finding("M1", shown_as="demoted", lessons=["cod"])],
                    [outcome("M1", "posted")])
        make_lesson(self.root, "cod", status="codified")
        *_, res = run_all(self.root)
        self.assertEqual(ops(res, "DELETE"), [])
        self.assertIn("regret", [a["kind"] for a in res["alerts"] if a["lesson"] == "cod"])

    def test_stale_by_age(self):
        make_lesson(self.root, "old", status="approved", last_confirmed="2025-01-01", created="2025-01-01")
        *_, res = run_all(self.root)
        self.assertTrue([x for x in self.update_for(res, "old") if x["changes"][0]["diff"].get("stale")])

    def test_stale_by_review_count(self):
        for i in range(31):
            make_report(self.root, "acme-a", i + 1, 1, 1 + i, [finding("I1", tier="I", category="naming-docs-style")],
                        [outcome("I1")])
        make_lesson(self.root, "idle", status="approved", last_confirmed="2026-01-01")
        *_, res = run_all(self.root)
        self.assertTrue([x for x in self.update_for(res, "idle") if x["changes"][0]["diff"].get("stale")])

    def test_fresh_lesson_not_stale(self):
        make_lesson(self.root, "fresh", status="approved", last_confirmed="2026-01-20")
        *_, res = run_all(self.root)
        self.assertFalse([x for x in self.update_for(res, "fresh") if x["changes"][0]["diff"].get("stale")])

    def test_lens_sha_mismatch_flags_recheck(self):
        make_lesson(self.root, "lv", status="approved", validated_with={"qa-adversary": "aaaaaaaa"})
        *_, res = run_all(self.root, lens_shas={"qa-adversary": "bbbbbbbb"})
        self.assertTrue([x for x in self.update_for(res, "lv") if x["changes"][0]["diff"].get("recheck")])

    def test_lens_sha_match_is_quiet(self):
        make_lesson(self.root, "lv", status="approved", validated_with={"qa-adversary": "aaaaaaaa"})
        *_, res = run_all(self.root, lens_shas={"qa-adversary": "aaaaaaaa"})
        self.assertFalse([x for x in self.update_for(res, "lv") if x["changes"][0]["diff"].get("recheck")])

    def test_count_only_updates_are_batched(self):
        make_cell_report(self.root, "acme-a", 1, 3, "posted")
        make_lesson(self.root, "one", status="approved")
        make_lesson(self.root, "two", status="approved", trigger={**TRIGGER, "tier_in": ["M", "B"]})
        *_, res = run_all(self.root)
        batches = [p for p in ops(res, "UPDATE") if len(p["changes"]) == 2]
        self.assertEqual(len(batches), 1)
        self.assertEqual(sorted(c["target"] for c in batches[0]["changes"]), ["one", "two"])
        self.assertEqual(set(batches[0]["changes"][0]["diff"]) - {"last_triggered", "last_used", "triggers_since_explore", "confidence"},
                         {"evidence", "posterior"})

    def test_noop_when_nothing_changes(self):
        make_lesson(self.root, "calm", status="approved", last_confirmed="2026-01-20")
        r1 = run_all(self.root)[-1]
        # apply the batch, then a second tally has nothing to change
        batch = [p for p in ops(r1, "UPDATE")]
        data = {"proposals": r1["proposals"]}
        tally.apply_proposals(self.root, data, [p["id"] for p in batch])
        res = run_all(self.root)[-1]
        self.assertEqual([p["op"] for p in res["proposals"] if p["op"] != "NOOP"], [])
        self.assertEqual([p["target"] for p in ops(res, "NOOP")], ["calm"])

    def test_recall_lesson_gets_no_counts(self):
        make_lesson(self.root, "rec", kind="recall", status="approved", last_confirmed="2026-01-20")
        *_, res = run_all(self.root)
        self.assertEqual([p["target"] for p in ops(res, "NOOP")], ["rec"])

    # The alert targets suppression by lessons: 5 consecutive reviews where the category shows no full item
    # AND a lesson moved it (shown_as demoted, or a shadow record `from` B/M, i.e. the would-be collapse).
    # A plain drought (or a naturally G/Q/I/T category) is not a self-confirming loop, so it stays silent.
    def _streak(self, tiers, cat="naming-docs-style", shadow_first=False, **kw):
        for i, tier in enumerate(tiers):
            rec = [{"lesson": "d1", "status": "candidate", "finding": "X1", "action": "demote",
                    "from": "M", "to": "I"}] if shadow_first and i == 0 else []
            make_report(self.root, "acme-a", i + 1, 1, 3 + i, [finding("X1", tier=tier, category=cat, **kw)],
                        [outcome("X1")], shadow=rec)
        *_, res = run_all(self.root)
        return [a for a in res["alerts"] if a["kind"] == "no-full-format"]

    def test_no_alert_for_a_category_that_never_showed_a_full_item(self):
        # was: fired on 5 I-only reviews; a naturally I/G/Q/T category can never be B/M (noise)
        self.assertEqual(self._streak(["I"] * 5), [])

    def test_no_alert_for_a_plain_drought_without_lessons(self):
        # was: any 5 reviews without B/M fired; with no lesson involved nothing is being suppressed
        self.assertEqual(self._streak(["M"] + ["I"] * 5), [])

    def test_alert_when_a_lesson_demotion_caused_the_collapse(self):
        alerts = self._streak(["I"] * 5, shown_as="demoted")
        self.assertEqual([(a["category"], a["streak"], a["demoted_involved"]) for a in alerts],
                         [("naming-docs-style", 5, True)])

    def test_alert_when_a_shadow_record_shows_a_would_be_collapse(self):
        self.assertEqual(len(self._streak(["I"] * 5, shadow_first=True)), 1)

    def test_no_alert_when_a_full_item_is_inside_the_streak(self):
        self.assertEqual(self._streak(["M", "I", "I", "M", "I", "I", "I", "I"], shadow_first=True), [])


# --- apply -------------------------------------------------------------------

class Apply(TmpRoot):
    def setUp(self):
        super().setUp()
        for i in range(4):
            make_cell_report(self.root, "acme-a", i + 1, 3 + i, "ignored")
        self.lesson = make_lesson(self.root, "dem", status="approved", trigger={**TRIGGER, "tier_in": ["B"]})
        self.res = run_all(self.root)[-1]
        self.data = json.loads(json.dumps({"proposals": self.res["proposals"]}))

    def test_writes_only_approved_ids(self):
        adds = [p for p in ops(self.data, "ADD") if p["frontmatter"]["category"] == CAT]
        self.assertEqual(len(adds), 1)
        before = self.lesson.read_text()
        written = tally.apply_proposals(self.root, self.data, [adds[0]["id"]])
        self.assertEqual([Path(w).name for w in written], ["correctness-scenario-prod-in-diff-m.md"])
        self.assertEqual(self.lesson.read_text(), before)
        fm, body = store.split_report((self.root / adds[0]["path"]).read_text())
        self.assertEqual((fm["status"], fm["provenance"]), ("candidate", "observed"))
        self.assertEqual(fm["evidence"]["ignored_seen"], 4)
        self.assertEqual(len(body.strip().splitlines()), 1)

    def test_update_changes_only_listed_fields_and_keeps_body(self):
        batch = [p for p in ops(self.data, "UPDATE")][0]
        tally.apply_proposals(self.root, self.data, [batch["id"]])
        fm, body = store.split_report(self.lesson.read_text())
        self.assertIn("evidence", fm)
        self.assertEqual(fm["status"], "approved")
        self.assertEqual(body, "one line body\n")

    def test_delete_marks_retired_and_keeps_file(self):
        data = {"proposals": [{"id": 1, "op": "DELETE", "target": "dem", "path": "ml-lessons/dem.md",
                               "changes": [], "requires": []}]}
        tally.apply_proposals(self.root, data, [1])
        fm, _ = store.split_report(self.lesson.read_text())
        self.assertEqual(fm["status"], "retired")

    def test_add_refuses_without_its_paired_retirement(self):
        data = {"proposals": [
            {"id": 1, "op": "DELETE", "target": "dem", "path": "ml-lessons/dem.md", "changes": [], "requires": []},
            {"id": 2, "op": "ADD", "target": "new", "path": "ml-lessons/new.md", "requires": [1],
             "frontmatter": {"id": "new", "status": "candidate"}, "body": "x\n"}]}
        with self.assertRaises(ValueError):
            tally.apply_proposals(self.root, data, [2])
        self.assertFalse((self.root / "ml-lessons" / "new.md").exists())
        tally.apply_proposals(self.root, data, [1, 2])
        self.assertTrue((self.root / "ml-lessons" / "new.md").exists())

    def test_stale_proposal_is_rejected(self):
        batch = [p for p in ops(self.data, "UPDATE")][0]
        fm, body = store.split_report(self.lesson.read_text())
        fm["status"] = "candidate"
        fm["evidence"] = {"accepted": 9, "partial": 0, "ignored_seen": 0, "unseen": 0, "repos_n": 1, "refs": []}
        self.lesson.write_text(store.render_report(fm, body))
        with self.assertRaises(ValueError):
            tally.apply_proposals(self.root, self.data, [batch["id"]])

    def test_unknown_id_is_rejected(self):
        with self.assertRaises(ValueError):
            tally.apply_proposals(self.root, self.data, [999])

    def test_add_refuses_to_overwrite_existing_file(self):
        add = [p for p in ops(self.data, "ADD") if p["frontmatter"]["category"] == CAT][0]
        tally.apply_proposals(self.root, self.data, [add["id"]])
        with self.assertRaises(ValueError):
            tally.apply_proposals(self.root, self.data, [add["id"]])


# --- CLI ---------------------------------------------------------------------

def cli(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = tally.main(list(argv))
    return rc, out.getvalue(), err.getvalue()


class Cli(TmpRoot):
    def setUp(self):
        super().setUp()
        for i in range(4):
            make_cell_report(self.root, "acme-a", i + 1, 3 + i, "ignored")

    def test_works_without_lesson_dirs(self):
        self.assertFalse((self.root / "ml-lessons").exists())
        rc, out, _ = cli("--root", str(self.root), "--today", TODAY)
        self.assertEqual(rc, 0)
        self.assertIn("correctness-scenario", out)
        self.assertIn("ADD", out)

    def test_json_output_and_apply_roundtrip(self):
        rc, out, _ = cli("--root", str(self.root), "--today", TODAY, "--json")
        self.assertEqual(rc, 0)
        data = json.loads(out)
        self.assertEqual({"summary", "cells", "lessons", "proposals", "alerts"} - set(data), set())
        add = [p for p in data["proposals"] if p["op"] == "ADD" and p["frontmatter"]["category"] == CAT][0]
        pfile = self.root / "proposals.json"
        pfile.write_text(out)
        rc, out, _ = cli("--root", str(self.root), "--apply", str(pfile), "--approved", str(add["id"]))
        self.assertEqual(rc, 0)
        self.assertTrue((self.root / add["path"]).is_file())

    def test_exclude_flag(self):
        rc, out, _ = cli("--root", str(self.root), "--today", TODAY, "--json",
                         "--exclude-reviews", "acme-a#1,acme-a#2,acme-a#3,acme-a#4")
        self.assertEqual(json.loads(out)["cells"], [])

    def test_only_and_exclude_are_exclusive(self):
        with self.assertRaises(SystemExit):
            cli("--root", str(self.root), "--only-reviews", "a", "--exclude-reviews", "b")

    def test_exclude_file_is_applied(self):
        meta = self.root / "reviews" / "_meta"
        meta.mkdir(parents=True, exist_ok=True)
        (meta / "tally_exclude.json").write_text(json.dumps(["acme-a#1", "acme-a#2", "acme-a#3", "acme-a#4"]))
        rc, out, _ = cli("--root", str(self.root), "--today", TODAY, "--json")
        self.assertEqual(json.loads(out)["cells"], [])

    def test_apply_without_approved_is_an_error(self):
        with self.assertRaises(SystemExit):
            cli("--root", str(self.root), "--apply", "x.json")

    def test_apply_error_exits_1(self):
        pfile = self.root / "p.json"
        pfile.write_text(json.dumps({"proposals": []}))
        rc, _, err = cli("--root", str(self.root), "--apply", str(pfile), "--approved", "5")
        self.assertEqual(rc, 1)
        self.assertIn("5", err)


class ShadowCount(TmpRoot):
    def reports(self, **kw):
        return tally.select_reports(tally.load_reports(self.root), **kw)

    def shadow(self, repo, pr, rnd, day, **kw):
        make_report(self.root, repo, pr, rnd, day, [finding("M1")], [outcome("M1")], mode="shadow", **kw)

    def test_distinct_prs_not_rounds(self):
        self.shadow("acme-a", 1, 1, 3)
        self.shadow("acme-a", 1, 2, 4)
        self.shadow("acme-b", 1, 1, 5)
        self.assertEqual(tally.shadow_counts(self.reports()), (2, 2))

    def test_only_shadow_mode_counts(self):
        self.shadow("acme-a", 1, 1, 3)
        make_report(self.root, "acme-a", 2, 1, 4, [finding("M1")], [outcome("M1")])
        make_report(self.root, "acme-a", 3, 1, 5, [finding("M1")], [outcome("M1")], mode="live")
        self.assertEqual(tally.shadow_counts(self.reports()), (1, 1))

    def test_harvested_is_the_subset_with_feedback(self):
        self.shadow("acme-a", 1, 1, 3, harvested=False)
        self.shadow("acme-a", 2, 1, 4)
        self.shadow("acme-a", 3, 1, 5, harvested=False)
        self.shadow("acme-a", 3, 2, 6)
        self.assertEqual(tally.shadow_counts(self.reports()), (3, 2))

    def test_excluded_prs_are_not_counted(self):
        self.shadow("acme-a", 1, 1, 3)
        self.shadow("acme-a", 2, 1, 4)
        self.assertEqual(tally.shadow_counts(self.reports(exclude=["acme-a#1"])), (1, 1))

    def test_pr_selector_excludes_a_future_round(self):
        self.shadow("acme-a", 1, 1, 3)
        self.shadow("acme-a", 1, 4, 9)
        self.shadow("acme-a", 10, 1, 9)
        names = [r["stem"] for r in self.reports(exclude=["acme-a#1"])]
        self.assertEqual(names, ["pr10-r1-2026-01-09"])

    def test_printed_line_and_summary(self):
        self.shadow("acme-a", 1, 1, 3, harvested=False)
        self.shadow("acme-a", 2, 1, 4)
        rc, out, _ = cli("--root", str(self.root), "--today", TODAY)
        self.assertEqual(rc, 0)
        self.assertIn("Shadow reviews: 2/6 (harvested 1)\n", out)
        rc, out, _ = cli("--root", str(self.root), "--today", TODAY, "--json")
        s = json.loads(out)["summary"]
        self.assertEqual((s["shadow_reviews"], s["shadow_harvested"]), (2, 1))


if __name__ == "__main__":
    unittest.main()
