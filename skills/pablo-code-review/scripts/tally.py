#!/usr/bin/env python3
"""Tally the review ledger into evidence cells, lesson evidence and numbered proposals (stdlib + PyYAML).

    tally.py [--root DIR] [--only-reviews IDS | --exclude-reviews IDS] [--json]
             [--apply proposals.json --approved 1,3]

--root holds reviews/, ml-lessons/ and repo-lessons/ (default: this skill). Without --apply nothing
is written. `--json > proposals.json` saves the proposals; `--apply` then writes ONLY the approved
ids of that file (ids are stable: the same ledger gives the same numbering).

Review selectors (IDS, comma separated): a review_id, `repo/pr12-r1` (a round), `repo#12` (a whole
PR), or a path relative to reviews/ with or without `.md`. `reviews/_meta/tally_exclude.json` is a
JSON list of selectors that are always excluded (test artifacts without owner feedback).

Rules: references/learning-loop.md § Harvest and § Consolidation (Beta prior (1,4), threshold
P(p > 0.15)). Outcomes are derived at tally time from the stored `feedback`.
"""

import argparse
import datetime as dt
import json
import math
import re
import sys
from pathlib import Path

import yaml

import store

SKILL_DIR = store.SKILL_DIR
PRIOR = (1.0, 4.0)
THRESHOLD = 0.15
WINDOW = 20
EXCLUDE_FILE = Path("reviews") / "_meta" / "tally_exclude.json"
COUNTED = ("accepted", "partial", "ignored_seen")
SEEN_REASONS = ("wrong", "not-worth", "business")  # an explicit "why not" means the reviewer read it
SKIPPED_TIERS = ("F", "O")  # FYI lines and observations are never counted
CELL_KEYS = ("category", "code_kind", "premise", "tier")
ML_CAP, REPO_CAP = 25, 10
STALE_DAYS, STALE_REVIEWS = 180, 30
COUNT_ONLY = {"evidence", "posterior", "confidence", "last_used", "last_triggered", "triggers_since_explore"}
LESSON_ORDER = (
    "id kind category trigger claim action never_when evidence posterior confidence provenance source "
    "validated_with status codified_in created approved_at last_confirmed last_used last_triggered "
    "triggers_since_explore window"
).split()
OP_ORDER = ("ADD", "UPDATE", "DELETE", "NOOP")


# --- Beta math -----------------------------------------------------------------

def beta_mean(alpha, beta):
    return alpha / (alpha + beta)


def beta_tail(alpha, beta, x=THRESHOLD, intervals=4000):
    """P(p > x) for p ~ Beta(alpha, beta): Simpson integration of the pdf over [x, 1]."""
    log_c = math.lgamma(alpha + beta) - math.lgamma(alpha) - math.lgamma(beta)

    def pdf(t):
        if t <= 0.0 or t >= 1.0:
            return 0.0
        return math.exp(log_c + (alpha - 1) * math.log(t) + (beta - 1) * math.log1p(-t))

    h = (1.0 - x) / intervals
    odd = sum(pdf(x + i * h) for i in range(1, intervals, 2))
    even = sum(pdf(x + i * h) for i in range(2, intervals, 2))
    return h / 3.0 * (pdf(x) + pdf(1.0) + 4.0 * odd + 2.0 * even)


def posterior_counts(accepted, partial, ignored, prior=PRIOR):
    """A partial weighs 0.5 as accepted and 0.5 as ignored."""
    return prior[0] + accepted + 0.5 * partial, prior[1] + ignored + 0.5 * partial


def rescaled_prior(accepted_eff, ignored_eff):
    """Repo-lesson prior: the pooled posterior (prior (1,4)) rescaled to 5 pseudo-counts."""
    a, b = PRIOR[0] + accepted_eff, PRIOR[1] + ignored_eff
    m = a / (a + b)
    return 5 * m, 5 * (1 - m)


# --- ledger ----------------------------------------------------------------------

def _plain(v):
    """YAML dates -> ISO strings, recursively (lesson files may hold bare dates)."""
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_plain(x) for x in v]
    return v


def parse_ids(text):
    return None if text is None else [s.strip() for s in text.split(",") if s.strip()]


def read_exclude_file(root):
    path = Path(root) / EXCLUDE_FILE
    if not path.is_file():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return [str(x) for x in data] if isinstance(data, list) else []


