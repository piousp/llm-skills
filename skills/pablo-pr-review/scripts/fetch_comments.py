#!/usr/bin/env python3
"""Fetch the user's own comments on a PR (stdlib only; shells out to `gh`).

    fetch_comments.py <pr_url> [--login L] [--since ISO] [--report PATH] [--out PATH]
    fetch_comments.py <pr_url> --all-authors [--report PATH] [--out PATH]

The PR URL is `https://<host>/<org>/<repo>/pull/<n>`; host, org and repo come from it and
nothing is defaulted. `--login` defaults to the authenticated user on that host. `--since`
defaults to the report's `date` when `--report` is given: comments created before it are
marked `pre_skill`. With `--report`, `candidates` lists which findings each inline comment may
match, by location only; the semantic judgment stays with the coordinator (learning-loop.md).
"""

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store  # noqa: E402

PR_URL_RE = re.compile(r"^https?://([^/\s]+)/([^/\s]+)/([^/\s]+)/pull/(\d+)/?(?:[?#].*)?$")
LINE_TOLERANCE = 3
INLINE_KEYS = ("id path line original_line original_commit_id commit_id diff_hunk body "
               "created_at in_reply_to_id").split()
REVIEW_KEYS = ("id state body submitted_at commit_id").split()
ISSUE_KEYS = ("id body created_at").split()


# --- pure functions ---------------------------------------------------------

def parse_pr_url(url):
    """`https://host/org/repo/pull/N` -> {host, org, repo, number}; ValueError otherwise."""
    m = PR_URL_RE.match(url.strip())
    if not m:
        raise ValueError(f"not a PR URL (expected https://<host>/<org>/<repo>/pull/<n>): {url!r}")
    host, org, repo, number = m.groups()
    return {"host": host, "org": org, "repo": repo, "number": int(number)}


def filter_login(items, login):
    """Keep only the items authored by `login` (case-insensitive)."""
    want = login.casefold()
    return [i for i in items if ((i.get("user") or {}).get("login") or "").casefold() == want]


def _parse_ts(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def mark_pre_skill(comments, since):
    """Copy each comment with `pre_skill` = created before `since` (always False without `since`)."""
    cutoff = _parse_ts(since) if since else None
    return [
        {**c, "pre_skill": bool(cutoff and c.get("created_at") and _parse_ts(c["created_at"]) < cutoff)}
        for c in comments
    ]


def cited_ranges(lines):
    """'41-47, 60' -> [(41, 47), (60, 60)]; ints or text accepted."""
    if isinstance(lines, int):
        return [(lines, lines)]
    ranges = []
    for a, b in re.findall(r"(\d+)(?:\s*-\s*(\d+))?", str(lines or "")):
        lo, hi = int(a), int(b or a)
        ranges.append((min(lo, hi), max(lo, hi)))
    return ranges


def path_matches(comment_path, finding_path):
    """Equal, or the finding path is a suffix of the comment path after '/' (basename locations)."""
    if not comment_path or not finding_path:
        return False
    return comment_path == finding_path or comment_path.endswith("/" + finding_path)


def _same_commit(comment_sha, report_sha):
    if not comment_sha or not report_sha:
        return False
    a, b = comment_sha.lower(), report_sha.lower()
    return a.startswith(b) or b.startswith(a)


def location_candidates(comments, findings, head_sha):
    """Location-only match of inline comments to findings.

    One entry {comment_id, finding_ids, basis} per (comment, basis). `same-commit-line`: the comment
    was made on `head_sha` and its original_line is within a cited range +-3. Everything else on a
    matching path is `path-only-needs-hunk` (the coordinator compares diff_hunk).
    """
    out = []
    for c in comments:
        by_basis = {"same-commit-line": [], "path-only-needs-hunk": []}
        for f in findings:
            loc = f.get("location") or {}
            if not path_matches(c.get("path"), loc.get("path")):
                continue
            line = c.get("original_line")
            near = line is not None and any(
                lo - LINE_TOLERANCE <= line <= hi + LINE_TOLERANCE for lo, hi in cited_ranges(loc.get("lines"))
            )
            same = near and _same_commit(c.get("original_commit_id"), head_sha)
            by_basis["same-commit-line" if same else "path-only-needs-hunk"].append(f["id"])
        for basis, ids in by_basis.items():
            if ids:
                out.append({"comment_id": c["id"], "finding_ids": ids, "basis": basis})
    return out


THREADS_QUERY = (
    "query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){pullRequest(number:$n){"
    "reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{isResolved isOutdated "
    "comments(first:100){nodes{databaseId}}}}}}}"
)


def thread_states(pages):
    """GraphQL reviewThreads pages -> {comment databaseId: {resolved, outdated}} (every comment of a thread)."""
    states = {}
    for page in pages:
        threads = (((((page.get("data") or {}).get("repository") or {}).get("pullRequest") or {})
                    .get("reviewThreads")) or {}).get("nodes") or []
        for t in threads:
            for c in (t.get("comments") or {}).get("nodes") or []:
                states[c["databaseId"]] = {"resolved": bool(t.get("isResolved")), "outdated": bool(t.get("isOutdated"))}
    return states


def comment_status(comment, states):
    """`resolved` (thread resolved) > `outdated` (thread outdated, or no current line) > `open`."""
    st = states.get(comment.get("id")) or {}
    if st.get("resolved"):
        return "resolved"
    if st.get("outdated") or comment.get("line") is None:
        return "outdated"
    return "open"


def _with_author(item, keys, status=None):
    out = {**_pick(item, keys), "author": (item.get("user") or {}).get("login"), "link": item.get("html_url")}
    if status is not None:
        out["status"] = status
    return out


def build_all_authors_output(pr, fetched_at, inline, reviews, issue, pr_obj, states, report_fm=None):
    """Like build_output, but every author, with author/link, and a status on each inline comment.

    `states` is thread_states(...) output, or None when the GraphQL query failed (no `resolved`).
    """
    known = states or {}
    mine_inline = [_with_author(c, INLINE_KEYS, comment_status(c, known)) for c in inline]
    out = {
        "pr": {**pr, "state": pr_obj.get("state"), "merged_at": pr_obj.get("merged_at"),
               "head_sha": (pr_obj.get("head") or {}).get("sha")},
        "fetched_at": fetched_at,
        "resolved_state": states is not None,
        "inline": mine_inline,
        "reviews": [_with_author(r, REVIEW_KEYS) for r in reviews],
        "issue": [_with_author(i, ISSUE_KEYS) for i in issue],
    }
    if report_fm is not None:
        out["candidates"] = location_candidates(
            mine_inline, report_fm.get("findings") or [], report_fm.get("head_sha") or out["pr"]["head_sha"]
        )
    return out


def _pick(item, keys):
    return {k: item.get(k) for k in keys}


def build_output(pr, login, fetched_at, inline, reviews, issue, pr_obj, since, report_fm=None):
    """Assemble the output JSON from already-fetched raw API payloads."""
    mine_inline = mark_pre_skill([_pick(c, INLINE_KEYS) for c in filter_login(inline, login)], since)
    out = {
        "pr": {**pr, "state": pr_obj.get("state"), "merged_at": pr_obj.get("merged_at"),
               "head_sha": (pr_obj.get("head") or {}).get("sha")},
        "login": login,
        "fetched_at": fetched_at,
        "inline": mine_inline,
        "reviews": [_pick(r, REVIEW_KEYS) for r in filter_login(reviews, login)],
        "issue": [_pick(i, ISSUE_KEYS) for i in filter_login(issue, login)],
    }
    if report_fm is not None:
        out["candidates"] = location_candidates(
            mine_inline, report_fm.get("findings") or [], report_fm.get("head_sha") or out["pr"]["head_sha"]
        )
    return out


# --- gh IO ------------------------------------------------------------------

def gh_api(host, endpoint, paginate=True):
    """Run `gh api` and return the flattened JSON (pages concatenated; a single object stays one)."""
    cmd = ["gh", "api", "--hostname", host]
    cmd += ["--paginate", "--slurp", endpoint] if paginate else [endpoint]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"gh api {endpoint} failed: {res.stderr.strip()}")
    data = json.loads(res.stdout)
    if not paginate:
        return data
    flat = []
    for page in data:
        flat.extend(page) if isinstance(page, list) else flat.append(page)
    return flat


