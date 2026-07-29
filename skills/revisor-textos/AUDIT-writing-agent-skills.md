# Auditoría de `revisor-textos` vs `writing-agent-skills`

Baseline: [writing-agent-skills](../writing-agent-skills/SKILL.md)
Auditado: [revisor-textos](./SKILL.md)

Fecha: 2025-07-29

---

## Resumen

| # | Hallazgo | Tip | Severidad | Archivo |
|---|----------|-----|-----------|---------|
| 1 | Skill no clasificado como capability/preference | 1 | **Alta** | SKILL.md (ausente) |
| 2 | Falta de negative case en description | 2, 6 | **Alta** | SKILL.md:1-6 |
| 3 | Dos evaluadores superan 500 líneas sin ToC | 4 | **Alta** | `evaluadores/defectos-epistemicos.md` (604), `falacias.md` (570) |
| 4 | Contradicción: template dice "no leer archivos", stages dicen "leer working file" | 3 | **Alta** | SKILL.md:90 vs stages/evaluate.md:37 |
| 5 | `ctx_read` no existe como herramienta | 3 | **Crítica** | SKILL.md:98,230 |
| 6 | Sin guía de fallback si analyst/redactor no están configurados | 3, 5 | **Media** | SKILL.md:55-56 |
| 7 | Prompt template duplicado en evaluate.md y correct.md y verify.md | 4 | **Media** | stages/ (3 archivos) |
| 8 | Sin evals ni test prompts documentados | 7 | **Media** | SKILL.md (ausente) |
| 9 | skill/script lógica mezclada: state.py escribe en derive_state() | 1 | **Crítica** | state.py:171,201 |
| 10 | Falta de `sessions` subcomando para reanudación | 5 | **Alta** | state.py (ausente) |

---

## 1. Know what a skill is

### Clasificación ausente (ALTA)

El tip 1 exige clasificar el skill como **capability** o **preference**. `revisor-textos` es un **preference skill** — codifica un workflow/proceso específico (orquestación de revisión académica multi-criterio con pipeline state-machine). Es durable: no será obsoleto por mejora del modelo base, solo por cambios en el proceso.

**Estado actual:** No hay mención de clasificación en ningún lado.

**Recomendación:** Agregar al inicio del SKILL.md:

```
Clasificación: Preference skill — codifica un pipeline de revisión académica.
No se vuelve obsoleto por mejora del modelo base.
```

### Estructura de directorios (OK)

- `SKILL.md` — presente, 238 líneas.
- `stages/` — 5 archivos autocontenidos.
- `evaluadores/` — 6 skills de evaluación.
- `evaluadores.json` — configuración.
- `state.py` — script de control.

La estructura sigue el modelo `SKILL.md + scripts/ + references/`, aunque aquí los scripts están en `stages/` y `state.py`. Esto es válido; la convención de nombres es diferente pero funcional.

### Tres capas de carga (OK)

El diseño respeta las tres capas: el SKILL.md se carga siempre, los stages se cargan bajo demanda (cuando `state.py` devuelve `stage_file`), y los evaluadores solo cuando el pipeline los necesita. Esto no está documentado explícitamente, pero el comportamiento es correcto.

---

## 2. Nail the description

### Description actual

```
Orquestador de revisiones academicas. Coordina la ejecucion secuencial de
evaluadores (filologico, heuristico, APA, falacias, defectos epistemicos)
sobre un texto en Markdown. Usa analyst (evaluar) y redactor (corregir).
Pipeline state-machine con state.py read-only.
```

### Evaluación

- ✅ Describe **qué** hace.
- ✅ Describe **cómo** lo hace (analyst/redactor, state.py).
- ❌ No describe **cuándo** usarlo. El tip 2 pide "Write both the what and the when".
- ❌ No incluye **negative case** (ver Tip 6 abajo). El skill no dice cuándo NO debe dispararse.

Un usuario podría invocar este skill para una revisión ortográfica rápida, y terminaría con un pipeline pesado de 5 evaluadores que no necesita. O podría invocarlo para un texto en HTML y el pipeline asume Markdown.

**Recomendación:**

```
Orquestador de revisiones academicas sobre textos en Markdown. Ejecuta un
pipeline secuencial de evaluadores (filologico, heuristico, APA, falacias,
defectos epistemicos, hilo-conductor) usando subagentes analyst (evaluar)
y redactor (corregir). Incluye loop de verificacion de regresiones.
NO usar para: correccion ortografica simple, analisis de sentimiento,
traduccion, o textos que no esten en Markdown.
```

### Trigger explícito

