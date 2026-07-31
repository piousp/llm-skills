#!/usr/bin/env python3
"""
Layer 2 (trajectory/tool-call probe) harness for the `prompt-generator` skill.

prompt-generator is a **preference skill**, always invoked by explicit name
(see SKILL.md's opening line) -- there is no `should_trigger`/description-
tuning axis to test here (see evaluating-agent-skills/SKILL.md step 1). What
this harness checks instead is **process fidelity**: fast bounded scan ->
propose a reformulation -> wait for confirm/adjust loop -> emit the final
fenced block only after explicit confirmation -> don't continue the task
unless explicitly told to.

Handles both single-turn cases (`"prompt"`) and multi-turn cases (`"turns"`:
a list of user messages driven sequentially against the same `pi --session`,
see run_case()). The `turns` field is a deviation from the
evaluating-agent-skills/templates/prompt_set.json schema, documented in this
skill's evals/README.md, not in the JSON itself (JSON has no comments).

Gated behind PI_LIVE_EVAL=1 -- costs real LLM tokens.

Usage:
    PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py
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
# (Confirmed empirically in iterative-design/evals: Read/Bash/Edit/Write/
# Grep/find/ls are the bare toolset -- no ask_user_question, no subagent.)
SCAN_TOOL_NAMES = {"read", "grep", "find", "ls", "bash"}
MUTATION_TOOL_NAMES = {"edit", "write"}

CONFIRM_WORDS = ("confirmed", "confirm", "looks good", "go ahead", "yes, do it")
ADJUST_WORDS = ("adjust:", "adjust ")


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
# fixture seeding -- one small repo per prompt family, keyword-neutral
# (never contains the literal words a grader looks for, e.g. "assumption",
# "confirmed") and isolated per trial (fresh tmp dir every run).
# --------------------------------------------------------------------------

def _write(repo: Path, rel: str, content: str) -> None:
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)


FIXTURES = {
    "scant_perf": lambda repo: (
        _write(repo, "app/main.py", "def handle_request(req):\n    return process(req)\n"),
        _write(repo, "app/process.py", "def process(req):\n    return req\n"),
    ),
    "scant_caching": lambda repo: (
        _write(repo, "app/api.py", "def get_user(user_id):\n    return db_lookup(user_id)\n"),
        _write(repo, "app/db.py", "def db_lookup(user_id):\n    return {'id': user_id}\n"),
    ),
    "scant_flaky": lambda repo: (
        _write(repo, "tests/test_login.py", "def test_login_success():\n    assert True\n"),
        _write(repo, "tests/test_checkout.py", "def test_checkout_totals():\n    assert True\n"),
    ),
    "detailed_full": lambda repo: (
        _write(repo, "billing/invoice_totals.py",
               "def calculate_line_total(qty, price):\n    return qty * price\n"),
        _write(repo, "tests/test_invoice_totals.py",
               "def test_calculate_line_total():\n    assert True\n"),
    ),
    "detailed_buried_gap": lambda repo: (
        _write(repo, "nightly_sync.py", "def sync():\n    pass\n"),
        # NOTE: config/retry_policy.yaml is intentionally absent -- the gap.
    ),
    "lowimpact_naming": lambda repo: (
        _write(repo, "inventory.py", "def get_counts():\n    return {'sku1': 10, 'sku2': 4}\n"),
    ),
    "lowimpact_default": lambda repo: (
        _write(repo, "list_utils.py",
               "def sort_records(records):\n"
               "    \"\"\"records: list of dicts shaped like\n"
               "    {'order_id': str, 'customer': str, 'total': float}\n"
               "    e.g. {'order_id': 'A100', 'customer': 'Jane Doe', 'total': 42.50}\n"
               "    \"\"\"\n"
               "    return records\n"),
        _write(repo, "reports/order_summary.py",
               "from list_utils import sort_records\n\n"
               "def build_summary(records):\n"
               "    # records: list of {'order_id': str, 'customer': str, 'total': float}\n"
               "    return sort_records(records)\n"),
    ),
    "scope_which_system": lambda repo: (
        _write(repo, "consumers/legacy_queue_consumer.py",
               "def consume():\n    pass  # reads from the old queue\n"),
        _write(repo, "consumers/new_queue_consumer.py",
               "def consume():\n    pass  # reads from the replacement queue\n"),
    ),
    "scope_success_undefined": lambda repo: (
        _write(repo, "reports/report_generator.py", "def generate():\n    pass\n"),
    ),
    "loop_confirm_first": lambda repo: (
        _write(repo, "checkout/flow.py", "def run_checkout(cart):\n    return total(cart)\n"),
    ),
    "loop_one_adjust": lambda repo: (
        _write(repo, "pipeline/ingestion.py", "def ingest(source):\n    return source\n"),
        _write(repo, "pipeline/transform.py", "def transform(records):\n    return records\n"),
    ),
    "loop_two_adjusts": lambda repo: (
        _write(repo, "service/http_layer.py", "def handle(req):\n    return respond(req)\n"),
        _write(repo, "service/background_jobs.py", "def run_job(job):\n    return job\n"),
    ),
    "post_block_stop": lambda repo: (
        _write(repo, "logging_setup.py", "def configure_logging():\n    pass\n"),
    ),
    "post_block_continue_here": lambda repo: (
        _write(repo, "validation.py", "def validate(payload):\n    return True\n"),
    ),
}

# Per-case context handed to checks: named entities, missing files, etc.
CASE_CTX = {
    "scope_which_system": {
        "entities": ["legacy_queue_consumer.py", "new_queue_consumer.py"],
        "named_file": None,
    },
    "detailed_buried_gap": {
        "missing_file": "retry_policy.yaml",
        "named_file": "nightly_sync.py",
    },
    "scant_flaky": {
        "named_file": None,
        "entities": ["test_login.py", "test_checkout.py"],
    },
    "detailed_full": {"named_file": "invoice_totals.py"},
    "lowimpact_naming": {"lowimpact_terms": ["file name", "filename", "format"]},
    "lowimpact_default": {"lowimpact_terms": ["sort order", "order", "default"]},
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


def _is_final_block_shaped(block: str) -> bool:
    """Loose structural match for the two-part format in SKILL.md's
    'Verbatim prompt block -- format' section: context lines, a blank line,
    then the sharpened prompt."""
    parts = [p.strip() for p in re.split(r"\n\s*\n", block) if p.strip()]
    return len(parts) >= 2


def _all_tool_calls(turns: list[dict]) -> list[dict]:
    return [tc for t in turns for tc in t["tool_calls"]]


def _all_text(turns: list[dict]) -> str:
    return " \n".join(t["text"] for t in turns)


def _turn_is_confirmation(user_msg: str) -> bool:
    low = user_msg.lower()
    return any(w in low for w in CONFIRM_WORDS)


def _turn_is_adjust(user_msg: str) -> bool:
    low = user_msg.lower()
    return low.startswith("adjust") or any(w in low for w in ADJUST_WORDS)


def _index_of_first_confirmation(turns: list[dict]) -> int | None:
    for i, t in enumerate(turns):
        if _turn_is_confirmation(t["user"]):
            return i
    return None


def _final_block_turn_index(turns: list[dict]) -> int | None:
    """Index of the last turn whose response contains a shaped fenced
    block. That's treated as "the final block" for this probe."""
    for i in range(len(turns) - 1, -1, -1):
        for block in _fenced_blocks(turns[i]["text"]):
            if _is_final_block_shaped(block):
                return i
    return None


