#!/usr/bin/env python3
"""
Layer 2 (trajectory/tool-call probe) harness for the `writing-agent-skills`
skill. Seeds an isolated temp dir, runs bare `pi -ne --skill <this skill>
--mode json -p <prompt>` for each case in prompt_set.json, and grades the
transcript with deterministic checks.

Gated behind PI_LIVE_EVAL=1 — costs real LLM tokens.

Usage:
    PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
PROMPT_SET_PATH = Path(__file__).resolve().parent / "prompt_set.json"


def run_pi(cwd: Path, prompt: str, timeout: int = 240) -> tuple[list[dict], str]:
    """Runs bare pi non-interactively against the skill, returns
    (tool_calls, final_response_text)."""
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
    """Fresh isolated dir per trial -- no shared state between prompts."""
    workdir = tmp / "work"
    workdir.mkdir()
    return workdir


# ---- helpers -----------------------------------------------------------

def _written_contents(tool_calls: list[dict], path_suffix: str) -> list[str]:
    out = []
    for tc in tool_calls:
        if tc["name"] not in ("write", "edit"):
            continue
        args = tc["arguments"]
        path = str(args.get("path", ""))
        if path.endswith(path_suffix):
            content = args.get("content", "")
            if not content and "edits" in args:
                content = " ".join(e.get("newText", "") for e in args.get("edits", []))
            out.append(content)
    return out


# ---- checks (check_id -> function(tool_calls, final_text, **ctx) -> bool) ----

def creates_skill_md(tool_calls, final_text, **ctx) -> bool:
    return bool(_written_contents(tool_calls, "SKILL.md"))


def frontmatter_valid(tool_calls, final_text, **ctx) -> bool:
    for content in _written_contents(tool_calls, "SKILL.md"):
        if re.match(r"^---\s*\nname:.*\ndescription:", content, re.DOTALL):
            return True
    return False


def description_has_what_and_when(tool_calls, final_text, **ctx) -> bool:
    for content in _written_contents(tool_calls, "SKILL.md"):
        m = re.search(r"description:\s*(.+?)\n---", content, re.DOTALL)
        desc = (m.group(1) if m else "").lower()
        if not desc:
            continue
        has_when = "when" in desc or "use for" in desc or "use when" in desc
        has_what = len(desc.split()) > 8
        if has_when and has_what:
            return True
    return False


def flags_vague_description(tool_calls, final_text, **ctx) -> bool:
    t = final_text.lower()
    return any(w in t for w in ["vague", "too generic", "won't trigger", "will not trigger", "trigger reliably"])


def recommends_reference_split(tool_calls, final_text, **ctx) -> bool:
    t = final_text.lower()
    return "references/" in t or ("split" in t and "topic" in t)


def improves_vague_description(tool_calls, final_text, **ctx) -> bool:
    t = final_text.lower()
    return ("when" in t) and any(w in t for w in ["rewrite", "instead", "try:", "better:", "suggest"])


def flags_missing_negative_case(tool_calls, final_text, **ctx) -> bool:
    t = final_text.lower()
    return any(w in t for w in ["negative case", "do not use", "not for", "should not"])


def recommends_freedom_over_steps(tool_calls, final_text, **ctx) -> bool:
    t = final_text.lower()
    return any(w in t for w in ["goal", "constraint"]) and ("step" in t)


def correctly_relaxes_description_requirement(tool_calls, final_text, **ctx) -> bool:
    t = final_text.lower()
    return "accurate" in t and any(w in t for w in ["not need", "doesn't need", "moot", "no need", "not optimiz"])


def mentions_retirement_process(tool_calls, final_text, **ctx) -> bool:
    t = final_text.lower()
    return "retire" in t and ("without the skill" in t or "unaided" in t or "base model" in t)


def defers_to_evaluating_agent_skills(tool_calls, final_text, **ctx) -> bool:
    return "evaluating-agent-skills" in final_text


def no_skill_authoring_artifact(tool_calls, final_text, **ctx) -> bool:
    for tc in tool_calls:
        if tc["name"] in ("write", "edit"):
            path = str(tc["arguments"].get("path", ""))
            if path.endswith("SKILL.md"):
                return False
    return True


CHECK_REGISTRY = {
    "creates_skill_md": creates_skill_md,
    "frontmatter_valid": frontmatter_valid,
    "description_has_what_and_when": description_has_what_and_when,
    "flags_vague_description": flags_vague_description,
    "recommends_reference_split": recommends_reference_split,
    "improves_vague_description": improves_vague_description,
    "flags_missing_negative_case": flags_missing_negative_case,
    "recommends_freedom_over_steps": recommends_freedom_over_steps,
    "correctly_relaxes_description_requirement": correctly_relaxes_description_requirement,
    "mentions_retirement_process": mentions_retirement_process,
    "defers_to_evaluating_agent_skills": defers_to_evaluating_agent_skills,
    "no_skill_authoring_artifact": no_skill_authoring_artifact,
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
