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
    consolidate <session_id>        Consolidate hallazgos-<id>.md into one file
    group <session_id>              Group consolidated hallazgos by ubicacion

Usage:
    python3 <skill-dir>/state.py init <file.md> [eval_id ...]
    python3 <skill-dir>/state.py next <session_id>
    python3 <skill-dir>/state.py status <session_id>
"""
import argparse
import json
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import NamedTuple, TypedDict


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


def _consolidado_json_path(session_dir: Path) -> Path:
    return session_dir / "hallazgos-consolidado.json"


def _agrupados_path(session_dir: Path) -> Path:
    return session_dir / "hallazgos-agrupados.json"


def _plan_path(session_dir: Path) -> Path:
    return session_dir / "plan-correccion.md"


# ── Leer helpers ────────────────────────────────────────────────────────────

def _leer_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


# Núcleo compartido: un número, opcionalmente seguido de un rango 'N-M'.
_NUMERO_O_RANGO = r"(\d+)(?:\s*[-–]\s*(\d+))?"

# Fallback de Ubicación: exige el prefijo 'línea(s)' explícito para evitar
# que un número suelto en prosa libre (p.ej. 'página 12') se confunda con
# una referencia de línea.
_RANGO_UBICACION_RE = re.compile(
    rf"l[ií]nea[s]?\s+{_NUMERO_O_RANGO}", re.IGNORECASE
)

# Extracción laxa dentro del propio campo Línea (p.ej. '12 (aprox.)', '~12',
# '12, 15'), sin exigir prefijo alguno.
_NUMERO_O_RANGO_RE = re.compile(_NUMERO_O_RANGO)


def _formatear_rango(inicio: str, fin: str | None) -> str:
    """'N', None -> 'N'; 'N', 'M' con N==M -> 'N'; 'N', 'M' con N!=M -> 'N-M'."""
    if fin is None or fin == inicio:
        return inicio
    return f"{inicio}-{fin}"


def _normalizar_linea(
    linea_field: str | None, ubicacion: str | None
) -> tuple[str | None, str]:
    """Normaliza la referencia de linea de un hallazgo.

    Prioriza linea_field (entero simple o rango 'N-M'/'N-M'); "desconocida"
    (case-insensitive) fuerza (None, "ninguna") sin caer a ubicacion. Si
    linea_field no es un match exacto, intenta una extraccion laxa del
    primer numero (y rango opcional) en cualquier parte del propio campo
    (origen sigue siendo "campo"). Solo si linea_field no tiene ningun
    numero se cae a ubicacion, que exige la frase "linea(s) N" explicita
    (nunca un numero suelto en prosa libre). Sin ninguna fuente ->
    (None, "ninguna").
    """
    if linea_field is not None:
        campo = linea_field.strip()
        if campo:
            if campo.lower() == "desconocida":
                return (None, "ninguna")
            if campo.isdigit():
                return (campo, "campo")
            match = re.fullmatch(r"(\d+)\s*[-–]\s*(\d+)", campo)
            if match:
                return (_formatear_rango(match.group(1), match.group(2)), "campo")
            match = _NUMERO_O_RANGO_RE.search(campo)
            if match:
                return (_formatear_rango(match.group(1), match.group(2)), "campo")

    if ubicacion is not None:
        match = _RANGO_UBICACION_RE.search(ubicacion)
        if match:
            return (_formatear_rango(match.group(1), match.group(2)), "ubicacion")

    return (None, "ninguna")


# ── Parseo de hallazgos.md ─────────────────────────────────────────────────

_TILDE_MAP = str.maketrans("áéíóúÁÉÍÓÚ", "aeiouAEIOU")

_HALLAZGO_HEADER_RE = re.compile(r"^##\s*Hallazgo:\s*(.*)$", re.MULTILINE)

_FIELD_LABEL_RE = re.compile(
    r"\*\*\s*(severidad|l[ií]nea|ubicaci[oó]n|problema|correcci[oó]n sugerida)\s*:\s*\*\*",
    re.IGNORECASE,
)

_SEVERIDADES_VALIDAS = {"alta", "media", "baja", "informativa"}

_NOMBRE_CANONICO = {
    "severidad": "Severidad",
    "linea": "Línea",
    "ubicacion": "Ubicación",
    "problema": "Problema",
    "correccion sugerida": "Corrección sugerida",
}


class Hallazgo(TypedDict):
    id: str
    evaluador: str
    titulo: str
    severidad: str | None
    linea: str | None
    linea_origen: str
    ubicacion: str | None
    problema: str | None
    correccion_sugerida: str | None


def _quitar_tildes(texto: str) -> str:
    """Quita tildes de vocales (mayusculas y minusculas) via translate."""
    return texto.translate(_TILDE_MAP)


def _parse_campos(bloque: str) -> dict[str, str | None]:
    """Extrae los campos reconocidos (severidad, linea, ubicacion, problema,
    correccion sugerida) de un bloque de hallazgo. Tolerante a tildes y
    mayusculas en las etiquetas '**Etiqueta:**'. El valor de cada campo
    corre hasta la siguiente etiqueta reconocida o el fin del bloque;
    ausente -> None."""
    matches = list(_FIELD_LABEL_RE.finditer(bloque))
    campos: dict[str, str | None] = {
        "severidad": None,
        "linea": None,
        "ubicacion": None,
        "problema": None,
        "correccion sugerida": None,
    }
    for i, m in enumerate(matches):
        clave = _quitar_tildes(m.group(1).lower())
        inicio_valor = m.end()
        fin_valor = matches[i + 1].start() if i + 1 < len(matches) else len(bloque)
        campos[clave] = bloque[inicio_valor:fin_valor].strip()
    return campos


def _es_sin_hallazgos(texto: str) -> bool:
    """True si texto (stripped, case-insensitive) es exactamente el
    centinela 'no se encontraron hallazgos.'."""
    return texto.strip().lower() == "no se encontraron hallazgos."


def _parse_hallazgos_md(texto: str, eval_id: str) -> tuple[list["Hallazgo"], list[str]]:
    """Parsea el contenido de un hallazgos-<eval_id>.md a una lista de dicts
    de hallazgo mas una lista de avisos de datos faltantes/no reconocidos.

    Nunca descarta un hallazgo por campos ausentes; ver reglas en el spec
    de la Fase 3 (Bucket 1 / Seam 1.2).
    """
    if _es_sin_hallazgos(texto):
        return ([], [])

    headers = list(_HALLAZGO_HEADER_RE.finditer(texto))
    if not headers:
        return ([], [f"{eval_id}: contenido sin bloques '## Hallazgo:' parseables"])

    hallazgos: list[Hallazgo] = []
    avisos: list[str] = []

    for i, header in enumerate(headers):
        titulo = header.group(1).strip()
        inicio_bloque = header.end()
        fin_bloque = headers[i + 1].start() if i + 1 < len(headers) else len(texto)
        bloque = texto[inicio_bloque:fin_bloque]

        campos = _parse_campos(bloque)
        hallazgo_id = f"{eval_id}-{i + 1:03d}"

        for clave, nombre in _NOMBRE_CANONICO.items():
            if campos[clave] is None:
                avisos.append(f"{hallazgo_id}: campo {nombre} ausente")

        severidad_raw = campos["severidad"]
        severidad = severidad_raw.strip().lower() if severidad_raw is not None else None
        if severidad is not None and severidad not in _SEVERIDADES_VALIDAS:
            avisos.append(f"{hallazgo_id}: severidad '{severidad}' no reconocida")

        linea_campo = campos["linea"]
        ubicacion = campos["ubicacion"]
        linea, linea_origen = _normalizar_linea(linea_campo, ubicacion)

        if linea_origen == "ubicacion":
            avisos.append(
                f"{hallazgo_id}: campo Línea ausente; línea derivada de Ubicación por regex"
            )
        elif (
            linea_origen == "ninguna"
            and linea_campo is not None
            and linea_campo.strip().lower() != "desconocida"
        ):
            avisos.append(f"{hallazgo_id}: campo Línea '{linea_campo}' no reconocible")

        hallazgos.append({
            "id": hallazgo_id,
            "evaluador": eval_id,
            "titulo": titulo,
            "severidad": severidad,
            "linea": linea,
            "linea_origen": linea_origen,
            "ubicacion": ubicacion,
            "problema": campos["problema"],
            "correccion_sugerida": campos["correccion sugerida"],
        })

    return (hallazgos, avisos)


# ── Consolidacion ───────────────────────────────────────────────────────────

def _estado_evaluador(raw: str, num_hallazgos: int) -> str:
    """Deriva el estado de un evaluador para el resumen del consolidado.

    'sin_hallazgos' si el contenido crudo, normalizado, es el centinela
    'no se encontraron hallazgos.'; 'no_parseable' si no produjo hallazgos
    y no es ese centinela (contenido sin bloques '## Hallazgo:'
    parseables); 'ok' si produjo al menos un hallazgo.
    """
    if _es_sin_hallazgos(raw):
        return "sin_hallazgos"
    if num_hallazgos == 0:
        return "no_parseable"
    return "ok"


def _construir_consolidado(
    evaluadores: list[str], contenidos: dict[str, str], session_id: str, generated_at: str
) -> tuple[dict, str]:
    """Construye el JSON y el markdown consolidados a partir de los
    hallazgos-<eval_id>.md ya leidos en memoria (`contenidos`). Funcion
    pura: no hace I/O ni llama a datetime.now(); `generated_at` se recibe
    como parametro para determinismo. Ver spec de la Fase 3 (Bucket 1 /
    Seam 1.3).
    """
    hallazgos: list[Hallazgo] = []
    avisos: list[str] = []
    resumen_evaluadores: list[dict] = []

    for eval_id in evaluadores:
        raw = contenidos[eval_id]
        hallazgos_i, avisos_i = _parse_hallazgos_md(raw, eval_id)
        hallazgos.extend(hallazgos_i)
        avisos.extend(avisos_i)
        resumen_evaluadores.append({
            "id": eval_id,
            "hallazgos": len(hallazgos_i),
            "estado": _estado_evaluador(raw, len(hallazgos_i)),
        })

    consolidado_json = {
        "generated_at": generated_at,
        "session_id": session_id,
        "evaluadores": resumen_evaluadores,
        "total_hallazgos": len(hallazgos),
        "hallazgos": hallazgos,
        "avisos": avisos,
    }

    num_aportaron = sum(1 for e in resumen_evaluadores if e["estado"] == "ok")
    secciones = [
        f"## Evaluador: {eval_id}\n\n{contenidos[eval_id]}"
        for eval_id in evaluadores
    ]
    encabezado = (
        "# Hallazgos Consolidados\n\n"
        f"- Generado: {generated_at}\n"
        f"- Evaluadores que aportaron: {num_aportaron} de {len(evaluadores)}\n"
        f"- Total hallazgos: {len(hallazgos)}\n\n"
    )
    consolidado_md = encabezado + "\n\n---\n\n".join(secciones)

    return (consolidado_json, consolidado_md)


# ── Agrupamiento ────────────────────────────────────────────────────────────

_SEVERIDAD_RANK = {"alta": 3, "media": 2, "baja": 1, "informativa": 0}


class _ClaveGrupo(NamedTuple):
    kind: str  # "linea" | "texto"
    valor: str

    def __str__(self) -> str:
        return f"{self.kind}:{self.valor}"


def _clave_grupo(finding: "Hallazgo") -> _ClaveGrupo:
    """Clave de agrupamiento = SOLO ubicacion normalizada, nunca severidad.
    kind='linea' si finding['linea'] no es None (comparacion exacta de
    string, rangos distintos nunca se fusionan); si no, kind='texto' con
    valor=ubicacion casefold + whitespace colapsado + strip.
    """
    linea = finding["linea"]
    if linea is not None:
        return _ClaveGrupo("linea", linea)
    ubicacion = finding["ubicacion"] or ""
    normalizada = re.sub(r"\s+", " ", ubicacion.casefold()).strip()
    return _ClaveGrupo("texto", normalizada)


def _normalizar_texto_dedup(texto: str | None) -> str:
    """Colapsa whitespace a un solo espacio y strip; None -> ''."""
    if texto is None:
        return ""
    return re.sub(r"\s+", " ", texto).strip()


def _severidad_maxima(hallazgos_grupo: list["Hallazgo"]) -> str:
    """Severidad (string) de mayor rango en el grupo; valores no reconocidos
    (incluida la ausencia de severidad, None) cuentan como rango -1;
    empate -> primero en orden de aparicion. Nunca devuelve None: si ningun
    hallazgo tiene severidad reconocida, se usa la del primero en orden de
    aparicion, o cadena vacia si esa tambien es None."""
    mejor = hallazgos_grupo[0]["severidad"] or ""
    mejor_rank = _SEVERIDAD_RANK.get(hallazgos_grupo[0]["severidad"], -1)
    for h in hallazgos_grupo[1:]:
        rank = _SEVERIDAD_RANK.get(h["severidad"], -1)
        if rank > mejor_rank:
            mejor = h["severidad"] or ""
            mejor_rank = rank
    return mejor


def _linea_sort_key(clave: _ClaveGrupo) -> tuple[int, int, int]:
    """Claves kind='linea' -> (0, inicio, fin); claves kind='texto' no se
    ordenan por esta funcion (se anexan despues, en orden de primera
    aparicion)."""
    valor = clave.valor
    if "-" in valor:
        inicio_str, fin_str = valor.split("-", 1)
    else:
        inicio_str = fin_str = valor
    return (0, int(inicio_str), int(fin_str))


def _agrupar_hallazgos(consolidado: dict, generated_at: str) -> dict:
    """Agrupa los hallazgos de un consolidado por ubicacion normalizada
    (linea o texto), nunca por severidad. Deduplica solo duplicados exactos
    intra-evaluador dentro de un mismo grupo. Funcion pura: no hace I/O ni
    llama a datetime.now(); `generated_at` se recibe como parametro para
    determinismo. Ver spec de la Fase 3 (Bucket 2 / Seam 2.1).
    """
    hallazgos_por_clave: dict[_ClaveGrupo, list[Hallazgo]] = {}
    orden_primera_aparicion: list[_ClaveGrupo] = []
    duplicados_eliminados = 0

    for finding in consolidado["hallazgos"]:
        clave = _clave_grupo(finding)
        if clave not in hallazgos_por_clave:
            hallazgos_por_clave[clave] = []
            orden_primera_aparicion.append(clave)

        grupo = hallazgos_por_clave[clave]
        es_duplicado = any(
            h["evaluador"] == finding["evaluador"]
            and _normalizar_texto_dedup(h["problema"]) == _normalizar_texto_dedup(finding["problema"])
            and _normalizar_texto_dedup(h["correccion_sugerida"]) == _normalizar_texto_dedup(finding["correccion_sugerida"])
            for h in grupo
        )
        if es_duplicado:
            duplicados_eliminados += 1
            continue
        grupo.append(finding)

    claves_linea = sorted(
        (c for c in orden_primera_aparicion if c.kind == "linea"),
        key=_linea_sort_key,
    )
    claves_texto = [c for c in orden_primera_aparicion if c.kind != "linea"]
    claves_ordenadas = claves_linea + claves_texto

    grupos = []
    for i, clave in enumerate(claves_ordenadas, start=1):
        hallazgos_grupo = hallazgos_por_clave[clave]
        primer = hallazgos_grupo[0]
        grupos.append({
            "grupo": i,
            "clave": str(clave),
            "linea": primer["linea"],
            "ubicacion": primer["ubicacion"],
            "severidad_maxima": _severidad_maxima(hallazgos_grupo),
            "hallazgos": hallazgos_grupo,
        })

    return {
        "generated_at": generated_at,
        "session_id": consolidado["session_id"],
        "total_grupos": len(grupos),
        "total_hallazgos": sum(len(g["hallazgos"]) for g in grupos),
        "duplicados_eliminados": duplicados_eliminados,
        "grupos": grupos,
    }


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
    # ── Phase 3: consolidate — all hallazgos, no consolidado.json ───────
    elif not _consolidado_json_path(session_dir).exists():
        result.update({
            "phase": "3",
            "phase_name": "consolidate",
            "next_action": "consolidar hallazgos con state.py consolidate (deterministico)",
            "actor": "coordinator",
            "stage_file": _stage_path("consolidate.md"),
            "pending": None,
            "progress": None,
        })
    # ── Phase 4: plan — consolidado.json exists, no plan-correccion.md ──
    elif not _plan_path(session_dir).exists():
        result.update({
            "phase": "4",
            "phase_name": "plan",
            "next_action": "agrupar hallazgos (script) y generar plan de correccion (worker)",
            "actor": "worker",
            "stage_file": _stage_path("plan.md"),
            "pending": None,
            "progress": None,
        })
    # ── Phase 5: correct — plan exists, no correccion ───────────────────
    elif not _correccion_path(session_dir).exists():
        result.update({
            "phase": "5",
            "phase_name": "correct",
            "next_action": "aplicar el plan de correccion al working file",
            "actor": "worker",
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


def _require_session_dir(args: list[str], usage: str) -> Path:
    """Valida args (>= 1) y resuelve+verifica el session dir, o exit(1) con
    los mensajes de error existentes ('Uso: <usage>' / 'Sesion ... no
    encontrada'). Devuelve el session dir resuelto."""
    if len(args) < 1:
        print(f"ERROR: Uso: {usage}", file=sys.stderr)
        sys.exit(1)

    session_id = args[0]
    sdir = _session_dir(session_id)

    if not sdir.exists():
        print(f"ERROR: Sesion '{session_id}' no encontrada en {sdir}.", file=sys.stderr)
        sys.exit(1)

    return sdir


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
    sdir = _require_session_dir(args, "state.py status <session_id>")
    session_id = args[0]

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
    consolidado = "si" if state.get("phase_name") in ("plan", "correct", "done") else "no"
    print(f"Consolidado: {consolidado}")

    # Plan status
    plan = "si" if _plan_path(sdir).exists() else "pendiente"
    print(f"Plan: {plan}")

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


def cmd_consolidate(args: list[str]) -> None:
    """Consolidate hallazgos-<eval_id>.md files into hallazgos-consolidado.md
    and hallazgos-consolidado.json.

    Usage: consolidate <session_id>
    """
    sdir = _require_session_dir(args, "state.py consolidate <session_id>")
    session_id = args[0]

    seleccion = _leer_json(_seleccion_path(sdir))
    if not seleccion or "evaluadores" not in seleccion:
        print(
            "ERROR: seleccion.json corrupto o ausente; ejecute init de nuevo",
            file=sys.stderr,
        )
        sys.exit(1)

    eval_ids = [ev["id"] for ev in seleccion["evaluadores"]]

    for eid in eval_ids:
        if not _hallazgos_path(sdir, eid).exists():
            print(
                f"ERROR: Falta hallazgos-{eid}.md; la fase de evaluacion no esta completa.",
                file=sys.stderr,
            )
            sys.exit(1)

    contenidos = {
        eid: _hallazgos_path(sdir, eid).read_text(encoding="utf-8")
        for eid in eval_ids
    }

    consolidado_json, consolidado_md = _construir_consolidado(
        eval_ids, contenidos, session_id=session_id, generated_at=datetime.now().isoformat()
    )

    _consolidado_path(sdir).write_text(consolidado_md, encoding="utf-8")
    _consolidado_json_path(sdir).write_text(
        json.dumps(consolidado_json, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print(f"Evaluadores: {len(eval_ids)}")
    for e in consolidado_json["evaluadores"]:
        print(f"  - {e['id']}: {e['estado']} ({e['hallazgos']} hallazgos)")
    print(f"Total hallazgos: {consolidado_json['total_hallazgos']}")
    for aviso in consolidado_json["avisos"]:
        print(f"Aviso: {aviso}")


def cmd_group(args: list[str]) -> None:
    """Group consolidated hallazgos by normalized ubicacion into
    hallazgos-agrupados.json.

    Usage: group <session_id>
    """
    sdir = _require_session_dir(args, "state.py group <session_id>")
    session_id = args[0]

    consolidado = _leer_json(_consolidado_json_path(sdir))
    if not consolidado:
        print(
            "ERROR: hallazgos-consolidado.json ausente o corrupto; ejecute consolidate primero.",
            file=sys.stderr,
        )
        sys.exit(1)

    for clave in ("session_id", "hallazgos"):
        if clave not in consolidado:
            print(
                f"ERROR: hallazgos-consolidado.json invalido o incompleto; falta la clave '{clave}'.",
                file=sys.stderr,
            )
            sys.exit(1)

    agrupados = _agrupar_hallazgos(consolidado, generated_at=datetime.now().isoformat())

    _agrupados_path(sdir).write_text(
        json.dumps(agrupados, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print(f"Total grupos: {agrupados['total_grupos']}")
    print(f"Total hallazgos: {agrupados['total_hallazgos']}")
    print(f"Duplicados eliminados: {agrupados['duplicados_eliminados']}")

    por_severidad: dict[str, int] = {}
    for grupo in agrupados["grupos"]:
        severidad = grupo["severidad_maxima"]
        por_severidad[severidad] = por_severidad.get(severidad, 0) + 1
    for severidad, cantidad in por_severidad.items():
        print(f"  - {severidad}: {cantidad}")


# ── Main ────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)

    sub = parser.add_subparsers(dest="command", required=True)

    init_cmd = sub.add_parser("init", help="Create a new revision session")
    init_cmd.add_argument("file", help="<file.md>")
    init_cmd.add_argument(
        "eval_ids", nargs="*",
        help="[eval_id ...]",
    )

    next_cmd = sub.add_parser("next", help="Derive current pipeline state")
    next_cmd.add_argument("session_id", help="Session ID (PPID)")

    status_cmd = sub.add_parser("status", help="Show human-readable session status")
    status_cmd.add_argument("session_id", help="Session ID (PPID)")

    consolidate_cmd = sub.add_parser(
        "consolidate", help="Consolidate hallazgos-<id>.md into one file"
    )
    consolidate_cmd.add_argument("session_id", help="Session ID (PPID)")

    group_cmd = sub.add_parser(
        "group", help="Group consolidated hallazgos by ubicacion"
    )
    group_cmd.add_argument("session_id", help="Session ID (PPID)")

    args = parser.parse_args()

    if args.command == "init":
        cmd_init([args.file] + args.eval_ids)
    elif args.command == "next":
        cmd_next([args.session_id])
    elif args.command == "status":
        cmd_status([args.session_id])
    elif args.command == "consolidate":
        cmd_consolidate([args.session_id])
    elif args.command == "group":
        cmd_group([args.session_id])

    return 0


if __name__ == "__main__":
    sys.exit(main())