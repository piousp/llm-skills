---
name: exportar-tesis-docx
description: Inyecta metadatos académicos (autor, título, materia, categoría, palabras clave, idioma, identificador) en un DOCX de la tesis PADE-UCR. Usar para exportar la tesis a DOCX con metadatos visibles en Archivo > Propiedades de Word.
---

# Exportar tesis a DOCX con metadatos

## Requisitos

- `python-docx` instalado

## Procedimiento

1. Ejecutar el script desde el directorio del skill:

   ```bash
   python3 scripts/inject-metadata.py <archivo.docx>
   ```

   - Si el usuario no especificó una ruta, usar el DOCX más reciente
     del directorio de la tesis o preguntar.

2. El script modifica el DOCX in-place e informa qué archivos procesó.

## Metadatos que inyecta

| Propiedad DOCX | Valor |
|----------------|-------|
| author | Lidia Andrea Solórzano Hidalgo, Oscar Rodolfo Solórzano Hidalgo |
| title | Diagnóstico de procesos de gestión financiera y toma de decisiones gerenciales en la empresa de crédito "XYZ" |
| subject | TFIA - Maestría en Dirección y Administración de Empresas con énfasis en Finanzas - Universidad de Costa Rica |
| category | TFIA |
| language | es-CR |
| keywords | gestión financiera, toma de decisiones, diagnóstico de procesos, automatización, inteligencia de negocios, Power BI, TFIA, UCR |
| content_status | Borrador |
| identifier | TFIA-PADE-UCR-2024 |
| comments | Trabajo Final de Investigación Aplicada - PADE - Universidad de Costa Rica |

## Verificación

```text
1. script devuelve "OK <archivo>" → metadatos inyectados
2. Si el usuario lo pide, abrir el DOCX en Word y revisar
   Archivo > Propiedades
```
