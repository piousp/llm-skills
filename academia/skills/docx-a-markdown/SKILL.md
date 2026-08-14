---
name: docx-a-markdown
description: docx-a-markdown
---

# Conversión de DOCX a Markdown

## Requisitos

- `pandoc` instalado (conversión principal)
- `python-docx` (extracción de comentarios)
- `mammoth` (opcional, conversión alternativa)

## Procedimiento

1. El tool `docx_to_markdown` (registrado por la extensión en
   `~/.pi/agent/extensions/docx-a-markdown/index.ts`) realiza la conversión.

2. **Antes de llamar al tool, preguntar al usuario** si desea incluir los
   comentarios de Word en la salida Markdown.

3. Llamar al tool con los parámetros:

   | Parámetro | Requerido | Descripción |
   |-----------|-----------|-------------|
   | `path` | Sí | Ruta al archivo .docx (absoluta o relativa al cwd) |
   | `output` | No | Ruta del archivo .md de salida. Si se omite, imprime por stdout |
   | `include_comments` | No | Booleano. Incluir comentarios al final. Default: depende de la respuesta del usuario |
   | `mode` | No | Motor: `"pandoc"` (default), `"mammoth"`, o `"python-docx"` |

4. La salida incluye el Markdown convertido. Si hay comentarios y se
   solicitaron, se agregan al final del documento en una sección
   estructurada:

   ```markdown
   ---

   ## Comentarios del documento

   ### Comentario #0
   - **Autor:** Dr. Evaluador
   - **Fecha:** 2025-06-15T10:30:00
   - **Sobre el texto:** "texto anotado"

   Contenido del comentario.
   ```

## Skill complementario

Para la operación inversa (Markdown → DOCX con inyección de metadatos
académicos), usar el skill `exportar-tesis-docx`.

## Verificación

```text
1. tool devuelve contenido o ruta del archivo → conversión exitosa
2. Si se incluyeron comentarios, verificar que aparecen al final del Markdown
3. Si se especificó output, verificar que el archivo .md existe y es legible
```