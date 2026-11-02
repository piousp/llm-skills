#!/usr/bin/env python3
"""Held-out replay of the lessons against the recorded ledger (stdlib + PyYAML). Writes nothing.

    replay.py --test <repo#pr,repo#pr,...> [--folds 4] [--root DIR] [--json] [--alt-test <prkeys>]

Fold 1 is --test. Folds 2..N take the remaining PRs sorted by `repo#pr` in slices of 4 ([0:4], [4:8],
...); PRs beyond the last slice are never tested. --alt-test adds a fold "1b" (an alternative held-out
set). For each fold: train = every other report; the lessons are built in memory from the train
ledger (every precision/presentation lesson that is a candidate or approved is treated as APPROVED:
the seeds and every lesson meeting the promotion thresholds, plus uncovered cells the train tally would
ADD); `select_lessons.select` then runs on the test reports' recorded items (baseline = recorded tiers;
full-format = B/M).

PASS iff all hold: 0 posted items lose full-format visibility (at most 1 partial may), full-format items
drop by >= 30%, every demoted category keeps >= 1 visible (non-collapsed) line in each test review.
The visible-line floor is on by default (--no-floor turns it off for comparison). Opt-in what-if variants
(never the default, never written): --whatif A (same as the default), B (A + drop
the lessons `volume` and `nit-exact`), C (B + postable-suggestion restricted to code_kind build/script/test,
race-spec dropped); --baseline static measures against the tiers left by the codified rules applied as
static selectors (refactor-only only where refactor-identification is the item's only lens; premise-external lands on Q) instead of the recorded tiers.
On failure the culprit lessons are named with a proposed NARROWED trigger (printed, never applied);
thresholds are never relaxed. Rules: references/learning-loop.md.
"""

import argparse
import json
import sys
from pathlib import Path

import select_lessons as sel
import store
import tally

SKILL_DIR = store.SKILL_DIR
FULL = ("B", "M")
DROP_MIN = 0.30
PARTIAL_MAX = 1
SLICE = 4
FACETS = ("category", "code_kind", "premise", "tier")
VARIANTS = ("A", "B", "C")
B_DROPS = ("volume", "nit-exact")
C_DROPS = ("race-spec",)
C_NARROW = {"postable-suggestion": {"code_kind": ["build", "script", "test"]}}
STATIC_NARROW = {"refactor-only": {"lens_only": "refactor-identification"}}
STATIC_TARGET = {"premise-external": "Q"}  # static demotions of these lessons land on Q, not one step down


# --- ledger ----------------------------------------------------------------------------

def parse_keys(text):
    """'repo#12, other#3' -> [('repo', '12'), ('other', '3')]."""
    keys = []
    for part in (text or "").split(","):
        part = part.strip()
        if not part:
            continue
        repo, sep, pr = part.rpartition("#")
        if not sep or not repo or not pr:
            raise ValueError(f"bad PR key {part!r}: expected repo#pr")
        keys.append((repo, pr))
    return keys


def key_of(report):
    return (report["repo"], report["pr_key"])


def load_ledger(root):
    """Reports with harvested feedback (the only ones that carry outcomes), oldest first."""
    reports = tally.select_reports(tally.load_reports(root), None, tally.read_exclude_file(root))
    return [r for r in reports if isinstance(r["fm"].get("feedback"), dict)]


def split_folds(all_keys, test_keys, folds, alt_keys=None):
    """[(name, keys)]: fold 1 = test_keys, (1b = alt_keys), then slices of the remaining sorted keys."""
    known = set(all_keys)
    for k in list(test_keys) + list(alt_keys or []):
        if k not in known:
            raise ValueError(f"unknown PR key {k[0]}#{k[1]}: not in the ledger")
    out = [("1", list(test_keys))]
    if alt_keys:
        out.append(("1b", list(alt_keys)))
    rest = sorted((k for k in known if k not in set(test_keys)), key=lambda k: f"{k[0]}#{k[1]}")
    for n in range(2, folds + 1):
        chunk = rest[(n - 2) * SLICE:(n - 1) * SLICE]
        if chunk:
            out.append((str(n), chunk))
    return out


# --- lessons built from the train ledger ----------------------------------------------------