def load_reports(root):
    """Every report under reviews/<repo>/, oldest first. Unreadable files are skipped."""
    out = []
    for path in sorted((Path(root) / "reviews").glob("*/*.md")):
        if path.parent.name == "_meta":
            continue
        try:
            fm, _ = store.split_report(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            continue
        if not isinstance(fm, dict) or not isinstance(fm.get("findings"), list):
            continue
        pr = fm.get("pr")
        out.append({
            "path": path, "repo": path.parent.name, "stem": path.stem,
            "rel_noext": f"{path.parent.name}/{path.stem}", "fm": _plain(fm),
            "pr_key": str(pr) if pr is not None else f"branch:{fm.get('branch')}",
            "date": str(_plain(fm.get("date")) or ""), "review_id": str(fm.get("review_id")),
            "round": fm.get("round") or 1,
        })
    out.sort(key=lambda r: (r["date"], r["repo"], r["pr_key"], r["round"]))
    return out


def selector_matches(report, selector):
    sel = selector.strip()
    if sel.endswith(".md"):
        sel = sel[:-3]
    if sel == report["review_id"]:
        return True
    if "#" in sel:
        repo, _, pr = sel.partition("#")
        return report["repo"] == repo and report["pr_key"] == pr
    rel = report["rel_noext"]
    return rel == sel or rel.startswith(sel + "-")


def select_reports(reports, only=None, exclude=None):
    if only is not None:
        reports = [r for r in reports if any(selector_matches(r, s) for s in only)]
    if exclude:
        reports = [r for r in reports if not any(selector_matches(r, s) for s in exclude)]
    return reports


SHADOW_TARGET = 6


def shadow_counts(reports):
    """(distinct PRs with a lessons_mode: shadow report, those with feedback harvested); `reports` is already
    filtered by the exclusions. A PR counts once however many rounds it has."""
    prs = {}
    for r in reports:
        if r["fm"].get("lessons_mode") == "shadow":
            key = (r["repo"], r["pr_key"])
            prs[key] = prs.get(key, False) or isinstance(r["fm"].get("feedback"), dict)
    return len(prs), sum(prs.values())


# --- outcome derivation -------------------------------------------------------------

def _seen(finding, commented):
    """Position bias: a not-posted finding was seen if a comment landed on its file or below it."""
    path = (finding.get("location") or {}).get("path")
    return any((c.get("location") or {}).get("path") == path or c.get("rank", 0) > finding.get("rank", 0)
               for c in commented)


def derive_state(finding, outcome, commented, this_pr_only):
    """(state, note) with state in accepted|partial|ignored_seen|unseen|excluded."""
    raw, reason = outcome.get("outcome"), outcome.get("reason")
    if finding.get("id") in this_pr_only or reason == "this-pr-only":
        return "excluded", "this-pr-only"
    if finding.get("tier") in SKIPPED_TIERS:
        return "excluded", "tier"
    if finding.get("shown_as", "normal") not in ("normal", "explore"):
        return "excluded", "demoted"
    if raw == "posted":
        return "accepted", ""
    if raw == "partial":
        return "partial", ""
    if raw in ("changed-after", "superseded"):
        return "excluded", raw
    if raw == "unseen" or reason == "didnt-read":
        return "unseen", reason or ""
    if raw == "not-posted":
        if reason in SEEN_REASONS:
            return "ignored_seen", f"reason:{reason}"
        return ("ignored_seen", "position") if _seen(finding, commented) else ("unseen", "position")
    return "excluded", raw or "no-outcome"


def observations(report):
    """One observation per finding that has a harvested outcome."""
    fm = report["fm"]
    fb = fm.get("feedback")
    if not isinstance(fb, dict):
        return []
    outcomes = {o["id"]: o for o in fb.get("outcomes") or [] if isinstance(o, dict) and "id" in o}
    findings = [f for f in fm["findings"] if isinstance(f, dict)]
    commented = [f for f in findings if outcomes.get(f.get("id"), {}).get("outcome") in ("posted", "partial")]
    this_pr_only = set(fb.get("this_pr_only") or [])
    out = []
    for f in findings:
        o = outcomes.get(f.get("id"))
        if o is None:
            continue
        state, note = derive_state(f, o, commented, this_pr_only)
        out.append({
            "review_id": report["review_id"], "repo": report["repo"], "pr_key": report["pr_key"],
            "date": report["date"], "round": report["round"], "id": f["id"], "rank": f.get("rank", 0),
            "tier": f.get("tier"), "category": f.get("category"), "code_kind": f.get("code_kind"),
            "premise": f.get("premise"), "title": f.get("title") or "", "lens": f.get("lens") or [],
            "shown_as": f.get("shown_as", "normal"), "lessons": f.get("lessons") or [],
            "raw": o.get("outcome"), "state": state, "note": note,
        })
    return out


def all_observations(reports):
    return [o for r in reports for o in observations(r)]


def summarize(obs):
    def count(key):
        c = {}
        for o in obs:
            c[o[key]] = c.get(o[key], 0) + 1
        return c
    return {"observations": len(obs), "raw": count("raw"), "state": count("state")}


# --- cells --------------------------------------------------------------------------

def _stats(rows):
    c = {k: sum(1 for o in rows if o["state"] == k) for k in COUNTED + ("unseen",)}
    seen = [o for o in rows if o["state"] in COUNTED]
    a, b = posterior_counts(c["accepted"], c["partial"], c["ignored_seen"])
    return {
        "accepted": c["accepted"], "partial": c["partial"], "ignored_seen": c["ignored_seen"],
        "unseen": c["unseen"], "n": len(seen),
        "prs": len({(o["repo"], o["pr_key"]) for o in seen}), "repos": len({o["repo"] for o in seen}),
        "alpha": a, "beta": b, "mean": beta_mean(a, b),
        "p_gt_015": beta_tail(a, b) if seen else beta_tail(*PRIOR),
    }


def cell_table(obs):
    cells = {}
    for o in obs:
        if o["state"] != "excluded":
            cells.setdefault(tuple(o[k] for k in CELL_KEYS), []).append(o)
    rows = [{**dict(zip(CELL_KEYS, key)), **_stats(rows)} for key, rows in cells.items()]
    rows.sort(key=lambda r: (-r["n"], -r["unseen"], tuple(str(r[k]) for k in CELL_KEYS)))
    return rows


# --- lessons ------------------------------------------------------------------------

def _wanted(value):
    if value in (None, "", "*", []):
        return None
    return set(value) if isinstance(value, (list, tuple, set)) else {value}


def trigger_matches(trigger, item):
    """`item` needs category, code_kind, premise, tier and title (and lens for `lens_only`); absent trigger fields match anything."""
    trigger = trigger or {}
    for key, field in (("category", "category"), ("code_kind", "code_kind"), ("premise", "premise"),
                       ("tier_in", "tier")):
        want = _wanted(trigger.get(key))
        if want is not None and item.get(field) not in want:
            return False
    only = trigger.get("lens_only")
    if only is not None and (item.get("lens") or []) != [only]:
        return False
    pattern = trigger.get("pattern")
    return not pattern or re.search(pattern, item.get("title") or "", flags=re.I) is not None


def _in_scope(fm, repo):
    return fm.get("repo") in (None, "", "*") or fm.get("repo") == repo


def load_lessons(root):
    out = []
    pairs = [("ml", p) for p in sorted((Path(root) / "ml-lessons").glob("*.md"))]
    pairs += [("repo", p) for p in sorted((Path(root) / "repo-lessons").glob("*/*.md"))]
    for scope, path in pairs:
        try:
            fm, body = store.split_report(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            continue
        if not isinstance(fm, dict):
            continue
        fm = _plain(fm)
        out.append({"path": path, "rel": path.relative_to(root).as_posix(), "fm": fm, "body": body,
                    "scope": scope, "id": str(fm.get("id") or path.stem)})
    return out


def lesson_evidence(lesson, obs, window=WINDOW):
    """Counts over the last `window` counted observations matching the lesson (unseen: all matches)."""
    mine = [o for o in obs if _in_scope(lesson, o["repo"]) and trigger_matches(lesson.get("trigger"), o)]
    counted = [o for o in mine if o["state"] in COUNTED][-window:]
    c = {k: sum(1 for o in counted if o["state"] == k) for k in COUNTED}
    return {
        **c, "unseen": sum(1 for o in mine if o["state"] == "unseen"), "n": len(counted),
        "repos_n": len({o["repo"] for o in counted}),
        "prs_n": len({(o["repo"], o["pr_key"]) for o in counted}),
        "refs": [f"rv-{o['review_id']}#{o['id']}" for o in counted],
    }


def derived_fields(lesson, reports):
    """last_used, last_triggered and triggers_since_explore, from the ledger alone."""
    lid = lesson.get("id")
    used = trig = None
    since = 0
    for r in reports:
        day = r["date"][:10]
        if lid in (r["fm"].get("lessons_applied") or []):
            used = day
        for f in r["fm"]["findings"]:
            if not isinstance(f, dict):
                continue
            if _in_scope(lesson, r["repo"]) and trigger_matches(lesson.get("trigger"), f):
                trig = day
            if lid in (f.get("lessons") or []):
                if f.get("shown_as") == "explore":
                    since = 0
                elif f.get("shown_as") == "demoted":
                    since += 1
    return {"last_used": used, "last_triggered": trig, "triggers_since_explore": since}


def _is_demote(fm):
    action = str(fm.get("action") or "")
    return action == "demote" or action.startswith("cap_full")


def _is_ml(lesson):
    return lesson["scope"] == "ml"


def _posterior(lesson, ev, obs):
    prior = PRIOR
    if lesson["scope"] == "repo" and lesson["fm"].get("repo") not in (None, "", "*"):
        pool = lesson_evidence({**lesson["fm"], "repo": "*"}, obs)
        prior = rescaled_prior(pool["accepted"] + 0.5 * pool["partial"], pool["ignored_seen"] + 0.5 * pool["partial"])
    a, b = posterior_counts(ev["accepted"], ev["partial"], ev["ignored_seen"], prior)
    return prior, a, b, beta_mean(a, b), beta_tail(a, b)


def _confidence(lesson, status, ev, mean, p):
    if status == "candidate":
        return "low"
    if _is_demote(lesson["fm"]):
        level = "high" if p <= 0.05 and ev["repos_n"] >= 3 else "medium" if p <= THRESHOLD else "low"
    else:
        level = "medium" if ev["n"] >= 5 and mean >= 0.35 else "low"
    return "medium" if level == "high" and lesson["fm"].get("provenance") == "seeded" else level


def _min_obs(lesson):
    return (8, 3) if _is_ml(lesson) else (4, 2)  # (observations, PRs)


def _promotes(lesson, ev, mean, p):
    if _is_demote(lesson["fm"]):
        n_min, prs_min = _min_obs(lesson)
        return (ev["n"] >= n_min and ev["prs_n"] >= prs_min and p <= THRESHOLD
                and (not _is_ml(lesson) or ev["repos_n"] >= 3))
    return ev["n"] >= (5 if _is_ml(lesson) else 4) and ev["prs_n"] >= 2 and mean >= 0.35


def _regret_refs(lesson, obs):
    lid = lesson["id"]
    return [f"rv-{o['review_id']}#{o['id']}" for o in obs
            if o["shown_as"] == "demoted" and o["raw"] in ("posted", "partial") and lid in o["lessons"]]


def _stale(fm, derived, reports, today):
    anchors = [d for d in (fm.get("last_confirmed"), derived["last_triggered"], fm.get("created"),
                           fm.get("approved_at")) if d]
    if not anchors:
        return False
    anchor = max(str(a)[:10] for a in anchors)
    age = (dt.date.fromisoformat(today) - dt.date.fromisoformat(anchor)).days
    return age > STALE_DAYS or sum(1 for r in reports if r["date"][:10] > anchor) >= STALE_REVIEWS


def _diff(before, after):
    return {k: {"before": before.get(k), "after": v} for k, v in after.items() if before.get(k) != v}


def analyze(lesson, reports, obs, today, lens_shas):
    """Per-lesson verdict: refreshed fields, flags, and what (if anything) to propose."""
    fm = lesson["fm"]
    status = fm.get("status", "candidate")
    ev = lesson_evidence(fm, obs)
    prior, a, b, mean, p = _posterior(lesson, ev, obs)
    derived = derived_fields({**fm, "id": lesson["id"]}, reports)
    regrets = _regret_refs(lesson, obs)
    retire = (status in ("candidate", "approved") and _is_demote(fm) and p > 0.40
              and ev["n"] >= _min_obs(lesson)[0])
    promote = (status == "candidate" and fm.get("provenance") != "stated" and not retire
               and _promotes(lesson, ev, mean, p))
    final = "approved" if promote else status
    after = {
        "evidence": {k: ev[k] for k in ("accepted", "partial", "ignored_seen", "unseen", "repos_n", "refs")},
        "posterior": {"prior": [round(prior[0], 4), round(prior[1], 4)], "alpha": round(a, 4),
                      "beta": round(b, 4), "mean": round(mean, 4), "p_gt_015": round(p, 4)},
        "confidence": _confidence(lesson, final, ev, mean, p),
        **derived,
    }
    flags = {}
    if promote:
        flags["status"] = "approved"
    new_regrets = [r for r in regrets if r not in (fm.get("regret_refs") or [])]
    if new_regrets and status != "codified":
        flags["regret_refs"] = list(fm.get("regret_refs") or []) + new_regrets
    if status != "retired" and not fm.get("stale") and _stale(fm, derived, reports, today):
        flags["stale"] = True
    validated = fm.get("validated_with") or {}
    if (validated and not fm.get("recheck")
            and any(lens_shas.get(k) and lens_shas[k] != v for k, v in validated.items())):
        flags["recheck"] = True
    return {"lesson": lesson, "ev": ev, "p": p, "mean": mean, "after": after, "flags": flags, "retire": retire,
            "regrets": regrets, "status": status, "promote": promote}


def _reason(an):
    parts = []
    f, ev = an["flags"], an["ev"]
    if an["promote"]:
        parts.append(f"promote: {ev['n']} counted obs from {ev['prs_n']} PRs / {ev['repos_n']} repos, "
                     f"mean {an['mean']:.2f}, P(p>0.15) {an['p']:.3f}")
    if "regret_refs" in f:
        parts.append("REGRET: a demoted item was posted anyway; narrow the trigger (see regret_refs)")
    if f.get("stale"):
        parts.append(f"stale: no confirmation or trigger for {STALE_DAYS} days / {STALE_REVIEWS} reviews")
    if f.get("recheck"):
        parts.append("a lens changed since validated_with: re-check the lesson")
    return "; ".join(parts) or "refresh evidence counts"


# --- proposals ----------------------------------------------------------------------

def _covers(lesson, cell):
    fm = lesson["fm"]
    if fm.get("kind") == "recall" or fm.get("status") == "retired":
        return False
    return not (fm.get("trigger") or {}).get("pattern") and trigger_matches(
        fm.get("trigger"), {**cell, "title": ""})


def _slug(cell):
    return "-".join(str(cell[k]) for k in CELL_KEYS).lower()


def _new_lesson(cell, obs, today):
    demote = not (cell["mean"] >= 0.35)
    trigger = {"category": cell["category"], "code_kind": cell["code_kind"], "premise": cell["premise"],
               "tier_in": [cell["tier"]], "pattern": None}
    lid = _slug(cell)
    ev = lesson_evidence({"trigger": trigger, "repo": "*"}, obs)
    a, b = posterior_counts(ev["accepted"], ev["partial"], ev["ignored_seen"])
    rate = f"{ev['accepted'] + ev['partial']} of {ev['n']}"
    fm = {
        "id": lid, "kind": "precision" if demote else "presentation", "category": cell["category"],
        "trigger": trigger,
        "claim": (f"Items in this cell are rarely acted on ({rate} counted observations)." if demote
                  else f"Items in this cell are often acted on ({rate} counted observations)."),
        "action": "demote" if demote else "rank_first", "never_when": "",
        "evidence": {k: ev[k] for k in ("accepted", "partial", "ignored_seen", "unseen", "repos_n", "refs")},
        "posterior": {"prior": list(PRIOR), "alpha": round(a, 4), "beta": round(b, 4),
                      "mean": round(beta_mean(a, b), 4), "p_gt_015": round(beta_tail(a, b), 4)},
        "confidence": "low", "provenance": "observed", "source": "tally", "validated_with": {},
        "status": "candidate", "codified_in": None, "created": today, "approved_at": None,
        "last_confirmed": None, "last_used": None, "last_triggered": None, "triggers_since_explore": 0,
        "window": WINDOW,
    }
    body = ("Auto-proposed from the tally; edit the claim before approving.\n")
    return lid, fm, body


def _streak_alerts(reports):
    """no-full-format: 5 consecutive reviews without a full (B/M) item in a category AND a lesson moved it
    (shown_as demoted, or a shadow record `from` B/M). A drought with no lesson involved is not suppression."""
    alerts = []
    cats = sorted({f.get("category") for r in reports for f in r["fm"]["findings"] if isinstance(f, dict)} - {None})
    for cat in cats:
        streak, moved = 0, False
        for r in reports:
            mine = [f for f in r["fm"]["findings"] if isinstance(f, dict) and f.get("category") == cat]
            if not mine:
                continue
            if any(f.get("tier") in ("B", "M") and f.get("shown_as", "normal") in ("normal", "explore") for f in mine):
                streak, moved = 0, False
                continue
            ids = {f.get("id") for f in mine}
            streak += 1
            moved = moved or any(f.get("shown_as") == "demoted" for f in mine) or any(
                x.get("from") in ("B", "M") and x.get("finding") in ids for x in r["fm"].get("lessons_shadow") or [])
        if streak >= 5 and moved:
            alerts.append({"kind": "no-full-format", "category": cat, "lesson": None, "streak": streak,
                           "demoted_involved": moved})
    return alerts


def propose(root, reports, obs, lessons, today, lens_shas):
    """Numbered ADD/UPDATE/DELETE/NOOP proposals, per-lesson evidence rows and alerts."""
    live = [l for l in lessons if l["fm"].get("status") != "retired"]
    props, alerts, rows = [], _streak_alerts(reports), []
    batch = []
    deleted = {}
    for lesson in live:
        if lesson["fm"].get("kind") == "recall":
            props.append({"key": f"noop:{lesson['id']}", "op": "NOOP", "target": lesson["id"], "path": lesson["rel"],
                          "reason": "recall lesson: no precision tally applies", "requires": []})
            continue
        an = analyze(lesson, reports, obs, today, lens_shas)
        rows.append({"id": lesson["id"], "scope": lesson["scope"], "status": an["status"], "n": an["ev"]["n"],
                     "prs": an["ev"]["prs_n"], "repos": an["ev"]["repos_n"], "mean": round(an["mean"], 4),
                     "p_gt_015": round(an["p"], 4), "evidence": an["after"]["evidence"],
                     "posterior": an["after"]["posterior"], "confidence": an["after"]["confidence"],
                     "last_used": an["after"]["last_used"], "last_triggered": an["after"]["last_triggered"],
                     "triggers_since_explore": an["after"]["triggers_since_explore"]})
        fm = lesson["fm"]
        if an["status"] == "codified":
            if an["regrets"]:
                alerts.append({"kind": "regret", "lesson": lesson["id"], "category": fm.get("category"),
                               "refs": an["regrets"]})
            if _is_demote(fm) and an["p"] > 0.40 and an["ev"]["n"] >= _min_obs(lesson)[0]:
                alerts.append({"kind": "codified-p-high", "lesson": lesson["id"], "category": fm.get("category"),
                               "p_gt_015": round(an["p"], 4)})
        target = {"target": lesson["id"], "scope": lesson["scope"], "path": lesson["rel"]}
        if an["retire"]:
            diff = {"status": {"before": an["status"], "after": "retired"}}
            p = {"key": f"del:{lesson['id']}", "op": "DELETE", "target": lesson["id"], "path": lesson["rel"],
                 "reason": f"P(p>0.15) {an['p']:.3f} > 0.40 over {an['ev']['n']} counted obs: retire",
                 "changes": [{**target, "diff": diff}], "requires": []}
            props.append(p)
            deleted[lesson["id"]] = p
            continue
        diff = _diff(fm, {**an["after"], **an["flags"]})
        if not diff:
            props.append({"key": f"noop:{lesson['id']}", "op": "NOOP", "target": lesson["id"], "path": lesson["rel"],
                          "reason": "evidence unchanged", "requires": []})
        elif set(diff) <= COUNT_ONLY:
            batch.append({**target, "diff": diff})
        else:
            props.append({"key": f"upd:{lesson['id']}", "op": "UPDATE", "reason": _reason(an),
                          "changes": [{**target, "diff": diff}], "requires": []})
    if batch:
        props.append({"key": "upd:counts", "op": "UPDATE", "reason": f"refresh evidence counts ({len(batch)} lessons)",
                      "changes": batch, "requires": []})
    props += _add_proposals(lessons, reports, obs, today, live, deleted, rows)
    props.sort(key=lambda p: OP_ORDER.index(p["op"]))
    ids = {p["key"]: i for i, p in enumerate(props, 1)}
    out = []
    for i, p in enumerate(props, 1):
        p = dict(p)
        p["requires"] = [ids[k] for k in p.get("requires", [])]
        p.pop("key")
        out.append({"id": i, **p})
    return {"proposals": out, "alerts": alerts, "lessons": rows}


def _add_proposals(lessons, reports, obs, today, live, deleted, rows):
    existing = {l["id"] for l in lessons}
    active = [l for l in live if _is_ml(l) and l["fm"].get("status") in ("approved", "candidate")
              and l["id"] not in deleted]
    free = [p for p in deleted.values() if p["path"].startswith("ml-lessons/")]
    n_by_id = {r["id"]: r["n"] for r in rows}
    spare = sorted((l for l in active if l["fm"].get("provenance") != "stated"),
                   key=lambda l: (l["fm"].get("status") == "approved", n_by_id.get(l["id"], 0), l["id"]))
    out = []
    for cell in cell_table(obs):
        if cell["n"] < 3 or cell["prs"] < 2 or not (cell["mean"] >= 0.35 or cell["p_gt_015"] <= 0.30):
            continue
        if any(_covers(l, cell) for l in live):
            continue
        lid, fm, body = _new_lesson(cell, obs, today)
        if lid in existing:
            continue
        existing.add(lid)
        requires = []
        if len(active) >= ML_CAP:
            if free:
                requires = [free.pop(0)["key"]]
            elif spare:
                victim = spare.pop(0)
                active.remove(victim)
                p = {"key": f"del:{victim['id']}", "op": "DELETE", "target": victim["id"], "path": victim["rel"],
                     "reason": f"make room: ml-lessons is at the cap of {ML_CAP}; fewest counted observations",
                     "changes": [{"target": victim["id"], "scope": "ml", "path": victim["rel"],
                                  "diff": {"status": {"before": victim["fm"].get("status"), "after": "retired"}}}],
                     "requires": []}
                out.append(p)
                requires = [p["key"]]
            else:
                continue
        else:
            active.append({"id": lid, "fm": fm})
        out.append({"key": f"add:{lid}", "op": "ADD", "scope": "ml", "target": lid, "path": f"ml-lessons/{lid}.md",
                    "reason": (f"uncovered cell: {cell['n']} counted obs from {cell['prs']} PRs, "
                               f"mean {cell['mean']:.2f}, P(p>0.15) {cell['p_gt_015']:.3f}"),
                    "frontmatter": fm, "body": body, "requires": requires})
    return out


# --- apply ----------------------------------------------------------------------------

def _read(path):
    fm, body = store.split_report(path.read_text(encoding="utf-8"))
    return _plain(fm), body


def apply_proposals(root, data, approved):
    """Write ONLY the approved ids of a printed proposals file. Validates everything before writing."""
    root = Path(root)
    by_id = {p["id"]: p for p in data.get("proposals", [])}
    approved = list(dict.fromkeys(approved))
    unknown = [i for i in approved if i not in by_id]
    if unknown:
        raise ValueError(f"unknown proposal id(s): {', '.join(map(str, unknown))}")
    writes = {}
    for i in approved:
        p = by_id[i]
        missing = [r for r in p.get("requires", []) if r not in approved]
        if missing:
            raise ValueError(f"proposal {i} ({p.get('target')}) also needs approved id(s): {', '.join(map(str, missing))}")
        if p["op"] == "NOOP":
            continue
        if p["op"] == "ADD":
            path = root / p["path"]
            if path.exists() or str(path) in writes:
                raise ValueError(f"proposal {i}: {p['path']} already exists")
            fm = {k: p["frontmatter"][k] for k in LESSON_ORDER if k in p["frontmatter"]}
            writes[str(path)] = (path, store.render_report(fm, p["body"]))
            continue
        for change in p.get("changes") or [{"path": p["path"], "diff": {}}]:
            path = root / change["path"]
            if not path.is_file():
                raise ValueError(f"proposal {i}: {change['path']} not found")
            fm, body = _read(path)
            prior = writes.get(str(path))
            if prior:
                fm, body = _read_text(prior[1])
            for key, ba in change["diff"].items():
                if fm.get(key) != ba["before"]:
                    raise ValueError(f"proposal {i}: {change['path']} changed since the proposal ({key}); rerun tally")
                fm[key] = ba["after"]
            if p["op"] == "DELETE":
                fm["status"] = "retired"
            writes[str(path)] = (path, store.render_report(fm, body))
    for path, text in writes.values():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return [str(path) for path, _ in writes.values()]


def _read_text(text):
    fm, body = store.split_report(text)
    return _plain(fm), body


# --- output ---------------------------------------------------------------------------

def _fmt_diff(diff):
    out = []
    for k, ba in diff.items():
        if k in ("evidence", "posterior"):
            out.append(f"{k}: {_short(ba['before'])} -> {_short(ba['after'])}")
        else:
            out.append(f"{k}: {ba['before']!r} -> {ba['after']!r}")
    return "; ".join(out)


def _short(v):
    if isinstance(v, dict):
        return "{" + ", ".join(f"{k}={x}" for k, x in v.items() if k != "refs") + "}"
    return repr(v)


def render_text(result, excluded):
    s = result["summary"]
    lines = [f"# Tally: {s['reports']} reports ({len(excluded)} excluded), {s['observations']} outcome rows", "",
             "Ledger outcomes (raw): " + ", ".join(f"{k} {v}" for k, v in sorted(s["raw"].items())),
             "Derived at tally time: " + ", ".join(f"{k} {v}" for k, v in sorted(s["state"].items())),
             f"Shadow reviews: {s['shadow_reviews']}/{SHADOW_TARGET} (harvested {s['shadow_harvested']})", ""]
    cells = [c for c in result["cells"] if c["n"] > 0]
    lines += [f"## Cells with counted observations ({len(cells)}; {len(result['cells']) - len(cells)} unseen-only cells omitted)",
              "| category | code_kind | premise | tier | acc | part | ign | unseen | PRs | mean | P(p>0.15) |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
    for c in cells:
        lines.append(f"| {c['category']} | {c['code_kind']} | {c['premise']} | {c['tier']} | {c['accepted']} | "
                     f"{c['partial']} | {c['ignored_seen']} | {c['unseen']} | {c['prs']} | {c['mean']:.3f} | {c['p_gt_015']:.3f} |")
    lines += ["", f"## Lessons ({len(result['lessons'])})"]
    for r in result["lessons"] or []:
        lines.append(f"- {r['id']} [{r['scope']}/{r['status']}] n={r['n']} PRs={r['prs']} repos={r['repos']} "
                     f"mean={r['mean']} P={r['p_gt_015']} last_triggered={r['last_triggered']} "
                     f"since_explore={r['triggers_since_explore']}")
    if not result["lessons"]:
        lines.append("(no ml-lessons/ or repo-lessons/ found: cell table only)")
    lines += ["", f"## Proposals ({len(result['proposals'])})"]
    for p in result["proposals"]:
        head = f"{p['id']}. {p['op']}"
        req = f" (needs {', '.join(map(str, p['requires']))})" if p.get("requires") else ""
        if p["op"] == "ADD":
            fm = p["frontmatter"]
            lines.append(f"{head} {p['path']}: {fm['action']} on {fm['category']}/{fm['trigger']['code_kind']}/"
                         f"{fm['trigger']['premise']}/{fm['trigger']['tier_in'][0]} - {p['reason']}{req}")
        elif p["op"] == "NOOP":
            lines.append(f"{head} {p['target']}: {p['reason']}")
        else:
            lines.append(f"{head} {p['reason']}{req}")
            for ch in p["changes"]:
                lines.append(f"    {ch['target']}: {_fmt_diff(ch['diff'])}")
    lines += ["", f"## Alerts ({len(result['alerts'])})"]
    for a in result["alerts"]:
        lines.append("- " + ", ".join(f"{k}={v}" for k, v in a.items() if v is not None))
    return "\n".join(lines) + "\n"


def build(root, only, exclude, today, lens_shas):
    reports_all = load_reports(root)
    reports = select_reports(reports_all, only, exclude)
    excluded = [r["rel_noext"] for r in reports_all if r not in reports]
    obs = all_observations(reports)
    lessons = load_lessons(root)
    result = propose(root, reports, obs, lessons, today, lens_shas)
    shadow, harvested = shadow_counts(reports)
    result["summary"] = {"reports": len(reports), **summarize(obs), "shadow_reviews": shadow,
                         "shadow_harvested": harvested}
    result["cells"] = cell_table(obs)
    return result, excluded


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=SKILL_DIR, help="directory holding reviews/, ml-lessons/, repo-lessons/")
    group = ap.add_mutually_exclusive_group()
    group.add_argument("--only-reviews", help="comma-separated review selectors to keep")
    group.add_argument("--exclude-reviews", help="comma-separated review selectors to drop")
    ap.add_argument("--json", action="store_true", help="print the full result as JSON (save it as proposals.json)")
    ap.add_argument("--apply", metavar="PROPOSALS_JSON", help="write the --approved ids of a printed proposals file")
    ap.add_argument("--approved", help="comma-separated proposal ids (required with --apply)")
    ap.add_argument("--today", default=dt.date.today().isoformat(), help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    if a.apply:
        if not a.approved:
            ap.error("--apply needs --approved")
        try:
            ids = [int(x) for x in parse_ids(a.approved)]
            data = json.loads(Path(a.apply).read_text(encoding="utf-8"))
            for path in apply_proposals(a.root, data, ids):
                print(path)
        except (ValueError, OSError) as e:
            print(e, file=sys.stderr)
            return 1
        return 0
    exclude = read_exclude_file(a.root) + (parse_ids(a.exclude_reviews) or [])
    lens_shas = {k: v for k, v in store.lens_versions_for(SKILL_DIR.parent)[0].items() if v}
    result, excluded = build(a.root, parse_ids(a.only_reviews), exclude, a.today, lens_shas)
    print(json.dumps(result, indent=2) if a.json else render_text(result, excluded), end="\n" if a.json else "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
