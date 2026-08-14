#!/usr/bin/env python3
"""
Layer 2 (trajectory/tool-call) probes for the code-review-checklist skill.

Each probe: seed a temp git repo via fixtures.py (FIXTURE_BUILDERS[case_id]),
run `pi -ne --skill <skill dir> --mode json -p <prompt>`, parse the NDJSON
transcript for tool calls, and grade the response against deterministic
checks from CHECK_REGISTRY (dispatch pattern: check-registry-pattern.md).

The offline `--validate` mode re-seeds every fixture and asserts: the exact
`git diff` file set per case (unstaged / --cached / main...HEAD), that every
planted token (or one of its alternatives) appears in the working file (or
in the prompt-embedded diff for the self-contained case), that fixture A's
src/orders.ts really contains
a >25-line processOrders, that every expected_checks id exists in
CHECK_REGISTRY, and runs synthetic-transcript smoke tests for six checks.
No LLM tokens are spent in --validate.

Live runs are gated behind PI_LIVE_EVAL=1 (costs real LLM tokens) and are
not part of any default/offline suite.

Usage:
    python3 evals/run_layer2_probes.py --validate
    PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py [--only id1,id2] [--save-out DIR]
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from fixtures import FIXTURE_BUILDERS, Fixture

SKILL_DIR = Path(__file__).resolve().parent.parent
PROMPT_SET_PATH = Path(__file__).resolve().parent / "prompt_set.json"
TIMEOUT = 300  # seconds per probe


def run_pi(cwd: Path, prompt: str, timeout: int = TIMEOUT) -> tuple[list[dict], str]:
    """Runs bare pi non-interactively against the skill, returns
    (tool_calls, final_response_text). tool_calls is a list of
    {"name": str, "arguments": dict}."""
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


# ---------------------------------------------------------------------------
# CHECK_REGISTRY — check_id -> (tool_calls, final_text, **ctx) -> bool.
# Pure functions only; ctx carries {"case": case, "fixture": fixture}.
# ---------------------------------------------------------------------------

def _mentions(text: str, token: str | list[str], file: str) -> bool:
    """token may be a single string or a list of alternatives (e.g. a
    secret's value OR its variable name); any one mention suffices."""
    tokens = [token] if isinstance(token, str) else token
    low = text.lower()
    return file in text and any(t.lower() in low for t in tokens)


def _planted(ctx: dict, name: str):
    return ctx.get("fixture", {}).get("planted", {}).get(name)


_GIT_MUTATING_VERBS = (
    "commit", "reset", "clean", "restore", "checkout", "stash",
    "add", "merge", "rebase", "cherry-pick", "rm",
)


def _is_mutating_git(cmd: str) -> bool:
    """True if cmd runs a git verb that mutates repo state. Read-only
    invocations that merely contain a mutating verb word are NOT mutations:
    `git stash` alone (== `git stash list`), `git stash list|show`, `-h`/
    `--help` on any verb, and plumbing `git commit-tree`."""
    for m in re.finditer(r"\bgit\s+([a-zA-Z-]+)", cmd):
        verb = m.group(1)
        if verb not in _GIT_MUTATING_VERBS:
            continue
        rest = cmd[m.end():].strip()
        first = rest.split()[0] if rest.split() else ""
        if first in ("-h", "--help"):
            continue
        if verb == "stash" and first in ("", "list", "show"):
            continue  # `git stash` alone lists stashes (read-only)
        if verb == "commit" and rest.startswith("-tree"):
            continue  # plumbing, does not touch the working tree
        return True
    return False


def check_no_code_mutation(tool_calls, final_text, **ctx) -> bool:
    """edit/write under the fixture repo, or a bash git-mutation verb, fails."""
    fixture = ctx.get("fixture", {})
    cwd = fixture.get("cwd")
    for tc in tool_calls:
        name = tc.get("name")
        args = tc.get("arguments", {})
        if name in ("edit", "write"):
            path = str(args.get("path", ""))
            if not path:
                continue
            p = Path(path)
            if cwd is not None:
                try:
                    cwd_res = Path(cwd).resolve()
                    resolved = p.resolve() if p.is_absolute() else (cwd_res / p).resolve()
                    if resolved == cwd_res or cwd_res in resolved.parents:
                        return False
                except (OSError, RuntimeError):
                    pass
        elif name == "bash":
            cmd = str(args.get("command", ""))
            if _is_mutating_git(cmd):
                return False
    return True


def check_read_test_file(tool_calls, final_text, **ctx) -> bool:
    """Every test_file in the fixture must be read (via read tool or bash)."""
    test_files = ctx.get("fixture", {}).get("test_files", [])
    for tf in test_files:
        found = False
        for tc in tool_calls:
            args = tc.get("arguments", {})
            if tc.get("name") == "read" and tf in str(args.get("path", "")):
                found = True
                break
            if tc.get("name") == "bash" and tf in str(args.get("command", "")):
                found = True
                break
        if not found:
            return False
    return True


def check_derived_diff_via_git(tool_calls, final_text, **ctx) -> bool:
    return any(
        tc.get("name") == "bash" and "git diff" in str(tc.get("arguments", {}).get("command", ""))
        for tc in tool_calls
    )


def check_derived_diff_via_git_cached(tool_calls, final_text, **ctx) -> bool:
    for tc in tool_calls:
        if tc.get("name") != "bash":
            continue
        cmd = str(tc.get("arguments", {}).get("command", ""))
        if "git diff" in cmd and ("--cached" in cmd or "--staged" in cmd):
            return True
    return False


def check_derived_diff_via_git_branch(tool_calls, final_text, **ctx) -> bool:
    fixture = ctx.get("fixture", {})
    branch = fixture.get("branch")
    for tc in tool_calls:
        if tc.get("name") != "bash":
            continue
        cmd = str(tc.get("arguments", {}).get("command", ""))
        if "git diff" in cmd and "main" in cmd and ("HEAD" in cmd or (branch and branch in cmd)):
            return True
    return False


def check_review_format_present(tool_calls, final_text, **ctx) -> bool:
    return (
        "## Review:" in final_text
        and len(re.findall(r"### .+: (pass|FAIL)", final_text)) >= 3
        and "Verdict:" in final_text
    )


def check_verdict_present(tool_calls, final_text, **ctx) -> bool:
    return re.search(r"\b(READY|NEEDS WORK)\b", final_text) is not None


def check_verdict_needs_work(tool_calls, final_text, **ctx) -> bool:
    return "NEEDS WORK" in final_text


def check_verdict_ready(tool_calls, final_text, **ctx) -> bool:
    return re.search(r"\bREADY\b", final_text) is not None and "NEEDS WORK" not in final_text


_SEVERITY_RE = re.compile(r"- \[(Blocker|Major|Nit|Question|FYI)\]")


def check_severity_tagged(tool_calls, final_text, **ctx) -> bool:
    return _SEVERITY_RE.search(final_text) is not None


def check_blocker_forces_needs_work(tool_calls, final_text, **ctx) -> bool:
    return ("[Blocker]" not in final_text) or ("NEEDS WORK" in final_text)


_PRAISE_PHRASES = [
    "well done", "great job", "nice work", "good work", "good job",
    "excelente", "buen trabajo", "muy buen trabajo",
]


def check_no_praise(tool_calls, final_text, **ctx) -> bool:
    low = final_text.lower()
    return not any(p in low for p in _PRAISE_PHRASES)


def check_has_file_line_refs(tool_calls, final_text, **ctx) -> bool:
    return re.search(r"[A-Za-z0-9_./-]+\.(ts|js|json|md):\d+", final_text) is not None


def _make_planted_check(name: str):
    """Factory for the nine found_planted_* checks — token+file mentions."""
    def check(tool_calls, final_text, **ctx) -> bool:
        planted = _planted(ctx, name)
        if planted is None:
            return False
        token, file = planted
        return _mentions(final_text, token, file)
    check.__name__ = f"check_found_planted_{name}"
    return check


def check_clean_diff_all_pass(tool_calls, final_text, **ctx) -> bool:
    """A clean diff must yield no violations (Blocker/Major/Nit) and no FAIL
    section; Question/FYI are informational, not violations. Verdict must be
    READY (zero violations is what the skill maps to READY)."""
    return (
        re.search(r"- \[(Blocker|Major|Nit)\]", final_text) is None
        and re.search(r"### .+: FAIL", final_text) is None
        and re.search(r"\bREADY\b", final_text) is not None
    )


def check_no_blocker_or_major_tags(tool_calls, final_text, **ctx) -> bool:
    return "[Blocker]" not in final_text and "[Major]" not in final_text


_NO_DIFF_PHRASES = [
    "no changes", "nothing to review", "no diff", "nothing to diff",
    "no unstaged changes", "working tree clean", "clean working tree",
    "no hay cambios", "sin cambios", "no hay nada", "nada que revisar",
    "no hay diff", "there are no changes",
]


def check_no_diff_graceful_base(tool_calls, final_text, **ctx) -> bool:
    low = final_text.lower()
    return (
        any(p in low for p in _NO_DIFF_PHRASES)
        and _SEVERITY_RE.search(final_text) is None
        and "Verdict:" not in final_text
    )


def check_negative_control_no_review(tool_calls, final_text, **ctx) -> bool:
    if "## Review:" in final_text or "Verdict:" in final_text:
        return False
    if re.search(r"\bREADY\b", final_text) or "NEEDS WORK" in final_text:
        return False
    for tc in tool_calls:
        if tc.get("name") == "bash" and "git diff" in str(tc.get("arguments", {}).get("command", "")):
            return False
    return True


def check_coverage_gap_section(tool_calls, final_text, **ctx) -> bool:
    return "Coverage Gaps" in final_text


def check_suggested_tests_section(tool_calls, final_text, **ctx) -> bool:
    return "Suggested Tests" in final_text


CHECK_REGISTRY = {
    "no_code_mutation": check_no_code_mutation,
    "read_test_file": check_read_test_file,
    "derived_diff_via_git": check_derived_diff_via_git,
    "derived_diff_via_git_cached": check_derived_diff_via_git_cached,
    "derived_diff_via_git_branch": check_derived_diff_via_git_branch,
    "review_format_present": check_review_format_present,
    "verdict_present": check_verdict_present,
    "verdict_needs_work": check_verdict_needs_work,
    "verdict_ready": check_verdict_ready,
    "severity_tagged": check_severity_tagged,
    "blocker_forces_needs_work": check_blocker_forces_needs_work,
    "no_praise": check_no_praise,
    "has_file_line_refs": check_has_file_line_refs,
    "clean_diff_all_pass": check_clean_diff_all_pass,
    "no_blocker_or_major_tags": check_no_blocker_or_major_tags,
    "no_diff_graceful_base": check_no_diff_graceful_base,
    "negative_control_no_review": check_negative_control_no_review,
    "coverage_gap_section": check_coverage_gap_section,
    "suggested_tests_section": check_suggested_tests_section,
}
for _planted_name in (
    "secret", "mutable_let", "swallowed_catch", "bool_param", "complexity",
    "scope_violation", "weak_test", "naming_nit", "redundant_comment",
):
    CHECK_REGISTRY[f"found_planted_{_planted_name}"] = _make_planted_check(_planted_name)


# ---------------------------------------------------------------------------
# Probe runner
# ---------------------------------------------------------------------------

def _load_case(case_id: str) -> dict:
    prompt_set = json.loads(PROMPT_SET_PATH.read_text())
    for case in prompt_set:
        if case["id"] == case_id:
            return case
    raise ValueError(f"unknown case id: {case_id}")


def _run_case_in(case: dict, builder, tmp: Path) -> dict:
    fixture: Fixture = builder(tmp)
    tool_calls, final_text = run_pi(fixture["cwd"], case["prompt"])
    ctx = {"case": case, "fixture": fixture}
    checks = {
        cid: CHECK_REGISTRY[cid](tool_calls, final_text, **ctx)
        for cid in case["expected_checks"]
    }
    return {
        "id": case["id"],
        "checks": checks,
        "passed": all(checks.values()) if checks else True,
        "tool_calls": [tc["name"] for tc in tool_calls],
        "n_tool_calls": len(tool_calls),
        "response": final_text,
    }


def run_case(case_id: str, tmp: Path | None = None) -> dict:
    """Run one prompt case against a fresh fixture and grade it.

    Returns {id, checks, passed, tool_calls, n_tool_calls, response}.
    If tmp is None a private TemporaryDirectory is created for this call
    (every call gets a fresh, isolated repo). Otherwise tmp must be an
    existing temp directory to seed the fixture in."""
    case = _load_case(case_id)
    builder = FIXTURE_BUILDERS.get(case_id)
    if builder is None:
        raise ValueError(f"no fixture builder for case id: {case_id}")
    if tmp is not None:
        return _run_case_in(case, builder, tmp)
    with tempfile.TemporaryDirectory() as tmp_str:
        return _run_case_in(case, builder, Path(tmp_str))


# ---------------------------------------------------------------------------
# Offline validation (no LLM tokens, no gate)
# ---------------------------------------------------------------------------

# per-case (diff mode, exact set of changed files) — mirrors the fixture spec
_DIFF_EXPECTATIONS: dict[str, tuple[str, set[str]]] = {
    "dirty_diff_unstaged": ("unstaged", {"README.md", "src/orders.ts", "src/payments.ts", "tests/payments.test.ts"}),
    "clean_diff_all_pass": ("unstaged", {"tests/orders.test.ts"}),
    "staged_diff_only": ("staged", {"src/payments.ts"}),
    "feature_branch_diff": ("branch", {"src/orders.ts", "tests/orders.test.ts"}),
    "single_blocker_needs_work": ("unstaged", {"src/config.ts"}),
    "no_diff_graceful": ("unstaged", set()),
    "diff_handed_in_prompt": ("unstaged", set()),
    "negative_control": ("unstaged", set()),
    "english_trigger_phrase": ("unstaged", {"src/labels.ts"}),
    "nit_only_ready": ("unstaged", {"src/user.ts", "tests/user.test.ts"}),
}


def _git_names(repo: Path, *args: str) -> list[str]:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, check=True,
    )
    return [ln for ln in proc.stdout.splitlines() if ln.strip()]


