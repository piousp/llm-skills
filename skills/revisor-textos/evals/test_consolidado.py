#!/usr/bin/env python3
"""Tests for _normalizar_linea() in state.py.

Predicted RED with OLD state.py:
- _normalizar_linea does not exist yet → ImportError at module load time.
"""
import io
import json
import shutil
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

# Add parent directory to path so we can import state.py
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from state import (
    _normalizar_linea,
    _parse_hallazgos_md,
    _construir_consolidado,
    _agrupar_hallazgos,
    _severidad_maxima,
    cmd_consolidate,
    cmd_group,
    _session_dir,
    _seleccion_path,
    _hallazgos_path,
    _consolidado_path,
    _consolidado_json_path,
    _agrupados_path,
)


class TestNormalizarLinea(unittest.TestCase):
    """Test _normalizar_linea() with linea_field and ubicacion fallback."""

    def test_single_integer(self):
        """'23' → ('23', 'campo')."""
        self.assertEqual(_normalizar_linea("23", None), ("23", "campo"))

    def test_single_integer_with_surrounding_spaces(self):
        """' 23 ' → ('23', 'campo')."""
        self.assertEqual(_normalizar_linea(" 23 ", None), ("23", "campo"))

    def test_range_distinct_bounds(self):
        """'22-25' → ('22-25', 'campo')."""
        self.assertEqual(_normalizar_linea("22-25", None), ("22-25", "campo"))

    def test_range_collapsed_when_equal(self):
        """'23-23' → ('23', 'campo') (collapsed range)."""
        self.assertEqual(_normalizar_linea("23-23", None), ("23", "campo"))

    def test_desconocida_lowercase(self):
        """'desconocida' → (None, 'ninguna')."""
        self.assertEqual(_normalizar_linea("desconocida", None), (None, "ninguna"))

    def test_desconocida_uppercase(self):
        """'DESCONOCIDA' → (None, 'ninguna') (case-insensitive)."""
        self.assertEqual(_normalizar_linea("DESCONOCIDA", None), (None, "ninguna"))

    def test_both_none(self):
        """(None, None) args → (None, 'ninguna')."""
        self.assertEqual(_normalizar_linea(None, None), (None, "ninguna"))

    def test_ubicacion_fallback_with_accent(self):
        """ubicacion 'Sección Metodología, línea 14' → ('14', 'ubicacion')."""
        self.assertEqual(
            _normalizar_linea(None, "Sección Metodología, línea 14"),
            ("14", "ubicacion"),
        )

    def test_ubicacion_fallback_without_accent(self):
        """ubicacion 'linea 14' (no accent) → ('14', 'ubicacion')."""
        self.assertEqual(_normalizar_linea(None, "linea 14"), ("14", "ubicacion"))

    def test_ubicacion_fallback_range(self):
        """ubicacion 'Líneas 10-12, ver anexo' → ('10-12', 'ubicacion')."""
        self.assertEqual(
            _normalizar_linea(None, "Líneas 10-12, ver anexo"),
            ("10-12", "ubicacion"),
        )

    def test_ubicacion_no_number_at_all(self):
        """ubicacion with no number → (None, 'ninguna')."""
        self.assertEqual(
            _normalizar_linea(None, "Sección Metodología, sin numero"),
            (None, "ninguna"),
        )

    def test_unrecognizable_linea_field_falls_back_to_ubicacion(self):
        """linea_field='abc' (unrecognizable) falls back to ubicacion → ('14', 'ubicacion')."""
        self.assertEqual(
            _normalizar_linea("abc", "revisar línea 14 del texto"),
            ("14", "ubicacion"),
        )

    def test_linea_field_loose_trailing_noise(self):
        """'12 (aprox.)' → ('12', 'campo') (loose extraction, still from campo)."""
        self.assertEqual(_normalizar_linea("12 (aprox.)", None), ("12", "campo"))

    def test_linea_field_loose_leading_noise(self):
        """'~12' → ('12', 'campo') (loose extraction, still from campo)."""
        self.assertEqual(_normalizar_linea("~12", None), ("12", "campo"))

    def test_linea_field_loose_comma_separated_first_wins(self):
        """'12, 15' (not a range) → ('12', 'campo'); first number wins, KISS."""
        self.assertEqual(_normalizar_linea("12, 15", None), ("12", "campo"))

    def test_linea_field_loose_with_linea_prefix_in_field_itself(self):
        """'línea 12' typed directly in the Línea field → ('12', 'campo'), not ubicacion."""
        self.assertEqual(_normalizar_linea("línea 12", None), ("12", "campo"))

    def test_ubicacion_bare_number_without_linea_word_does_not_match(self):
        """ubicacion 'Referencias, página 12' (no 'línea'/'líneas' word) →
        (None, 'ninguna'); a bare number elsewhere in free prose must never be
        mistaken for a line reference (regression test for the ubicacion
        fallback's required prefix)."""
        self.assertEqual(
            _normalizar_linea(None, "Referencias, página 12"),
            (None, "ninguna"),
        )


