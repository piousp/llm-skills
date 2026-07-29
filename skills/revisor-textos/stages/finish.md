# Stage: Finish (Phase 4 — Diff, Entrega, Handoff)

## Cuándo se ejecuta
Cuando `state.py next` reporta `phase: 4, phase_name: "finish"`.

## Proceso

### 1. Generar diff

Ejecutar:
```bash
diff -u <session_dir>/original.md <session_dir>/working.md > <session_dir>/diff.md
```

Si `diff` no está disponible, copiar ambos archivos y notificar al usuario.

### 2. Copiar a directorio de salida

Preguntar al usuario el directorio de salida (o usar el directorio actual).

Copiar:
- `<session_dir>/original.md` → `<output>/<nombre_original>`
- `<session_dir>/working.md` → `<output>/<nombre>-revisado.md`
- `<session_dir>/diff.md` → `<output>/<nombre>-diff.md`

### 3. Generar resumen

Generar y escribir en `<output>/<nombre>-resumen.md`:

```markdown
# Resumen de revision

- **Session**: <session_id>
- **Archivo original**: <ruta_original>
- **Fecha**: <fecha>

## Evaluadores aplicados

| Evaluador | Primer pase | Segundo pase |
|-----------|-------------|--------------|
| filologica | corregido | verificado |
| ... | ... | ... |

## Segundos pases detectados: <N> problemas encontrados

## Archivos entregados
- <original>
- <revisado>
- <diff>
- <resumen>
```

### 4. Entregar al usuario

Presentar al usuario:
1. **Archivo original** — copia inalterada.
2. **Archivo corregido** — con todas las revisiones aplicadas.
3. **Diff** — cambios entre original y corregido.
4. **Resumen** — evaluadores aplicados, estado de cada uno.

### 5. Handoff

El pipeline `state.py` reportará `phase: "done"` después de finish.
Reportar al usuario el resumen final y finalizar.