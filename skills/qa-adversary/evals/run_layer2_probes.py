#!/usr/bin/env python3
"""
Layer 2 (trajectory/tool-call probes) for the qa-adversary skill.

Each probe: seed a fresh temp repo (fixtures.py), run bare `pi -ne --skill
<qa-adversary dir> --mode json -p <prompt>`, parse the NDJSON transcript for
tool calls, and grade the final report against the probe's expected_checks
from prompt_set.json. All checks here are deterministic (guardrails +
report-structure regex). The qualitative slice — was the failure scenario
sound, was the report honestly in-lane — is graded at Layer 3 (judge.py),
which regex genuinely can't reach.

Gated behind PI_LIVE_EVAL=1 by convention — costs real LLM tokens, must
never be part of a default/offline suite. Offline validation (no LLM, no env
var) via --check.

Usage:
    python3 evals/run_layer2_probes.py --check              # offline: registry + fixtures smoke test
    python3 evals/run_layer2_probes.py --trials N           # dry-run without PI_LIVE_EVAL: "Skipped…", exit 0
    PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py --trials 5   # live: N trials per case
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable

from fixtures import SEEDERS, git_available, seed_git_diff_coverage

EVALS_DIR = Path(__file__).resolve().parent
SKILL_DIR = EVALS_DIR.parent
PROMPT_SET_PATH = EVALS_DIR / "prompt_set.json"
PROBE_TIMEOUT = 300


def parse_trials(argv: list[str]) -> int:
    """Parses --trials N (default 1); invalid N prints an error and exits 2.
    With --check or without PI_LIVE_EVAL the parsed value is ignored (each
    case/probe runs once, exactly as before); only live mode uses it."""
    trials = 1
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--trials":
            if i + 1 >= len(argv):
                print("ERROR: --trials requires an integer N >= 1 (e.g. --trials 5)")
                sys.exit(2)
            raw = argv[i + 1]
            i += 2
        elif arg.startswith("--trials="):
            raw = arg[len("--trials="):]
            i += 1
        else:
            i += 1
            continue
        try:
            trials = int(raw)
        except ValueError:
            trials = 0
        if trials < 1:
            print(f"ERROR: --trials must be an integer >= 1, got {raw!r}")
            sys.exit(2)
    return trials


def run_pi(cwd: Path, prompt: str, timeout: int = PROBE_TIMEOUT) -> tuple[list[dict], str]:
    """Runs bare pi non-interactively with the qa-adversary skill loaded;
    returns (tool_calls, final_response_text). tool_calls is a list of
    {"name": str, "arguments": dict}. On timeout, raises RuntimeError naming
    the probe (harness-level FAIL)."""
    try:
        proc = subprocess.run(
            ["pi", "-ne", "--skill", str(SKILL_DIR), "--mode", "json", "-p", prompt],
            cwd=str(cwd), capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"probe timed out after {timeout}s (prompt: {prompt!r})")
    tool_calls: list[dict] = []
    final_text = ""
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            continue
        if evt.get("type") != "message_end":
            continue
        msg = evt.get("message", {})
        if msg.get("role") != "assistant":
            continue
        # Join the last assistant message's text items; ignore thinking
        # blocks and any other content type.
        texts = [c["text"] for c in msg.get("content", []) if c.get("type") == "text"]
        if texts:
            final_text = " ".join(texts)
        for c in msg.get("content", []):
            if c.get("type") == "toolCall":
                tool_calls.append({"name": c.get("name"), "arguments": c.get("arguments", {})})
    return tool_calls, final_text


# ---------------------------------------------------------------- checks

def check_no_source_or_test_mutation(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """Guardrail: the agent must never edit/write source or test code."""
    for tc in tool_calls:
        if tc.get("name") in ("edit", "write", "notepad"):
            return False
    return True


# Segment-start test-runner matching: only a segment whose first token is a
# test runner matches, so read-only inspection like `grep pytest` or
# `git log | grep test` cannot false-positive.
_SEGMENT_TEST_RUNNER_RE = re.compile(
    r"^(?:pytest|jest|vitest|phpunit)(?:\s|$)"
    r"|^python3?(?:\s+-m)?\s+(?:pytest|unittest)(?:\s|$)"
    r"|^(?:npm|npx)(?:\s+run)?\s+(?:test|jest)(?:\s|$)"
    r"|^(?:mvn|gradle|gradlew|mvnw|cargo|go|dotnet)\s+test(?:\s|$)"
)


def _bash_command_segments(tool_calls: list[dict]) -> list[str]:
    segments: list[str] = []
    for tc in tool_calls:
        if tc.get("name") != "bash":
            continue
        args = tc.get("arguments") or {}
        if not isinstance(args, dict):
            continue
        command = str(args.get("command", ""))
        for raw in re.split(r"[;&|\n]", command):
            seg = raw.strip()
            if not seg:
                continue
            # Normalize: strip leading `sudo`, env assignments (NAME=value,
            # not just NAME= — otherwise `FOO=1 pytest` would reduce to
            # `1 pytest` and slip past the runner match), and `./`. Repeat
            # until stable so `FOO=1 sudo pytest` also reduces.
            for _ in range(4):
                new = re.sub(r"^sudo\s+", "", seg)
                new = re.sub(r"^[A-Za-z_][A-Za-z0-9_]*=\S*\s*", "", new)
                new = re.sub(r"^\./", "", new).strip()
                if new == seg:
                    break
                seg = new
            segments.append(seg)
    return segments


def _matching_test_segments(tool_calls: list[dict]) -> list[str]:
    """Bash segments that would trip check_no_test_execution — printed on a
    no_test_execution failure so the offending command is diagnosable (a
    genuine test run vs a regex false positive)."""
    return [seg for seg in _bash_command_segments(tool_calls)
            if _SEGMENT_TEST_RUNNER_RE.match(seg)]


def check_no_test_execution(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """Guardrail: no test/build command in any bash call, no delegated
    test-runner tool call."""
    for seg in _bash_command_segments(tool_calls):
        if _SEGMENT_TEST_RUNNER_RE.match(seg):
            return False
    for tc in tool_calls:
        if tc.get("name") in ("run_tests", "test_runner"):
            return False
    return True


def check_report_structure(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """The final report carries all five template sections (English or
    Spanish headers, markdown heading or bold label)."""
    low = final_text.lower()
    return all(_has_section_header(low, kw) for kw in _SECTION_HEADER_PATTERNS.values())


_SECTION_HEADER_PATTERNS = {
    "title": r"qa adversary",
    "findings": r"findings|hallazgos",
    "coverage": r"integration coverage|cobertura",
    "questions": r"open questions|dudas|preguntas abiertas",
    "verdict": r"verdict|veredicto",
}


def _has_section_header(low: str, keywords: str) -> bool:
    """Section headers are recognized only at line starts: a markdown
    heading (#{1,6}) or a standalone bold label whose whole line is the
    label (optionally closed with ':'/'('/')'), in English or Spanish.
    Line anchoring rejects prose like 'see the **Cobertura** below'.
    First live run: the agent rendered the report fully in Spanish with
    headers like 'Cobertura de integración' / 'Dudas abiertas' — English
    substrings missed them, so matching is keyword-based with a header
    marker, not an exact '### ' prefix match. Accepted-risk framing
    (unchanged): a bold label only counts as a header when it stands
    alone on its own line — the line-anchoring refinement is what makes
    prose like 'see the **Cobertura** below' no longer false-positive."""
    heading = re.search(r"^\s*#{1,6}\s*(?:%s)" % keywords, low, re.MULTILINE)
    if heading:
        return True
    bold = re.search(
        r"^\s*\*\*[^*]*?(?:%s)[^*]*?[:()]?\*\*\s*"
        r"(?:\*\*[^*]*?\*\*)?\s*$" % keywords, low, re.MULTILINE)
    return bold is not None


_FINDING_LINE_RE = re.compile(r"^\s*\d+\.\s*\[(block|high|medium|low)\]", re.IGNORECASE)


def _extract_verdict(low: str) -> str | None:
    """Extract the verdict value (pass/block/needs clarification) from the
    lowercased report. Star characters are stripped first: '*' never occurs
    in the verdict vocabulary, and stripping makes the extraction robust to
    any bold formatting of the label and/or value (**Veredicto:** **BLOCK**,
    ### Verdict: **PASS**, ...). None when no verdict line parses. Shared by
    check_verdict_valid and check_clean_control_only."""
    m = re.search(
        r"(verdict|veredicto)\s*:\s*(pass|block|needs clarification)",
        low.replace("*", ""))
    return m.group(2) if m else None


def check_verdict_valid(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """Verdict must extract to PASS | BLOCK | NEEDS CLARIFICATION, and a
    [BLOCK]/[HIGH] finding anywhere in the report forces verdict BLOCK."""
    low = final_text.lower()
    verdict = _extract_verdict(low)
    if verdict is None:
        return False
    if "[block]" in low or "[high]" in low:
        return verdict == "block"
    return True


def check_findings_have_file_line(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """Every numbered [SEV] finding line must carry a file:line anchor.
    Vacuous-true when there are no finding lines (a valid empty-findings
    report must not be penalized)."""
    for line in final_text.splitlines():
        if _FINDING_LINE_RE.match(line):
            if not re.search(r"\S+:\d+", line):
                return False
    return True


def check_findings_have_failure_scenario(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """Every finding block (numbered [SEV] line up to the next [SEV] line or
    a ### header) must contain a 'Failure scenario:' line. Vacuous-true when
    there are no finding lines."""
    blocks: list[list[str]] = []
    current: list[str] | None = None
    for line in final_text.splitlines():
        if _FINDING_LINE_RE.match(line):
            current = []
            blocks.append(current)
        elif current is not None and re.match(r"^\s*###", line):
            current = None
        elif current is not None:
            current.append(line)
    if not blocks:
        return True
    for block in blocks:
        if not any(re.match(r"^\s*(failure scenario|escenario(?:\s+de\s+(?:fallo|falla|error|fracaso))?)\s*:",
                             l, re.IGNORECASE)
                   for l in block):
            return False
    return True


def check_found_planted_bug(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """The report names the fixture file AND at least one token describing
    the planted defect. Registered under found_planted_bug_logic_01 /
    _data_02 / _rule_03 / _repo_04, which differ only via ctx."""
    low = final_text.lower()
    filename = ctx.get("file", "")
    tokens = ctx.get("tokens", [])
    if filename and os.path.basename(filename).lower() not in low:
        return False
    return any(str(tok).lower() in low for tok in tokens)


def check_clean_control_only(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """Negative control: verdict must be PASS or NEEDS CLARIFICATION and the
    report must contain no [BLOCK]/[HIGH] (no manufactured or inflated
    findings on a behavior-preserving change)."""
    low = final_text.lower()
    verdict = _extract_verdict(low)
    if verdict is None or verdict not in ("pass", "needs clarification"):
        return False
    if "[block]" in low or "[high]" in low:
        return False
    return True


CHECK_REGISTRY: dict[str, Callable[[list[dict], str], bool]] = {
    "no_source_or_test_mutation": check_no_source_or_test_mutation,
    "no_test_execution": check_no_test_execution,
    "report_structure": check_report_structure,
    "verdict_valid": check_verdict_valid,
    "findings_have_file_line": check_findings_have_file_line,
    "findings_have_failure_scenario": check_findings_have_failure_scenario,
    "found_planted_bug_logic_01": check_found_planted_bug,
    "found_planted_bug_data_02": check_found_planted_bug,
    "found_planted_bug_rule_03": check_found_planted_bug,
    "found_planted_bug_repo_04": check_found_planted_bug,
    "clean_control_only": check_clean_control_only,
}


# ---------------------------------------------------------------- harness

def load_prompt_set() -> list[dict]:
    return json.loads(PROMPT_SET_PATH.read_text(encoding="utf-8"))


def grade_case(case: dict, tool_calls: list[dict], final_text: str) -> dict[str, bool]:
    ctx = case.get("ctx", {})
    return {
        check_id: CHECK_REGISTRY[check_id](tool_calls, final_text, **ctx)
        for check_id in case["expected_checks"]
    }


def run_probe(case: dict) -> dict:
    """One isolated trial: fresh temp dir -> seed fixture -> run pi -> grade."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        cwd = SEEDERS[case["seed"]](tmp)
        prompt = case["prompt"].replace("<repo>", str(cwd))
        start = time.monotonic()
        tool_calls, final_text = run_pi(cwd, prompt)
        elapsed_s = round(time.monotonic() - start, 1)
        checks = grade_case(case, tool_calls, final_text)
        return {
            "id": case["id"],
            "checks": checks,
            "passed": all(checks.values()) if checks else True,
            "tool_calls": [tc["name"] for tc in tool_calls],
            "response": final_text,
            "tool_call_count": len(tool_calls),
            "elapsed_s": elapsed_s,
            "test_segments": _matching_test_segments(tool_calls),
        }


# Import seam for judge.py: probe_id -> zero-arg runnable probe.
PROBES: dict[str, Callable[[], dict]] = {
    case["id"]: (lambda c=case: run_probe(c)) for case in load_prompt_set()
}


def check_consistency() -> list[str]:
    """Offline validation of prompt_set.json against the registry/seeders."""
    errors: list[str] = []
    required = {"id", "prompt", "should_trigger", "seed", "ctx", "expected_checks"}
    for case in load_prompt_set():
        cid = case.get("id", "?")
        missing = required - set(case.keys())
        if missing:
            errors.append(f"{cid}: missing keys {sorted(missing)}")
        if case.get("should_trigger") is not True:
            errors.append(f"{cid}: should_trigger must be true (preference skill invoked by name)")
        seed = case.get("seed")
        if seed not in SEEDERS:
            errors.append(f"{cid}: unknown seed {seed!r}")
        ctx = case.get("ctx", {})
        for check_id in case.get("expected_checks", []):
            if check_id not in CHECK_REGISTRY:
                errors.append(f"{cid}: unknown expected_check {check_id!r}")
            if check_id.startswith("found_planted_bug") and not ctx.get("tokens"):
                errors.append(f"{cid}: check {check_id!r} needs non-empty ctx['tokens']")
    return errors


def fixture_smoke_test() -> list[str]:
    """Offline: seed every fixture into a fresh temp dir and assert the
    expected files exist with the expected buggy content; for the git
    fixture also assert the working tree is dirty on exactly paging.py and a
    baseline commit exists."""
    errors: list[str] = []
    inline_checks = [
        ("seed_inline_logic_change", "discounts.py", "member_since.days > 90"),
        ("seed_inline_data_handling", "cart.py", "price_lookup[sku]"),
        ("seed_inline_business_rule", "shipping.py", "order.subtotal >= 75.00"),
        ("seed_inline_clean_control", "invoice.py", 'sum(line["amount"] for line in order["lines"])'),
    ]
    for seed_key, filename, needle in inline_checks:
        with tempfile.TemporaryDirectory() as tmp_str:
            repo = SEEDERS[seed_key](Path(tmp_str))
            path = repo / filename
            if not path.exists():
                errors.append(f"{seed_key}: expected {filename} missing")
                continue
            if needle not in path.read_text(encoding="utf-8"):
                errors.append(f"{seed_key}: expected content {needle!r} not found in {filename}")

    with tempfile.TemporaryDirectory() as tmp_str:
        if not git_available():
            errors.append("seed_git_diff_coverage: git not available on this machine — "
                          "git fixture smoke test cannot run (live probe will also be skipped)")
        else:
            repo = seed_git_diff_coverage(Path(tmp_str))
            for rel in ("paging.py", "api.py", "tests/integration/test_paging_api.py"):
                if not (repo / rel).exists():
                    errors.append(f"seed_git_diff_coverage: expected {rel} missing")
            if "start + size + 1" not in (repo / "paging.py").read_text(encoding="utf-8"):
                errors.append("seed_git_diff_coverage: buggy paging.py not in working tree")
            status = subprocess.run(
                ["git", "status", "--porcelain"], cwd=str(repo),
                capture_output=True, text=True,
            )
            if status.stdout.strip() != "M paging.py":
                errors.append(f"seed_git_diff_coverage: git status --porcelain = "
                              f"{status.stdout.strip()!r}, expected 'M paging.py'")
            log = subprocess.run(
                ["git", "log", "-1", "--oneline"], cwd=str(repo),
                capture_output=True, text=True,
            )
            if log.returncode != 0 or not log.stdout.strip():
                errors.append("seed_git_diff_coverage: baseline commit missing (git log -1 fails)")
    return errors


def main(argv: list[str]) -> int:
    trials = parse_trials(argv)
    if "--check" in argv:
        errors = check_consistency() + fixture_smoke_test()
        if errors:
            for err in errors:
                print(f"ERROR: {err}")
            print(f"check: FAIL ({len(errors)} error(s))")
            return 1
        print("check: OK — registry/consistency valid, all fixtures seed correctly")
        return 0

    if os.environ.get("PI_LIVE_EVAL") != "1":
        print("Skipped (set PI_LIVE_EVAL=1 to run — costs real LLM tokens).")
        return 0

    preflight = check_consistency()
    if preflight:
        for err in preflight:
            print(f"pre-flight ERROR: {err}")
        return 1

    all_passed = True
    for case in load_prompt_set():
        case_id = case["id"]
        print(f"== {case_id} ==")
        passed_trials = 0
        for i in range(1, trials + 1):
            try:
                result = run_probe(case)
            except RuntimeError as exc:
                all_passed = False
                print(f"trial {i}/{trials}: FAIL — harness error: {exc}")
                continue
            failed = [check_id for check_id, ok in result["checks"].items() if not ok]
            if failed:
                all_passed = False
                print(f"trial {i}/{trials}: FAIL — {', '.join(failed)}")
                print(f"    response: {result['response'][:300]!r}")
                print(f"    tool_calls: {result['tool_calls']}")
                if "no_test_execution" in failed:
                    print(f"    offending test segments: {result.get('test_segments')}")
            else:
                passed_trials += 1
                print(f"trial {i}/{trials}: PASS "
                      f"({sum(result['checks'].values())}/{len(result['checks'])} checks, "
                      f"{result['tool_call_count']} calls, {result['elapsed_s']}s)")
        print(f"{case_id}: {passed_trials}/{trials} trials passed")
        print()

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
