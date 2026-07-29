# Stage: Correct (Phase 4 — Corrección consolidada en una sola pasada)

## Cuándo se ejecuta
Cuando `state.py next` reporta `phase: 4, phase_name: "correct"`.

## Actor
`redactor` — agente con capacidad de escritura. Aplica todas las correcciones del consolidado en una sola pasada.

## Inputs recibidos de state.py
- `session_dir` — directorio de la sesión.
- `working_file` — ruta absoluta de la copia de trabajo.
- `consolidado_path` — ruta a `<session_dir>/hallazgos-consolidado.md`.

## Proceso

### 1. Confirmar con el usuario

Preguntar: "¿Aplicar todas las correcciones del consolidado en una sola pasada?"

NO avanzar hasta que el usuario confirme explícitamente.

### 2. Invocar al `redactor` (una sola pasada)

Invocar al subagente `redactor` con este prompt estructurado:

```
[CONTEXTO]
Hallazgos consolidados (ruta absoluta):
<consolidado_path>

Archivo a modificar (ruta absoluta):
<working_file>

[INSTRUCCION]
Modo: repair
1. Lee el archivo <consolidado_path> usando la herramienta `read` con la ruta exacta.
2. Lee el archivo <working_file> usando la herramienta `read` con la ruta exacta.
3. Aplica TODAS las correcciones sugeridas en los hallazgos consolidados al contenido del archivo, en una sola pasada.
4. Escribe el archivo corregido COMPLETO en <working_file> usando la herramienta `write` (sobrescribiendo el original).

[LIMITES]
- No leas ningun otro archivo — solo el consolidado y el working file indicados.
- No introduzcas cambios no solicitados.
- No alteres el formato Markdown del documento.
- Preserva el contenido sustancial — solo corrige lo señalado en los hallazgos.
- Escribe el archivo completo (no solo el diff).
- Output: sigue el protocolo definido en `references/subagent-protocol.md`.
```

### 3. Verificar

El redactor debe devolver el output segun el protocolo en `references/subagent-protocol.md`. Verificar también que `<working_file>` se modificó (fecha de modificación posterior a la llamada).

### 4. Crear marcador único

Crear un archivo marcador en `<session_dir>/correccion.md`:

```markdown
# Corrección

- Fecha: <fecha ISO 8601>
- Status: applied | failed
- Razón: <reason del redactor, solo si failed>
- Total hallazgos procesados: <N>
```

- **applied**: si el output del redactor empieza con "Work finished" (case-insensitive, con whitespace, segun el protocolo en `references/subagent-protocol.md`).
- **failed**: en cualquier otro caso (incluyendo "FAILURE: ..." o cualquier output inesperado). La razón es el output completo del redactor.

### 5. Manejo de fallos

Si el redactor devuelve output vacío, error, o el output no sigue el protocolo en `references/subagent-protocol.md`:
1. Re-delegar una vez con el mismo prompt.
2. Si falla de nuevo, escribir `correccion.md` con `Status: failed` y `Razón: <output del segundo intento>`.
3. No hay más pases — el pipeline termina aquí.

### 6. Avanzar

El siguiente `state.py next` detectará que `correccion.md` existe y reportará `phase: "done"`.