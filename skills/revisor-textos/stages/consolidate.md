# Stage: Consolidate (Phase 3 — Consolidación de hallazgos)

## Cuándo se ejecuta
Cuando `state.py next` reporta `phase: 3, phase_name: "consolidate"`.

## Actor
`redactor` — agente con capacidad de escritura. Lee los hallazgos individuales y escribe el consolidado.

## Inputs recibidos de state.py
- `session_dir` — directorio de la sesión.
- `working_file` — ruta absoluta de la copia de trabajo.
- `evaluadores` — lista de IDs de evaluadores (de `seleccion.json`).

## Proceso

### 1. Confirmar con el usuario

Preguntar: "¿Consolidar los hallazgos de todos los evaluadores en un solo archivo?"

NO avanzar hasta que el usuario confirme explícitamente.

### 2. Preparar el prompt (el coordinador)

El coordinador prepara un prompt para el `redactor` con las rutas absolutas a los archivos `hallazgos-<eval>.md` y la ruta de salida.

Estrategia: los archivos de hallazgos son pequeños (< 300 líneas cada uno), por lo que el coordinador puede incrustar el contenido en el prompt bajo `[CONTEXTO]`. Si hay muchos hallazgos, usar rutas absolutas para que el redactor lea directamente.

### 3. Invocar al `redactor`

```
[CONTEXTO]
Archivos de hallazgos a consolidar (orden de seleccion.json):
<lista de rutas absolutas, una por linea>

Archivo de salida:
<session_dir>/hallazgos-consolidado.md

Formato de salida esperado:
--- INICIO FORMATO ---
# Hallazgos Consolidados

- Generado: <fecha ISO 8601>
- Evaluadores que aportaron: <M de N>
- Total hallazgos: <N>

## Evaluador: <eval_id_1>

<contenido de hallazgos-<eval_id_1>.md>

---

## Evaluador: <eval_id_2>

<contenido de hallazgos-<eval_id_2>.md>
--- FIN FORMATO ---

[INSTRUCCION]
Modo: consolidation
1. Lee cada archivo de hallazgos usando la herramienta `read` con la ruta exacta.
2. Construye un unico archivo consolidado siguiendo EXACTAMENTE el formato de salida.
3. Escribe el archivo consolidado en <session_dir>/hallazgos-consolidado.md usando la herramienta `write`.

[LIMITES]
- No modifiques el contenido de los hallazgos — conservalos textualmente.
- No introduzcas cambios ni evaluaciones nuevas.
- Preserva el orden de los evaluadores tal como aparece en la lista.
- Output: sigue el protocolo definido en `references/subagent-protocol.md`.
```

### 4. Verificar

Después de que `redactor` confirme, verificar que `<session_dir>/hallazgos-consolidado.md` existe y tiene contenido.

### 5. Manejo de fallos

Si el redactor devuelve output vacío, error, o no escribe el archivo:
1. Re-delegar una vez con el mismo prompt.
2. Si falla de nuevo, el coordinador escribe un consolidado mínimo directamente.

### 6. Avanzar

No se necesita comando adicional — el siguiente `state.py next` detectará que `hallazgos-consolidado.md` existe y reportará `phase: 4, phase_name: "correct"`.