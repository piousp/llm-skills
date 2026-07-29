#!/usr/bin/env python3
"""
Deterministic control-flow reader for the revisor-textos skill.

Read-only over the session directory on disk. Derives the current phase,
evaluator position, and next action from artifact files — never maintains
its own mutable state file, so it cannot desync.

Granularity: evaluator-level. state.py tracks which evaluator is current,
which step (evaluate/correct/verify) is next, and which phase (first_pass,
second_pass, finish) is active. The coordinator reads state.py → executes
the stage → repeats until phase=done.

Commands:
    init <file.md> [eval_id ...]  -- Create session, copy files (only writer)
    next <session_id>             -- Derive state, print JSON (read-only)

Usage:
    python3 <skill-dir>/state.py init <file.md> [eval_id ...]
    python3 <skill-dir>/state.py next <session_id>
    python3 <skill-dir>/state.py next <session_id> --dir <base-dir>
"""
import argparse
import json
import shutil
import sys
import uuid
from datetime import datetime
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SKILL_DIR / "evaluadores.json"
REVISION_DIR_NAME = "revision"


# ── Config helpers ──────────────────────────────────────────────────────────

def _cargar_config() -> list[str]:
    """Returns flat list of evaluator paths from evaluadores.json."""
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _evaluadores_disponibles() -> list[dict]:
    """Returns [{id, ruta}] for all evaluators in evaluadores.json."""
    result = []
    for p in _cargar_config():
        result.append({
            "id": Path(p).stem,
            "ruta": str((SKILL_DIR / p).resolve()),
        })
    return result


def _stage_path(name: str) -> str:
    """Absolute path to a stages/*.md file."""
    return str(SKILL_DIR / "stages" / name)


# ── Session path helpers ────────────────────────────────────────────────────

def _session_dir(base_dir: Path, session_id: str) -> Path:
    return base_dir / REVISION_DIR_NAME / session_id


def _seleccion_path(session_dir: Path) -> Path:
    return session_dir / "seleccion.json"


def _hallazgos_path(session_dir: Path, eval_id: str) -> Path:
    return session_dir / f"hallazgos-{eval_id}.json"


def _corregido_path(session_dir: Path, eval_id: str) -> Path:
    return session_dir / f"corregido-{eval_id}.md"


def _verificacion_path(session_dir: Path, eval_id: str) -> Path:
    return session_dir / f"verificacion-{eval_id}.json"


# ── State derivation (read-only) ────────────────────────────────────────────