def replay_lessons(train, lessons):
    """(lessons treated as approved, info). Codified, retired and recall lessons are left out."""
    obs = tally.all_observations(train)
    today = max((r["date"][:10] for r in train), default="1970-01-01")
    proposals = tally.propose(None, train, obs, lessons, today, {})
    out, info = [], {"meets_thresholds": [], "retire_flagged": [], "added_by_tally": []}
    for l in lessons:
        fm = l["fm"]
        if fm.get("status") not in ("candidate", "approved") or fm.get("kind") == "recall":
            continue
        an = tally.analyze(l, train, obs, today, {})
        if an["promote"]:
            info["meets_thresholds"].append(l["id"])
        if an["retire"]:
            info["retire_flagged"].append(l["id"])
        out.append({**l, "fm": {**fm, "status": "approved"}})
    for p in proposals["proposals"]:
        if p["op"] == "ADD":
            fm = {**p["frontmatter"], "status": "approved"}
            info["added_by_tally"].append(fm["id"])
            out.append({"id": fm["id"], "fm": fm, "body": p["body"], "scope": "ml",
                        "rel": p["path"], "path": Path(p["path"])})
    return out, info


# --- what-if variants and the static baseline ------------------------------------------------

def variant_pool(pool, variant):
    """(lessons, floor) for a what-if variant; `pool` is untouched (copies are made, nothing is written).
    None -> the replay default; "none" -> no learned lessons at all. The floor is on for every variant
    (it is the default); `run_fold(floor=False)` switches it off for comparison."""
    if variant is None:
        return pool, True
    if variant == "none":
        return [], True
    if variant not in VARIANTS:
        raise ValueError(f"unknown variant {variant!r}: expected one of {', '.join(VARIANTS)}")
    drops = set(B_DROPS) if variant in ("B", "C") else set()
    if variant == "C":
        drops |= set(C_DROPS)
    out = []
    for l in pool:
        if l["id"] in drops:
            continue
        narrow = C_NARROW.get(l["id"]) if variant == "C" else None
        out.append({**l, "fm": {**l["fm"], "trigger": {**(l["fm"].get("trigger") or {}), **narrow}}} if narrow else l)
    return out, True


def codified_pool(lessons):
    """The codified lessons as approved selectors (in memory), refactor-only restricted to single-lens items."""
    out = []
    for l in lessons:
        fm = l["fm"]
        if fm.get("status") != "codified" or fm.get("kind") == "recall":
            continue
        trig = {**(fm.get("trigger") or {}), **STATIC_NARROW.get(l["id"], {})}
        out.append({**l, "fm": {**fm, "status": "approved", "trigger": trig}})
    return out


def _decide(report, items, pool, train, protect_cfg, since, floor, static):
    """(final findings, baseline findings) for one test report. Baseline = recorded tiers, or (static is a
    pool) the tiers left by the codified selectors; the pool then runs on what the static pass left visible."""
    kw = {"pr": report["pr_key"], "review_id": report["review_id"]}
    if static is None:
        res = sel.select(items, report["repo"], pool, train, protect_cfg, since=since, floor=floor, **kw)
        base = [{"id": i["id"], "tier": i["tier"], "collapsed": False} for i in items]
        return res["findings"], base
    first = {f["id"]: f for f in sel.select(items, report["repo"], static, [], protect_cfg, explore=False,
                                            targets=STATIC_TARGET, **kw)["findings"]}
    rest = [{**i, "tier": first[i["id"]]["tier"]} for i in items if not first[i["id"]]["collapsed"]]
    second = {f["id"]: f for f in sel.select(rest, report["repo"], pool, train, protect_cfg, since=since,
                                             floor=floor, **kw)["findings"]} if rest else {}
    final = []
    for i in items:
        f1 = first[i["id"]]
        f2 = second.get(i["id"])
        final.append(f1 if f2 is None else {**f2, "lessons": f1["lessons"] + f2["lessons"]})
    base = [{"id": i["id"], "tier": first[i["id"]]["tier"], "collapsed": first[i["id"]]["collapsed"]} for i in items]
    return final, base


# --- one fold ------------------------------------------------------------------------------

def _items(report):
    return [{k: v for k, v in f.items() if k not in ("shown_as", "lessons")}
            for f in report["fm"]["findings"] if isinstance(f, dict)]


def _outcomes(report):
    return {o["id"]: o.get("outcome") for o in report["fm"]["feedback"].get("outcomes") or []
            if isinstance(o, dict) and "id" in o}


