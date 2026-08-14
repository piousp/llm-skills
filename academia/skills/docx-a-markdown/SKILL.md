---
name: docx-a-markdown
description: Convierte archivos DOCX a Markdown usando pandoc, mammoth o python-docx, con extracción opcional de comentarios de Word. Usar cuando se pida convertir un DOCX a Markdown o extraer comentarios de un documento de Word.
---

# Conversión de DOCX a Markdown

## Requisitos

- `pandoc` instalado (conversión principal)
- `python-docx` (extracción de comentarios)
- `mammoth` (opcional, conversión alternativa)

## Procedimiento

1. **Antes de convertir, preguntar al usuario** si desea incluir los
   comentarios de Word en la salida Markdown.

2. Ejecutar el script desde el directorio del skill:

   ```bash
   python3 scripts/docx-to-markdown.py <archivo.docx> [--output salida.md] [--mode pandoc|mammoth|python-docx] [--no-comments]
   ```

   | Parámetro | Requerido | Descripción |
   |-----------|-----------|-------------|
   | `path` | Sí | Ruta al archivo .docx |
   | `--output` | No | Ruta del .md de salida. Si se omite, imprime por stdout |
   | `--mode` | No | Motor: `pandoc` (default), `mammoth` o `python-docx` |
   | `--no-comments` | No | Omite la extracción de comentarios (default: incluirlos) |

3. Si se incluyen comentarios, aparecen al final del Markdown en una
   sección estructurada:

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
1. script devuelve contenido o ruta del archivo → conversión exitosa
2. Si se incluyeron comentarios, verificar que aparecen al final del Markdown
3. Si se especificó --output, verificar que el archivo .md existe y es legible
```
