#!/usr/bin/env python3
"""Read-only, advisory state reporter for the thesis-planning skill.

Reads $THESIS_DIR's artifacts and prints JSON describing the current phase,
next action, gate status, and (for Phase 4) which chapters remain. Never
writes, never prompts, never picks a phase for the user. No git dependency —
thesis state is artifact existence plus chapter status parsed from
outline.md, not commit history.
"""
import argparse
import json
import os
import re
import sys

CHAPTER_STATUSES = {"pending", "drafting", "drafted", "revised"}
DONE_STATUSES = {"drafted", "revised"}
SLUG_RE = re.compile(r"[^a-z0-9]+")
FEEDBACK_HEADER_RE = re.compile(
    r"^## \d{4}-\d{2}-\d{2} \| .+? \| v\d+ \| (open|addressed|rejected)\s*$",
    re.IGNORECASE,
)
RESOLUTION_RE = re.compile(r"^Resolution:\s*(.+)$")


def read(path):
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            return f.read()
    return None


def parse_chapters(outline_text):
    """Extract (name, status) pairs from outline.md.

    Only matches numbered-list lines ("1. Chapter Name: status=drafting"),
    never bare headers (`#`) or bullets (`-`/`*`) — a real outline mixes
    structural headers (title, appendix notes) with chapters, and a heading-
    based matcher can't tell them apart (dogfooding found this: an H1 title
    and an unrelated H2 note were both misread as pending chapters). Numbered
    chapters are also how a working table of contents is naturally written.
    Falls back to status=pending for a numbered entry with no recognizable
    status token.
    """
    if not outline_text:
        return []
    chapters = []
    for line in outline_text.splitlines():
        m = re.match(r"\d+\.\s+(?P<name>[^:(\n]+)", line)
        if not m:
            continue
        name = m.group("name").strip()
        if not name:
            continue
        status_m = re.search(
            r"status\s*[:=]\s*(" + "|".join(CHAPTER_STATUSES) + r")",
            line,
            re.IGNORECASE,
        )
        status = status_m.group(1).lower() if status_m else "pending"
        chapters.append({"name": name, "status": status})
    return chapters


def slugify(name):
    """Best-effort chapter-name-to-slug match against chapters/<slug>.md.

    Not guaranteed to match the coordinator's actual filename choice exactly
    (accents, punctuation) — used only to flag likely inconsistencies, not as
    an authoritative mapping.
    """
    return SLUG_RE.sub("-", name.strip().lower()).strip("-")


def warn_rejected_without_resolution(thesis_dir, slug):
    """Emit a stderr warning for each 'rejected' entry missing a non-empty
    Resolution: line.

    The feedback contract (SKILL.md Phase 4c) requires a one-line reason when
    a reviewer comment is rejected; nothing in the script checks it, so a
    'rejected' status could pass silently. Advisory only — never changes exit
    codes.
    """
    path = os.path.join(thesis_dir, "chapters", f"{slug}.feedback.md")
    text = read(path)
    if not text:
        return
    lines = text.splitlines()
    for i, line in enumerate(lines):
        stripped = line.strip()
        m = FEEDBACK_HEADER_RE.match(stripped)
        if not m or m.group(1).lower() != "rejected":
            continue
        block = lines[i + 1 :]
        end = len(block)
        for j, l in enumerate(block):
            if l.strip().startswith("##"):
                end = j
                break
        has_resolution = any(RESOLUTION_RE.match(l.strip()) for l in block[:end])
        if not has_resolution:
            print(
                f"warning: 'rejected' entry in {slug}.feedback.md lacks a "
                f"non-empty Resolution: line: {stripped!r}",
                file=sys.stderr,
            )


def count_open_feedback(thesis_dir, slug):
    """Count 'open' entries in chapters/<slug>.feedback.md.

    Malformed headers (no recognizable status) are ignored, never crash the
    script — this file is hand-edited prose, not machine-generated.
    """
    path = os.path.join(thesis_dir, "chapters", f"{slug}.feedback.md")
    text = read(path)
    if not text:
        return 0
    open_count = 0
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("##"):
            continue
        m = FEEDBACK_HEADER_RE.match(stripped)
        if m and m.group(1).lower() == "open":
            open_count += 1
        elif m is None:
            print(
                f"warning: unrecognized feedback header in {slug}.feedback.md: "
                f"{stripped!r} (expected '## YYYY-MM-DD | reviewer | vNN | status')",
                file=sys.stderr,
            )
    return open_count


