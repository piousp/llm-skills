#!/usr/bin/env python3
"""
Layer 2 (trajectory/tool-call, process-fidelity) probes for
refactor-identification. Forced loading via `--skill <dir>` — this layer
checks HOW the skill behaves once active, not WHETHER it triggers (that's
run_trigger_probes.py).

Success criteria checked (SKILL.md step 2, defined before writing the checks):
  - Never mutates repo code — this skill identifies candidates only, it never
    executes a refactor (Boundaries section).
  - Output follows the mandatory template verbatim: Scope / Findings /
    Unresolved / Filtered out / Summary sections.
  - Every finding has file:line evidence anchored in the diff.
  - Every finding carries a gate note (checked N1–N9).
  - A genuine structural duplicate is correctly categorized A1.
  - A speculative single-implementation "candidate" is correctly filtered by
    N1 in Filtered out, not reported as a Finding (the skill's own worked
    "Filtered by the gate" example).
  - A business-rule duplicate whose occurrence count depends on a fact
    outside this repo (below threshold locally, possibly not below
    threshold elsewhere) is routed to Unresolved (N9), not silently dropped
    and not fabricated as a Finding or a Filtered-out verdict.

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


# ---- fixtures -------------------------------------------------------------

def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True)


def seed_structural_duplication_repo(tmp: Path) -> Path:
    """main has computeRefundTotal; feature branch adds a near-identical
    computeInvoiceTotal — the skill's own A1 worked example, reproduced as a
    live fixture."""
    repo = tmp / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "eval@example.com")
    _git(repo, "config", "user.name", "eval")
    (repo / "InvoiceService.java").write_text(
        "class InvoiceService {\n"
        "    double computeRefundTotal(java.util.List<LineItem> items) {\n"
        "        double total = 0;\n"
        "        for (LineItem i : items) { total += i.getAmount() * i.getQuantity(); }\n"
        "        return total;\n"
        "    }\n"
        "}\n"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "init")
    _git(repo, "checkout", "-q", "-b", "feature")
    (repo / "InvoiceService.java").write_text(
        "class InvoiceService {\n"
        "    double computeRefundTotal(java.util.List<LineItem> items) {\n"
        "        double total = 0;\n"
        "        for (LineItem i : items) { total += i.getAmount() * i.getQuantity(); }\n"
        "        return total;\n"
        "    }\n\n"
        "    double computeInvoiceTotal(java.util.List<LineItem> items) {\n"
        "        double total = 0;\n"
        "        for (LineItem i : items) { total += i.getAmount() * i.getQuantity(); }\n"
        "        return total;\n"
        "    }\n"
        "}\n"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "add computeInvoiceTotal")
    return repo


def seed_single_implementation_repo(tmp: Path) -> Path:
    """feature branch adds a single new discount rule, no second
    implementation planned — the skill's own N1-rejected worked example."""
    repo = tmp / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "eval@example.com")
    _git(repo, "config", "user.name", "eval")
    (repo / "README.md").write_text("placeholder\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "init")
    _git(repo, "checkout", "-q", "-b", "feature")
    (repo / "DiscountCalculator.java").write_text(
        "class DiscountCalculator {\n"
        "    double applyDiscount(Order order) {\n"
        "        if (order.getTotal() > 100) { return order.getTotal() * 0.9; }\n"
        "        return order.getTotal();\n"
        "    }\n"
        "}\n"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "add DiscountCalculator")
    return repo


def seed_uncertain_threshold_repo(tmp: Path) -> Path:
    """feature branch adds a second occurrence of a business-rule predicate
    already used once elsewhere in this repo (2 occurrences total, below the
    >=3 business-dup threshold) — but the prompt states a possible 3rd
    occurrence lives in another repo the agent cannot check."""
    repo = tmp / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "eval@example.com")
    _git(repo, "config", "user.name", "eval")
    (repo / "OrderValidator.java").write_text(
        "class OrderValidator {\n"
        "    boolean isEligibleForLoyaltyDiscount(Customer customer, Order order) {\n"
        "        return customer.getTier() == Tier.PREMIUM && order.getTotal() > 500;\n"
        "    }\n"
        "}\n"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "init")
    _git(repo, "checkout", "-q", "-b", "feature")
    (repo / "ShippingCalculator.java").write_text(
        "class ShippingCalculator {\n"
        "    boolean qualifiesForFreeShipping(Customer customer, Order order) {\n"
        "        return customer.getTier() == Tier.PREMIUM && order.getTotal() > 500;\n"
        "    }\n"
        "}\n"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "add qualifiesForFreeShipping")
    return repo


