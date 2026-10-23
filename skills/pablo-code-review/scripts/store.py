#!/usr/bin/env python3
"""Report ledger for pablo-code-review (stdlib + PyYAML).

Commands:
    store.py write-report --meta <json|-> --body <md> [--root DIR] [--backfill]
    store.py validate <report>...
    store.py review-id <host> <org> <repo> <pr|branch:NAME> <round>
    store.py lens-sha <dir>
    store.py set-feedback <report> <feedback.json>

Host and org always come from the arguments or the meta JSON: nothing is defaulted.
"""

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path

import yaml

SKILL_DIR = Path(__file__).resolve().parent.parent
TAXONOMY_MD = SKILL_DIR / "references" / "taxonomy.md"
LEGACY_LENSES = ("qa-adversary", "code-review-checklist", "refactor-identification")
LENSES = LEGACY_LENSES + ("pablo-test-review",)
TIERS = ("B", "M", "Q", "I", "G", "T", "O", "F")
TALLY_TIERS = ("B", "M", "Q", "I", "G")
CODE_KINDS = ("prod", "test", "build", "script", "dev-tool")
PREMISES = ("in-diff", "1-hop", "external-unverified")
KINDS = ("finding", "question", "gap", "nit")
SHOWN_AS = ("normal", "explore", "demoted")
VERDICTS = ("BLOCK", "NEEDS WORK", "PASS")
KEY_ORDER = (
    "review_id host org repo pr round branch base_sha head_sha date context_prs skill_sha "
    "lens_versions lessons_applied lessons_shadow diff_stats items_shown_full "
    "items_shown_total verdict tally findings"
).split()
FINDING_ORDER = (
    "id lens lens_sev tier category code_kind premise kind location title rank shown_as lessons"
).split()
INPUT_KEYS = (
    "host org repo pr branch base_sha head_sha date context_prs diff_stats verdict findings"
).split()
OUTCOMES = ("posted", "partial", "not-posted", "unseen", "superseded", "changed-after")
FORMS = ("question", "assertion")
MATCHES = ("auto", "asked")
REASONS = ("wrong", "not-worth", "business", "didnt-read", "this-pr-only")
FEEDBACK_KEYS = "harvested_at outcomes recall_misses this_pr_only wiki_proposals".split()
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
HEX8_RE = re.compile(r"^[0-9a-f]{8}$")
GIT_SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")


# --- pure helpers -----------------------------------------------------------

def pr_ref(pr, branch):
    """Identity of the reviewed change: the PR number, or `branch:<name>` without a PR."""
    return pr if pr is not None else f"branch:{branch}"


def review_id(host, org, repo, pr, round_):
    return hashlib.sha1(f"{host}/{org}/{repo}#{pr}#{round_}".encode()).hexdigest()[:8]


def taxonomy(path=TAXONOMY_MD):
    text = Path(path).read_text(encoding="utf-8")
    return re.findall(r"^\d+\. ([a-z-]+):", text, flags=re.M)


def lens_sha(directory):
    d = Path(directory)
    files = [d / "SKILL.md"] + sorted((d / "references").rglob("*.md"))
    blob = b"".join(f.read_bytes() for f in files if f.is_file())
    return hashlib.sha256(blob).hexdigest()[:8]


def branch_slug(branch):
    return re.sub(r"[^a-z0-9]+", "-", str(branch).lower()).strip("-")


def file_prefix(pr, branch):
    return f"pr{pr}" if pr is not None else branch_slug(branch)


def next_round(existing_names, prefix):
    pat = re.compile(rf"^{re.escape(prefix)}-r(\d+)-")
    rounds = [int(m.group(1)) for n in existing_names if (m := pat.match(n))]
    return 1 + max(rounds, default=0)


def tally_of(findings):
    tiers = [f.get("tier") for f in findings if isinstance(f, dict)]
    return {t: tiers.count(t) for t in TALLY_TIERS}


def expected_verdict(tally):
    if tally["B"] > 0:
        return "BLOCK"
    return "NEEDS WORK" if tally["M"] > 0 else "PASS"


