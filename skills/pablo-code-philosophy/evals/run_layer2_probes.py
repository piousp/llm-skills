#!/usr/bin/env python3
"""
Layer 2 (outcome) probes for `pablo-code-philosophy`.

Post-split state (OQ2, 2025-08-08): the skill's frontmatter description is
auto-trigger-capable ("Trigger when:" clause, [DO NOT] negative case,
[ALWAYS]/[DO NOT] enforcement keys), like its two new siblings
`pablo-tdd` and `pablo-code-planning`. Empirical validation of the
auto-trigger and the corresponding eval updates are deferred to a separate
step (explicit deferral) -- this harness adds no trigger probes.

Consequence for these probes: `should_trigger`/negative controls are out of
scope while trigger validation is deferred, so this harness FORCES the skill
to load via `--skill <SKILL_DIR>` and measures *behavioral outcome* instead
of discovery -- did the response/tool calls actually reflect the skill's
rules (surgical edits, stated YAGNI/KISS/DRY/SOLID rationale, pipeline
order, precedence, conflict-matrix resolutions) once loaded. This is the
same pattern as the generic `templates/run_layer2_probes.py` in
evaluating-agent-skills, not the auto-discovery pattern used for
trigger-based skills.

SANDBOXING: every trial runs inside its own temp dir; fixture files
(messy_module.py, other_module.py, server.js, order_service.py,
changes.diff, validations.scala, and a throwaway git repo) live there and
are never a real skill or a real repo file. See the incident documented in
evaluating-agent-skills/evals/README.md ("Feasibility finding") -- never
point a live probe's fixture at a real skill directory.

Gated behind PI_LIVE_EVAL=1 -- costs real LLM tokens.

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
PROMPT_SET_PATH = Path(__file__).resolve().parent / "prompt_set.json"


def run_pi(cwd: Path, prompt: str, timeout: int = 240) -> tuple[list[dict], str]:
    """`pi` with `--skill <SKILL_DIR>` forced -- trigger validation is
    deferred (OQ2), so we measure behavior once loaded, not discovery.
    Returns (tool_calls, final_response_text)."""
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
    """Fixture repo shared by every trial. Fully isolated inside tmp -- never
    a real skill or real repo file (SKILL.md step 5). Each fixture is coherent
    with the prompt that uses it -- prior N=1 run flagged fixture/prompt
    mismatches as noise (an existing-API prompt with no API, a diff over a
    nonexistent file, an FP/Scala prompt with no .scala file)."""
    workdir = tmp / "work"
    workdir.mkdir()

    # server.js -- real existing Express API for trigger_add_endpoint_existing_api
    (workdir / "server.js").write_text(
        "const express = require('express');\n"
        "const app = express();\n"
        "\n"
        "const orders = [{ id: 1, total: 42 }];\n"
        "\n"
        "app.get('/orders', (req, res) => {\n"
        "  res.json(orders);\n"
        "});\n"
        "\n"
        "app.listen(3000);\n"
        "\n"
        "module.exports = app;\n"
    )

    # order_service.py -- referenced by changes.diff, so the diff is coherent
    # with a real file (was over a nonexistent service.py before)
    (workdir / "order_service.py").write_text(
        "def old():\n"
        "    pass\n"
    )
    (workdir / "changes.diff").write_text(
        "--- a/order_service.py\n"
        "+++ b/order_service.py\n"
        "@@\n"
        "-def old():\n"
        "+def new():\n"
        "     pass\n"
    )

    (workdir / "other_module.py").write_text(
        "def unrelated():\n"
        "    return 42\n"
    )

    # messy_module.py -- committed baseline, then an uncommitted change on
    # top, inside a real git repo, giving the refactor and clean-file probes
    # a realistic repo context (was no repo at all before)
    (workdir / "messy_module.py").write_text(
        "def calc(a,b):\n"
        "    x=a+b\n"
        "    y=x*2\n"
        "    return y\n"
    )
    subprocess.run(["git", "init", "-q"], cwd=workdir, check=True)
    subprocess.run(["git", "config", "user.email", "eval@example.com"], cwd=workdir, check=True)
    subprocess.run(["git", "config", "user.name", "Eval Bot"], cwd=workdir, check=True)
    subprocess.run(["git", "add", "-A"], cwd=workdir, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "baseline"], cwd=workdir, check=True)
    (workdir / "messy_module.py").write_text(
        "def calc(a,b):\n"
        "    x=a+b\n"
        "    y=x*2\n"
        "    return y\n"
        "\n"
        "def unused_helper():\n"
        "    pass\n"
    )

    # validations.scala -- real Scala file for edge_mixed_philosophy_fp
    # (prompt asked for Scala with no .scala file present before)
    (workdir / "validations.scala").write_text(
        "object Validations {\n"
        "  def validateNonEmpty(s: String): Either[String, String] =\n"
        "    if (s.isEmpty) Left(\"empty\") else Right(s)\n"
        "\n"
        "  def validateLength(s: String): Either[String, String] =\n"
        "    if (s.length > 100) Left(\"too long\") else Right(s)\n"
        "\n"
        "  def validate(s: String): Either[String, String] =\n"
        "    validateNonEmpty(s).flatMap(validateLength)\n"
        "}\n"
    )

    return workdir


def _reads_skill_md(tool_calls: list[dict], suffix: str) -> bool:
    for tc in tool_calls:
        if tc["name"] == "read" and str(tc["arguments"].get("path", "")).endswith(suffix):
            return True
    return False


# --- CHECK_REGISTRY: one pure function per check_id (see
# evaluating-agent-skills/references/check-registry-pattern.md). Signature:
# (tool_calls, final_text, **ctx) -> bool. Now behavioral: `--skill` is
# forced, so "did it load" is no longer a question worth asking; these
# check what happened *given* it loaded.

def mentions_keywords(tool_calls, final_text, keywords=(), **ctx) -> bool:
    """Behavioral stand-in for 'the skill's judgment layer was applied':
    the response names at least one of the relevant principle/edge-case
    keywords (e.g. yagni|kiss|dry|solid, pipeline, srp, premature) instead
    of jumping straight to code/approval with no stated rationale.
    Deliberately a simple substring check -- no LLM-as-judge, per YAGNI
    (L3 is explicitly deferred, see README)."""
    text = final_text.lower()
    return any(kw.lower() in text for kw in keywords)


def no_unrelated_edits(tool_calls, final_text, allowed_files=("messy_module.py",), **ctx) -> bool:
    """No edit/write tool call may target a file outside the ones named in
    the prompt -- the skill's 'Surgical Changes' rule."""
    for tc in tool_calls:
        if tc["name"] in ("edit", "write"):
            path = str(tc["arguments"].get("path", ""))
            if not any(path.endswith(f) for f in allowed_files):
                return False
    return True


