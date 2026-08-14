#!/usr/bin/env python3
"""
Layer 3 (LLM-as-judge) for the qa-adversary skill's Layer 2 probes.

The deterministic checks in run_layer2_probes.py can tell you the report has
the five template sections and carries an anchored finding that names the
planted bug. They cannot tell you whether the failure scenario was actually
sound, whether the report stayed in the behavior lane (vs
code-review-checklist's style lane), or whether a clean refactor was
honestly passed instead of burned. This re-runs the probes and sends each
transcript (tool calls + final response) to a second `pi` call — without
--skill, so the judge grades the transcript on its own merits rather than
re-loading the lens — for a structured JSON verdict.

Gated behind PI_LIVE_EVAL=1 — costs real LLM tokens (2x per probe: probe +
judge call), never part of a default/offline suite. Offline wiring check via
--check.

Usage:
    python3 evals/judge.py --check     # offline: specs all reference known probes
    PI_LIVE_EVAL=1 python3 evals/judge.py --trials 3   # live: N trials per judge spec
"""
import json
import os
import re
import subprocess
import sys
from typing import Callable

sys.path.insert(0, os.path.dirname(__file__))
from run_layer2_probes import PROBES, parse_trials  # noqa: E402

JUDGE_TIMEOUT = 120
JUDGE_SCHEMA_NOTE = (
    'Respond with ONLY a single JSON object, no prose before or after, matching '
    'exactly this shape: {"passed": <bool>, "score": <int 0-100>, "notes": "<one or two sentences>"}.'
)

# ---------------------------------------------------------------- judges

BUG_CORRECTNESS_INSTRUCTIONS = {
    "logic_change_inverted_condition": (
        "The planted bug is in discounts.py: can_discount() changed the tenure check "
        "from member_since.days >= 90 to member_since.days > 90, so a member with exactly "
        "90 days of tenure is wrongly denied the loyalty discount although ticket QA-117 "
        "states the threshold is inclusive ('at least 90 days')."
    ),
    "data_handling_missing_key": (
        "The planted bug is in cart.py: total_price() replaced price_lookup.get(sku) plus "
        "a None-presence check that skips unlisted SKUs with price_lookup[sku], which raises "
        "KeyError for any SKU missing from the price catalog."
    ),
    "business_rule_threshold_vs_ticket": (
        "The planted bug is in shipping.py: free_shipping() changed order.subtotal > 75.00 "
        "to order.subtotal >= 75.00, so an order with subtotal exactly 75.00 gets free "
        "shipping although ticket SHIP-204 requires strictly over $75 ('subtotal must be "
        "greater than 75.00')."
    ),
    "repo_git_diff_coverage": (
        "The planted bug is the unstaged working-tree change in paging.py: page() changed "
        "return items[start:start + size] to return items[start:start + size + 1], returning "
        "one extra element whenever the slice extends past the page boundary (e.g. page 2 of "
        "25 items with size 10 returns 11 items). The seeded integration test "
        "tests/integration/test_paging_api.py does not cover that path."
    ),
}
BUG_CORRECTNESS_SUFFIX = (
    " Judge whether the agent's final response below identifies THAT defect — not merely a "
    "keyword mention, an adjacent finding, or a manufactured one — and backs it with a "
    "concrete, reproducible failure scenario (named inputs/state → wrong output) anchored "
    "to file:line. Pass only if the specific defect above is named and the scenario is sound."
)
LANE_DISCIPLINE = (
    "The qa-adversary skill's lane is behavior only: correctness, data handling, business "
    "rules, regressions, integration coverage. It explicitly forbids style/quality commentary "
    "— complexity, naming, abstractions, DRY/SOLID, code smells, unit-test-skeleton criticism "
    "— which belongs to code-review-checklist. Judge whether the agent's final response below "
    "contains any such style/quality commentary as a finding, recommendation, or aside. Fail "
    "if it does; pass if the report stays strictly in the behavior lane."
)
CLEAN_HONESTY = (
    "The change in the diff below is a behavior-preserving refactor: invoice_total() replaced "
    "an explicit loop over order['lines'] with sum(line['amount'] for line in order['lines']); "
    "the two are equivalent for every input, including an empty lines list. Judge whether the "
    "agent's final response below honestly reported PASS or NEEDS CLARIFICATION — stating "
    "residual risk and any NOT COVERED paths — and did NOT manufacture BLOCK/HIGH (or any) "
    "findings to look thorough. Fail if the agent invented findings or inflated severity on "
    "a behavior-preserving change."
)


