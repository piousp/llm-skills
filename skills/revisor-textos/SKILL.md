---
name: revisor-textos
description: >
  Orquestador de revisiones academicas sobre textos en Markdown. Ejecuta un
  pipeline de evaluadores (filologica, heuristica, apa, falacias,
  defectos-epistemicos, hilo-conductor-historia, teivc, estructura-parrafo)
  usando subagentes. Pipeline state-machine con state.py read-only.
  NO usar para: correccion ortografica simple, analisis de sentimiento,
  traduccion, o textos que no esten en Markdown.
---

Clasificación: Preference skill — codifica un pipeline de revisión académica.
No se vuelve obsoleto por mejora del modelo base.

# Revisor de Textos — Coordinador

Siempre invocado por nombre (sin auto-trigger).

> **CRÍTICO:** Nunca avanzar a la siguiente fase hasta que el usuario lo confirme
> explícitamente. Antes de cada acción de evaluación o corrección, verificar que
> existe un subagente delegado para esa tarea. Si no, detenerse e informar (ver
> "Sin `subagent` disponible → solo informar" abajo) — nunca evaluar ni corregir
> directamente.

## La regla del coordinador

El agente principal ejecutando este skill es un **coordinador, no un ejecutor**. Puede
 explorar y leer libremente — archivos, historial, contexto existente — para entender
el estado del pipeline. Nunca debe evaluar contenido, aplicar correcciones, ni ejecutar
comandos de revisión él mismo. Cada una de esas acciones se delega a un subagente.

### Sin `subagent` disponible → solo informar

**Antes de cualquier acción de evaluación, consolidación o corrección**, verificar
que la herramienta `subagent` está disponible en el entorno actual. Si no está
disponible:

1. Informar al usuario explícitamente: "No tengo acceso a la herramienta `subagent`.
   Este skill requiere subagentes para delegar evaluación, plan o corrección."
2. Detenerse: no leer archivos bajo `evaluadores/` (trabajo del `analyst`), no
   intentar consolidar ni corregir (trabajo del `worker`), no ejecutar la revisión
   ni aplicar cambios directamente, y no seguir explorando archivos de la sesión.
3. Sugerir al usuario que ejecute este skill en un entorno con subagentes habilitados.

**Carve-out explícito**: el coordinador sí escribe y mantiene los archivos de estado
en el directorio de sesión: archivos markdown de hallazgos, archivos marcadores de
corrección. Esto no es "evaluar" — es registrar el resultado de las delegaciones para
que `state.py` pueda leerlo.

### Regla de lectura e incrustación

**El coordinador nunca pasa rutas de archivos a los subagentes sin contexto.**
Los subagentes se ejecutan con `inheritProjectContext: false` — no tienen contexto
del proyecto y no pueden resolver rutas relativas.

Estrategia según el tipo de archivo:

- **Archivos pequeños** (skills evaluadores, hallazgos markdown, < 300 líneas): el
  coordinador lee con `read` e incrusta el contenido textual en el prompt bajo
  `[CONTEXTO]`. Esto evita que el subagente tenga que leerlos.
- **Archivos grandes** (working file, miles de palabras): el subagente lo lee
  directamente usando la herramienta `read` con la ruta absoluta. El coordinador
  incluye la ruta exacta en el prompt y el subagente la usa explícitamente.

## Subagentes

Dos subagentes que **deben estar configurados en el harness** (ver Dependencias),
invocados por nombre. No se requieren agentes nuevos. Si no están configurados,
aplica la regla "no subagent → solo informar" (sección "Regla de subagentes" arriba).

- **`analyst`** — agente read-only de propósito general. Evalúa el documento contra
  un skill de revisión y reporta hallazgos en su **output textual** (markdown, nunca
  escribe archivos). Usado en evaluación.
- **`worker`** — agente con capacidad de escritura. Recibe hallazgos en markdown
  y un archivo de trabajo, aplica las correcciones sugeridas. Usado en la Fase 4
  (redacta el plan de corrección conjunto) y la Fase 5 (aplica el plan).

### Manejo de fallos de subagentes

Si un subagente devuelve output vacío, un error, o no completa la tarea:
1. Verificar la causa del fallo.
2. Escalar con el usuario con: qué subagente falló, qué se intentó,
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
Modo: <evaluacion | repair>
<tarea concreta en 1-3 oraciones>

