#!/usr/bin/env python3
"""
Layer 2b (real analyst-carrier delegation) for the qa-adversary skill.

Unlike Layer 2 (run_layer2_probes.py), where the qa-adversary lens is
applied directly in bare `pi -ne --skill <dir>`, Layer 2b loads a real
`subagent` tool via an explicit `-e <path>` to a pi extension and drives a
coordinator that delegates the QA review to the `analyst` subagent, with
the qa-adversary skill handed over as the analyst's lens — the skill's
documented "hand it to a read-only analysis agent (e.g. analyst) as its
lens" usage. The contract is a `Lens: <SKILL_DIR>/SKILL.md` line inside the
analyst's task: the analyst agent has native lens-mode support and is
configured with `skills: ["qa-adversary"]` in this machine's settings.json,
but the harness must not hardcode that — the Lens line is the contract.

Documented limitation: the analyst's internal tool calls are NOT visible in
the coordinator's transcript. The analyst is read-only by its agent
configuration and its own hard limits prohibit test runs, but
transcript-level guardrail checks (no edit/write, no test-execution) remain
L2's job; L2b grades the delegation contract + the returned report.

Gated behind PI_LIVE_EVAL=1 AND PI_SUBAGENT_EXTENSION_PATH (skip with a
clear message when either is unset). N=1 documented: a multi-minute,
real-token trial (coordinator + analyst).

Usage:
    python3 evals/run_layer2b_pipeline.py --check     # offline: LENS_PATH + git fixture smoke
    PI_LIVE_EVAL=1 python3 evals/run_layer2b_pipeline.py
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from fixtures import git_available, seed_git_diff_coverage
from run_layer2_probes import (
    check_findings_have_failure_scenario as findings_have_failure_scenario,
    check_findings_have_file_line as findings_have_file_line,
    check_found_planted_bug as found_planted_bug,
    check_report_structure as report_structure,
    check_verdict_valid as verdict_valid,
)

EVALS_DIR = Path(__file__).resolve().parent
SKILL_DIR = EVALS_DIR.parent
LENS_PATH = SKILL_DIR / "SKILL.md"

# Path to a pi extension providing a real `subagent` tool (e.g. the
# pi-simple-agents package's extensions/ dir). Not hardcoded -- this skill
# is public and must not assume any one machine's layout. Set it via env var.
_SUBAGENT_EXT_ENV = "PI_SUBAGENT_EXTENSION_PATH"
SUBAGENT_EXT = os.environ.get(_SUBAGENT_EXT_ENV)

COORD_TIMEOUT = 900


def run_pi(cwd: Path, prompt: str, timeout: int = COORD_TIMEOUT) -> tuple[list[dict], str, list[str]]:
    """Runs pi non-interactively as the L2b coordinator: the subagent
    extension is loaded via explicit `-e` and there is deliberately NO
    --skill — the coordinator is a generic delegator; the qa-adversary lens
    goes to the analyst subagent. Returns (tool_calls, final_text,
    raw_stdout_lines). On timeout, raises RuntimeError."""
    try:
        proc = subprocess.run(
            ["pi", "-ne", "-e", str(SUBAGENT_EXT), "--mode", "json", "-p", prompt],
            cwd=str(cwd), capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"coordinator timed out after {timeout}s (prompt: {prompt!r})")
    stdout_lines = proc.stdout.splitlines()
    tool_calls: list[dict] = []
    final_text = ""
    for line in stdout_lines:
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
        # Join the last assistant message's text items; ignore thinking
        # blocks and any other content type.
        texts = [c["text"] for c in msg.get("content", []) if c.get("type") == "text"]
        if texts:
            final_text = " ".join(texts)
        for c in msg.get("content", []):
            if c.get("type") == "toolCall":
                tool_calls.append({"name": c.get("name"), "arguments": c.get("arguments", {})})
    return tool_calls, final_text, stdout_lines


def extract_subagent_report(tool_calls: list[dict], stdout_lines: list[str]) -> str | None:
    """Walks the NDJSON lines and returns the LAST subagent toolResult's
    report: prefer `message.details['runs'][0]['finalText']` (the raw
    analyst output); fall back to joining `message.content[*].text`. None
    if no subagent toolResult is found. (Empirically confirmed structure:
    message_end with role 'toolResult', content [{type: text}],
    details.runs[0].{status, finalText}.)"""
    report = None
    for line in stdout_lines:
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
        if msg.get("role") != "toolResult" or msg.get("toolName") != "subagent":
            continue
        runs = (msg.get("details") or {}).get("runs") or []
        if runs and isinstance(runs[0], dict) and runs[0].get("finalText"):
            report = runs[0]["finalText"]
            continue
        texts = [c.get("text", "") for c in msg.get("content", [])
                 if isinstance(c, dict) and c.get("type") == "text"]
        if texts:
            report = " ".join(texts)
    return report


def _subagent_run_succeeded(stdout_lines: list[str]) -> bool:
    """Scans raw stdout for a subagent toolResult whose
    details.runs[0].status == 'success'. False if absent."""
    for line in stdout_lines:
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
        if msg.get("role") != "toolResult" or msg.get("toolName") != "subagent":
            continue
        runs = (msg.get("details") or {}).get("runs") or []
        if runs and isinstance(runs[0], dict) and runs[0].get("status") == "success":
            return True
    return False


def run_trial() -> dict:
    """One live L2b trial: seed the probe-4 git fixture, drive a generic
    coordinator that delegates the QA review to the analyst subagent with
    the qa-adversary lens, and grade the delegation contract + report."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        if not git_available():
            raise RuntimeError(
                "git not available — the L2b fixture is the seeded git repo "
                "(paging.py unstaged diff + uncovered integration suite); cannot run"
            )
        repo = seed_git_diff_coverage(tmp)
        coordinator_prompt = (
            f"QA the current change in the repo at {repo} by handing the "
            f"qa-adversary skill to the analyst subagent as its lens.\n\n"
            f"1. Run the subagent tool with agent \"analyst\" and a task that "
            f"includes a \"Lens: {LENS_PATH}\" line plus these instructions: "
            f"the change to QA is the unstaged git diff in the repo at {repo} "
            f"(run git diff; the repo has no remote and no parent branch — do "
            f"not wait for one); produce the QA report in the qa-adversary "
            f"skill's output format, including the integration-coverage "
            f"assessment (the repo has an integration test suite under "
            f"tests/integration/); do not run any tests.\n"
            f"2. Do not perform the review yourself and do not modify any "
            f"file. In your final response, return the analyst's report."
        )
        tool_calls, final_text, stdout_lines = run_pi(repo, coordinator_prompt, COORD_TIMEOUT)

        subagent_calls = [tc for tc in tool_calls if tc.get("name") == "subagent"]
        delegated_args = subagent_calls[0].get("arguments") if subagent_calls else None
        subagent_args_lower = " ".join(
            json.dumps(tc.get("arguments", {})).lower() for tc in subagent_calls
        )

        checks = {
            "delegated_to_analyst": any(
                "analyst" in json.dumps(tc.get("arguments", {})).lower()
                for tc in subagent_calls
            ),
            "lens_handed": bool(
                subagent_calls
                and "lens:" in subagent_args_lower
                and ("qa-adversary" in subagent_args_lower
                     or str(LENS_PATH).lower() in subagent_args_lower)
            ),
            "analyst_run_succeeded": _subagent_run_succeeded(stdout_lines),
            "coordinator_no_mutation": not any(
                tc.get("name") in ("edit", "write", "notepad") for tc in tool_calls
            ),
        }

        report = extract_subagent_report(tool_calls, stdout_lines)
        failure_note = None
        if report is None:
            # No analyst output to grade: all report checks fail with an
            # explicit note instead of a silent vacuous pass.
            checks["report_structure"] = False
            checks["verdict_valid"] = False
            checks["findings_have_file_line"] = False
            checks["findings_have_failure_scenario"] = False
            checks["found_planted_bug_repo_04"] = False
            failure_note = "no analyst report extracted from the coordinator transcript"
        else:
            # The analyst's own tool calls are not visible in the
            # coordinator's transcript, so the report checks run with an
            # empty tool_calls list.
            checks["report_structure"] = report_structure([], report)
            checks["verdict_valid"] = verdict_valid([], report)
            checks["findings_have_file_line"] = findings_have_file_line([], report)
            checks["findings_have_failure_scenario"] = findings_have_failure_scenario([], report)
            checks["found_planted_bug_repo_04"] = found_planted_bug(
                [], report, file="paging.py",
                tokens=["size + 1", "extra element", "off-by-one"],
            )

        report_preview = (
            report[:300] if report
            else f"<no analyst report — coordinator final: {final_text[:200]!r}>"
        )[:300]

        return {
            "passed": all(checks.values()),
            "checks": checks,
            "delegated": delegated_args,
            "report_preview": report_preview,
            "tool_calls": [tc.get("name") for tc in tool_calls],
            "response": final_text[:300],
            "failure_note": failure_note,
        }


