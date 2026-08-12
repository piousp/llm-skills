---
name: human-like-writing
description: >
  Escribir o reescribir cualquier texto para que suene naturalmente humano,
  en cualquier género: comentarios de código, revisiones de PR, resúmenes,
  ajustes de textos, correos y redacción académica. Usar antes de redactar o
  revisar cualquier pieza de escritura. No usar para detectar o juzgar texto
  escrito por IA; este skill produce escritura, no ejecuta un pipeline de
  revisión.
---

# Escritura con Voz Humana

Objetivo: texto que suene escrito por una persona, no generado por un modelo.
Las reglas valen para todo tipo de escritura: comentarios de código,
revisiones de PR, resúmenes, ajustes, correos y redacción académica. Nada
aquí es específico de un solo dominio.

**Idioma de trabajo.** Si el idioma de trabajo es inglés, leer `SKILL.md` y
seguirlo en su lugar. Esa versión lleva su propia lista de palabras
prohibidas y sus propios ejemplos.

## Antes de escribir

- [MUST] leer `references/banned-list-es.md` y tenerla a la vista mientras se redacta.
- [MUST] leer `references/voice-es.md` para fijar la voz y reunir muestras few-shot.
- [DO] fijar la voz y reunir de 3 a 5 muestras reales de la escritura del
  autor antes de redactar cualquier cosa de más de una frase.

## Reglas duras

Absolutas. Romper una obliga a reescribir.

- **[NEVER]** usar guion largo para enfatizar o para conectar ideas. Usar
  punto, coma o punto y coma. El guion largo es la marca más fuerte de
  texto generado.
- **[NEVER]** cerrar con una frase de manual. La última frase del texto es
  el último punto concreto, no un resumen del texto. Los cierres
  prohibidos están en `references/banned-list-es.md`.
- **[NEVER]** abrir una frase con un conector de relleno que no aporta
  lógica. Si el conector no hace trabajo, eliminarlo o fusionar la frase
  con la anterior.
- **[NEVER]** añadir una sección plantilla de cierre (retos y pasos
  siguientes) que la tarea no haya pedido por su nombre.
- **[NEVER]** usar negritas sistemáticas en listas ni formato de relleno.
  Una negrita puntual para una palabra clave, como mucho, y rara vez. Una
  lista llana ya lleva su estructura.
- **[NEVER]** apilar atenuantes. "Parece que esto podría ser algo
  arriesgado" suena a evasión. Un atenuante por afirmación, o ninguno.
- **[NEVER]** usar las palabras de `references/banned-list-es.md`. Si una
  palabra prohibida es exactamente la adecuada, reescribir la frase
  alrededor de ella.

## Reglas suaves

Hábitos con criterio, no una lista de control.

- **[ALWAYS]** preferir voz activa. "El test falla en la línea 12" pesa más
  que "se observa que el test falla en la línea 12". La pasiva sirve cuando
  el agente de la acción se desconoce o no importa.
- **[ALWAYS]** variar la longitud y el ritmo de las frases. Tras una frase
  larga, una corta. Empezar unas por el verbo, otras por el sujeto, otras
  por una subordinada. El texto generado tiene poca burstiness (ritmo
  uniforme) y poca perplejidad (elección de palabras demasiado predecible);
  los detectores combinan ambas señales con marcadores de vocabulario, así
  que cambiar sinónimos no los engaña.
- **[ALWAYS]** tomar postura. Decir qué falla, qué está bien, qué cambiaría.
  Un resumen neutro suena a máquina. Una opinión clara, aunque sea leve,
  suena humana. "El estudio reporta una ganancia del 12 %, pero el grupo de
  control era pequeño" es postura; "el estudio reporta una ganancia del
  12 %" no lo es.
- **[ALWAYS]** ser concreto. Nombrar el archivo, la línea, la cifra, la
  fecha, la persona. "La fusión tarda 40 segundos" pesa; "la fusión es
  lenta" no. "El efecto se sostuvo en 14 de 16 ensayos" vale más que "los
  resultados fueron relevantes".
- **[DO]** añadir detalle sensorial o vivido cuando el género lo admita:
  qué mostró el registro de compilación, cómo suena el argumento leído en
  voz alta, qué test falló primero. La prosa académica toma el detalle
  como dato. Los correos y las revisiones lo toman como voz.
- **[DO]** recortar relleno. Cada frase debe hacer trabajo. Leer el
  borrador en voz alta y cortar lo que frene la respiración.

## Flujo de trabajo

Adaptar los pasos al tamaño de la tarea. Nunca forzar la secuencia completa
para un comentario suelto.

**Texto largo o delicado** (una revisión de PR, un resumen, un párrafo
académico):

1. **Fijar la voz.** Escribir una línea de descripción de voz, por ejemplo
   "directa, concreta, con opinión leve, sin relleno". Tenerla a la vista.
2. **Esquema.** Solo si el texto superará un párrafo. Tres a cinco puntos
   en orden. Todavía sin prosa.
3. **Borrador.** Escribir libre contra el esquema, con la lista de palabras
   prohibidas y la descripción de voz abiertas.
4. **Solo crítica.** Leer el borrador y anotar qué rompe las reglas: dónde
   el ritmo es plano, dónde se esconde la postura, qué palabra prohibida
   se coló. Solo diagnosticar. No reescribir todavía.
5. **Reescritura por edición.** Corregir el borrador frase por frase,
   partiendo de la crítica. Conservar el significado y el detalle. Nunca
   añadir argumentos nuevos para estirar el texto.

**Texto corto** (un comentario de código, una respuesta, una línea de
asunto): saltarse los pasos. Aplicar las reglas duras y suaves directamente,
en una pasada.

## Autoverificación antes de entregar

Un pase mental rápido. Responder estas preguntas, corregir lo que falle y
entregar.

- ¿Hay algún guion largo en el texto?
- ¿Hay alguna palabra de la lista prohibida?
- ¿Termina con un cierre de manual o un comentario sobre el propio texto?
- ¿Varían las longitudes de frase o todas tienen la misma forma?
- ¿Se ve la postura, o un lector neutro no sabría qué piensa el autor?
- ¿Cada afirmación es concreta, con un nombre, una cifra o un ejemplo detrás?
- ¿El autor reconocería su propia voz en este texto?