class TestParseHallazgosMd(unittest.TestCase):
    """Test _parse_hallazgos_md() against the required cases of Bucket 1 /
    Seam 1.2. One subTest per case (table-driven)."""

    def test_well_formed_two_findings_all_fields(self):
        texto = (
            "## Hallazgo: Uso incorrecto de comas\n\n"
            "**Severidad:** alta\n\n"
            "**Línea:** 12\n\n"
            "**Ubicación:** Párrafo 2, línea 12\n\n"
            "**Problema:** Falta una coma antes de la conjunción.\n\n"
            "**Corrección sugerida:** Agregar coma antes de 'pero'.\n\n"
            "## Hallazgo: Repetición de palabra\n\n"
            "**Severidad:** media\n\n"
            "**Línea:** 20\n\n"
            "**Ubicación:** Párrafo 3\n\n"
            "**Problema:** La palabra 'proceso' se repite.\n\n"
            "**Corrección sugerida:** Usar un sinónimo.\n"
        )
        hallazgos, avisos = _parse_hallazgos_md(texto, "filologica")
        with self.subTest("no warnings"):
            self.assertEqual(avisos, [])
        with self.subTest("count"):
            self.assertEqual(len(hallazgos), 2)
        with self.subTest("first finding"):
            self.assertEqual(hallazgos[0], {
                "id": "filologica-001",
                "evaluador": "filologica",
                "titulo": "Uso incorrecto de comas",
                "severidad": "alta",
                "linea": "12",
                "linea_origen": "campo",
                "ubicacion": "Párrafo 2, línea 12",
                "problema": "Falta una coma antes de la conjunción.",
                "correccion_sugerida": "Agregar coma antes de 'pero'.",
            })
        with self.subTest("second finding"):
            self.assertEqual(hallazgos[1], {
                "id": "filologica-002",
                "evaluador": "filologica",
                "titulo": "Repetición de palabra",
                "severidad": "media",
                "linea": "20",
                "linea_origen": "campo",
                "ubicacion": "Párrafo 3",
                "problema": "La palabra 'proceso' se repite.",
                "correccion_sugerida": "Usar un sinónimo.",
            })

    def test_linea_desconocida_no_aviso_no_reconocible(self):
        """'Línea: desconocida' (any case) is a documented sentinel for
        document-wide findings; must NOT trigger the 'no reconocible' aviso
        (regression test for _parse_hallazgos_md's aviso-generation bug —
        _normalizar_linea itself already handles this sentinel correctly)."""
        for etiqueta_valor in ("desconocida", "DESCONOCIDA"):
            with self.subTest(valor=etiqueta_valor):
                texto = (
                    "## Hallazgo: Hallazgo global\n\n"
                    "**Severidad:** baja\n\n"
                    f"**Línea:** {etiqueta_valor}\n\n"
                    "**Ubicación:** Todo el documento\n\n"
                    "**Problema:** Inconsistencia de estilo en todo el texto.\n\n"
                    "**Corrección sugerida:** Unificar el estilo.\n"
                )
                hallazgos, avisos = _parse_hallazgos_md(texto, "apa")
                self.assertEqual(hallazgos[0]["linea"], None)
                self.assertEqual(hallazgos[0]["linea_origen"], "ninguna")
                self.assertFalse(
                    any("no reconocible" in aviso for aviso in avisos),
                    msg=f"unexpected 'no reconocible' aviso for valor={etiqueta_valor!r}: {avisos}",
                )

    def test_missing_linea_derived_from_ubicacion(self):
        texto = (
            "## Hallazgo: Falta cita\n\n"
            "**Severidad:** baja\n\n"
            "**Ubicación:** Sección Metodología, línea 14\n\n"
            "**Problema:** Falta cita bibliográfica.\n\n"
            "**Corrección sugerida:** Añadir cita.\n"
        )
        hallazgos, avisos = _parse_hallazgos_md(texto, "apa")
        with self.subTest("linea derived"):
            self.assertEqual(hallazgos[0]["linea"], "14")
            self.assertEqual(hallazgos[0]["linea_origen"], "ubicacion")
        with self.subTest("exactly two warnings, no duplicate no-reconocible"):
            self.assertEqual(avisos, [
                "apa-001: campo Línea ausente",
                "apa-001: campo Línea ausente; línea derivada de Ubicación por regex",
            ])

    def test_ubicacion_without_accent_parses_like_with_accent(self):
        def bloque(etiqueta_ubicacion: str) -> str:
            return (
                "## Hallazgo: Cita faltante\n\n"
                "**Severidad:** media\n\n"
                "**Línea:** 7\n\n"
                f"**{etiqueta_ubicacion}:** Párrafo 1\n\n"
                "**Problema:** Descripcion.\n\n"
                "**Corrección sugerida:** Corregir.\n"
            )
        con_tilde, _ = _parse_hallazgos_md(bloque("Ubicación"), "x")
        sin_tilde, _ = _parse_hallazgos_md(bloque("Ubicacion"), "x")
        self.assertEqual(con_tilde, sin_tilde)

    def test_problema_multiline_preserved_verbatim(self):
        texto = (
            "## Hallazgo: Parrafo largo\n\n"
            "**Severidad:** informativa\n\n"
            "**Línea:** 5\n\n"
            "**Ubicación:** Introducción\n\n"
            "**Problema:** Primer párrafo del problema.\n\n"
            "Segundo párrafo con más detalle.\n\n"
            "**Corrección sugerida:** Reescribir la sección.\n"
        )
        hallazgos, _ = _parse_hallazgos_md(texto, "heuristica")
        self.assertEqual(
            hallazgos[0]["problema"],
            "Primer párrafo del problema.\n\nSegundo párrafo con más detalle.",
        )

    def test_severidad_no_canonica_preservada_con_aviso(self):
        texto = (
            "## Hallazgo: Severidad rara\n\n"
            "**Severidad:** CRÍTICA\n\n"
            "**Línea:** 8\n\n"
            "**Ubicación:** Parrafo 1\n\n"
            "**Problema:** Problema de prueba.\n\n"
            "**Corrección sugerida:** Corregir prueba.\n"
        )
        hallazgos, avisos = _parse_hallazgos_md(texto, "apa")
        with self.subTest("lowercased, accent preserved"):
            self.assertEqual(hallazgos[0]["severidad"], "crítica")
        with self.subTest("single warning"):
            self.assertEqual(avisos, ["apa-001: severidad 'crítica' no reconocida"])

    def test_no_se_encontraron_hallazgos_case_insensitive(self):
        for variante in (
            "No se encontraron hallazgos.",
            "NO SE ENCONTRARON HALLAZGOS.",
            "  no se encontraron hallazgos.  ",
        ):
            with self.subTest(variante=variante):
                self.assertEqual(_parse_hallazgos_md(variante, "apa"), ([], []))

    def test_empty_string_no_parseable(self):
        self.assertEqual(
            _parse_hallazgos_md("", "apa"),
            ([], ["apa: contenido sin bloques '## Hallazgo:' parseables"]),
        )

    def test_free_prose_no_blocks(self):
        texto = "Este es un texto libre sin ningun hallazgo estructurado.\n"
        self.assertEqual(
            _parse_hallazgos_md(texto, "apa"),
            ([], ["apa: contenido sin bloques '## Hallazgo:' parseables"]),
        )

    def test_consecutive_headers_no_blank_line(self):
        texto = (
            "## Hallazgo: Primero\n"
            "**Severidad:** alta\n"
            "**Línea:** 1\n"
            "**Ubicación:** p1\n"
            "**Problema:** p\n"
            "**Corrección sugerida:** c\n"
            "## Hallazgo: Segundo\n"
            "**Severidad:** media\n"
            "**Línea:** 2\n"
            "**Ubicación:** p2\n"
            "**Problema:** p2\n"
            "**Corrección sugerida:** c2\n"
        )
        hallazgos, avisos = _parse_hallazgos_md(texto, "filologica")
        with self.subTest("no warnings"):
            self.assertEqual(avisos, [])
        with self.subTest("two findings, correct boundaries"):
            self.assertEqual(len(hallazgos), 2)
            self.assertEqual(hallazgos[0]["titulo"], "Primero")
            self.assertEqual(hallazgos[0]["problema"], "p")
            self.assertEqual(hallazgos[1]["titulo"], "Segundo")
            self.assertEqual(hallazgos[1]["problema"], "p2")


