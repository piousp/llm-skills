#!/usr/bin/env python3
"""
Layer 2 (trigger-only) probes for refactor-identification.

Classification (evaluating-agent-skills SKILL.md step 1): this skill has a
real "when" clause plus explicit negative cases in its description (TRIGGER:
"deciding if a refactor belongs in this branch"... SKIP: "renames, trivial
extraction, executing fixes, whole-repo scans, merge gating"). Unlike a
name-only-invoked skill (iterative-design), should_trigger is a real,
checkable axis here — this probe set is the highest-value first layer
(evaluating-agent-skills SKILL.md step 4).

Trigger signal: an early `read` of THIS skill's own SKILL.md, run via bare
`pi` with NO --skill flag (real discovery, not forced loading) — the same
proxy evaluating-agent-skills/evals/run_trigger_probes.py validated
empirically.

SANDBOXING: every prompt targets a path inside the trial's own temp dir,
never a real file/skill outside it, so any writes triggered by a
should_trigger:false case that DOES fire on the wrong skill stay contained.

FIXTURE NOTE: `positive_branch_refactor_question` gets a real git repo (a
`feature` branch with an actual diff against `main`) instead of an empty
workdir — a first pass with an empty workdir produced a false negative
(the model ran an environment probe, found no repo, and asked for a path
without ever reading this skill's SKILL.md). See evals/README.md.

Gated behind PI_LIVE_EVAL=1 — costs real LLM tokens.

Usage:
    PI_LIVE_EVAL=1 python3 evals/run_trigger_probes.py
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL_MD_SUFFIX = "refactor-identification/SKILL.md"
PROMPT_SET_PATH = Path(__file__).resolve().parent / "trigger_prompt_set.json"


def run_pi(cwd: Path, prompt: str, timeout: int = 180) -> tuple[list[dict], str]:
    """Bare `pi` — NO --skill flag, so discovery/triggering is real, not
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


def reads_refactor_identification_skill_md(tool_calls, final_text, **ctx) -> bool:
    for tc in tool_calls:
        if tc["name"] == "read":
            path = str(tc["arguments"].get("path", ""))
            if path.endswith(SKILL_MD_SUFFIX):
                return True
    return False


def does_not_read_refactor_identification_skill_md(tool_calls, final_text, **ctx) -> bool:
    return not reads_refactor_identification_skill_md(tool_calls, final_text, **ctx)


CHECK_REGISTRY = {
    "reads_refactor_identification_skill_md": reads_refactor_identification_skill_md,
    "does_not_read_refactor_identification_skill_md": does_not_read_refactor_identification_skill_md,
}


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True)


def seed_generic(tmp: Path, prompt_template: str) -> tuple[Path, str]:
    """Default fixture for cases with no repo-specific needs. Every fixture
    lives inside tmp — never a real repo/skill dir."""
    workdir = tmp / "work"
    workdir.mkdir()

    write_target_dir = tmp / "fixture-write-target"
    write_target_dir.mkdir()
    (write_target_dir / "DiscountCalculator.java").write_text(
        "class DiscountCalculator {\n"
        "    double applyDiscount(Order order) {\n"
        "        if (order.getTotal() > 100) { return order.getTotal() * 0.9; }\n"
        "        return order.getTotal();\n"
        "    }\n"
        "}\n"
    )

    prompt = prompt_template.format(FIXTURE_WRITE_TARGET=str(write_target_dir))
    return workdir, prompt


def seed_branch_with_real_diff(tmp: Path, prompt_template: str) -> tuple[Path, str]:
    """Non-empty-workdir fixture for `positive_branch_refactor_question`: a
    real git repo, on a `feature` branch with an actual diff against `main`
    touching OrderService.java and PaymentService.java (matching what the
    prompt describes), so the model can't short-circuit on "no repo here"
    before ever considering which skill applies."""
    repo = tmp / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "eval@example.com")
    _git(repo, "config", "user.name", "eval")
    (repo / "OrderService.java").write_text(
        "class OrderService {\n"
        "    double computeTotal(java.util.List<LineItem> items) {\n"
        "        double total = 0;\n"
        "        for (LineItem i : items) { total += i.getAmount() * i.getQuantity(); }\n"
        "        return total;\n"
        "    }\n"
        "}\n"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "init")
    _git(repo, "checkout", "-q", "-b", "feature")
    (repo / "PaymentService.java").write_text(
        "class PaymentService {\n"
        "    double computeTotal(java.util.List<LineItem> items) {\n"
        "        double total = 0;\n"
        "        for (LineItem i : items) { total += i.getAmount() * i.getQuantity(); }\n"
        "        return total;\n"
        "    }\n"
        "}\n"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "add PaymentService")
    return repo, prompt_template.format(FIXTURE_WRITE_TARGET=str(repo))


SEED_REGISTRY = {
    "positive_branch_refactor_question": seed_branch_with_real_diff,
}


def seed_env(case_id: str, tmp: Path, prompt_template: str) -> tuple[Path, str]:
    seed_fn = SEED_REGISTRY.get(case_id, seed_generic)
    return seed_fn(tmp, prompt_template)


def run_probe(case: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        cwd, prompt = seed_env(case["id"], tmp, case["prompt"])
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
