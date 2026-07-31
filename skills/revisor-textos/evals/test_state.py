#!/usr/bin/env python3
"""Tests for derive_state() in state.py.

Predicted RED with OLD state.py:
- derive_state() signature is (session_id, base_dir) — calling with one Path
  argument will raise TypeError.
- Even if signature matched, old code looks for revision/ subdir (not /tmp/...),
  hallazgos-*.json (not hallazgos-*.md), corregido-*.md (not correccion-*.md),
  and expects a 'fase' field in seleccion.json.
- Old derive_state() writes to disk (side effect via _escribir_seleccion),
  violating the 100% read-only contract.
"""
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

# Add parent directory to path so we can import state.py
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from state import (
    derive_state, cmd_init, cmd_status, _session_dir, _seleccion_path, SKILL_DIR,
    list_sessions, MAX_EVALUADORES, _write_json,
)


class TestDeriveState(unittest.TestCase):
    """Test derive_state() with various artifact configurations."""

    # ── Fixture helpers ──────────────────────────────────────────────────

    def _make_seleccion(self, sdir: Path, evaluadores: list[str]):
        """Create a valid seleccion.json (no 'fase' field) in session dir."""
        sdir.mkdir(parents=True, exist_ok=True)
        seleccion = {
            "session_id": "12345",
            "original_path": "/tmp/test/original.md",
            "created_at": "2024-01-01T00:00:00",
            "evaluadores": [
                {"id": eid, "ruta": f"/tmp/test/evaluadores/{eid}.md"}
                for eid in evaluadores
            ],
        }
        (sdir / "seleccion.json").write_text(
            json.dumps(seleccion, indent=2), encoding="utf-8"
        )

    def _make_hallazgo(self, sdir: Path, eval_id: str):
        """Create a hallazgos-<eval_id>.md file."""
        (sdir / f"hallazgos-{eval_id}.md").write_text(
            f"# Hallazgos: {eval_id}\n\n- Finding 1\n", encoding="utf-8"
        )

    def _make_consolidado(self, sdir: Path, evaluadores: list[str]):
        """Create hallazgos-consolidado.md AND hallazgos-consolidado.json
        (phase 3 -> phase 4 'plan' requires the .json to exist)."""
        lines = [
            "# Hallazgos Consolidados\n",
            "\n",
            "- Generado: 2024-01-01T00:00:00\n",
            f"- Evaluadores que aportaron: {len(evaluadores)} de {len(evaluadores)}\n",
            "- Total hallazgos: 1\n",
        ]
        for eid in evaluadores:
            lines.append(f"\n## Evaluador: {eid}\n\n")
            lines.append(f"# Hallazgos: {eid}\n\n- Finding 1\n")
        (sdir / "hallazgos-consolidado.md").write_text("".join(lines), encoding="utf-8")

        consolidado_json = {
            "generated_at": "2024-01-01T00:00:00",
            "session_id": "12345",
            "evaluadores": [
                {"id": eid, "hallazgos": 1, "estado": "ok"} for eid in evaluadores
            ],
            "total_hallazgos": 1,
            "hallazgos": [],
            "avisos": [],
        }
        (sdir / "hallazgos-consolidado.json").write_text(
            json.dumps(consolidado_json, indent=2), encoding="utf-8"
        )

    def _make_plan(self, sdir: Path):
        """Create a plan-correccion.md file."""
        (sdir / "plan-correccion.md").write_text(
            "# Plan de corrección\n\n- Total grupos: 0\n", encoding="utf-8"
        )

    def _make_correccion(self, sdir: Path):
        """Create a correccion.md file."""
        (sdir / "correccion.md").write_text(
            "# Corrección consolidada\n\n- Status: applied\n", encoding="utf-8"
        )

    # ── Error: not-found ─────────────────────────────────────────────────

    def test_no_session_dir_returns_not_found(self):
        """Session dir doesn't exist → phase: error, phase_name: not-found."""
        with tempfile.TemporaryDirectory() as tmp:
            non_existent = Path(tmp) / "sesion-inexistente"
            state = derive_state(non_existent)
            self.assertEqual(state["phase"], "error")
            self.assertEqual(state["phase_name"], "not-found")
            self.assertIsNotNone(state["blocked_reason"])

    # ── Error: corrupt ───────────────────────────────────────────────────

    def test_corrupt_seleccion_returns_corrupt(self):
        """Corrupt (invalid JSON) seleccion.json → phase: error, corrupt."""
        with tempfile.TemporaryDirectory() as tmp:
            sdir = Path(tmp) / "session"
            sdir.mkdir(parents=True)
            (sdir / "seleccion.json").write_text("not valid json", encoding="utf-8")
            state = derive_state(sdir)
            self.assertEqual(state["phase"], "error")
            self.assertEqual(state["phase_name"], "corrupt")
            self.assertIsNotNone(state["blocked_reason"])

    def test_missing_seleccion_returns_corrupt(self):
        """No seleccion.json at all → phase: error, phase_name: corrupt."""
        with tempfile.TemporaryDirectory() as tmp:
            sdir = Path(tmp) / "session"
            sdir.mkdir(parents=True)
            state = derive_state(sdir)
            self.assertEqual(state["phase"], "error")
            self.assertEqual(state["phase_name"], "corrupt")
            self.assertIsNotNone(state["blocked_reason"])

    # ── Phase 1: init ────────────────────────────────────────────────────

    def test_init_phase_no_hallazgos(self):
        """seleccion.json exists, 0 hallazgos → phase: 1, phase_name: init."""
        with tempfile.TemporaryDirectory() as tmp:
            sdir = Path(tmp) / "session"
            self._make_seleccion(sdir, ["filologica", "heuristica", "apa"])
            state = derive_state(sdir)
            self.assertEqual(state["phase"], "1")
            self.assertEqual(state["phase_name"], "init")
            self.assertEqual(state["total_evaluators"], 3)
            self.assertEqual(state["pending"], ["filologica", "heuristica", "apa"])
            self.assertIsNone(state["progress"])
            self.assertIsNone(state["blocked_reason"])

    # ── Phase 2: evaluating ──────────────────────────────────────────────

    def test_evaluating_phase_one_hallazgo(self):
        """1 hallazgo out of 3 → phase: 2, evaluating, progress: '1/3'."""
        with tempfile.TemporaryDirectory() as tmp:
            sdir = Path(tmp) / "session"
            self._make_seleccion(sdir, ["filologica", "heuristica", "apa"])
            self._make_hallazgo(sdir, "filologica")
            state = derive_state(sdir)
            self.assertEqual(state["phase"], "2")
            self.assertEqual(state["phase_name"], "evaluating")
            self.assertEqual(state["progress"], "1/3")
            self.assertEqual(state["pending"], ["heuristica", "apa"])
            self.assertEqual(state["total_evaluators"], 3)
            self.assertEqual(state["actor"], "analyst")
            self.assertIsNone(state["blocked_reason"])

    # ── Phase 3: consolidate ────────────────────────────────────────────

    def test_consolidate_phase_all_hallazgos_no_consolidado(self):
        """All 3 hallazgos, NO hallazgos-consolidado.md → phase: 3, consolidate."""
        with tempfile.TemporaryDirectory() as tmp:
            sdir = Path(tmp) / "session"
            self._make_seleccion(sdir, ["filologica", "heuristica", "apa"])
            for eid in ["filologica", "heuristica", "apa"]:
                self._make_hallazgo(sdir, eid)
            state = derive_state(sdir)
            self.assertEqual(state["phase"], "3")
            self.assertEqual(state["phase_name"], "consolidate")
            self.assertEqual(state["actor"], "coordinator")
            self.assertTrue(
                str(state["stage_file"]).endswith("stages/consolidate.md"),
                f"stage_file should end with stages/consolidate.md, got: {state['stage_file']}",
            )
            self.assertIsNone(state["pending"])
            self.assertIsNone(state["progress"])
            self.assertIsNone(state["blocked_reason"])

    # ── Phase 4: correct ─────────────────────────────────────────────────

    def test_plan_phase_consolidado_no_plan(self):
        """hallazgos-consolidado.json exists, NO plan-correccion.md → phase: 4, plan."""
        with tempfile.TemporaryDirectory() as tmp:
            sdir = Path(tmp) / "session"
            self._make_seleccion(sdir, ["filologica", "heuristica", "apa"])
            for eid in ["filologica", "heuristica", "apa"]:
                self._make_hallazgo(sdir, eid)
            self._make_consolidado(sdir, ["filologica", "heuristica", "apa"])
            state = derive_state(sdir)
            self.assertEqual(state["phase"], "4")
            self.assertEqual(state["phase_name"], "plan")
            self.assertEqual(state["actor"], "worker")
            self.assertTrue(
                str(state["stage_file"]).endswith("stages/plan.md"),
                f"stage_file should end with stages/plan.md, got: {state['stage_file']}",
            )
            self.assertIsNone(state["pending"])
            self.assertIsNone(state["progress"])
            self.assertIsNone(state["blocked_reason"])

    def test_correct_phase_plan_no_correccion(self):
        """plan-correccion.md exists, NO correccion.md → phase: 5, correct."""
        with tempfile.TemporaryDirectory() as tmp:
            sdir = Path(tmp) / "session"
            self._make_seleccion(sdir, ["filologica", "heuristica", "apa"])
            for eid in ["filologica", "heuristica", "apa"]:
                self._make_hallazgo(sdir, eid)
            self._make_consolidado(sdir, ["filologica", "heuristica", "apa"])
            self._make_plan(sdir)
            state = derive_state(sdir)
            self.assertEqual(state["phase"], "5")
            self.assertEqual(state["phase_name"], "correct")
            self.assertEqual(state["actor"], "worker")
            self.assertTrue(
                str(state["stage_file"]).endswith("stages/correct.md"),
                f"stage_file should end with stages/correct.md, got: {state['stage_file']}",
            )
            self.assertIsNone(state["pending"])
            self.assertIsNone(state["progress"])

    # ── Done: correction exists ───────────────────────────────────────────

    def test_done_phase_correccion_exists(self):
        """hallazgos-consolidado.json + plan-correccion.md + correccion.md → phase: 'done'."""
        with tempfile.TemporaryDirectory() as tmp:
            sdir = Path(tmp) / "session"
            self._make_seleccion(sdir, ["filologica", "heuristica", "apa"])
            for eid in ["filologica", "heuristica", "apa"]:
                self._make_hallazgo(sdir, eid)
            self._make_consolidado(sdir, ["filologica", "heuristica", "apa"])
            self._make_plan(sdir)
            self._make_correccion(sdir)
            state = derive_state(sdir)
            self.assertEqual(state["phase"], "done")
            self.assertEqual(state["phase_name"], "done")
            self.assertIsNone(state["stage_file"])
            self.assertIsNone(state["pending"])
            self.assertIsNone(state["progress"])
            self.assertIsNone(state["blocked_reason"])

    # ── Common fields across all states ─────────────────────────────────

    def test_common_fields_present(self):
        """All non-error states return session_dir, working_file, actor, stage_file."""
        with tempfile.TemporaryDirectory() as tmp:
            sdir = Path(tmp) / "session"
            self._make_seleccion(sdir, ["filologica", "heuristica", "apa"])
            state = derive_state(sdir)
            self.assertIn("session_dir", state)
            self.assertIn("working_file", state)
            self.assertIn("actor", state)
            self.assertIn("next_action", state)
            self.assertIn("stage_file", state)
            self.assertIn("total_evaluators", state)
            self.assertIn("pending", state)
            self.assertIn("progress", state)
            self.assertIn("blocked_reason", state)

    def test_working_file_path(self):
        """working_file is session_dir / working.md."""
        with tempfile.TemporaryDirectory() as tmp:
            sdir = Path(tmp) / "session"
            self._make_seleccion(sdir, ["filologica"])
            state = derive_state(sdir)
            self.assertEqual(state["working_file"], str(sdir / "working.md"))

    def test_session_dir_returned(self):
        """session_dir matches the argument passed to derive_state()."""
        with tempfile.TemporaryDirectory() as tmp:
            sdir = Path(tmp) / "session"
            self._make_seleccion(sdir, ["filologica"])
            state = derive_state(sdir)
            self.assertEqual(state["session_dir"], str(sdir))

    # ── Read-only contract ──────────────────────────────────────────────────

    def test_derive_state_is_readonly(self):
        """derive_state() does not write to disk under any circumstance."""
        with tempfile.TemporaryDirectory() as tmp:
            sdir = Path(tmp) / "session"
            self._make_seleccion(sdir, ["filologica", "heuristica", "apa"])

            # Record mtimes of all files before calling derive_state
            mtimes_before = {}
            for f in sdir.iterdir():
                if f.is_file():
                    mtimes_before[f.name] = os.path.getmtime(f)

            # Call derive_state 100 times
            for _ in range(100):
                state = derive_state(sdir)

            # Verify no file changed its mtime
            for f in sdir.iterdir():
                if f.is_file():
                    self.assertEqual(
                        os.path.getmtime(f),
                        mtimes_before[f.name],
                        f"File {f.name} was modified by derive_state() — violates read-only contract",
                    )

            # Verify phase is still init (no side effects on state derivation)
            self.assertEqual(state["phase"], "1")
            self.assertEqual(state["phase_name"], "init")

    # ── CLI contract tests (via subprocess) ─────────────────────────────────

    def test_seleccion_no_fase_field(self):
        """After cmd_init, seleccion.json does NOT contain a 'fase' field."""
        with tempfile.TemporaryDirectory() as tmp:
            # Create a small test file
            test_file = Path(tmp) / "article.md"
            test_file.write_text("# Test\n\nParagraph.\n", encoding="utf-8")

            # Run cmd_init via subprocess
            state_py = SKILL_DIR / "state.py"
            result = subprocess.run(
                [sys.executable, str(state_py),
                 "init", str(test_file), "filologica"],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, msg=f"cmd_init failed: {result.stderr}")

            # Find the session dir from the output
            session_dir = None
            for line in result.stdout.splitlines():
                if line.startswith("Directorio de sesion:"):
                    session_dir = line.split(":", 1)[1].strip()
                    break
            self.assertIsNotNone(session_dir, msg="Could not find session dir in output")

            # Read seleccion.json
            seleccion_path = Path(session_dir) / "seleccion.json"
            self.assertTrue(seleccion_path.exists())

            with open(seleccion_path, "r", encoding="utf-8") as f:
                seleccion = json.load(f)

            # Assert no 'fase' field
            self.assertNotIn("fase", seleccion,
                              msg="seleccion.json must not contain 'fase' field")

            # Verify it has the correct fields
            self.assertIn("session_id", seleccion)
            self.assertIn("evaluadores", seleccion)
            self.assertIn("original_path", seleccion)
            # Verify no 'design_dir' field
            self.assertNotIn("design_dir", seleccion,
                              msg="seleccion.json must not contain 'design_dir' field")

    def test_cmd_init_fails_on_missing_file(self):
        """cmd_init with nonexistent file exits with code 1."""
        with tempfile.TemporaryDirectory() as tmp:
            state_py = SKILL_DIR / "state.py"
            result = subprocess.run(
                [sys.executable, str(state_py),
                 "init", "/nonexistent/file.md"],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 1)

    def test_cmd_next_returns_valid_json(self):
        """cmd_next returns valid JSON with all expected fields."""
        with tempfile.TemporaryDirectory() as tmp:
            test_file = Path(tmp) / "article.md"
            test_file.write_text("# Test\n\nParagraph.\n", encoding="utf-8")

            state_py = SKILL_DIR / "state.py"

            # Init first
            init_result = subprocess.run(
                [sys.executable, str(state_py),
                 "init", str(test_file), "filologica"],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(init_result.returncode, 0)

            # Extract session_id
            session_id = None
            for line in init_result.stdout.splitlines():
                if line.startswith("Session:"):
                    session_id = line.split(":", 1)[1].strip()
                    break
            self.assertIsNotNone(session_id)

            # Run next
            next_result = subprocess.run(
                [sys.executable, str(state_py),
                 "next", session_id],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(next_result.returncode, 0)

            # Parse JSON
            try:
                state = json.loads(next_result.stdout)
            except json.JSONDecodeError as e:
                self.fail(f"cmd_next output is not valid JSON: {e}\nOutput: {next_result.stdout}")

            # Verify all expected fields
            expected_fields = ["phase", "phase_name", "next_action", "actor",
                               "stage_file", "session_dir", "working_file",
                               "progress", "pending", "total_evaluators", "blocked_reason"]
            for field in expected_fields:
                self.assertIn(field, state, f"Missing field: {field}")

            # Should be in init phase
            self.assertEqual(state["phase"], "1")
            self.assertEqual(state["phase_name"], "init")

    # ── Seam 2+3: CLI without --design-dir ────────────────────────────────

    def test_init_works_without_design_dir(self):
        """state.py init works without --design-dir flag."""
        with tempfile.TemporaryDirectory() as tmp:
            test_file = Path(tmp) / "article.md"
            test_file.write_text("# Test\n\nParagraph.\n", encoding="utf-8")

            state_py = SKILL_DIR / "state.py"

            result = subprocess.run(
                [sys.executable, str(state_py),
                 "init", str(test_file), "filologica"],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0,
                             msg=f"init failed without --design-dir: {result.stderr}")

            # Verify session was created
            self.assertIn("Session:", result.stdout)

            # Extract session_id and session dir
            session_id = None
            sdir = None
            for line in result.stdout.splitlines():
                if line.startswith("Session:"):
                    session_id = line.split(":", 1)[1].strip()
                if line.startswith("Directorio de sesion:"):
                    sdir = line.split(":", 1)[1].strip()

            self.assertIsNotNone(session_id)
            self.assertIsNotNone(sdir)

            # Verify seleccion.json exists and has no design_dir field
            seleccion_path = Path(sdir) / "seleccion.json"
            self.assertTrue(seleccion_path.exists())
            with open(seleccion_path, "r", encoding="utf-8") as f:
                seleccion = json.load(f)
            self.assertNotIn("design_dir", seleccion,
                             msg="seleccion.json must not contain 'design_dir' field")

            # Verify next works without --design-dir
            next_result = subprocess.run(
                [sys.executable, str(state_py),
                 "next", session_id],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(next_result.returncode, 0,
                             msg=f"next failed without --design-dir: {next_result.stderr}")

            # Verify JSON output is valid
            try:
                state = json.loads(next_result.stdout)
            except json.JSONDecodeError as e:
                self.fail(f"next output is not valid JSON: {e}\nOutput: {next_result.stdout}")

            # Verify all expected fields
            expected_fields = ["phase", "phase_name", "next_action", "actor",
                               "stage_file", "session_dir", "working_file",
                               "progress", "pending", "total_evaluators", "blocked_reason"]
            for field in expected_fields:
                self.assertIn(field, state, f"Missing field: {field}")

            # Should be in init phase
            self.assertEqual(state["phase"], "1")
            self.assertEqual(state["phase_name"], "init")

    def test_cmd_status_prints_consolidado_and_correccion(self):
        """cmd_status prints Consolidado and Correccion lines (not per-evaluator status)."""
        with tempfile.TemporaryDirectory() as tmp:
            test_file = Path(tmp) / "article.md"
            test_file.write_text("# Test\n\nParagraph.\n", encoding="utf-8")

            state_py = SKILL_DIR / "state.py"

            # Init
            init_result = subprocess.run(
                [sys.executable, str(state_py),
                 "init", str(test_file), "filologica"],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(init_result.returncode, 0)

            session_id = None
            for line in init_result.stdout.splitlines():
                if line.startswith("Session:"):
                    session_id = line.split(":", 1)[1].strip()
                    break
            self.assertIsNotNone(session_id)

            # Get session dir from init output
            sdir = None
            for line in init_result.stdout.splitlines():
                if line.startswith("Directorio de sesion:"):
                    sdir = Path(line.split(":", 1)[1].strip())
                    break
            self.assertIsNotNone(sdir)

            # Create hallazgos-consolidado.md and correccion.md to simulate completed pipeline
            (sdir / "hallazgos-consolidado.md").write_text(
                "# Hallazgos Consolidados\n\n- Test\n", encoding="utf-8"
            )
            (sdir / "correccion.md").write_text(
                "# Corrección consolidada\n\n- Status: applied\n", encoding="utf-8"
            )

            # Run status
            status_result = subprocess.run(
                [sys.executable, str(state_py),
                 "status", session_id],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(status_result.returncode, 0)

            # Verify Consolidado and Correccion appear
            self.assertIn("Consolidado", status_result.stdout)
            self.assertIn("Correccion", status_result.stdout)

            # Verify old per-evaluator format is gone
            self.assertNotIn("[pendiente]", status_result.stdout)
            self.assertNotIn("[evaluado]", status_result.stdout)
            self.assertNotIn("[corregido]", status_result.stdout)

    # ── Zero evaluators ────────────────────────────────────────────────────

    def test_derive_state_with_zero_evaluators(self):
        """Empty evaluadores list → phase: 1, init, total_evaluators=0, pending=[] ."""
        with tempfile.TemporaryDirectory() as tmp:
            sdir = Path(tmp) / "session"
            self._make_seleccion(sdir, [])
            state = derive_state(sdir)
            self.assertEqual(state["phase"], "1")
            self.assertEqual(state["phase_name"], "init")
            self.assertEqual(state["total_evaluators"], 0)
            self.assertEqual(state["pending"], [])

    # ── Single evaluator — all phases ───────────────────────────────────────

    def test_derive_state_with_one_evaluator_boundary(self):
        """1 evaluator: single evaluator can't enter evaluating (num_hallazgos == total)."""
        with tempfile.TemporaryDirectory() as tmp:
            sdir = Path(tmp) / "session"
            self._make_seleccion(sdir, ["filologica"])

            # Phase 1: init — 0 hallazgos
            state = derive_state(sdir)
            self.assertEqual(state["phase"], "1")
            self.assertEqual(state["phase_name"], "init")
            self.assertEqual(state["total_evaluators"], 1)
            self.assertEqual(state["pending"], ["filologica"])

            # Con 1 evaluador, al crear el hallazgo num_hallazgos == total
            # → salta evaluating directamente a consolidate
            self._make_hallazgo(sdir, "filologica")
            state = derive_state(sdir)
            self.assertEqual(state["phase"], "3")
            self.assertEqual(state["phase_name"], "consolidate")

    # ── cmd_status output ───────────────────────────────────────────────────

    def test_cmd_status_on_fresh_init(self):
        """cmd_status on fresh init prints Consolidado: no, Correccion: pendiente."""
        with tempfile.TemporaryDirectory() as tmp:
            session_id = "test-fresh-init"
            sdir = _session_dir(session_id)
            sdir.mkdir(parents=True, exist_ok=True)
            self._make_seleccion(sdir, ["filologica"])

            f = io.StringIO()
            with redirect_stdout(f):
                cmd_status([session_id])
            output = f.getvalue()

            self.assertIn("Consolidado: no", output)
            self.assertIn("Correccion: pendiente", output)

    def test_cmd_status_plan_line(self):
        """cmd_status prints Plan: si when plan-correccion.md exists."""
        with tempfile.TemporaryDirectory() as tmp:
            session_id = "test-plan-line"
            sdir = _session_dir(session_id)
            sdir.mkdir(parents=True, exist_ok=True)
            self._make_seleccion(sdir, ["filologica"])
            self._make_hallazgo(sdir, "filologica")
            self._make_consolidado(sdir, ["filologica"])
            self._make_plan(sdir)

            f = io.StringIO()
            with redirect_stdout(f):
                cmd_status([session_id])
            output = f.getvalue()

            self.assertIn("Plan: si", output)

    def test_cmd_status_on_correccion_failed(self):
        """cmd_status with correccion.md containing 'Status: failed' prints Correccion: failed."""
        with tempfile.TemporaryDirectory() as tmp:
            session_id = "test-correccion-failed"
            sdir = _session_dir(session_id)
            sdir.mkdir(parents=True, exist_ok=True)
            self._make_seleccion(sdir, ["filologica"])
            self._make_hallazgo(sdir, "filologica")
            self._make_consolidado(sdir, ["filologica"])
            (sdir / "correccion.md").write_text(
                "# Corrección\n\n- Fecha: 2024-01-01\n- Status: failed\n- Razón: algo salio mal\n",
                encoding="utf-8",
            )

            f = io.StringIO()
            with redirect_stdout(f):
                cmd_status([session_id])
            output = f.getvalue()

            self.assertIn("Correccion: failed", output)

    def test_cmd_status_exits_nonzero_on_corrupt_seleccion(self):
        """cmd_status exits with code 1 (via _die) when seleccion.json is corrupt — same
        error-phase contract as cmd_consolidate/cmd_group, uniform across operator commands."""
        with tempfile.TemporaryDirectory() as tmp:
            session_id = "test-status-corrupt-seleccion"
            sdir = _session_dir(session_id)
            sdir.mkdir(parents=True, exist_ok=True)
            (sdir / "seleccion.json").write_text("not valid json", encoding="utf-8")

            err = io.StringIO()
            with redirect_stderr(err):
                with self.assertRaises(SystemExit) as ctx:
                    cmd_status([session_id])

            self.assertEqual(ctx.exception.code, 1)
            self.assertIn("ERROR:", err.getvalue())

    # ── Pending order ───────────────────────────────────────────────────────

    def test_consolidate_and_correct_have_no_pending(self):
        """Phases 3 (consolidate), 4 (correct), and done have pending=None, progress=None."""
        with tempfile.TemporaryDirectory() as tmp:
            sdir = Path(tmp) / "session"
            self._make_seleccion(sdir, ["filologica", "heuristica", "apa"])

            # Phase 3: all hallazgos, no consolidado → pending=None, progress=None
            for eid in ["filologica", "heuristica", "apa"]:
                self._make_hallazgo(sdir, eid)
            state = derive_state(sdir)
            self.assertEqual(state["phase"], "3")
            self.assertIsNone(state["pending"])
            self.assertIsNone(state["progress"])

            # Phase 4: consolidado exists, no plan → pending=None, progress=None
            self._make_consolidado(sdir, ["filologica", "heuristica", "apa"])
            state = derive_state(sdir)
            self.assertEqual(state["phase"], "4")
            self.assertIsNone(state["pending"])
            self.assertIsNone(state["progress"])

            # Phase 5: plan exists, no correccion → pending=None, progress=None
            self._make_plan(sdir)
            state = derive_state(sdir)
            self.assertEqual(state["phase"], "5")
            self.assertIsNone(state["pending"])
            self.assertIsNone(state["progress"])

            # Done: correccion exists → pending=None, progress=None
            self._make_correccion(sdir)
            state = derive_state(sdir)
            self.assertEqual(state["phase"], "done")
            self.assertIsNone(state["pending"])
            self.assertIsNone(state["progress"])

    # ── Session discovery (M1) ───────────────────────────────────────────

    def test_list_sessions_empty_when_base_dir_missing(self):
        """list_sessions() returns [] when no sessions base dir exists yet."""
        import state as state_module
        original = state_module._sessions_base_dir
        state_module._sessions_base_dir = lambda: Path("/tmp/revisor-textos-does-not-exist-xyz")
        try:
            self.assertEqual(list_sessions(), [])
        finally:
            state_module._sessions_base_dir = original

    def test_list_sessions_reports_phase_and_sorts_newest_first(self):
        """list_sessions() derives phase per candidate and sorts by mtime desc."""
        import state as state_module
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / "base"
            base.mkdir()

            older = base / "111"
            self._make_seleccion(older, ["filologica"])
            newer = base / "222"
            self._make_seleccion(newer, ["filologica", "heuristica"])
            self._make_hallazgo(newer, "filologica")

            # Force older's mtime behind newer's regardless of creation order.
            os.utime(older, (1000, 1000))
            os.utime(newer, (2000, 2000))

            original = state_module._sessions_base_dir
            state_module._sessions_base_dir = lambda: base
            try:
                sessions = list_sessions()
            finally:
                state_module._sessions_base_dir = original

            self.assertEqual([s["session_id"] for s in sessions], ["222", "111"])
            self.assertEqual(sessions[0]["phase_name"], "evaluating")
            self.assertEqual(sessions[1]["phase_name"], "init")

    def test_cmd_sessions_cli_lists_prior_session(self):
        """`state.py sessions` (subprocess, real cwd) lists a session created by init."""
        with tempfile.TemporaryDirectory() as tmp:
            test_file = Path(tmp) / "article.md"
            test_file.write_text("# Test\n\nParagraph.\n", encoding="utf-8")

            state_py = SKILL_DIR / "state.py"
            init_result = subprocess.run(
                [sys.executable, str(state_py), "init", str(test_file), "filologica"],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(init_result.returncode, 0)
            session_id = next(
                line.split(":", 1)[1].strip()
                for line in init_result.stdout.splitlines()
                if line.startswith("Session:")
            )

            sessions_result = subprocess.run(
                [sys.executable, str(state_py), "sessions"],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(sessions_result.returncode, 0)
            sessions = json.loads(sessions_result.stdout)
            self.assertIn(session_id, [s["session_id"] for s in sessions])

    # ── MAX_EVALUADORES cap (M2) ─────────────────────────────────────────

    def test_cmd_init_truncates_to_max_evaluadores(self):
        """cmd_init caps selection at MAX_EVALUADORES, preserving order, and
        warns on stderr about the omitted ids."""
        import state as state_module
        original_disponibles = state_module._evaluadores_disponibles
        state_module._evaluadores_disponibles = lambda: [
            {"id": f"ev{i}", "ruta": f"/tmp/ev{i}.md"} for i in range(MAX_EVALUADORES + 2)
        ]
        try:
            with tempfile.TemporaryDirectory() as tmp:
                test_file = Path(tmp) / "article.md"
                test_file.write_text("# Test\n\nParagraph.\n", encoding="utf-8")
                ids = [f"ev{i}" for i in range(MAX_EVALUADORES + 2)]

                out, err = io.StringIO(), io.StringIO()
                with redirect_stdout(out), redirect_stderr(err):
                    cmd_init([str(test_file)] + ids)  # completes normally (warning, not error)
        finally:
            state_module._evaluadores_disponibles = original_disponibles

        stdout = out.getvalue()
        selected = [
            line.strip().lstrip("- ").strip()
            for line in stdout.splitlines()
            if line.startswith("  - ev")
        ]
        self.assertEqual(selected, [f"ev{i}" for i in range(MAX_EVALUADORES)])
        self.assertIn(f"se truncó a los primeros {MAX_EVALUADORES}", err.getvalue())
        self.assertIn("ev8", err.getvalue())
        self.assertIn("ev9", err.getvalue())

    def test_cmd_init_dies_when_no_valid_evaluators_requested(self):
        """cmd_init with an eval_id not present in evaluadores.json exits via
        _die(msg, *extra): stderr carries both the primary message and the
        'IDs disponibles:' extra line (the only real call site exercising
        _die's *extra mechanism end-to-end)."""
        with tempfile.TemporaryDirectory() as tmp:
            test_file = Path(tmp) / "article.md"
            test_file.write_text("# Test\n\nParagraph.\n", encoding="utf-8")

            err = io.StringIO()
            with redirect_stderr(err):
                with self.assertRaises(SystemExit) as ctx:
                    cmd_init([str(test_file), "eval_id_que_no_existe"])

            self.assertEqual(ctx.exception.code, 1)
            stderr = err.getvalue()
            self.assertIn("Ningun evaluador valido entre los solicitados.", stderr)
            self.assertIn("IDs disponibles:", stderr)

    # ── _write_json contract ─────────────────────────────────────────────

    def test_write_json_uses_indent2_and_ensure_ascii_false(self):
        """_write_json() writes indent=2, ensure_ascii=False, UTF-8-decodable JSON."""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "out.json"
            _write_json(path, {"clave": "valor con ñ"})

            raw = path.read_text(encoding="utf-8")

            self.assertIn('\n  "clave"', raw)
            self.assertIn("ñ", raw)
            self.assertNotIn("\\u00f1", raw)


if __name__ == "__main__":
    unittest.main()