# Auditoría de `revisor-textos` vs `iterative-design`

Baseline: [iterative-design](../iterative-design/SKILL.md)
Auditado: [revisor-textos](./SKILL.md)

Fecha: 2025-07-29

---

## Resumen de hallazgos

| # | Hallazgo | Severidad | Archivo | Recomendación |
|---|----------|-----------|---------|---------------|
| 1 | `derive_state()` escribe en disco, violando su contrato read-only | **Crítica** | `state.py:171,201` | Separar escritura del cómputo de estado |
| 2 | Referencia a herramienta inexistente `ctx_read` | **Crítica** | `SKILL.md:98,230` | Cambiar a `read` |
| 3 | Contradicción: template dice "no leer archivos", stages dicen "leer working file" | **Alta** | `SKILL.md:90,103` vs `stages/evaluate.md:37-38, stages/correct.md:28` | Armonizar; el template debe reflejar la excepción para archivos grandes |
| 4 | Falta mecanismo `sessions` para reanudación cross-session | **Alta** | `state.py` (ausente) | Implementar subcomando `sessions` análogo al de iterative-design |
| 5 | `state.py` no acepta `--dir` después del session_id en `next` | **Media** | `state.py:323-324` | El `--dir` es argparse global, debería funcionar; probar caso `next <id> --dir <ruta>` |
| 6 | Fallback de JSON malformado insuficiente | **Media** | `stages/evaluate.md:49-50` | Añadir plan de contingencia documentado tras 2 reintentos fallidos |
| 7 | Sin equivalente de `decisions.md` para auditoría | **Media** | `SKILL.md` (ausente) | Considerar crear registro de decisiones para reanudación y trazabilidad |
| 8 | Verify loop sin límite de iteraciones | **Media** | `stages/verify.md:38-39` | Acotar reintentos en el sub-loop verify→correct→verify |
| 9 | `argparse.REMAINDER` puede tragarse `--dir` | **Baja** | `state.py:291` | Usar `nargs='*'` con manejo explícito en `cmd_init` |
| 10 | Sin guía de fallback para subagentes no disponibles | **Baja** | `SKILL.md:55-56` | Añadir "si no está configurado, delegar mediante subagent tool" |
| 11 | Verificación de corrupción de working file no implementada en stages | **Baja** | `SKILL.md:134-135` (mencionado) vs stages (ausente) | Referenciar la regla de restauración desde cada stage relevante |
| 12 | ~~Sin mecanismo de `--design-dir` o equivalente; state.py opera sobre cwd~~ **OBSOLETO** — El fix reemplazó `--design-dir` con `Path.cwd().name` como clave de sesión. | **Informativa** | `state.py:260` | Resuelto: ahora usa `Path.cwd().name` en lugar de `--design-dir` |

---

## 1. Arquitectura y estructura del SKILL.md

### Coordinador como no-ejecutor

Ambos skills establecen la misma regla fundamental: el agente que ejecuta el skill es un coordinador, no un ejecutor, y delega todo trabajo sustantivo a subagentes. Ambos definen un carve-out explícito para que el coordinador escriba archivos de estado/artefactos.

**Fortalezas de revisor-textos:**
- El carve-out es más simple y directo que el de iterative-design: "el coordinador escribe archivos JSON de hallazgos, marcadores de corrección, archivos de verificación".
- La regla de lectura e incrustación (archivos pequeños → incrustar en prompt; archivos grandes → subagente lee con `read`) es pragmática y bien documentada.
- El formato canónico de prompts (`[CONTEXTO]` / `[INSTRUCCIÓN]` / `[LÍMITES]`) es riguroso y consistente.

**Debilidades de revisor-textos:**
- No hay guía de fallback si los subagentes `analyst` o `redactor` no están configurados en el harness. iterative-design dedica un párrafo explícito a esto ("If your harness has no subagent/delegation mechanism, say so...") y da instrucciones de respaldo por rol genérico.
- La referencia a `ctx_read` (líneas 98 y 230 del SKILL.md) es a una herramienta que **no existe** en el inventario de herramientas del agente. La herramienta correcta es `read`. Esto es un bug que haría fallar al coordinador novato que siga las instrucciones al pie de la letra.
- No hay un equivalente de `decisions.md` para registrar decisiones de diseño o desviaciones del plan.

