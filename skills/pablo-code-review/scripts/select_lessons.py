#!/usr/bin/env python3
"""Merge-time lesson selection for pablo-code-review (stdlib + PyYAML). Deterministic; writes nothing.

    select_lessons.py --repo R --in items.json [--root DIR] [--pr N] [--shadow] > decisions.json

items.json is a list of merged items, or {"pr": N, "review_id": "...", "findings": [...]}. An item has
id, tier, rank, category, code_kind, premise, title, optional lens[] and protect[] (set by the
coordinator: security, data-loss, credentials, asked, static) and optional assertion_loosened.

Output: {findings:[{id,tier,rank,shown_as,form,lessons,collapsed}], collapsed_line, lessons_applied,
lessons_shadow (records {lesson,status,finding,action,from,to}), bodies (<=150 lines), alerts}. Rules:
references/learning-loop.md (Merge-time application): approved lessons only (candidates are recorded in
lessons_shadow; codified, retired and recall lessons never apply), at most ONE demotion step,
never-suppress items untouched, every 4th trigger of a demote lesson is shown at its original tier
(`explore`, no marker).
--shadow: the approved effects are computed (explore off, floor on) but NOT rendered: findings come back
with their input tier/rank/id, shown_as normal, no lessons, no collapsed line, lessons_applied [];
lessons_shadow then also holds the approved lessons' would-be effects.
"""

import argparse
import difflib
import json
import re
import sys
from pathlib import Path

import store
import tally

SKILL_DIR = store.SKILL_DIR
PROTECT_FILE = Path("repo-lessons") / "_protect.json"
LEVELS = ("repo", "org", "ml")  # precedence: repo-lessons, then _org, then ml-lessons
CAPS = {"repo": 10, "org": 10, "ml": 15}
TIER_ORDER = {t: i for i, t in enumerate("BMQIGTOF")}
STEP_DOWN = {"B": "M", "M": "I"}  # every other demotable tier is collapsed
DEMOTABLE = frozenset("BMQIGT")
EXPLORE_EVERY = 4
MAX_BODY_LINES = 150
SIMILARITY = 0.8
COLLAPSED_PREFIX = "Demoted by lessons: "
REQUIRED = ("id", "tier", "rank")


# --- lessons -----------------------------------------------------------------------

def level_of(lesson):
    if lesson["scope"] == "ml":
        return "ml"
    return "org" if Path(lesson["rel"]).parts[1] == "_org" else "repo"


def parse_action(action):
    """'cap_full:3' -> ('cap_full', 3); anything else -> (action, None)."""
    name, _, n = str(action or "").partition(":")
    return name, (int(n) if n.isdigit() else None)


def _pool(lessons, repo, status, capped=True):
    """Lessons of `status` that apply to `repo`, in precedence order (repo, _org, ml; then id).
    Returns (kept, ids dropped by the per-level caps)."""
    mine = [l for l in lessons
            if l["fm"].get("status") == status and l["fm"].get("kind") != "recall"
            and tally._in_scope(l["fm"], repo)]
    mine.sort(key=lambda l: (LEVELS.index(level_of(l)), l["id"]))
    kept, dropped, used = [], [], {k: 0 for k in LEVELS}
    for l in mine:
        lv = level_of(l)
        if capped and used[lv] >= CAPS[lv]:
            dropped.append(l["id"])
            continue
        used[lv] += 1
        kept.append(l)
    return kept, dropped


# --- never-suppress ------------------------------------------------------------------

def _words(text):
    return " ".join(re.findall(r"[a-z0-9]+", (text or "").lower()))


def _similar(a, b):
    return difflib.SequenceMatcher(None, _words(a), _words(b)).ratio() >= SIMILARITY


