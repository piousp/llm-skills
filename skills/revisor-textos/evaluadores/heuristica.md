# Filosofía

Revisión basada en principios de calidad argumentativa y comunicativa, no en
preferencias personales. Cada observación debe identificar un problema
objetivo en la estructura, coherencia o solidez del texto: contradicción
interna, argumento circular, evidencia insuficiente, sesgo no reconocido,
progresión temática deficiente. Señalar, fundamentar, sugerir. No opinar
sobre estilo allí donde es cuestión de gusto; intervenir donde la claridad,
coherencia o solidez argumentativa están en juego.

# Coherencia argumentativa

- **Tesis clara**: ¿el documento plantea una tesis o propósito explícito y
  verificable?
- **Pertinencia**: ¿cada sección y cada párrafo contribuye a sostener la
  tesis, o hay material tangencial?
- **Estructura argumentativa**: ¿las premisas están explícitas y son
  aceptables? ¿La conclusión se sigue lógicamente de ellas?
- **Consistencia interna**: ¿hay contradicciones entre afirmaciones en
  distintas secciones del documento?
- **Evidencia**: ¿cada afirmación central está respaldada por evidencia
  (datos, citas, razonamiento)? ¿La evidencia es suficiente y pertinente?
- **Contraargumentos**: ¿el documento reconoce y responde a objeciones
  previsibles?
- **Progresión**: ¿el argumento avanza de forma acumulativa o hay circularidad
  (volver al mismo punto sin haberlo desarrollado)?

# Razonamiento y solidez lógica

Detectar y clasificar falacias lógicas:

- **Generalización apresurada**: concluir sobre una población a partir de una
  muestra insuficiente o no representativa.
- **Falso dilema / falsa dicotomía**: presentar solo dos opciones cuando
  existen alternativas.
- **Petición de principio**: asumir en las premisas lo que se quiere probar
  en la conclusión.
- **Post hoc ergo propter hoc**: asumir causalidad por sucesión temporal.
- **Correlación como causalidad**: inferir relación causal de una correlación
  sin controlar variables.
- **Falsa analogía**: comparación entre situaciones que difieren en aspectos
  relevantes.
- **Apelación a la autoridad**: citar una autoridad fuera de su dominio de
  competencia.
- **Apelación a la novedad**: asumir que lo más reciente es superior por
  ser reciente.
- **Straw man (hombre de paja)**: distorsionar un argumento opuesto para
  refutarlo más fácilmente.
- **Ad hominem**: atacar a la persona que sostiene el argumento en lugar de
  al argumento mismo.
- **Falso consenso**: asumir que una posición es ampliamente aceptada sin
  evidencia.
- **Pendiente resbaladiza**: asumir que un primer paso lleva inevitablemente
  a una cadena de consecuencias extremas sin evidencia de eslabones
  intermedios.

Para cada falacia: identificar la ubicación, nombrar la falacia, explicar
por qué es falaz, y sugerir reformulación o eliminación.

# Detección de sesgos

## Sesgos cognitivos en la redacción

- **Sesgo de confirmación**: presentar o ponderar evidencia que favorece la
  hipótesis del autor e ignorar o minimizar evidencia contraria.
- **Sesgo de disponibilidad**: basar conclusiones en ejemplos vívidos o
  recientes en lugar de en datos sistemáticos.
- **Sesgo de anclaje**: dar peso desproporcionado a la primera información
  presentada (ej. valores iniciales en estimaciones).
- **Sesgo de optimismo**: subestimar sistemáticamente riesgos o limitaciones.
- **Sesgo de negatividad**: enfatizar desproporcionadamente aspectos negativos
  en contra de la evidencia disponible.
- **Sesgo de género**: lenguaje o supuestos que implícitamente favorecen un
  género sobre otros.
- **Etnocentrismo**: presentar la propia cultura o contexto como norma
  implícita.

## Sesgos metodológicos en la redacción

- **Sesgo de selección**: describir una muestra sin aclarar criterios de
  inclusión/exclusión o cómo estos afectan la generalización.
- **Sesgo de publicación**: citar predominantemente resultados positivos
  o publicados, ignorando literatura gris o resultados nulos.
- **Sesgo de supervivencia**: analizar solo los casos que "sobrevivieron"
  un proceso, ignorando los que no.
- **Sesgo de autoselección**: no mencionar que los participantes se
  autoseleccionaron y las implicaciones para la validez externa.

## Sesgos lingüísticos

- **Lenguaje eufemístico**: suavizar términos para minimizar hallazgos
  negativos o viceversa, lenguaje sensacionalista.
- **Nominalización excesiva**: convertir acciones en sustantivos abstractos
  que ocultan al agente ("se tomó la decisión" → "decidimos").
- **Implicaturas no justificadas**: sugerir conclusiones sin explicitarlas
  (ej. "el estudio encontró una correlación significativa, aunque otros no"
  sin decir que la evidencia es mixta).
- **Sesgo de marco (*framing*)**: presentar la misma información de forma
  que favorezca una interpretación sobre otra (ej. "tasa de éxito del 90 %"
  vs "tasa de fracaso del 10 %").

# Procedimiento de revisión

Producir un informe estructurado:

1. **Resumen ejecutivo** — estado general de la calidad argumentativa,
   hallazgos principales priorizados por severidad.
2. **Coherencia argumentativa** — hallazgos sobre tesis, pertinencia,
   estructura, consistencia, evidencia, contraargumentos, progresión.
3. **Razonamiento y falacias** — falacias detectadas con ubicación,
   explicación y corrección sugerida.
4. **Sesgos** — sesgos cognitivos, metodológicos y lingüísticos detectados.
5. **Recomendaciones** — priorizadas por impacto (alta / media / baja /
   informativa).

## Formato de cada observación

- Ubicación precisa: [sección / párrafo / línea]
- Área: [coherencia / razonamiento / sesgo]
- Subtipo: [tesis / pertinencia / contradicción / evidencia / falacia /
  sesgo cognitivo / sesgo metodológico / sesgo lingüístico / otro]
- Severidad: [alta / media / baja / informativa]
- Descripción del problema
- Principio violado (con referencia a la sección de este skill)
- Corrección sugerida

# Verificación

```text
1. Coherencia → verificar: tesis clara, premisas explícitas, evidencia suficiente
2. Razonamiento → verificar: ausencia de falacias lógicas identificables
3. Sesgos → verificar: sin sesgos cognitivos, metodológicos o lingüísticos
4. Sin solapamiento con falacias → verificar: no reemplazar el skill analisis-falacias-logicas
   (este skill detecta falacias en el contexto de la calidad argumentativa general;
   para un análisis exhaustivo de falacias, usar analisis-falacias-logicas)
5. Sin solapamiento con defectos epistémicos → verificar: no confundir sesgos
   de redacción con defectos en el anclaje del conocimiento
   (usar revision-defectos-epistemicos para eso)
```