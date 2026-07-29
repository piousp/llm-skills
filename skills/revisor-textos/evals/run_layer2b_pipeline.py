#!/usr/bin/env python3
"""
Layer 2b — real delegation pipeline (Phase 1→3) for revisor-textos.

Unlike Layer 2 (bare `pi -ne`), this loads a real `subagent` tool via an
explicit `-e <path>` to a pi extension that provides one (e.g. the
`pi-simple-agents` package's extensions/ dir). This path is machine-specific,
so it is NOT hardcoded: set the `PI_SUBAGENT_EXTENSION_PATH` env var to your
own subagent extension's path before running this layer.

Drives a multi-turn conversation via `--session <path>` across separate `pi`
subprocess calls — not a single `-p` shot — because the skill has multiple
confirmation checkpoints between phases.

Gated behind PI_LIVE_EVAL=1 and PI_SUBAGENT_EXTENSION_PATH. Costs real,
multi-minute, real-token delegation.

Usage:
    export PI_SUBAGENT_EXTENSION_PATH=/path/to/pi-simple-agents/extensions
    PI_LIVE_EVAL=1 python3 evals/run_layer2b_pipeline.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from run_layer2_probes import check_used_parallel_subagent_tasks

SKILL_DIR = Path(__file__).resolve().parent.parent
_SUBAGENT_EXT_ENV = "PI_SUBAGENT_EXTENSION_PATH"
SUBAGENT_EXT = os.environ.get(_SUBAGENT_EXT_ENV)

# ── Test fixture content ────────────────────────────────────────────────────

SAMPLE_ARTICLE = """# Analisis del discurso politico contemporaneo

## Introduccion

El discurso politico contemporaneo se caracteriza por una serie de
transformaciones que responden a cambios en la esfera publica y en los
medios de comunicacion. Autores como Habermas (1981) han senalado la
importancia de la accion comunicativa como fundamento de la democracia
deliberativa.

## Desarrollo

En America Latina, el populismo ha sido objeto de numerosos estudios.
Laclau (2005) propone una lectura del populismo como logica politica,
mientras que otros autores lo consideran una patologia de la democracia.
Esta tension teorica refleja las dificultades para definir un fenomeno
esencialmente controvertido.

## Conclusion