def load_protect(root):
    path = Path(root) / PROTECT_FILE
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def never_suppress(item, repo, pr, review_id, cfg):
    """Reason string when no lesson may demote this item, else None."""
    protect = item.get("protect") or []
    if item["tier"] == "B" and "qa-adversary" in (item.get("lens") or []):
        return "qa-blocker"
    if item.get("category") == "duplication-reuse":
        return "duplication-reuse"
    if item.get("category") == "type-modelling" and item.get("premise") == "in-diff":
        return "type-modelling-in-diff"
    if item.get("assertion_loosened") or "assertion_loosened" in protect:
        return "assertion-loosened"
    if protect:
        return "coordinator:" + ",".join(protect)
    for e in cfg.get("findings", []):
        if e.get("repo") != repo:
            continue
        if review_id and e.get("review_id") == review_id and e.get("id") == item["id"]:
            return "protect-list"
        if pr is not None and str(e.get("pr")) != str(pr):
            continue
        if _similar(e.get("title"), item.get("title")):
            return "protect-list"
    for e in cfg.get("categories", []):
        if (e.get("repo") == repo and e.get("category") == item.get("category")
                and e.get("premise") in (None, item.get("premise"))):
            return "protect-list"
    return None


# --- wants ---------------------------------------------------------------------------

def matches(trigger, item):
    """tally.trigger_matches plus two optional lens keys: `lens_count` (int, in-memory only: the item must
    carry exactly that many lenses) and `lens_only` (str: the item's only lens is that one)."""
    want = (trigger or {}).get("lens_count")
    if want is not None and len(item.get("lens") or []) != want:
        return False
    only = (trigger or {}).get("lens_only")
    if only is not None and (item.get("lens") or []) != [only]:
        return False
    return tally.trigger_matches(trigger, item)


def collect(pool, items):
    """{item id: [(lesson, kind)]}: what each lesson would do to each matching item (before gates)."""
    wants = {i["id"]: [] for i in items}
    ranked = sorted(items, key=lambda i: i["rank"])
    for lesson in pool:
        name, n = parse_action(lesson["fm"].get("action"))
        hit = [i for i in ranked if matches(lesson["fm"].get("trigger"), i)]
        for pos, i in enumerate(hit):
            if name == "cap_full":
                if n is not None and pos >= n:
                    wants[i["id"]].append((lesson, "demote"))
            elif name in ("demote", "promote", "rank_first", "question_form"):
                wants[i["id"]].append((lesson, name))
    return wants


def effective(item, kind, protected):
    if kind == "demote":
        return item["tier"] in DEMOTABLE and item["id"] not in protected
    if kind == "promote":
        return item["tier"] == "I" and item.get("premise") == "in-diff"
    return True


def demoted_to(tier):
    """One step down: the next tier, or None for 'collapsed into the one line'."""
    return STEP_DOWN.get(tier)


def _ids(pairs, kind):
    return [l["id"] for l, k in pairs if k == kind]


# --- selection -----------------------------------------------------------------------

def select(items, repo, lessons, reports, protect_cfg=None, pr=None, review_id=None, since=None, floor=True,
           explore=True, targets=None, shadow=False):
    """Public entry. Live: `_select` with the approved pool, plus the candidates' would-be effects. `shadow=True`:
    the same effects are computed (explore off, floor on) but not rendered; see the module docstring."""
    kw = {"pr": pr, "review_id": review_id}
    composed = _select(items, repo, _candidates_as_approved(lessons), reports, protect_cfg, floor=True,
                       explore=False, since={}, **kw)
    status = {l["id"]: l["fm"].get("status") for l in lessons}
    records = _records(composed, items, _actions(lessons), {i for i, st in status.items() if st == "candidate"},
                       "candidate")
    if not shadow:
        res = _select(items, repo, lessons, reports, protect_cfg, since=since, floor=floor, explore=explore,
                      targets=targets, **kw)
        return {**res, "lessons_shadow": records}
    res = _select(items, repo, lessons, reports, protect_cfg, floor=True, explore=False, since={}, **kw)
    approved = _records(res, items, _actions(lessons), {i for i, st in status.items() if st == "approved"}, "approved")
    static = [{"id": i["id"], "tier": i["tier"], "rank": i["rank"], "shown_as": "normal", "form": None, "lessons": [],
               "collapsed": False} for i in sorted(items, key=lambda i: i["rank"])]
    by_id = {i["id"]: i for i in items}
    streaks = [a for a in res["alerts"] if a["kind"] != "no-full-format"] + _streaks(reports, static, by_id)
    return {"findings": static, "collapsed_line": "", "lessons_applied": [], "lessons_shadow": approved + records,
            "bodies": "", "alerts": streaks, "protected": res["protected"]}