### Reglas de git

Iterative-design tiene reglas detalladas sobre no mutar el repo (`git commit`, `git tag`, etc.). revisor-textos no necesita estas reglas porque no interactúa con git — esto es correcto y no es una debilidad.

---

## 2. state.py: control de flujo y gestión de estado

### 2a. Violación del contrato read-only (CRÍTICO)

El docstring de `revisor-textos/state.py` (línea 5) dice:

> *"Read-only over the session directory on disk. Derives the current phase, evaluator position, and next action from artifact files — never maintains its own mutable state file, so it cannot desync."*

Sin embargo, `derive_state()` **escribe en disco** en dos lugares:

```python
# Línea 171 — dentro del bloque first_pass
seleccion["fase"] = "second_pass"
_escribir_seleccion(sdir, seleccion)  # ESCRIBE

# Línea 201 — dentro del bloque second_pass
seleccion["fase"] = "finish"
_escribir_seleccion(sdir, seleccion)  # ESCRIBE
```

Esto es una violación directa del contrato. `derive_state()` debería ser puramente una función de lectura. La escritura debería ocurrir en un comando separado (`advance` o `transition`), o ser responsabilidad exclusiva del coordinador después de leer el estado.

**Impacto:** Si `derive_state()` se llama dos veces en el mismo ciclo (por ejemplo, el coordinador lo ejecuta, luego un stage lo re-ejecuta para verificar), la segunda llamada puede encontrar un estado diferente al de la primera porque la primera llamada ya lo mutó. Esto rompe la idempotencia esperada de una función de solo lectura.

**Comparación con iterative-design:** `iterative-design/scripts/state.py` `derive_state()` es **puramente read-only**. Nunca escribe nada en disco. La transición de fase se deriva exclusivamente de la presencia/ausencia de artefactos en `$DESIGN_DIR` y de las entradas en `decisions.md`.

### 2b. Falta de subcomando `sessions` (ALTA)

El SKILL.md de revisor-textos (sección "Reanudación cross-session") describe un flujo de reanudación:

> *"Si al iniciar el skill se detecta un directorio `revision/` con sesiones previas: Preguntar al usuario: 'Se detectaron sesiones previas. ¿Iniciar una nueva o reanudar una existente?'"*

Pero `state.py` no tiene ningún subcomando para listar sesiones previas. iterative-design tiene `state.py sessions` que lista los directorios `<PID>/` bajo la clave de repo, con mtime y fase alcanzada.

**Impacto:** El coordinador no tiene un mecanismo programático para ofrecer opciones al usuario. Tendría que hacer `ls revision/` por su cuenta, parsear directorios, y leer `seleccion.json` de cada uno — exactamente el tipo de lógica que `state.py` debería encapsular.

### 2c. Subcomando `status` (sí existe)

A diferencia de lo que podría pensarse, revisor-textos sí tiene `cmd_status` (línea 320), que muestra estado legible. Esto es correcto. iterative-design no tiene un equivalente directo (usa `sessions` para listar y `next` para estado).

### 2d. `--dir` como argparse global vs. posicional

**OBSOLETO (post-fix):** `state.py` ya no acepta `--design-dir`. La clave de sesión se deriva de `Path.cwd().name`, eliminando la necesidad de pasar `--design-dir` o `--dir` explícitamente. El argparse sigue usando `--dir` como argumento global con `default="."`, pero la sesión se resuelve por `cwd` en lugar de por un flag.

---

## 3. Sistema de stages

### 3a. Estructura de stages

Iterative-design tiene una estructura consistente en todos sus stages:
- **Preflight** — skills o herramientas que cargar
- **How to run** — secuencia de pasos
- **Exit criteria** — condiciones para dar por terminada la fase

revisor-textos tiene una estructura diferente:
- **Cuándo se ejecuta** — trigger
- **Actor** — subagente responsable
- **Inputs recibidos de state.py** — datos del contexto
- **Proceso** — pasos detallados
- **Avanzar** — cómo continúa el pipeline