El analisis del discurso politico requiere una metodologia que integre
dimensiones linguisticas, sociales e historicas. Solo asi es posible
comprender la complejidad de los procesos politicos contemporaneos.
"""


def run_pi(cwd: Path, prompt: str, session: Path | None = None,
           timeout: int = 900) -> tuple[list[dict], str]:
    """Runs pi with subagent extension against the skill.

    Returns (tool_calls, final_response_text).
    """
    cmd = ["pi", "-ne", "-e", SUBAGENT_EXT, "--skill", str(SKILL_DIR),
           "--mode", "json"]
    if session:
        cmd.extend(["--session", str(session)])
    cmd.extend(["-p", prompt])

    proc = subprocess.run(
        cmd, cwd=str(cwd), capture_output=True, text=True, timeout=timeout,
    )
    tool_calls = []
    final_text = ""
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            continue
        if evt.get("type") != "message_end":
            continue
        msg = evt.get("message", {})
        if msg.get("role") != "assistant":
            continue
        texts = [c["text"] for c in msg.get("content", []) if c.get("type") == "text"]
        if texts:
            final_text = " ".join(texts)
        for c in msg.get("content", []):
            if c.get("type") == "toolCall":
                tool_calls.append({"name": c.get("name"), "arguments": c.get("arguments", {})})
    return tool_calls, final_text


def subagent_called(tool_calls: list[dict], name: str) -> bool:
    """True if a subagent tool call references the named agent."""
    for tc in tool_calls:
        if tc["name"] == "subagent":
            args = tc.get("arguments", {})
            if isinstance(args, dict):
                if args.get("agent") == name:
                    return True
                if args.get("subagent") == name:
                    return True
            if isinstance(args, str) and name in args:
                return True
    return False


def run_trial() -> dict:
    """Run a single trial: init → evaluate → correct for one evaluator."""
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / "repo"
        repo.mkdir()

        # Create the article file
        article_path = repo / "article.md"
        article_path.write_text(SAMPLE_ARTICLE, encoding="utf-8")

        # Create design dir
        design_dir = repo / "design"
        design_dir.mkdir()

        # Session file for multi-turn conversation
        session_file = repo / "session.json"

        # Record initial mtime of a non-existent working file
        session_dir = Path(f"/tmp/revisor-textos/{repo.name}/")
        # We'll find the actual session dir after the first turn

        # ── Turn 1: Init session ────────────────────────────────────────
        turn1_prompt = (
            f"Usa el skill revisor-textos para revisar el archivo "
            f"{article_path} con los evaluadores 'heuristica' y 'filologica'."
        )
        tc1, text1 = run_pi(repo, turn1_prompt, session=None)

        # Find the session dir from tool calls or text
        actual_session_dir = None
        for tc in tc1:
            if tc["name"] == "bash":
                cmd = str(tc["arguments"].get("command", ""))
                if "state.py" in cmd and "init" in cmd:
                    # The session dir is /tmp/revisor-textos/<basename>/<PPID>/
                    pass

        # Try to find session dir by looking at /tmp/revisor-textos/
        potential_sessions = list(Path("/tmp/revisor-textos").glob(f"{repo.name}/*"))
        if potential_sessions:
            actual_session_dir = sorted(potential_sessions, key=lambda p: p.stat().st_mtime)[-1]

        # Record working file mtime before correction
        wf_mtime_before = None
        if actual_session_dir:
            wf = actual_session_dir / "working.md"
            if wf.exists():
                wf_mtime_before = wf.stat().st_mtime

        # ── Turn 2: Continue / confirm ──────────────────────────────────
        # The coordinator should ask for confirmation; we simulate it
        if actual_session_dir:
            turn2_prompt = (
                f"Confirmado. Continuar con la revision en el directorio de sesion "
                f"{actual_session_dir}."
            )
        else:
            turn2_prompt = (
                f"Confirmado. Continuar con la revision."
            )

        tc2, text2 = run_pi(repo, turn2_prompt, session=session_file)

        # ── Gather results ──────────────────────────────────────────────
        all_tool_calls = tc1 + tc2

        # Check hallazgos file
        hallazgos_file = None
        if actual_session_dir:
            hf = actual_session_dir / "hallazgos-heuristica.md"
            if hf.exists():
                hallazgos_file = hf

        # Check correccion marker
        correccion_file = None
        if actual_session_dir:
            cf = actual_session_dir / "correccion.md"
            if cf.exists():
                correccion_file = cf

        # Check working file mtime after
        wf_mtime_after = None
        if actual_session_dir:
            wf = actual_session_dir / "working.md"
            if wf.exists():
                wf_mtime_after = wf.stat().st_mtime

        # Check hallazgos content follows template
        hallazgos_valid = False
        if hallazgos_file:
            content = hallazgos_file.read_text(encoding="utf-8")
            hallazgos_valid = (
                "## Hallazgo:" in content or "No se encontraron hallazgos" in content
            )

        # Check correccion marker status
        correccion_valid = False
        if correccion_file:
            content = correccion_file.read_text(encoding="utf-8")
            correccion_valid = "Status:" in content

        # Check working file was modified
        working_modified = False
        if wf_mtime_before and wf_mtime_after:
            working_modified = wf_mtime_after > wf_mtime_before

        checks = {
            "delegated_to_analyst": subagent_called(all_tool_calls, "analyst"),
            "coordinator_wrote_hallazgos": hallazgos_file is not None,
            "hallazgos_follows_template": hallazgos_valid,
            "delegated_to_redactor": subagent_called(all_tool_calls, "redactor"),
            "working_file_modified": working_modified,
            "correccion_marker_written": correccion_file is not None,
            "correccion_marker_valid": correccion_valid,
            "used_parallel_subagent_tasks": check_used_parallel_subagent_tasks(
                all_tool_calls, text2,
                session_dir=str(actual_session_dir or "")
            ),
        }

        # Clean up session dir
        if actual_session_dir and actual_session_dir.exists():
            shutil.rmtree(actual_session_dir, ignore_errors=True)

        return {
            "checks": checks,
            "passed": all(checks.values()),
            "tool_calls_turn1": [tc["name"] for tc in tc1],
            "tool_calls_turn2": [tc["name"] for tc in tc2],
            "response_turn1": text1[:300],
            "response_turn2": text2[:300],
            "session_dir": str(actual_session_dir) if actual_session_dir else "not found",
        }


def main() -> int:
    if os.environ.get("PI_LIVE_EVAL") != "1":
        print("Skipped (set PI_LIVE_EVAL=1 to run — costs real LLM tokens).")
        return 0
    if not SUBAGENT_EXT:
        print(f"Skipped: set {_SUBAGENT_EXT_ENV} to a pi extension providing a real 'subagent' tool.")
        return 0
    if not Path(SUBAGENT_EXT).exists():
        print(f"Skipped: {_SUBAGENT_EXT_ENV}={SUBAGENT_EXT} does not exist.")
        return 0

    print("Running L2b pipeline (N=1)...")
    print(f"  Subagent extension: {SUBAGENT_EXT}")
    print(f"  Skill dir: {SKILL_DIR}")
    print()

    result = run_trial()
    status = "PASS" if result["passed"] else "FAIL"
    print(f"[{status}] revisor-textos L2b pipeline")
    print(f"  Session dir: {result['session_dir']}")
    for check, ok in result["checks"].items():
        print(f"    {'ok' if ok else 'FAIL'}: {check}")
    print(f"  Tool calls (turn 1): {result['tool_calls_turn1']}")
    print(f"  Tool calls (turn 2): {result['tool_calls_turn2']}")
    print()

    if not result["passed"]:
        print("One or more checks failed. See above for details.")
        print("N=1 caveat: this is a single trial; results may vary.")
        return 1

    print("All checks passed (N=1).")
    return 0


if __name__ == "__main__":
    sys.exit(main())