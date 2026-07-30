# Plantilla de hallazgos

Cada hallazgo debe seguir esta estructura:

## Hallazgo: <título breve>

**Severidad:** alta | media | baja | informativa

**Línea:** <N | N-M | desconocida>

**Ubicación:** <sección, párrafo o contexto del documento>

**Problema:** <descripción del problema identificado>

**Corrección sugerida:** <cómo corregirlo>

## Reglas del campo Línea

- `Línea` es el número de línea del archivo de trabajo tal como lo muestra la herramienta `read`
  (1-indexado). Usa un rango `N-M` si el hallazgo abarca varias líneas contiguas.
- `desconocida` solo para hallazgos globales de todo el documento (por ejemplo, interlineado APA
  aplicado uniformemente) — en ese caso, `Ubicación` debe describir el alcance completo.
- `Ubicación` conserva su rol de contexto legible para humanos; ya no es la clave usada para
  agrupar hallazgos (esa clave viene del campo `Línea`, parseado mecánicamente por `state.py`).
