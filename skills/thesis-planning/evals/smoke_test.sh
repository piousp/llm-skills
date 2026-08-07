#!/usr/bin/env bash
# Smoke test E2E para skills/thesis-planning.
# Simula un $THESIS_DIR en cada fase y verifica que scripts/state.py y
# scripts/validate_sources.py respondan con el JSON esperado y los exit codes
# correctos. Read-only sobre el repo (todo ocurre en mktemp).
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
state_run() { python3 "$REPO/scripts/state.py" "$@"; }
validate_run() { python3 "$REPO/scripts/validate_sources.py" "$@"; }
PASS=0; FAIL=0

check() { # check <label> <expected_exit> <actual_exit> <json_file>
  local label="$1" want="$2" got="$3" f="$4"
  if [ "$want" != "$got" ]; then
    FAIL=$((FAIL+1)); echo "FAIL [$label] exit=$got esperado=$want"
    cat "$f"; return
  fi
  python3 -c "import json,sys; json.load(open('$f'))" 2>/dev/null || {
    FAIL=$((FAIL+1)); echo "FAIL [$label] stdout no es JSON válido"; cat "$f"; return; }
  PASS=$((PASS+1)); echo "PASS [$label]"
}

# ---------- Escenario 1: fases tempranas ----------
D=$(mktemp -d)
mkdir -p "$D/chapters/history"
echo "# Sources" > "$D/sources-initial.md"

state_run --dir "$D" > /tmp/smoke1.json 2>/dev/null; check "fase1 sin question" 0 $? /tmp/smoke1.json
grep -q '"phase": 1' /tmp/smoke1.json && PASS=$((PASS+1)) && echo "PASS [fase1 reporta phase=1]" || { FAIL=$((FAIL+1)); echo "FAIL [fase1 phase]"; }

echo "# Question" > "$D/research-question.md"
state_run --dir "$D" > /tmp/smoke2.json 2>/dev/null; check "fase2 sin litmap" 0 $? /tmp/smoke2.json
grep -q '"phase": 2' /tmp/smoke2.json && PASS=$((PASS+1)) && echo "PASS [fase2 reporta phase=2]" || { FAIL=$((FAIL+1)); echo "FAIL [fase2 phase]"; }

echo "# Litmap" > "$D/literature-map.md"
state_run --dir "$D" > /tmp/smoke3.json 2>/dev/null; check "fase3 sin outline" 0 $? /tmp/smoke3.json
grep -q '"phase": 3' /tmp/smoke3.json && PASS=$((PASS+1)) && echo "PASS [fase3 reporta phase=3]" || { FAIL=$((FAIL+1)); echo "FAIL [fase3 phase]"; }

# ---------- Escenario 2: fase 4 con inconsistencias + feedback ----------
cat > "$D/outline.md" <<'EOF'
# Tesis

1. Introduccion: status=pending
2. Marco teorico: status=drafted
3. Metodologia: status=pending
4. Resultados: status=revised
EOF
# cap1 pending con archivo + feedback abierto (aparece en remaining, se
# verifica open_feedback); cap2 drafted SIN archivo (inconsistente);
# cap4 revised sin snapshot ni feedback (inconsistente)
# NOTA: nombres ASCII por contrato (S8/H12) — la slugificación es best-effort
# y no translitera acentos.
echo "# Intro" > "$D/chapters/introduccion.md"
# feedback con rejected sin Resolution -> warning a stderr (no rompe exit 0)
cat > "$D/chapters/introduccion.feedback.md" <<'EOF'
## 2026-08-01 | Prof. X | v01 | open
Scope: general
Comment: revisar sección 2

## 2026-08-02 | Prof. X | v02 | rejected
Scope: seccion-3
Comment: afirmación sin fuente
Resolution: 
EOF

state_run --dir "$D" > /tmp/smoke4.json 2>/tmp/smoke4.err; check "fase4 con inconsist" 0 $? /tmp/smoke4.json
grep -q '"phase": 4' /tmp/smoke4.json && PASS=$((PASS+1)) && echo "PASS [fase4 reporta phase=4]" || { FAIL=$((FAIL+1)); echo "FAIL [fase4 phase]"; }
grep -q "inconsistent_chapters" /tmp/smoke4.json && grep -q "Marco teorico" /tmp/smoke4.json && PASS=$((PASS+1)) && echo "PASS [drafted sin archivo = inconsistente]" || { FAIL=$((FAIL+1)); echo "FAIL [inconsistent detectado]"; }
grep -q "Resultados" /tmp/smoke4.json && PASS=$((PASS+1)) && echo "PASS [revised sin snapshot = inconsistente]" || { FAIL=$((FAIL+1)); echo "FAIL [revised inconsistente]"; }
grep -q "lacks a non-empty Resolution" /tmp/smoke4.err && PASS=$((PASS+1)) && echo "PASS [warning rejected sin Resolution]" || { FAIL=$((FAIL+1)); echo "FAIL [warning resolution no emitido]"; }
grep -q '"open_feedback": 1' /tmp/smoke4.json && PASS=$((PASS+1)) && echo "PASS [open feedback contado]" || { FAIL=$((FAIL+1)); echo "FAIL [open_feedback]"; }

