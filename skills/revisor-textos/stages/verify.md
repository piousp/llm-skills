# Stage: Verify (Phase 3 — Second Pass)

## Cuándo se ejecuta
Cuando `state.py next` reporta `step: "verify"` en la segunda pasada.

## Actor
`analyst` — verifica regresiones. Si hay hallazgos, se delega a `redactor` para corrección.

## Inputs recibidos de state.py
- `session_dir` — directorio de la sesión.
- `working_file` — ruta absoluta de la copia de trabajo actual.
- `evaluator_skill` — ruta al archivo del skill evaluador.
- `evaluator` — ID del evaluador.

## Proceso

### 1. Leer el skill evaluador (el coordinador)

El coordinador lee el evaluador skill con `read` e incrusta su contenido en el prompt.

### 2. Delegar a `analyst` para verificación

Invocar al subagente `analyst` con este prompt estructurado:

```
[CONTEXTO]
Skill de revision (criterios a verificar):
--- INICIO SKILL ---
<contenido del archivo evaluator_skill, copiado textualmente>
--- FIN SKILL ---

Archivo a verificar (ruta absoluta):
<working_file>

[INSTRUCCION]
Modo: verificacion de regresiones
1. Lee el archivo <working_file> usando la herramienta `read` con la ruta exacta.
2. NO es una re-evaluacion completa. Enfocate SOLO en:
   a. REGRESIONES: problemas que ya estaban corregidos en el primer pase y
      aparecieron de nuevo.
   b. NUEVOS PROBLEMAS: issues introducidos por las correcciones previas
      (formato roto, sentido alterado, informacion perdida).
3. Si encuentras regresiones o nuevos problemas, reportalos con severidad "alta".
   Si no encuentras problemas, reporta hallazgos vacio.

[LIMITES]
- No leas ningun otro archivo — solo el working file indicado.
- No modifiques nada — solo reporta hallazgos.
- Output: UN BLOQUE JSON valido. No incluyas texto fuera del JSON.

Formato:
{"evaluador": "<evaluator>", "hallazgos": [
  {"ubicacion": "<seccion/parrafo/linea>", "tipo": "regresion|nuevo-problema",
   "descripcion": "<descripcion del problema>",
   "severidad": "alta",
   "correccion": "<correccion sugerida>"}
]}

Si no hay problemas: {"evaluador": "<evaluator>", "hallazgos": []}
```

### 3. Extraer hallazgos del output

Extraer el bloque JSON de la respuesta del `analyst`.

### 4. Escribir archivo de verificacion

El coordinador escribe el JSON (con hallazgos o vacío) en:
```
<session_dir>/verificacion-<evaluator>.json
```

### 5. Si hay hallazgos: delegar corrección

Si el JSON contiene hallazgos (lista no vacía):

**5a.** Delegar a `redactor`:

```
[CONTEXTO]
Hallazgos de verificacion a corregir:
--- INICIO HALLAZGOS ---
<contenido del archivo verificacion-<evaluator>.json, copiado textualmente>
--- FIN HALLAZGOS ---

Archivo a modificar (ruta absoluta):
<working_file>

[INSTRUCCION]
Modo: repair
1. Lee el archivo <working_file> usando la herramienta `read` con la ruta exacta.
2. Aplica las correcciones de los hallazgos de verificacion al contenido del archivo.
3. Corrige solo los hallazgos con severidad "alta".
4. Escribe el archivo corregido COMPLETO en <working_file> usando la herramienta `write`.

[LIMITES]
- No leas ningun otro archivo — solo el working file indicado.
- No introduzcas cambios no solicitados.
- Escribe el archivo completo.
```

**5b.** Notificar al usuario: "Se encontraron [N] regresiones en [evaluador].
Correcciones aplicadas."

### 6. Si no hay hallazgos

Notificar al usuario: "Sin regresiones en [evaluador]."

### 7. Avanzar

El siguiente `state.py next` detectará que `verificacion-<evaluator>.json`
existe y avanzará al siguiente evaluador en la segunda pasada.