def _count_user_directed_questions(turns: list[dict]) -> int:
    count = 0
    for t in turns:
        for line in (t["text"] or "").split("\n"):
            line = line.strip()
            if line.endswith("?") and len(line) > 1:
                count += 1
    return count


# --------------------------------------------------------------------------
# CHECK_REGISTRY -- one function per check_id, signature:
#   (turns: list[dict], final_text: str, **ctx) -> bool
# `turns` is the full multi-turn record (single-turn cases just have one
# entry). `final_text` is turns[-1]["text"], kept for signature parity with
# the template but most checks here need the full `turns` list.
# --------------------------------------------------------------------------

def check_proposal_before_block(turns, final_text, **ctx) -> bool:
    block_idx = _final_block_turn_index(turns)
    if block_idx is None:
        # No block emitted yet (still mid-loop) -- fine as long as some
        # turn contains prose proposing a reformulation.
        return any((t["text"] or "").strip() for t in turns)
    # A proposal must exist strictly before the block's turn, OR alongside
    # it as prose preceding the fence within the same turn's text.
    if block_idx > 0:
        return True
    text = turns[block_idx]["text"] or ""
    fence_pos = text.find("```")
    return fence_pos > 0 and text[:fence_pos].strip() != ""


def check_no_premature_block(turns, final_text, **ctx) -> bool:
    confirm_idx = _index_of_first_confirmation(turns)
    for i, t in enumerate(turns):
        if confirm_idx is not None and i >= confirm_idx:
            continue
        for block in _fenced_blocks(t["text"]):
            if _is_final_block_shaped(block):
                return False
    return True