El SKILL.md dice: "Siempre invocado por nombre (sin auto-trigger)." Esto es correcto y sigue la guía del tip 2: "If a skill is only ever invoked by explicit name, say so plainly."

---

## 3. Write instructions, not essays

### Directivas fuertes (OK)

El skill está lleno de directivas correctas:

- _"Nunca avanzar a la siguiente fase hasta que el usuario lo confirme explícitamente."_
- _"El agente principal ejecutando este skill es un **coordinador, no un ejecutor**."_
- _"El coordinador nunca pasa rutas de archivos a los subagentes sin contexto."_
- _"No leas ningun archivo — todo el contenido esta en este prompt."_ (aunque esto contradice stages, ver hallazgo 4)

La sección **Anti-patterns** (7 items) es particularmente buena — sigue el principio de "constraints over procedures".

### Problema: contradicción template vs. stages (ALTA)

El template canónico en SKILL.md dice:

```
[LÍMITES]
- No leas ningun archivo — todo el contenido esta en este prompt.
```

Pero los stages concretos dicen lo opuesto:

| Stage | Texto |
|-------|-------|
| evaluate.md:37-38 | `1. Lee el archivo <working_file> usando la herramienta \`read\` con la ruta exacta.` |
| correct.md:28 | `1. Lee el archivo <working_file> usando la herramienta \`read\` con la ruta exacta.` |
| verify.md:40-41 | `1. Lee el archivo <working_file> usando la herramienta \`read\` con la ruta exacta.` |

El template debería decir:

```
- Archivos pequeños (< 300 líneas): todo el contenido está en este prompt bajo [CONTEXTO].
- Archivos grandes (> 300 líneas): leer usando la herramienta `read` con la ruta absoluta.
```

### Referencia a herramienta inexistente `ctx_read` (CRÍTICA)

SKILL.md menciona `ctx_read` en dos lugares:

- Línea 98: _"Usar `ctx_read` con `mode="full"`."_
- Línea 230: _"Siempre leer el archivo con `ctx_read` e incrustar el contenido textual."_

`ctx_read` **no existe** como herramienta en el harness. La herramienta correcta es `read`. Esto haría fallar a cualquier coordinador que siga las instrucciones al pie de la letra. Es un bug directo.

### Verborrea en secciones extensas (BAJO)

La sección "Regla de lectura e incrustación" tiene párrafos explicativos largos que podrían resumirse en 2-3 directivas. Ejemplo:

> _"El coordinador nunca pasa rutas de archivos a los subagentes sin contexto. Los subagentes se ejecutan con `inheritProjectContext: false` — no tienen contexto del proyecto y no pueden resolver rutas relativas."_

Sigue el principio de dar una razón corta, que es bueno. Pero la estrategia de archivos pequeños vs grandes podría ser más concisa:

```
- < 300 líneas: incrustar en [CONTEXTO].
- ≥ 300 líneas: subagente usa `read` con ruta absoluta.
```

---

## 4. Keep it lean

### SKILL.md: 238 líneas ✅

Bien dentro del límite de ~500 líneas.

### stages/: 44-111 líneas cada uno ✅

Todos bajo control.

### evaluadores/ — dos archivos sobrepasan 500 líneas ❌

| Archivo | Líneas |
|---------|--------|
| defectos-epistemicos.md | **604** |
| falacias.md | **570** |
| apa.md | 200 |
| filologica.md | 186 |
| heuristica.md | 138 |
| hilo-conductor-historia.md | 143 |

El tip 4 dice: _"If a reference file exceeds 500 lines, put a table of contents with line hints at the top."_

**defectos-epistemicos.md** y **falacias.md** superan el límite y no tienen tabla de contenidos.

### Duplicación de prompts entre stages (MEDIA)

Los prompts para `analyst` en evaluate.md y verify.md son casi idénticos (cambia `Modo: evaluacion` vs `Modo: verificacion` y algunos detalles). El prompt para `redactor` en correct.md y en verify.md (sub-paso 5a) también es casi idéntico.

El tip 4 sugiere dividir contenido multi-tópico en referencias separadas. Una alternativa sería tener un único `references/prompt-templates.md` con los 3 templates (evaluate, correct, verify) incluido por referencia desde los stages, evitando la duplicación.

Esto no es crítico pero dificulta el mantenimiento: cualquier cambio al formato de prompts requiere editar 3 archivos.

### state.py: 391 líneas ✅

Es un script, no contenido del skill. El límite no aplica.

---

## 5. Set the right level of freedom

### Procedimientos detallados vs. objetivos (debate)

