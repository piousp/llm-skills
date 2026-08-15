#!/usr/bin/env python3
"""
Layer 2 (trajectory/tool-call probe) harness for the `agent-prompting` skill.

agent-prompting is an **auto-triggered guide skill**: it loads when the
coordinator is about to send a prompt to a subagent and shapes the
delegation message (flow map, prompt anatomy, per-type templates,
delegate-vs-do criteria). Unlike the old prompt-generator, it is NOT
invoked by name and it does NOT run a confirm/adjust loop -- there is no
fenced "sharpened prompt" deliverable. What this harness checks is
**delegation-prompt quality**: does the agent, when handed a delegation
task, produce a prompt that carries the skill's load-bearing elements
(objective, output contract, stop rule, fail-closed lens handling,
inline contract for web-only agents, one lens per invocation, transparency
discipline) without mutating the repo or scanning unboundedly?

Cases are single-turn (`"prompt"`) or, when the interaction needs a
confirmation turn, multi-turn (`"turns"`: a list of user messages driven
sequentially against the same `pi --session`, see run_case()).

Gated behind PI_LIVE_EVAL=1 -- costs real LLM tokens.

Usage:
    PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py

Note on the auto-trigger axis: probes run with `--skill SKILL_DIR` (forced
load) and therefore validate prompt QUALITY, not description-triggering.
The real auto-trigger (skill loading without an explicit invocation) is
probed separately after sync to ~/.pi/agent/skills/ (see evals/README.md).
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
PROMPT_SET_PATH = Path(__file__).resolve().parent / "prompt_set.json"

# Read/search-type tool names bare `pi -ne` exposes without extensions.
SCAN_TOOL_NAMES = {"read", "grep", "find", "ls", "bash"}
MUTATION_TOOL_NAMES = {"edit", "write"}


# --------------------------------------------------------------------------
# pi driving
# --------------------------------------------------------------------------

def run_pi_turn(cwd: Path, prompt: str, session: Path, timeout: int = 240) -> tuple[list[dict], str]:
    """Runs one turn of bare pi against the skill, reusing `session` across
    turns of the same case via --session. Returns (tool_calls, final_text)
    for this turn only."""
    proc = subprocess.run(
        ["pi", "-ne", "--skill", str(SKILL_DIR), "--session", str(session),
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


def run_case(case: dict, cwd: Path) -> list[dict]:
    """Drives every turn of a case (single-`prompt` or multi-`turns`)
    sequentially against the same session file. Returns a list of turn
    records: {"user": str, "tool_calls": list[dict], "text": str}."""
    turns = case.get("turns") or [case["prompt"]]
    with tempfile.TemporaryDirectory() as session_tmp:
        session = Path(session_tmp) / "session.json"
        records = []
        for user_msg in turns:
            tool_calls, text = run_pi_turn(cwd, user_msg, session)
            records.append({"user": user_msg, "tool_calls": tool_calls, "text": text})
        return records


# --------------------------------------------------------------------------
# fixture seeding -- one small repo per case family, keyword-neutral and
# isolated per trial (fresh tmp dir every run).
# --------------------------------------------------------------------------

def _write(repo: Path, rel: str, content: str) -> None:
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)


def _seed_review_repo(repo: Path) -> None:
    """Fixture for review_delegation: a git repo with a committed baseline
    and an uncommitted working-tree change (the diff under review)."""
    _write(repo, "app/payments.py", "def charge(amount):\n    return amount * 1\n")
    subprocess.run(["git", "init", "-q"], cwd=str(repo), check=False)
    subprocess.run(["git", "add", "-A"], cwd=str(repo), check=False)
    subprocess.run(["git", "-c", "user.email=e@x", "-c", "user.name=e",
                    "commit", "-qm", "baseline"], cwd=str(repo), check=False)
    _write(repo, "app/payments.py",
           "def charge(amount):\n    return amount  # TODO: round to 2 decimals\n")


FIXTURES = {
    "web_search_delegation": lambda repo: None,  # web task: no repo needed
    "planning_delegation": lambda repo: (
        _write(repo, "app/payments.py", "def charge(amount):\n    return amount\n"),
        _write(repo, "goal.md",
               "GOAL: refactor app/payments.py to use the new pipeline, keep tests green.\n"),
        _write(repo, "decisions.md",
               "Decision: migrate payments to the new pipeline in two seams; keep existing\n"
               "tests green; no API breakage.\n"),
    ),
    "implementation_delegation": lambda repo: (
        _write(repo, "app/payments.py",
               "def validate_amount(amount):\n    return amount > 0\n\n"
               "def charge(amount):\n    validate_amount(amount)\n    return amount\n"),
        _write(repo, "tests/test_payments.py", "def test_charge_valid():\n    assert True\n"),
        _write(repo, "plan.md",
               "# Plan (approved)\n"
               "## Seam 2: extract validate_amount()\n"
               "Move validate_amount() from app/payments.py to app/validation.py; "
               "keep behavior identical; add boundary tests.\n"
               "Verification: existing tests pass; new tests cover amount <= 0.\n"),
    ),
    "review_delegation": _seed_review_repo,
    "transparency_step": lambda repo: None,
    "negative_no_delegation": lambda repo: (
        _write(repo, "app/utils.py", "def get_user(user_id):\n    return {'id': user_id}\n"),
    ),
}

# Per-case context handed to checks.
CASE_CTX = {
    "review_delegation": {
        "lenses": ["code-review-checklist", "qa-adversary", "refactor-identification",
                   "pablo-code-philosophy", "pablo-tdd", "pablo-code-planning"],
    },
}


def seed_env(tmp: Path, case: dict) -> Path:
    repo = tmp / "repo"
    repo.mkdir()
    seeder = FIXTURES.get(case["id"])
    if seeder:
        seeder(repo)
    return repo


def _hash_tree(repo: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(repo.rglob("*")):
        if p.is_file():
            h.update(str(p.relative_to(repo)).encode())
            h.update(p.read_bytes())
    return h.hexdigest()


# --------------------------------------------------------------------------
# shared helpers
# --------------------------------------------------------------------------

FENCE_RE = re.compile(r"```[a-zA-Z]*\n(.*?)```", re.DOTALL)


def _fenced_blocks(text: str) -> list[str]:
    return [m.strip() for m in FENCE_RE.findall(text or "")]


def _all_tool_calls(turns: list[dict]) -> list[dict]:
    return [tc for t in turns for tc in t["tool_calls"]]


def _all_text(turns: list[dict]) -> str:
    return " \n".join(t["text"] for t in turns)


# Signals that identify the skill's delegation scaffolding in the produced
# prompt (the templates ship in references/; prompts are produced in
# English, the subagents' working language).
SKILL_SIGNALS = (
    "objective", "objetivo", "output contract", "contrato de salida",
    "stop rule", "regla de parada", "limits", "limites",
    "use when", "fail-closed", "fail closed", "no results",
    "could not verify", "no pude verificar", "lens: read and apply",
    "if you cannot read it", "make no changes",
    "independent sources", "fuentes independientes",
    # T2 (option a, planner without a lens) vocabulary: the template
    # carries the contract as Goal verbatim / Decisions and constraints /
    # Out of scope / open questions, not as objective/output contract.
    "out of scope", "fuera de alcance", "open questions",
    "preguntas abiertas", "verbatim", "never invent",
    "nunca inventes", "no inventes",
)


def _skill_signal_count(text: str) -> int:
    low = (text or "").lower()
    return sum(1 for s in SKILL_SIGNALS if s in low)


# --------------------------------------------------------------------------
# CHECK_REGISTRY -- one function per check_id, signature:
#   (turns: list[dict], final_text: str, **ctx) -> bool
# `turns` is the full turn record (single-turn cases have one entry).
# --------------------------------------------------------------------------

def check_auto_triggered(turns, final_text, **ctx) -> bool:
    """The produced text carries the skill's delegation scaffolding (proxy
    for the skill having applied its guide): at least two distinct signals."""
    return _skill_signal_count(_all_text(turns)) >= 2


def check_has_objective(turns, final_text, **ctx) -> bool:
    text = _all_text(turns).lower()
    return any(k in text for k in (
        "objective", "objetivo", "research question", "goal (verbatim",
        "goal verbatim", "implement", "revis", "audit", "review the change",
    ))


def check_has_output_contract(turns, final_text, **ctx) -> bool:
    text = _all_text(turns).lower()
    return any(k in text for k in (
        "output contract", "contrato de salida", '"claims"', '"verdict"',
        "veredicto", "execution summary", "json", "plan document",
        "deliverable", "verification", "verificación", "open questions",
        "preguntas abiertas", "status:", "corroboration",
    ))


def check_has_stop_rule(turns, final_text, **ctx) -> bool:
    text = _all_text(turns).lower()
    return any(k in text for k in (
        "stop rule", "regla de parada", "whichever comes first",
        "lo que ocurra primero", "10 tool calls", "ceiling", "techo",
        "independent sources", "fuentes independientes", "queries",
    ))


def check_contract_inline_for_web(turns, final_text, **ctx) -> bool:
    """Web-scout delegation: the output contract must be INLINE. The
    process finding showed an unreadable lens stalling the delegation;
    inline keeps the contract visible in the transparency preview and
    portable (read was later granted to web-scout but inline stays by
    design). Fails if the prompt passes a local lens path to a web-only
    agent."""
    text = _all_text(turns)
    low = text.lower()
    if re.search(r"lens:\s*/[^\s]+", low):
        return False
    return any(k in low for k in (
        '"claims"', "could_not_verify", "urls_attempted", "independent_sources",
        "corroboration", "query", "search",
    ))


def check_fail_closed_lens(turns, final_text, **ctx) -> bool:
    """Lens-based delegation (planner/implementer/analyst): fail-closed
    wording -- no lens, no work."""
    text = _all_text(turns).lower()
    return any(k in text for k in (
        "if you cannot read it", "if unreadable", "make no changes and say so",
        "stop and report", "cannot read it, make no changes", "fail-closed",
        "fail closed", "no hagas cambios", "si no puedes leer",
    ))


def check_lens_single(turns, final_text, **ctx) -> bool:
    """One lens per invocation (review lane rule). Counts only the lens
    applied in the delegated prompt: occurrences inside a fenced block
    (the quoted prompt), falling back to "read and apply <lens>" in the
    whole text. Mentions in justification prose do not count."""
    lenses = ctx.get("lenses") or []
    if not lenses:
        return True
    text = _all_text(turns)
    low = text.lower()
    blocks = _fenced_blocks(text)
    scope = "\n".join(blocks).lower() if blocks else low
    applied = [l for l in lenses if l.lower() in scope]
    if not blocks:
        # fallback: only count a lens when it appears as an applied lens
        applied = [l for l in lenses if f"read and apply {l}" in low]
    return len(applied) <= 1


def check_prompt_sent_is_shown(turns, final_text, **ctx) -> bool:
    """Transparency discipline: the exact prompt is shown before sending
    (the verbatim question, or a quoted block carrying the delegation
    prompt)."""
    text = _all_text(turns)
    low = text.lower()
    if "¿muestro el prompt antes de delegar?" in low:
        return True
    if len(_fenced_blocks(text)) >= 1 and _skill_signal_count(text) >= 2:
        return True
    return False


def check_answered_directly(turns, final_text, **ctx) -> bool:
    """Negative case: a task the coordinator does directly must NOT get
    delegation scaffolding (skill's [DO NOT] clause)."""
    return _skill_signal_count(_all_text(turns)) < 2


def check_case_fail_closed(turns, final_text, **ctx) -> bool:
    """Case-level fail-closed for planning (T2, option a): contracts the
    goal does not support surface as open questions; [NEVER] invent them.
    The planner selects its lens internally, so the lens-read fail-closed
    of T3/T4 does not apply here."""
    text = _all_text(turns).lower()
    return any(k in text for k in (
        "open questions", "preguntas abiertas", "surface them as open",
        "never invent", "no inventes", "nunca inventes",
        "cannot support", "no soporta",
    ))


def check_no_mutation(turns, final_text, **ctx) -> bool:
    repo = ctx.get("repo")
    before_hash = ctx.get("before_hash")
    after_hash = _hash_tree(repo) if repo else None
    for tc in _all_tool_calls(turns):
        if tc["name"].lower() in MUTATION_TOOL_NAMES:
            return False
    if repo and before_hash is not None and after_hash != before_hash:
        return False
    return True


def check_scan_bounded(turns, final_text, **ctx) -> bool:
    """Preparing the delegation prompt may scan (read goal.md, the diff),
    but stays bounded: at most 8 scan tool calls in the first turn."""
    scan_calls = 0
    for t in turns[:1]:
        for tc in t["tool_calls"]:
            if tc["name"].lower() in SCAN_TOOL_NAMES:
                scan_calls += 1
    return scan_calls <= 8


CHECK_REGISTRY = {
    "auto_triggered": check_auto_triggered,
    "has_objective": check_has_objective,
    "has_output_contract": check_has_output_contract,
    "has_stop_rule": check_has_stop_rule,
    "contract_inline_for_web": check_contract_inline_for_web,
    "fail_closed_lens": check_fail_closed_lens,
    "case_fail_closed": check_case_fail_closed,
    "lens_single": check_lens_single,
    "prompt_sent_is_shown": check_prompt_sent_is_shown,
    "answered_directly": check_answered_directly,
    "no_mutation": check_no_mutation,
    "scan_bounded": check_scan_bounded,
}


def run_probe(case: dict, trials: int = 3) -> dict:
    """Runs the case `trials` times (default 3, per evaluating-agent-skills
    step 5 -- N=1 single-trial granularity is unreliable for agent output).
    Each check passes by MAJORITY across trials; the returned transcript is
    the best trial (first one that passed all checks), which the L3 judge
    evaluates."""
    trial_results = []
    for _ in range(trials):
        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            repo = seed_env(tmp, case)
            before_hash = _hash_tree(repo)
            turns = run_case(case, repo)
            after_hash = _hash_tree(repo)

            ctx = dict(CASE_CTX.get(case["id"], {}))
            ctx["repo"] = repo
            ctx["before_hash"] = before_hash

            final_text = turns[-1]["text"] if turns else ""
            checks = {
                check_id: CHECK_REGISTRY[check_id](turns, final_text, **ctx)
                for check_id in case["expected_checks"]
            }
            trial_results.append({
                "checks": checks,
                "passed": all(checks.values()),
                "mutated": before_hash != after_hash,
                "turns": [{"user": t["user"],
                           "tool_calls": [tc["name"] for tc in t["tool_calls"]],
                           "text": t["text"][:400], "full_text": t["text"]} for t in turns],
            })

    threshold = (trials + 1) // 2
    majority = {}
    for check_id in case["expected_checks"]:
        majority[check_id] = sum(1 for r in trial_results if r["checks"][check_id]) >= threshold
    best = next((r for r in trial_results if r["passed"]), trial_results[0])
    return {
        "id": case["id"],
        "should_trigger": case.get("should_trigger", True),
        "checks": majority,
        "passed": all(majority.values()),
        "trials": [{"passed": r["passed"], "mutated": r["mutated"],
                     "fails": [cid for cid, ok in r["checks"].items() if not ok]}
                    for r in trial_results],
        "turns": best["turns"],
        "mutated": best["mutated"],
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
        print(f"[{status}] {result['id']} (should_trigger={result['should_trigger']})")
        for i, t in enumerate(result["trials"]):
            print(f"    trial {i}: {'PASS' if t['passed'] else 'FAIL'} "
                  f"fails={t['fails']} mutated={t['mutated']}")
        for check, ok in result["checks"].items():
            print(f"    {'ok' if ok else 'FAIL'}: {check}")
        for i, t in enumerate(result["turns"]):
            print(f"    turn {i}: user={t['user'][:80]!r} tool_calls={t['tool_calls']}")
            print(f"        response: {t['text']!r}")
        print(f"    mutated fixture repo: {result['mutated']}")
        print()

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
