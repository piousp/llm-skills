# Protocolo de output para subagentes revisor-evaluador / redactor

## Modo: evaluacion (revisor-evaluador)

- Hallazgos: bloque markdown siguiendo la plantilla de `references/findings.md`.
- Caso vacio: la unica linea en el output debe ser "No se encontraron hallazgos."

## Modo: repair / plan (redactor)

- Exito: la unica linea en el output debe ser "Work finished" (sin prosa adicional).
- Fallo: la unica linea en el output debe ser "FAILURE: <razon concreta en una linea>".