def _forms(report):
    return {o["id"]: o.get("form") for o in report["fm"]["feedback"].get("outcomes") or []
            if isinstance(o, dict) and "id" in o}


def _is_full(finding):
    return finding["tier"] in FULL and not finding["collapsed"]


def _is_kept(finding, form):
    """Full format, or a visible Q the owner's posted comment was itself a question about."""
    return _is_full(finding) or (finding["tier"] == "Q" and not finding["collapsed"] and form == "question")


def narrow_trigger(lesson, lost, matched):
    """Propose a narrower trigger for `lesson` that excludes `lost` while keeping most non-posted matches.
    `matched` = every ledger item (with `posted`) that the lesson's current trigger matches."""
    best = None
    quiet = [m for m in matched if not m["posted"]]
    for facet in FACETS:
        keep_vals = sorted({m[facet] for m in quiet if m[facet] is not None} - {lost.get(facet)})
        if not keep_vals:
            continue
        still = [m for m in matched if m[facet] in keep_vals]
        kept_quiet = sum(1 for m in still if not m["posted"])
        score = (sum(1 for m in still if m["posted"]), -kept_quiet)
        if best is None or score < best[0]:
            best = (score, facet, keep_vals, kept_quiet, len(quiet))
    if best is None:
        return {"restrict": None, "note": "no single facet separates this item: add a title pattern or retire"}
    _, facet, vals, kept, total = best
    key = "tier_in" if facet == "tier" else facet
    still_posted = best[0][0]
    out = {"restrict": {key: vals}, "keeps_non_posted": f"{kept}/{total}", "still_matches_posted": still_posted}
    if still_posted or kept * 2 < total:
        out["weak"] = True  # the restriction still hits posted items or drops most of the lesson's reach: retire instead
    return out


def _matched_items(lesson, reports):
    out = []
    for r in reports:
        outs = _outcomes(r)
        for f in _items(r):
            if tally._in_scope(lesson["fm"], r["repo"]) and tally.trigger_matches(lesson["fm"].get("trigger"), f):
                out.append({**{k: f.get(k) for k in FACETS}, "posted": outs.get(f["id"]) in ("posted", "partial")})
    return out


def run_fold(name, keys, reports, lessons, protect_cfg, variant=None, static=False, floor=True):
    """`variant` (None, A, B, C, "none") picks the what-if lessons; `static=True` measures against the
    post-codified-rules tiers (see module doc). Defaults reproduce the plain replay."""
    keyset = set(keys)
    test = [r for r in reports if key_of(r) in keyset]
    train = [r for r in reports if key_of(r) not in keyset]
    pool, info = replay_lessons(train, lessons)
    pool, variant_floor = variant_pool(pool, variant)
    floor = floor and variant_floor
    static_pool = codified_pool(lessons) if static else None
    by_lesson = {l["id"]: l for l in pool}
    since = {}
    base_full = after_full = demoted_full = recorded_full = 0
    lost_vs_recorded = []
    lost, partial_lost, empty, posted_collapsed, violations = [], [], [], [], []
    for r in test:
        outs, forms = _outcomes(r), _forms(r)
        items = _items(r)
        findings, base = _decide(r, items, pool, train, protect_cfg, since, floor, static_pool)
        res = {"findings": findings}
        basis = {b["id"]: b for b in base}
        after = {f["id"]: f for f in findings}
        titles = {i["id"]: i for i in items}
        for i in items:
            f = after[i["id"]]
            was_full, is_full = _is_full(basis[i["id"]]), _is_full(f)
            kept = _is_kept(f, forms.get(i["id"]))
            recorded_full += i["tier"] in FULL
            if outs.get(i["id"]) in ("posted", "partial") and i["tier"] in FULL and not kept:
                lost_vs_recorded.append(f"{r['rel_noext']}:{i['id']}")
            base_full += was_full
            after_full += is_full
            demoted_full += was_full and not is_full
            out = outs.get(i["id"])
            if out in ("posted", "partial") and f["collapsed"]:
                posted_collapsed.append(f"{r['rel_noext']}:{i['id']}")
            if out in ("posted", "partial") and was_full and not kept:
                row = {"kind": "posted-lost" if out == "posted" else "partial-lost", "review": r["rel_noext"],
                       "finding": i["id"], "title": i.get("title"), "from": basis[i["id"]]["tier"],
                       "to": "collapsed" if f["collapsed"] else f["tier"], "lessons": f["lessons"],
                       "narrowed": {lid: narrow_trigger(by_lesson[lid], i, _matched_items(by_lesson[lid], reports))
                                    for lid in f["lessons"] if lid in by_lesson}}
                (lost if out == "posted" else partial_lost).append(row)
                violations.append(row)
        for cat in sorted({titles[f["id"]].get("category") for f in res["findings"] if f["shown_as"] == "demoted"}):
            mine = [f for f in res["findings"] if titles[f["id"]].get("category") == cat]
            if not any(not f["collapsed"] for f in mine):
                culprits = sorted({x for f in mine for x in f["lessons"]})
                row = {"kind": "category-empty", "review": r["rel_noext"], "category": cat,
                       "items": [f["id"] for f in mine], "lessons": culprits,
                       "narrowed": {lid: narrow_trigger(by_lesson[lid], {**titles[mine[0]["id"]]},
                                                        _matched_items(by_lesson[lid], reports))
                                    for lid in culprits if lid in by_lesson}}
                empty.append(row)
                violations.append(row)
    drop = (base_full - after_full) / base_full if base_full else 0.0
    checks = {"posted_kept": not lost and len(partial_lost) <= PARTIAL_MAX, "drop_ge_30": drop >= DROP_MIN,
              "categories_visible": not empty}
    return {
        "fold": name, "test": [f"{k[0]}#{k[1]}" for k in keys], "reports": [r["rel_noext"] for r in test],
        "train_reports": len(train), "lessons_treated_as_approved": sorted(by_lesson), **info,
        "variant": variant, "static_baseline": bool(static), "recorded_full": recorded_full,
        "posted_or_partial_lost_vs_recorded": lost_vs_recorded,
        "full_baseline": base_full, "full_after": after_full, "full_drop_pct": round(100 * drop, 1),
        "posted_lost": len(lost), "partial_lost": len(partial_lost),
        "demoted_categories_empty": [e["category"] for e in empty],
        "posted_or_partial_collapsed_non_full": posted_collapsed,
        "checks": checks, "pass": all(checks.values()), "violations": violations,
    }