def _candidates_as_approved(lessons):
    """The lesson set as replay sees it: every candidate treated as approved (in memory only)."""
    return [{**l, "fm": {**l["fm"], "status": "approved"}} if l["fm"].get("status") == "candidate" else l
            for l in lessons]


def _actions(lessons):
    return {l["id"]: str(l["fm"].get("action") or "") for l in lessons}


def _records(res, items, actions, ids, status):
    """Would-be effects diffed from a `_select` result: one record per (item, acting lesson in `ids`)."""
    tier_in = {i["id"]: i["tier"] for i in items}
    rank_in = {i["id"]: i["rank"] for i in items}
    out = []
    for f in sorted(res["findings"], key=lambda f: rank_in[f["id"]]):
        for lid in f["lessons"]:
            if lid not in ids:
                continue
            name, _ = parse_action(actions[lid])
            frm = tier_in[f["id"]]
            moves = name in ("demote", "cap_full", "promote")
            to = ("collapsed" if f["collapsed"] else f["tier"]) if moves else frm
            out.append({"lesson": lid, "status": status, "finding": f["id"], "action": actions[lid], "from": frm, "to": to})
    return out


def _select(items, repo, lessons, reports, protect_cfg=None, pr=None, review_id=None, since=None, floor=True,
            explore=True, targets=None):
    """Pure core. `since` maps lesson id -> triggers since the last exploration; it is read from the
    ledger (`reports`) for lessons it lacks, and updated in place (replay threads it across reviews).
    `floor` (on by default) never collapses the last visible item of a category (the highest-ranked
    collapsed one is restored); `floor=False` is the comparison opt-out. Opt-in: `explore=False` turns the every-4th-trigger exploration off (static rules).
    Opt-in `targets` {lesson id: tier}: a demotion by that lesson lands on that tier instead of one step down."""
    items = [dict(i) for i in items]
    for i in items:
        missing = [k for k in REQUIRED if k not in i]
        if missing:
            raise ValueError(f"item {i.get('id')!r} lacks {', '.join(missing)}")
    cfg = protect_cfg or {}
    protected = {i["id"]: r for i in items if (r := never_suppress(i, repo, pr, review_id, cfg))}
    by_id = {i["id"]: i for i in items}
    pool, dropped = _pool(lessons, repo, "approved")
    wants = collect(pool, items)
    alerts = [{"kind": "cap", "lessons": dropped}] if dropped else []
    since = {} if since is None else since
    for l in pool:
        if explore and parse_action(l["fm"].get("action"))[0] in ("demote", "cap_full"):
            since.setdefault(l["id"], tally.derived_fields({**l["fm"], "id": l["id"]}, reports)["triggers_since_explore"])

    out, acted = {}, []
    for item in sorted(items, key=lambda i: i["rank"]):
        pairs = [(l, k) for l, k in wants[item["id"]] if effective(item, k, protected)]
        conflict = sorted({l["id"] for l, k in pairs if k in ("demote", "promote")}) if (
            _ids(pairs, "demote") and _ids(pairs, "promote")) else []
        if conflict:
            alerts.append({"kind": "conflict", "finding": item["id"], "lessons": conflict})
            pairs = [(l, k) for l, k in pairs if l["id"] not in conflict]
        demoters, promoters = _ids(pairs, "demote"), _ids(pairs, "promote")
        tier, shown, collapsed = item["tier"], "normal", False
        if demoters:
            if explore and any(since[d] + 1 >= EXPLORE_EVERY for d in demoters):
                shown = "explore"
                since.update({d: 0 for d in demoters})
            else:
                if explore:
                    since.update({d: since[d] + 1 for d in demoters})
                shown = "demoted"
                nxt = next((targets[d] for d in demoters if d in (targets or {})), None) or demoted_to(tier)
                tier, collapsed = (nxt, False) if nxt else (tier, True)
        elif promoters:
            tier = "M"
        used = list(dict.fromkeys(l["id"] for l, _ in pairs))
        out[item["id"]] = {"id": item["id"], "tier": tier, "shown_as": shown, "collapsed": collapsed,
                           "form": "question" if _ids(pairs, "question_form") else None, "lessons": used,
                           "_first": bool(_ids(pairs, "rank_first")), "_rank": item["rank"]}

    if floor:
        _apply_floor(out, by_id)
    acted = [x for iid in sorted(out, key=lambda k: out[k]["_rank"]) for x in out[iid]["lessons"]]
    ordered = sorted(out.values(), key=lambda f: (f["collapsed"], TIER_ORDER.get(f["tier"], 99), not f["_first"], f["_rank"]))
    for pos, f in enumerate(ordered, 1):
        f["rank"] = pos
        del f["_first"], f["_rank"]
    ids = [f["id"] for f in ordered if f["collapsed"]]
    why = list(dict.fromkeys(x for f in ordered if f["collapsed"] for x in f["lessons"]))
    applied = list(dict.fromkeys(acted))
    result = {
        "findings": ordered,
        "collapsed_line": f"{COLLAPSED_PREFIX}{', '.join(ids)} ({', '.join(why)})" if ids else "",
        "lessons_applied": applied,
        "lessons_shadow": [],
        "bodies": _bodies([l for l in pool if l["id"] in applied]),
        "alerts": alerts + _streaks(reports, ordered, by_id),
        "protected": protected,
    }
    return result