[LÍMITES]
- <constraints específicos del paso>
- Output: <formato exacto del output esperado>
```

Reglas:

- **El coordinador lee los archivos y copia el contenido textual al prompt.**
  Nunca pasar rutas ni referencias a archivos. Usar `read` con la ruta del archivo;
  si la salida se trunca, continuar con `offset` hasta leer el archivo completo.
- **Los marcadores `--- INICIO ---` / `--- FIN ---`** delimitan cada bloque de
  contenido para que el subagente distinga entre contexto e instrucción.
- **`[INSTRUCCIÓN]`** es breve y concreta: 1-3 oraciones que describen exactamente
  qué hacer. No mezclar múltiples tareas en una invocación.
- **`[LÍMITES]`** especifica el formato exacto del output esperado.
- **Archivos grandes (> 300 líneas)**: el subagente usa `read` con la ruta absoluta
  proporcionada en el prompt. No incluir el contenido textual en el prompt.
  Indicar en `[LÍMITES]`: "Lee el archivo <ruta> usando la herramienta `read`."
- **Archivos pequeños (< 300 líneas)**: incluir el contenido textual en `[CONTEXTO]`.
  Indicar en `[LÍMITES]`: "No leas ningun archivo — todo el contenido esta en el prompt."
- Si un campo de contexto no aplica, omitirlo (no incluirlo vacío).
- Los prompts en los stages (`stages/*.md`) siguen este formato; no redefinen
  la sintaxis.

## Pipeline: 5 fases + terminal

### Fases

| Fase | Descripción | Actor |
|------|-------------|-------|
| **1 — Init** | Seleccionar archivo + evaluadores, crear sesión | Coordinador |
| **2 — Evaluate** | Evaluación paralela de todos los evaluadores via `subagent tasks` | analyst |
| **3 — Consolidate** | El coordinador ejecuta `state.py consolidate`; determinístico, sin subagente | Coordinador |
| **4 — Plan** | `state.py group` agrupa mecánicamente por párrafo (derivado de `working.md` por `state.py group`); el `worker` redacta un plan de corrección conjunto por grupo | worker |
| **5 — Correct** | Una sola pasada del `worker` con `plan-correccion.md` | worker |
| **Done** | Pipeline terminado; notificar al usuario | Coordinador |

### Loop de evaluadores

Dentro de la Fase 2 (Evaluate):
- Todos los evaluadores se lanzan en paralelo via `subagent tasks: [...]`.
- Máximo 4 concurrentes, máximo 8 evaluadores totales.

Dentro de la Fase 4 (Plan):
- El script agrupa mecánicamente por ubicación, luego una confirmación del usuario,
  luego una invocación al `worker` que redacta el plan de corrección conjunto.
- El `worker` reporta éxito/fallo vía `**Status:** COMPLETED | BLOCKED` en su resumen
  (ver `references/subagent-protocol.md`).

Dentro de la Fase 5 (Correct):
- Una sola pasada del `worker` con el plan.
- Una confirmación del usuario antes de la invocación.
- El `worker` reporta éxito/fallo vía `**Status:** COMPLETED | BLOCKED` en su resumen.

## Control flow: `state.py`

La secuencia de fases, el evaluador actual, y el siguiente paso son mecánicos —
derivados de los archivos en disco, no de juicio del coordinador.

```bash
python3 <skill-dir>/state.py next <session_id>
```

Retorna JSON con:

| Campo | Descripción |
|-------|-------------|
| `phase` | Número de fase (1-5), `"done"`, o `"error"` |
| `phase_name` | Nombre de la fase |
| `next_action` | Qué debe hacer el coordinador |
| `actor` | Subagente a invocar |
| `stage_file` | Ruta absoluta al archivo de stage, o `null` |
| `session_dir` | Ruta del directorio de sesión |
| `working_file` | Ruta de la copia de trabajo |
| `progress` | Progreso "M/N" (solo en evaluating) |
| `pending` | IDs de evaluadores pendientes |

Este script es **advisory** y **read-only** (excepto `init`, `consolidate` y `group`):
nunca pregunta al usuario, nunca decide qué hacer — solo reporta lo que los archivos ya
dicen. Además de `init`, `state.py` tiene los subcomandos `consolidate` y `group`.
`derive_state()` es 100% read-only, no escribe en disco.

### El loop

```
1. Ejecutar state.py init <file.md> [eval_ids] para crear la sesión.
2. Guardar el session_id (PPID).
3. Loop:
   a. Ejecutar state.py next <session_id>.
   b. Si stage_file es no-null → leer y ejecutar ese archivo de stage,
      esperar confirmación del usuario, volver a 3a.
   c. Si phase: "done" → presentar el resumen final (path al working file,
      status del plan y de la corrección) y detenerse. No hay handoff.
   d. Si phase: "error" → mostrar blocked_reason al usuario, escalar.
```

### Inicio de sesión

1. Ejecutar `state.py sessions` (sin argumentos). Lista, de forma read-only, los
   `<session_id>/` candidatos bajo `/tmp/revisor-textos/<basename(cwd)>/` (mtime
   + fase alcanzada en cada uno). El script nunca elige ni pregunta por su cuenta.
2. Si la lista está **vacía** — no hay sesión previa. Ir al paso 4.
3. Si la lista **no está vacía** — usar `ask_user_question` para ofrecer cada
   candidato (su mtime y fase) más la opción "empezar de cero". Nunca reanudar
   automáticamente: una respuesta ambigua u omitida significa empezar de cero
   bajo un `session_id` (PPID) nuevo, nunca adivinar cuál sesión previa reusar.
   Si el usuario elige reanudar, guardar ese `session_id` y saltar directamente
   al loop (paso 3a) — no volver a ejecutar `init`.
4. Preguntar al usuario: archivo a revisar y qué evaluadores aplicar. Ejecutar
   `state.py init <file.md> [eval_id ...]`.
5. Iniciar el loop.

El directorio de sesión vive en `/tmp/...` y no sobrevive a un reinicio de la
máquina — la reanudación del paso 3 solo cubre sesiones dentro del mismo ciclo
de vida de `/tmp`, nunca cross-reboot.

## Directorio de sesión

Cada sesión se almacena en `/tmp/revisor-textos/<basename(cwd)>/<PPID>/`:

| Archivo | Propósito |
|---------|-----------|
| `seleccion.json` | Evaluadores seleccionados (sin campo `fase`) |
| `original.md` | Copia inalterada del archivo original |
| `working.md` | Copia de trabajo modificable |
| `hallazgos-<eval>.md` | Hallazgos de cada evaluador (markdown con plantilla de `references/findings.md`) |
| `hallazgos-consolidado.md` | Consolidado de hallazgos de todos los evaluadores |
| `hallazgos-consolidado.json` | Vista estructurada del consolidado, usada por `state.py group` |
| `hallazgos-agrupados.json` | Agrupamiento mecánico por ubicación, regenerado en cada entrada a Fase 4 |
| `plan-correccion.md` | Plan de corrección conjunto por grupo de ubicación, escrito por el `worker` en Fase 4 |
| `correccion.md` | Marcador único de la corrección consolidada |

## Plantilla de hallazgos

Los hallazgos usan la plantilla definida en `references/findings.md`. Cada hallazgo
tiene cinco campos: Severidad, Línea, Ubicación, Problema, Corrección sugerida.

El coordinador pasa esta plantilla al `analyst` en el prompt de evaluación para que
el output siga el formato exacto.

## Iteration budget & escalation

- **Máximo 2 intentos por delegación** (original + 1 reintento) por subagente.
- **Máximo 4 evaluadores concurrentes** en evaluación paralela.
- **Máximo 8 evaluadores totales** por sesión.
- Si un subagente falla 2 veces:
  - Si es el `analyst` en evaluación: omitir ese evaluador del consolidado.
  - Si es el `worker` en correct: marcar `correccion.md` con Status: failed.
  - Si el `worker` falla 2 veces en Plan (Fase 4): el coordinador escribe un plan
    degradado (transcripción mecánica verbatim de las correcciones sugeridas, sin
    redactar nada nuevo).
- Si el archivo de trabajo se corrompe (no es Markdown válido), restaurar desde
  `original.md` y re-ejecutar la fase.

## Anti-patterns

- **El coordinador evaluando o corrigiendo contenido** — siempre delegar a `analyst`
  o `worker`.
- **El subagente escribiendo archivos de hallazgos** — `analyst` reporta en su output
  textual; el coordinador escribe el markdown.
- **El subagente ejecutando comandos** — `analyst` y `worker` sí tienen `bash` en su
  configuración, pero no deben usarlo para esta tarea: evaluación/corrección de
  contenido es lectura y escritura de texto, no ejecución.
- **Saltarse la confirmación del usuario** — cada fase requiere confirmación
  explícita (las fases 4 y 5 tienen una sola confirmación cada una, no una por
  hallazgo/grupo).
- **Ignorar el estado de `state.py`** — si `state.py` reporta una fase, confiar en
  ella. No re-derivar el estado manualmente.
- **El coordinador escribiendo archivos de trabajo** — solo `worker` modifica
  `working.md`. El coordinador solo escribe archivos de hallazgos y marcadores.
- **Pasar rutas de archivos a los subagentes sin contexto** — los subagentes tienen
  `inheritProjectContext: false` y no pueden resolver rutas del proyecto.
  Siempre leer el archivo con `read` e incrustar el contenido textual en el prompt
  bajo `[CONTEXTO]`, o proporcionar la ruta absoluta para archivos grandes.
- **Lanzar evaluadores secuencialmente** — en Fase 2, usar `subagent tasks: [...]`
  para lanzar todos en paralelo.
- **Generar archivos intermedios de corrección por evaluador** — el worker hace una
  sola pasada sobre el consolidado; no se generan `correccion-<eval>.md`.
- **Ejecutar la fase de handoff** — eliminada del pipeline; el done es solo notificación.
- **Pasar el plan al worker por secciones** — el worker recibe `plan-correccion.md`
  completo y hace una sola pasada.
- **Delegar la consolidación o el agrupamiento a un subagente** — son pasos
  determinísticos de `state.py` (`consolidate`, `group`), nunca del `worker`.
- **El `worker` de la Fase 5 leyendo los hallazgos crudos** — consume
  `plan-correccion.md`, nunca `hallazgos-consolidado.md`/`.json` directamente.

## Dependencias

- Python 3.6+ (para `state.py`).
- `analyst` y `worker` subagentes configurados en el harness.
- Archivos de evaluadores en `evaluadores/` dentro de este skill.
- Configuración de evaluadores en `evaluadores.json`.