# ---------- Escenario 3: fase 5 (todo listo) ----------
# Reescribir outline: todos drafted/revised + archivos para todos + snapshot
cat > "$D/outline.md" <<'EOF'
# Tesis

1. Introduccion: status=drafted
2. Marco teorico: status=drafted
3. Metodologia: status=drafted
4. Resultados: status=revised
EOF
echo "# Marco" > "$D/chapters/marco-teorico.md"
echo "# Metodologia" > "$D/chapters/metodologia.md"
echo "# Resultados" > "$D/chapters/resultados.md"
cp "$D/chapters/resultados.md" "$D/chapters/history/resultados.v01.md"
# cerrar el feedback open de introduccion
cat > "$D/chapters/introduccion.feedback.md" <<'EOF'
## 2026-08-02 | Prof. X | v02 | addressed
Scope: seccion-3
Comment: afirmación sin fuente
Resolution: agregada cita de Fuentes (2024)
EOF
state_run --dir "$D" > /tmp/smoke5.json 2>/tmp/smoke5.err; check "fase5 completo" 0 $? /tmp/smoke5.json
grep -q '"phase": 5' /tmp/smoke5.json && PASS=$((PASS+1)) && echo "PASS [fase5 reporta phase=5]" || { FAIL=$((FAIL+1)); echo "FAIL [fase5 phase]"; }
[ ! -s /tmp/smoke5.err ] && PASS=$((PASS+1)) && echo "PASS [sin warnings con feedback cerrado]" || { FAIL=$((FAIL+1)); echo "FAIL [warning inesperado en fase5]"; cat /tmp/smoke5.err; }

# ---------- Escenario 4: validate_sources ----------
# 4a: lote bueno (1 verified, 1 quarantine)
cat > /tmp/smoke-records.json <<'EOF'
[
  {"url":"https://example.org/a","doi":"10.1/a","title":"Paper A","authors":["A. Uno"],
   "year":2020,"venue":"Rev A","abstract":"abs","abstract_source":"verbatim",
   "keywords":["k1"],"relevance":"high","relevance_reason":"directamente relevante",
   "verified_by_read":true},
  {"url":"https://example.org/b","doi":null,"title":"Paper B","authors":["B. Dos"],
   "year":2021,"venue":null,"abstract":"abs","abstract_source":"paraphrased",
   "keywords":[],"relevance":"medium","relevance_reason":"contexto util",
   "verified_by_read":false}
]
EOF
validate_run /tmp/smoke-records.json > /tmp/smoke6.json 2>/dev/null; check "lote con 1 verified + 1 quarantined" 0 $? /tmp/smoke6.json
grep -q '"verified": 1' /tmp/smoke6.json && grep -q '"quarantined": 1' /tmp/smoke6.json && PASS=$((PASS+1)) && echo "PASS [conteos verified/quarantined]" || { FAIL=$((FAIL+1)); echo "FAIL [conteos]"; }

# 4b: registro malformado -> exit 1
cat > /tmp/smoke-bad.json <<'EOF'
[{"url":"https://example.org/c","doi":null,"title":"","authors":["A",42],
  "year":2022,"venue":"V","abstract":"abs","abstract_source":"verbatim",
  "keywords":[],"relevance":"high","relevance_reason":"r",
  "verified_by_read":true}]
EOF
validate_run /tmp/smoke-bad.json > /tmp/smoke7.json 2>/dev/null; check "registro malformado rechazado" 1 $? /tmp/smoke7.json
grep -q '"rejected": 1' /tmp/smoke7.json && PASS=$((PASS+1)) && echo "PASS [rejected=1 en reporte]" || { FAIL=$((FAIL+1)); echo "FAIL [rejected]"; }

# 4c: no_results -> exit 0
cat > /tmp/smoke-nores.json <<'EOF'
{"result":"no_results","queries_tried":["q1"],"urls_attempted":[],
 "ceiling_hit":false,"note":"eje muy estrecho"}
EOF
validate_run /tmp/smoke-nores.json > /tmp/smoke8.json 2>/dev/null; check "no_results outcome valido" 0 $? /tmp/smoke8.json
grep -q '"result": "no_results"' /tmp/smoke8.json && PASS=$((PASS+1)) && echo "PASS [reporte no_results]" || { FAIL=$((FAIL+1)); echo "FAIL [no_results]"; }

# 4d: top-level no array ni dict -> exit 2 (stdout vacío, error a stderr)
echo '42' > /tmp/smoke-42.json
validate_run /tmp/smoke-42.json > /tmp/smoke9.out 2>/tmp/smoke9.err
if [ $? -eq 2 ] && [ ! -s /tmp/smoke9.out ] && grep -q "must be an array" /tmp/smoke9.err; then
  PASS=$((PASS+1)); echo "PASS [top-level invalido exit 2]"
else
  FAIL=$((FAIL+1)); echo "FAIL [top-level invalido exit 2]"; cat /tmp/smoke9.err
fi

rm -rf "$D" /tmp/smoke*.json /tmp/smoke*.out /tmp/smoke*.err /tmp/smoke-records.json /tmp/smoke-bad.json /tmp/smoke-nores.json /tmp/smoke-42.json

echo
echo "===== SMOKE RESULT: $PASS pass, $FAIL fail ====="
[ "$FAIL" -eq 0 ]
