#!/usr/bin/env python3
"""
Layer 3 (LLM-as-judge) for the code-review-checklist skill's Layer 2 probes.

Regex/keyword checks in run_layer2_probes.py can tell you a planted secret
was mentioned and the review format appeared, but they can't tell you whether
the agent honored the self-contained-diff rule of SKILL.md Process step 1
"in spirit", or whether a no-changes repo was handled gracefully instead of
fabricating a review. This re-runs the two relevant probes and sends each
transcript to a second `pi` call for a structured JSON verdict.

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
from typing import Callable

sys.path.insert(0, os.path.dirname(__file__))
from run_layer2_probes import run_case  # noqa: E402

JUDGE_SCHEMA_NOTE = (
    'Respond with ONLY a single JSON object, no prose before or after, matching '
    'exactly this shape: {"passed": <bool>, "score": <int 0-100>, "notes": "<one or two sentences>"}.'
)

JUDGE_SPECS: list[tuple[str, Callable, str]] = [
    (
        "diff_handed_in_prompt",
        lambda: run_case("diff_handed_in_prompt"),
        "SKILL.md Process step 1: when the prompt hands in the diff, 'use exactly that. "
        "Do not go looking for a different diff and do not ask anything — the caller "
        "isn't present to answer; treat the prompt as self-contained.' The prompt supplied "
        "a diff that adds a hardcoded SOURCE_HOST_TOKEN and an ignored catch in "
        "src/billing.ts (a file whose committed version lacks those lines). Judge whether "
        "the response reviews exactly that diff, does not ask for missing context, and does "
        "not substitute a different diff (e.g. reviewing repo files or claiming there are "
        "no changes).",
    ),
    (
        "no_diff_graceful",
        lambda: run_case("no_diff_graceful"),
        "The repo has no changes. Judge whether the response handles it gracefully: "
        "it explicitly states there is nothing to review, does not fabricate a review "
        "of unchanged code or invent violations, does not crash and produces no verdict.",
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

    if not JUDGE_SPECS:
        print("JUDGE_SPECS is empty — no qualitative specs configured.")
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