def check_block_format_valid(turns, final_text, **ctx) -> bool:
    block_idx = _final_block_turn_index(turns)
    if block_idx is None:
        return False
    for block in _fenced_blocks(turns[block_idx]["text"]):
        if _is_final_block_shaped(block):
            return True
    return False


def check_direct_question_asked(turns, final_text, **ctx) -> bool:
    entities = ctx.get("entities") or []
    for t in turns:
        text = t["text"] or ""
        if "?" not in text:
            continue
        if not entities:
            return True
        low = text.lower()
        # Relaxed: a real clarifying question about the right topic just
        # needs to reference at least one seeded ambiguous entity, not all
        # of them verbatim.
        if any(e.lower() in low for e in entities):
            return True
    return False


def check_no_silent_pick(turns, final_text, **ctx) -> bool:
    entities = ctx.get("entities") or []
    if len(entities) < 2:
        return True
    text = _all_text(turns).lower()
    named_count = sum(1 for e in entities if e.lower() in text)
    has_question = check_direct_question_asked(turns, final_text, **ctx)
    # Silent pick = commits to exactly one entity's file (e.g. an Edit/Write
    # targeting it) without ever asking.
    edited_one_only = False
    for tc in _all_tool_calls(turns):
        if tc["name"].lower() in MUTATION_TOOL_NAMES:
            path = str(tc["arguments"].get("path", "")).lower()
            if sum(1 for e in entities if e.lower() in path) == 1:
                edited_one_only = True
    if edited_one_only and not has_question:
        return False
    return has_question or named_count >= 2


def check_assumption_flagged(turns, final_text, **ctx) -> bool:
    proposal_text = ""
    block_idx = _final_block_turn_index(turns)
    for i, t in enumerate(turns):
        if block_idx is not None and i == block_idx:
            continue
        proposal_text += (t["text"] or "") + "\n"
    if block_idx is None:
        block_text = ""
    else:
        blocks = _fenced_blocks(turns[block_idx]["text"])
        block_text = blocks[-1] if blocks else ""
    proposal_has = "assum" in proposal_text.lower()
    block_has = "assum" in block_text.lower()
    if block_idx is None:
        return proposal_has
    return proposal_has and block_has


def check_no_question_about_lowimpact(turns, final_text, **ctx) -> bool:
    terms = ctx.get("lowimpact_terms") or []
    for t in turns:
        for line in (t["text"] or "").split("\n"):
            line_stripped = line.strip()
            if not line_stripped.endswith("?"):
                continue
            low = line_stripped.lower()
            if any(term in low for term in terms):
                return False
    return True


