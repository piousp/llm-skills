---
name: revisor-textos
description: >
  Orquestador de revisiones academicas. Coordina la ejecucion secuencial de
  evaluadores (filologico, heuristico, APA, falacias, defectos epistemicos)
  sobre un texto en Markdown. Usa analyst (evaluar) y redactor (corregir).
  Pipeline state-machine con state.py read-only.
---

# Revisor de Textos — Coordinador

Siempre invocado por nombre (sin auto-trigger).

# *CRÍTICO*

**Nunca avanzar a la siguiente fase hasta que el usuario lo confirme explícitamente.**
Antes de cada acción de evaluación o corrección, verificar que existe un subagente
delegado para esa tarea. Si no, detenerse y delegar. No evaluar ni corregir directamente.

## La regla del coordinador

El agente principal ejecutando este skill es un **coordinador, no un ejecutor**. Puede
explorar y leer libremente — archivos, historial, contexto existente — para entender
el estado del pipeline. Nunca debe evaluar contenido, aplicar correcciones, ni ejecutar
comandos de revisión él mismo. Cada una de esas acciones se delega a un subagente.

**Carve-out explícito**: el coordinador sí escribe y mantiene los archivos de estado
en el directorio de sesión: archivos JSON de hallazgos, archivos marcadores de
corrección, archivos de verificación. Esto no es "evaluar" — es registrar el resultado
de las delegaciones para que `state.py` pueda leerlo.

### Regla de lectura e incrustación

**El coordinador nunca pasa rutas de archivos a los subagentes sin contexto.**
Los subagentes se ejecutan con `inheritProjectContext: false` — no tienen contexto
del proyecto y no pueden resolver rutas relativas.

Estrategia según el tipo de archivo:

- **Archivos pequeños** (skills evaluadores, hallazgos JSON, < 300 líneas): el
  coordinador lee con `read` e incrusta el contenido textual en el prompt bajo
  `[CONTEXTO]`. Esto evita que el subagente tenga que leerlos.
- **Archivos grandes** (working file, miles de palabras): el subagente lo lee
  directamente usando la herramienta `read` con la ruta absoluta. El coordinador
  incluye la ruta exacta en el prompt y el subagente la usa explícitamente.

## Subagentes

Dos subagentes **ya existentes**, invocados por nombre. No se requieren agentes nuevos.

- **`analyst`** — agente read-only de propósito general. Evalúa el documento contra
  un skill de revisión y reporta hallazgos en su **output textual** (nunca escribe
  archivos). Usado en evaluación (primer pase) y verificación (segundo pase).
- **`redactor`** — agente con capacidad de escritura. Recibe un archivo JSON de
  hallazgos y un archivo de trabajo, aplica las correcciones sugeridas. Usado en
  corrección (primer y segundo pase).

### Manejo de fallos de subagentes

Si un subagente devuelve output vacío, un error, o no completa la tarea:
1. Re-delegar una vez con el mismo prompt (puede ser un fallo transitorio).
2. Si falla de nuevo, escalar al usuario con: qué subagente falló, qué se intentó,
   y el mensaje de error exacto.
3. No intentar parchear el trabajo del subagente — el coordinador no es ejecutor.

### Formato canónico de prompts para subagentes

Todo prompt a un subagente se ensambla con esta estructura de tres secciones,
separando contexto de instrucción. Los subagentes se ejecutan en contexto
ajeno (`inheritProjectContext: false`) — no han visto la conversación previa,
no pueden leer archivos del proyecto, y no reciben el contexto del harness.

```
[CONTEXTO]
Skill de revision:
--- INICIO ---
<contenido del archivo evaluador, copiado textualmente por el coordinador>
--- FIN ---

Documento a revisar:
--- INICIO ---
<contenido del archivo de trabajo, copiado textualmente por el coordinador>
--- FIN ---

[INSTRUCCIÓN]
Modo: <evaluacion | repair | verificacion>
<tarea concreta en 1-3 oraciones>

[LÍMITES]
- No leas ningun archivo — todo el contenido esta en este prompt.
- <constraints específicos del paso>
- Output: <formato exacto del output esperado>
```

Reglas:

- **El coordinador lee los archivos y copia el contenido textual al prompt.**
  Nunca pasar rutas ni referencias a archivos. Usar `ctx_read` con `mode="full"`.
- **Los marcadores `--- INICIO ---` / `--- FIN ---`** delimitan cada bloque de
  contenido para que el subagente distinga entre contexto e instrucción.
- **`[INSTRUCCIÓN]`** es breve y concreta: 1-3 oraciones que describen exactamente
  qué hacer. No mezclar múltiples tareas en una invocación.
- **`[LÍMITES]`** incluye siempre "No leas ningun archivo — todo el contenido
  esta en este prompt" para prevenir que el subagente intente leer archivos
  y se cuelgue.
- **`[LÍMITES]`** especifica el formato exacto del output esperado, normalmente
  un bloque JSON.
- Si un campo de contexto no aplica, omitirlo (no incluirlo vacío).
- Los prompts en los stages (`stages/*.md`) siguen este formato; no redefinen
  la sintaxis.

## Pipeline: 4 fases, 2 loops

Dos niveles de loop:

1. **Loop de fases** (Init → First Pass → Second Pass → Finish) — manejado por `state.py`.
2. **Loop de evaluadores** (filológica, heurística, APA, falacias, defectos-epistémicos)
   — dentro de las fases First Pass y Second Pass. `state.py` trackea qué evaluador
   y qué paso (evaluate/correct/verify) toca, derivando de los archivos en disco.

