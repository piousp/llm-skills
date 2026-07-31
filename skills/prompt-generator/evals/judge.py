#!/usr/bin/env python3
"""
Layer 3 (LLM-as-judge) for the `prompt-generator` skill.

Reruns 3 of the Layer 2 probes (loop_one_adjust, scope_which_system,
scant_perf) via run_layer2_probes.run_probe(), then asks a second `pi`
call for a structured JSON verdict on questions deterministic regex checks
in run_layer2_probes.py genuinely can't answer:

  1. Materially sharper vs. cosmetic paraphrase -- did the reformulation
     actually pin terms/scope/success criteria, or just reword the ask?
  2. loop_one_adjust -- was the user's mid-loop adjustment ("exclude the
     ingestion module, focus only on the transform step") faithfully folded
     into the re-proposal, not just acknowledged and dropped?
  3. scope_which_system -- did the clarifying question target the actual
     fork between the two seeded consumer files, not a generic "can you
     clarify?" that dodges naming either candidate?

Gated behind PI_LIVE_EVAL=1 -- costs real LLM tokens, 2x per probe (probe +
judge call).

Usage:
    PI_LIVE_EVAL=1 python3 evals/judge.py
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
from run_layer2_probes import run_probe  # noqa: E402

JUDGE_SCHEMA_NOTE = (
    'Respond with ONLY a single JSON object, no prose before or after, matching '
    'exactly this shape: {"passed": <bool>, "score": <int 0-100>, "notes": "<one or two sentences>"}.'
)


def _find_case(prompt_set: list[dict], case_id: str) -> dict:
    for c in prompt_set:
        if c["id"] == case_id:
            return c
    raise KeyError(f"case {case_id!r} not found in prompt_set.json")


def _transcript_text(probe_result: dict) -> str:
    lines = []
    for i, t in enumerate(probe_result["turns"]):
        lines.append(f"Turn {i} (user): {t['user']}")
        lines.append(f"Turn {i} (agent tool calls): {t['tool_calls']}")
        lines.append(f"Turn {i} (agent response): {t['text']}")
    return "\n".join(lines)


def _judge_instructions_for(case_id: str) -> str:
    if case_id == "scant_perf":
        return (
            "Below is a transcript of the prompt-generator skill responding to the "
            "vague ask 'make the app faster'. Judge whether the proposed "
            "reformulation is MATERIALLY sharper than the original (pins down which "
            "part of the app, what 'faster' means, scope, success criteria) rather "
            "than a cosmetic paraphrase of the same vague ask."
        )
    if case_id == "loop_one_adjust":
        return (
            "Below is a multi-turn transcript. The user first gave a vague ask, "
            "then said: 'adjust: exclude the ingestion module, focus only on the "
            "transform step'. Judge whether the agent's next proposal (before the "
            "final confirmed block) faithfully incorporated that exact adjustment "
            "(explicitly excludes ingestion, explicitly scopes to transform) rather "
            "than ignoring it or only partially reflecting it."
        )
    if case_id == "scope_which_system":
        return (
            "Below is a transcript for the prompt 'migrate the queue consumer to "
            "the new pipeline', run against a fixture repo containing two plausible "
            "consumer files: consumers/legacy_queue_consumer.py and "
            "consumers/new_queue_consumer.py. Judge whether the agent's clarifying "
            "question specifically targets the fork between these two files (names "
            "both, or clearly distinguishes them) rather than asking a generic "
            "'can you clarify the queue consumer?' that never surfaces the actual "
            "choice."
        )
    raise KeyError(f"no judge instructions defined for case {case_id!r}")


JUDGE_CASE_IDS = ["loop_one_adjust", "scope_which_system", "scant_perf"]


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

    import pathlib
    prompt_set_path = pathlib.Path(__file__).resolve().parent / "prompt_set.json"
    prompt_set = json.loads(prompt_set_path.read_text())

    all_passed = True
    for case_id in JUDGE_CASE_IDS:
        case = _find_case(prompt_set, case_id)
        probe_result = run_probe(case)
        transcript = _transcript_text(probe_result)
        judge_prompt = (
            f"{_judge_instructions_for(case_id)}\n\n"
            f"--- Transcript ---\n{transcript}\n\n"
            f"{JUDGE_SCHEMA_NOTE}"
        )
        verdict = run_judge(judge_prompt)
        status = "PASS" if verdict.get("passed") else "FAIL"
        if not verdict.get("passed"):
            all_passed = False
        print(f"[{status}] {case_id} (deterministic checks: "
              f"{'PASS' if probe_result['passed'] else 'FAIL'})")
        print(f"    score: {verdict.get('score')}")
        print(f"    notes: {verdict.get('notes')}")
        print()

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