El skill es extremadamente detallado en la secuencia de pasos. Cada stage especifica:
1. Qué archivo leer
2. Qué subagente invocar
3. El prompt exacto (con marcadores `--- INICIO ---` / `--- FIN ---`)
4. El formato exacto del output esperado
5. Cómo escribir los archivos de resultado
6. Cómo presentar al usuario
7. Cómo avanzar al siguiente paso

El tip 5 dice: _"Describe the goal, not a rigid step sequence, unless order genuinely matters."_ Y también: _"If exact step order is truly load-bearing (fragile if step 3 runs before step 2), that's not a skill problem — write a script and have the skill call it."_

**Evaluación:** El orden SÍ es crítico aquí (evaluate → correct → verify → finish), y el skill DELEGA el control de flujo a `state.py`, que es exactamente el patrón que el tip 5 recomienda: _"write a script and have the skill call it."_ La secuencia detallada dentro de cada stage está justificada porque cada paso depende del anterior (no puedes delegar a `redactor` sin tener los hallazgos, no puedes presentar al usuario sin tener el resultado del subagente).

**Sin embargo**, la repetición del prompt exacto podría sustituirse por:

```
Usar el template de prompt para [evaluate|correct|verify] definido en
references/prompt-templates.md, reemplazando los placeholders:
- {{skill_content}} → contenido del skill evaluador
- {{working_file}} → ruta del working file
- {{findings}} → contenido del archivo de hallazgos (solo correct/verify)
```

Esto reduciría duplicación y simplificaría el mantenimiento, sin perder la precisión del formato.

### Falta de `sessions` subcomando (ALTA)

El SKILL.md describe un flujo de reanudación cross-session:

> _"Si al iniciar el skill se detecta un directorio `revision/` con sesiones previas... Preguntar al usuario... ¿Iniciar una nueva o reanudar una existente?"_

Pero `state.py` no implementa `sessions` ni ningún mecanismo para listar sesiones. El coordinador tendría que hacer `ls revision/` y parsear directorios manualmente. El tip 5 dice que si el orden de pasos es frágil, debe ser un script — y aquí la lógica de "detectar sesiones previas" está descrita en el skill pero no implementada en el script. El script debería tener `state.py sessions` (o similar).

---

## 6. Don't skip negative cases

### Sin negative case en la description ❌

El tip 6 dice explícitamente: _"State explicitly when the skill should NOT fire, especially if its topic overlaps something broader."_

`revisor-textos` no tiene ningún negative case. Un usuario podría pedir "revisa este texto" esperando corrección ortográfica básica y obtendría el pipeline completo de 5 evaluadores. O podría invocarlo para un PDF y el pipeline fallaría porque espera Markdown.

### Negative cases potenciales (no cubiertos)

| Contexto | Riesgo |
|----------|--------|
| Texto en PDF/docx (no Markdown) | Pipeline falla; `state.py init` acepta cualquier archivo |
| Corrección rápida de 1 párrafo | Pipeline de 5 evaluadores es overkill |
| Texto en inglés | Evaluadores están en español |
| Solicitud vaga "revisa esto" | El usuario no sabe que elegirá evaluadores |

**Recomendación:** Agregar al description:

```
NO usar: para textos que no estén en Markdown, para corrección ortográfica
simple, para documentos en inglés, o cuando se necesite una revisión rápida
de un solo criterio.
```

---

## 7. Test it before you ship it

### Sin evals documentados ❌

El skill no menciona ningún test prompt, criterio de evaluación, o resultados de pruebas. El tip 7 recomienda:

1. **10-20 test prompts** variados (should trigger, should not trigger, edge cases).
2. **3-5 trials per prompt** (los agentes son no-deterministas).
3. **Criterios de éxito medibles** por prompt.

### Dependencia externa dificulta testing

`revisor-textos` depende de subagentes externos (`analyst`, `redactor`) y de 6 skills evaluadores. Esto hace que sea difícil de testear de forma aislada. Un test unitario requeriría mockear los subagentes.

Un plan de testing realista podría incluir:

| Prompt | Should trigger? | Criterio de éxito |
|--------|----------------|-------------------|
| "Revisa este artículo usando el skill revisor-textos" | Sí | Pipeline complete hasta finish |
| "Corrige la ortografía de este texto" | No | No inicia pipeline |
| "Revisa mi tesis con criterio filológico y APA" | Sí | Solo 2 evaluadores en seleccion.json |
| "Reanuda la sesión abc123" | Sí | state.py next abc123 funciona |
| Session corrupta (borrar seleccion.json) | N/A | state.py reporta phase=error |

### Sin guía de fallback si subagentes no existen (MEDIA)

El tip 7 también sugiere probar con configuraciones variadas. Si el harness no tiene `analyst` o `redactor`, el skill no da ninguna instrucción de respaldo. El coordinador simplemente falla al delegar.