def main(argv: list[str]) -> int:
    if "--check" in argv:
        # Offline: LENS_PATH exists and the git fixture seeds with the
        # expected dirty working tree. No env vars required.
        errors: list[str] = []
        if not LENS_PATH.exists():
            errors.append(f"LENS_PATH missing: {LENS_PATH}")
        with tempfile.TemporaryDirectory() as tmp_str:
            try:
                repo = seed_git_diff_coverage(Path(tmp_str))
            except RuntimeError as exc:
                errors.append(f"seed_git_diff_coverage: {exc}")
            else:
                status = subprocess.run(
                    ["git", "status", "--porcelain"], cwd=str(repo),
                    capture_output=True, text=True,
                )
                if status.stdout.strip() != "M paging.py":
                    errors.append(f"seed_git_diff_coverage: git status --porcelain = "
                                  f"{status.stdout.strip()!r}, expected 'M paging.py'")
        if errors:
            for err in errors:
                print(f"ERROR: {err}")
            print(f"check: FAIL ({len(errors)} error(s))")
            return 1
        print("check: OK — LENS_PATH exists, git fixture seeds with dirty status 'M paging.py'")
        return 0

    if os.environ.get("PI_LIVE_EVAL") != "1":
        print("Skipped (set PI_LIVE_EVAL=1 to run — real multi-minute, "
              "real-token coordinator + analyst delegation).")
        return 0
    if not SUBAGENT_EXT:
        print(f"Skipped: set {_SUBAGENT_EXT_ENV} to the path of a pi extension "
              f"that provides a real 'subagent' tool (e.g. the pi-simple-agents "
              f"package's extensions/ dir).")
        return 0

    try:
        result = run_trial()
    except Exception as exc:
        print(f"[FAIL] layer2b_analyst_carrier (harness error: {exc})")
        return 1

    status = "PASS" if result["passed"] else "FAIL"
    print(f"[{status}] layer2b_analyst_carrier")
    for check, ok in result["checks"].items():
        print(f"    {'ok' if ok else 'FAIL'}: {check}")
    if result["failure_note"]:
        print(f"    note: {result['failure_note']}")
    print(f"    delegated: {json.dumps(result['delegated'])}")
    print(f"    report_preview: {result['report_preview']!r}")
    print(f"    tool_calls: {result['tool_calls']}")
    print(f"    response: {result['response']!r}")

    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
