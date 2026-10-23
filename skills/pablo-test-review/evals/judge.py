#!/usr/bin/env python3
"""
Layer 3 (LLM-as-judge) for the pablo-test-review skill's Layer 2 probes.

The deterministic checks in run_layer2_probes.py can tell that the report has
the right sections, anchored items, backticked `Change:` tokens and respects
the caps. They cannot tell whether a line is worth posting as written, whether
the one gap follows the ordered keys in the rubric's Gap ranking, or whether an empty
result is honest silence rather than a missed finding. This re-runs the probes
and sends each transcript (tool calls + final response) to a second `pi` call,
without --skill, so the judge grades the transcript on its own merits.

Specs (6 entries):
  P1, P2, P5  post-ready: would a maintainer post the line as is?
  P7          gap-ranking: at most 1 gap, round trip kept, no padding
  N6, N7      honest-silence: no padding, no out-of-lane commentary

Gated behind PI_LIVE_EVAL=1: costs real LLM tokens (2x per probe: probe +
judge call), never part of a default/offline suite. Offline wiring check via
--check.

Usage:
    python3 evals/judge.py --check     # offline: specs reference known probes, prompts well formed
    PI_LIVE_EVAL=1 python3 evals/judge.py --trials 3   # live: N trials per judge spec
"""
import json
import os
import re
import subprocess
import sys
from typing import Callable

sys.path.insert(0, os.path.dirname(__file__))
from run_layer2_probes import PROBES, parse_trials  # noqa: E402

JUDGE_TIMEOUT = 120
JUDGE_SCHEMA_NOTE = (
    'Respond with ONLY a single JSON object, no prose before or after, matching '
    'exactly this shape: {"passed": <bool>, "score": <int 0-100>, "notes": "<one or two sentences>"}.'
)

# ---------------------------------------------------------------- judges

POST_READY = {
    "P1_removed_assertion": (
        "The diff deleted assertEquals(Status.ARCHIVED, dto.status()) from WidgetMapperTest; "
        "nothing else asserts the status field."
    ),
    "P2_sibling_helper_missing": (
        "The new test copiesToSecondRegion in WidgetCopyTest omits assertSourceUntouched(source), "
        "which its three sibling tests call."
    ),
    "P5_claim_not_checked": (
        "The new test setsDereferencedAtOnDelete in WidgetDeleterTest is named for the "
        "dereferencedAt timestamp but asserts only the event status; the changed production "
        "line sets the timestamp from the clock (123 ms in the test)."
    ),
}
POST_READY_SUFFIX = (
    " Judge whether the agent's final response below contains a line a careful maintainer "
    "would post on the pull request as written: it targets THAT defect (not an adjacent or "
    "invented one), is one or two sentences, preferably a question, sits on a changed line, "
    "and its `Change:` line names the exact assertion or helper as code. Fail if the item is "
    "generic ('tests could be stronger'), padded, wrong about the defect, or buried among "
    "unrelated items."
)
GAP_RANKING = (
    "The change adds two scenarios (activate, archive) to an integration-test repository. "
    "Several untested sequences exist; the repository README says operators archive a widget "
    "and restore it the same day in most cases, so the archive-then-restore round trip is the "
    "production-likely gap. Judge whether the agent's final response below lists at most 1 "
    "critical gap, which is the archive/restore round trip (no higher-ranked key applies: every candidate is a sequence, so the production-likely one wins), gives "
    "each gap a concrete test name with input and expected result, and does not pad with "
    "exhaustive edge cases. Fail if it lists more than 1 gap, misses the round trip, or "
    "gives gaps without a concrete test."
)
HONEST_SILENCE = {
    "N6_clean_tests_only": (
        "The diff only adds two well-formed tests (a non-ISO date rejected with the exact "
        "exception type; an exact date value asserted). Nothing is weak, brittle or missing."
    ),
    "N7_prod_style_only": (
        "The diff changes a production comparison (>= 10 to > 10) and a poorly named local "
        "variable; the tests were updated to assert both sides of the boundary exactly. "
        "Production quality is outside the test lens."
    ),
}
HONEST_SILENCE_SUFFIX = (
    " Judge whether the agent's final response below honestly reports no test observations "
    "(or at most one Nit with an exact replacement) and does NOT pad the report with invented "
    "test critiques or production-code commentary to look thorough. Fail if it manufactures "
    "items or comments on production style or correctness."
)

def _build_judge_specs() -> list[tuple[str, Callable[[], dict], str]]:
    specs: list[tuple[str, Callable[[], dict], str]] = []
    for probe_id, text in POST_READY.items():
        specs.append((probe_id, PROBES[probe_id], text + POST_READY_SUFFIX))
    specs.append(("P7_it_many_candidate_gaps", PROBES["P7_it_many_candidate_gaps"], GAP_RANKING))
    for probe_id, text in HONEST_SILENCE.items():
        specs.append((probe_id, PROBES[probe_id], text + HONEST_SILENCE_SUFFIX))
    return specs


JUDGE_SPECS: list[tuple[str, Callable[[], dict], str]] = _build_judge_specs()