Ambas estructuras son válidas. La de revisor-textos es más procedural y la de iterative-design más declarativa. La diferencia principal es que iterative-design explicita las condiciones de salida, lo que ayuda a evitar ambigüedad sobre cuándo una fase está completa.

### 3b. Formato de prompts en stages

Los stages de revisor-textos siguen fielmente el formato canónico definido en el SKILL.md. Esto es una fortaleza.

**Sin embargo**, hay una contradicción entre el template canónico y los stages concretos:

| Fuente | Dice | Implicación |
|--------|------|-------------|
| `SKILL.md:90` (template) | `- No leas ningun archivo — todo el contenido esta en este prompt.` | El subagente no debe usar `read` |
| `stages/evaluate.md:37-38` | `1. Lee el archivo <working_file> usando la herramienta \`read\` con la ruta exacta.` | El subagente DEBE usar `read` |
| `stages/correct.md:28` | `1. Lee el archivo <working_file> usando la herramienta \`read\` con la ruta exacta.` | El subagente DEBE usar `read` |

La intención es clara: archivos pequeños se incrustan, archivos grandes se leen con `read`. Pero el template canónico en el SKILL.md contradice esta práctica. El template debería reflejar la excepción:

```
- Archivos pequeños (< 300 líneas): todo el contenido está en este prompt.
- Archivos grandes: leer usando la herramienta `read` con la ruta absoluta proporcionada.
```

### 3c. Referencia a la cota de iteraciones

Iterative-design menciona la cota de iteraciones (`max 2 attempts`) explícitamente dentro de cada stage (ej. `stages/tdd.md`: "counts toward the iteration budget: max 2 attempts total for this seam"). Los stages de revisor-textos no lo hacen — la cota está definida en el SKILL.md pero no se repite en los stages, por lo que el coordinador que ejecuta un stage de forma aislada podría no saber que existe un límite.

### 3d. Sub-loop verify sin cota (MEDIA)

El stage `verify.md` (segundo pase) puede delegar corrección a `redactor` si se encuentran regresiones. Pero no hay un límite documentado en cuántas veces puede repetirse el ciclo `verify → correct → verify`. Si `redactor` introduce nuevas regresiones, el ciclo podría continuar indefinidamente.

Iterative-design maneja esto con su regla de "max 2 attempts" que se aplica a cada delegación y a cada ciclo BLOCK → re-run.

---

## 4. Patrones de delegación a subagentes

### 4a. Guía de fallback

Iterative-design dedica espacio significativo a especificar qué hacer si un subagente concreto no está disponible:

> *"`pablo-planner`, `pablo-implementer`, `code-review-checklist`, and `qa-adversary` are all specific, named subagents — invoke them by name when your harness has them configured. If a named agent isn't available, fall back to the generic role description..."*

revisor-textos simplemente asume que `analyst` y `redactor` existen:

> *"Dos subagentes **ya existentes**, invocados por nombre. No se requieren agentes nuevos."*

Si el harness no tiene estos subagentes, el coordinador se queda sin instrucciones.

### 4b. Parsing de output del subagente

Iterative-design tiene un mecanismo de parsing basado en marcadores (`<!-- BEGIN PLAN -->` / `<!-- END PLAN -->`) con una estrategia de fallback documentada: si los marcadores están malformados, reintentar una vez; si el error persiste pero hay un marcador detectable, split heurístico; si nada funciona, escalar al usuario.

revisor-textos espera JSON del subagente `analyst` y dice "Extraerlo y parsearlo. Si el JSON no es parseable, reintentar una vez." Pero no hay un plan de contingencia si el segundo intento también falla. El coordinador no sabría qué hacer, y el SKILL.md no lo cubre.

### 4c. Contexto fresco vs. incrustación

revisor-textos establece explícitamente que `inheritProjectContext: false` y que los subagentes no pueden resolver rutas relativas. La estrategia de archivos pequeños (incrustar) vs. grandes (ruta absoluta + `read`) es correcta y pragmática.

---

## 5. Manejo de errores y escalación

### 5a. Cota de iteraciones

revisor-textos define:

> *"Máximo 2 intentos por delegación (original + 1 reintento) por subagente."*

Iterative-design define:

> *"max 2 attempts per seam (Phase 3 red→green), per refactor candidate (Phase 4), and per qa-adversary BLOCK re-run cycle (Phase 5) — an attempt is one full delegation cycle"*

La diferencia es que iterative-design especifica **qué cuenta como un intento** ("one full delegation cycle") y lo aplica granularmente a cada concepto del pipeline (seam, candidato, ciclo BLOCK). revisor-textos lo deja más abierto.

### 5b. Corrupción de archivo de trabajo

revisor-textos sí menciona este caso en el SKILL.md:

> *"Si el archivo de trabajo se corrompe (no es Markdown válido), restaurar desde `original.md` y re-ejecutar el último evaluador."*

Pero los stages no referencian esta regla. Un coordinador que solo lea el stage `correct.md` o `verify.md` no sabría que existe este mecanismo de recuperación.

### 5c. Registro de decisiones

Iterative-design mantiene `$DESIGN_DIR/decisions.md` como un registro append-only de decisiones de diseño, respuestas a gates, candidatos de refactor rechazados, etc. Este archivo es también la fuente de verdad que `state.py` parsea para determinar el estado del pipeline.

revisor-textos no tiene equivalente. Las decisiones (qué evaluadores aplicar, por qué se saltó uno, etc.) solo existen en la conversación. Si el coordinador se pierde o se necesita reanudar una sesión, no hay un registro durable de las decisiones tomadas.

---

## 6. Handoff y finalización

### 6a. Etapa Finish

revisor-textos tiene un stage `finish.md` completo que:
1. Genera diff con `diff -u`
2. Copia archivos a directorio de salida
3. Genera resumen markdown
4. Presenta todo al usuario

Esto es más concreto y detallado que el handoff de iterative-design, que solo dice "report to the user: `$DESIGN_DIR`'s path, the final artifacts produced, every gate answer and load-bearing decision from `decisions.md`".

### 6b. Gates y fases opcionales

Iterative-design tiene un sistema de gates (fases 4 y 5 son opcionales, con pregunta explícita al usuario). revisor-textos no necesita gates porque todas las fases son obligatorias (First Pass, Second Pass, Finish). Esto es correcto para el dominio.

### 6c. Handoff sin decisiones

Al no tener `decisions.md`, el handoff de revisor-textos no puede reportar "cada respuesta a gate y decisión importante". Esto es aceptable si el pipeline es completamente determinista (todos los evaluadores se aplican siempre), pero limita la trazabilidad cuando el usuario decide saltarse un evaluador o modificar el orden.

---

## 7. Problemas específicos en `state.py`

### 7a. `argparse.REMAINDER` puede tragarse `--dir`

En la línea 291:

```python
init_cmd.add_argument("args", nargs=argparse.REMAINDER,
                      help="<file.md> [eval_id ...]")
```

`REMAINDER` consume todos los argumentos restantes, incluyendo `--dir` si se coloca después del subcomando `init`. Esto es un bug de baja probabilidad pero conocido. Mejor usar `nargs='*'` y parsear `--dir` manualmente, o documentar que `--dir` debe ir antes del subcomando.

### 7b. El subcomando `status` llama a `derive_state` (línea 355)

Esto significa que el comando `status` también puede **mutar** el estado si `derive_state()` decide avanzar de fase. Un comando que debería ser puramente informativo puede tener efectos secundarios.

---

## Conclusión

revisor-textos es un skill sólido con una arquitectura bien pensada: formato de prompts canónico, separación clara de responsabilidades, stages autocontenidos, y un pipeline state-machine determinista. Los problemas identificados son principalmente:

1. **Crítico**: `state.py` viola su propio contrato read-only escribiendo en `derive_state()`. Esto es herencia de una versión anterior donde el estado se mutaba en el script y no se refactorizó al separar la lógica de lectura.

2. **Crítico**: Referencia a `ctx_read` que no existe como herramienta.

3. **Alta**: Contradicción entre el template de prompts y los stages concretos respecto a si el subagente debe leer archivos.

4. **Alta**: Falta de subcomando `sessions` para reanudación, que el SKILL.md promete pero `state.py` no implementa.

Estos problemas son reparables sin cambios arquitectónicos mayores. Ninguno invalida el diseño general del skill.