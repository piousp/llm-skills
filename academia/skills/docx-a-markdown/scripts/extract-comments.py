#!/usr/bin/env python3
"""Extrae comentarios de un archivo DOCX como JSON.

Salida: lista de objetos con id, author, date, text, annotated_text.

Uso: extract-comments.py <ruta-al-docx>
"""

import json
import sys
import zipfile
from dataclasses import dataclass, asdict
from typing import Optional
from xml.etree import ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


@dataclass
class Comment:
    id: int
    author: str
    date: Optional[str]
    text: str
    annotated_text: Optional[str]


def _get_text(element: ET.Element) -> str:
    """Extrae el texto completo de un elemento XML (p. ej. w:p)."""
    return "".join(
        t.text or ""
        for t in element.iter(f"{{{W_NS}}}t")
    )


def _extract_comment_ranges(body: ET.Element) -> dict[int, list[str]]:
    """Construye un mapa comment_id → [texto anotado] desde w:commentRangeStart/End en el body."""
    ranges: dict[int, list[str]] = {}
    current_id: Optional[int] = None
    texts: list[str] = []

    for child in body.iter():
        tag = child.tag

        if tag == f"{{{W_NS}}}commentRangeStart":
            cid_str = child.get(f"{{{W_NS}}}id")
            if cid_str is None:
                continue
            _flush_range(ranges, current_id, texts)
            current_id = int(cid_str)
            texts = []

        elif tag == f"{{{W_NS}}}commentRangeEnd":
            cid_str = child.get(f"{{{W_NS}}}id")
            if cid_str is not None and current_id is not None and int(cid_str) == current_id:
                _flush_range(ranges, current_id, texts)
                current_id = None
                texts = []

        elif tag == f"{{{W_NS}}}r" and current_id is not None:
            for t_elem in child.findall(f"{{{W_NS}}}t"):
                if t_elem.text:
                    texts.append(t_elem.text)

    return ranges


def _flush_range(ranges: dict[int, list[str]], cid: Optional[int], texts: list[str]) -> None:
    """Finaliza el rango de comentario actual, si existe."""
    if cid is not None:
        joined = "".join(texts).strip()
        if joined:
            ranges.setdefault(cid, []).append(joined)


def _parse_comment_xml(comment: ET.Element) -> Comment:
    """Convierte un elemento XML w:comment en un Comment."""
    cid_str = comment.get(f"{{{W_NS}}}id")
    return Comment(
        id=int(cid_str) if cid_str else 0,
        author=comment.get(f"{{{W_NS}}}author", "Desconocido"),
        date=comment.get(f"{{{W_NS}}}date"),
        text=_get_text(comment),
        annotated_text=None,
    )


def _set_annotated_text(
    comments: list[Comment], ranges: dict[int, list[str]]
) -> None:
    """Asigna el texto anotado a cada comentario según su id."""
    for c in comments:
        annotated_list = ranges.get(c.id, [])
        joined = " ".join(annotated_list).strip() if annotated_list else None
        c.annotated_text = joined or None


def extract_comments(docx_path: str) -> list[dict]:
    """Abre un DOCX y devuelve sus comentarios como lista de dicts."""
    try:
        with zipfile.ZipFile(docx_path, "r") as z:
            if "word/comments.xml" not in z.namelist():
                return []

            comments_tree = ET.parse(z.open("word/comments.xml"))
            doc_tree = ET.parse(z.open("word/document.xml"))
    except FileNotFoundError:
        _fail(f"File not found: {docx_path}")
    except zipfile.BadZipFile:
        _fail(f"Not a valid ZIP/DOCX file: {docx_path}")

    body = doc_tree.find(f".//{{{W_NS}}}body")
    if body is None:
        return []

    ranges = _extract_comment_ranges(body)
    raw_comments = [
        _parse_comment_xml(el)
        for el in comments_tree.getroot().findall(f"{{{W_NS}}}comment")
    ]
    _set_annotated_text(raw_comments, ranges)

    return [asdict(c) for c in raw_comments]


def _fail(msg: str) -> None:
    print(json.dumps({"error": msg}))
    sys.exit(1)


def main() -> None:
    if len(sys.argv) < 2:
        _fail("Usage: extract-comments.py <path-to-docx>")
    comments = extract_comments(sys.argv[1])
    print(json.dumps(comments, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()