# ---------------------------------------------------------------- harness

def _final_text_from_ndjson(stdout: str) -> str:
    """Same NDJSON parse as run_layer2_probes.run_pi: text of the last
    assistant message_end event."""
    final_text = ""
    for line in stdout.splitlines():
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
        texts = [c["text"] for c in msg.get("content", []) if c.get("type") == "text"]
        if texts:
            final_text = " ".join(texts)
    return final_text


def _parse_judge_verdict(final_text: str) -> dict | None:
    """First {...} blob (DOTALL) parsed as JSON with a bool `passed` and an
    int `score`. None on any failure so the caller can retry."""
    match = re.search(r"\{.*\}", final_text, re.DOTALL)
    if not match:
        return None
    try:
        verdict = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(verdict.get("passed"), bool) or not isinstance(verdict.get("score"), int):
        return None
    return verdict


def run_judge(judge_prompt: str, timeout: int = JUDGE_TIMEOUT) -> dict:
    """Calls pi as the judge (no --skill: the judge must grade the transcript
    on its own merits). Retries once with the same prompt on any failure to
    obtain a valid verdict; a judge failure is a FAIL, never a silent skip."""
    last_text = ""
    for _ in range(2):
        try:
            proc = subprocess.run(
                ["pi", "-ne", "--mode", "json", "-p", judge_prompt],
                capture_output=True, text=True, timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            last_text = "<judge call timed out>"
            continue
        last_text = _final_text_from_ndjson(proc.stdout)
        verdict = _parse_judge_verdict(last_text)
        if verdict is not None:
            return verdict
    return {
        "passed": False,
        "score": 0,
        "notes": f"judge did not return JSON: {last_text[:200]!r}",
    }


def _display_label(probe_id: str, instructions: str) -> str:
    if instructions == GAP_RANKING:
        return f"{probe_id} [gap-ranking]"
    if instructions.endswith(HONEST_SILENCE_SUFFIX):
        return f"{probe_id} [honest-silence]"
    return f"{probe_id} [post-ready]"


def check_specs() -> list[str]:
    """Offline wiring check: probes exist, six specs, instructions non-empty,
    each prompt ends with the JSON schema note when assembled."""
    errors = [f"JUDGE_SPECS references unknown probe {spec[0]!r} (not in PROBES)"
              for spec in JUDGE_SPECS if spec[0] not in PROBES]
    if len(JUDGE_SPECS) != 6:
        errors.append(f"expected 6 judge specs, found {len(JUDGE_SPECS)}")
    for probe_id, _, instructions in JUDGE_SPECS:
        if len(instructions) < 100:
            errors.append(f"{probe_id}: judge instructions too short")
    sample = {"passed": True, "score": 90, "notes": "ok"}
    if _parse_judge_verdict("noise " + json.dumps(sample) + " noise") != sample:
        errors.append("_parse_judge_verdict does not parse a well-formed verdict")
    if _parse_judge_verdict('{"passed": "yes", "score": 1}') is not None:
        errors.append("_parse_judge_verdict accepts a non-bool passed")
    return errors


def main(argv: list[str]) -> int:
    trials = parse_trials(argv)
    if "--check" in argv:
        errors = check_specs()
        if errors:
            for err in errors:
                print(f"ERROR: {err}")
            return 1
        print(f"check: OK - {len(JUDGE_SPECS)} judge specs all reference known probes")
        return 0

    if os.environ.get("PI_LIVE_EVAL") != "1":
        print("Skipped (set PI_LIVE_EVAL=1 to run; costs real LLM tokens, 2x per probe).")
        return 0

    all_passed = True
    for probe_id, probe_fn, judge_instructions in JUDGE_SPECS:
        label = _display_label(probe_id, judge_instructions)
        passed_trials = 0
        for i in range(1, trials + 1):
            try:
                probe_result = probe_fn()
            except Exception as exc:  # probe raised (e.g. timeout): FAIL and continue
                all_passed = False
                print(f"[FAIL] {label} trial {i}/{trials} (probe raised: {exc})")
                continue
            judge_prompt = (
                f"{judge_instructions}\n\n"
                f"--- Agent's tool calls ---\n{json.dumps(probe_result['tool_calls'])}\n\n"
                f"--- Agent's final response ---\n{probe_result['response']}\n\n"
                f"{JUDGE_SCHEMA_NOTE}"
            )
            verdict = run_judge(judge_prompt)
            status = "PASS" if verdict.get("passed") else "FAIL"
            if not verdict.get("passed"):
                all_passed = False
            else:
                passed_trials += 1
            det_failed = [cid for cid, ok in probe_result.get("checks", {}).items() if not ok]
            det_note = (f"FAIL ({', '.join(det_failed)})" if det_failed else "PASS")
            print(f"[{status}] {label} trial {i}/{trials} (deterministic checks: {det_note})")
            print(f"    score: {verdict.get('score')}")
            print(f"    notes: {verdict.get('notes')}")
            print()
        print(f"{label}: {passed_trials}/{trials} trials passed")
        print()

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