def _find_file(cwd: Path, rel_or_name: str) -> Path | None:
    exact = cwd / rel_or_name
    if exact.is_file():
        return exact
    for p in cwd.rglob("*"):
        if p.is_file() and p.name == rel_or_name:
            return p
    return None


def _process_orders_span(text: str) -> int:
    """Lines occupied by processOrders in fixture A's src/orders.ts.

    Counts from the blank separator line above the declaration through the
    closing brace — the range the fixture spec documents as "lines 10-35",
    i.e. 26 lines. The skill checklist's complexity threshold is ">25 lines";
    this documents that the planted function clears it."""
    lines = text.splitlines()
    sig = next(i for i, ln in enumerate(lines) if "export function processOrders" in ln)
    close = next(i for i in range(sig, len(lines)) if lines[i] == "}")
    return close - sig + 2  # include the blank separator line above


def _validate_fixture(case_id: str, case: dict, fixture: Fixture) -> list[str]:
    problems: list[str] = []
    repo = fixture["cwd"]

    # (a) exact diff file set
    mode, expected = _DIFF_EXPECTATIONS[case_id]
    try:
        if mode == "staged":
            actual = set(_git_names(repo, "diff", "--cached", "--name-only"))
            unstaged = set(_git_names(repo, "diff", "--name-only"))
            if actual != expected:
                problems.append(
                    f"{case_id}: git diff --cached files {sorted(actual)} != expected {sorted(expected)}")
            if unstaged:
                problems.append(f"{case_id}: expected clean working tree, unstaged diff has {sorted(unstaged)}")
        elif mode == "branch":
            actual = set(_git_names(repo, "diff", "main...HEAD", "--name-only"))
            if actual != expected:
                problems.append(
                    f"{case_id}: git diff main...HEAD files {sorted(actual)} != expected {sorted(expected)}")
        else:
            actual = set(_git_names(repo, "diff", "--name-only"))
            if actual != expected:
                problems.append(
                    f"{case_id}: git diff files {sorted(actual)} != expected {sorted(expected)}")
    except (subprocess.CalledProcessError, OSError) as exc:
        problems.append(f"{case_id}: git diff failed: {exc}")
        return problems

    # (b) every planted token reachable in the review target; a secret may
    # list alternatives (its value OR its variable name)
    for name, (token, file) in fixture.get("planted", {}).items():
        tokens = [token] if isinstance(token, str) else token
        if case_id == "diff_handed_in_prompt":
            # the diff lives in the prompt (self-contained); the repo working
            # tree intentionally has no such change
            if not any(t in case.get("prompt", "") for t in tokens):
                problems.append(f"{case_id}: planted[{name}] no alternative of {tokens!r} in prompt")
            continue
        target = _find_file(repo, file)
        if target is None:
            problems.append(f"{case_id}: planted[{name}] file {file!r} not found in repo")
            continue
        content = target.read_text()
        if not any(t in content for t in tokens):
            problems.append(
                f"{case_id}: planted[{name}] no alternative of {tokens!r} in working file {target.relative_to(repo)}")

    # (c) fixture A must really contain a >25-line processOrders
    if case_id == "dirty_diff_unstaged":
        orders = repo / "src/orders.ts"
        if not orders.is_file():
            problems.append("dirty_diff_unstaged: src/orders.ts missing")
        else:
            text = orders.read_text()
            if "processOrders" not in text:
                problems.append("dirty_diff_unstaged: processOrders missing from src/orders.ts")
            elif _process_orders_span(text) <= 25:
                problems.append(
                    f"dirty_diff_unstaged: processOrders spans {_process_orders_span(text)} lines, expected >25")

    return problems