# --- codified-rule regret -------------------------------------------------------------------------

def codified_regret(reports, lessons, protect_cfg):
    """Posted/partial items that lose full-format visibility when ONLY the codified rules run as static
    selectors (refactor-only on single-lens items). One row per item and lesson that touched it."""
    static = codified_pool(lessons)
    demoters = {l["id"] for l in static if sel.parse_action(l["fm"].get("action"))[0] in ("demote", "cap_full")}
    rows = []
    for r in reports:
        outs, forms = _outcomes(r), _forms(r)
        items = _items(r)
        res = {f["id"]: f for f in sel.select(items, r["repo"], static, [], protect_cfg, pr=r["pr_key"],
                                              review_id=r["review_id"], explore=False,
                                              targets=STATIC_TARGET)["findings"]}
        for i in items:
            f = res[i["id"]]
            if outs.get(i["id"]) in ("posted", "partial") and i["tier"] in FULL \
                    and not _is_kept(f, forms.get(i["id"])):
                for lid in (x for x in f["lessons"] if x in demoters):  # question-form etc. do not move tiers
                    rows.append({"lesson": lid, "review": r["rel_noext"], "finding": i["id"], "tier": i["tier"],
                                 "to": "collapsed" if f["collapsed"] else f["tier"], "outcome": outs[i["id"]],
                                 "category": i.get("category"), "lens": i.get("lens") or [], "title": i.get("title")})
    return sorted(rows, key=lambda x: (x["lesson"], x["review"], x["finding"]))


# --- output ----------------------------------------------------------------------------------

def _counts(names):
    return ", ".join(f"{n} x{names.count(n)}" for n in sorted(set(names)))


