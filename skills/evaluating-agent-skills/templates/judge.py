#!/usr/bin/env python3
"""
TEMPLATE — Layer 3 (LLM-as-judge) for qualitative checks regex can't reach.
Copy into <target-skill>/evals/judge.py and fill in the TODOs:

  1. Import your filled-in run_layer2_probes.py's probe functions (or
     inline equivalents) instead of the placeholder import below.
  2. JUDGE_SPECS — one (probe_id, probe_fn, judge_instructions) tuple per
     qualitative question you actually need an LLM verdict for. Don't add a
     judge entry for anything a deterministic check in run_layer2_probes.py
     could already answer (SKILL.md step 4: L3 is for what regex genuinely
     can't reach).

Gated behind PI_LIVE_EVAL=1 — costs real LLM tokens, 2x per probe (probe +
judge call). Never part of a default/offline suite.

Usage:
    PI_LIVE_EVAL=1 python3 evals/judge.py
"""
import json
import os
import re
import subprocess
import sys
from typing import Callable

sys.path.insert(0, os.path.dirname(__file__))
# TODO 1: replace with your real probe functions, e.g.:
# from run_layer2_probes import probe_x, probe_y
from run_layer2_probes import run_probe  # noqa: E402

JUDGE_SCHEMA_NOTE = (
    'Respond with ONLY a single JSON object, no prose before or after, matching '
    'exactly this shape: {"passed": <bool>, "score": <int 0-100>, "notes": "<one or two sentences>"}.'
)

# TODO 2: one (probe_id, probe_fn, judge_instructions) per qualitative question.
JUDGE_SPECS: list[tuple[str, Callable, str]] = [
    # (
    #     "gate_wording_faithful",
    #     lambda: run_probe({"id": "...", "prompt": "...", "expected_checks": []}),
    #     "Describe, referencing the target skill's exact rule text, what the "
    #     "judge should verify in the agent's final response below.",
    # ),
]


def run_judge(judge_prompt: str, timeout: int = 90) -> dict:
    proc = subprocess.run(
        ["pi", "-ne", "--mode", "json", "-p", judge_prompt],
        capture_output=True, text=True, timeout=timeout,
    )
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
        texts = [c["text"] for c in msg.get("content", []) if c.get("type") == "text"]
        if texts:
            final_text = " ".join(texts)

    match = re.search(r"\{.*\}", final_text, re.DOTALL)
    if not match:
        return {"passed": False, "score": 0, "notes": f"judge did not return JSON: {final_text[:200]!r}"}
    try:
        verdict = json.loads(match.group(0))
    except json.JSONDecodeError:
        return {"passed": False, "score": 0, "notes": f"judge JSON did not parse: {match.group(0)[:200]!r}"}

    if not isinstance(verdict.get("passed"), bool) or not isinstance(verdict.get("score"), int):
        return {"passed": False, "score": 0, "notes": f"judge JSON missing/malformed fields: {verdict!r}"}
    return verdict


def main() -> int:
    if os.environ.get("PI_LIVE_EVAL") != "1":
        print("Skipped (set PI_LIVE_EVAL=1 to run — costs real LLM tokens, 2x per probe).")
        return 0

    if not JUDGE_SPECS:
        print("JUDGE_SPECS is empty — fill in TODO 2 before running this template.")
        return 0

    all_passed = True
    for probe_id, probe_fn, judge_instructions in JUDGE_SPECS:
        probe_result = probe_fn()
        judge_prompt = (
            f"{judge_instructions}\n\n"
            f"--- Agent's tool calls ---\n{probe_result['tool_calls']}\n\n"
            f"--- Agent's final response ---\n{probe_result['response']}\n\n"
            f"{JUDGE_SCHEMA_NOTE}"
        )
        verdict = run_judge(judge_prompt)
        status = "PASS" if verdict.get("passed") else "FAIL"
        if not verdict.get("passed"):
            all_passed = False
        print(f"[{status}] {probe_id} (deterministic checks: "
              f"{'PASS' if probe_result['passed'] else 'FAIL'})")
        print(f"    score: {verdict.get('score')}")
        print(f"    notes: {verdict.get('notes')}")
        print()

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