SEED_REGISTRY = {
    "detects_a1_structural_duplication": seed_structural_duplication_repo,
    "rejects_single_implementation_by_n1": seed_single_implementation_repo,
    "routes_uncertain_threshold_to_unresolved": seed_uncertain_threshold_repo,
}


# ---- checks -----------------------------------------------------------
# Signature: (tool_calls, final_text, **ctx) -> bool. Outcome (tool calls,
# repo state) over transcript text wherever the two diverge.

def no_repo_mutation(tool_calls, final_text, **ctx) -> bool:
    """The skill identifies candidates only — it must never edit/write any
    file inside the fixture repo (Boundaries section)."""
    repo = str(ctx["repo"])
    for tc in tool_calls:
        if tc["name"] in ("edit", "write"):
            path = str(tc["arguments"].get("path", ""))
            if repo in path:
                return False
    return True


def output_has_required_sections(tool_calls, final_text, **ctx) -> bool:
    required = ["### Scope", "### Findings", "### Unresolved", "### Filtered out", "### Summary"]
    return all(section in final_text for section in required)


def finding_has_file_line_evidence(tool_calls, final_text, **ctx) -> bool:
    return bool(re.search(r"InvoiceService\.java:\d+", final_text))


def gate_note_present(tool_calls, final_text, **ctx) -> bool:
    return "N1" in final_text and "N9" in final_text


def identifies_a1_category(tool_calls, final_text, **ctx) -> bool:
    return "A1" in final_text and "duplicat" in final_text.lower()


def cites_n1_in_filtered_out(tool_calls, final_text, **ctx) -> bool:
    low = final_text.lower()
    filtered_idx = low.find("### filtered out")
    if filtered_idx == -1:
        return False
    return "n1" in low[filtered_idx:]


def does_not_report_speculative_strategy_finding(tool_calls, final_text, **ctx) -> bool:
    low = final_text.lower()
    findings_idx = low.find("### findings")
    filtered_idx = low.find("### filtered out")
    if findings_idx == -1 or filtered_idx == -1 or filtered_idx <= findings_idx:
        return False
    findings_block = low[findings_idx:filtered_idx]
    return "[rf-" not in findings_block


def routes_uncertain_threshold_to_unresolved(tool_calls, final_text, **ctx) -> bool:
    """The fixture's business-rule predicate has only 2 occurrences inside
    this repo (below the >=3 business-dup threshold), but the prompt states
    a possible 3rd occurrence lives in another repo not available here. The
    skill must not silently drop it (evidence-ceiling rule) and must not
    fabricate a Finding or a Filtered-out verdict either — it belongs in
    Unresolved, citing the missing cross-repo fact."""
    low = final_text.lower()
    findings_idx = low.find("### findings")
    unresolved_idx = low.find("### unresolved")
    filtered_idx = low.find("### filtered out")
    if findings_idx == -1 or unresolved_idx == -1 or filtered_idx == -1:
        return False
    if not (findings_idx < unresolved_idx < filtered_idx):
        return False
    findings_block = low[findings_idx:unresolved_idx]
    unresolved_block = low[unresolved_idx:filtered_idx]
    if "[rf-" in findings_block:
        return False  # fabricated as a confirmed Finding
    if "(none)" in unresolved_block and "[rf-u" not in unresolved_block:
        return False  # silently dropped instead of flagged
    return True


CHECK_REGISTRY = {
    "no_repo_mutation": no_repo_mutation,
    "output_has_required_sections": output_has_required_sections,
    "finding_has_file_line_evidence": finding_has_file_line_evidence,
    "gate_note_present": gate_note_present,
    "identifies_a1_category": identifies_a1_category,
    "cites_n1_in_filtered_out": cites_n1_in_filtered_out,
    "does_not_report_speculative_strategy_finding": does_not_report_speculative_strategy_finding,
    "routes_uncertain_threshold_to_unresolved": routes_uncertain_threshold_to_unresolved,
}


def run_probe(case: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        repo = SEED_REGISTRY[case["id"]](tmp)
        prompt = case["prompt"].format(REPO_DIR=str(repo))
        tool_calls, final_text = run_pi(repo, prompt)
        checks = {
            check_id: CHECK_REGISTRY[check_id](tool_calls, final_text, repo=repo)
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
        print(f"    response: {result['response'][:400]!r}")
        print()

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
