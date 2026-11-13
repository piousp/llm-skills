#!/usr/bin/env python3
"""E1: compare backfilled feedback drafts with independently derived per-PR counts.

    check_backfill.py --expected reviews/_meta/backfill_expected.json [--feedback-dir DIR]
                      [--agreement tags_run2.json_dir]

expected: {"<dir>": [posted, partial, items]}, summed over all rounds listed in feedback-dir
(<dir>-r<k>.json). Posted and partial are judgment calls at the boundary, so the pass rule is
|posted+partial - expected| <= 1 per PR; posted and partial alone only warn. Item counts
warn above 15% difference. With --agreement DIR, also compares categories in
reviews/_meta/tags/<d>-r<k>.json with the second run in DIR and fails below 80%.
"""
import argparse, glob, json, os, re, sys

def load_counts(fdir):
    out = {}
    for p in sorted(glob.glob(os.path.join(fdir, "*-r[0-9]*.json"))):
        m = re.match(r"(.+)-r(\d+)\.json$", os.path.basename(p))
        d = m.group(1)
        fb = json.load(open(p))
        oc = [o["outcome"] for o in fb["outcomes"]]
        c = out.setdefault(d, {"posted": 0, "partial": 0, "items": 0})
        c["posted"] += oc.count("posted"); c["partial"] += oc.count("partial"); c["items"] += len(oc)
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--expected", required=True)
    ap.add_argument("--feedback-dir", default=os.path.join(os.path.dirname(__file__), "..", "reviews", "_meta", "feedback"))
    ap.add_argument("--agreement")
    a = ap.parse_args()
    exp = json.load(open(a.expected)); got = load_counts(a.feedback_dir)
    fails = 0
    print(f"{'PR':40} {'exp P/Pa/N':>12} {'got P/Pa/N':>12}  result")
    for d, (ep, epa, en) in sorted(exp.items()):
        g = got.get(d)
        if not g:
            print(f"{d:40} {'-':>12} {'missing':>12}  FAIL"); fails += 1; continue
        ok = abs((g['posted'] + g['partial']) - (ep + epa)) <= 1
        notes = []
        if abs(g['posted'] - ep) > 1 or abs(g['partial'] - epa) > 1: notes.append("split differs")
        if en and abs(g['items'] - en) / en > 0.15: notes.append("items +-15%")
        print(f"{d:40} {f'{ep}/{epa}/{en}':>12} {str(g['posted'])+'/'+str(g['partial'])+'/'+str(g['items']):>12}  {'ok' if ok else 'FAIL'}{' (warn: ' + ', '.join(notes) + ')' if notes else ''}")
        fails += (not ok)
    if a.agreement:
        tdir = os.path.join(a.feedback_dir, "..", "tags"); tot = agree = 0
        for p in glob.glob(os.path.join(tdir, "*.json")):
            q = os.path.join(a.agreement, os.path.basename(p))
            if not os.path.exists(q): continue
            t1, t2 = json.load(open(p)), json.load(open(q))
            for k, v in t1.items():
                if k in t2: tot += 1; agree += (t1[k] == t2[k])
        rate = agree / tot if tot else 0
        print(f"category agreement: {agree}/{tot} = {rate:.0%}")
        fails += (rate < 0.80)
    print("E1/E2:", "PASS" if not fails else f"FAIL ({fails})")
    sys.exit(1 if fails else 0)

main()
