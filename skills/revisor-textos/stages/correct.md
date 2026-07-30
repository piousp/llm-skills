# Stage: Correct (Phase 5 — Corrección consolidada en una sola pasada)

## Cuándo se ejecuta
Cuando `state.py next` reporta `phase: 5, phase_name: "correct"`.

## Actor
`redactor` — agente con capacidad de escritura. Aplica el plan de corrección conjunto en una sola
pasada.

## Inputs recibidos de state.py
- `session_dir` — directorio de la sesión.
- `working_file` — ruta absoluta de la copia de trabajo.
- `plan_path` — ruta a `<session_dir>/plan-correccion.md`.

## Proceso

### 1. Confirmar con el usuario

Preguntar: "¿Aplicar el plan de corrección al archivo de trabajo?"

NO avanzar hasta que el usuario confirme explícitamente.

### 2. Short-circuit: plan sin grupos

Si `plan-correccion.md` indica `Total grupos: 0`: el coordinador escribe directamente
`<session_dir>/correccion.md` con `Status: applied` y `Total grupos procesados: 0`, sin invocar al
`redactor` (no hay nada que corregir).

### 3. Invocar al `redactor` (una sola pasada)

```
[CONTEXTO]
Plan de corrección (ruta absoluta):
<plan_path>

Archivo a modificar (ruta absoluta):
<working_file>

[INSTRUCCION]
Modo: repair
1. Lee el archivo <plan_path> usando la herramienta `read` con la ruta exacta.
2. Lee el archivo <working_file> usando la herramienta `read` con la ruta exacta.
3. Aplica la "Corrección integrada" de CADA grupo del plan, en el orden en que aparecen, en una
   sola pasada sobre el contenido del archivo.
4. Escribe el archivo corregido COMPLETO en <working_file> usando la herramienta `write`
   (sobrescribiendo el original).

[LIMITES]
- No leas ningun otro archivo — solo el plan y el working file indicados.
- No introduzcas cambios no solicitados.
- No alteres el formato Markdown del documento.
- Preserva el contenido sustancial — solo corrige lo señalado en el plan.
- Los números de línea del plan refieren al contenido de working.md TAL COMO ESTÁ ANTES de tus
  ediciones. Si tus correcciones desplazan líneas, aplica los grupos siguientes por su contexto
  (Ubicación y Problema del grupo), no por el número de línea a ciegas.
- Escribe el archivo completo (no solo el diff).
- Output: sigue el protocolo definido en `references/subagent-protocol.md`.
```

### 4. Verificar

El `redactor` debe devolver el output según el protocolo en `references/subagent-protocol.md`.
Verificar también que `<working_file>` se modificó (fecha de modificación posterior a la llamada).

### 5. Crear marcador único

Crear un archivo marcador en `<session_dir>/correccion.md`:

```markdown
# Corrección

- Fecha: <fecha ISO 8601>
- Status: applied | failed
- Razón: <reason del redactor, solo si failed>
- Total grupos procesados: <N>
```

- **applied**: si el output del redactor empieza con "Work finished" (protocolo).
- **failed**: en cualquier otro caso.

### 6. Manejo de fallos

1. Re-delegar una vez con el mismo prompt.
2. Si falla de nuevo, escribir `correccion.md` con `Status: failed` y `Razón: <output del segundo
   intento>`. No hay más pases — el pipeline termina aquí.

### 7. Avanzar

El siguiente `state.py next` detectará que `correccion.md` existe y reportará `phase: "done"`.
