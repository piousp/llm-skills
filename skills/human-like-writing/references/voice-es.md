# Fijar la voz y few-shot

Método para fijar una voz antes de escribir y para moldear el texto con
muestras propias del autor. Lo lee la versión en español del skill.

### Fijar la voz

Escribir una línea de descripción de voz antes de redactar. Define
audiencia, registro, postura y qué evitar. Mantenerla a la vista mientras
se escribe.

Ejemplo: "Directa, concreta, con opinión leve, sin relleno. Frases cortas,
palabras llanas, cifras."

La descripción es una restricción, no un adorno. Cada frase del borrador se
contrasta contra ella.

### Few-shot

Reunir de 3 a 5 muestras reales de la escritura del autor en el mismo
género que la tarea. Una muestra moldea el estilo mejor que cualquier
descripción.

Cómo usar las muestras:

1. Leerlas una vez y anotar rasgos recurrentes: longitud de frase,
   aperturas, hábitos de puntuación, dónde aparecen las opiniones, grado
   de formalidad.
2. Imitar esos rasgos en el borrador. Copiar el ritmo, no el contenido.
3. Si el autor no tiene muestras, escribir solo contra la descripción de
   voz.

Patrón de prompt: "Aquí van 3 muestras de la escritura del autor. Iguala
su ritmo, su registro de vocabulario y su tono. No copies el contenido."