def lens_versions_for(skills_dir):
    """lens-sha per lens dir; (versions, missing). A lens dir without SKILL.md gets null + a reason."""
    versions, missing = {}, {}
    for name in LENSES:
        d = Path(skills_dir) / name
        if (d / "SKILL.md").is_file():
            versions[name] = lens_sha(d)
        else:
            versions[name] = None
            missing[name] = f"lens directory not found: {d}"
    return versions, missing


def build_frontmatter(meta, round_, skill_sha, lens_versions, lens_missing=None):
    """Meta JSON + derived fields → ordered frontmatter dict (no validation)."""
    findings = [
        {k: f[k] for k in FINDING_ORDER if k in f} if isinstance(f, dict) else f
        for f in meta.get("findings") or []
    ]
    for f in findings:
        if isinstance(f, dict):
            f.setdefault("shown_as", "normal")
            f.setdefault("lessons", [])
    shown = [f for f in findings if isinstance(f, dict)]
    full = [f for f in shown if f.get("tier") in ("B", "M") and f.get("shown_as") in ("normal", "explore")]
    fm = {
        "review_id": review_id(meta.get("host"), meta.get("org"), meta.get("repo"),
                               pr_ref(meta.get("pr"), meta.get("branch")), round_),
        "host": meta.get("host"),
        "org": meta.get("org"),
        "repo": meta.get("repo"),
        "pr": meta.get("pr"),
        "round": round_,
        "branch": meta.get("branch"),
        "base_sha": meta.get("base_sha"),
        "head_sha": meta.get("head_sha"),
        "date": meta.get("date"),
        "context_prs": meta.get("context_prs", []),
        "skill_sha": skill_sha,
        "lens_versions": lens_versions,
        **({"lens_versions_missing": lens_missing} if lens_missing else {}),
        "lessons_applied": [],
        "lessons_shadow": [],
        "diff_stats": meta.get("diff_stats"),
        "items_shown_full": len(full),
        "items_shown_total": len(shown),
        "verdict": meta.get("verdict"),
        "tally": tally_of(findings),
        "findings": findings,
    }
    return fm


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _enum(f, key, allowed, where, errs):
    if f.get(key) not in allowed:
        errs.append(f"{where}.{key}: {f.get(key)!r} not in {'|'.join(allowed)}")


def _validate_finding(f, i, slugs, body, errs):
    where = f"findings[{i}]"
    if not isinstance(f, dict):
        errs.append(f"{where}: must be a mapping")
        return
    fid = f.get("id")
    tier = f.get("tier")
    _enum(f, "tier", TIERS, where, errs)
    if not (isinstance(fid, str) and re.fullmatch(r"[BMQIGTOF]\d+", fid)):
        errs.append(f"{where}.id: {fid!r} must look like B1, M2, Q1, I3, G1, T1, O1, F1")
    elif tier in TIERS and fid[0] != tier:
        errs.append(f"{where}.id: {fid!r} does not start with its tier {tier!r}")
    elif tier != "F" and not re.search(rf"\b{fid}\b", body):
        errs.append(f"{where}.id: {fid!r} does not appear in the report body")
    if f.get("category") not in slugs:
        errs.append(f"{where}.category: {f.get('category')!r} is not in the taxonomy")
    _enum(f, "code_kind", CODE_KINDS, where, errs)
    _enum(f, "premise", PREMISES, where, errs)
    _enum(f, "kind", KINDS, where, errs)
    _enum(f, "shown_as", SHOWN_AS, where, errs)
    lens, sev = f.get("lens"), f.get("lens_sev")
    if not (isinstance(lens, list) and lens and all(l in LENSES for l in lens)):
        errs.append(f"{where}.lens: must be a non-empty list of {'|'.join(LENSES)}")
    elif not (isinstance(sev, list) and len(sev) == len(lens)):
        errs.append(f"{where}.lens_sev: must be a list with one entry per lens")
    loc = f.get("location")
    if not (isinstance(loc, dict) and loc.get("path") and loc.get("lines") not in (None, "")):
        errs.append(f"{where}.location: needs path and lines")
    if not (isinstance(f.get("title"), str) and f["title"].strip()):
        errs.append(f"{where}.title: must be a non-empty string")
    if not (_is_int(f.get("rank")) and f["rank"] >= 1):
        errs.append(f"{where}.rank: must be an integer >= 1")
    if not isinstance(f.get("lessons"), list):
        errs.append(f"{where}.lessons: must be a list")