def _leer_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def derive_state(session_id: str, base_dir: Path) -> dict:
    """
    Derive pipeline state from artifacts on disk.
    Returns a dict with phase, evaluator, step, stage_file, etc.
    """
    sdir = _session_dir(base_dir, session_id)

    if not sdir.exists():
        return {
            "phase": "error",
            "phase_name": "not-found",
            "next_action": "session not found; run init first",
            "actor": "coordinator",
            "required_inputs": [],
            "stage_file": None,
            "blocked_reason": f"Session directory '{sdir}' does not exist",
        }

    seleccion = _leer_json(_seleccion_path(sdir))
    if not seleccion or "evaluadores" not in seleccion:
        return {
            "phase": "error",
            "phase_name": "corrupt",
            "next_action": "session is corrupt; re-run init",
            "actor": "coordinator",
            "required_inputs": [],
            "stage_file": None,
            "blocked_reason": "seleccion.json missing or corrupt",
        }

    evaluadores: list[dict] = seleccion["evaluadores"]
    total = len(evaluadores)
    fase = seleccion.get("fase", "first_pass")

    # ── First pass ──────────────────────────────────────────────────────
    if fase == "first_pass":
        for i, ev in enumerate(evaluadores):
            hid = ev["id"]
            h_path = _hallazgos_path(sdir, hid)
            c_path = _corregido_path(sdir, hid)

            if not h_path.exists():
                return {
                    "phase": 2,
                    "phase_name": "first_pass",
                    "evaluator": hid,
                    "evaluator_index": i,
                    "total_evaluators": total,
                    "step": "evaluate",
                    "next_action": f"delegate to analyst for {hid} evaluation",
                    "actor": "analyst",
                    "required_inputs": [ev["ruta"], str(sdir / "working.md")],
                    "stage_file": _stage_path("evaluate.md"),
                    "session_dir": str(sdir),
                    "working_file": str(sdir / "working.md"),
                    "evaluator_file": ev["ruta"],
                    "evaluator_skill": ev["ruta"],
                }

            if not c_path.exists():
                return {
                    "phase": 2,
                    "phase_name": "first_pass",
                    "evaluator": hid,
                    "evaluator_index": i,
                    "total_evaluators": total,
                    "step": "correct",
                    "next_action": f"delegate to redactor to apply {hid} corrections",
                    "actor": "redactor",
                    "required_inputs": [str(h_path), str(sdir / "working.md")],
                    "stage_file": _stage_path("correct.md"),
                    "session_dir": str(sdir),
                    "working_file": str(sdir / "working.md"),
                    "findings_file": str(h_path),
                    "evaluator": hid,
                }

        # All first-pass evaluators done → advance to second pass
        seleccion["fase"] = "second_pass"
        _escribir_seleccion(sdir, seleccion)
        fase = "second_pass"  # update local variable for fall-through
        # Fall through to second pass

    # ── Second pass ─────────────────────────────────────────────────────
    if fase == "second_pass":
        for i, ev in enumerate(evaluadores):
            hid = ev["id"]
            v_path = _verificacion_path(sdir, hid)

            if not v_path.exists():
                return {
                    "phase": 3,
                    "phase_name": "second_pass",
                    "evaluator": hid,
                    "evaluator_index": i,
                    "total_evaluators": total,
                    "step": "verify",
                    "next_action": f"delegate to analyst for {hid} verification (regression check)",
                    "actor": "analyst",
                    "required_inputs": [ev["ruta"], str(sdir / "working.md")],
                    "stage_file": _stage_path("verify.md"),
                    "session_dir": str(sdir),
                    "working_file": str(sdir / "working.md"),
                    "evaluator_file": ev["ruta"],
                    "evaluator_skill": ev["ruta"],
                }

        # All second-pass evaluators done
        seleccion["fase"] = "finish"
        _escribir_seleccion(sdir, seleccion)
        fase = "finish"  # update local variable for fall-through
        # Fall through to finish

    # ── Finish / Done ────────────────────────────────────────────────────
    if fase == "finish":
        return {
            "phase": 4,
            "phase_name": "finish",
            "next_action": "generate diff, copy files to output directory, present to user",
            "actor": "coordinator",
            "required_inputs": [str(sdir / "original.md"), str(sdir / "working.md")],
            "stage_file": _stage_path("finish.md"),
            "session_dir": str(sdir),
            "working_file": str(sdir / "working.md"),
            "original_file": str(sdir / "original.md"),
        }

    return {
        "phase": "done",
        "phase_name": "handoff",
        "next_action": "report final handoff summary to the user",
        "actor": "coordinator",
        "required_inputs": [],
        "stage_file": None,
    }