def _build_judge_specs() -> list[tuple[str, Callable[[], dict], str]]:
    specs: list[tuple[str, Callable[[], dict], str]] = []
    bug_probes = (
        "logic_change_inverted_condition",
        "data_handling_missing_key",
        "business_rule_threshold_vs_ticket",
        "repo_git_diff_coverage",
    )
    for probe_id in bug_probes:
        specs.append((
            probe_id, PROBES[probe_id],
            BUG_CORRECTNESS_INSTRUCTIONS[probe_id] + BUG_CORRECTNESS_SUFFIX,
        ))
        specs.append((probe_id, PROBES[probe_id], LANE_DISCIPLINE))
    specs.append(("clean_negative_control_refactor", PROBES["clean_negative_control_refactor"], CLEAN_HONESTY))
    return specs


JUDGE_SPECS: list[tuple[str, Callable[[], dict], str]] = _build_judge_specs()


# ---------------------------------------------------------------- harness

def _final_text_from_ndjson(stdout: str) -> str:
    """Same NDJSON parse as run_layer2_probes.run_pi: text of the last
    assistant message_end event."""
    final_text = ""
    for line in stdout.splitlines():
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
    return final_text


def _parse_judge_verdict(final_text: str) -> dict | None:
    """First {...} blob (DOTALL) parsed as JSON with a bool `passed` and an
    int `score`. None on any failure so the caller can retry."""
    match = re.search(r"\{.*\}", final_text, re.DOTALL)
    if not match:
        return None
    try:
        verdict = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(verdict.get("passed"), bool) or not isinstance(verdict.get("score"), int):
        return None
    return verdict


def run_judge(judge_prompt: str, timeout: int = JUDGE_TIMEOUT) -> dict:
    """Calls pi as the judge (no --skill: the judge must grade the transcript
    on its own merits). Retries once with the same prompt on any failure to
    obtain a valid verdict; a judge failure is a FAIL, never a silent skip."""
    last_text = ""
    for _ in range(2):
        try:
            proc = subprocess.run(
                ["pi", "-ne", "--mode", "json", "-p", judge_prompt],
                capture_output=True, text=True, timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            last_text = "<judge call timed out>"
            continue
        last_text = _final_text_from_ndjson(proc.stdout)
        verdict = _parse_judge_verdict(last_text)
        if verdict is not None:
            return verdict
    return {
        "passed": False,
        "score": 0,
        "notes": f"judge did not return JSON: {last_text[:200]!r}",
    }


def _display_label(probe_id: str, instructions: str) -> str:
    if instructions == LANE_DISCIPLINE:
        return f"{probe_id} [lane-discipline]"
    if instructions == CLEAN_HONESTY:
        return f"{probe_id} [clean-honesty]"
    return f"{probe_id} [bug-correctness]"


def main(argv: list[str]) -> int:
    trials = parse_trials(argv)
    if "--check" in argv:
        missing = sorted({spec[0] for spec in JUDGE_SPECS if spec[0] not in PROBES})
        if missing:
            for probe_id in missing:
                print(f"ERROR: JUDGE_SPECS references unknown probe {probe_id!r} (not in PROBES)")
            return 1
        print(f"check: OK — {len(JUDGE_SPECS)} judge specs all reference known probes")
        return 0

    if os.environ.get("PI_LIVE_EVAL") != "1":
        print("Skipped (set PI_LIVE_EVAL=1 to run — costs real LLM tokens, 2x per probe).")
        return 0

    all_passed = True
    for probe_id, probe_fn, judge_instructions in JUDGE_SPECS:
        label = _display_label(probe_id, judge_instructions)
        passed_trials = 0
        for i in range(1, trials + 1):
            try:
                probe_result = probe_fn()
            except Exception as exc:  # probe raised (e.g. timeout) — FAIL and continue
                all_passed = False
                print(f"[FAIL] {label} trial {i}/{trials} (probe raised: {exc})")
                continue
            judge_prompt = (
                f"{judge_instructions}\n\n"
                f"--- Agent's tool calls ---\n{json.dumps(probe_result['tool_calls'])}\n\n"
                f"--- Agent's final response ---\n{probe_result['response']}\n\n"
                f"{JUDGE_SCHEMA_NOTE}"
            )
            verdict = run_judge(judge_prompt)
            status = "PASS" if verdict.get("passed") else "FAIL"
            if not verdict.get("passed"):
                all_passed = False
            else:
                passed_trials += 1
            det_failed = [cid for cid, ok in probe_result.get("checks", {}).items() if not ok]
            det_note = (f"FAIL ({', '.join(det_failed)})" if det_failed else "PASS")
            print(f"[{status}] {label} trial {i}/{trials} (deterministic checks: "
                  f"{det_note})")
            print(f"    score: {verdict.get('score')}")
            print(f"    notes: {verdict.get('notes')}")
            print()
        print(f"{label}: {passed_trials}/{trials} trials passed")
        print()

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
