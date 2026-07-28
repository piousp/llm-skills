#!/usr/bin/env python3
"""
Layer 2 (trigger-only) probes for evaluating-agent-skills itself.

Scope, deliberately narrow: this skill has a real "when" clause plus explicit
negative cases in its description (unlike name-only-invoked skills such as
iterative-design), so should_trigger is the single highest-value, cheapest
axis to check here (SKILL.md step 1). This does NOT grade the *quality* of
an eval suite the skill would build (that's the "Full L2" the skill's own
README explicitly defers, see below) -- it only checks whether the skill's
description correctly fires (or doesn't) on a representative prompt, run via
bare `pi` with NO --skill flag (real discovery, not forced loading).

Trigger signal: does the transcript contain an early `read` of THIS skill's
own SKILL.md? Confirmed empirically as the observable proxy for "did the
skill's description match and get loaded" (see README.md "Feasibility
finding").

SANDBOXING: every prompt targets a path inside the trial's own temp dir
(never a real skill under ~/.pi/agent/skills) so any real writes triggered
by discovery stay fully contained and vanish when the temp dir is cleaned
up. This fixes a real incident from building this eval: an earlier ungated
manual trigger check used a real skill name as the target and caused an
actual (correct, but unintended) write to that skill's directory.

Gated behind PI_LIVE_EVAL=1 -- costs real LLM tokens.

Usage:
    PI_LIVE_EVAL=1 python3 evals/run_trigger_probes.py
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
SKILL_MD_SUFFIX = "evaluating-agent-skills/SKILL.md"
PROMPT_SET_PATH = Path(__file__).resolve().parent / "prompt_set.json"


def run_pi(cwd: Path, prompt: str, timeout: int = 180) -> tuple[list[dict], str]:
    """Bare `pi` -- NO --skill flag, so discovery/triggering is real, not
    forced. Returns (tool_calls, final_response_text)."""
    proc = subprocess.run(
        ["pi", "-ne", "--mode", "json", "-p", prompt],
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


def reads_evaluating_agent_skills_skill_md(tool_calls, final_text, **ctx) -> bool:
    for tc in tool_calls:
        if tc["name"] == "read":
            path = str(tc["arguments"].get("path", ""))
            if path.endswith(SKILL_MD_SUFFIX):
                return True
    return False


def does_not_read_evaluating_agent_skills_skill_md(tool_calls, final_text, **ctx) -> bool:
    return not reads_evaluating_agent_skills_skill_md(tool_calls, final_text, **ctx)


CHECK_REGISTRY = {
    "reads_evaluating_agent_skills_skill_md": reads_evaluating_agent_skills_skill_md,
    "does_not_read_evaluating_agent_skills_skill_md": does_not_read_evaluating_agent_skills_skill_md,
}


def seed_env(tmp: Path, prompt_template: str) -> tuple[Path, str]:
    """Every fixture lives inside tmp -- never a real skill dir. Returns
    (cwd, filled_prompt)."""
    workdir = tmp / "work"
    workdir.mkdir()

    fixture_skill_dir = tmp / "fixture-skill"
    fixture_skill_dir.mkdir()
    (fixture_skill_dir / "SKILL.md").write_text(
        "---\nname: fixture-skill\ndescription: A minimal disposable skill "
        "used only as an eval-target fixture. Not a real skill.\n---\n\n"
        "# Fixture Skill\n\nPlaceholder body for eval purposes only.\n"
    )

    write_target_dir = tmp / "fixture-write-target"
    write_target_dir.mkdir()

    prompt = prompt_template.format(
        FIXTURE_SKILL_DIR=str(fixture_skill_dir),
        FIXTURE_WRITE_TARGET=str(write_target_dir),
    )
    return workdir, prompt


def run_probe(case: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        cwd, prompt = seed_env(tmp, case["prompt"])
        tool_calls, final_text = run_pi(cwd, prompt)
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
        print(f"[{status}] {result['id']} (should_trigger={case['should_trigger']})")
        for check, ok in result["checks"].items():
            print(f"    {'ok' if ok else 'FAIL'}: {check}")
        print(f"    tool_calls: {result['tool_calls']}")
        print(f"    response: {result['response'][:300]!r}")
        print()

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
