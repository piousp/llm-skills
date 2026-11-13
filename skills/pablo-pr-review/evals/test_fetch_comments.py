"""Unit tests for scripts/fetch_comments.py: pure functions on synthetic JSON, no network.

Run: cd pablo-pr-review && python3 -m unittest discover -s evals -p 'test_*.py' -v
"""

import json
import sys
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import fetch_comments as fc  # noqa: E402

HEAD = "9f8e7d6c5b4a"
FINDINGS = [
    {"id": "M1", "location": {"path": "src/main/java/com/acme/widget/RetryPolicy.java", "lines": "41-47"}},
    {"id": "Q1", "location": {"path": "RetryPolicy.java", "lines": "12"}},  # basename location
    {"id": "I1", "location": {"path": "src/main/java/com/acme/widget/Backoff.java", "lines": "20-31"}},
]


def comment(cid, path, original_line, commit=HEAD, created="2026-02-02T10:00:00Z"):
    return {"id": cid, "path": path, "original_line": original_line, "original_commit_id": commit,
            "created_at": created}


class ParsePrUrl(unittest.TestCase):
    def test_literal(self):
        self.assertEqual(
            fc.parse_pr_url("https://github.example.com/acme/widget/pull/42"),
            {"host": "github.example.com", "org": "acme", "repo": "widget", "number": 42},
        )

    def test_trailing_slash_and_fragment(self):
        self.assertEqual(fc.parse_pr_url("https://h.example.com/o/r/pull/7/#issuecomment-1")["number"], 7)

    def test_rejects_non_pr_urls(self):
        for bad in ("https://github.example.com/acme/widget/issues/42", "acme/widget#42", ""):
            with self.assertRaises(ValueError):
                fc.parse_pr_url(bad)


class FilterLogin(unittest.TestCase):
    def test_keeps_only_the_login_and_tolerates_missing_user(self):
        items = [{"id": 1, "user": {"login": "Reviewer1"}}, {"id": 2, "user": {"login": "bot"}}, {"id": 3}]
        self.assertEqual([i["id"] for i in fc.filter_login(items, "reviewer1")], [1])


class MarkPreSkill(unittest.TestCase):
    def test_strictly_before_since_is_pre_skill(self):
        cs = [{"id": 1, "created_at": "2026-02-01T09:59:59Z"},
              {"id": 2, "created_at": "2026-02-01T10:00:00Z"},
              {"id": 3, "created_at": "2026-02-03T00:00:00Z"}]
        got = fc.mark_pre_skill(cs, "2026-02-01T10:00:00Z")
        self.assertEqual([c["pre_skill"] for c in got], [True, False, False])
        self.assertNotIn("pre_skill", cs[0])

    def test_without_since_nothing_is_pre_skill(self):
        self.assertEqual(fc.mark_pre_skill([{"id": 1, "created_at": "2020-01-01T00:00:00Z"}], None)[0]["pre_skill"], False)


class CitedRanges(unittest.TestCase):
    def test_forms(self):
        self.assertEqual(fc.cited_ranges("41-47"), [(41, 47)])
        self.assertEqual(fc.cited_ranges("12, 60-62"), [(12, 12), (60, 62)])
        self.assertEqual(fc.cited_ranges(8), [(8, 8)])


class LocationCandidates(unittest.TestCase):
    def test_same_commit_within_tolerance(self):
        got = fc.location_candidates([comment(1, "src/main/java/com/acme/widget/RetryPolicy.java", 50)], FINDINGS, HEAD)
        self.assertEqual(got[0], {"comment_id": 1, "finding_ids": ["M1"], "basis": "same-commit-line"})
        # Q1 shares the file but cites line 12: path only
        self.assertEqual(got[1], {"comment_id": 1, "finding_ids": ["Q1"], "basis": "path-only-needs-hunk"})

    def test_just_outside_tolerance_is_path_only(self):
        got = fc.location_candidates([comment(1, "src/main/java/com/acme/widget/RetryPolicy.java", 51)], FINDINGS, HEAD)
        self.assertEqual(got, [{"comment_id": 1, "finding_ids": ["M1", "Q1"], "basis": "path-only-needs-hunk"}])

    def test_other_commit_is_path_only_even_on_the_line(self):
        got = fc.location_candidates([comment(1, "src/main/java/com/acme/widget/Backoff.java", 25, commit="0000000")], FINDINGS, HEAD)
        self.assertEqual(got, [{"comment_id": 1, "finding_ids": ["I1"], "basis": "path-only-needs-hunk"}])

    def test_basename_finding_path_matches_full_comment_path(self):
        got = fc.location_candidates([comment(1, "src/main/java/com/acme/widget/RetryPolicy.java", 12)], FINDINGS, HEAD)
        self.assertEqual(got, [
            {"comment_id": 1, "finding_ids": ["Q1"], "basis": "same-commit-line"},
            {"comment_id": 1, "finding_ids": ["M1"], "basis": "path-only-needs-hunk"},
        ])

    def test_suffix_must_start_after_a_slash(self):
        self.assertFalse(fc.path_matches("src/XRetryPolicy.java", "RetryPolicy.java"))

    def test_unrelated_path_and_null_line(self):
        self.assertEqual(fc.location_candidates([comment(1, "README.md", 3)], FINDINGS, HEAD), [])
        got = fc.location_candidates([comment(2, "src/main/java/com/acme/widget/Backoff.java", None)], FINDINGS, HEAD)
        self.assertEqual(got[0]["basis"], "path-only-needs-hunk")

    def test_abbreviated_sha_counts_as_same_commit(self):
        got = fc.location_candidates([comment(1, "src/main/java/com/acme/widget/Backoff.java", 20, commit=HEAD + "0123456789")], FINDINGS, HEAD)
        self.assertEqual(got[0]["basis"], "same-commit-line")