def validate_report(fm, body, slugs):
    """Return a list of 'key: message' strings; empty means valid."""
    errs = []
    if not isinstance(fm, dict):
        return ["frontmatter: missing or not a mapping"]
    backfill = fm.get("backfill") is True
    for key in KEY_ORDER:
        if key not in fm:
            errs.append(f"{key}: missing key")
    if errs:
        return errs
    for key in ("host", "org", "repo"):
        if not (isinstance(fm[key], str) and fm[key].strip()):
            errs.append(f"{key}: must be a non-empty string")
    if fm["pr"] is not None and not (_is_int(fm["pr"]) and fm["pr"] >= 1):
        errs.append("pr: must be a positive integer or null")
    if fm["pr"] is None and not (isinstance(fm["branch"], str) and fm["branch"].strip()):
        errs.append("branch: required when pr is null")
    if not (_is_int(fm["round"]) and fm["round"] >= 1):
        errs.append("round: must be an integer >= 1")
    for key in ("base_sha", "head_sha"):
        v = fm[key]
        if not ((isinstance(v, str) and GIT_SHA_RE.match(v)) or (backfill and v is None)):
            errs.append(f"{key}: must be a 7-40 char hex sha")
    if not (isinstance(fm["date"], str) and DATE_RE.match(fm["date"])):
        errs.append("date: must be a quoted UTC timestamp like 2026-01-31T09:30:00Z")
    if not (isinstance(fm["context_prs"], list)):
        errs.append("context_prs: must be a list")
    sha = fm["skill_sha"]
    if not ((isinstance(sha, str) and HEX8_RE.match(sha)) or (backfill and sha == "backfill")):
        errs.append("skill_sha: must be 8 hex chars (or 'backfill' with backfill: true)")
    lv = fm["lens_versions"]
    if not (isinstance(lv, dict) and set(lv) in (set(LENSES), set(LEGACY_LENSES))):
        errs.append(f"lens_versions: must have exactly the keys {', '.join(LENSES)} "
                    f"(reports written before pablo-test-review may omit it)")
    else:
        why = fm.get("lens_versions_missing")
        why = why if isinstance(why, dict) else {}
        for name, v in lv.items():
            null_ok = backfill or (isinstance(why.get(name), str) and why[name].strip())
            if not ((isinstance(v, str) and HEX8_RE.match(v)) or (v is None and null_ok)):
                errs.append(f"lens_versions.{name}: must be 8 hex chars "
                            f"(null only with a lens_versions_missing reason)")
    for key in ("lessons_applied", "lessons_shadow"):
        if not isinstance(fm[key], list):
            errs.append(f"{key}: must be a list")
    ds = fm["diff_stats"]
    if not (isinstance(ds, dict) and all(_is_int(ds.get(k)) for k in ("files", "additions", "deletions"))):
        errs.append("diff_stats: needs integer files, additions, deletions")
    findings = fm["findings"]
    if not isinstance(findings, list):
        return errs + ["findings: must be a list"]
    ids = [f.get("id") for f in findings if isinstance(f, dict)]
    for fid in {i for i in ids if ids.count(i) > 1}:
        errs.append(f"findings: duplicate id {fid!r}")
    for i, f in enumerate(findings):
        _validate_finding(f, i, slugs, body, errs)
    if fm["verdict"] not in VERDICTS:
        errs.append(f"verdict: {fm['verdict']!r} not in {'|'.join(VERDICTS)}")
    tally = tally_of(findings)
    if fm["tally"] != tally:
        errs.append(f"tally: {fm['tally']} does not match findings {tally}")
    elif fm["verdict"] in VERDICTS and not backfill and fm["verdict"] != expected_verdict(tally):
        errs.append(f"verdict: {fm['verdict']} but tally {tally} gives {expected_verdict(tally)}")
    shown = [f for f in findings if isinstance(f, dict)]
    full = [f for f in shown if f.get("tier") in ("B", "M") and f.get("shown_as") in ("normal", "explore")]
    if fm["items_shown_full"] != len(full):
        errs.append(f"items_shown_full: {fm['items_shown_full']} but findings give {len(full)}")
    if fm["items_shown_total"] != len(shown):
        errs.append(f"items_shown_total: {fm['items_shown_total']} but findings give {len(shown)}")
    if "feedback" in fm:
        errs += validate_feedback(fm["feedback"], ids)
    return errs


