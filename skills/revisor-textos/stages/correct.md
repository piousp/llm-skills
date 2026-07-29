# Stage: Correct (Phase 2 — First Pass, Correction)

## Cuándo se ejecuta
Cuando `state.py next` reporta `step: "correct"` en la primera pasada.

## Actor
`redactor` — agente con capacidad de escritura. Aplica correcciones y escribe el archivo.

## Inputs recibidos de state.py
- `session_dir` — directorio de la sesión.
- `working_file` — ruta absoluta de la copia de trabajo.
- `findings_file` — ruta al archivo JSON de hallazgos.
- `evaluator` — ID del evaluador.

## Proceso

### 1. Leer los hallazgos (el coordinador)

El coordinador lee el archivo de hallazgos (pequeño, siempre JSON) e incrusta su
contenido en el prompt. El working file puede ser grande; el redactor lo lee y
escribe directamente.

### 2. Delegar a `redactor`

Invocar al subagente `redactor` con este prompt estructurado:

```
[CONTEXTO]
Hallazgos a corregir:
--- INICIO HALLAZGOS ---
<contenido del archivo findings_file, copiado textualmente>
--- FIN HALLAZGOS ---

Archivo a modificar (ruta absoluta):
<working_file>

[INSTRUCCION]
Modo: repair
1. Lee el archivo <working_file> usando la herramienta `read` con la ruta exacta.
2. Aplica las correcciones sugeridas en los hallazgos al contenido del archivo.
3. Escribe el archivo corregido COMPLETO en <working_file> usando la herramienta `write`.

[LIMITES]
- No leas ningun otro archivo — solo el working file indicado.
- No introduzcas cambios no solicitados.
- No alteres el formato Markdown del documento.
- Preserva el contenido sustancial — solo corrige lo señalado en los hallazgos.
- Escribe el archivo completo (no solo el diff).
```

### 3. Verificar

Después de que `redactor` confirme que escribió el archivo, verificar que
`<working_file>` se modificó (fecha de modificación).

### 4. Marcar evaluador como corregido

Crear un archivo marcador:
```
<session_dir>/corregido-<evaluator>.md
```

Contenido:
```
# Correccion aplicada: <evaluator>
- Fecha: <fecha>
- Hallazgos corregidos: <N>
```

### 5. Presentar al usuario

Mostrar al usuario:
- Evaluador corregido
- Número de correcciones aplicadas

Preguntar: "¿Continuar con el siguiente evaluador?"

### 6. Avanzar

El siguiente `state.py next` detectará que `corregido-<evaluator>.md` existe
y avanzará al siguiente evaluador o a la siguiente fase.