class BuildOutput(unittest.TestCase):
    def test_filters_marks_and_adds_candidates(self):
        pr = {"host": "github.example.com", "org": "acme", "repo": "widget", "number": 42}
        inline = [
            dict(comment(1, "src/main/java/com/acme/widget/Backoff.java", 25), user={"login": "me"}, body="Nice", line=25,
                 commit_id=HEAD, diff_hunk="@@", in_reply_to_id=None),
            dict(comment(2, "src/main/java/com/acme/widget/Backoff.java", 25, created="2026-01-01T00:00:00Z"), user={"login": "me"}),
            dict(comment(3, "src/main/java/com/acme/widget/Backoff.java", 25), user={"login": "other"}),
        ]
        out = fc.build_output(
            pr, "me", "2026-02-03T00:00:00Z", inline,
            [{"id": 9, "user": {"login": "me"}, "state": "COMMENTED", "body": "", "submitted_at": "x", "commit_id": HEAD}],
            [{"id": 8, "user": {"login": "other"}, "body": "b", "created_at": "x"}],
            {"state": "open", "merged_at": None, "head": {"sha": HEAD}},
            "2026-02-01T00:00:00Z", {"head_sha": HEAD, "findings": FINDINGS},
        )
        self.assertEqual([c["id"] for c in out["inline"]], [1, 2])
        self.assertEqual([c["pre_skill"] for c in out["inline"]], [False, True])
        self.assertEqual([r["id"] for r in out["reviews"]], [9])
        self.assertEqual(out["issue"], [])
        self.assertEqual(out["pr"]["head_sha"], HEAD)
        self.assertEqual(out["candidates"][0], {"comment_id": 1, "finding_ids": ["I1"], "basis": "same-commit-line"})

    def test_no_report_means_no_candidates(self):
        out = fc.build_output({"number": 1}, "me", "t", [], [], [], {"head": {}}, None)
        self.assertNotIn("candidates", out)


def page(*threads, has_next=False, cursor="c1"):
    return {"data": {"repository": {"pullRequest": {"reviewThreads": {
        "pageInfo": {"hasNextPage": has_next, "endCursor": cursor},
        "nodes": [{"isResolved": r, "isOutdated": o, "comments": {"nodes": [{"databaseId": i} for i in ids]}}
                  for r, o, ids in threads]}}}}}


class ThreadStates(unittest.TestCase):
    def test_every_comment_of_a_thread_gets_its_state(self):
        got = fc.thread_states([page((True, False, [1, 2]), (False, True, [3]))])
        self.assertEqual(got, {1: {"resolved": True, "outdated": False}, 2: {"resolved": True, "outdated": False},
                               3: {"resolved": False, "outdated": True}})

    def test_empty_or_malformed_pages_give_no_states(self):
        self.assertEqual(fc.thread_states([{}, {"data": None}, page()]), {})


class CommentStatus(unittest.TestCase):
    def test_resolved_wins_then_outdated_then_open(self):
        states = {1: {"resolved": True, "outdated": True}, 2: {"resolved": False, "outdated": True},
                  3: {"resolved": False, "outdated": False}}
        self.assertEqual([fc.comment_status({"id": i, "line": 5}, states) for i in (1, 2, 3)],
                         ["resolved", "outdated", "open"])

    def test_null_line_is_outdated_without_thread_state(self):
        self.assertEqual(fc.comment_status({"id": 9, "line": None}, {}), "outdated")
        self.assertEqual(fc.comment_status({"id": 9, "line": 4}, {}), "open")


