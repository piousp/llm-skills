#!/usr/bin/env python3
"""
Layer 2b (real delegation pipeline) for the iterative-design skill.

Unlike Layer 2a (run_layer2_probes.py), which asserts the *degraded* path
in bare `pi -ne` (no subagent tool -> correct refusal), this loads the real
`subagent` tool via an explicit -e path to pi-simple-agents' extension
source -- confirmed deterministic across 3 runs (Read/Bash/Edit/Write/
subagent, nothing else, no npm auto-install since -ne skips discovery).

Scope: Phase 2 -> Phase 3 only. `ask_user_question` is still not available
this way, so Phase 4/5 gates cannot be driven programmatically -- the run
is expected to STOP at the Phase 4 gate, not proceed past it. Seeds
$DESIGN_DIR with goal.md so Phase 1 (which needs an interactive interview)
is bypassed, same scoping choice as Layer 2a.

This is a real, multi-minute, real-token trial: planner (lens/planner-lens.md) runs on
fable-5/xhigh, code-implementer on sonnet. Start with N=1 to validate
harness mechanics before considering repeated trials.

Gated behind PI_LIVE_EVAL=1.

Usage:
    PI_LIVE_EVAL=1 python3 evals/run_layer2b_pipeline.py
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent

# Path to a pi extension providing a real `subagent` tool (e.g. the
# pi-simple-agents package's extensions/ dir). Not hardcoded -- this skill
# is public and must not assume any one machine's layout. Set it via env var.
_SUBAGENT_EXT_ENV = "PI_SUBAGENT_EXTENSION_PATH"
SUBAGENT_EXT = os.environ.get(_SUBAGENT_EXT_ENV)

GOAL_TEXT = (
    "Add a pure function `is_even(n: int) -> bool` to math_utils.py that "
    "returns True if n is even, False otherwise. No other behavior.\n\n"
    "Discovery outcome: trivial, single-seam scope, no ambiguity -- "
    "proceed straight to planning.\n"
)


def run_pi(cwd: Path, prompt: str, session: Path, timeout: int = 900) -> tuple[list[dict], str, str]:
    proc = subprocess.run(
        ["pi", "-ne", "-e", str(SUBAGENT_EXT), "--skill", str(SKILL_DIR),
         "--session", str(session), "--mode", "json", "-p", prompt],
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
    return tool_calls, final_text, proc.stderr


def subagent_called(tool_calls, name_fragment: str) -> bool:
    for tc in tool_calls:
        if tc["name"] != "subagent":
            continue
        args_str = json.dumps(tc["arguments"]).lower()
        if name_fragment.lower() in args_str:
            return True
    return False


def run_trial() -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=repo)
        (repo / "math_utils.py").write_text("# math utilities\n")
        subprocess.run(["git", "add", "-A"], cwd=repo)
        subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=repo)

        design_dir = Path(tmp) / "design"
        design_dir.mkdir()
        (design_dir / "goal.md").write_text(GOAL_TEXT)

        session = Path(tmp) / "session.json"
        prompt1 = (
            f"Follow the iterative-design skill (invoked by name) to continue "
            f"this already-started design. $DESIGN_DIR={design_dir}. Repo root: {repo}. "
            f"Do whatever the current design-dir state calls for, including "
            f"delegating to subagents as the skill directs. If you reach an "
            f"optional-phase gate that needs my explicit answer, stop and say so "
            f"rather than guessing."
        )
        tool_calls_1, text_1, stderr_1 = run_pi(repo, prompt1, session)

        prompt2 = (
            "Confirmed, the Phase 2 design (plan + technical) looks good. "
            "Proceed to Phase 3 (delegate to code-implementer for the TDD loop) "
            "per the skill's process."
        )
        tool_calls_2, text_2, stderr_2 = run_pi(repo, prompt2, session)

        prompt3 = (
            "Confirmed, the spec looks good. Proceed: delegate this seam to "
            "code-implementer for the TDD loop (RED then GREEN), and freeze/record "
            "the phase3-green checkpoint once it's done."
        )
        tool_calls_3, text_3, stderr_3 = run_pi(repo, prompt3, session)

        tool_calls = tool_calls_1 + tool_calls_2 + tool_calls_3
        text = text_3
        stderr = stderr_1 + stderr_2 + stderr_3

        artifacts = {}
        for f in ("plan.md", "technical.md", "spec.md", "decisions.md"):
            p = design_dir / f
            artifacts[f] = p.read_text(encoding="utf-8") if p.exists() else None

        repo_code = (repo / "math_utils.py").read_text(encoding="utf-8")
        test_files = list(repo.glob("test_*.py")) + list(repo.glob("*_test.py")) + \
            list((repo / "tests").glob("*.py")) if (repo / "tests").is_dir() else \
            list(repo.glob("test_*.py")) + list(repo.glob("*_test.py"))

        checks = {
            "delegated_to_planner": subagent_called(tool_calls, "planner"),
            "delegated_to_implementer": subagent_called(tool_calls, "code-implementer"),
            "coordinator_wrote_plan": artifacts["plan.md"] is not None,
            "coordinator_wrote_technical": artifacts["technical.md"] is not None,
            "spec_written": artifacts["spec.md"] is not None,
            "phase3_green_recorded": bool(
                artifacts["decisions.md"] and "phase3-green" in artifacts["decisions.md"].lower()
            ),
            "repo_code_changed": "is_even" in repo_code,
            "test_file_exists": len(test_files) > 0,
            "did_not_run_refactor_unasked": not (
                artifacts["decisions.md"] and
                "phase 4" in artifacts["decisions.md"].lower() and
                "decision: run" in artifacts["decisions.md"].lower()
            ),
        }

        return {
            "passed": all(checks.values()),
            "checks": checks,
            "tool_calls": [tc["name"] for tc in tool_calls],
            "response": text,
            "stderr_tail": stderr[-2000:] if stderr else "",
            "design_dir_dump": tmp,  # note: cleaned up on exit, informational only
        }


def main() -> int:
    if os.environ.get("PI_LIVE_EVAL") != "1":
        print("Skipped (set PI_LIVE_EVAL=1 to run — real multi-minute, real-token trial).")
        return 0
    if not SUBAGENT_EXT:
        print(f"Skipped: set {_SUBAGENT_EXT_ENV} to the path of a pi extension "
              f"that provides a real 'subagent' tool (e.g. the pi-simple-agents "
              f"package's extensions/ dir).")
        return 0

    result = run_trial()
    print(f"[{'PASS' if result['passed'] else 'FAIL'}] layer2b_pipeline_phase2_to_3")
    for check, ok in result["checks"].items():
        print(f"    {'ok' if ok else 'FAIL'}: {check}")
    print(f"    tool_calls: {result['tool_calls']}")
    print(f"    response: {result['response'][:500]!r}")
    if result["stderr_tail"]:
        print(f"    stderr (tail): {result['stderr_tail']}")

    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