def validate_feedback(fb, finding_ids):
    """Errors for a report's `feedback` block; ids must belong to the report's findings."""
    if not isinstance(fb, dict):
        return ["feedback: must be a mapping"]
    errs = []
    if not (isinstance(fb.get("harvested_at"), str) and DATE_RE.match(fb["harvested_at"])):
        errs.append("feedback.harvested_at: must be a UTC timestamp like 2026-01-31T09:30:00Z")
    outcomes = fb.get("outcomes")
    if not isinstance(outcomes, list):
        errs.append("feedback.outcomes: must be a list")
        outcomes = []
    seen = []
    for i, o in enumerate(outcomes):
        where = f"feedback.outcomes[{i}]"
        if not isinstance(o, dict):
            errs.append(f"{where}: must be a mapping")
            continue
        if o.get("id") not in finding_ids:
            errs.append(f"{where}.id: {o.get('id')!r} is not a finding of this report")
        if o.get("id") in seen:
            errs.append(f"{where}.id: duplicate {o.get('id')!r}")
        seen.append(o.get("id"))
        _enum(o, "outcome", OUTCOMES, where, errs)
        if o.get("form") is not None:
            _enum(o, "form", FORMS, where, errs)
        elif o.get("outcome") in ("posted", "partial"):
            errs.append(f"{where}.form: required when outcome is posted or partial")
        _enum(o, "match", MATCHES, where, errs)
        if o.get("reason") is not None:
            _enum(o, "reason", REASONS, where, errs)
        ids = o.get("comment_ids")
        if not (isinstance(ids, list) and all(_is_int(c) for c in ids)):
            errs.append(f"{where}.comment_ids: must be a list of integers")
        elif o.get("outcome") in ("posted", "partial") and not ids:
            errs.append(f"{where}.comment_ids: required when outcome is posted or partial")
    for key in ("recall_misses", "this_pr_only", "wiki_proposals"):
        if not isinstance(fb.get(key), list):
            errs.append(f"feedback.{key}: must be a list")
    if isinstance(fb.get("this_pr_only"), list):
        for fid in fb["this_pr_only"]:
            if fid not in finding_ids:
                errs.append(f"feedback.this_pr_only: {fid!r} is not a finding of this report")
    return errs


def merge_feedback(old, new):
    """Merge a feedback block into the existing one: outcomes by id (new wins), lists unioned."""
    old = old if isinstance(old, dict) else {}
    merged = {k: old[k] for k in FEEDBACK_KEYS if k in old}
    by_id = {o["id"]: o for o in merged.get("outcomes", []) if isinstance(o, dict) and "id" in o}
    for o in new.get("outcomes") or []:
        if isinstance(o, dict) and "id" in o:
            by_id[o["id"]] = o
        else:
            by_id[repr(o)] = o
    out = {
        "harvested_at": new.get("harvested_at") or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "outcomes": list(by_id.values()),
    }
    for key in ("recall_misses", "this_pr_only", "wiki_proposals"):
        items = list(merged.get(key, []))
        items += [x for x in new.get(key) or [] if x not in items]
        out[key] = items
    return out


def split_report(text):
    m = re.match(r"^---\n(.*?)\n---\n(.*)\Z", text, flags=re.S)
    if not m:
        return None, text
    return yaml.safe_load(m.group(1)), m.group(2)


def render_report(fm, body):
    return "---\n" + yaml.safe_dump(fm, sort_keys=False, allow_unicode=True) + "---\n" + body


# --- IO ---------------------------------------------------------------------

