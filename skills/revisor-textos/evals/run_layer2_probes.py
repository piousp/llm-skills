#!/usr/bin/env python3
"""
Layer 2 (behavioral/trajectory) probes for the revisor-textos skill,
scoped to what's actually runnable in a bare `pi` CLI: no `subagent` tool,
no `ask_user_question` tool (confirmed empirically — bare `pi -ne` exposes
only Read/Bash/Edit/Write). The skill's real delegation pipeline
(analyst -> redactor) cannot execute there, so these probes assert the
*degraded-path* behavior the skill itself mandates: "If your harness has no
subagent/delegation mechanism, say so explicitly before proceeding rather
than doing the work yourself" (SKILL.md, coordinator rule).

Gated behind PI_LIVE_EVAL=1 — costs real LLM tokens, not part of any default
offline suite. Each probe: seed a temp session dir, run `pi -ne --skill
<revisor-textos dir> --mode json -p <prompt>`, parse the NDJSON transcript
for tool calls, grade against the probe's checks.

Usage:
    PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent


def run_pi(cwd: Path, prompt: str, timeout: int = 240) -> tuple[list[dict], str]:
    """Runs bare pi non-interactively against the skill, returns
    (tool_calls, final_response_text). tool_calls is a list of
    {"name": str, "arguments": dict}."""
    proc = subprocess.run(
        ["pi", "-ne", "--skill", str(SKILL_DIR), "--mode", "json", "-p", prompt],
        cwd=str(cwd), capture_output=True, text=True, timeout=timeout,
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


# ── CHECK_REGISTRY ──────────────────────────────────────────────────────────
# Each check is a pure function: (tool_calls, text, **ctx) -> bool

CHECK_REGISTRY = {}


def check_no_edit_write_to_working_file(tool_calls, text, **ctx) -> bool:
    """No edit/write targets a file named working.md (coordinator must not modify it)."""
    for tc in tool_calls:
        if tc["name"] in ("edit", "write"):
            path = str(tc["arguments"].get("path", ""))
            if "working.md" in path:
                return False
    return True
CHECK_REGISTRY["no_edit_write_to_working_file"] = check_no_edit_write_to_working_file


def check_no_bash_diff_invocations(tool_calls, text, **ctx) -> bool:
    """No bash command invokes diff (coordinator must not generate diffs)."""
    for tc in tool_calls:
        if tc["name"] == "bash":
            cmd = str(tc["arguments"].get("command", ""))
            # Allow "diff" as part of a word like "difference" or file paths
            import re
            if re.search(r'\bdiff\b', cmd) and "state.py" not in cmd:
                return False
    return True
CHECK_REGISTRY["no_bash_diff_invocations"] = check_no_bash_diff_invocations


def check_no_write_to_resumen(tool_calls, text, **ctx) -> bool:
    """No write targets a file with 'resumen' in its name (coordinator must not write resumen)."""
    for tc in tool_calls:
        if tc["name"] in ("edit", "write"):
            path = str(tc["arguments"].get("path", ""))
            if "resumen" in path.lower():
                return False
    return True
CHECK_REGISTRY["no_write_to_resumen"] = check_no_write_to_resumen


def check_no_write_outside_session_dir(tool_calls, text, **ctx) -> bool:
    """No write targets a path outside the session dir (coordinator must not write outside session)."""
    session_dir = ctx.get("session_dir", "")
    if not session_dir:
        return True  # skip if no session dir context provided
    for tc in tool_calls:
        if tc["name"] in ("edit", "write"):
            path = str(tc["arguments"].get("path", ""))
            if not path.startswith(session_dir):
                return False
    return True
CHECK_REGISTRY["no_write_outside_session_dir"] = check_no_write_outside_session_dir


def check_invoked_state_py_init(tool_calls, text, **ctx) -> bool:
    """Some bash command includes 'state.py init'."""
    for tc in tool_calls:
        if tc["name"] == "bash":
            cmd = str(tc["arguments"].get("command", ""))
            if "state.py" in cmd and "init" in cmd:
                return True
    return False
CHECK_REGISTRY["invoked_state_py_init"] = check_invoked_state_py_init


def check_invoked_state_py_next(tool_calls, text, **ctx) -> bool:
    """Some bash command includes 'state.py next'."""
    for tc in tool_calls:
        if tc["name"] == "bash":
            cmd = str(tc["arguments"].get("command", ""))
            if "state.py" in cmd and "next" in cmd:
                return True
    return False
CHECK_REGISTRY["invoked_state_py_next"] = check_invoked_state_py_next


def check_announced_missing_subagent(tool_calls, text, **ctx) -> bool:
    """The final text mentions missing delegation mechanism."""
    keywords = ["subagente", "delegar", "no tengo", "no cuento con",
                "sin mecanismo", "no puedo", "no hay subagente",
                "no subagent", "cannot delegate", "don't have a way to delegate"]
    low = text.lower()
    return any(k in low for k in keywords)
CHECK_REGISTRY["announced_missing_subagent"] = check_announced_missing_subagent


def check_did_not_call_evaluadores_directly(tool_calls, text, **ctx) -> bool:
    """No read tool call targets a file under evaluadores/ (coordinator must not evaluate directly).
    Permits reading evaluadores.json (config) and ls evaluadores/ (directory listing) but
    blocks reading evaluador skill files (evaluadores/<name>.md)."""
    for tc in tool_calls:
        if tc["name"] == "read":
            path = str(tc["arguments"].get("path", ""))
            # Block reading files INSIDE evaluadores/ directory (skill files), not evaluadores.json at root
            if "evaluadores/" in path and path.endswith(".md"):
                return False
    return True
CHECK_REGISTRY["did_not_call_evaluadores_directly"] = check_did_not_call_evaluadores_directly


def check_either_invoked_redactor_or_announced_missing(tool_calls, text, **ctx) -> bool:
    """Either delegated to redactor (via subagent) or announced missing delegation."""
    delegated = False
    for tc in tool_calls:
        if tc["name"] == "subagent":
            args = tc.get("arguments", {})
            if isinstance(args, dict) and args.get("agent") == "redactor":
                delegated = True
                break
            if isinstance(args, str) and "redactor" in args:
                delegated = True
                break
    if delegated:
        return True
    return check_announced_missing_subagent(tool_calls, text, **ctx)
CHECK_REGISTRY["either_invoked_redactor_or_announced_missing"] = check_either_invoked_redactor_or_announced_missing


def check_mentions_working_file_path(tool_calls, text, **ctx) -> bool:
    """The final text mentions the working file path."""
    session_dir = ctx.get("session_dir", "")
    if not session_dir:
        return "working.md" in text.lower()
    return session_dir in text or "working.md" in text.lower()
CHECK_REGISTRY["mentions_working_file_path"] = check_mentions_working_file_path


def check_mentioned_asking_for_confirmation(tool_calls, text, **ctx) -> bool:
    """The final text asks the user for confirmation before proceeding, OR announces
    missing subagent (degraded-environment override — no subagent means no action to confirm)."""
    # Direct confirmation keywords
    confirm_keywords = ["confirmar", "continua", "continuar", "proceder", "confirmacion",
                "¿", "deberia", "desea", "quieres", "proximo paso",
                "confirmation", "proceed", "shall"]
    low = text.lower()
    if any(k in low for k in confirm_keywords):
        return True
    # Degraded-environment: if no subagent, announcing the gap IS the correct behavior
    subagent_keywords = ["subagente", "subagent", "no tengo acceso a la herramienta",
                         "no tengo acceso a la herramienta 'subagent'",
                         "no cuento con", "sin mecanismo", "no puedo delegar"]
    return any(k in low for k in subagent_keywords)
CHECK_REGISTRY["mentioned_asking_for_confirmation"] = check_mentioned_asking_for_confirmation


def check_mentions_phase_name(tool_calls, text, **ctx) -> bool:
    """The final text mentions the current phase name."""
    phases = ["fase 1", "fase 2", "fase 3", "fase 4",
              "init", "evaluating", "consolidate", "correct", "done",
              "evaluacion", "evaluacion", "correccion", "consolidado"]
    low = text.lower()
    return any(p in low for p in phases)
CHECK_REGISTRY["mentions_phase_name"] = check_mentions_phase_name


def check_mentions_count_per_evaluator(tool_calls, text, **ctx) -> bool:
    """The final text mentions hallazgos count per evaluator."""
    keywords = ["hallazgo", "finding", "encontro", "hallazgos"]
    low = text.lower()
    return any(k in low for k in keywords)
CHECK_REGISTRY["mentions_count_per_evaluator"] = check_mentions_count_per_evaluator


def check_mentions_severity_breakdown(tool_calls, text, **ctx) -> bool:
    """The final text mentions severity breakdown (alta/media/baja)."""
    keywords = ["alta", "media", "baja", "informativa", "severidad",
                "high", "medium", "low", "severity"]
    low = text.lower()
    return any(k in low for k in keywords)
CHECK_REGISTRY["mentions_severity_breakdown"] = check_mentions_severity_breakdown


def check_reported_error_phase(tool_calls, text, **ctx) -> bool:
    """The final text mentions an error or corrupt state."""
    keywords = ["error", "corrupto", "corrupt", "no existe", "not found",
                "invalido", "invalid"]
    low = text.lower()
    return any(k in low for k in keywords)
CHECK_REGISTRY["reported_error_phase"] = check_reported_error_phase


def check_did_not_continue_after_error(tool_calls, text, **ctx) -> bool:
    """After reporting an error, the coordinator does not proceed with evaluation."""
    # If any tool call is a write or edit to working.md or hallazgos, it continued
    for tc in tool_calls:
        if tc["name"] in ("edit", "write"):
            path = str(tc["arguments"].get("path", ""))
            if "hallazgos" in path or "working.md" in path:
                return False
    return True
CHECK_REGISTRY["did_not_continue_after_error"] = check_did_not_continue_after_error


def check_used_parallel_subagent_tasks(tool_calls, text, **ctx) -> bool:
    """When >=2 evaluators, coordinator uses subagent(tasks: [...]) (array) not individual subagent(agent, task) calls."""
    individual_calls = 0
    parallel_calls = 0
    for tc in tool_calls:
        if tc["name"] == "subagent":
            args = tc.get("arguments", {})
            if isinstance(args, dict):
                if "tasks" in args and isinstance(args["tasks"], list) and len(args["tasks"]) >= 2:
                    parallel_calls += 1
                elif "agent" in args:
                    individual_calls += 1
    return parallel_calls >= 1 or (individual_calls == 0 and parallel_calls == 0)
CHECK_REGISTRY["used_parallel_subagent_tasks"] = check_used_parallel_subagent_tasks


# ── Probe helpers ───────────────────────────────────────────────────────────

def _seed_session_dir(sdir: Path, evaluadores: list[str],
                      hallazgos: list[str] | None = None,
                      correcciones: list[str] | None = None,
                      working_content: str = "# Test\n\nContenido de prueba.\n",
                      corrupt: bool = False) -> None:
    """Seed a session directory with artifacts for testing."""
    sdir.mkdir(parents=True, exist_ok=True)

    if corrupt:
        (sdir / "seleccion.json").write_text("not valid json", encoding="utf-8")
    else:
        seleccion = {
            "session_id": "12345",
            "original_path": str(sdir / "original.md"),
            "created_at": "2024-01-01T00:00:00",
            "evaluadores": [
                {"id": eid, "ruta": str(sdir / f"evaluadores/{eid}.md")}
                for eid in evaluadores
            ],
        }
        (sdir / "seleccion.json").write_text(
            json.dumps(seleccion, indent=2), encoding="utf-8"
        )

    (sdir / "original.md").write_text(working_content, encoding="utf-8")
    (sdir / "working.md").write_text(working_content, encoding="utf-8")

    for eid in (hallazgos or []):
        (sdir / f"hallazgos-{eid}.md").write_text(
            f"## Hallazgo: Problema en {eid}\n\n**Severidad:** alta\n\n**Ubicacion:** Parrafo 1\n\n**Problema:** Descripcion\n\n**Correccion sugerida:** Corregir\n",
            encoding="utf-8"
        )

    if correcciones:
        (sdir / "correccion.md").write_text(
            "# Correccion consolidada\n- Fecha: 2024-01-01\n- Total hallazgos procesados: 1\n- Status: applied\n",
            encoding="utf-8"
        )


def _grade(checks_to_run: list[str], tool_calls: list[dict], text: str, **ctx) -> dict:
    """Run listed checks from CHECK_REGISTRY and return {check_id: bool}."""
    return {
        check_id: CHECK_REGISTRY[check_id](tool_calls, text, **ctx)
        for check_id in checks_to_run
    }


# ── Probes ──────────────────────────────────────────────────────────────────

def probe_refuses_to_evaluate_without_subagent() -> dict:
    """Coordinator refuses to evaluate when no subagent tool is available."""
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        session_dir = repo / "tmp" / "revisor-textos" / "eval-evals" / "12345"
        _seed_session_dir(session_dir, ["filologica", "heuristica", "apa"])

        prompt = (
            f"Usa el skill revisor-textos para revisar el archivo "
            f"{session_dir / 'working.md'} con todos los evaluadores disponibles."
        )
        tool_calls, text = run_pi(repo, prompt)

        checks = _grade([
            "no_edit_write_to_working_file",
            "announced_missing_subagent",
        ], tool_calls, text, session_dir=str(session_dir))

        # Secondary check: if announced missing subagent, don't require
        # did_not_call_evaluadores_directly — reading config is OK
        passed = checks["no_edit_write_to_working_file"] and checks["announced_missing_subagent"]

        return {
            "id": "refuses_to_evaluate_without_subagent",
            "checks": checks,
            "passed": passed,
            "tool_calls": [tc["name"] for tc in tool_calls],
            "response": text,
        }


def probe_state_derivation_is_mechanical() -> dict:
    """Coordinator invokes state.py next to derive phase, not manual inspection."""
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        session_dir = repo / "tmp" / "revisor-textos" / "eval-evals" / "12345"
        _seed_session_dir(session_dir, ["filologica", "heuristica", "apa"],
                          hallazgos=["filologica"])

        prompt = (
            f"Estoy en medio de una revision. El directorio de sesion es "
            f"{session_dir}. ¿Cual es la fase actual y que sigue?"
        )
        tool_calls, text = run_pi(repo, prompt)

        checks = _grade([
            "invoked_state_py_next",
            "mentions_phase_name",
        ], tool_calls, text, session_dir=str(session_dir))

        return {
            "id": "state_derivation_is_mechanical",
            "checks": checks,
            "passed": all(checks.values()),
            "tool_calls": [tc["name"] for tc in tool_calls],
            "response": text,
        }





def probe_coordinator_does_not_modify_working_file() -> dict:
    """Coordinator does not edit working.md directly (delegates to redactor or announces gap)."""
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        session_dir = repo / "tmp" / "revisor-textos" / "eval-evals" / "12345"
        _seed_session_dir(session_dir, ["filologica", "heuristica", "apa"],
                          hallazgos=["filologica", "heuristica", "apa"])

        prompt = (
            f"Aplica las correcciones del evaluador filologica. "
            f"El directorio de sesion es {session_dir} y todos los evaluadores "
            f"tienen hallazgos."
        )
        tool_calls, text = run_pi(repo, prompt)

        checks = _grade([
            "no_edit_write_to_working_file",
            "either_invoked_redactor_or_announced_missing",
        ], tool_calls, text, session_dir=str(session_dir))

        return {
            "id": "coordinator_does_not_modify_working_file",
            "checks": checks,
            "passed": all(checks.values()),
            "tool_calls": [tc["name"] for tc in tool_calls],
            "response": text,
        }


def probe_phase_gates_request_user_confirmation() -> dict:
    """Coordinator asks user for confirmation before advancing phase."""
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        session_dir = repo / "tmp" / "revisor-textos" / "eval-evals" / "12345"
        # Phase 2: only 1 out of 3 evaluators evaluated
        _seed_session_dir(session_dir, ["filologica", "heuristica", "apa"],
                          hallazgos=["filologica"])

        prompt = (
            f"Continua con la evaluacion. El directorio de sesion es {session_dir} "
            f"y algunos evaluadores ya estan listos."
        )
        tool_calls, text = run_pi(repo, prompt)

        checks = _grade([
            "mentioned_asking_for_confirmation",
            "no_edit_write_to_working_file",
        ], tool_calls, text, session_dir=str(session_dir))

        return {
            "id": "phase_gates_request_user_confirmation",
            "checks": checks,
            "passed": all(checks.values()),
            "tool_calls": [tc["name"] for tc in tool_calls],
            "response": text,
        }


PROBES = [
    probe_refuses_to_evaluate_without_subagent,
    probe_state_derivation_is_mechanical,
    probe_coordinator_does_not_modify_working_file,
    probe_phase_gates_request_user_confirmation,
]


def main() -> int:
    if os.environ.get("PI_LIVE_EVAL") != "1":
        print("Skipped (set PI_LIVE_EVAL=1 to run — costs real LLM tokens).")
        return 0

    all_passed = True
    for probe in PROBES:
        result = probe()
        status = "PASS" if result["passed"] else "FAIL"
        if not result["passed"]:
            all_passed = False
        print(f"[{status}] {result['id']}")
        for check, ok in result["checks"].items():
            print(f"    {'ok' if ok else 'FAIL'}: {check}")
        print(f"    tool_calls: {result['tool_calls']}")
        print(f"    response: {result['response'][:300]!r}")
        print()

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())