#!/usr/bin/env python3
"""Layer 1 (offline, free) tests for scripts/validate_sources.py."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))
import validate_sources as vs  # noqa: E402

GOOD_RECORD = {
    "url": "https://arxiv.org/abs/2506.04290",
    "doi": None,
    "title": "Test Paper",
    "authors": ["A. Author"],
    "year": 2025,
    "venue": "arXiv",
    "abstract": "test abstract",
    "abstract_source": "verbatim",
    "keywords": ["llm", "credit"],
    "relevance": "high",
    "relevance_reason": "directly addresses gap X",
    "verified_by_read": True,
}


class ValidateRecordTest(unittest.TestCase):
    def test_valid_record_no_errors(self):
        self.assertEqual(vs.validate_record(GOOD_RECORD, 0), [])

    def test_missing_field(self):
        rec = dict(GOOD_RECORD)
        del rec["relevance_reason"]
        errors = vs.validate_record(rec, 0)
        self.assertTrue(any("relevance_reason" in e for e in errors))

    def test_bad_url_rejected(self):
        rec = dict(GOOD_RECORD, url="not-a-url")
        errors = vs.validate_record(rec, 0)
        self.assertTrue(any("invalid url" in e for e in errors))

    def test_invented_doi_type_rejected(self):
        rec = dict(GOOD_RECORD, doi=123)
        errors = vs.validate_record(rec, 0)
        self.assertTrue(any("doi" in e for e in errors))

    def test_doi_null_is_valid(self):
        rec = dict(GOOD_RECORD, doi=None)
        self.assertEqual(vs.validate_record(rec, 0), [])

    def test_invalid_relevance_enum(self):
        rec = dict(GOOD_RECORD, relevance="extreme")
        errors = vs.validate_record(rec, 0)
        self.assertTrue(any("relevance must be one of" in e for e in errors))

    def test_invalid_abstract_source_enum(self):
        rec = dict(GOOD_RECORD, abstract_source="bogus")
        errors = vs.validate_record(rec, 0)
        self.assertTrue(any("abstract_source must be one of" in e for e in errors))

    def test_verified_by_read_must_be_bool(self):
        rec = dict(GOOD_RECORD, verified_by_read="yes")
        errors = vs.validate_record(rec, 0)
        self.assertTrue(any("verified_by_read must be a boolean" in e for e in errors))


class MainReportTest(unittest.TestCase):
    def run_validate(self, records):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(records, f)
            path = f.name
        sys.argv = ["validate_sources.py", path]
        import io
        import contextlib

        buf = io.StringIO()
        exit_code = None
        with contextlib.redirect_stdout(buf):
            try:
                vs.main()
            except SystemExit as e:
                exit_code = e.code
        return json.loads(buf.getvalue()), exit_code

    def test_all_verified_exits_zero(self):
        report, code = self.run_validate([GOOD_RECORD])
        self.assertEqual(code, 0)
        self.assertEqual(report["verified"], 1)
        self.assertEqual(report["quarantined"], 0)
        self.assertEqual(report["rejected"], 0)

    def test_unverified_is_quarantined_not_rejected(self):
        rec = dict(GOOD_RECORD, verified_by_read=False)
        report, code = self.run_validate([rec])
        self.assertEqual(code, 0)
        self.assertEqual(report["quarantined"], 1)
        self.assertIn(GOOD_RECORD["url"], report["quarantined_urls"])

    def test_malformed_record_exits_nonzero(self):
        rec = dict(GOOD_RECORD, url="not-a-url")
        report, code = self.run_validate([rec])
        self.assertEqual(code, 1)
        self.assertEqual(report["rejected"], 1)


if __name__ == "__main__":
    unittest.main()