class TestConstruirConsolidado(unittest.TestCase):
    """Test _construir_consolidado() against the required cases of Bucket 1 /
    Seam 1.3.

    Fixture: 3 evaluators — 'apa' (ok, 2 findings: one missing 'Ubicación'
    with an unrecognized severity to trigger 'campo ausente' and 'severidad
    no reconocida' warnings; one well-formed), 'filologica' (sin_hallazgos,
    sentinel content), 'heuristica' (no_parseable, free prose).
    """

    def _fixture(self):
        evaluadores = ["apa", "filologica", "heuristica"]
        contenidos = {
            "apa": (
                "## Hallazgo: Titulo uno\n\n"
                "**Severidad:** rara\n\n"
                "**Línea:** 5\n\n"
                "**Problema:** Problema uno.\n\n"
                "**Corrección sugerida:** Corregir uno.\n\n"
                "## Hallazgo: Titulo dos\n\n"
                "**Severidad:** alta\n\n"
                "**Línea:** 10\n\n"
                "**Ubicación:** Párrafo 2\n\n"
                "**Problema:** Problema dos.\n\n"
                "**Corrección sugerida:** Corregir dos.\n"
            ),
            "filologica": "No se encontraron hallazgos.",
            "heuristica": "Este es un texto libre sin hallazgos estructurados.\n",
        }
        return evaluadores, contenidos

    def test_mixed_estados_and_totals(self):
        """1 ok (2 findings) + 1 sin_hallazgos + 1 no_parseable → total 2,
        'aportaron: 1 de 3', deterministic ids apa-001/apa-002."""
        evaluadores, contenidos = self._fixture()
        consolidado_json, consolidado_md = _construir_consolidado(
            evaluadores, contenidos, "sess-1", "2026-07-29T00:00:00"
        )
        with self.subTest("total_hallazgos"):
            self.assertEqual(consolidado_json["total_hallazgos"], 2)
        with self.subTest("aportaron en md"):
            self.assertIn("Evaluadores que aportaron: 1 de 3", consolidado_md)
        with self.subTest("ids deterministas"):
            self.assertEqual(consolidado_json["hallazgos"][0]["id"], "apa-001")
            self.assertEqual(consolidado_json["hallazgos"][1]["id"], "apa-002")
        with self.subTest("resumen por evaluador"):
            self.assertEqual(consolidado_json["evaluadores"], [
                {"id": "apa", "hallazgos": 2, "estado": "ok"},
                {"id": "filologica", "hallazgos": 0, "estado": "sin_hallazgos"},
                {"id": "heuristica", "hallazgos": 0, "estado": "no_parseable"},
            ])
        with self.subTest("json header fields verbatim"):
            self.assertEqual(consolidado_json["session_id"], "sess-1")
            self.assertEqual(consolidado_json["generated_at"], "2026-07-29T00:00:00")

    def test_md_contains_no_parseable_content_verbatim(self):
        """Nothing gets lost: the no_parseable evaluator's raw content
        appears verbatim in the .md output."""
        evaluadores, contenidos = self._fixture()
        _, consolidado_md = _construir_consolidado(
            evaluadores, contenidos, "sess-1", "2026-07-29T00:00:00"
        )
        self.assertIn(contenidos["heuristica"], consolidado_md)

    def test_avisos_include_all_three_kinds(self):
        """avisos includes at least one 'campo ausente', one 'severidad ...
        no reconocida' and one no_parseable warning."""
        evaluadores, contenidos = self._fixture()
        consolidado_json, _ = _construir_consolidado(
            evaluadores, contenidos, "sess-1", "2026-07-29T00:00:00"
        )
        avisos = consolidado_json["avisos"]
        with self.subTest("campo ausente"):
            self.assertTrue(any("campo Ubicación ausente" in a for a in avisos))
        with self.subTest("severidad no reconocida"):
            self.assertTrue(any("no reconocida" in a for a in avisos))
        with self.subTest("no_parseable"):
            self.assertIn(
                "heuristica: contenido sin bloques '## Hallazgo:' parseables", avisos
            )

    def test_zero_evaluators_with_findings(self):
        """All evaluators sin_hallazgos/no_parseable → empty hallazgos list,
        total 0, md still well-formed with every section present."""
        evaluadores = ["filologica", "heuristica"]
        contenidos = {
            "filologica": "No se encontraron hallazgos.",
            "heuristica": "Este es un texto libre sin hallazgos estructurados.\n",
        }
        consolidado_json, consolidado_md = _construir_consolidado(
            evaluadores, contenidos, "sess-2", "2026-07-29T00:00:00"
        )
        with self.subTest("hallazgos vacio"):
            self.assertEqual(consolidado_json["hallazgos"], [])
        with self.subTest("total 0"):
            self.assertEqual(consolidado_json["total_hallazgos"], 0)
        with self.subTest("header presente"):
            self.assertIn("# Hallazgos Consolidados", consolidado_md)
            self.assertIn("Evaluadores que aportaron: 0 de 2", consolidado_md)
        with self.subTest("ambas secciones presentes"):
            self.assertIn("## Evaluador: filologica", consolidado_md)
            self.assertIn("## Evaluador: heuristica", consolidado_md)

    def test_determinism(self):
        """Same inputs (same generated_at) → byte-identical .md and equal
        JSON dicts across two calls."""
        evaluadores, contenidos = self._fixture()
        json_1, md_1 = _construir_consolidado(
            evaluadores, contenidos, "sess-1", "2026-07-29T00:00:00"
        )
        json_2, md_2 = _construir_consolidado(
            evaluadores, contenidos, "sess-1", "2026-07-29T00:00:00"
        )
        self.assertEqual(md_1, md_2)
        self.assertEqual(json_1, json_2)

    def test_separator_between_sections_only(self):
        """'---' appears strictly between sections: count == len(evaluadores) - 1."""
        evaluadores, contenidos = self._fixture()
        _, consolidado_md = _construir_consolidado(
            evaluadores, contenidos, "sess-1", "2026-07-29T00:00:00"
        )
        separator_lines = [
            linea for linea in consolidado_md.splitlines() if linea.strip() == "---"
        ]
        self.assertEqual(len(separator_lines), len(evaluadores) - 1)