def _smoke_fixture(tmp: Path) -> Fixture:
    repo = tmp / "repo"
    repo.mkdir(parents=True, exist_ok=True)
    return {
        "cwd": repo,
        "planted": {"secret": ("dev-gateway-smoke", "payments.ts")},
        "test_files": [],
        "branch": None,
    }


def _run_smoke_tests() -> list[str]:
    """Synthetic-transcript smoke tests for six checks: one expected-pass and
    one expected-fail pair per check (more for no_code_mutation)."""
    problems: list[str] = []
    with tempfile.TemporaryDirectory() as tmp_str:
        fixture = _smoke_fixture(Path(tmp_str))

        # --- no_code_mutation: read + git diff/git status must NOT be blocked
        allowed = [
            {"name": "read", "arguments": {"path": "src/orders.ts"}},
            {"name": "bash", "arguments": {"command": "git diff --stat"}},
            {"name": "bash", "arguments": {"command": "git status --short"}},
        ]
        if not check_no_code_mutation(allowed, "", fixture=fixture):
            problems.append("smoke no_code_mutation: read/git diff/git status were blocked")

        # edit/write under the repo must be blocked
        blocked_calls = [
            {"name": "edit", "arguments": {"path": "src/orders.ts"}},
            {"name": "write", "arguments": {"path": str(fixture["cwd"] / "src/payments.ts")}},
        ]
        for tc in blocked_calls:
            if check_no_code_mutation([tc], "", fixture=fixture):
                problems.append(f"smoke no_code_mutation: {tc['name']} under repo was not blocked")

        # bash with any mutating git verb must be blocked
        for cmd in [
            "git commit -m 'x'", "git reset --hard HEAD", "git restore src/a.ts",
            "git checkout -- .", "git clean -fd", "git add -A",
            "git merge main", "git rebase main", "git cherry-pick abc123", "git rm src/a.ts",
            "git stash push -m 'wip'", "git stash save wip", "git checkout main",
        ]:
            if check_no_code_mutation([{"name": "bash", "arguments": {"command": cmd}}], "", fixture=fixture):
                problems.append(f"smoke no_code_mutation: bash {cmd!r} was not blocked")

        # read-only git invocations containing a mutating verb word must NOT be blocked
        for cmd in [
            "git stash", "git stash list", "git stash show",
            "git reset --help", "git commit-tree -m 'x'", "git checkout -h",
        ]:
            if not check_no_code_mutation([{"name": "bash", "arguments": {"command": cmd}}], "", fixture=fixture):
                problems.append(f"smoke no_code_mutation: bash {cmd!r} was blocked (read-only)")

        # --- review_format_present
        good_review = (
            "## Review: main\n"
            "### Red Flags: pass\n"
            "### Design & Functionality: pass\n"
            "### Data Shape: pass\n"
            "### Verdict: READY\n"
        )
        if not check_review_format_present([], good_review):
            problems.append("smoke review_format_present: well-formed review not detected")
        if check_review_format_present([], "## Review: main\n### Red Flags: pass\n### Verdict: READY\n"):
            problems.append("smoke review_format_present: review with <3 sections detected")

        # --- verdict_ready
        if not check_verdict_ready([], "Verdict: READY (0 blockers, 0 majors)"):
            problems.append("smoke verdict_ready: READY verdict not detected")
        if check_verdict_ready([], "Verdict: NEEDS WORK (1 blocker)"):
            problems.append("smoke verdict_ready: NEEDS WORK accepted as ready")

        # --- found_planted_secret
        if not CHECK_REGISTRY["found_planted_secret"](
            [], "src/payments.ts:6 — [Blocker] dev-gateway-smoke hardcoded secret", fixture=fixture):
            problems.append("smoke found_planted_secret: planted secret mention not detected")
        alt_fixture = {
            "cwd": fixture["cwd"],
            "planted": {"secret": (["dev-gateway-alt", "PAYMENT_GATEWAY_KEY"], "payments.ts")},
            "test_files": [], "branch": None,
        }
        if not CHECK_REGISTRY["found_planted_secret"](
            [], "[Blocker] PAYMENT_GATEWAY_KEY hardcoded in payments.ts", fixture=alt_fixture):
            problems.append("smoke found_planted_secret: alternative variable-name mention not detected")
        if CHECK_REGISTRY["found_planted_secret"]([], "No issues found.", fixture=fixture):
            problems.append("smoke found_planted_secret: missing mention accepted")

        # --- no_diff_graceful_base
        if not check_no_diff_graceful_base([], "No hay cambios. Working tree clean — nothing to review."):
            problems.append("smoke no_diff_graceful_base: graceful no-diff not detected")
        if check_no_diff_graceful_base([], "Working tree clean\n- [Blocker] src/a.ts:1 — x"):
            problems.append("smoke no_diff_graceful_base: severity tags not rejected")
        if check_no_diff_graceful_base([], "No changes. Verdict: READY"):
            problems.append("smoke no_diff_graceful_base: Verdict present not rejected")

        # --- negative_control_no_review
        if not check_negative_control_no_review([], "Una cola es FIFO; una pila es LIFO. Ejemplo con deque:"):
            problems.append("smoke negative_control_no_review: plain answer rejected")
        if check_negative_control_no_review(
            [{"name": "bash", "arguments": {"command": "git diff"}}], "Respuesta..."):
            problems.append("smoke negative_control_no_review: git diff tool call accepted")
        if check_negative_control_no_review([], "## Review: main\n### Verdict: READY"):
            problems.append("smoke negative_control_no_review: review format accepted")

    return problems


