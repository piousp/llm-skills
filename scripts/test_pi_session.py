"""
Unit tests for scripts/pi_session.py - session working directory resolver.

Seams:
1. Pure function: resolve_session_dir(session_file, session_id) -> Path.
   Expected values are literal paths, computed independently of the implementation.
2. CLI (subprocess with controlled env): exit code, stdout format, dir
   creation on disk, --json payload.

Run: python3 -m unittest test_pi_session -v   (from scripts/)
  or: python3 test_pi_session.py
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "pi_session.py"

spec = importlib.util.spec_from_file_location("pi_session", SCRIPT)
pi_session = importlib.util.module_from_spec(spec)
sys.modules["pi_session"] = pi_session
spec.loader.exec_module(pi_session)


class ResolveSessionDirTests(unittest.TestCase):
    def test_persistent_session_file_yields_sibling_files_dir(self):
        session_file = (
            "/home/user/.pi/agent/sessions/--proj--/"
            "2026-08-10T22-32-16-734Z_019fedce-205e-73cf-b6f1-95e73fef7da0.jsonl"
        )
        expected = Path(
            "/home/user/.pi/agent/sessions/--proj--/"
            "2026-08-10T22-32-16-734Z_019fedce-205e-73cf-b6f1-95e73fef7da0.files"
        )
        self.assertEqual(
            pi_session.resolve_session_dir(
                session_file, "019fedce-205e-73cf-b6f1-95e73fef7da0"
            ),
            expected,
        )

    def test_empty_session_file_falls_back_to_ephemeral_dir(self):
        # pi sets PI_SESSION_FILE="" in RPC mode when no session file exists.
        self.assertEqual(
            pi_session.resolve_session_dir(
                "", "019fedce-205e-73cf-b6f1-95e73fef7da0"
            ),
            Path("/tmp/pi/session/019fedce-205e-73cf-b6f1-95e73fef7da0"),
        )

    def test_both_unset_raises(self):
        with self.assertRaises(ValueError):
            pi_session.resolve_session_dir(None, None)


class CliTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.session_root = Path(self._tmp.name) / "sessions" / "--proj--"
        self.session_root.mkdir(parents=True)
        self.session_file = (
            self.session_root
            / "2026-08-10T22-32-16-734Z_019fedce-205e-73cf-b6f1-95e73fef7da0.jsonl"
        )

    def run_cli(self, args, env_extra):
        # Scrub inherited PI_* (tests run inside pi) and set exactly what each
        # case needs.
        env = {k: v for k, v in os.environ.items() if not k.startswith("PI_")}
        env.update(env_extra)
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            capture_output=True,
            text=True,
            env=env,
        )

    def test_default_prints_path_and_creates_dir(self):
        r = self.run_cli(
            [],
            {"PI_SESSION_FILE": str(self.session_file), "PI_SESSION_ID": "019fedce"},
        )
        self.assertEqual(r.returncode, 0)
        expected = self.session_root / (
            "2026-08-10T22-32-16-734Z_019fedce-205e-73cf-b6f1-95e73fef7da0.files"
        )
        self.assertEqual(r.stdout.strip(), str(expected))
        self.assertTrue(expected.is_dir())

    def test_json_reports_persistent_session_fields(self):
        r = self.run_cli(
            ["--json"],
            {"PI_SESSION_FILE": str(self.session_file), "PI_SESSION_ID": "019fedce"},
        )
        self.assertEqual(r.returncode, 0)
        payload = json.loads(r.stdout)
        expected_dir = self.session_root / (
            "2026-08-10T22-32-16-734Z_019fedce-205e-73cf-b6f1-95e73fef7da0.files"
        )
        self.assertEqual(payload["session_dir"], str(expected_dir))
        self.assertEqual(payload["session_id"], "019fedce")
        self.assertEqual(payload["session_file"], str(self.session_file))
        self.assertEqual(payload["storage_dir"], str(self.session_root))
        self.assertIs(payload["ephemeral"], False)

    def test_json_reports_ephemeral_session_fields(self):
        r = self.run_cli(
            ["--json"],
            {"PI_SESSION_FILE": "", "PI_SESSION_ID": "019fedce-xyz"},
        )
        self.assertEqual(r.returncode, 0)
        payload = json.loads(r.stdout)
        self.assertEqual(payload["session_dir"], "/tmp/pi/session/019fedce-xyz")
        self.assertEqual(payload["session_id"], "019fedce-xyz")
        self.assertEqual(payload["session_file"], "")
        self.assertIsNone(payload["storage_dir"])
        self.assertIs(payload["ephemeral"], True)

    def test_missing_identity_exits_2(self):
        r = self.run_cli([], {})
        self.assertEqual(r.returncode, 2)
        self.assertIn("PI_SESSION_FILE", r.stderr)


if __name__ == "__main__":
    unittest.main()
