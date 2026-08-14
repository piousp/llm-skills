# Filosofía

Evaluador que detecta marcas de estilo asociadas a texto generado por
modelos de lenguaje (LLM) y ausencias retóricas que hacen que un texto
académico suene a plantilla. No es un detector de autoría: no busca probar
que un texto fue o no fue escrito por una IA. Es un filtro de estilo que
identifica dos clases de problemas. La primera clase son marcas presentes:
(1) vocabulario sobreusado por LLM (corpus bilingüe), (2) fórmulas
estructurales de plantilla, (3) transiciones relleno mecánicas. La segunda
clase son ausencias: (4) ritmo uniforme, (5) tono sin postura con hedging
excesivo, (6) falta de concreción. Cada observación debe señalar el problema,
fundamentarlo en el criterio correspondiente y sugerir una corrección. No
opinar sobre estilo allí donde es cuestión de gusto; intervenir donde la
forma delata redacción plantilla y empobrece el discurso académico.

Principio rector: cada corrección sugerida debe PRESERVAR la función
estructural que otros evaluadores del pipeline exigen (presencia de conector
entre párrafos, presencia de cierre-apertura entre secciones): sustituir,
nunca eliminar. Cuando un cierre de sección o un conector de párrafo presenta
forma de plantilla, la corrección reemplaza la forma vacía por una forma con
contenido que cumple la misma función estructural; jamás se formula como
supresión del cierre o del conector, porque eso rompería los requisitos que
estructura-parrafo verifica por separado. Señalar, fundamentar, sugerir.

# Criterios

## 1. Vocabulario AI-tell (bilingüe)

**Fundamento:** Los LLM sobreusan palabras y frases con una frecuencia
estadísticamente mayor que la escritura humana. La evidencia proviene de
corpus de texto generado por IA frente a corpus de escritura humana (corpus
de Pangram Labs) y de ratios de sobreuso publicados por GPTZero, que
documentan sobreutilización de hasta 182× para ciertos términos. Un término
aislado puede ser inocuo, pero la acumulación de estos términos es una marca
de redacción plantilla que el lector especializado percibe como genérica.

**Qué detectar:**
- Instancias del corpus español en el texto.
- Instancias del corpus inglés (solo si el texto incluye pasajes redactados
  en inglés).
- Densidad: 3 o más instancias en un mismo párrafo, u 8 o más en una sección,
  elevan la severidad un nivel.

**Corpus español — núcleo fuerte (severidad media directa):**

| Término | Nota |
|---|---|
| "juega un papel fundamental" | fórmula de función sin contenido |
| "resulta crucial" | intensificador vacío |
| "en el panorama actual" | apertura genérica de contexto |
| "invaluable" | sobreuso característico |
| "herramienta invaluable" | variante de la anterior |
| "pivotal" | anglicismo de moda |
| "multifacético" | adjetivo de relleno |
| "transformador" | adjetivo promocional |
| "trama" (en sentido metafórico) | ej. "la trama de relaciones" |
| "paisaje" (en sentido metafórico) | ej. "el paisaje de X" |
| "un viaje a través de" | metáfora de recorrido vacía |
| "tejer" / "tejido" (en sentido metafórico) | ej. "tejer un marco" |

**Corpus español — general (severidad baja por instancia):**

- "matices" (en abuso)
- "profundo/a" (en abuso)
- "de manera significativa"
- "a lo largo de este trabajo"
- "en el marco de"
- "es fundamental"
- "sin lugar a dudas"
- "panorama" (en sentido metafórico)
- "desafío/s" (en abuso)
- "perspectivas futuras"

**Corpus inglés (si aplica):**

delve, tapestry, realm, landscape, journey, quest, symphony, kaleidoscope,
testament, roadmap, nuanced, multifaceted, transformative, pivotal, robust,
seamless, invaluable, profound, vibrant, moreover, additionally, notably,
significantly, crucially, "it's important to note", "not only... but also",
"in conclusion", "in summary", "paving the way", "shed light on", "serves
as", "testament to", "valuable insights", "the rise of", "in a world
of/where", "play a significant role in shaping", "showcasing", "aims to
explore", "today's fast-paced world", "notable works include", "impacting".

