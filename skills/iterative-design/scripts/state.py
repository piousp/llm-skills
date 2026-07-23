#!/usr/bin/env python3
"""
Deterministic control-flow reader for the iterative-design skill.

Read-only over .design/ and git HEAD. Derives the current phase from the
existing artifacts on every invocation — never maintains its own state file,
so it cannot desync from .design/decisions.md (the coordinator's
single-writer log), and resuming is just re-running this script: a brand
new coordinator session with zero prior context gets the correct phase back
from the artifacts alone.

Granularity: phase-level only. It resolves *which phase* the pipeline is
in, not progress *within* a phase (e.g. which seam of Phase 3, or which
refactor candidate of Phase 4, is already done) — that would need per-seam
markers in decisions.md, which the skill's own rule ("not routine per-seam
confirmations") deliberately avoids. On resuming mid-phase, the coordinator
re-derives that finer progress from the frozen tests and the code itself.

This script is advisory: it tells the coordinator what phase/action comes
next given the artifacts on disk. It never prompts the user, never writes
anything, and never invokes subagents itself — the coordinator remains the
sole executor and the sole writer of .design/.

Usage:
    python3 state.py next          # JSON: current state + next action
    python3 state.py next --dir .  # explicit repo root (default: cwd)
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def git_head(repo_root: Path) -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", str(repo_root), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        return out.stdout.strip() if out.returncode == 0 else None
    except Exception:
        return None


def gate_answer(decisions_text: str, gate_label: str) -> str | None:
    """
    Look for a recorded gate decision in decisions.md. Anchors on a '## '
    section header that names the gate (e.g. 'Phase 4 gate') and only reads
    the Decision: line within that section's block (up to the next '## '
    header), so an incidental mention of 'Phase 4' earlier in prose can't be
    mistaken for the gate's own entry. Returns 'run', 'skip', or None if no
    answer has been recorded yet. Purely mechanical — does not interpret
    ambiguous text as an answer (that judgment call belongs to the
    coordinator, per the skill's own re-ask rule).

    Contract: the coordinator must title the gate's decisions.md entry with
    a '## ' header containing both the gate_label (e.g. 'Phase 4') and the
    word 'gate' (e.g. '## Phase 4 gate (2026-01-02)'), and record the answer
    as 'Decision: run' / 'Decision: skip' / 'Decision: finish'.
    """
    header_pattern = re.compile(
        rf"^##\s+.*{re.escape(gate_label)}.*gate.*$",
        re.IGNORECASE | re.MULTILINE,
    )
    header_match = header_pattern.search(decisions_text)
    if not header_match:
        return None

    block_start = header_match.end()
    next_header = re.search(r"^##\s+", decisions_text[block_start:], re.MULTILINE)
    block_end = block_start + next_header.start() if next_header else len(decisions_text)
    block = decisions_text[block_start:block_end]

    decision_match = re.search(r"Decision:\s*(run|skip|finish)", block, re.IGNORECASE)
    if not decision_match:
        return None
    val = decision_match.group(1).lower()
    return "skip" if val == "finish" else val


SKILL_DIR = Path(__file__).resolve().parent.parent


def stage_path(name: str) -> str:
    """Absolute path to a stages/*.md file, resolved against the skill's own
    directory (not the caller's cwd/repo_root) so it works regardless of
    where the coordinator invokes the script from."""
    return str(SKILL_DIR / "stages" / name)


def derive_state(repo_root: Path) -> dict:
    design = repo_root / ".design"
    goal = design / "goal.md"
    plan = design / "plan.md"
    technical = design / "technical.md"
    spec = design / "spec.md"
    decisions = design / "decisions.md"

    decisions_text = read_text(decisions)
    head = git_head(repo_root)

    if not goal.exists():
        return {
            "phase": 1,
            "phase_name": "goal-discovery",
            "next_action": "run Phase 1 goal discovery interview with the user",
            "actor": "coordinator",
            "required_inputs": [],
            "gate_status": None,
            "blocked_reason": None,
            "stage_file": stage_path("goal-discovery.md"),
        }

    if not (plan.exists() and technical.exists()):
        return {
            "phase": 2,
            "phase_name": "planner",
            "next_action": "delegate to pablo-planner for design; split its "
                            "returned document into plan.md + technical.md",
            "actor": "pablo-planner",
            "required_inputs": [".design/goal.md"],
            "gate_status": None,
            "blocked_reason": None,
            "stage_file": stage_path("planner.md"),
        }

    phase3_hash_recorded = bool(re.search(r"phase3-green", decisions_text, re.IGNORECASE))
    if not (spec.exists() and phase3_hash_recorded):
        return {
            "phase": 3,
            "phase_name": "tdd",
            "next_action": "run/continue the vertical TDD loop (spec, RED, GREEN) "
                            "over the Phase 2 design; freeze and record phase3-green "
                            "checkpoint hash on completion",
            "actor": "pablo-implementer",
            "required_inputs": [".design/plan.md", ".design/technical.md"],
            "gate_status": None,
            "blocked_reason": None,
            "git_head": head,
            "stage_file": stage_path("tdd.md"),
        }

    # Phase 3 is done. Check the Phase 4 gate.
    phase4_answer = gate_answer(decisions_text, "Phase 4")
    if phase4_answer is None:
        return {
            "phase": 4,
            "phase_name": "refactor (gate)",
            "next_action": "ask the user the Phase 4 gate question; do nothing "
                            "until answered unambiguously",
            "actor": "coordinator",
            "required_inputs": [],
            "gate_status": "unanswered",
            "blocked_reason": "Phase 4 gate has no recorded run/skip decision "
                               "in .design/decisions.md",
            "stage_file": None,  # gate question wording lives in SKILL.md, not a stage to execute
        }

    if phase4_answer == "run":
        # Once Phase 4 actually completes, decisions.md should also carry a
        # completion marker; until then keep surfacing Phase 4 as active.
        phase4_done = bool(re.search(r"phase\s*4.*(complete|combined review)",
                                      decisions_text, re.IGNORECASE))
        if not phase4_done:
            return {
                "phase": 4,
                "phase_name": "refactor",
                "next_action": "run refactor candidates, apply accepted ones, "
                                "simplification pass, one combined "
                                "code-review-checklist pass",
                "actor": "pablo-implementer / code-review-checklist",
                "required_inputs": [".design/plan.md", ".design/technical.md"],
                "gate_status": "run",
                "blocked_reason": None,
                "stage_file": stage_path("refactor.md"),
            }

    # Phase 4 ran-and-done, or was skipped. Check the Phase 5 gate.
    phase5_answer = gate_answer(decisions_text, "Phase 5")
    if phase5_answer is None:
        return {
            "phase": 5,
            "phase_name": "qa (gate)",
            "next_action": "ask the user the Phase 5 gate question; do nothing "
                            "until answered unambiguously",
            "actor": "coordinator",
            "required_inputs": [],
            "gate_status": "unanswered",
            "blocked_reason": "Phase 5 gate has no recorded run/finish decision "
                               "in .design/decisions.md",
            "stage_file": None,  # gate question wording lives in SKILL.md, not a stage to execute
        }

    if phase5_answer == "run":
        # Only fall through to "done" once Phase 5 actually completes (PASS);
        # a BLOCK verdict must never read as done, so this keys on an explicit
        # completion marker the coordinator writes only on PASS, mirroring
        # the Phase 4 completion check above.
        phase5_done = bool(re.search(r"phase\s*5.*complete", decisions_text, re.IGNORECASE))
        if not phase5_done:
            return {
                "phase": 5,
                "phase_name": "qa",
                "next_action": "delegate to qa-adversary for final QA verdict "
                                "(select prompt variant per Phase 4 gate outcome)",
                "actor": "qa-adversary",
                "required_inputs": [".design/spec.md", "frozen tests", "implementation diff"],
                "gate_status": "run",
                "blocked_reason": None,
                "stage_file": stage_path("qa.md"),
            }

    return {
        "phase": "done",
        "phase_name": "handoff",
        "next_action": "report final handoff summary to the user",
        "actor": "coordinator",
        "required_inputs": [],
        "gate_status": None,
        "blocked_reason": None,
        "stage_file": None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    next_cmd = sub.add_parser("next", help="Report current phase and next action")
    next_cmd.add_argument("--dir", default=".", help="Repo root (default: cwd)")
    args = parser.parse_args()

    if args.command == "next":
        repo_root = Path(args.dir).resolve()
        state = derive_state(repo_root)
        print(json.dumps(state, indent=2))
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
