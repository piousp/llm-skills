#!/usr/bin/env python3
"""
Inyecta metadatos académicos en archivos DOCX de la tesis PADE-UCR.

Uso:
    python3 inject-metadata.py [archivo.docx ...]

Si no se especifican archivos, procesa todos los .docx del directorio actual.
"""

import sys
from pathlib import Path

from docx import Document

AUTHOR = "Lidia Andrea Solórzano Hidalgo, Oscar Rodolfo Solórzano Hidalgo"
TITLE = (
    'Diagnóstico de procesos de gestión financiera y toma de decisiones '
    'gerenciales en la empresa de crédito "XYZ"'
)
SUBJECT = (
    "TFIA - Maestría en Dirección y Administración de Empresas "
    "con énfasis en Finanzas - Universidad de Costa Rica"
)
CATEGORY = "TFIA"
LANGUAGE = "es-CR"
KEYWORDS = (
    "gestión financiera, toma de decisiones, diagnóstico de procesos, "
    "automatización, inteligencia de negocios, Power BI, TFIA, UCR"
)
CONTENT_STATUS = "Borrador"
IDENTIFIER = "TFIA-PADE-UCR-2024"
COMMENTS = "Trabajo Final de Investigación Aplicada - PADE - Universidad de Costa Rica"


def inject_metadata(path: Path) -> None:
    """Injecta metadatos en un archivo DOCX in-place."""
    doc = Document(str(path))
    props = doc.core_properties

    props.author = AUTHOR
    props.title = TITLE
    props.subject = SUBJECT
    props.category = CATEGORY
    props.language = LANGUAGE
    props.keywords = KEYWORDS
    props.content_status = CONTENT_STATUS
    props.identifier = IDENTIFIER
    props.comments = COMMENTS

    doc.save(str(path))
    print(f"  OK  {path.name}")


def main() -> None:
    args = sys.argv[1:]

    if args:
        paths = [Path(a) for a in args]
    else:
        paths = list(Path.cwd().glob("*.docx"))

    if not paths:
        print("No se encontraron archivos .docx.")
        sys.exit(0)

    for p in paths:
        if not p.exists():
            print(f"  NO  {p.name} (no existe)")
            continue
        try:
            inject_metadata(p)
        except Exception as e:
            print(f"  ERR {p.name}: {e}")

    print("Hecho.")


if __name__ == "__main__":
    main()