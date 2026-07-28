#!/usr/bin/env python3
"""
Layer 3 (LLM-as-judge) for the iterative-design skill's Layer 2 probes.

Regex/keyword checks in run_layer2_probes.py can tell you a phrase like
"Phase 4" and "optional" showed up, or that no edit/write hit a repo file.
They can't tell you whether the *rationale* was sound or the wording is
faithful *in spirit* to SKILL.md. This re-runs the same three probes and
sends each transcript to a second `pi` call for a structured verdict.

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
    probe_refuses_without_delegation,
    probe_gate_wording_faithful,
    probe_state_derivation_is_mechanical,
)

JUDGE_SCHEMA_NOTE = (
    'Respond with ONLY a single JSON object, no prose before or after, matching '
    'exactly this shape: {"passed": <bool>, "score": <int 0-100>, "notes": "<one or two sentences>"}.'
)

JUDGE_SPECS = [
    (
        "refuses_without_delegation",
        probe_refuses_without_delegation,
        "SKILL.md's coordinator rule states: \"If your harness has no "
        "subagent/delegation mechanism, say so explicitly before proceeding "
        "rather than doing the work yourself.\" Judge whether the agent's "
        "final response below correctly identifies the missing delegation "
        "mechanism, cites (in substance, not necessarily verbatim) that this "
        "is the skill's own rule rather than an ad-hoc excuse, and stops "
        "short of silently doing the planner/implementer's job itself.",
    ),
    (
        "gate_wording_faithful",
        probe_gate_wording_faithful,
        "SKILL.md's Phase 4 gate must be presented as: \"Phase 3 is green, "
        "frozen, and checkpointed at `phase3-green` (commit `<hash>`). Phase 4 "
        "(refactor + one `code-review-checklist` pass) is optional. Run Phase 4, "
        "or skip to Phase 5? [run / skip]\". Judge whether the agent's final "
        "response below is faithful to this wording IN SPIRIT (translation or "
        "light paraphrase is fine) -- specifically: does it convey Phase 3 is "
        "frozen/checkpointed, that Phase 4 is optional, and does it actually "
        "ask the user rather than assume an answer.",
    ),
    (
        "state_derivation_is_mechanical",
        probe_state_derivation_is_mechanical,
        "SKILL.md states phase derivation is mechanical (`state.py next`), "
        "not a judgment call. Judge whether the agent's final response below "
        "grounds its phase claim in the state.py output rather than reasoning "
        "independently about the design-dir contents, and whether it flags "
        "any anomaly state.py can't catch (e.g. a suspicious/placeholder "
        "goal.md) without overriding the mechanical phase result.",
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
        print(f"[{status}] {probe_id} (deterministic checks: "
              f"{'PASS' if probe_result['passed'] else 'FAIL'})")
        print(f"    score: {verdict.get('score')}")
        print(f"    notes: {verdict.get('notes')}")
        print()

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
