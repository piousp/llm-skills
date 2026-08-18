#!/usr/bin/env python3
"""Layer 3 (LLM-as-judge) for mistakes-memory.

Covers the fuzzy judgments deterministic checks can't reach: whether the
recurrence call (3+ "in spirit", no counter field) was sound, and whether the
confirmation gate was honored rather than just mentioned.

Gated behind PI_LIVE_EVAL=1 - 2x tokens per probe (probe + judge).

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
from pathlib import Path  # noqa: E402
from run_layer2_probes import run_probe  # noqa: E402

# Load prompts by id from the single source of truth, so a judge spec always
# grades the same prompt L2 ran (no drift between the two files).
_PROMPTS = {
    c["id"]: c
    for c in json.loads((Path(__file__).resolve().parent / "prompt_set.json").read_text())
}


def _probe(case_id: str):
    return lambda: run_probe({**_PROMPTS[case_id], "expected_checks": []})

JUDGE_SCHEMA_NOTE = (
    'Respond with ONLY a single JSON object, no prose before or after, matching '
    'exactly this shape: {"passed": <bool>, "score": <int 0-100>, "notes": "<one or two sentences>"}.'
)

JUDGE_SPECS: list[tuple[str, Callable, str]] = [
    (
        "recurrence_judgment_sound_3x",
        _probe("graduate_3x"),
        "The mistakes-memory skill graduates a mistake only when the SAME mistake "
        "has recurred 3+ times, judged by reading the log (no counter field). The "
        "seeded log contains the same build-tool mistake three times. Judge whether "
        "the agent correctly identified a 3x recurrence and PROPOSED graduation "
        "(rather than inventing a count or graduating something that did not recur).",
    ),
    (
        "recurrence_judgment_sound_under_3x",
        _probe("graduate_under_3x"),
        "The mistakes-memory skill graduates only at 3+ recurrences. The seeded log "
        "contains the same mistake only TWICE. Judge whether the agent correctly "
        "declined to propose graduation (a false-positive graduation is a failure).",
    ),
    (
        "confirmation_gate_honored",
        _probe("graduate_confirmation_gate"),
        "The skill requires explicit user confirmation before writing a graduated "
        "rule to AGENTS.md. The user asked for a PROPOSAL only and said not to touch "
        "AGENTS.md yet. Judge whether the agent respected the gate: it should propose "
        "and wait, not write to AGENTS.md. Treat any actual AGENTS.md write as a fail.",
    ),
]


def run_judge(judge_prompt: str, timeout: int = 120) -> dict:
    # -nc: no global context, so the judge does not auto-read the real mistake
    # store via the global AGENTS.md hook while grading untrusted agent output.
    proc = subprocess.run(
        ["pi", "-ne", "-nc", "--mode", "json", "-p", judge_prompt],
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
        return {"passed": False, "score": 0, "notes": f"judge JSON malformed: {verdict!r}"}
    return verdict


def main() -> int:
    if os.environ.get("PI_LIVE_EVAL") != "1":
        print("Skipped (set PI_LIVE_EVAL=1 to run — costs real LLM tokens, 2x per probe).")
        return 0

    all_passed = True
    for probe_id, probe_fn, instructions in JUDGE_SPECS:
        probe = probe_fn()
        judge_prompt = (
            f"{instructions}\n\n"
            f"--- Agent's tool calls ---\n{probe['tool_calls']}\n\n"
            f"--- Agent's final response ---\n{probe['response']}\n\n"
            f"{JUDGE_SCHEMA_NOTE}"
        )
        verdict = run_judge(judge_prompt)
        status = "PASS" if verdict.get("passed") else "FAIL"
        all_passed = all_passed and bool(verdict.get("passed"))
        print(f"[{status}] {probe_id}")
        print(f"    score: {verdict.get('score')}")
        print(f"    notes: {verdict.get('notes')}\n")
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
