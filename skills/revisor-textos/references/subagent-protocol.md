# Protocolo de output para subagentes analyst / worker

Ambos agentes tienen un formato de resumen fijo en su propio system prompt
(no configurable por prompt) — el coordinador reconoce ese formato nativo en
vez de exigir una línea única.

## Modo: evaluacion (`analyst`)

`analyst` cierra su output con un resumen estructurado propio (`systemPromptMode:
append` — se agrega después de las instrucciones del prompt, no las reemplaza).
El coordinador extrae los hallazgos así:

- **Hallazgos**: el bloque markdown que sigue la plantilla de
  `references/findings.md` (cada hallazgo empieza con `## Hallazgo:`) va
  **antes** del resumen de `analyst`. El coordinador toma solo ese bloque —
  ignora el resumen final al escribir `hallazgos-<evaluador>.md`.
- **Caso vacío**: si no hay bloques `## Hallazgo:` en el output, tratar como
  "No se encontraron hallazgos." — no es un fallo del subagente.

## Modo: plan / repair (`worker`)

`worker` siempre cierra con:

```
## Execution Summary

**Task:** ...
**What I did:** ...
**Files/resources created or modified:** ...
**Status:** COMPLETED | COMPLETED (with notes) | BLOCKED
**Observations:** ...
```

El coordinador determina éxito/fallo por el campo `**Status:**`, no por una
línea exacta:

- **Éxito**: `**Status:** COMPLETED` o `**Status:** COMPLETED (with notes)`.
  Si hay notas, el coordinador las revisa antes de avanzar — pueden señalar
  un caso límite no cubierto. Si alguna nota describe un problema de
  **contenido** (fabricación de fuentes/citas, cambio de significado, alcance
  no autorizado), tratarlo como fallo pese a que el Status diga COMPLETED —
  ver `stages/correct.md` para el criterio explícito en modo repair.
- **Fallo**: `**Status:** BLOCKED`. La razón está en el cuerpo del resumen
  (campo **Observations:** o la línea del propio Status). El coordinador la
  usa como el `<reason>` al escalar o marcar `correccion.md` como failed.

En ambos modos, si `worker` no devuelve el resumen con `## Execution Summary`
(output vacío o cortado), tratar como fallo de subagente — mismo manejo que
un output sin `**Status:**` reconocible.
