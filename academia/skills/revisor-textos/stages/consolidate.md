# Stage: Consolidate (Phase 3 — Consolidación determinística de hallazgos)

## Cuándo se ejecuta
Cuando `state.py next` reporta `phase: 3, phase_name: "consolidate"`.

## Actor
Coordinador — este paso es 100% determinístico (parseo y ensamblado de archivos), no requiere
ningún subagente.

## Inputs recibidos de state.py
- `session_dir` — directorio de la sesión.
- `working_file` — ruta absoluta de la copia de trabajo.
- `evaluadores` — lista de IDs de evaluadores (de `seleccion.json`).

## Proceso

### 1. Confirmar con el usuario

Preguntar: "¿Consolidar los hallazgos de todos los evaluadores en un solo archivo?"

NO avanzar hasta que el usuario confirme explícitamente. (La confirmación se mantiene aunque el
paso sea determinístico — la regla CRÍTICO de confirmación por fase aplica siempre.)

### 2. Ejecutar el script

```bash
python3 <skill-dir>/state.py consolidate <session_id>
```

Este comando parsea cada `hallazgos-<eval>.md`, y escribe (en este orden):
1. `<session_dir>/hallazgos-consolidado.md` — versión legible, con el contenido crudo de cada
   evaluador preservado verbatim.
2. `<session_dir>/hallazgos-consolidado.json` — versión estructurada (hallazgos parseados con
   línea, severidad, evaluador, problema, corrección sugerida), usada por la Fase 4 para agrupar.

### 3. Verificar

Confirmar exit code 0 y que ambos archivos existen. Presentar al usuario el resumen impreso por el
script (totales por evaluador, total de hallazgos, avisos de parseo si los hubo).

### 4. Manejo de fallos

Si el script termina con exit code distinto de 0: mostrar el mensaje de error (stderr) al usuario y
escalar. **No hay reintento de 2 intentos aquí** — el patrón de reintento existe para salidas no
deterministas de subagentes; re-ejecutar un script determinista sin cambiar la causa del error no
puede dar un resultado distinto.

### 5. Avanzar

No se necesita comando adicional — el siguiente `state.py next` detectará que
`hallazgos-consolidado.json` existe y reportará `phase: 4, phase_name: "plan"`.
