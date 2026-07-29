#!/usr/bin/env python3
"""
Deterministic control-flow reader for the revisor-textos skill.

Read-only over the session directory on disk. Derives the current phase,
evaluator position, and next action from artifact files — never maintains
its own mutable state file, so it cannot desync.

Granularity: evaluator-level. state.py derives the current phase and which
evaluator is pending from the presence of artifact files — no 'fase' field
is written to seleccion.json.

Commands:
    init <file.md> [eval_id ...]  Create session
    next <session_id>              Derive state, print JSON
    status <session_id>             Print human-readable status

Usage:
    python3 <skill-dir>/state.py init <file.md> [eval_id ...]
    python3 <skill-dir>/state.py next <session_id>
    python3 <skill-dir>/state.py status <session_id>
"""
import argparse
import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SKILL_DIR / "evaluadores.json"


# ── Config helpers ──────────────────────────────────────────────────────────

def _evaluadores_disponibles() -> list[dict]:
    """Lee evaluadores.json y devuelve [{id, ruta}]."""
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        paths = json.load(f)
    return [
        {"id": Path(p).stem, "ruta": str((SKILL_DIR / p).resolve())}
        for p in paths
    ]


def _stage_path(name: str) -> str:
    """Absolute path to a stages/*.md file."""
    return str(SKILL_DIR / "stages" / name)


# ── Session path helpers ────────────────────────────────────────────────────

def tmp_root_dir() -> Path:
    """/tmp first; fall back to $TMPDIR only if /tmp doesn't exist or isn't
    writable. Pure function of /tmp writability and the TMPDIR env var."""
    if Path("/tmp").is_dir() and os.access("/tmp", os.W_OK):
        return Path("/tmp")
    tmpdir = os.environ.get("TMPDIR")
    if tmpdir and os.access(tmpdir, os.W_OK):
        return Path(tmpdir)
    return Path("/tmp")


def _session_dir(session_id: str) -> Path:
    """Compute session directory:
    <tmp_root_dir()>/revisor-textos/<basename(cwd)>/<session_id>/.

    The basename of cwd is a process property, not an argument, so the path
    is stable across all invocations of the same coordinator run."""
    root = tmp_root_dir()
    key = Path.cwd().name
    return root / "revisor-textos" / key / session_id


def _seleccion_path(session_dir: Path) -> Path:
    return session_dir / "seleccion.json"


def _hallazgos_path(session_dir: Path, eval_id: str) -> Path:
    return session_dir / f"hallazgos-{eval_id}.md"


def _correccion_path(session_dir: Path) -> Path:
    return session_dir / "correccion.md"


def _consolidado_path(session_dir: Path) -> Path:
    return session_dir / "hallazgos-consolidado.md"


# ── Leer helpers ────────────────────────────────────────────────────────────

def _leer_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


# ── State derivation (100% read-only, no writes) ────────────────────────────

def derive_state(session_dir: Path) -> dict:
    """Derive pipeline state from artifacts on disk.

    Returns a dict with phase, phase_name, next_action, actor, stage_file,
    session_dir, working_file, progress, pending, total_evaluators, and
    blocked_reason.

    100% read-only — never writes to disk. State is derived from artifact
    presence only (no 'fase' field in seleccion.json).
    """
    # Common output fields
    result = {
        "session_dir": str(session_dir),
        "working_file": str(session_dir / "working.md"),
        "total_evaluators": 0,
        "pending": None,
        "progress": None,
        "blocked_reason": None,
    }

    # ── Error: session dir does not exist ────────────────────────────────
    if not session_dir.exists():
        result.update({
            "phase": "error",
            "phase_name": "not-found",
            "next_action": "la sesion no existe; ejecute init primero",
            "actor": "coordinator",
            "stage_file": None,
            "blocked_reason": (
                f"Session directory '{session_dir}' does not exist"
            ),
        })
        return result

    # ── Error: seleccion.json missing or corrupt ─────────────────────────
    seleccion = _leer_json(_seleccion_path(session_dir))
    if not seleccion or "evaluadores" not in seleccion:
        result.update({
            "phase": "error",
            "phase_name": "corrupt",
            "next_action": "seleccion.json corrupto o ausente; ejecute init de nuevo",
            "actor": "coordinator",
            "stage_file": None,
            "blocked_reason": "seleccion.json missing or corrupt",
        })
        return result

    evaluadores: list[dict] = seleccion["evaluadores"]
    total = len(evaluadores)
    eval_ids = [ev["id"] for ev in evaluadores]

    # Count existing artifacts (read-only inspection)
    hallazgos_exist = [
        eid for eid in eval_ids
        if _hallazgos_path(session_dir, eid).exists()
    ]

    num_hallazgos = len(hallazgos_exist)

    result["total_evaluators"] = total

    # ── Phase 1: init — no evaluations started ───────────────────────────
    if num_hallazgos == 0:
        result.update({
            "phase": "1",
            "phase_name": "init",
            "next_action": "iniciar evaluacion con el primer evaluador",
            "actor": "coordinator",
            "stage_file": _stage_path("init.md"),
            "pending": eval_ids,
            "progress": None,
        })
    # ── Phase 2: evaluating — some hallazgos exist, not all ──────────────
    elif num_hallazgos < total:
        pending = [eid for eid in eval_ids if eid not in hallazgos_exist]
        result.update({
            "phase": "2",
            "phase_name": "evaluating",
            "next_action": "continuar evaluacion de pendientes",
            "actor": "analyst",
            "stage_file": _stage_path("evaluate.md"),
            "pending": pending,
            "progress": f"{num_hallazgos}/{total}",
        })
    # ── Phase 3: consolidate — all hallazgos, no consolidado ────────────
    elif not _consolidado_path(session_dir).exists():
        result.update({
            "phase": "3",
            "phase_name": "consolidate",
            "next_action": "consolidar hallazgos en un solo archivo",
            "actor": "coordinator",
            "stage_file": _stage_path("consolidate.md"),
            "pending": None,
            "progress": None,
        })
    # ── Phase 4: correct — consolidado exists, no correccion ────────────
    elif not _correccion_path(session_dir).exists():
        result.update({
            "phase": "4",
            "phase_name": "correct",
            "next_action": "aplicar correcciones consolidadas",
            "actor": "redactor",
            "stage_file": _stage_path("correct.md"),
            "pending": None,
            "progress": None,
        })
    # ── Done: correccion exists ─────────────────────────────────────────
    else:
        result.update({
            "phase": "done",
            "phase_name": "done",
            "next_action": "presentar resumen final y detener",
            "actor": "coordinator",
            "stage_file": None,
            "pending": None,
            "progress": None,
        })

    return result