def validate() -> int:
    """Offline validation: fixtures, planted tokens, diff sets, registry
    coverage, and smoke checks. No LLM tokens. Returns 0 on success."""
    problems: list[str] = []
    prompt_set = json.loads(PROMPT_SET_PATH.read_text())
    cases_by_id = {c["id"]: c for c in prompt_set}

    # (d) every expected_checks id must exist in CHECK_REGISTRY
    for case in prompt_set:
        for cid in case["expected_checks"]:
            if cid not in CHECK_REGISTRY:
                problems.append(f"{case['id']}: expected check '{cid}' not in CHECK_REGISTRY")

    # prompt_set ids and fixture builders must be in lockstep
    for case_id in cases_by_id:
        if case_id not in FIXTURE_BUILDERS:
            problems.append(f"prompt id '{case_id}' has no fixture builder")
    for case_id in FIXTURE_BUILDERS:
        if case_id not in cases_by_id:
            problems.append(f"fixture builder '{case_id}' has no prompt case")

    # (a)+(b)+(c) per fixture
    for case_id, builder in FIXTURE_BUILDERS.items():
        with tempfile.TemporaryDirectory() as tmp_str:
            tmp = Path(tmp_str)
            try:
                fixture = builder(tmp)
            except (subprocess.CalledProcessError, OSError) as exc:
                problems.append(f"{case_id}: fixture seeding failed: {exc}")
                continue
            problems += _validate_fixture(case_id, cases_by_id.get(case_id, {}), fixture)

    # (e) smoke tests
    problems += _run_smoke_tests()

    if problems:
        for p in problems:
            print(f"FAIL: {p}")
        print(f"validate: {len(problems)} problem(s) found")
        return 1
    print("validate: OK — fixtures, planted tokens, diff sets, registry, and smoke checks all pass")
    return 0