class TestAgruparHallazgos(unittest.TestCase):
    """Test _agrupar_hallazgos() against the required cases of Bucket 2 /
    Seam 2.1. Fixtures built directly (not via _construir_consolidado) to
    keep the seam isolated."""

    def _hallazgo(
        self, evaluador, linea, ubicacion="Parrafo 1", severidad="media",
        problema="Problema", correccion="Correccion", titulo="T",
        idx=1,
    ):
        return {
            "id": f"{evaluador}-{idx:03d}",
            "evaluador": evaluador,
            "titulo": titulo,
            "severidad": severidad,
            "linea": linea,
            "linea_origen": "campo" if linea is not None else "ninguna",
            "ubicacion": ubicacion,
            "problema": problema,
            "correccion_sugerida": correccion,
        }

    def _consolidado(self, hallazgos):
        return {
            "generated_at": "irrelevant",
            "session_id": "sess-1",
            "evaluadores": [],
            "total_hallazgos": len(hallazgos),
            "hallazgos": hallazgos,
            "avisos": [],
        }

    def test_same_linea_different_severidad_same_group_max_severidad(self):
        h1 = self._hallazgo("apa", "23", severidad="baja")
        h2 = self._hallazgo("filologica", "23", severidad="alta")
        consolidado = self._consolidado([h1, h2])
        resultado = _agrupar_hallazgos(consolidado, "2026-07-29T00:00:00")
        with self.subTest("un solo grupo"):
            self.assertEqual(resultado["total_grupos"], 1)
        with self.subTest("severidad maxima"):
            self.assertEqual(resultado["grupos"][0]["severidad_maxima"], "alta")
        with self.subTest("ambos hallazgos presentes"):
            self.assertEqual(resultado["grupos"][0]["hallazgos"], [h1, h2])

    def test_distinct_ranges_never_merge(self):
        h1 = self._hallazgo("apa", "23")
        h2 = self._hallazgo("filologica", "22-25")
        consolidado = self._consolidado([h1, h2])
        resultado = _agrupar_hallazgos(consolidado, "2026-07-29T00:00:00")
        self.assertEqual(resultado["total_grupos"], 2)
        claves = {g["clave"] for g in resultado["grupos"]}
        self.assertEqual(claves, {"linea:23", "linea:22-25"})

    def test_group_by_normalized_ubicacion_text(self):
        h1 = self._hallazgo("apa", None, ubicacion="Referencias")
        h2 = self._hallazgo("filologica", None, ubicacion="referencias  ")
        consolidado = self._consolidado([h1, h2])
        resultado = _agrupar_hallazgos(consolidado, "2026-07-29T00:00:00")
        self.assertEqual(resultado["total_grupos"], 1)
        self.assertEqual(resultado["grupos"][0]["clave"], "texto:referencias")
        self.assertEqual(len(resultado["grupos"][0]["hallazgos"]), 2)

    def test_exact_duplicate_same_evaluador_deduplicated(self):
        h1 = self._hallazgo(
            "apa", "23", problema="Problema  con  espacios",
            correccion="Corregir  esto", idx=1,
        )
        h2 = self._hallazgo(
            "apa", "23", problema="Problema con espacios",
            correccion="Corregir esto", idx=2,
        )
        consolidado = self._consolidado([h1, h2])
        resultado = _agrupar_hallazgos(consolidado, "2026-07-29T00:00:00")
        with self.subTest("un solo hallazgo conservado"):
            self.assertEqual(len(resultado["grupos"][0]["hallazgos"]), 1)
            self.assertEqual(resultado["grupos"][0]["hallazgos"][0], h1)
        with self.subTest("contador de duplicados"):
            self.assertEqual(resultado["duplicados_eliminados"], 1)
        with self.subTest("total_hallazgos refleja el dedup"):
            self.assertEqual(resultado["total_hallazgos"], 1)

    def test_same_text_different_evaluador_not_deduplicated(self):
        h1 = self._hallazgo("apa", "23", problema="Igual", correccion="Igual")
        h2 = self._hallazgo("filologica", "23", problema="Igual", correccion="Igual")
        consolidado = self._consolidado([h1, h2])
        resultado = _agrupar_hallazgos(consolidado, "2026-07-29T00:00:00")
        self.assertEqual(len(resultado["grupos"][0]["hallazgos"]), 2)
        self.assertEqual(resultado["duplicados_eliminados"], 0)

    def test_ordering_lines_ascending_then_text_last(self):
        h_10 = self._hallazgo("apa", "10")
        h_5 = self._hallazgo("apa", "5", idx=2)
        h_5_8 = self._hallazgo("apa", "5-8", idx=3)
        h_texto = self._hallazgo("apa", None, ubicacion="Conclusiones", idx=4)
        consolidado = self._consolidado([h_10, h_5, h_5_8, h_texto])
        resultado = _agrupar_hallazgos(consolidado, "2026-07-29T00:00:00")
        claves_en_orden = [g["clave"] for g in resultado["grupos"]]
        self.assertEqual(
            claves_en_orden,
            ["linea:5", "linea:5-8", "linea:10", "texto:conclusiones"],
        )

    def test_severidad_maxima_never_none_when_all_unranked(self):
        """Todas las severidades ausentes (None) -> _severidad_maxima nunca
        devuelve None (viola su anotacion -> str); cae a la severidad del
        primero en orden de aparicion (cadena vacia si tambien es None)."""
        h1 = self._hallazgo("apa", "23", severidad=None)
        h2 = self._hallazgo("filologica", "23", severidad=None, idx=2)
        with self.subTest("direct call"):
            self.assertEqual(_severidad_maxima([h1, h2]), "")
        consolidado = self._consolidado([h1, h2])
        resultado = _agrupar_hallazgos(consolidado, "2026-07-29T00:00:00")
        with self.subTest("via _agrupar_hallazgos"):
            self.assertEqual(resultado["grupos"][0]["severidad_maxima"], "")

    def test_empty_hallazgos_list(self):
        consolidado = self._consolidado([])
        resultado = _agrupar_hallazgos(consolidado, "2026-07-29T00:00:00")
        with self.subTest("grupos vacio"):
            self.assertEqual(resultado["grupos"], [])
        with self.subTest("total_grupos"):
            self.assertEqual(resultado["total_grupos"], 0)
        with self.subTest("total_hallazgos"):
            self.assertEqual(resultado["total_hallazgos"], 0)
        with self.subTest("duplicados_eliminados"):
            self.assertEqual(resultado["duplicados_eliminados"], 0)