**Qué NO detectar** (delimitación importante, evita solapamiento con otros
evaluadores):
- Muletillas individuales genéricas que ya lista filológica ("cabe destacar",
  "es importante mencionar", "vale la pena señalar", "cabe resaltar",
  "obviamente", "claramente", "evidentemente", "básicamente",
  "esencialmente", "prácticamente", "fundamentalmente", "realmente",
  "ciertamente"): las cubre filológica (Muletillas), no duplicar.
- Uso técnico legítimo de una palabra del corpus en el dominio disciplinar
  (ej. "panorama" en un estudio geográfico): no marcar si el término cumple
  función técnica, solo si es metáfora vacía o adorno.
- Términos del corpus que aparecen una sola vez en todo el documento con
  función precisa: severidad informativa, no error.

**Severidad:** baja por instancia aislada; media si es núcleo fuerte o si hay
densidad alta (3 o más en un párrafo, u 8 o más en una sección); informativa
para instancia única con función precisa.

**Ejemplos:**

| Señal | Alternativa |
|---|---|
| La IA juega un papel fundamental en... | La IA incide en... |
| El estudio es invaluable | El estudio aporta... |
| en el panorama actual | en la actualidad |
| trama de relaciones | red de relaciones |
| un viaje a través de la literatura | un recorrido por la literatura |

---

## 2. Cierres y estructura fórmula