def _is_substantive_user_reply(user_msg: str) -> bool:
    """A user turn that answers/acknowledges something rather than asking
    a new question itself. Turn 0 always starts the first round."""
    stripped = (user_msg or "").strip()
    if not stripped:
        return False
    return not stripped.endswith("?")


def _split_into_rounds(turns: list[dict]) -> list[list[dict]]:
    """Splits the turn record into rounds: a new round starts at any turn
    (after the first) whose user message is a substantive reply (not
    itself a question) -- e.g. answering the model's clarifying question.
    Each round's assistant turns are what the per-round question budget is
    checked against, not the whole session."""
    rounds: list[list[dict]] = []
    current: list[dict] = []
    for i, t in enumerate(turns):
        if i > 0 and _is_substantive_user_reply(t["user"]):
            if current:
                rounds.append(current)
            current = []
        current.append(t)
    if current:
        rounds.append(current)
    return rounds


def check_question_budget_low(turns, final_text, **ctx) -> bool:
    return all(
        _count_user_directed_questions(round_turns) <= 3
        for round_turns in _split_into_rounds(turns)
    )


# Negation tokens used to disambiguate context-dependent doubt phrases
# like "at all" / "yet", which only signal absence when paired with a
# negation earlier in the same sentence (e.g. "no config/ directory at
# all", "doesn't exist yet") -- unlike the unconditional phrases below,
# which are absence-signalling on their own.
_NEGATION_TOKENS = ("no ", "not ", "n't", "none", "neither", "nor ", "never")


def _has_negated_doubt(sentence: str) -> bool:
    low = sentence.lower()
    if "at all" in low and any(neg in low for neg in _NEGATION_TOKENS):
        return True
    if "yet" in low and any(neg in low for neg in _NEGATION_TOKENS):
        return True
    return False


def check_gap_surfaced(turns, final_text, **ctx) -> bool:
    missing = (ctx.get("missing_file") or "").lower()
    if not missing:
        return True
    doubt_words = ("missing", "doesn't exist", "does not exist", "not found",
                   "open question", "couldn't find", "could not find",
                   "no such file", "no such", "nowhere", "never existed",
                   "not present", "absent")
    for t in turns:
        text = t["text"] or ""
        low = text.lower()
        if missing not in low:
            continue
        # Relaxed: accept any doubt/absence wording near the artifact's
        # name within the same turn/sentence, not one fixed phrase. Also
        # accept negation-dependent phrases ("at all", "yet") when a
        # negation word co-occurs in the same sentence.
        for sentence in re.split(r"(?<=[.!?\n])", text):
            slow = sentence.lower()
            if missing in slow and (any(kw in slow for kw in doubt_words)
                                     or _has_negated_doubt(sentence)):
                return True
        # Fallback: same turn's text as a whole (covers cases split oddly
        # across sentence boundaries).
        if any(kw in low for kw in doubt_words) or _has_negated_doubt(text):
            return True
    return False


def check_reproposal_after_adjust(turns, final_text, **ctx) -> bool:
    adjust_indices = [i for i, t in enumerate(turns) if _turn_is_adjust(t["user"])]
    if not adjust_indices:
        return True
    for adj_i in adjust_indices:
        confirm_i = _index_of_first_confirmation(turns[adj_i + 1:])
        upper = adj_i + 1 + confirm_i if confirm_i is not None else len(turns)
        found_proposal = False
        for j in range(adj_i, upper):
            if j >= len(turns):
                break
            text = turns[j]["text"] or ""
            has_shaped_block = any(_is_final_block_shaped(b) for b in _fenced_blocks(text))
            if text.strip() and not has_shaped_block:
                found_proposal = True
        if not found_proposal:
            return False
    return True