def _escribir_seleccion(sdir: Path, seleccion: dict) -> None:
    """Write seleccion.json (used only for phase advancement tracking)."""
    sdir.mkdir(parents=True, exist_ok=True)
    (_seleccion_path(sdir)).write_text(
        json.dumps(seleccion, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


# ── Commands ────────────────────────────────────────────────────────────────

def cmd_init(args: list[str]) -> None:
    """Create a new revision session.
    
    Usage: init <file.md> [eval_id ...]
    - If no eval_ids, all evaluators from evaluadores.json are used.
    - If eval_ids are given, they are filtered preserving JSON order.
    """
    if len(args) < 1:
        print("ERROR: Uso: state.py init <archivo.md> [eval_id ...]", file=sys.stderr)
        sys.exit(1)

    original_path = Path(args[0]).resolve()
    if not original_path.exists():
        print(f"ERROR: El archivo '{original_path}' no existe.", file=sys.stderr)
        sys.exit(1)

    disponibles = _evaluadores_disponibles()
    ids_solicitados = args[1:] if len(args) > 1 else [d["id"] for d in disponibles]
    seleccionados = [d for d in disponibles if d["id"] in ids_solicitados]

    if not seleccionados:
        print("ERROR: Ningun evaluador valido entre los solicitados.", file=sys.stderr)
        print(f"IDs disponibles: {[d['id'] for d in disponibles]}", file=sys.stderr)
        sys.exit(1)

    session_id = str(uuid.uuid4())[:8]
    base_dir = Path.cwd()
    sdir = _session_dir(base_dir, session_id)
    sdir.mkdir(parents=True, exist_ok=True)

    # Copy original (immutable) and working copy (mutable)
    shutil.copy2(original_path, sdir / "original.md")
    shutil.copy2(original_path, sdir / "working.md")

    # Write seleccion.json
    seleccion = {
        "session_id": session_id,
        "original_path": str(original_path),
        "created_at": datetime.now().isoformat(),
        "fase": "first_pass",
        "evaluadores": [
            {
                "id": d["id"],
                "ruta": d["ruta"],
            }
            for d in seleccionados
        ],
    }
    _escribir_seleccion(sdir, seleccion)

    # Print session info
    print(f"Session: {session_id}")
    print(f"Original: {original_path}")
    print(f"Copia de trabajo: {sdir / 'working.md'}")
    print(f"Evaluadores seleccionados: {len(seleccionados)}")
    for e in seleccionados:
        print(f"  - {e['id']}")
    print("---")
    primer = seleccionados[0]
    print(f"Primer evaluador: {primer['id']}")
    print(f"Ruta del evaluador: {primer['ruta']}")
    print(f"Archivo a revisar: {sdir / 'working.md'}")
    print(f"Directorio de sesion: {sdir}")


def cmd_next(args: list[str], base_dir: Path) -> None:
    """Derive and print the current pipeline state (read-only)."""
    if len(args) < 1:
        print("ERROR: Uso: state.py next <session_id>", file=sys.stderr)
        sys.exit(1)

    session_id = args[0]
    state = derive_state(session_id, base_dir)
    print(json.dumps(state, indent=2, ensure_ascii=False))


def cmd_status(args: list[str], base_dir: Path) -> None:
    """Print human-readable session status."""
    if len(args) < 1:
        print("ERROR: Uso: state.py status <session_id>", file=sys.stderr)
        sys.exit(1)

    session_id = args[0]
    sdir = _session_dir(base_dir, session_id)

    if not sdir.exists():
        print(f"ERROR: Sesion '{session_id}' no encontrada en {sdir}.", file=sys.stderr)
        sys.exit(1)

    seleccion = _leer_json(_seleccion_path(sdir))
    if not seleccion:
        print(f"ERROR: seleccion.json no encontrado en {sdir}.", file=sys.stderr)
        sys.exit(1)

    print(f"Session: {seleccion['session_id']}")
    print(f"Original: {seleccion['original_path']}")
    print(f"Directorio: {sdir}")
    print(f"Fase: {seleccion.get('fase', 'unknown')}")
    print("---")
    for ev in seleccion["evaluadores"]:
        hid = ev["id"]
        h_path = _hallazgos_path(sdir, hid)
        c_path = _corregido_path(sdir, hid)
        v_path = _verificacion_path(sdir, hid)

        estado = "pendiente"
        if v_path.exists():
            estado = "verificado"
        elif c_path.exists():
            estado = "corregido"
        elif h_path.exists():
            estado = "analizado"

        print(f"  [{estado}] {hid}")

    state = derive_state(session_id, base_dir)
    print("---")
    print(f"Proximo paso: {state.get('next_action', 'N/A')}")


# ── Main ────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", default=".", help="Base directory for revision/ (default: cwd)")

    sub = parser.add_subparsers(dest="command", required=True)

    init_cmd = sub.add_parser("init", help="Create a new revision session")
    init_cmd.add_argument("args", nargs=argparse.REMAINDER,
                          help="<file.md> [eval_id ...]")

    next_cmd = sub.add_parser("next", help="Derive current pipeline state")
    next_cmd.add_argument("session_id", help="Session ID")

    status_cmd = sub.add_parser("status", help="Show human-readable session status")
    status_cmd.add_argument("session_id", help="Session ID")

    args = parser.parse_args()
    base_dir = Path(args.dir).resolve()

    if args.command == "init":
        cmd_init(args.args)
    elif args.command == "next":
        cmd_next([args.session_id], base_dir)
    elif args.command == "status":
        cmd_status([args.session_id], base_dir)

    return 0


if __name__ == "__main__":
    sys.exit(main())