### Fases

| Fase | Descripción | Actor |
|------|-------------|-------|
| **1 — Init** | Seleccionar archivo + evaluadores, crear sesión | Coordinador |
| **2 — First Pass** | Loop: evaluar → corregir cada evaluador | analyst / redactor |
| **3 — Second Pass** | Loop: verificar regresiones por evaluador | analyst / redactor |
| **4 — Finish** | Diff, entrega, resumen, handoff | Coordinador |

## Control flow: `state.py`

La secuencia de fases, el evaluador actual, y el siguiente paso son mecánicos —
derivados de los archivos en disco, no de juicio del coordinador.

```bash
python3 <skill-dir>/state.py next <session_id> --dir <project-root>
```

Retorna JSON con:

| Campo | Descripción |
|-------|-------------|
| `phase` | Número de fase (1-4) o `"done"` |
| `phase_name` | Nombre de la fase |
| `evaluator` | ID del evaluador actual (solo fases 2-3) |
| `evaluator_index` | Índice del evaluador actual (0-based) |
| `total_evaluators` | Total de evaluadores seleccionados |
| `step` | `"evaluate"`, `"correct"`, `"verify"`, o `null` |
| `next_action` | Qué debe hacer el coordinador |
| `actor` | Subagente a invocar |
| `stage_file` | Ruta absoluta al archivo de stage, o `null` |
| `session_dir` | Ruta del directorio de sesión |
| `working_file` | Ruta de la copia de trabajo |
| `evaluator_skill` | Ruta al skill del evaluador actual (si aplica) |
| `findings_file` | Ruta al archivo de hallazgos (si aplica) |

Este script es **advisory** y **read-only** (excepto `init`): nunca pregunta al usuario,
nunca decide qué hacer — solo reporta lo que los archivos ya dicen.

### El loop

```
1. Ejecutar state.py init <file.md> [eval_ids] para crear la sesión.
2. Guardar el session_id.
3. Loop:
   a. Ejecutar state.py next <session_id>.
   b. Si stage_file es no-null → leer y ejecutar ese archivo de stage,
      esperar confirmación del usuario, volver a 3a.
   c. Si phase: "done" → ejecutar el handoff y detenerse.
   d. Si phase: "error" → mostrar blocked_reason al usuario, escalar.
```

### Inicio y reanudación

#### Sesión nueva

1. Preguntar al usuario: archivo a revisar y qué evaluadores aplicar.
2. Ejecutar `state.py init` con la respuesta.
3. Iniciar el loop.

#### Reanudación cross-session

Si al iniciar el skill se detecta un directorio `revision/` con sesiones previas:

1. Preguntar al usuario: "Se detectaron sesiones previas. ¿Iniciar una nueva
   o reanudar una existente?"
2. Si reanuda: pedir el session_id, ejecutar `state.py next <session_id>` para
   conocer el estado, y continuar desde allí.
3. Si nueva: proceder como sesión nueva.

## Archivos de sesión

Cada sesión se almacena en `<project-root>/revision/<session_id>/`:

| Archivo | Propósito |
|---------|-----------|
| `original.md` | Copia inalterada del archivo original |
| `working.md` | Copia de trabajo modificable |
| `seleccion.json` | Evaluadores seleccionados, fase actual |
| `hallazgos-<eval>.json` | Hallazgos de cada evaluador (primer pase) |
| `corregido-<eval>.md` | Marcador de corrección aplicada (primer pase) |
| `verificacion-<eval>.json` | Resultado de verificación (segundo pase) |
| `diff.md` | Diff entre original y working (generado en finish) |

## Iteration budget & escalation

- **Máximo 2 intentos por delegación** (original + 1 reintento) por subagente.
- Si un subagente falla 2 veces, marcar el evaluador como "fallido", registrarlo
  en decisions.md, y continuar con el siguiente.
- Si el archivo de trabajo se corrompe (no es Markdown válido), restaurar desde
  `original.md` y re-ejecutar el último evaluador.

## Anti-patterns

- **El coordinador evaluando o corrigiendo contenido** — siempre delegar a `analyst`
  o `redactor`.
- **El subagente escribiendo archivos de hallazgos** — `analyst` reporta en su output
  textual; el coordinador escribe el JSON.
- **El subagente ejecutando comandos** — ni `analyst` ni `redactor` tienen `bash`
  (o si lo tienen, no deben usarlo para esta tarea). Son agentes de contenido.
- **Saltarse la confirmación del usuario entre evaluadores** — cada fase y cada
  evaluador requiere confirmación explícita.
- **Ignorar el estado de `state.py`** — si `state.py` reporta una fase, confiar en
  ella. No re-derivar el estado manualmente.
- **El coordinador escribiendo archivos de trabajo** — solo `redactor` modifica
  `working.md`. El coordinador solo escribe archivos de hallazgos, marcadores y
  archivos de salida.
- **Pasar rutas de archivos a los subagentes** — los subagentes tienen
  `inheritProjectContext: false` y no pueden resolver rutas del proyecto.
  Siempre leer el archivo con `ctx_read` e incrustar el contenido textual en el
  prompt bajo `[CONTEXTO]`.

## Dependencias

- Python 3.6+ (para `state.py`).
- `diff` (para generar diff entre original y corregido, en finish).
- `analyst` y `redactor` subagentes configurados en el harness.
- Archivos de evaluadores en `evaluadores/` dentro de este skill.
- Configuración de evaluadores en `evaluadores.json`.