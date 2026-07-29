# Stage: Evaluate (Phase 2 — First Pass)

## Cuándo se ejecuta
Cuando `state.py next` reporta `step: "evaluate"` en la primera pasada.

## Actor
`analyst` — agente read-only. Reporta hallazgos en su output textual.

## Inputs recibidos de state.py
- `session_dir` — directorio de la sesión.
- `working_file` — ruta absoluta de la copia de trabajo.
- `evaluator_skill` — ruta al archivo del skill evaluador.
- `evaluator` — ID del evaluador.

## Proceso

### 1. Leer el skill evaluador (el coordinador)

El coordinador lee el evaluador skill con `read` e incrusta su contenido en el prompt.
El skill evaluador es pequeño (~200 líneas); el working file puede ser grande (miles de
palabras) y el subagente lo lee directamente.

### 2. Delegar a `analyst`

Invocar al subagente `analyst` con este prompt estructurado:

```
[CONTEXTO]
Skill de revision (criterios a aplicar):
--- INICIO SKILL ---
<contenido del archivo evaluator_skill, copiado textualmente>
--- FIN SKILL ---

Archivo a revisar (ruta absoluta):
<working_file>

[INSTRUCCION]
Modo: evaluacion
1. Lee el archivo <working_file> usando la herramienta `read` con la ruta exacta.
2. Aplica los criterios del skill de revision al contenido del archivo.
3. Identifica todos los hallazgos segun los criterios del skill.
4. Reporta los hallazgos en formato JSON.

[LIMITES]
- No leas ningun otro archivo — solo el working file indicado.
- No modifiques nada — solo reporta hallazgos.
- No incluyas hallazgos fuera del alcance del skill.
- Output: UN BLOQUE JSON valido. No incluyas texto fuera del JSON.
  Si no hay hallazgos: {"evaluador": "<evaluator>", "hallazgos": []}

Formato de cada hallazgo:
{"ubicacion": "<seccion/parrafo/linea>", "tipo": "<tipo de hallazgo>",
 "descripcion": "<descripcion del problema>",
 "severidad": "alta|media|baja|informativa",
 "correccion": "<correccion sugerida>"}
```

### 3. Extraer hallazgos del output

El `analyst` devuelve un bloque JSON en su respuesta. Extraerlo y parsearlo.
Si el JSON no es parseable, reintentar una vez (re-delegar con el mismo prompt).

### 4. Escribir archivo de hallazgos

El coordinador escribe el JSON extraído en:
```
<session_dir>/hallazgos-<evaluator>.json
```

### 5. Presentar al usuario

Mostrar al usuario un resumen de los hallazgos:
- Evaluador
- Número de hallazgos
- Desglose por severidad
- Si hay hallazgos de severidad "alta", mencionarlos explícitamente

Preguntar: "¿Continuar con la corrección?"

### 6. Avanzar

No se necesita comando adicional — el siguiente `state.py next` detectará
que `hallazgos-<evaluator>.json` existe y reportará `step: "correct"`.