class TestCmdConsolidateAndGroup(unittest.TestCase):
    """CLI tests for cmd_consolidate() and cmd_group() (Bucket 3, Seams 3.1/3.2).

    Direct-call style, matching the cmd_status direct-call tests in
    evals/test_state.py: _session_dir(session_id) resolves to a real path
    under tmp_root_dir(), so each test uses a unique session_id and cleans
    up its own directory in tearDown.
    """

    HALLAZGO_APA = (
        "## Hallazgo: Falta cita\n\n"
        "**Severidad:** alta\n\n"
        "**L\u00ednea:** 5\n\n"
        "**Ubicaci\u00f3n:** P\u00e1rrafo 1\n\n"
        "**Problema:** Falta cita bibliografica.\n\n"
        "**Correcci\u00f3n sugerida:** Anadir cita.\n"
    )

    def setUp(self):
        self._session_ids: list[str] = []

    def tearDown(self):
        for session_id in self._session_ids:
            sdir = _session_dir(session_id)
            if sdir.exists():
                shutil.rmtree(sdir)

    def _new_session(self, session_id: str, evaluadores: list[str]) -> Path:
        self._session_ids.append(session_id)
        sdir = _session_dir(session_id)
        sdir.mkdir(parents=True, exist_ok=True)
        seleccion = {
            "session_id": session_id,
            "original_path": "/tmp/test/original.md",
            "created_at": "2024-01-01T00:00:00",
            "evaluadores": [
                {"id": eid, "ruta": f"/tmp/test/evaluadores/{eid}.md"}
                for eid in evaluadores
            ],
        }
        _seleccion_path(sdir).write_text(
            json.dumps(seleccion, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        return sdir

    def _write_hallazgo(self, sdir: Path, eval_id: str, contenido: str) -> None:
        _hallazgos_path(sdir, eval_id).write_text(contenido, encoding="utf-8")

    # ── cmd_consolidate: error paths ────────────────────────────────────

    def test_cmd_consolidate_usage_error(self):
        f = io.StringIO()
        with redirect_stderr(f):
            with self.assertRaises(SystemExit) as ctx:
                cmd_consolidate([])
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("Uso: state.py consolidate", f.getvalue())

    def test_cmd_consolidate_session_not_found(self):
        f = io.StringIO()
        with redirect_stderr(f):
            with self.assertRaises(SystemExit) as ctx:
                cmd_consolidate(["sesion-inexistente-xyz"])
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("no encontrada", f.getvalue())

    def test_cmd_consolidate_corrupt_seleccion(self):
        session_id = "test-consolidate-corrupt"
        self._session_ids.append(session_id)
        sdir = _session_dir(session_id)
        sdir.mkdir(parents=True, exist_ok=True)
        _seleccion_path(sdir).write_text("not valid json", encoding="utf-8")

        f = io.StringIO()
        with redirect_stderr(f):
            with self.assertRaises(SystemExit) as ctx:
                cmd_consolidate([session_id])
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("seleccion.json corrupto o ausente", f.getvalue())

    def test_cmd_consolidate_missing_hallazgos_file(self):
        session_id = "test-consolidate-missing-hallazgos"
        sdir = self._new_session(session_id, ["apa", "filologica"])
        self._write_hallazgo(sdir, "apa", self.HALLAZGO_APA)
        # hallazgos-filologica.md is deliberately absent

        f = io.StringIO()
        with redirect_stderr(f):
            with self.assertRaises(SystemExit) as ctx:
                cmd_consolidate([session_id])
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("Falta hallazgos-filologica.md", f.getvalue())

    # ── cmd_consolidate: happy path ──────────────────────────────────────

    def test_cmd_consolidate_valid_session_writes_md_and_json(self):
        session_id = "test-consolidate-valid"
        sdir = self._new_session(session_id, ["apa", "filologica"])
        self._write_hallazgo(sdir, "apa", self.HALLAZGO_APA)
        self._write_hallazgo(sdir, "filologica", "No se encontraron hallazgos.")

        out = io.StringIO()
        with redirect_stdout(out):
            cmd_consolidate([session_id])

        md_path = _consolidado_path(sdir)
        json_path = _consolidado_json_path(sdir)
        with self.subTest("md exists"):
            self.assertTrue(md_path.exists())
        with self.subTest("json exists"):
            self.assertTrue(json_path.exists())

        consolidado = json.loads(json_path.read_text(encoding="utf-8"))
        with self.subTest("total_hallazgos"):
            self.assertEqual(consolidado["total_hallazgos"], 1)
        with self.subTest("session_id propagated"):
            self.assertEqual(consolidado["session_id"], session_id)

        with self.subTest("summary mentions evaluators and avisos"):
            summary = out.getvalue()
            self.assertIn("apa: ok", summary)
            self.assertIn("filologica: sin_hallazgos", summary)
            self.assertIn("Total hallazgos: 1", summary)

    def test_cmd_consolidate_idempotent_rerun(self):
        session_id = "test-consolidate-idempotent"
        sdir = self._new_session(session_id, ["apa", "filologica"])
        self._write_hallazgo(sdir, "apa", self.HALLAZGO_APA)
        self._write_hallazgo(sdir, "filologica", "No se encontraron hallazgos.")

        with redirect_stdout(io.StringIO()):
            cmd_consolidate([session_id])
        first = json.loads(_consolidado_json_path(sdir).read_text(encoding="utf-8"))

        with redirect_stdout(io.StringIO()):
            cmd_consolidate([session_id])
        second = json.loads(_consolidado_json_path(sdir).read_text(encoding="utf-8"))

        first.pop("generated_at")
        second.pop("generated_at")
        self.assertEqual(first, second)

    # ── cmd_group: error paths ──────────────────────────────────────────

    def test_cmd_group_usage_error(self):
        f = io.StringIO()
        with redirect_stderr(f):
            with self.assertRaises(SystemExit) as ctx:
                cmd_group([])
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("Uso: state.py group", f.getvalue())

    def test_cmd_group_session_not_found(self):
        f = io.StringIO()
        with redirect_stderr(f):
            with self.assertRaises(SystemExit) as ctx:
                cmd_group(["sesion-inexistente-xyz"])
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("no encontrada", f.getvalue())

    def test_cmd_group_missing_consolidado_json(self):
        session_id = "test-group-missing-consolidado"
        self._new_session(session_id, ["apa"])

        f = io.StringIO()
        with redirect_stderr(f):
            with self.assertRaises(SystemExit) as ctx:
                cmd_group([session_id])
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("ejecute consolidate primero", f.getvalue())

    def test_cmd_group_corrupt_consolidado_json(self):
        session_id = "test-group-corrupt-consolidado"
        sdir = self._new_session(session_id, ["apa"])
        _consolidado_json_path(sdir).write_text("not valid json", encoding="utf-8")

        f = io.StringIO()
        with redirect_stderr(f):
            with self.assertRaises(SystemExit) as ctx:
                cmd_group([session_id])
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("ejecute consolidate primero", f.getvalue())

    def test_cmd_group_consolidado_missing_hallazgos_key(self):
        """Valid JSON but missing the 'hallazgos' key -> clean ERROR + exit(1),
        not an unhandled KeyError."""
        session_id = "test-group-missing-hallazgos-key"
        sdir = self._new_session(session_id, ["apa"])
        _consolidado_json_path(sdir).write_text(
            json.dumps({
                "generated_at": "2024-01-01T00:00:00",
                "session_id": session_id,
            }),
            encoding="utf-8",
        )

        f = io.StringIO()
        with redirect_stderr(f):
            with self.assertRaises(SystemExit) as ctx:
                cmd_group([session_id])
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("ERROR:", f.getvalue())
        self.assertIn("falta la clave 'hallazgos'", f.getvalue())

    # ── cmd_group: happy path ────────────────────────────────────────────

    def test_cmd_group_valid_session_writes_agrupados_json(self):
        session_id = "test-group-valid"
        sdir = self._new_session(session_id, ["apa", "filologica"])
        self._write_hallazgo(sdir, "apa", self.HALLAZGO_APA)
        self._write_hallazgo(sdir, "filologica", "No se encontraron hallazgos.")
        with redirect_stdout(io.StringIO()):
            cmd_consolidate([session_id])

        out = io.StringIO()
        with redirect_stdout(out):
            cmd_group([session_id])

        agrupados_path = _agrupados_path(sdir)
        self.assertTrue(agrupados_path.exists())
        agrupados = json.loads(agrupados_path.read_text(encoding="utf-8"))
        with self.subTest("total_grupos"):
            self.assertEqual(agrupados["total_grupos"], 1)
        with self.subTest("total_hallazgos"):
            self.assertEqual(agrupados["total_hallazgos"], 1)
        with self.subTest("summary mentions severidad breakdown"):
            summary = out.getvalue()
            self.assertIn("Total grupos: 1", summary)
            self.assertIn("alta: 1", summary)

    def test_cmd_group_idempotent_rerun(self):
        session_id = "test-group-idempotent"
        sdir = self._new_session(session_id, ["apa", "filologica"])
        self._write_hallazgo(sdir, "apa", self.HALLAZGO_APA)
        self._write_hallazgo(sdir, "filologica", "No se encontraron hallazgos.")
        with redirect_stdout(io.StringIO()):
            cmd_consolidate([session_id])

        with redirect_stdout(io.StringIO()):
            cmd_group([session_id])
        first = json.loads(_agrupados_path(sdir).read_text(encoding="utf-8"))

        with redirect_stdout(io.StringIO()):
            cmd_group([session_id])
        second = json.loads(_agrupados_path(sdir).read_text(encoding="utf-8"))

        first.pop("generated_at")
        second.pop("generated_at")
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
