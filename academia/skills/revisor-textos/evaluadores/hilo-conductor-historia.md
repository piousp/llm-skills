# Filosofía

Un texto no solo debe ser coherente — debe contar una historia, avanzar por un
hilo conductor y llegar a algún lugar. La coherencia argumentativa es necesaria
pero insuficiente: un texto puede ser lógicamente impecable y aun así sentirse
estancado, repetitivo o sin rumbo. Este evaluador añade la dimensión narrativa:
fluidez, avance progresivo, destino.

Cada observación debe identificar un problema objetivo en la narrativa del
texto: hilo conductor ausente o débil, falta de avance, ramas muertas,
retrocesos innecesarios, cierre que no cumple la promesa del inicio, o
transiciones que no propulsan. Señalar, fundamentar, sugerir. No opinar sobre
preferencias estilísticas donde no hay pérdida de dirección narrativa.

# Hilo conductor

El hilo conductor es la respuesta a "¿de qué trata este texto?" en una sola
oración. Atraviesa cada sección, cada párrafo. Todo lo que no lo avanza, sobra.

- **Enunciabilidad**: ¿se puede enunciar el hilo conductor en una oración? Si
  no, el texto no tiene hilo claro.
- **Avance por párrafo**: al terminar un párrafo, el lector debe saber algo
  que no sabía antes, o ver una conexión que no veía. Si un párrafo no aporta
  nuevo avance, es relleno.
- **Sin ramas muertas**: si una sección desarrolla un punto que no conecta con
  el hilo principal, no pertenece al texto. Evaluar si debe ir a un apéndice o
  eliminarse.
- **Una línea, no un árbol**: el texto sigue un solo hilo central. Las
  ramificaciones secundarias se minimizan o se eliminan.
- **Múltiples hilos sin jerarquía**: detectar si el texto intenta cubrir
  demasiado y ningún hilo domina. El lector no sabe cuál es el principal.

# Historia — narrativa textual

El texto debe ir de un punto de partida a un punto de llegada, y el lector
debe sentir ese movimiento.

- **Principio**: establece el punto de partida — el contexto, la pregunta, la
  tensión inicial. El lector debe saber dónde está parado y qué está en juego.
- **Desarrollo**: cada sección acerca al lector al destino. La progresión debe
  ser acumulativa: lo que se dijo antes no se repite, se usa como escalón.
- **Llegada**: el cierre debe cumplir la promesa del inicio. Resolver la
  tensión inicial, responder la pregunta, completar el arco. Si el inicio
  promete X y el final entrega Y, el lector queda insatisfecho.
- **El cierre es destino, no resumen**: el final no debe ser un resumen de lo
  que ya se dijo. Debe ser el lugar al que todo el texto apuntaba. Una
  conclusión que sorprende por inevitabilidad, no por novedad.
- **El lector no se pierde**: en cualquier punto del texto, el lector debe
  poder responder: "¿dónde estoy en el hilo conductor?" sin esfuerzo.

# Principios de evaluación

## Avance en cada paso

Cada sección, cada párrafo, debe mover el hilo hacia adelante. Si una sección
solo profundiza sin avanzar, probablemente está estancando el texto.

## Sin retrocesos

No repetir información ya establecida. No volver a explicar conceptos que ya
se cubrieron. Usar referencias en lugar de repeticiones.

## Cada transición debe propulsar

El conector entre párrafos no solo conecta — también indica dirección.
"En contraste" es conexión; "Esto nos lleva a" es conexión + avance.
Evaluar si las transiciones solo enlazan o también indican dirección.

## Tensión y resolución

Incluso en textos no ficcionales, hay una pregunta que se abre al inicio y
se cierra al final. El lector debe sentir que esa pregunta lo acompañó
durante la lectura.

# Técnicas de verificación

## Prueba "¿Qué avanza?"

Para cada párrafo o sección, preguntar:
- ¿Qué sabe el lector ahora que no sabía antes?
- ¿Cómo acerca esto al destino del texto?
- Si elimino este párrafo, ¿se pierde el hilo?

Si la respuesta es "nada" o "no se pierde", el párrafo sobra.

## Mapear el arco narrativo

Identificar los tres hitos del texto:
1. **Punto de partida**: contexto, situación inicial, pregunta.
2. **Giro o desarrollo**: el punto donde el texto cambia de dirección o
   profundiza. Puede ser un hallazgo, una evidencia clave, un cambio de
   perspectiva.
3. **Llegada**: la conclusión, la respuesta, la nueva comprensión.

Verificar que el texto va de 1 a 3 sin desviarse.

## Señalizar sin lastrar

El avance debe señalizarse sin romper el flujo. Preferir:
- "Esto nos lleva a..." (avance)
- "Hasta aquí hemos visto que... Ahora..." (pausa + avance)
- "La consecuencia directa es..." (causa-efecto que avanza)

Detectar:
- "Como se mencionó anteriormente..." (retroceso, no avance)
- "Volviendo a..." (retroceso)
- "Otro aspecto importante es..." (sin dirección, puede ser rama muerta)

# Procedimiento de revisión

Producir un informe estructurado:

1. **Resumen ejecutivo** — estado general de la narrativa del texto: ¿tiene
   hilo conductor? ¿llega a algún lugar? Hallazgos principales priorizados
   por severidad.
2. **Hilo conductor** — hallazgos sobre enunciabilidad, avance por párrafo,
   ramas muertas, jerarquía de hilos.
3. **Narrativa** — hallazgos sobre principio, desarrollo, llegada, cierre,
   progresión acumulativa, señalización.
4. **Principios** — avance, retrocesos, transiciones, tensión-resolución.
5. **Recomendaciones** — priorizadas por impacto (alta / media / baja /
   informativa).

## Formato de cada hallazgo

- Ubicación precisa: [sección / párrafo / línea]
- Tipo: [`hilo-conductor` | `narrativa` | `principio` | `transición`]
- Severidad: [alta / media / baja / informativa]
- Descripción del problema
- Principio violado (con referencia a la sección de este evaluador)
- Corrección sugerida

# Verificación

```text
1. Hilo conductor → verificar: enunciable en una oración, cada párrafo avanza, sin ramas muertas
2. Narrativa → verificar: principio claro, desarrollo acumulativo, cierre cumple promesa del inicio
3. Avance → verificar: sin retrocesos, cada sección mueve el hilo hacia adelante
4. Transiciones → verificar: conectan y propulsan, no solo enlazan
5. Arco narrativo → verificar: punto de partida → desarrollo → llegada, sin desviaciones
6. Sin solapamiento con heuristica → verificar: no reemplazar revision-heuristica
   (este evaluador detecta problemas narrativos y de flujo; para problemas de
   coherencia argumentativa, falacias lógicas o sesgos, usar heuristica)
```