# ── Commands ────────────────────────────────────────────────────────────────

def cmd_init(args: list[str]) -> None:
    """Create a new revision session.

    Usage: init <file.md> [eval_id ...]
    - If no eval_ids, all evaluators from evaluadores.json are used.
    - If eval_ids are given, they are filtered preserving JSON order.
    """
    if len(args) < 1:
        print(
            "ERROR: Uso: state.py init <archivo.md> [eval_id ...]",
            file=sys.stderr,
        )
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

    session_id = str(os.getppid())
    sdir = _session_dir(session_id)
    sdir.mkdir(parents=True, exist_ok=True)

    # Copy original (immutable) and working copy (mutable)
    shutil.copy2(original_path, sdir / "original.md")
    shutil.copy2(original_path, sdir / "working.md")

    # Write seleccion.json — no 'fase' field, no 'sessions' subcommand
    seleccion = {
        "session_id": session_id,
        "original_path": str(original_path),
        "created_at": datetime.now().isoformat(),
        "evaluadores": [
            {
                "id": d["id"],
                "ruta": d["ruta"],
            }
            for d in seleccionados
        ],
    }
    (_seleccion_path(sdir)).write_text(
        json.dumps(seleccion, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

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


def cmd_next(args: list[str]) -> None:
    """Derive and print the current pipeline state (read-only)."""
    if len(args) < 1:
        print(
            "ERROR: Uso: state.py next <session_id>",
            file=sys.stderr,
        )
        sys.exit(1)

    session_id = args[0]
    sdir = _session_dir(session_id)
    state = derive_state(sdir)
    print(json.dumps(state, indent=2, ensure_ascii=False))


def cmd_status(args: list[str]) -> None:
    """Print human-readable session status."""
    if len(args) < 1:
        print(
            "ERROR: Uso: state.py status <session_id>",
            file=sys.stderr,
        )
        sys.exit(1)

    session_id = args[0]
    sdir = _session_dir(session_id)

    if not sdir.exists():
        print(f"ERROR: Sesion '{session_id}' no encontrada en {sdir}.", file=sys.stderr)
        sys.exit(1)

    state = derive_state(sdir)

    # Session info from derive_state
    print(f"Session: {session_id}")
    print(f"Directorio: {sdir}")

    if state.get("phase") == "error":
        print(f"Estado: ERROR - {state.get('blocked_reason', 'unknown')}")
        return

    print(f"Total evaluadores: {state.get('total_evaluators', 'N/A')}")
    print()

    # Consolidado status (from derive_state)
    consolidado = "si" if state.get("phase_name") in ("correct", "done") else "no"
    print(f"Consolidado: {consolidado}")

    # Correccion status (reads correccion.md directly)
    correccion_path = _correccion_path(sdir)
    if correccion_path.exists():
        contenido = correccion_path.read_text(encoding="utf-8")
        if "Status: applied" in contenido:
            print("Correccion: applied")
        else:
            print("Correccion: failed")
    else:
        print("Correccion: pendiente")

    print()
    print(f"Proximo paso: {state.get('next_action', 'N/A')}")


# ── Main ────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)

    sub = parser.add_subparsers(dest="command", required=True)

    init_cmd = sub.add_parser("init", help="Create a new revision session")
    init_cmd.add_argument(
        "args", nargs=argparse.REMAINDER,
        help="<file.md> [eval_id ...]",
    )

    next_cmd = sub.add_parser("next", help="Derive current pipeline state")
    next_cmd.add_argument("session_id", help="Session ID (PPID)")

    status_cmd = sub.add_parser("status", help="Show human-readable session status")
    status_cmd.add_argument("session_id", help="Session ID (PPID)")

    args = parser.parse_args()

    if args.command == "init":
        cmd_init(args.args)
    elif args.command == "next":
        cmd_next([args.session_id])
    elif args.command == "status":
        cmd_status([args.session_id])

    return 0


if __name__ == "__main__":
    sys.exit(main())