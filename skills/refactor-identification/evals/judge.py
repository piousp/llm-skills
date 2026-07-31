#!/usr/bin/env python3
"""
Layer 3 (LLM-as-judge) for refactor-identification's Layer 2 probes.

The regex checks in run_layer2_probes.py can confirm section headers, an
"N1"/"A1" substring, or a file:line pattern showed up. They can't tell
whether the categorization is actually *correct* (is this really the same
structural shape, not just superficially similar) or whether the gate
reasoning in the N1-rejection case is *faithful in spirit* to the skill's
own worked example, not just keyword-present. This re-runs the two Layer 2
probes and sends each transcript to a second `pi` call for a structured
verdict.

Gated behind PI_LIVE_EVAL=1 — costs real LLM tokens (2x: probe + judge).

Usage:
    PI_LIVE_EVAL=1 python3 evals/judge.py
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
import run_layer2_probes as _l2  # noqa: E402

JUDGE_SCHEMA_NOTE = (
    'Respond with ONLY a single JSON object, no prose before or after, matching '
    'exactly this shape: {"passed": <bool>, "score": <int 0-100>, "notes": "<one or two sentences>"}.'
)

JUDGE_SPECS = [
    (
        "detects_a1_structural_duplication",
        "The fixture branch adds `computeInvoiceTotal` to InvoiceService.java, "
        "which is structurally identical (same loop/accumulation shape) to the "
        "pre-existing `computeRefundTotal` in the same file. Judge whether the "
        "agent's final response below correctly identifies this as A1 "
        "structural duplication (not business-rule duplication, not SRP, not "
        "a flag/enum smell), names both methods with file:line, assigns "
        "priority P1 (the branch itself introduces the duplicate and the fix "
        "stays in the same file), and proposes extracting a shared helper as "
        "the refactor direction — without prescribing implementation steps "
        "(direction only, per the skill's own scope limit).",
    ),
    (
        "rejects_single_implementation_by_n1",
        "The fixture branch adds a single new `DiscountCalculator.applyDiscount` "
        "method with no second discount rule anywhere in the repo — the "
        "skill's own worked 'rejected by the gate' example (N1: only one "
        "variant exists, no imaginary flexibility). Judge whether the agent's "
        "final response below correctly places this in Filtered out citing "
        "N1 (not a Finding proposing a Strategy pattern), and whether its "
        "one-line rationale actually reflects N1's substance (no second "
        "implementation exists or is planned) rather than a generic "
        "'looks fine' dismissal.",
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

    prompt_set = {c["id"]: c for c in json.loads(_l2.PROMPT_SET_PATH.read_text())}

    all_passed = True
    for probe_id, judge_instructions in JUDGE_SPECS:
        probe_result = _l2.run_probe(prompt_set[probe_id])
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
