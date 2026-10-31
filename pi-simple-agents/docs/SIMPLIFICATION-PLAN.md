# Simplification Plan: todo `src/` de pi-simple-agents

Generado por el skill `pablo-code-simplify` (pasada de solo lectura, dos lentes por lote,
seis analistas, tres lotes). El plan no aplica cambios por sí mismo.

- Alcance: `src/*.ts`, 30 archivos, 6.462 líneas, normalizado como contenido literal íntegro.
- Fuera de alcance: `test/` (17.002 líneas), fixtures `.mjs`, `skills/`, `docs/`.
- Criterio de superficie: `package.json` declara `pi.extensions: ["./extensions"]` y ningún
  `main`/`exports`; sólo `extensions/index.ts` y `test/` importan `src/`. Los `export` de `src/`
  son package-private (confirmado en `DEVELOPER.md`, "The package exposes exactly one public
  entry point"). Los cambios de firma sobre ellos van al tier `internal-signature`.
- Pasos: 19 (14 `mechanical`, 5 `internal-signature`). Orden: mecánicos primero.
- Cada paso es aplicable de forma independiente y deja el código en estado funcional.

## Estado de ejecución

Ronda de mecánicas cerrada: 12 de 14 aplicadas, 2 descartadas tras inspeccionar el código.
Cada paso aplicado quedó en un commit propio, con `npm run typecheck` + `npm test` (938 tests)
verdes antes del commit.

| Paso | Commit | Resultado |
|---|---|---|
| 1 | `19655b6` | aplicado |
| 2 | `4199222` | aplicado |
| 3 | `c74e78c` | aplicado |
| 4 | `087ec54` | aplicado |
| 5 | `3d16cbf` | aplicado |
| 6 | `3d4c636` | aplicado |
| 7 | `4bccbb3` | aplicado |
| 8 | `4a0ac12` | aplicado |
| 9 | `5f1ffa5` | aplicado |
| 10 | `ca517a9` | aplicado |
| 11 | — | **descartado**: N3, se lee peor (ver abajo) |
| 12 | `7a44348` | aplicado |
| 13 | — | **descartado**: el typecheck lo rechaza (ver abajo) |
| 14 | `0075818` | aplicado |
| 15 | `1fe07da` | aplicado (contrato `string | undefined`) |
| 16 | `a863c8f` | aplicado (dos predicados: `isPositiveFiniteNumber` privado, `isValidTimeoutMs` exportado) |
| 17 | `1c3ce57` | aplicado (`isPlainObject` en `overrides.ts`) |
| 18 | `60ef207` | aplicado (seam eliminado; divergencia con el catálogo de pi declarada en el módulo) |
| 19 | `77913af` | aplicado (`candidate.usage` + `displayUsageOf`) |
| — | `219cdc1` | `DEVELOPER.md` al día tras los pasos 15-19 |
| 20 | `8d223a9` | aplicado (`danglingToolCalls` usa `isNonEmptyString`) |
| 22 | `10e211c` | aplicado (helper `perToken`) |
| 23 | `ec7eb94` | aplicado (campos de sólo escritura del cache waste) |
| 21 | — | pendiente (ver "Pendientes propuestos") |

Revisión: cada paso `internal-signature` pasó por tres lentes (`qa-adversary`, `code-review-checklist`,
`refactor-identification`; `pablo-test-review` no está instalado) y por un smoke independiente en
herdr con `pi -ne -e ./extensions`.

Fallos de typecheck atrapados por el protocolo: el paso 13 fusionaba la rama `failed` de
`job-messages.ts` y los 938 tests pasaban, pero `tsc` rechazaba el objeto fusionado porque la unión
discriminada exige `isError: true` literal.

Smoke con `pi -ne -e ./extensions` en herdr, dos hitos: carga de la extensión con `/subagents`
y `/subagents session` sin errores; y tras el paso 14, un run real de `scout` con el reporte
renderizando Main, Subagents, By Agent y Total con split cached/uncached y costo por clave.

## Steps

1. `src/session-reconcile.ts:335`: reemplazar el literal `{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }` por `emptyUsageTotals()` (`:663-665`).
   - Lens: refactor-identification | Principle: DRY, reimplementación inline de un helper existente (RF-6) | Tier: mechanical
   - Behavior-preservation: `emptyUsageTotals` devuelve ese literal exacto; ya se usa así en `:790` y `:888`.
   - Verify: `test/unit/session-reconcile.test.ts` (totales de `mergeReport`, `usageCostBreakdown`).

2. `src/session-reconcile.ts:194-195, 814, 842, 1027`: extraer `isNonEmptyString(value): value is string` y usarlo en los cinco sitios que hoy escriben `typeof X === "string" && X`.
   - Lens: refactor-identification | Principle: DRY, regla repetida cinco veces y ya divergente (RF-3) | Tier: mechanical
   - Behavior-preservation: conjunción literal de las dos condiciones; mismo conjunto aceptado. `:203-204` queda intacto: ahí la regla acepta `""` y unificarla cambiaría comportamiento.
   - Verify: `test/unit/session-reconcile.test.ts` (acks y `buildRelaunchCandidates`).

3. `src/session-reconcile.ts:811-824, 839-851`: extraer un constructor no exportado de los campos comunes de `ReconciledRun` desde el mensaje de completion, usado por `dirlessRun` y por la rama `if (matched)` de `makeRun`.
   - Lens: refactor-identification | Principle: A1, literal de 10 campos idéntico salvo `stats`/`sessionFile`/`timestamp` (RF-1) | Tier: mechanical
   - Behavior-preservation: proyección pura de `details`/`segment`; no reordena efectos ni cambia campos omitidos.
   - Verify: `test/unit/session-reconcile.test.ts` (`buildSubagentSessionReport`). Aplicar después del paso 2: comparte líneas 814 y 842.

4. `src/job-view.ts:566-570, 614-616`: reemplazar las tres definiciones duplicadas (`bold`, `dim`, `counter`) por una factory no exportada.
   - Lens: refactor-identification | Principle: A1, tres helpers duplicados literalmente en el mismo archivo (RF-5) | Tier: mechanical
   - Behavior-preservation: definiciones byte-idénticas salvo un comentario; misma función para el mismo `theme`.
   - Verify: `test/unit/job-view.test.ts` (`buildSubagentSessionText`, `plainTheme`/`boldTheme`).

5. `src/job-view.ts:264-303`: aplanar `buildRelaunchResultText` con retornos tempranos y quitar el ternario redundante de `:277`.
   - Lens: pablo-code-philosophy | Principle: KISS, flujo no plano; `paramsRecorded` ya está implicado por `dropClauses` no vacío | Tier: mechanical
   - Behavior-preservation: mismo string producido; donde `paramsRecorded` es falso el `map` no se ejecuta.
   - Verify: `test/unit/job-view.test.ts` (`buildRelaunchResultText`, retry/continue con y sin params).

6. `src/background-jobs.ts:190-198, 350-355`: extraer helper no exportado de ids de jobs finalizados con opción de orden.
   - Lens: refactor-identification | Principle: A1, pipeline duplicado módulo `reverse`/`slice` (RF-6) | Tier: mechanical
   - Behavior-preservation: preserva el orden de iteración del `Map`; `reverse`/`slice` quedan en el llamador.
   - Verify: `test/unit/background-jobs.test.ts` (retención y listado).

7. `src/subagent-session.ts:133-147, 149-163, 169-178`: consolidar los tres bloques "precondición → try → catch → `fallbackToInMemory`".
   - Lens: refactor-identification | Principle: A1, tres copias idénticas módulo fábrica y mensaje | Tier: mechanical
   - Behavior-preservation: cada camino conserva su mensaje literal y el orden precondición→construcción.
   - Verify: `test/unit/subagent-session.test.ts`, `test/unit/subagent-session-wiring.test.ts`.

8. `src/peek-window.ts:445-446`: que `handleMouse` delegue en `stepScroll(-(event.wheelDelta ?? 0))`.
   - Lens: refactor-identification | Principle: A1, mutación + `onScroll` duplicados módulo el signo (RF-4b) | Tier: mechanical
   - Behavior-preservation: mismo offset clampeado y misma notificación; `handled: true` sin cambios.
   - Verify: `test/unit/peek-window.test.ts` (rueda y persistencia del offset).

9. `src/render-call.ts:6`: borrar `export { firstLine, truncate } from "./text-utils.ts";`.
   - Lens: pablo-code-philosophy | Principle: código muerto | Tier: mechanical
   - Behavior-preservation: ningún módulo los importa desde ahí; los cinco consumidores van a `text-utils.ts`.
   - Verify: grep de importadores + `npm run typecheck`.

10. `src/frontmatter.ts:263-267`: reutilizar `PLAIN_TOP_LEVEL_KEY_LINE` (`:213`) en lugar de construir un `RegExp` por campo y re-escanear la línea con `match(...)!`.
    - Lens: refactor-identification | Principle: A1, dos implementaciones de línea clave-valor (RF-2) | Tier: mechanical
    - Behavior-preservation: todos los `SCALAR_FIELDS` cumplen `[A-Za-z_][A-Za-z0-9_-]*`; se compara la clave capturada.
    - Verify: `test/unit/frontmatter.test.ts` (recuperación desde block scalar).

11. `src/frontmatter.ts:153-201`: tabla `campo → normalizador`. **[DESCARTADO]**
    - Motivo del descarte: los cinco recorridos no son copias. `LIST_FIELDS` lleva canal lateral
      (`inertToolNames`, `mapClaudeTools`) y una rama propia de `undefined`; el `model` no se
      normaliza en su pasada sino en un post-paso que lee `normalized.model` ya escrito;
      `ENUM_FIELDS` itera `{key, allowed}` y `maxTurns`/`timeoutMs` son singletons con validador
      propio. Una tabla exige que cada entrada devuelva `{value, inert}` más un post-hook: un
      mini-framework para siete pasadas secuenciales que hoy dicen su orden literalmente.
      Regla: N3, la abstracción se lee peor que la duplicación.
    - Pendiente: reanalizar con `planner` (el usuario lo pidió) para ver si existe una forma
      acotada que no caiga en N3.

12. `src/agents.ts:102-107, 153-161`: extraer `statFile` encapsulando `stat` + `isFile()` con captura.
    - Lens: refactor-identification | Principle: A1, mismo trío en dos funciones (RF-11) | Tier: mechanical
    - Behavior-preservation: mismo veredicto; aviso y retorno de cada fase quedan en su sitio.
    - Verify: `test/unit/agents.test.ts` (descubrimiento, archivos ilegibles).

13. `src/job-messages.ts:146-167`: unificar la rama `failed` con la final. **[DESCARTADO]**
    - Motivo del descarte: se implementó y los 938 tests pasaron, pero `npm run typecheck` lo
      rechaza. `SubagentJobMessageDetails` exige `status: "failed"` con `isError: true` literal, y
      el objeto fusionado pierde el estrechamiento del discriminante
      (`"cancelled" | "completed" | "failed"` no es asignable a `"failed"`). La duplicación codifica
      una invariante del tipo; las salidas serían una aserción `as` (que la tapa) o el ternario por
      rama (que reintroduce la duplicación). Commit revertido.
    - Pendiente: reanalizar con `planner` si conviene aflojar el tipo o dejar la duplicación.

14. `src/job-widget.ts:61-65, 67-71`: deduplicar el par `getUi()` + `scheduleOrStop` de `tick` y `refresh`.
    - Lens: pablo-code-philosophy | Principle: A1, dos líneas duplicadas literalmente | Tier: mechanical
    - Behavior-preservation: misma secuencia; el reset del handle queda en `tick`.
    - Verify: `test/unit/job-widget.test.ts` (tick programado, parada sin UI).

15. `src/claude-compat.ts:64-69`: `normalizeClaudeModel` devuelve `string | undefined` en lugar de `{ model?: string }`.
    - Lens: pablo-code-philosophy | Principle: middle-man, objeto-caja de un campo | Tier: internal-signature
    - Call sites: `src/overrides.ts:250`, `src/frontmatter.ts:182` (1 hop); grep `normalizeClaudeModel` sin otros.
    - Behavior-preservation: ambos desestructuran `.model` y no leen otra cosa.
    - Verify: `test/unit/claude-compat.test.ts`, `test/unit/overrides.test.ts`.

16. `src/run.ts:109-113`: exportar el predicado de validez de `timeoutMs` y usarlo en `src/job-view.ts:337-341`.
    - Lens: refactor-identification | Principle: A1, misma regla de dominio en dos módulos (RF-4); patrón ya existente con `isValidMaxTurns` | Tier: internal-signature
    - Call sites: `src/job-view.ts:337-341`, `src/run.ts:109-113`.
    - Behavior-preservation: misma conjunción y mismo techo; `resolveTimeoutMs` mantiene su recorte.
    - Verify: `test/unit/run.test.ts`, `test/unit/job-view.test.ts` (`outOfRangeRelaunchFields`).

17. `src/agents.ts:271-273`: borrar el `isPlainObject` local y usar el de `src/overrides.ts:159-161`, exportado.
    - Lens: refactor-identification | Principle: A1, dos copias byte-idénticas (RF-10b) | Tier: internal-signature
    - Call sites: `src/agents.ts:271`, `src/overrides.ts:159`.
    - Behavior-preservation: cuerpos idénticos módulo nombre del parámetro; predicado puro.
    - Verify: `test/unit/agents.test.ts` (`agentOverrides` desde settings).

18. `src/session-reconcile.ts:261, 418, 441, 469, 495, 565, 573, 711, 758, 833, 837`: eliminar `readPerTokenFallback` y `ReadPerTokenResolver`.
    - Lens: pablo-code-philosophy | Principle: YAGNI, seam de cinco capas sin proveedor | Tier: internal-signature
    - Call sites: `session-reconcile.ts:1013`, `extensions/index.ts:770-776` (quitar el argumento `undefined`), `test/unit/session-reconcile.test.ts:604, 1023`.
    - Behavior-preservation: el único uso (`:441`) cae siempre a `?? 0` porque nadie provee el resolver.
    - Verify: `test/unit/session-reconcile.test.ts` (cache waste) + `npm run typecheck` por la aridad.

19. `src/session-reconcile.ts:965, 973-995, 1056, 1072`: eliminar `SubagentRelaunchCandidate.usage` y `displayUsageOf`.
    - Lens: both | Principle: código muerto + DRY, segunda copia de la precedencia "disk-first" (RF-8) | Tier: internal-signature
    - Call sites: sin lectores en `src/` ni `extensions/`; escritores `:1056`, `:1072`; test que lo fija: `test/unit/session-reconcile.test.ts:726-737`.
    - Behavior-preservation: nadie lee el campo, así que ningún texto ni resultado del tool cambia.
    - Verify: `test/unit/session-reconcile.test.ts` (quitar la clave `usage` del `deepEqual`), `test/unit/job-view.test.ts`.

20. **Nuevo (pendiente)**: `src/session-reconcile.ts:233, 235, 239` — tres copias más de la regla
    "string no vacío" dentro de `danglingToolCalls`, fuera del alcance del paso 2. Mismo predicado
    `isNonEmptyString` ya extraído. Tier: mechanical.
    - Verify: `test/unit/session-reconcile.test.ts` (`danglingToolCalls`).

## Pendientes propuestos por las revisiones

- **21** `isNonEmptyString` vive dos veces: `src/session-reconcile.ts:265` y `src/validate.ts:28`
  (idénticos). Hogar natural: `src/overrides.ts`, junto a `isStringArray`/`isPlainObject`
  (`DEVELOPER.md` lo declara "single home for the shared field guards"). Tier: internal-signature.
- **22** aplicado en `10e211c` (helper `perToken` en `detectMiss`).
- **23** aplicado en `ec7eb94` (`PreviousRequest.modelKey`/`.timestamp`, `MissCandidate.provider`/
  `.model`/`.timestamp` y sus cinco asignaciones).
- **24** `validate.ts:24` `isRecord` acepta arrays (`typeof [] === "object"` sin `!Array.isArray`),
  a diferencia de `isPlainObject`: defecto preexistente que `qa-adversary` marcó como cambio de
  comportamiento (`validateSubagentParams([])` devuelve el error de `agent` en vez del de forma).
  No es simplificación: requiere decisión de producto.

## Not mechanical (follow-up)

- `src/overrides.ts:136-157` + `:230-242` tabla: el orden de emisión de `warnings` es observable.
- `src/overrides.ts:179-204` → `overrideValueMatches`: el `switch` cubre campos fuera de `OVERRIDE_TYPE_SPEC` y `maxTurns` valida rango; donde coincide, se lee peor (KISS > DRY).
- `src/overrides.ts:140` derivar `SETTINGS_EXCLUDED_FIELDS`: falso en runtime, una clave desconocida no pertenece a ningún conjunto y lleva su propio aviso.
- `src/session-reconcile.ts:729-736, 1016-1029` fusión de índices y doble parseo: el orden de inserción de los `Map` es observable.
- `src/session-reconcile.ts:577-592, 645-649, 893, 962, 1036-1054` ADT de estado; `:594-611` unión sobre `orphaned`; `:134-144, 296-305, 358-380` unión de `entry.type`: A3/A4 que cruzan firmas.
- `src/progress.ts:56-66` variantes de `TaskProgress`: A4 con payload condicionado.
- `src/progress.ts:145-151` vs `:165-171` clasificador compartido: la escalera coincide, el payload no (`statusFor` lista todos los tools; `activityWord` usa `.at(-1)` con `shortToolName`).
- `src/run.ts:57-127` combinador validate-or-warn: los tres difieren en política de recorte.
- `src/run.ts:357-569` y `src/agents.ts:149-204` Split Phase: requieren planificación aparte.
- `src/run.ts:161-164` (`extensionBindTimeoutMs`, `toolGraceMs`): único modo de que los tests no esperen 10 s.
- `src/peek-window.ts:188-189, 218, 370` geometría: las copias no son idénticas (`:189` omite el piso `Math.max(1, …)`).
- `src/peek-window.ts:481-490` `PeekManager` de una implementación: es la anotación de retorno.
- `src/peek-window.ts:63, 246` + `src/job-view.ts:93, 101-107` presentación settled compartida y export de `isSettled`: exige decidir dueño.
- Constantes exportadas sólo para tests (`DIVIDER`, `JOBS_WIDGET_KEY`, `MAX_PREVIEW_WIDTH`, `MAX_TRANSCRIPT_*`, `RUN_INDEX`): retirar el export obliga a hardcodear en el test y debilita la verificación.
- `src/validate.ts:17-18` + `src/agents.ts:338` re-exports: el comentario documenta que la consolidación se pospone al close-out de docs.
- `src/job-messages.ts:13-21` `buildSubagentToolResult`: re-exportado en la superficie del paquete.
- `src/agents.ts:18, 191` `source: "user"`: sin lectores, pero cambia la forma del objeto que ven las extensiones.
- `src/transcript.ts:96` guard defensivo: la inalcanzabilidad depende de `pushEntry`, fuera del radio de 1 hop.
- `src/subagent-session.ts:37-46` `matchAll`: patrón `/g` de módulo con `lastIndex` manual; equivalencia no evidente.
- `src/agents.ts:64, 69` y `src/run.ts:37, 47, 362` reloj inyectable: parámetro especulativo (YAGNI).
- `src/usage.ts:54-68` `TokenCounts`/`addTokenCounts` y `:75-85` `cost` en ceros: único llamador, comentario documenta la separación.

## Bug fuera de alcance

`src/loader-config.ts:75-88` emite un aviso sin `WARN_PREFIX` y otro con él, y `src/warn.ts:4`
vuelve a prefijar, produciendo `pi-simple-agents: pi-simple-agents: …`. Defecto de
comportamiento; corresponde a cacería de bugs, no a simplificación.
