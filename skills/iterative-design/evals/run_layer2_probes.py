#!/usr/bin/env python3
"""
Layer 2 (behavioral/trajectory) probes for the iterative-design skill,
scoped to what's actually runnable in a bare `pi` CLI: no `subagent` tool,
no `ask_user_question` tool (confirmed empirically — bare `pi -ne` exposes
only Read/Bash/Edit/Write). The skill's real delegation pipeline
(planner -> implementer -> green) cannot execute there, so these probes
assert the *degraded-path* behavior the skill itself mandates: "If your
harness has no subagent/delegation mechanism, say so explicitly before
proceeding rather than doing the work yourself" (SKILL.md, coordinator rule).

Gated behind PI_LIVE_EVAL=1 — costs real LLM tokens, not part of any default
offline suite. Each probe: seed a temp repo + $DESIGN_DIR, run `pi -ne
--skill <iterative-design dir> --mode json -p <prompt>`, parse the NDJSON
transcript for tool calls, grade against the probe's checks.

Usage:
    PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent


def run_pi(cwd: Path, prompt: str, timeout: int = 240) -> tuple[list[dict], str]:
    """Runs bare pi non-interactively against the skill, returns
    (tool_calls, final_response_text). tool_calls is a list of
    {"name": str, "arguments": dict}."""
    proc = subprocess.run(
        ["pi", "-ne", "--skill", str(SKILL_DIR), "--mode", "json", "-p", prompt],
        cwd=str(cwd), capture_output=True, text=True, timeout=timeout,
    )
    tool_calls = []
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


def no_repo_mutation(tool_calls, repo_files) -> bool:
    """No edit/write tool call targets any file under repo_files (i.e. the
    coordinator never authors repo code itself)."""
    for tc in tool_calls:
        if tc["name"] in ("edit", "write"):
            path = str(tc["arguments"].get("path", ""))
            if any(f in path for f in repo_files):
                return False
    return True


def mentions_missing_delegation(text: str) -> bool:
    keywords = ["subagent", "delegat", "no tengo", "no cuento con",
                "sin mecanismo", "cannot delegate", "don't have a way to delegate"]
    low = text.lower()
    return any(k in low for k in keywords)


def gate_wording_matches_phase4(text: str) -> bool:
    low = text.lower()
    has_phase4 = "phase 4" in low or "fase 4" in low
    has_optional = "optional" in low
    has_phase5_ref = "phase 5" in low or "fase 5" in low
    has_freeze_ref = "frozen" in low or "phase3-green" in low or "checkpoint" in low
    has_no_hash_ref = "commit" not in low and "hash" not in low
    return has_phase4 and (has_optional or has_phase5_ref) and has_freeze_ref and has_no_hash_ref


def invoked_state_script(tool_calls) -> bool:
    for tc in tool_calls:
        if tc["name"] == "bash":
            cmd = str(tc["arguments"].get("command", ""))
            if "state.py" in cmd and "next" in cmd:
                return True
    return False


def probe_refuses_without_delegation() -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / "repo"
        repo.mkdir()
        (repo / "utils.py").write_text("# placeholder\n")

        design_dir = Path(tmp) / "design"
        design_dir.mkdir()
        (design_dir / "goal.md").write_text(
            "Goal: add a trivial add(a, b) function to utils.py.\n"
        )

        prompt = (
            f"Follow the iterative-design skill (invoked by name) to continue "
            f"this already-started design. $DESIGN_DIR={design_dir}. Repo root: {repo}. "
            f"Do whatever the current design-dir state calls for."
        )
        tool_calls, text = run_pi(repo, prompt)

        checks = {
            "no_repo_code_mutation": no_repo_mutation(tool_calls, ["utils.py"]),
            "no_unilateral_plan_write": no_repo_mutation(tool_calls, ["plan.md", "technical.md"]),
            "announces_missing_delegation": mentions_missing_delegation(text),
        }
        return {
            "id": "refuses_without_delegation", "checks": checks,
            "passed": all(checks.values()),
            "tool_calls": [tc["name"] for tc in tool_calls], "response": text,
        }


def probe_gate_wording_faithful() -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / "repo"
        repo.mkdir()

        design_dir = Path(tmp) / "design"
        design_dir.mkdir()
        for f in ("goal.md", "plan.md", "technical.md", "spec.md"):
            (design_dir / f).write_text("placeholder\n")
        (design_dir / "decisions.md").write_text("phase3-green at abc123\n")

        prompt = (
            f"Follow the iterative-design skill (invoked by name). "
            f"$DESIGN_DIR={design_dir}. Repo root: {repo}. "
            f"What's next given the design-dir state? Do whatever it calls for."
        )
        tool_calls, text = run_pi(repo, prompt)

        checks = {
            "asked_gate_not_decided_unilaterally": no_repo_mutation(tool_calls, ["decisions.md"]),
            "gate_wording_faithful": gate_wording_matches_phase4(text),
        }
        return {
            "id": "gate_wording_faithful", "checks": checks,
            "passed": all(checks.values()),
            "tool_calls": [tc["name"] for tc in tool_calls], "response": text,
        }


def probe_state_derivation_is_mechanical() -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / "repo"
        repo.mkdir()

        design_dir = Path(tmp) / "design"
        design_dir.mkdir()
        (design_dir / "goal.md").write_text("Goal: placeholder.\n")

        prompt = (
            f"Follow the iterative-design skill (invoked by name). "
            f"$DESIGN_DIR={design_dir}. Repo root: {repo}. "
            f"What phase are we in and what's next?"
        )
        tool_calls, text = run_pi(repo, prompt)

        checks = {"invoked_state_script": invoked_state_script(tool_calls)}
        return {
            "id": "state_derivation_is_mechanical", "checks": checks,
            "passed": all(checks.values()),
            "tool_calls": [tc["name"] for tc in tool_calls], "response": text,
        }


PROBES = [
    probe_refuses_without_delegation,
    probe_gate_wording_faithful,
    probe_state_derivation_is_mechanical,
]


def main() -> int:
    if os.environ.get("PI_LIVE_EVAL") != "1":
        print("Skipped (set PI_LIVE_EVAL=1 to run — costs real LLM tokens).")
        return 0

    all_passed = True
    for probe in PROBES:
        result = probe()
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