class BuildAllAuthorsOutput(unittest.TestCase):
    PR = {"host": "github.example.com", "org": "acme", "repo": "widget", "number": 42}

    def build(self, states):
        inline = [
            dict(comment(1, "src/main/java/com/acme/widget/Backoff.java", 25), user={"login": "other"}, line=25,
                 html_url="https://h/pull/42#discussion_r1", body="b"),
            dict(comment(2, "src/main/java/com/acme/widget/Backoff.java", 25), user={"login": "me"}, line=None,
                 html_url="https://h/pull/42#discussion_r2", body="c"),
        ]
        return fc.build_all_authors_output(
            self.PR, "t", inline,
            [{"id": 9, "user": {"login": "author"}, "state": "COMMENTED", "body": "r", "html_url": "https://h/r9"}],
            [{"id": 8, "user": {"login": "bot"}, "body": "i", "html_url": "https://h/i8"}],
            {"state": "open", "head": {"sha": HEAD}}, states, {"head_sha": HEAD, "findings": FINDINGS})

    def test_keeps_every_author_with_link_and_status(self):
        out = self.build({1: {"resolved": True, "outdated": False}})
        self.assertEqual([(c["author"], c["link"], c["status"]) for c in out["inline"]],
                         [("other", "https://h/pull/42#discussion_r1", "resolved"),
                          ("me", "https://h/pull/42#discussion_r2", "outdated")])
        self.assertEqual((out["reviews"][0]["author"], out["reviews"][0]["link"]), ("author", "https://h/r9"))
        self.assertEqual((out["issue"][0]["author"], out["issue"][0]["link"]), ("bot", "https://h/i8"))
        self.assertTrue(out["resolved_state"])
        self.assertEqual(out["candidates"][0]["comment_id"], 1)

    def test_failed_graphql_degrades_to_open_and_outdated(self):
        out = self.build(None)
        self.assertFalse(out["resolved_state"])
        self.assertEqual([c["status"] for c in out["inline"]], ["open", "outdated"])

    def test_default_output_is_unchanged(self):
        out = fc.build_output({"number": 1}, "me", "t", [dict(comment(1, "a", 1), user={"login": "me"})], [], [], {"head": {}}, None)
        self.assertNotIn("author", out["inline"][0])
        self.assertNotIn("resolved_state", out)


class GhThreads(unittest.TestCase):
    def run_pages(self, outputs):
        results = [mock.Mock(returncode=0, stdout=json.dumps(o), stderr="") for o in outputs]
        with mock.patch.object(fc.subprocess, "run", side_effect=results) as run:
            return fc.gh_threads("h.example.com", {"org": "acme", "repo": "widget", "number": 42}), run

    def test_follows_pagination_cursor(self):
        (pages, run) = self.run_pages([page((False, False, [1]), has_next=True, cursor="abc"), page((True, False, [2]))])
        self.assertEqual(len(pages), 2)
        self.assertNotIn("after=abc", run.call_args_list[0].args[0])
        self.assertIn("after=abc", run.call_args_list[1].args[0])
        self.assertEqual(run.call_args_list[0].args[0][:5], ["gh", "api", "--hostname", "h.example.com", "graphql"])

    def test_gh_failure_raises(self):
        bad = mock.Mock(returncode=1, stdout="", stderr="denied")
        with mock.patch.object(fc.subprocess, "run", return_value=bad):
            with self.assertRaises(RuntimeError):
                fc.gh_threads("h", {"org": "o", "repo": "r", "number": 1})


class MainAllAuthors(unittest.TestCase):
    def test_graphql_failure_still_outputs_without_resolved_state(self):
        def fake_api(host, endpoint, paginate=True):
            return {"state": "open", "head": {"sha": HEAD}} if not paginate else []
        buf = mock.Mock()
        with mock.patch.object(fc, "gh_api", side_effect=fake_api), \
             mock.patch.object(fc, "gh_threads", side_effect=RuntimeError("denied")), \
             mock.patch.object(fc, "_emit", side_effect=lambda out, path: (buf(out), 0)[1]):
            rc = fc.main(["https://h.example.com/acme/widget/pull/42", "--all-authors"])
        self.assertEqual(rc, 0)
        self.assertFalse(buf.call_args.args[0]["resolved_state"])


if __name__ == "__main__":
    unittest.main()
