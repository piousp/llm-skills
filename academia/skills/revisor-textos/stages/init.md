# Stage: Init (Phase 1)

## Cuándo se ejecuta
Después de que el usuario confirma archivo y evaluadores. No hay subagente aquí — el coordinador ejecuta `state.py init`.

## Proceso

### 1. Preguntar al usuario

Usar `ask_user_question` para:
1. **Ruta del archivo Markdown** a revisar.
2. **Qué evaluadores aplicar**: todos, o seleccionar algunos de la lista.

Si el usuario no especifica evaluadores, aplicar todos.

### 2. Ejecutar init

```bash
python3 <skill-dir>/state.py init <ruta_archivo.md> [eval_id ...]
```

- `skill-dir` es el directorio donde reside este SKILL.md.
- Si no se pasan IDs, se usan todos los evaluadores de `evaluadores.json`.
- Si se pasan IDs, se filtran preservando el orden del JSON.

### 3. Leer output

El script imprime:
- `Session: <PPID>` — guardar este ID, se usa en todos los comandos siguientes.
- `Directorio de sesion: <ruta>` — ruta donde están los archivos de trabajo.

### 4. Confirmar con el usuario

Mostrar al usuario:
- Session ID (PPID)
- Archivo original
- Evaluadores seleccionados
- Directorio de sesión

Preguntar: "¿Iniciamos la revisión?"

## Output del stage
- `session_id` — PPID, para pasar a `state.py next`.
- `session_dir` — ruta del directorio de sesión.
- `working_file` — ruta de la copia de trabajo.