def gh_threads(host, pr):
    """All reviewThreads pages of the PR via `gh api graphql` (read-only query)."""
    pages, after = [], None
    while True:
        cmd = ["gh", "api", "--hostname", host, "graphql", "-f", f"query={THREADS_QUERY}", "-F", f"o={pr['org']}",
               "-F", f"r={pr['repo']}", "-F", f"n={pr['number']}"]
        if after:
            cmd += ["-F", f"after={after}"]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            raise RuntimeError(f"gh graphql reviewThreads failed: {res.stderr.strip()}")
        page = json.loads(res.stdout)
        pages.append(page)
        info = ((((page.get("data") or {}).get("repository") or {}).get("pullRequest") or {})
                .get("reviewThreads") or {}).get("pageInfo") or {}
        if not info.get("hasNextPage"):
            return pages
        after = info.get("endCursor")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pr_url")
    ap.add_argument("--login")
    ap.add_argument("--since", help="ISO timestamp; comments created before it are pre_skill")
    ap.add_argument("--report", help="review report; enables candidates and the default --since")
    ap.add_argument("--out", help="write JSON here instead of stdout")
    ap.add_argument("--all-authors", action="store_true",
                    help="every author, with author/link/status per comment (ignores --login and --since)")
    a = ap.parse_args(argv)
    try:
        pr = parse_pr_url(a.pr_url)
        report_fm = store.split_report(Path(a.report).read_text(encoding="utf-8"))[0] if a.report else None
        since = a.since or (report_fm or {}).get("date")
        host, base = pr["host"], f"repos/{pr['org']}/{pr['repo']}"
        n = pr["number"]
        if a.all_authors:
            try:
                states = thread_states(gh_threads(host, pr))
            except (RuntimeError, ValueError, OSError):
                states = None
            out = build_all_authors_output(
                pr, dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                gh_api(host, f"{base}/pulls/{n}/comments"),
                gh_api(host, f"{base}/pulls/{n}/reviews"),
                gh_api(host, f"{base}/issues/{n}/comments"),
                gh_api(host, f"{base}/pulls/{n}", paginate=False),
                states, report_fm,
            )
            return _emit(out, a.out)
        login = a.login or subprocess.run(
            ["gh", "api", "--hostname", host, "user", "-q", ".login"], capture_output=True, text=True, check=True
        ).stdout.strip()
        out = build_output(
            pr, login, dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            gh_api(host, f"{base}/pulls/{n}/comments"),
            gh_api(host, f"{base}/pulls/{n}/reviews"),
            gh_api(host, f"{base}/issues/{n}/comments"),
            gh_api(host, f"{base}/pulls/{n}", paginate=False),
            since, report_fm,
        )
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as e:
        print(e, file=sys.stderr)
        return 1
    return _emit(out, a.out)


def _emit(out, path):
    text = json.dumps(out, indent=2, ensure_ascii=False) + "\n"
    if path:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