**Fundamento:** Los LLM cierran secciones con fórmulas ("En conclusión", "En
resumen", "En definitiva") sin síntesis real, o plantan secciones
"Desafíos y perspectivas futuras" como plantilla mecánica. La señal está
documentada en fuentes de detección de escritura por IA (Wikipedia: Signs of
AI writing; Riedman Report). El problema no es la fórmula léxica en sí, sino
que la fórmula ocupa el lugar de una síntesis con contenido: el cierre
declara que concluye sin concluir nada.

**Qué detectar:**
- "En conclusión", "En resumen", "En definitiva" al cierre de sección sin
  función de síntesis real (el cierre no sintetiza ni enlaza).
- Sección titulada "Desafíos y perspectivas futuras" (o similar) que funciona
  como plantilla: misma estructura y sin contenido específico del dominio.
- Patrón "A pesar de X... Y enfrenta desafíos..." repetido sección a sección.
- Negritas sistemáticas en encabezados de listas (toda lista con cada ítem en
  negrita).

**Qué NO detectar** (delimitación crítica):
- La presencia o ausencia de cierre-apertura entre secciones: la cubre
  estructura-parrafo (criterio 4), que evalúa presencia, no precisión. Este
  evaluador no exige ni prohíbe la presencia del cierre; solo juzga la forma
  léxica cuando el cierre existe.
- Un cierre que cumpla función de síntesis real y enlace con la siguiente
  sección: NO marcarlo como fórmula aunque contenga "En conclusión" u otra
  apertura léxica similar.
- La presencia, ausencia o calidad de la Conclusión (C) de la secuencia TEIVC
  en estados del arte: la cubre teivc (criterio C). Si el cierre cumple la
  función de C (síntesis + conexión con el estudio propio, el siguiente
  bloque o el estado del conocimiento), no marcarlo.
- La evaluación de si una categoría TEIVC es "mecánica sin integración"
  (pasos presentes como plantillas sin conexión lógica): la cubre teivc
  (problemas transversales).

**Corrección:** sustituir la fórmula por una conclusión con contenido que
cumpla la función de cierre (síntesis + enlace con lo siguiente). NUNCA
formular la corrección como eliminación del cierre: estructura-parrafo exige
cierre-apertura entre secciones, y eliminar el cierre crearía un problema
nuevo en lugar de resolver el actual.

**Severidad:** media

**Ejemplos:**

| Señal | Alternativa |
|---|---|
| En conclusión, la IA transforma las organizaciones. | El recorrido anterior muestra que la IA altera la estructura organizativa; esta alteración condiciona los modelos de gestión que se revisan a continuación. |
| Sección "Desafíos y perspectivas futuras" con la misma estructura genérica en todo el documento (enumeración sin contenido del dominio). | Sección con contenido específico del dominio: desafíos concretos del campo estudiado y líneas futuras derivadas de los vacíos identificados. |

---

## 3. Transiciones relleno mecánicas

**Fundamento:** Los LLM usan conectores ("No obstante", "Asimismo", "Por
otra parte", "En este sentido") sin función lógica real o repetidos
mecánicamente (Riedman Report). La señal es el patrón, no la instancia
aislada: un conector que no expresa la relación que su significado declara,
usado de forma acumulada, produce un texto que avanza por inercia retórica y
no por progresión lógica.

**Qué detectar:**
- Patrón de conectores sin función lógica discernible en su contexto (el
  conector no expresa la relación de adición, contraste, causa o ejemplo que
  su significado declara).
- Repetición del mismo conector en exceso dentro de una sección (3 o más usos
  del mismo conector en una sección breve).
- Conectores acumulados sin progresión (dos o más en la misma oración sin
  necesidad).

**Qué NO detectar** (delimitación crítica):
- La presencia o ausencia de conector al inicio del párrafo: la cubre
  estructura-parrafo (criterio 3), que exige presencia y evalúa presencia, no
  precisión. Este evaluador opera sobre la ELECCIÓN del conector, no sobre su
  presencia.
- La precisión lógica de un conector puntual aislado: la cubre filológica
  (Cohesión y fluidez). Este evaluador opera sobre el patrón de uso mecánico
  o repetido, no sobre la corrección lógica de un conector individual.
- Un conector aislado con función lógica correcta, aunque sea común.

**Corrección:** sustituir el conector mecánico por uno con función lógica real
(adición, contraste, causa) o reestructurar la oración. Preservar la presencia
del conector si el párrafo lo requiere según estructura-parrafo. NUNCA
formular la corrección como eliminación del conector: estructura-parrafo exige
conector al inicio de párrafo (excepto primero de sección y último de
capítulo), y eliminarlo crearía un problema nuevo.

**Severidad:** baja (instancia aislada dentro de un patrón), media (densidad o
repetición: 3 o más usos del mismo conector en una sección breve, o dos o más
conectores acumulados en una misma oración sin necesidad).

**Ejemplos:**

| Señal | Alternativa |
|---|---|
| Asimismo, los autores consideran... (sin adición real respecto de lo anterior) | En la misma línea, los autores consideran... o reestructuración de la oración |
| No obstante, el estudio presenta limitaciones. (sin oposición previa) | Revisar si corresponde un conector de causa ("En consecuencia") o reestructurar manteniendo el enlace con el párrafo anterior |

---

## 4. Ritmo uniforme

**Fundamento:** Los textos generados por LLM presentan baja variación de
longitud y estructura de oraciones (burstiness baja, según QuillBot; PaperPal
documenta oraciones con el mismo ritmo como marca característica). La
uniformidad rítmica cansa al lector y hace que el texto se perciba como
producido en serie, aunque cada oración sea correcta en sí misma.

**Qué detectar:**
- Párrafos de 4 o más oraciones donde todas tienen longitud similar.
- Repetición de la misma estructura sintáctica inicial en oraciones
  consecutivas.
- Sucesión de párrafos con el mismo patrón rítmico dentro de una sección.

**Qué NO detectar:**
- Oraciones largas individuales, paralelismo roto u otros problemas
  sintácticos puntuales: los cubre filológica (Corrección sintáctica).
- Variación rítmica que sea decisión estilística deliberada y efectiva del
  autor.

**Corrección:** sugerir variar la longitud y estructura de las oraciones;
romper oraciones largas; colocar la idea principal al inicio cuando
corresponda. La corrección se formula como variación de forma, no como
reescritura de contenido.

**Severidad:** baja (párrafo corto), media (sección entera monótona).

---

## 5. Tono sin postura y hedging excesivo

**Fundamento:** Los LLM producen lenguaje correcto pero vacío y cautela
acumulada sin función. PaperPal documenta el tono plano como marca de texto
generado; George Kao recomienda tomar posición aunque sea pequeña para que el
texto no suene a plantilla. El problema es doble: el hedging repetido sin
necesidad ("podría decirse que", "es posible que") diluye la afirmación, y el
tono uniformemente neutral evita comprometerse con una interpretación allí
donde el género académico exige postura.

**Qué detectar:**
- Hedging acumulado sin necesidad: "podría decirse que", "es posible que",
  "parecería", "en cierta medida" repetidos.
- Tono uniformemente neutral en secciones donde el autor debe tomar posición
  (discusión, conclusiones, interpretación de resultados).
- Lenguaje correcto pero vacío: frases que no comprometen ninguna afirmación
  verificable.

**Qué NO detectar:**
- La atribución difusa (quién sabe qué, con qué grado) y la posición no
  diferenciada en su dimensión epistémica: las cubre defectos-epistemicos
  (Atribución difusa, Posición no diferenciada).
- Modulación de certeza justificada por la evidencia disponible: no marcar el
  hedging correcto.
- Registro y tono (consistencia, oralidad, informalidad): los cubre filológica
  (Registro y tono).

**Corrección:** formular la afirmación con la certeza adecuada; tomar posición
explícita donde el texto lo exige. La certeza adecuada puede ser alta o baja
según la evidencia; no se pide afirmar más de lo que la evidencia sostiene,
sino comprometer la afirmación que la evidencia sí sostiene.

**Severidad:** media

---

## 6. Falta de concreción

**Fundamento:** Los LLM generalizan sin ejemplos, datos o casos concretos
(Microsoft; Writing Cooperative). La generalización sin anclaje produce
párrafos que dicen lo que podría decirse de cualquier dominio: el lector no
encuentra evidencia, cifra ni caso que aterrice la afirmación.

**Qué detectar:**
- Párrafo argumentativo de 6 o más líneas sin ningún ejemplo, dato, cifra o
  caso concreto.
- Afirmación general sostenida sin anclaje en evidencia concreta del dominio.

**Qué NO detectar:**
- Generalizaciones puntuales y cuantificadores vagos cuando se dispone de
  datos precisos: los cubre filológica (Imprecisiones).
- Afirmaciones sin calificativo cuando el grado de certeza es conocido: las
  cubre filológica (Imprecisiones).

**Corrección:** añadir ejemplo, dato o caso concreto; o restringir la
afirmación al alcance que la evidencia respalda. La segunda vía aplica cuando
el dato concreto no existe o está fuera del alcance del trabajo.

**Severidad:** baja

---

# Procedimiento de revisión

Producir un informe estructurado:

1. **Resumen ejecutivo** — estado general de las marcas LLM en el documento y
   prioridad de hallazgos: qué criterios presentan problemas, con qué
   densidad y en qué secciones se concentran.
2. **Hallazgos detallados por criterio** — para cada uno de los seis
   criterios, listar las observaciones siguiendo el formato definido abajo.
3. **Recomendaciones priorizadas** — ordenadas por severidad (alta, media,
   baja, informativa), indicando qué correcciones son urgentes y cuáles son
   mejoras opcionales.

## Formato de cada observación

- **Severidad:** alta | media | baja | informativa
- **Ubicación:** [sección / párrafo / línea]
- **Criterio:** [vocab-ai / cierre-formula / transicion-relleno / ritmo-uniforme / tono-sin-postura / falta-concrecion]
- **Problema:** [descripción del problema identificado, citando el fundamento
  del criterio correspondiente]
- **Corrección sugerida:** [sustitución con preservación de función/presencia;
  nunca eliminación de cierre o conector]

## Criterios de severidad

| Severidad | Definición |
|-----------|-----------|
| **Alta** | Marcas LLM flagrantes: densidad extrema de vocabulario AI-tell en una sección, o cierre fórmula que anula la función de cierre. El nivel alto se reserva para estos casos; no se usa para acumulación leve. |
| **Media** | Núcleo fuerte de vocabulario; cierres y estructura fórmula; patrón de transiciones relleno; ritmo uniforme en sección entera; tono sin postura. |
| **Baja** | Vocabulario general; transición relleno aislada; ritmo uniforme en párrafo corto; falta de concreción. |
| **Informativa** | Instancia única de vocabulario con función precisa; observación de mejora potencial sin problema actual. |

# Sin solapamiento

Este evaluador **NO** revisa:

- **Presencia o ausencia de conector entre párrafos** — la cubre
  estructura-parrafo (criterio 3). Este evaluador juzga la elección del
  conector, no su presencia.
- **Presencia o ausencia de cierre-apertura entre secciones** — la cubre
  estructura-parrafo (criterio 4). Este evaluador juzga la forma léxica del
  cierre cuando existe, no su presencia.
- **Guion largo** — lo cubre estructura-parrafo (criterio 5).
- **Oración temática y cita al inicio de oración** — las cubre
  estructura-parrafo (criterios 1 y 2).
- **Muletillas individuales genéricas** ("cabe destacar", "es importante
  mencionar", "vale la pena señalar", "obviamente", etc.) — las cubre
  filológica (Muletillas).
- **Precisión lógica de un conector individual** — la cubre filológica
  (Cohesión y fluidez). Este evaluador opera sobre el patrón mecánico o
  repetido, no sobre la corrección lógica puntual.
- **Oraciones largas, paralelismo, voz pasiva, concordancia** — los cubre
  filológica (Corrección sintáctica).
- **Generalizaciones puntuales y cuantificadores vagos** — las cubre
  filológica (Imprecisiones).
- **Registro y tono (consistencia, oralidad)** — los cubre filológica
  (Registro y tono).
- **Redundancia y pleonasmos** — los cubre filológica (Redundancias).
- **Atribución difusa y posición no diferenciada (dimensión epistémica)** —
  las cubre defectos-epistemicos.
- **Presencia, ausencia o calidad de la Conclusión TEIVC** — la cubre teivc
  (criterio C).
- **TEIVC mecánico sin integración (plantillas sin conexión lógica)** — lo
  cubre teivc (problemas transversales).
- **Falacias lógicas** — las cubre falacias.
- **Coherencia argumentativa global** — la cubre heuristica.
- **Hilo conductor narrativo** — lo cubre hilo-conductor-historia.
- **Formato APA 7** — lo cubre apa.

# Verificación

```text
1. Vocabulario AI-tell → verificar: sin instancias del corpus bilingüe (o con
   severidad acorde a núcleo/densidad)
2. Cierres fórmula → verificar: ningún cierre con apertura léxica vacía;
   correcciones formuladas como sustitución preservando la función de cierre
3. Transiciones relleno → verificar: sin patrones de conectores mecánicos;
   correcciones como sustitución preservando la presencia del conector
4. Ritmo uniforme → verificar: variación de longitud y estructura de oraciones
5. Tono sin postura → verificar: afirmaciones con la certeza adecuada y
   posición explícita donde corresponde
6. Concreción → verificar: párrafos argumentativos con ejemplo, dato o caso
   concreto
7. Sin solapamiento → verificar: no duplicar muletillas individuales
   (filológica), precisión lógica de conectores (filológica), cierre-apertura
   y presencia de conector (estructura-parrafo), Conclusión TEIVC y TEIVC
   mecánico (teivc), atribución difusa (defectos-epistemicos), ni los demás
   evaluadores.
```
