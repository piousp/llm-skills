#!/usr/bin/env python3
"""
Deterministic control-flow reader for the iterative-design skill.

Read-only over the design dir. Derives the current phase from
the existing artifacts on every invocation — never maintains its own state
file, so it cannot desync from <design_dir>/decisions.md (the coordinator's
single-writer log), and resuming within one session is just re-running this
script.

Design artifacts live in a per-launch temp directory, not in the repo:
/tmp (or $TMPDIR if /tmp is unusable)/iterative-design/<basename(cwd)>/<PPID>/ — no nested
`.design/` subdir, the PID dir itself holds goal.md/plan.md/technical.md/
spec.md/decisions.md directly. Because the temp dir is keyed
by the PID of the parent `pi` process, a *new launch* cannot rediscover a
prior session's temp dir on its own — that's what the `sessions` subcommand
is for: it lists candidate `<PID>/` dirs under the same repo-basename key
(mtime + derived phase each), purely so the coordinator can offer the user
a resume-or-fresh choice. This script never prompts, never decides, never
writes — listing is as far as its authority goes.

Granularity: phase-level only. It resolves *which phase* the pipeline is
in, not progress *within* a phase (e.g. which seam of Phase 3, or which
refactor candidate of Phase 4, is already done) — that would need per-seam
markers in decisions.md, which the skill's own rule ("not routine per-seam
confirmations") deliberately avoids. On resuming mid-phase, the coordinator
re-derives that finer progress from the frozen tests and the code itself.

This script is advisory: it tells the coordinator what phase/action comes
next given the artifacts on disk. It never prompts the user, never writes
anything, and never invokes subagents itself — the coordinator remains the
sole executor and the sole writer of the design dir.

Usage:
    python3 state.py next --design-dir <tmp-dir>
    python3 state.py sessions
        # lists candidate <PID>/ dirs under the repo-basename key, for the
        # coordinator's Phase 0 resume-or-fresh prompt (this script never
        # prompts itself)
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


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
    as 'Decision: run' / 'Decision: skip' / 'Decision: finish'. decisions.md
    is append-only, so when multiple headers match the same gate label, the
    LAST one in the file is authoritative (a later block can revise/reopen
    an earlier one).
    """
    header_pattern = re.compile(
        rf"^##\s+.*{re.escape(gate_label)}.*gate.*$",
        re.IGNORECASE | re.MULTILINE,
    )
    header_matches = list(header_pattern.finditer(decisions_text))
    if not header_matches:
        return None
    header_match = header_matches[-1]

    block_start = header_match.end()
    next_header = re.search(r"^##\s+", decisions_text[block_start:], re.MULTILINE)
    block_end = block_start + next_header.start() if next_header else len(decisions_text)
    block = decisions_text[block_start:block_end]

    decision_match = re.search(r"Decision:\s*(run|skip|finish)", block, re.IGNORECASE)
    if not decision_match:
        return None
    val = decision_match.group(1).lower()
    return "skip" if val == "finish" else val


def _header_matches(decisions_text: str, body_pattern: str) -> list[re.Match]:
    """Return every '## ' header line whose body matches body_pattern, in
    document order (empty list if none). Anchoring on the header line itself
    (not any prose elsewhere in decisions.md) prevents an incidental mention
    of the same words in an unrelated section from being mistaken for the
    real marker."""
    return list(re.finditer(
        rf"^##\s+.*{body_pattern}.*$", decisions_text, re.IGNORECASE | re.MULTILINE,
    ))


SKILL_DIR = Path(__file__).resolve().parent.parent


def tmp_root_dir() -> Path:
    """/tmp first; fall back to $TMPDIR only if /tmp doesn't exist or isn't
    writable."""
    tmp = Path("/tmp")
    if tmp.is_dir() and os.access(tmp, os.W_OK):
        return tmp
    fallback = os.environ.get("TMPDIR")
    return Path(fallback) if fallback else tmp


def sessions_base_dir() -> Path:
    """/tmp (or $TMPDIR if /tmp is unusable, see tmp_root_dir)/
    iterative-design/<basename(cwd)>/ — the parent of all per-launch
    <PID>/ design dirs for this repo (keyed by basename of the current
    working directory ONLY — never by any CLI argument, so this must match
    exactly how the coordinator derives $DESIGN_DIR in SKILL.md Phase 0.
    Two repos sharing a basename collide on purpose, an accepted tradeoff
    favoring a readable path over uniqueness)."""
    tmp_root = tmp_root_dir()
    return tmp_root / "iterative-design" / Path.cwd().name


