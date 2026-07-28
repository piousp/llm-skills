#!/usr/bin/env python3
"""
Layer 3 (LLM-as-judge) for the `writing-agent-skills` skill — qualitative
checks that regex can't reach: is the rewritten description genuinely
trigger-optimized (not just longer), is a "steps vs. goal" recommendation
faithful to the skill's actual freedom-of-execution rule, is a deferral to
`evaluating-agent-skills` scoped correctly rather than the skill trying to
own eval-building itself.

Gated behind PI_LIVE_EVAL=1 — costs real LLM tokens, 2x per probe.

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
from run_layer2_probes import run_probe  # noqa: E402

JUDGE_SCHEMA_NOTE = (
    'Respond with ONLY a single JSON object, no prose before or after, matching '
    'exactly this shape: {"passed": <bool>, "score": <int 0-100>, "notes": "<one or two sentences>"}.'
)

JUDGE_SPECS: list[tuple[str, Callable, str]] = [
    (
        "tighten_vague_description_quality",
        lambda: run_probe({
            "id": "tighten_vague_description",
            "prompt": "My skill's description is just 'API helper' and nobody's description-matching "
                       "triggers it correctly. Fix it.",
            "expected_checks": [],
        }),
        "The target skill's rule: a description must state both the WHAT and the WHEN, and a "
        "negative case if the topic is confusable with something adjacent. Judge whether the "
        "agent's rewritten description below actually satisfies this — not just longer or "
        "reworded, but genuinely more specific about what triggers it and what doesn't.",
    ),
    (
        "rigid_step_sequence_quality",
        lambda: run_probe({
            "id": "rigid_step_sequence",
            "prompt": "My skill body says: 'Step 1: read the file. Step 2: parse JSON. Step 3: "
                       "update the port. Step 4: write it back.' Is this the right style for a skill?",
            "expected_checks": [],
        }),
        "The target skill's rule: prefer describing the goal/constraints over a rigid step "
        "sequence, UNLESS exact order is genuinely load-bearing (in which case the fix is a "
        "script, not prose steps). Judge whether the agent correctly diagnosed this specific "
        "example (order-independent steps -> should be a goal statement) rather than giving "
        "generic 'be more concise' advice.",
    ),
    (
        "defer_full_eval_suite_scoping",
        lambda: run_probe({
            "id": "defer_full_eval_suite",
            "prompt": "How do I build a full eval suite with LLM-as-judge and live trajectory "
                       "probes for the skill I just wrote?",
            "expected_checks": [],
        }),
        "The target skill's rule: full eval-suite construction (prompt sets, layered checks, "
        "LLM-as-judge) is out of scope for writing-agent-skills and belongs to the "
        "evaluating-agent-skills skill; writing-agent-skills only covers the lightweight "
        "manual-testing step (§7). Judge whether the agent correctly deferred instead of trying "
        "to build the full layered harness itself inline.",
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
        print("Skipped (set PI_LIVE_EVAL=1 to run — costs real LLM tokens, 2x per probe).")
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
        print(f"[{status}] {probe_id}")
        print(f"    score: {verdict.get('score')}")
        print(f"    notes: {verdict.get('notes')}")
        print()

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
