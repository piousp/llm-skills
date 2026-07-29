# Protocolo de output para subagentes analyst / redactor

## Modo: evaluacion (analyst)

- Hallazgos: bloque markdown siguiendo la plantilla de `references/findings.md`.
- Caso vacio: la unica linea en el output debe ser "No se encontraron hallazgos."

## Modo: repair / consolidation (redactor)

- Exito: la unica linea en el output debe ser "Work finished" (sin prosa adicional).
- Fallo: la unica linea en el output debe ser "FAILURE: <razon concreta en una linea>".