def list_sessions() -> list[dict]:
    """List candidate <PID>/ design dirs under this repo's sessions base,
    newest-modified first. Each entry carries enough for the coordinator to
    present a resume-or-fresh choice to the user — this function only reads
    and reports, it never prompts or writes."""
    base = sessions_base_dir()
    if not base.is_dir():
        return []

    candidates = []
    for entry in base.iterdir():
        if not entry.is_dir():
            continue
        try:
            mtime = entry.stat().st_mtime
        except OSError:
            continue
        state = derive_state(entry)
        candidates.append({
            "pid": entry.name,
            "design_dir": str(entry),
            "mtime": mtime,
            "mtime_iso": datetime.fromtimestamp(mtime).isoformat(timespec="seconds"),
            "phase": state["phase"],
            "phase_name": state["phase_name"],
        })

    candidates.sort(key=lambda c: c["mtime"], reverse=True)
    return candidates


def stage_path(name: str) -> str:
    """Absolute path to a stages/*.md file, resolved against the skill's own
    directory (not the caller's cwd) so it works regardless of where the
    coordinator invokes the script from."""
    return str(SKILL_DIR / "stages" / name)


def derive_state(design_dir: Path) -> dict:
    """design_dir is the per-launch <PID>/ directory holding goal.md/plan.md/
    technical.md/spec.md/decisions.md directly — no nested .design/
    subdir."""
    goal = design_dir / "goal.md"
    plan = design_dir / "plan.md"
    technical = design_dir / "technical.md"
    spec = design_dir / "spec.md"
    decisions = design_dir / "decisions.md"

    decisions_text = read_text(decisions)

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
            "next_action": "delegate to planner (lens/planner-lens.md) for design; split its "
                            "returned document into plan.md + technical.md",
            "actor": "planner",
            "required_inputs": ["$DESIGN_DIR/goal.md"],
            "gate_status": None,
            "blocked_reason": None,
            "stage_file": stage_path("planner.md"),
        }

    phase3_freeze_recorded = bool(re.search(r"phase3-green", decisions_text, re.IGNORECASE))
    if not (spec.exists() and phase3_freeze_recorded):
        return {
            "phase": 3,
            "phase_name": "tdd",
            "next_action": "run/continue the vertical TDD loop (spec, RED, GREEN) "
                            "over the Phase 2 design; freeze and record phase3-green "
                            "(per `stages/tdd.md` Freeze) on completion",
            "actor": "code-implementer",
            "required_inputs": ["$DESIGN_DIR/plan.md", "$DESIGN_DIR/technical.md"],
            "gate_status": None,
            "blocked_reason": None,
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
                               "in $DESIGN_DIR/decisions.md",
            "stage_file": None,  # gate question wording lives in SKILL.md, not a stage to execute
        }

    if phase4_answer == "run":
        # Once Phase 4 actually completes, decisions.md should also carry a
        # completion marker; until then keep surfacing Phase 4 as active.
        phase4_done = bool(_header_matches(
            decisions_text, r"phase\s*4.*(complete|combined review)"))
        if not phase4_done:
            return {
                "phase": 4,
                "phase_name": "refactor",
                "next_action": "run refactor candidates, apply accepted ones, "
                                "simplification pass, one combined "
                                "code-review-checklist pass",
                "actor": "code-implementer / analyst (code-review-checklist lens)",
                "required_inputs": ["$DESIGN_DIR/plan.md", "$DESIGN_DIR/technical.md"],
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
                               "in $DESIGN_DIR/decisions.md",
            "stage_file": None,  # gate question wording lives in SKILL.md, not a stage to execute
        }

    if phase5_answer == "run":
        # Only fall through to "done" once Phase 5 actually completes (PASS);
        # a BLOCK verdict must never read as done, so this keys on an explicit
        # completion marker the coordinator writes only on PASS, mirroring
        # the Phase 4 completion check above.
        phase5_done = bool(_header_matches(decisions_text, r"phase\s*5.*complete"))
        if not phase5_done:
            return {
                "phase": 5,
                "phase_name": "qa",
                "next_action": "delegate to qa-adversary for final QA verdict "
                                "(select prompt variant per Phase 4 gate outcome)",
                "actor": "analyst (qa-adversary lens)",
                "required_inputs": ["$DESIGN_DIR/spec.md", "frozen tests", "files-touched record"],
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
    next_cmd.add_argument("--design-dir", required=True,
                           help="Per-launch design dir (the <PID>/ dir holding goal.md etc.)")

    sessions_cmd = sub.add_parser(
        "sessions",
        help="List candidate prior <PID>/ design dirs for this repo's basename key",
    )

    args = parser.parse_args()

    if args.command == "next":
        design_dir = Path(args.design_dir).resolve()
        state = derive_state(design_dir)
        print(json.dumps(state, indent=2))
        return 0

    if args.command == "sessions":
        print(json.dumps(list_sessions(), indent=2))
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
