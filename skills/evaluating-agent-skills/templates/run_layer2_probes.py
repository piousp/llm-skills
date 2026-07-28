#!/usr/bin/env python3
"""
TEMPLATE — Layer 2 (trajectory/tool-call probe) harness. Copy into
<target-skill>/evals/run_layer2_probes.py and fill in the TODOs:

  1. SKILL_DIR — point at the target skill's directory.
  2. PROMPT_SET_PATH — point at your filled-in prompt_set.json
     (see ../../evaluating-agent-skills/templates/prompt_set.json for schema).
  3. CHECK_REGISTRY — one function per check_id used in your prompt set.
     See ../../evaluating-agent-skills/references/check-registry-pattern.md.
  4. seed_env(tmp) — build whatever fixture repo/dir state each prompt needs
     before running pi. Return the cwd to run pi from.

Gated behind PI_LIVE_EVAL=1 by convention — costs real LLM tokens, must never
be part of a default/offline test suite. See SKILL.md step 5.

Usage:
    PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# TODO 1: point at the target skill's directory.
SKILL_DIR = Path(__file__).resolve().parent.parent

# TODO 2: point at your filled-in prompt set.
PROMPT_SET_PATH = Path(__file__).resolve().parent / "prompt_set.json"


def run_pi(cwd: Path, prompt: str, timeout: int = 240) -> tuple[list[dict], str]:
    """Runs bare pi non-interactively against the skill, returns
    (tool_calls, final_response_text). tool_calls is a list of
    {"name": str, "arguments": dict}. Do not add extensions here unless the
    prompt case specifically needs one (see the L2b pattern in
    iterative-design/evals/run_layer2b_pipeline.py for that case)."""
    proc = subprocess.run(
        ["pi", "-ne", "--skill", str(SKILL_DIR), "--mode", "json", "-p", prompt],
        cwd=str(cwd), capture_output=True, text=True, timeout=timeout,
    )
    tool_calls: list[dict] = []
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
        for c in msg.get("content", []):
            if c.get("type") == "toolCall":
                tool_calls.append({"name": c.get("name"), "arguments": c.get("arguments", {})})
    return tool_calls, final_text


def seed_env(tmp: Path) -> Path:
    """TODO 4: build fixture state (a temp repo, seed files, etc.) for a
    single trial and return the directory pi should be run from. Keep every
    trial's state fully isolated -- never share a fixture across prompts or
    runs (SKILL.md step 5)."""
    repo = tmp / "repo"
    repo.mkdir()
    return repo


# TODO 3: one function per check_id referenced in prompt_set.json.
# Signature: (tool_calls: list[dict], final_text: str, **ctx) -> bool
def example_check_id(tool_calls, final_text, **ctx) -> bool:
    """Replace with a real check. Prefer inspecting tool_calls / filesystem
    state over final_text (outcome over transcript -- see SKILL.md step 2)."""
    return True


CHECK_REGISTRY = {
    "example_check_id": example_check_id,
}


def run_probe(case: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        cwd = seed_env(tmp)
        tool_calls, final_text = run_pi(cwd, case["prompt"])
        checks = {
            check_id: CHECK_REGISTRY[check_id](tool_calls, final_text)
            for check_id in case["expected_checks"]
        }
        return {
            "id": case["id"],
            "checks": checks,
            "passed": all(checks.values()) if checks else True,
            "tool_calls": [tc["name"] for tc in tool_calls],
            "response": final_text,
        }


def main() -> int:
    if os.environ.get("PI_LIVE_EVAL") != "1":
        print("Skipped (set PI_LIVE_EVAL=1 to run — costs real LLM tokens).")
        return 0

    prompt_set = json.loads(PROMPT_SET_PATH.read_text())
    all_passed = True
    for case in prompt_set:
        result = run_probe(case)
        status = "PASS" if result["passed"] else "FAIL"
        if not result["passed"]:
            all_passed = False
        print(f"[{status}] {result['id']}")
        for check, ok in result["checks"].items():
            print(f"    {'ok' if ok else 'FAIL'}: {check}")
        print(f"    tool_calls: {result['tool_calls']}")
        print(f"    response: {result['response'][:300]!r}")
        print()

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