def render(results):
    lines = ["# Replay", "",
             "Train = every other report; every candidate/approved precision or presentation lesson (seeds, "
             "repo and org lessons, tally ADD cells) is treated as APPROVED; codified, retired and recall "
             "lessons are left out.", ""]
    for r in results:
        lines += [f"## Fold {r['fold']}: {'PASS' if r['pass'] else 'FAIL'}",
                  *([f"- what-if: variant {r['variant'] or '-'}, baseline "
                     f"{'static (codified rules applied)' if r['static_baseline'] else 'recorded'}; recorded full-format "
                     f"{r['recorded_full']}"] if r["variant"] or r["static_baseline"] else []),
                  f"- test PRs: {', '.join(r['test'])} ({len(r['reports'])} reviews; train {r['train_reports']} reviews)",
                  f"- posted items losing full-format visibility: {r['posted_lost']}; partial: {r['partial_lost']} "
                  f"(limit 0 / {PARTIAL_MAX}) -> {'ok' if r['checks']['posted_kept'] else 'FAIL'}",
                  f"- full-format items (B/M): {r['full_baseline']} -> {r['full_after']}, drop "
                  f"{r['full_drop_pct']}% (min 30) -> {'ok' if r['checks']['drop_ge_30'] else 'FAIL'}",
                  f"- demoted categories left without a visible line (reviews affected): "
                  f"{_counts(r['demoted_categories_empty']) or 'none'} -> "
                  f"{'ok' if r['checks']['categories_visible'] else 'FAIL'}",
                  f"- info: posted/partial items collapsed (not full-format at baseline): "
                  f"{', '.join(r['posted_or_partial_collapsed_non_full']) or 'none'}",
                  f"- info: lessons meeting promotion thresholds on train: {', '.join(r['meets_thresholds']) or 'none'}; "
                  f"retire-flagged on train (still applied): {', '.join(r['retire_flagged']) or 'none'}; "
                  f"added by tally: {', '.join(r['added_by_tally']) or 'none'}"]
        for v in r["violations"]:
            head = (f"- VIOLATION {v['kind']} {v['review']}:{v.get('finding', v.get('category'))}"
                    + (f" ({v['from']} -> {v['to']}) {v['title']!r}" if "from" in v else f" items {v['items']}"))
            lines.append(f"{head}; culprit lessons: {', '.join(v['lessons']) or 'none recorded'}")
            for lid, n in v["narrowed"].items():
                lines.append(f"    proposed narrowing for {lid}: {json.dumps(n)}")
        lines.append("")
    return "\n".join(lines)


def render_regret(rows):
    lines = ["# Codified-rule regret (posted/partial items that lose full-format visibility)", ""]
    for lid in sorted({x["lesson"] for x in rows}):
        mine = [x for x in rows if x["lesson"] == lid]
        lines.append(f"## {lid}: {len(mine)}")
        lines += [f"- {x['review']}:{x['finding']} {x['tier']}->{x['to']} {x['outcome']} {x['category']} "
                  f"lens={x['lens']} {x['title']!r}" for x in mine]
        lines.append("")
    return "\n".join(lines if rows else lines + ["none"])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--test", help="comma-separated repo#pr keys: the fold-1 held-out set (required unless --regret)")
    ap.add_argument("--folds", type=int, default=4)
    ap.add_argument("--alt-test", help="comma-separated repo#pr keys: an extra fold '1b'")
    ap.add_argument("--root", default=SKILL_DIR, help="directory holding reviews/, ml-lessons/, repo-lessons/")
    ap.add_argument("--whatif", choices=VARIANTS, help="opt-in what-if variant (see above); default: none")
    ap.add_argument("--baseline", choices=("recorded", "static"), default="recorded",
                    help="static = tiers after the codified rules as selectors (opt-in)")
    ap.add_argument("--regret", action="store_true",
                    help="list posted/partial items the codified rules alone would hide; ignores --test")
    ap.add_argument("--no-floor", dest="floor", action="store_false",
                    help="comparison only: switch the visible-line floor off (default: on)")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    if not a.regret and not a.test:
        ap.error("--test is required unless --regret")
    try:
        reports = load_ledger(a.root)
        if a.regret:
            rows = codified_regret(reports, tally.load_lessons(a.root), sel.load_protect(a.root))
            print(json.dumps(rows, indent=2) if a.json else render_regret(rows))
            return 0
        folds = split_folds(sorted({key_of(r) for r in reports}), parse_keys(a.test), a.folds,
                            parse_keys(a.alt_test) if a.alt_test else None)
        lessons, protect = tally.load_lessons(a.root), sel.load_protect(a.root)
        results = [run_fold(n, k, reports, lessons, protect, a.whatif, a.baseline == "static", a.floor) for n, k in folds]
    except (ValueError, OSError) as e:
        print(e, file=sys.stderr)
        return 1
    print(json.dumps(results, indent=2) if a.json else render(results))
    return 0 if all(r["pass"] for r in results) else 2


if __name__ == "__main__":
    sys.exit(main())