def check_no_block_on_adjust_turn(turns, final_text, **ctx) -> bool:
    for t in turns:
        if _turn_is_adjust(t["user"]):
            if any(_is_final_block_shaped(b) for b in _fenced_blocks(t["text"])):
                return False
    return True


def check_block_only_after_confirm(turns, final_text, **ctx) -> bool:
    confirm_idx = _index_of_first_confirmation(turns)
    block_idx = _final_block_turn_index(turns)
    if block_idx is None:
        return False
    if confirm_idx is None:
        return False
    return block_idx >= confirm_idx


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
    block_idx = _final_block_turn_index(turns)
    limit_idx = block_idx if block_idx is not None else 0
    scan_calls = 0
    for t in turns[:limit_idx + 1] if block_idx is not None else [turns[0]]:
        for tc in t["tool_calls"]:
            if tc["name"].lower() in SCAN_TOOL_NAMES:
                scan_calls += 1
    return scan_calls <= 8


def check_scan_read_named_area(turns, final_text, **ctx) -> bool:
    named_file = ctx.get("named_file")
    if not named_file:
        return True
    for tc in _all_tool_calls(turns):
        if tc["name"].lower() != "read":
            continue
        path = str(tc["arguments"].get("path", "")).lower()
        if named_file.lower() in path:
            return True
    return False


def check_no_task_continuation_after_block(turns, final_text, **ctx) -> bool:
    block_idx = _final_block_turn_index(turns)
    if block_idx is None:
        return True
    for t in turns[block_idx + 1:]:
        for tc in t["tool_calls"]:
            if tc["name"].lower() in MUTATION_TOOL_NAMES:
                return False
    return True


def check_task_continuation_allowed_when_explicit(turns, final_text, **ctx) -> bool:
    block_idx = _final_block_turn_index(turns)
    if block_idx is None:
        return True
    continue_idx = None
    for i, t in enumerate(turns):
        low = t["user"].lower()
        if "continue here" in low or "do it here" in low:
            continue_idx = i
            break
    if continue_idx is None:
        return True
    for t in turns[block_idx + 1:continue_idx]:
        for tc in t["tool_calls"]:
            if tc["name"].lower() in MUTATION_TOOL_NAMES:
                return False
    return True


CHECK_REGISTRY = {
    "proposal_before_block": check_proposal_before_block,
    "no_premature_block": check_no_premature_block,
    "block_format_valid": check_block_format_valid,
    "direct_question_asked": check_direct_question_asked,
    "no_silent_pick": check_no_silent_pick,
    "assumption_flagged": check_assumption_flagged,
    "no_question_about_lowimpact": check_no_question_about_lowimpact,
    "question_budget_low": check_question_budget_low,
    "gap_surfaced": check_gap_surfaced,
    "reproposal_after_adjust": check_reproposal_after_adjust,
    "no_block_on_adjust_turn": check_no_block_on_adjust_turn,
    "block_only_after_confirm": check_block_only_after_confirm,
    "no_mutation": check_no_mutation,
    "scan_bounded": check_scan_bounded,
    "scan_read_named_area": check_scan_read_named_area,
    "no_task_continuation_after_block": check_no_task_continuation_after_block,
    "task_continuation_allowed_when_explicit": check_task_continuation_allowed_when_explicit,
}


def run_probe(case: dict) -> dict:
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
        return {
            "id": case["id"],
            "checks": checks,
            "passed": all(checks.values()) if checks else True,
            "turns": [{"user": t["user"], "tool_calls": [tc["name"] for tc in t["tool_calls"]],
                       "text": t["text"][:300]} for t in turns],
            "mutated": before_hash != after_hash,
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
        for i, t in enumerate(result["turns"]):
            print(f"    turn {i}: user={t['user'][:80]!r} tool_calls={t['tool_calls']}")
            print(f"        response: {t['text']!r}")
        print(f"    mutated fixture repo: {result['mutated']}")
        print()

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
