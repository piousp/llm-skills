# Stage: Evaluate (Phase 2 — Evaluación paralela)

## Cuándo se ejecuta
Cuando `state.py next` reporta `phase: 2, phase_name: "evaluating"` o `phase: 3, phase_name: "evaluated"`.

## Actor
`analyst` — agente read-only. Reporta hallazgos en su output textual (markdown).

## Inputs recibidos de state.py
- `session_dir` — directorio de la sesión.
- `working_file` — ruta absoluta de la copia de trabajo.
- `evaluadores` — lista de IDs de evaluadores (de `seleccion.json`).

## Proceso

### 1. Preparar prompts (el coordinador)

El coordinador lee cada skill evaluador de `evaluadores.json` y prepara N prompts, uno por evaluador.

Estrategia según el tipo de archivo:
- **Archivos pequeños** (skills evaluadores, < 300 líneas): el coordinador lee con `read` e incrusta el contenido en el prompt bajo `[CONTEXTO]`.
- **Archivos grandes** (working file, miles de palabras): el subagente lo lee directamente usando `read` con la ruta absoluta.

### 2. Lanzar evaluación en paralelo

Invocar a `subagent tasks: [...]` con N tasks simultáneos:

```
Ejemplo concreto con 3 evaluadores:
subagent(tasks: [
  {
    agent: "analyst",
    task: "Evalúa el documento contra el skill filologica. ..."
  },
  {
    agent: "analyst",
    task: "Evalúa el documento contra el skill heuristica. ..."
  },
  {
    agent: "analyst",
    task: "Evalúa el documento contra el skill APA. ..."
  }
])
```

- **Máximo 4 concurrentes.** Si hay más de 4 evaluadores, se lanzan en lotes de 4.
- **Máximo 8 tasks totales.** Si el usuario seleccionó más de 8, el coordinador debe limitar a 8 en init.

Cada task usa el subagente `analyst` con este prompt estructurado:

```
[CONTEXTO]
Skill de revision (criterios a aplicar):
--- INICIO SKILL ---
<contenido del archivo evaluador, copiado textualmente>
--- FIN SKILL ---

Archivo a revisar (ruta absoluta):
<working_file>

Plantilla de hallazgos (copiar esta estructura exacta en el output):
--- INICIO PLANTILLA ---
## Hallazgo: <título breve>

**Severidad:** alta | media | baja | informativa

**Ubicación:** <sección, párrafo o línea del documento>

**Problema:** <descripción del problema identificado>

**Corrección sugerida:** <cómo corregirlo>
--- FIN PLANTILLA ---

[INSTRUCCION]
Modo: evaluacion
1. Lee el archivo <working_file> usando la herramienta `read` con la ruta exacta (si es grande).
2. Aplica los criterios del skill de revision al contenido del archivo.
3. Identifica todos los hallazgos segun los criterios del skill.
4. Reporta los hallazgos siguiendo EXACTAMENTE la plantilla de hallazgos.

[LIMITES]
- No leas ningun otro archivo — solo el working file indicado.
- No modifiques nada — solo reporta hallazgos.
- No incluyas hallazgos fuera del alcance del skill.
- Output: markdown siguiendo la plantilla. Cada hallazgo comienza con ## Hallazgo:.
- Sigue el protocolo de output definido en `references/subagent-protocol.md`.
```

### 3. Recolectar resultados

Esperar a que todos los `subagent tasks` completen. Para cada resultado:

- Si el subagente devolvió hallazgos válidos: el coordinador escribe el resultado textual en `<session_dir>/hallazgos-<evaluador>.md`.
- Si el subagente falló (output vacío, error): re-delegar una vez con el mismo prompt. Si falla de nuevo, marcar el evaluador como fallido y continuar con los demás.

### 4. Presentar al usuario

Una vez que todos los evaluadores han completado (o fallado):

Mostrar al usuario un resumen por evaluador:
- Evaluador
- Número de hallazgos
- Desglose por severidad (alta/media/baja/informativa)
- Si un evaluador falló, indicarlo explícitamente

Preguntar: "¿Continuar con la corrección?"

### 5. Avanzar

No se necesita comando adicional — el siguiente `state.py next` detectará
que los archivos `hallazgos-*.md` existen y reportará `phase: 3, phase_name: "evaluated"`.