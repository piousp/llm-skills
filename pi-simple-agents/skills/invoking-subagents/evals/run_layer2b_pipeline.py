#!/usr/bin/env python3
"""
Layer 2b — real subagent-tool probes for `invoking-subagents`.

`invoking-subagents` is a pure-markdown reference skill: no `scripts/` (no
L1 target) and no degraded-path behavior when the `subagent` tool is absent
(no L2 target either — bare `pi -ne` never exposes `subagent`, so any check
run there would be checking a tool that literally cannot be called; see
README "Why L1/L2 don't apply here"). Every case in prompt_set.json is run
directly against a real `subagent` tool, loaded via an explicit `-e <path>`
to a pi extension that provides one (e.g. pi-simple-agents' own
`extensions/` dir) — not bare discovery.

All checks below are structural/deterministic (mode exclusivity, the
8-task cap, model-format compliance) — no LLM judge (L3) needed; see
README "Why no L3".

Gated behind PI_LIVE_EVAL=1 and PI_SUBAGENT_EXTENSION_PATH. Costs real LLM
tokens: each case spawns at least one real `worker` subagent run; the
`nine_tasks_respect_cap` case alone spawns up to 9. Not part of any
default/offline suite.

Usage:
    export PI_SUBAGENT_EXTENSION_PATH=/path/to/pi-simple-agents/extensions
    PI_LIVE_EVAL=1 python3 evals/run_layer2b_pipeline.py
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
PROMPT_SET_PATH = Path(__file__).resolve().parent / "prompt_set.json"

_SUBAGENT_EXT_ENV = "PI_SUBAGENT_EXTENSION_PATH"
SUBAGENT_EXT = os.environ.get(_SUBAGENT_EXT_ENV)


def run_pi(cwd: Path, prompt: str, timeout: int = 600) -> tuple[list[dict], str]:
    proc = subprocess.run(
        ["pi", "-ne", "-e", SUBAGENT_EXT, "--skill", str(SKILL_DIR),
         "--mode", "json", "-p", prompt],
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


def _subagent_calls(tool_calls: list[dict]) -> list[dict]:
    return [tc for tc in tool_calls if tc["name"] == "subagent"]


def _model_format_valid(model) -> bool:
    """provider/modelId form, not a bare Claude-Code-style alias."""
    if not isinstance(model, str) or "/" not in model:
        return False
    return model.strip().lower() not in {"sonnet", "opus", "haiku", "fable", "inherit"}


# ── CHECK_REGISTRY: check_id -> function(tool_calls, final_text, **ctx) -> bool ──

def check_single_call_agent_mode(tool_calls, final_text, **ctx) -> bool:
    calls = _subagent_calls(tool_calls)
    if len(calls) != 1:
        return False
    args = calls[0]["arguments"]
    return "agent" in args and "task" in args and "tasks" not in args


def check_agent_is_worker(tool_calls, final_text, **ctx) -> bool:
    return any(c["arguments"].get("agent") == "worker" for c in _subagent_calls(tool_calls))


def check_parallel_tasks_array(tool_calls, final_text, **ctx) -> bool:
    return any(
        isinstance(c["arguments"].get("tasks"), list) and len(c["arguments"]["tasks"]) >= 2
        for c in _subagent_calls(tool_calls)
    )


def check_tasks_count_two(tool_calls, final_text, **ctx) -> bool:
    return any(
        isinstance(c["arguments"].get("tasks"), list) and len(c["arguments"]["tasks"]) == 2
        for c in _subagent_calls(tool_calls)
    )


def check_no_mode_mixing(tool_calls, final_text, **ctx) -> bool:
    for c in _subagent_calls(tool_calls):
        args = c["arguments"]
        if "tasks" in args and ("agent" in args or "task" in args):
            return False
    return True


def check_single_mode_model_top_level(tool_calls, final_text, **ctx) -> bool:
    for c in _subagent_calls(tool_calls):
        args = c["arguments"]
        if "tasks" not in args and "model" in args:
            return _model_format_valid(args["model"])
    return False


def check_parallel_model_per_entry(tool_calls, final_text, **ctx) -> bool:
    for c in _subagent_calls(tool_calls):
        args = c["arguments"]
        tasks = args.get("tasks")
        if isinstance(tasks, list) and len(tasks) >= 2:
            if "model" in args:
                return False  # top-level model alongside tasks is invalid
            models = [t.get("model") for t in tasks if isinstance(t, dict) and t.get("model")]
            return len(models) >= 1 and all(_model_format_valid(m) for m in models)
    return False


def check_no_top_level_model_with_tasks(tool_calls, final_text, **ctx) -> bool:
    return all(
        not ("tasks" in c["arguments"] and "model" in c["arguments"])
        for c in _subagent_calls(tool_calls)
    )


def check_model_format_valid_everywhere(tool_calls, final_text, **ctx) -> bool:
    for c in _subagent_calls(tool_calls):
        args = c["arguments"]
        if "model" in args and not _model_format_valid(args["model"]):
            return False
        for t in (args.get("tasks") or []):
            if isinstance(t, dict) and "model" in t and not _model_format_valid(t["model"]):
                return False
    return True


def check_respects_max_8_per_call(tool_calls, final_text, **ctx) -> bool:
    return all(
        not (isinstance(c["arguments"].get("tasks"), list) and len(c["arguments"]["tasks"]) > 8)
        for c in _subagent_calls(tool_calls)
    )


def check_no_subagent_call(tool_calls, final_text, **ctx) -> bool:
    return len(_subagent_calls(tool_calls)) == 0


def check_all_nine_replies_attempted(tool_calls, final_text, **ctx) -> bool:
    """Total task count across all subagent calls (single-mode call = 1,
    tasks[] call = len(tasks)) must reach 9 -- guards against the model
    silently dropping to 8 replies to dodge the cap instead of splitting
    across multiple calls."""
    total = 0
    for c in _subagent_calls(tool_calls):
        args = c["arguments"]
        tasks = args.get("tasks")
        total += len(tasks) if isinstance(tasks, list) else 1
    return total >= 9


CHECK_REGISTRY = {
    "single_call_agent_mode": check_single_call_agent_mode,
    "agent_is_worker": check_agent_is_worker,
    "parallel_tasks_array": check_parallel_tasks_array,
    "tasks_count_two": check_tasks_count_two,
    "no_mode_mixing": check_no_mode_mixing,
    "single_mode_model_top_level": check_single_mode_model_top_level,
    "parallel_model_per_entry": check_parallel_model_per_entry,
    "no_top_level_model_with_tasks": check_no_top_level_model_with_tasks,
    "model_format_valid_everywhere": check_model_format_valid_everywhere,
    "respects_max_8_per_call": check_respects_max_8_per_call,
    "no_subagent_call": check_no_subagent_call,
    "all_nine_replies_attempted": check_all_nine_replies_attempted,
}


def run_probe(case: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp_str:
        cwd = Path(tmp_str)
        tool_calls, final_text = run_pi(cwd, case["prompt"])
        checks = {
            cid: CHECK_REGISTRY[cid](tool_calls, final_text)
            for cid in case["expected_checks"]
        }
        triggered = len(_subagent_calls(tool_calls)) > 0
        trigger_ok = triggered == case["should_trigger"]
        return {
            "id": case["id"],
            "checks": checks,
            "trigger_ok": trigger_ok,
            "passed": all(checks.values()) and trigger_ok,
            "subagent_calls": [c["arguments"] for c in _subagent_calls(tool_calls)],
            "response": final_text,
        }


def main() -> int:
    if os.environ.get("PI_LIVE_EVAL") != "1":
        print("Skipped (set PI_LIVE_EVAL=1 to run — costs real LLM tokens).")
        return 0
    if not SUBAGENT_EXT:
        print(f"Skipped: set {_SUBAGENT_EXT_ENV} to a pi extension providing a real "
              f"'subagent' tool (e.g. the pi-simple-agents package's extensions/ dir).")
        return 0
    if not Path(SUBAGENT_EXT).exists():
        print(f"Skipped: {_SUBAGENT_EXT_ENV}={SUBAGENT_EXT} does not exist.")
        return 0

    prompt_set = json.loads(PROMPT_SET_PATH.read_text())
    all_passed = True
    for case in prompt_set:
        result = run_probe(case)
        if not result["passed"]:
            all_passed = False
        print(f"[{'PASS' if result['passed'] else 'FAIL'}] {result['id']}")
        print(f"    trigger_ok: {result['trigger_ok']} (should_trigger={case['should_trigger']})")
        for check, ok in result["checks"].items():
            print(f"    {'ok' if ok else 'FAIL'}: {check}")
        print(f"    subagent_calls: {json.dumps(result['subagent_calls'])[:400]}")
        print(f"    response: {result['response'][:200]!r}")
        print()

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
