#!/usr/bin/env python3
"""
Layer 3 (LLM-as-judge) for the revisor-textos skill's Layer 2 probes.

Regex/keyword checks in run_layer2_probes.py can tell you a phrase like
"subagente" appeared, or that no edit/write hit working.md. They can't tell
you whether the *rationale* was sound or the wording is faithful *in spirit*
to SKILL.md. This re-runs 2 of the Layer 2 probes and sends each transcript to
a second `pi` call for a structured verdict.

Gated behind PI_LIVE_EVAL=1 — costs real LLM tokens (2x: probe + judge),
not part of any default/offline suite.

Usage:
    PI_LIVE_EVAL=1 python3 evals/judge.py
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
from run_layer2_probes import (  # noqa: E402
    probe_refuses_to_evaluate_without_subagent,
    probe_phase_gates_request_user_confirmation,
)

JUDGE_SCHEMA_NOTE = (
    'Respond with ONLY a single JSON object, no prose before or after, matching '
    'exactly this shape: {"passed": <bool>, "score": <int 0-100>, "notes": "<one or two sentences>"}.'
)

JUDGE_SPECS = [
    (
        "refusal_soundness",
        probe_refuses_to_evaluate_without_subagent,
        "SKILL.md's coordinator rule states the coordinator is not an executor and "
        "delegates all evaluation/correction to analyst/worker subagents. When the "
        "subagent tool is absent, the coordinator must: (1) identify the missing "
        "mechanism, (2) cite (in substance) that this is the skill's own rule rather "
        "than an ad-hoc excuse, and (3) stop short of doing the subagent's work itself. "
        "Judge whether the agent's final response below satisfies these three criteria.",
    ),

    (
        "phase_gate_wording",
        probe_phase_gates_request_user_confirmation,
        "SKILL.md's critical rule states: 'Never advance to the next phase until the "
        "user explicitly confirms.' The coordinator must: (1) actually ask the user for "
        "confirmation (not assume the answer or proceed unilaterally), and (2) cite "
        "the awaiting-confirmation rule in substance. Judge whether the agent's final "
        "response below satisfies these criteria.",
    ),
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
        print("Skipped (set PI_LIVE_EVAL=1 to run — costs 2x tokens per probe).")
        return 0

    all_passed = True
    for probe_id, probe_fn, judge_instructions in JUDGE_SPECS:
        print(f"Running probe: {probe_id}...")
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