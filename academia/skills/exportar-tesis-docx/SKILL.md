---
name: exportar-tesis-docx
description: exportar-tesis-docx
---

# Exportar tesis a DOCX con metadatos

## Procedimiento

1. Llamar al tool `injectar_metadatos_tesis` con el parámetro `path`
   apuntando al archivo DOCX.
   - Si el usuario no especificó una ruta, usar el DOCX más reciente
     del directorio de la tesis o preguntar.
2. El tool ejecuta el script Python y devuelve el resultado.
3. Informar al usuario qué metadatos se inyectaron y en qué archivo.

## Metadatos que inyecta

| Propiedad DOCX | Valor |
|----------------|-------|
| author | Lidia Andrea Solórzano Hidalgo, Oscar Rodolfo Solórzano Hidalgo |
| title | Diagnóstico de procesos de análisis financiero y toma de decisiones gerenciales en una empresa de Crédito "XYZ" |
| subject | TFIA - Maestría en Dirección y Administración de Empresas con énfasis en Finanzas - Universidad de Costa Rica |
| category | TFIA |
| language | es-CR |
| keywords | gestión financiera, toma de decisiones, diagnóstico de procesos, automatización, inteligencia de negocios, Power BI, TFIA, UCR |
| content_status | Borrador |
| identifier | TFIA-PADE-UCR-2024 |
| comments | Trabajo Final de Investigación Aplicada - PADE - Universidad de Costa Rica |

## Verificación

```text
1. tool devuelve "OK <archivo>" → metadatos inyectados
2. Si el usuario lo pide, abrir el DOCX en Word y revisar
   Archivo > Propiedades
```