#!/usr/bin/env python3
"""Lint ml-lessons/ (the tracked, public lessons) for leaked internal names (stdlib + PyYAML).

    lint_ml_lessons.py [--root DIR]

--root holds ml-lessons/ and, when present, reviews/ and repo-lessons/ (default: this skill). Exit 0
when clean, 1 with one `file:line: reason` per finding, 2 when ml-lessons/ does not exist.

Checks (references/learning-loop.md, plan section 4.5):
  - repo names (reviews/ and repo-lessons/ directory names, report `repo`), report `org` and `host`
    values: read at RUNTIME from the git-ignored ledger, never hard-coded here;
  - a '/' inside any whitespace-delimited token (paths, urls; write "or", not "a/b");
  - ticket keys [A-Z]{2,}-\\d+; file names ending .java or .scala;
  - class-like identifiers (CamelCase with 2+ capitals) except ALLOW_CLASS_LIKE;
  - evidence.refs that are not rv-<8 hex>[#<tier letter><number>];
  - a body over 6 non-blank lines; more than 25 approved lessons.
repo-lessons/ is internal and is NOT linted (it only feeds the name denylist).
"""

import argparse
import re
import sys
from pathlib import Path

import yaml

import store

BODY_MAX = 6
APPROVED_MAX = 25
# Product names that look CamelCase but are public vocabulary, not internal identifiers.
ALLOW_CLASS_LIKE = {"JavaScript", "TypeScript", "GitHub"}
TICKET = re.compile(r"[A-Z]{2,}-\d+")
JAVA_SCALA = re.compile(r"\.(java|scala)\b")
CLASS_LIKE = re.compile(r"\b[A-Z][a-z]+[A-Z]\w*\b")
REF_OK = re.compile(r"^rv-[0-9a-f]{8}(#[A-Z]\d+)?$")
TOKEN_EDGE = "`\"'()[]{}<>,;:.!?"
MIN_NAME = 3  # shorter values would match everywhere


def runtime_names(root):
    """Repo names, orgs and hosts found in the (git-ignored) ledger and repo-lessons under root."""
    root = Path(root)
    names = set()
    for base in ("reviews", "repo-lessons"):
        d = root / base
        if d.is_dir():
            names |= {p.name for p in d.iterdir() if p.is_dir() and not p.name.startswith("_")}
    reviews = root / "reviews"
    if reviews.is_dir():
        for path in reviews.glob("*/*.md"):
            if path.parent.name == "_meta":
                continue
            try:
                fm, _ = store.split_report(path.read_text(encoding="utf-8"))
            except (OSError, yaml.YAMLError):
                continue
            if isinstance(fm, dict):
                names |= {str(fm[k]) for k in ("repo", "org", "host") if isinstance(fm.get(k), str)}
    return sorted(n for n in names if len(n) >= MIN_NAME)


def _name_regex(names):
    if not names:
        return None
    alt = "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True))
    return re.compile(rf"(?<![A-Za-z0-9])(?:{alt})(?![A-Za-z0-9])", re.I)


def _split(text):
    """(frontmatter dict | None, index of the first body line | None) over text.splitlines()."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            try:
                fm = yaml.safe_load("\n".join(lines[1:i]))
            except yaml.YAMLError:
                return None, None
            return (fm if isinstance(fm, dict) else None), i + 1
    return None, None


def _line_of(lines, needle, default=1):
    for i, line in enumerate(lines, 1):
        if needle in line:
            return i
    return default


def lint_file(path, rel, name_re):
    """List of (line, reason) for one lesson file."""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    out = []
    fm, body_start = _split(text)
    if fm is None:
        return [(1, "missing or invalid YAML frontmatter")]
    for n, line in enumerate(lines, 1):
        if name_re:
            for m in name_re.finditer(line):
                out.append((n, f"internal name '{m.group(0)}' (repo, org or host)"))
        for tok in line.split():
            tok = tok.strip(TOKEN_EDGE)
            if "/" in tok:
                out.append((n, f"'/' inside token '{tok}' (path or url)"))
        m = TICKET.search(line)
        if m:
            out.append((n, f"ticket key '{m.group(0)}'"))
        m = JAVA_SCALA.search(line)
        if m:
            out.append((n, f"source file name '{m.group(0)}'"))
        for m in CLASS_LIKE.finditer(line):
            if m.group(0) not in ALLOW_CLASS_LIKE:
                out.append((n, f"class-like identifier '{m.group(0)}'"))
    refs = (fm.get("evidence") or {}).get("refs") if isinstance(fm.get("evidence"), dict) else None
    for ref in refs or []:
        if not (isinstance(ref, str) and REF_OK.match(ref)):
            out.append((_line_of(lines, str(ref), _line_of(lines, "refs")),
                        f"evidence ref '{ref}' is not rv-<8 hex>[#<id>]"))
    body = [(i, ln) for i, ln in enumerate(lines[body_start:], body_start + 1) if ln.strip()]
    if len(body) > BODY_MAX:
        out.append((body[BODY_MAX][0], f"body has {len(body)} non-blank lines (max {BODY_MAX})"))
    return out


def lint_root(root):
    """(findings, approved_count): findings are (relative file, line, reason) tuples."""
    root = Path(root)
    name_re = _name_regex(runtime_names(root))
    findings, approved = [], 0
    for path in sorted((root / "ml-lessons").glob("*.md")):
        rel = path.relative_to(root).as_posix()
        findings += [(rel, n, why) for n, why in lint_file(path, rel, name_re)]
        fm, _ = _split(path.read_text(encoding="utf-8"))
        if fm and fm.get("status") == "approved":
            approved += 1
    if approved > APPROVED_MAX:
        findings.append(("ml-lessons", 1, f"{approved} approved lessons (max {APPROVED_MAX})"))
    return findings, approved


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=store.SKILL_DIR, help="directory holding ml-lessons/ (and the ledger)")
    a = ap.parse_args(argv)
    if not (Path(a.root) / "ml-lessons").is_dir():
        print(f"{a.root}: no ml-lessons/ directory", file=sys.stderr)
        return 2
    findings, _ = lint_root(a.root)
    for rel, n, why in findings:
        print(f"{rel}:{n}: {why}")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
