# Stage: Plan (Phase 4 — Agrupamiento mecánico + plan de corrección conjunto)

## Cuándo se ejecuta
Cuando `state.py next` reporta `phase: 4, phase_name: "plan"`.

## Actores
- Script (`state.py group`) — agrupamiento mecánico, sin juicio.
- `redactor` — agente con capacidad de escritura. Redacta la corrección conjunta por grupo.

## Inputs recibidos de state.py
- `session_dir` — directorio de la sesión.
- `working_file` — ruta absoluta de la copia de trabajo.

## Proceso

### 1. Paso (a) — Agrupamiento mecánico

Ejecutar:

```bash
python3 <skill-dir>/state.py group <session_id>
```

Este comando lee `hallazgos-consolidado.json`, agrupa los hallazgos por ubicación normalizada
(misma línea → mismo grupo, sin importar la severidad de cada hallazgo individual), calcula la
severidad máxima por grupo, deduplica solo duplicados exactos intra-evaluador, y escribe
`<session_dir>/hallazgos-agrupados.json`.

Si el script termina con exit code distinto de 0: mostrar el error (stderr) al usuario y escalar.
Sin reintento — mismo razonamiento que en `stages/consolidate.md` (error determinístico de
precondición, no de subagente).

### 2. Short-circuit: sin grupos

Si `total_grupos == 0` en el JSON agrupado: el coordinador escribe directamente
`<session_dir>/plan-correccion.md` con:

```markdown
# Plan de corrección

- Generado: <fecha ISO 8601>
- Total grupos: 0

No hay correcciones que aplicar.
```

Informar al usuario y terminar el stage (no se invoca al `redactor`). Escribir este marcador no es
juicio del coordinador — es transcripción mecánica de "no hay grupos".

### 3. Confirmar con el usuario

Si `total_grupos > 0`, presentar el resumen del agrupamiento (total de grupos, desglose por
severidad máxima, duplicados eliminados) y preguntar: "¿Generar el plan de corrección conjunto?"

NO avanzar hasta que el usuario confirme explícitamente.

### 4. Paso (b) — Invocar al `redactor`

El coordinador lee `hallazgos-agrupados.json` (si < 300 líneas, lo incrusta en `[CONTEXTO]`; si es
grande, pasa la ruta absoluta e indica que lo lea con `read`).

```
[CONTEXTO]
Hallazgos agrupados por ubicacion (JSON):
--- INICIO ---
<contenido de hallazgos-agrupados.json>
--- FIN ---

Archivo de salida:
<session_dir>/plan-correccion.md

Formato de salida esperado:
--- INICIO FORMATO ---
# Plan de corrección

- Generado: <fecha ISO 8601>
- Total grupos: <N>
- Total hallazgos cubiertos: <M>

## Grupo <k> — <Línea N | Líneas N-M | Ubicación: "<texto>"> — severidad <severidad_maxima>

- Evaluadores: <eval1 (severidad), eval2 (severidad)>
- Hallazgos: <ids>

**Corrección integrada:** <UNA instrucción accionable que integra todos los
hallazgos del grupo en una sola corrección conjunta>
--- FIN FORMATO ---

[INSTRUCCION]
Modo: plan
1. Para cada grupo del JSON, redacta UNA "Corrección integrada" que combine todos
   los hallazgos del grupo (todos los ejes: heurística, APA, epistemología, etc.)
   en una sola instrucción de corrección — no una lista de correcciones separadas.
2. Escribe el plan completo en <session_dir>/plan-correccion.md usando la
   herramienta `write`, siguiendo EXACTAMENTE el formato de salida.

[LIMITES]
- Un bloque "## Grupo" por grupo del JSON, en el mismo orden, sin omitir ninguno.
- No inventes hallazgos ni correcciones fuera de los listados.
- No modifiques working.md ni ningún otro archivo — solo escribe plan-correccion.md.
- Output: sigue el protocolo definido en `references/subagent-protocol.md`.
```

### 5. Verificar

El `redactor` debe devolver "Work finished" (protocolo). Verificar además que
`plan-correccion.md` existe y que el número de encabezados `## Grupo` coincide con `total_grupos`
del JSON agrupado.

### 6. Manejo de fallos

1. Re-delegar una vez con el mismo prompt.
2. Si falla de nuevo: el coordinador escribe un **plan degradado mecánico** — mismo formato, pero
   cada "Corrección integrada" es la transcripción textual (verbatim) de las
   `correccion_sugerida` de cada hallazgo del grupo, una por línea, con esta cabecera adicional
   por grupo: `- Modo: degradado (transcripción mecánica; la integración por eje queda a cargo de
   la fase 5)`. El coordinador nunca redacta una corrección conjunta él mismo — solo transcribe
   verbatim (mismo precedente que el "consolidado mínimo" que existía en el pipeline anterior).

### 7. Avanzar

No se necesita comando adicional — el siguiente `state.py next` detectará que
`plan-correccion.md` existe y reportará `phase: 5, phase_name: "correct"`.