def write_report(meta, body, root=SKILL_DIR, backfill=False):
    """Validate and write one ledger file; returns its Path. Raises ValueError with all errors."""
    missing = [f"{k}: missing key in meta" for k in INPUT_KEYS if k not in meta and k not in ("branch", "context_prs", "pr")]
    if missing:
        raise ValueError("\n".join(missing))
    meta = dict(meta)
    meta.setdefault("date", dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    meta.setdefault("pr", None)
    meta.setdefault("branch", None)
    prefix = file_prefix(meta["pr"], meta["branch"])
    repo_dir = Path(root) / "reviews" / str(meta["repo"])
    names = [p.name for p in repo_dir.glob("*.md")] if repo_dir.is_dir() else []
    round_ = next_round(names, prefix)
    if backfill:
        skill_sha, lens_versions = "backfill", {n: None for n in LENSES}
        lens_missing = None
    else:
        skill_sha = lens_sha(SKILL_DIR)
        lens_versions, lens_missing = lens_versions_for(SKILL_DIR.parent)
    if backfill:
        lens_missing = None
    fm = build_frontmatter(meta, round_, skill_sha, lens_versions, lens_missing)
    if backfill:
        fm["backfill"] = True
    errs = validate_report(fm, body, taxonomy())
    if errs:
        raise ValueError("\n".join(errs))
    path = repo_dir / f"{prefix}-r{round_}-{meta['date'][:10]}.md"
    repo_dir.mkdir(parents=True, exist_ok=True)
    with open(path, "x", encoding="utf-8") as fh:
        fh.write(render_report(fm, body))
    return path


def set_feedback(report, feedback):
    """Merge `feedback` into the report's frontmatter, re-validate, rewrite. Raises ValueError."""
    path = Path(report)
    fm, body = split_report(path.read_text(encoding="utf-8"))
    if not isinstance(fm, dict):
        raise ValueError("frontmatter: missing or not a mapping")
    if not isinstance(feedback, dict):
        raise ValueError("feedback: must be a mapping")
    fm["feedback"] = merge_feedback(fm.get("feedback"), feedback)
    errs = validate_report(fm, body, taxonomy())
    if errs:
        raise ValueError("\n".join(errs))
    path.write_text(render_report(fm, body), encoding="utf-8")
    return path


# --- CLI --------------------------------------------------------------------

def _cmd_write(a):
    meta = json.loads(sys.stdin.read() if a.meta == "-" else Path(a.meta).read_text(encoding="utf-8") if Path(a.meta).is_file() else a.meta)
    body = Path(a.body).read_text(encoding="utf-8")
    try:
        print(write_report(meta, body, a.root, a.backfill))
    except ValueError as e:
        print(e, file=sys.stderr)
        return 1
    return 0


def _cmd_validate(a):
    bad = 0
    slugs = taxonomy()
    for p in a.paths:
        fm, body = split_report(Path(p).read_text(encoding="utf-8"))
        for e in validate_report(fm, body, slugs):
            print(f"{p}: {e}")
            bad += 1
    return 1 if bad else 0


def _cmd_feedback(a):
    try:
        feedback = json.loads(Path(a.feedback).read_text(encoding="utf-8"))
        print(set_feedback(a.report, feedback))
    except (ValueError, OSError) as e:
        print(e, file=sys.stderr)
        return 1
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("write-report")
    w.add_argument("--meta", required=True, help="JSON text, a JSON file path, or - for stdin")
    w.add_argument("--body", required=True, help="markdown file with the verbatim report")
    w.add_argument("--root", default=SKILL_DIR, help="directory that holds reviews/")
    w.add_argument("--backfill", action="store_true")
    w.set_defaults(fn=_cmd_write)
    v = sub.add_parser("validate")
    v.add_argument("paths", nargs="+")
    v.set_defaults(fn=_cmd_validate)
    r = sub.add_parser("review-id")
    r.add_argument("host"); r.add_argument("org"); r.add_argument("repo")
    r.add_argument("pr", help="PR number or branch:NAME"); r.add_argument("round", type=int)
    r.set_defaults(fn=lambda a: print(review_id(a.host, a.org, a.repo, a.pr, a.round)) or 0)
    s = sub.add_parser("lens-sha")
    s.add_argument("dir")
    s.set_defaults(fn=lambda a: print(lens_sha(a.dir)) or 0)
    f = sub.add_parser("set-feedback")
    f.add_argument("report"); f.add_argument("feedback", help="JSON file with the feedback block")
    f.set_defaults(fn=_cmd_feedback)
    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
