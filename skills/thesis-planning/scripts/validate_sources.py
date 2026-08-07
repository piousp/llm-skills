#!/usr/bin/env python3
"""Validate a literature-scout JSON output against the schema in
lens/literature-scout-lens.md before the coordinator persists it.

Read-only checker: prints a report, exits non-zero if any record is rejected.
Rejects (does not just warn on) any record with verified_by_read: false —
those are quarantined, never silently persisted as verified sources.
"""
import argparse
import json
import re
import sys

REQUIRED_FIELDS = [
    "url", "doi", "title", "authors", "year", "venue", "abstract",
    "abstract_source", "keywords", "relevance", "relevance_reason",
    "verified_by_read",
]
RELEVANCE_VALUES = {"high", "medium", "low"}
ABSTRACT_SOURCE_VALUES = {"verbatim", "paraphrased", "unavailable"}
URL_RE = re.compile(r"^https?://\S+$")


def validate_record(rec, idx):
    errors = []
    for field in REQUIRED_FIELDS:
        if field not in rec:
            errors.append(f"record {idx}: missing field '{field}'")
    if errors:
        return errors  # can't check further without required fields

    if not isinstance(rec["url"], str) or not URL_RE.match(rec["url"]):
        errors.append(f"record {idx}: invalid url '{rec['url']}'")

    if rec["doi"] is not None and not isinstance(rec["doi"], str):
        errors.append(f"record {idx}: doi must be string or null")

    if not isinstance(rec["title"], str) or not rec["title"].strip():
        errors.append(f"record {idx}: title must be a non-empty string")

    if not isinstance(rec["authors"], list):
        errors.append(f"record {idx}: authors must be a list")

    if rec["year"] is not None and not isinstance(rec["year"], (int, float)):
        errors.append(f"record {idx}: year must be number or null")

    if not isinstance(rec["keywords"], list):
        errors.append(f"record {idx}: keywords must be a list")

    if rec["venue"] is not None and not isinstance(rec["venue"], str):
        errors.append(f"record {idx}: venue must be string or null")

    if not isinstance(rec["abstract"], str):
        errors.append(f"record {idx}: abstract must be a string")

    if not all(isinstance(a, str) for a in rec["authors"]):
        errors.append(f"record {idx}: authors must be a list of strings")

    if rec["relevance"] not in RELEVANCE_VALUES:
        errors.append(
            f"record {idx}: relevance must be one of {sorted(RELEVANCE_VALUES)}"
        )

    if not isinstance(rec["relevance_reason"], str) or not rec[
        "relevance_reason"
    ].strip():
        errors.append(f"record {idx}: relevance_reason must be a non-empty string")

    if rec["abstract_source"] not in ABSTRACT_SOURCE_VALUES:
        errors.append(
            f"record {idx}: abstract_source must be one of "
            f"{sorted(ABSTRACT_SOURCE_VALUES)}"
        )

    if not isinstance(rec["verified_by_read"], bool):
        errors.append(f"record {idx}: verified_by_read must be a boolean")

    return errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("json_file", help="path to a literature-scout JSON array")
    args = ap.parse_args()

    with open(args.json_file, encoding="utf-8") as f:
        records = json.load(f)

    if isinstance(records, dict) and records.get("result") == "no_results":
        report = {
            "result": "no_results",
            "note": records.get("note"),
            "queries_tried": records.get("queries_tried", []),
            "ceiling_hit": records.get("ceiling_hit", False),
            "total": 0, "verified": 0, "quarantined": 0, "rejected": 0,
        }
        json.dump(report, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
        sys.exit(0)

    if not isinstance(records, list):
        print("ERROR: top-level JSON must be an array", file=sys.stderr)
        sys.exit(2)

    verified, quarantined, rejected = [], [], []

    for idx, rec in enumerate(records):
        errors = validate_record(rec, idx)
        if errors:
            rejected.append({"index": idx, "errors": errors})
            continue
        if rec["verified_by_read"] is True:
            verified.append(rec)
        else:
            quarantined.append(rec)

    report = {
        "total": len(records),
        "verified": len(verified),
        "quarantined": len(quarantined),
        "rejected": len(rejected),
        "rejected_detail": rejected,
        "quarantined_urls": [r["url"] for r in quarantined],
    }
    json.dump(report, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")

    if rejected:
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