def _apply_floor(out, by_id):
    """A category whose every item got collapsed keeps its highest-ranked item visible, unmarked."""
    cats = {}
    for f in out.values():
        cats.setdefault(by_id[f["id"]].get("category"), []).append(f)
    for fs in cats.values():
        if any(f["collapsed"] for f in fs) and all(f["collapsed"] for f in fs):
            keep = min(fs, key=lambda f: f["_rank"])
            keep.update(collapsed=False, shown_as="normal", lessons=[])


def _bodies(lessons):
    lines = []
    for l in lessons:
        lines += [f"## {l['id']}"] + l["body"].strip().splitlines()
    if len(lines) > MAX_BODY_LINES:
        lines = lines[:MAX_BODY_LINES - 1] + ["[truncated]"]
    return "\n".join(lines)


def _streaks(reports, findings, by_id):
    """Alert when a category in this review would reach 5 consecutive reviews with no full-format item."""
    now = {"fm": {"findings": [{"category": by_id[f["id"]].get("category"), "tier": f["tier"],
                               "shown_as": f["shown_as"]} for f in findings]}}
    cats = {by_id[f["id"]].get("category") for f in findings}
    return [a for a in tally._streak_alerts(list(reports) + [now]) if a["category"] in cats]


# --- CLI -----------------------------------------------------------------------------

def read_items(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, list):
        return data, {}
    if isinstance(data, dict) and isinstance(data.get("findings"), list):
        return data["findings"], data
    raise ValueError("items file must be a list or an object with a findings list")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--in", dest="infile", required=True, help="merged items JSON")
    ap.add_argument("--root", default=SKILL_DIR, help="directory holding reviews/, ml-lessons/, repo-lessons/")
    ap.add_argument("--pr", help="PR number, when the items file does not carry it")
    ap.add_argument("--no-floor", dest="floor", action="store_false",
                    help="comparison only: allow a category's last visible item to collapse (default: the floor keeps one)")
    ap.add_argument("--shadow", action="store_true",
                    help="shadow mode: compute but do not render the lessons' effects (findings come back unchanged)")
    a = ap.parse_args(argv)
    try:
        items, meta = read_items(a.infile)
        reports = tally.select_reports(tally.load_reports(a.root), None, tally.read_exclude_file(a.root))
        pr = a.pr if a.pr is not None else meta.get("pr")
        result = select(items, a.repo, tally.load_lessons(a.root), reports, load_protect(a.root), pr,
                        meta.get("review_id"), floor=a.floor, shadow=a.shadow)
    except (ValueError, OSError) as e:
        print(e, file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