---

## 8. Know when to retire a skill

### Preference skill — durable por definición ✅

Este skill es un **preference skill**: codifica un workflow/proceso específico (orquestación de revisión académica). Según el tip 8: _"preference skills don't get obsoleted by model improvement, only by process changes."_

No necesita evaluación periódica de obsolescencia.

### No obstante...

Si en el futuro los modelos base aprenden a orquestar pipelines multi-paso de forma confiable sin instrucciones explícitas, este skill podría simplificarse. Pero eso requeriría que el modelo entienda el concepto de "pipeline state-machine con evaluadores secuenciales y verificación de regresiones" — improbable en el corto plazo.

### Documentación de esta clasificación

Actualmente no hay ninguna indicación de que este skill sea un preference skill durable. Sería útil agregarlo para que futuros mantenedores sepan que no necesitan re-evaluarlo periódicamente.

---

## Tabla consolidada de hallazgos

| # | Hallazgo | Tip | Severidad | Archivo:línea | Recomendación |
|---|----------|-----|-----------|---------------|---------------|
| 1 | Skill no clasificado como capability/preference | 1 | **Alta** | SKILL.md | Agregar "Clasificación: Preference skill" al inicio |
| 2 | Sin negative case en description | 2, 6 | **Alta** | SKILL.md:1-6 | Agregar "NO usar para..." al description |
| 3 | evaluadores >500 líneas sin tabla de contenidos | 4 | **Alta** | `defectos-epistemicos.md`, `falacias.md` | Agregar ToC al inicio de cada archivo |
| 4 | Template dice "no leer archivos", stages dicen "leer working file" | 3 | **Alta** | SKILL.md:90 vs stages/*.md | Armonizar template con la práctica real |
| 5 | `ctx_read` no existe como herramienta | 3 | **Crítica** | SKILL.md:98,230 | Cambiar a `read` |
| 6 | Sin guía de fallback si analyst/redactor no existen | 3, 5 | **Media** | SKILL.md:55-56 | Agregar "si no está configurado, fallback a subagent tool con descripción genérica" |
| 7 | Prompts duplicados en 3 stages | 4 | **Media** | stages/*.md | Extraer templates a `references/prompt-templates.md` |
| 8 | Sin evals ni test prompts documentados | 7 | **Media** | SKILL.md | Agregar plan de testing con prompts y criterios |
| 9 | state.py derive_state() escribe en disco | 1, 5 | **Crítica** | state.py:171,201 | Separar escritura a comando `advance`; hacer derive_state() puro |
| 10 | Falta subcomando `sessions` para reanudación | 5 | **Alta** | state.py (ausente) | Implementar `state.py sessions` que liste sesiones disponibles |

### Distribución por severidad

| Severidad | Conteo |
|-----------|--------|
| Crítica | 2 |
| Alta | 4 |
| Media | 3 |
| Baja | 0 |
| Informativa | 0 |

---

## Conclusión

`revisor-textos` está bien diseñado en varios aspectos que el framework writing-agent-skills enfatiza: la estructura de directorios es correcta, el SKILL.md cabe dentro del límite de 500 líneas, el trigger explícito está declarado, las directivas son claras (anti-patterns es un acierto), y el control de flujo está correctamente delegado a un script (`state.py`) en lugar de codificado como pasos en el skill.

Las carencias principales frente a este framework son:

1. **Ausencia de clasificación (Tip 1):** No especifica si es capability o preference skill. Es preference, y debería decirlo.

2. **Descripción incompleta (Tips 2 y 6):** Le falta el "cuándo" y el negative case. Un usuario puede invocarlo para tareas inapropiadas sin saberlo.

3. **Contradicción template vs. práctica (Tip 3):** El template dice "no leer archivos" pero los stages dicen "leer working file". Esto confunde al coordinador.

4. **Dos evaluadores muy largos (Tip 4):** `defectos-epistemicos.md` (604 líneas) y `falacias.md` (570 líneas) superan el límite y no tienen tabla de contenidos.

5. **Bug `ctx_read` (Tip 3):** Referencia a herramienta inexistente. Esto es un error directo que rompe la ejecución.

6. **Sin evals (Tip 7):** Sin test prompts ni criterios de éxito, no hay forma de medir si el skill funciona correctamente.

Los hallazgos críticos de la auditoría anterior (usando iterative-design como baseline) que también se detectan aquí son: **#5 (ctx_read) y #9 (state.py escribe en disco)** — ambos aparecen con severidad crítica también en este análisis.

El hallazgo nuevo que no estaba en la auditoría anterior es **#1 (falta de clasificación capability/preference)**, que es propio del framework writing-agent-skills.