def count_snapshots(thesis_dir, slug):
    """Count chapters/history/<slug>.vNN.md snapshots for this chapter."""
    history_dir = os.path.join(thesis_dir, "chapters", "history")
    if not os.path.isdir(history_dir):
        return 0
    pattern = re.compile(r"^" + re.escape(slug) + r"\.v\d+\.md$")
    return sum(1 for f in os.listdir(history_dir) if pattern.match(f))


def check_chapter_files(chapters, thesis_dir):
    """Cross-check outline.md's claimed status against the environment.

    Bug found by dogfooding retrospective (DR-4): trusting outline.md's status
    field alone lets a chapter marked drafted/revised report as done with no
    file ever written — exactly the outcome-vs-transcript failure mode
    evaluating-agent-skills warns about. Extended for the feedback/versioning
    mechanism: `revised` additionally requires at least one snapshot in
    chapters/history/ and zero open feedback entries — a status claim without
    either is flagged inconsistent and treated as still outstanding, never
    silently trusted.

    Mutates each chapter dict in place with on_disk/has_skeleton/versions/
    open_feedback, and returns the list of inconsistent chapter names.
    """
    chapters_dir = os.path.join(thesis_dir, "chapters")
    existing_files = set()
    if os.path.isdir(chapters_dir):
        existing_files = {
            f for f in os.listdir(chapters_dir)
            if os.path.isfile(os.path.join(chapters_dir, f))
        }

    inconsistent = []
    for c in chapters:
        slug = slugify(c["name"])
        on_disk = f"{slug}.md" in existing_files
        versions = count_snapshots(thesis_dir, slug)
        open_feedback = count_open_feedback(thesis_dir, slug)
        warn_rejected_without_resolution(thesis_dir, slug)

        c["on_disk"] = on_disk
        c["has_skeleton"] = f"{slug}.skeleton.md" in existing_files
        c["versions"] = versions
        c["open_feedback"] = open_feedback

        if c["status"] in DONE_STATUSES and not on_disk:
            inconsistent.append(c["name"])
        elif c["status"] == "revised" and (versions == 0 or open_feedback > 0):
            inconsistent.append(c["name"])
    return inconsistent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="$THESIS_DIR path")
    args = ap.parse_args()

    d = args.dir
    sources = read(os.path.join(d, "sources-initial.md"))
    question = read(os.path.join(d, "research-question.md"))
    litmap = read(os.path.join(d, "literature-map.md"))
    outline = read(os.path.join(d, "outline.md"))

    result = {
        "thesis_dir": d,
        "phase": None,
        "next_action": None,
        "gate_status": "n/a",
        "required_inputs": [],
        "remaining_chapters": [],
    }

    if question is None:
        result["phase"] = 1
        result["next_action"] = "Exploratory reading; draft research-question.md"
        result["required_inputs"] = ["sources-initial.md", "research-question.md"]
        if sources is None:
            result["gate_status"] = "not-started"
        else:
            result["gate_status"] = "unanswered"  # awaiting user confirmation of Q
    elif litmap is None:
        result["phase"] = 2
        result["next_action"] = "Build literature-map.md grouped by theme"
        result["required_inputs"] = ["literature-map.md"]
    elif outline is None:
        result["phase"] = 3
        result["next_action"] = "Draft outline.md (working table of contents)"
        result["required_inputs"] = ["outline.md"]
    else:
        chapters = parse_chapters(outline)
        inconsistent = check_chapter_files(chapters, d)
        result["inconsistent_chapters"] = inconsistent
        # A chapter claimed drafted/revised with no file on disk, or revised
        # without a snapshot + zero open feedback, is not done — the
        # environment's actual state overrides outline.md's claim (see
        # check_chapter_files docstring).
        remaining = [
            c
            for c in chapters
            if c["status"] in ("pending", "drafting") or c["name"] in inconsistent
        ]
        result["remaining_chapters"] = remaining
        if remaining:
            result["phase"] = 4
            names = ", ".join(c["name"] for c in remaining)
            result["next_action"] = f"Draft or continue chapters: {names}"
            if inconsistent:
                result["next_action"] += (
                    f" (WARNING: status claim not backed by environment state: "
                    f"{', '.join(inconsistent)})"
                )
        else:
            result["phase"] = 5
            result["next_action"] = (
                "All chapters drafted/revised; optional reverse-outline pass"
            )
            result["gate_status"] = "unanswered"

    json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
