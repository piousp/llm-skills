#!/usr/bin/env python3
"""
Layer 3 (LLM-as-judge) for the `agent-prompting` skill.

Reruns 3 of the Layer 2 probes (web_search_delegation,
planning_delegation, transparency_step) via run_layer2_probes.run_probe(),
then asks a second `pi` call for a structured JSON verdict on questions
deterministic regex checks in run_layer2_probes.py genuinely can't answer:

  1. web_search_delegation -- is the produced web-scout prompt MATERIALLY
     actionable (operative stop rule, inline contract with real fields,
     triangulation) or a vague "search the web for X"?
  2. planning_delegation -- does the coordinator->planner prompt carry the
     confirmed goal authoritatively (verbatim or by reference) plus
     constraints/out-of-scope and a verifiable plan deliverable, instead
     of a generic "make a plan for X"?
  3. transparency_step -- did the agent show the exact, paste-ready
     delegation prompt (the prompt shown equals the prompt to be sent),
     not a summary of what it will do?

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
        response = t.get("full_text") or t["text"]
        lines.append(f"Turn {i} (agent response): {response}")
    return "\n".join(lines)


def _judge_instructions_for(case_id: str) -> str:
    if case_id == "web_search_delegation":
        return (
            "Below is a transcript of an agent (with the agent-prompting skill) "
            "preparing a web-search delegation prompt for a web-scout subagent. "
            "Judge whether the produced prompt is MATERIALLY actionable: a concrete "
            "research objective, an INLINE output contract (JSON fields for claims, "
            "sources, corroboration), an operative STOP RULE (bounded queries or "
            "sources, not open-ended 'keep searching'), and verification/triangulation "
            "requirements. A vague 'search the web for X' is a fail."
        )
    if case_id == "planning_delegation":
        return (
            "Below is a transcript of an agent (with the agent-prompting skill) "
            "preparing a coordinator-to-planner delegation prompt. Judge whether the "
            "prompt passes the confirmed goal authoritatively (goal verbatim or an "
            "explicit reference to the goal file), includes decisions/constraints or "
            "out-of-scope, names a lens by path with fail-closed handling, and "
            "defines the plan deliverable with verification per step. A generic "
            "'make a plan for X' is a fail."
        )
    if case_id == "transparency_step":
        return (
            "Below is a transcript of an agent (with the agent-prompting skill) "
            "handling the transparency step before delegating a web search. Judge "
            "whether the agent SHOWED the exact, complete, paste-ready delegation "
            "prompt (in a quoted block) and/or asked '¿Muestro el prompt antes de "
            "delegar? (sí / no)' -- i.e. the prompt shown equals the prompt to be "
            "sent. A summary of what it will do, without the actual prompt, is a fail."
        )
    raise KeyError(f"no judge instructions defined for case {case_id!r}")


JUDGE_CASE_IDS = ["web_search_delegation", "planning_delegation", "transparency_step"]


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