# ---------------------------------------------------------------------------
# main()
# ---------------------------------------------------------------------------

def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Layer 2 probes for code-review-checklist")
    parser.add_argument(
        "--only", nargs="*", default=None,
        help="only run these case ids (comma-separated or space-separated)")
    parser.add_argument("--save-out", default=None, help="save per-probe JSON results to DIR")
    parser.add_argument(
        "--validate", action="store_true",
        help="run offline validation only (no LLM tokens, no PI_LIVE_EVAL gate)")
    return parser.parse_args(argv)


def _flatten_only(raw: list[str] | None) -> set[str] | None:
    if raw is None:
        return None
    only: set[str] = set()
    for chunk in raw:
        for cid in chunk.split(","):
            if cid:
                only.add(cid)
    return only


def _save_out(out_dir: str, case_id: str, result: dict) -> None:
    d = Path(out_dir)
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{case_id}.json").write_text(json.dumps(result, indent=2, ensure_ascii=False))


def main() -> int:
    args = _parse_args(sys.argv[1:])

    if args.validate:
        return validate()

    if os.environ.get("PI_LIVE_EVAL") != "1":
        print("Skipped (set PI_LIVE_EVAL=1 to run — costs real LLM tokens).")
        return 0

    if shutil.which("pi") is None:
        print("ERROR: 'pi' executable not found on PATH — Layer 2 probes need the pi CLI.", file=sys.stderr)
        return 1

    prompt_set = json.loads(PROMPT_SET_PATH.read_text())
    only = _flatten_only(args.only)
    cases = [c for c in prompt_set if only is None or c["id"] in only]
    if only:
        missing = sorted(only - {c["id"] for c in prompt_set})
        if missing:
            print(f"WARNING: --only ids not in prompt set: {missing}", file=sys.stderr)

    all_passed = True
    passed_probes = 0
    passed_checks = 0
    total_checks = 0
    total_calls = 0
    for case in cases:
        result = run_case(case["id"])
        ok = result["passed"]
        all_passed = all_passed and ok
        passed_probes += 1 if ok else 0
        total_checks += len(result["checks"])
        passed_checks += sum(1 for v in result["checks"].values() if v)
        total_calls += result["n_tool_calls"]
        status = "PASS" if ok else "FAIL"
        print(f"[{status}] {result['id']}")
        for check_id, check_ok in result["checks"].items():
            print(f"    {'ok' if check_ok else 'FAIL'}: {check_id}")
        print(f"    tool_calls: {result['tool_calls']}")
        print(f"    n_tool_calls: {result['n_tool_calls']}")
        print(f"    response: {result['response'][:300]!r}")
        print()
        if args.save_out:
            _save_out(args.save_out, result["id"], result)

    print(f"Summary: {passed_probes}/{len(cases)} probes passed ({passed_checks}/{total_checks} checks)")
    print(f"Total tool calls: {total_calls}")
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