def no_file_edits(tool_calls, final_text, **ctx) -> bool:
    """For pure-review prompts: reviewing a diff shouldn't itself produce
    edit/write tool calls."""
    return not any(tc["name"] in ("edit", "write") for tc in tool_calls)


def sibling_loaded(tool_calls, final_text, sibling: str = "", **ctx) -> bool:
    """Checks for an early `read` of <sibling>/SKILL.md -- still meaningful:
    forcing this skill's load says nothing about whether a sibling skill's
    own (unforced) discovery also fires for a mixed-topic prompt."""
    if not sibling:
        return False
    return _reads_skill_md(tool_calls, f"{sibling}/SKILL.md")


CHECK_REGISTRY = {
    "mentions_keywords": mentions_keywords,
    "no_unrelated_edits": no_unrelated_edits,
    "no_file_edits": no_file_edits,
    "sibling_loaded": sibling_loaded,
}


def resolve_check(check_id: str):
    """Supports parametrized check_id conventions used in prompt_set.json:
    "sibling_loaded:<name>", "mentions_keywords:<kw1>|<kw2>|...", and
    "no_unrelated_edits:<file1>,<file2>,...". Bare check_ids fall back to
    the registry function's own defaults."""
    if check_id.startswith("sibling_loaded:"):
        _, sibling = check_id.split(":", 1)
        return lambda tc, ft, **ctx: sibling_loaded(tc, ft, sibling=sibling, **ctx)
    if check_id.startswith("mentions_keywords:"):
        _, kws = check_id.split(":", 1)
        keywords = kws.split("|")
        return lambda tc, ft, **ctx: mentions_keywords(tc, ft, keywords=keywords, **ctx)
    if check_id.startswith("no_unrelated_edits:"):
        _, files = check_id.split(":", 1)
        allowed = tuple(files.split(","))
        return lambda tc, ft, **ctx: no_unrelated_edits(tc, ft, allowed_files=allowed, **ctx)
    return CHECK_REGISTRY[check_id]


def run_probe(case: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        cwd = seed_env(tmp)
        tool_calls, final_text = run_pi(cwd, case["prompt"])
        checks = {
            check_id: resolve_check(check_id)(tool_calls, final_text)
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
        print("Skipped (set PI_LIVE_EVAL=1 to run - costs real LLM tokens).")
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
