#!/usr/bin/env python3
"""
Trigger probes for the qa-adversary skill: does its description route QA
prompts to it and leave its neighbours' prompts alone?

Runs bare `pi -ne --mode json -p <prompt>` with NO --skill flag, so the
skill is found by real discovery from ~/.pi/agent/skills/ (pi lists every
skill's name and description at startup and loads the body via `read`).
Trigger signal: a `read` of qa-adversary/SKILL.md, the proxy confirmed in
evaluating-agent-skills/evals/README.md ("Feasibility finding").

Every trial runs in a fresh temp dir; prompts tell the agent not to modify
files. Gated behind PI_LIVE_EVAL=1 (real tokens). Offline validation via
--check (prompt set + check self-test, no LLM).

Usage:
    python3 evals/run_trigger_probes.py --check
    PI_LIVE_EVAL=1 python3 evals/run_trigger_probes.py
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
SKILL_MD_SUFFIX = "qa-adversary/SKILL.md"
PROMPT_SET_PATH = Path(__file__).resolve().parent / "trigger_prompt_set.json"


def run_pi(cwd: Path, prompt: str, timeout: int = 180) -> tuple[list[dict], str]:
    """Bare `pi` -- NO --skill flag, so discovery/triggering is real, not
    forced. Returns (tool_calls, final_response_text)."""
    try:
        proc = subprocess.run(
            ["pi", "-ne", "--mode", "json", "-p", prompt],
            cwd=str(cwd), capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"probe timed out after {timeout}s")
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


def reads_qa_adversary_skill_md(tool_calls, final_text, **ctx) -> bool:
    for tc in tool_calls:
        if tc["name"] == "read":
            path = str(tc["arguments"].get("path", ""))
            if path.endswith(SKILL_MD_SUFFIX):
                return True
    return False


def first_skill_read_is_not_qa_adversary(tool_calls, final_text, **ctx) -> bool:
    """False only when the first read of any */SKILL.md is qa-adversary's.
    True when no SKILL.md is read."""
    for tc in tool_calls:
        if tc["name"] == "read":
            path = str(tc["arguments"].get("path", ""))
            if path.endswith("/SKILL.md"):
                return not path.endswith(SKILL_MD_SUFFIX)
    return True


CHECK_REGISTRY = {
    "reads_qa_adversary_skill_md": reads_qa_adversary_skill_md,
    "first_skill_read_is_not_qa_adversary": first_skill_read_is_not_qa_adversary,
}


def seed_env(tmp: Path, prompt: str) -> tuple[Path, str]:
    """The trial's cwd lives inside tmp. The prompt is returned literally
    (no str.format: prompts may contain braces)."""
    workdir = tmp / "work"
    workdir.mkdir()
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


def check_consistency() -> list[str]:
    errors: list[str] = []
    prompt_set = json.loads(PROMPT_SET_PATH.read_text())
    required = {"id", "prompt", "should_trigger", "expected_checks"}
    seen: set[str] = set()
    for case in prompt_set:
        cid = case.get("id", "<no id>")
        if set(case) != required:
            errors.append(f"{cid}: keys {sorted(case)} != {sorted(required)}")
            continue
        if cid in seen:
            errors.append(f"{cid}: duplicate id")
        seen.add(cid)
        if not isinstance(case["should_trigger"], bool):
            errors.append(f"{cid}: should_trigger must be bool")
            continue
        want = (
            ["reads_qa_adversary_skill_md"]
            if case["should_trigger"]
            else ["first_skill_read_is_not_qa_adversary"]
        )
        if case["expected_checks"] != want:
            errors.append(f"{cid}: expected_checks {case['expected_checks']} != {want}")

    def read(path: str) -> dict:
        return {"name": "read", "arguments": {"path": path}}

    cases = [
        ([read("/x/qa-adversary/SKILL.md")], True, False),
        ([read("/x/pablo-pr-review/SKILL.md"), read("/x/qa-adversary/SKILL.md")], True, True),
        ([], False, True),
    ]
    for i, (calls, want_reads, want_first_not) in enumerate(cases, 1):
        got_reads = reads_qa_adversary_skill_md(calls, "")
        got_first_not = first_skill_read_is_not_qa_adversary(calls, "")
        if got_reads != want_reads or got_first_not != want_first_not:
            errors.append(
                f"self-test {i}: reads={got_reads} first_not={got_first_not}, "
                f"expected reads={want_reads} first_not={want_first_not}"
            )
    return errors


def main(argv: list[str]) -> int:
    if "--check" in argv:
        errors = check_consistency()
        if errors:
            for err in errors:
                print(f"ERROR: {err}")
            print(f"check: FAIL ({len(errors)} error(s))")
            return 1
        n = len(json.loads(PROMPT_SET_PATH.read_text()))
        print(f"check: OK — {n} trigger cases valid, check self-test passed")
        return 0

    if os.environ.get("PI_LIVE_EVAL") != "1":
        print("Skipped (set PI_LIVE_EVAL=1 to run — costs real LLM tokens).")
        return 0

    prompt_set = json.loads(PROMPT_SET_PATH.read_text())
    all_passed = True
    for case in prompt_set:
        try:
            result = run_probe(case)
        except RuntimeError as exc:
            all_passed = False
            print(f"[FAIL] {case['id']} (should_trigger={case['should_trigger']})")
            print(f"    error: {exc}")
            print()
            continue
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
    sys.exit(main(sys.argv[1:]))
