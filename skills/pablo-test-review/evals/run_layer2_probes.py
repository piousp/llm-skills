#!/usr/bin/env python3
"""
Layer 2 (trajectory/tool-call probes) for the pablo-test-review skill.

Each probe: seed a fresh temp repo (fixtures.py), run bare `pi -ne --skill
<pablo-test-review dir> --mode json -p <prompt>`, parse the NDJSON transcript
for tool calls, and grade the final report against the probe's expected_checks
from prompt_set.json. All checks are deterministic (guardrails plus report
structure and token matching). The qualitative slice (would the line be posted
as is, is the gap ranking right, is silence honest) is graded at Layer 3
(judge.py).

Gated behind PI_LIVE_EVAL=1 by convention: it costs real LLM tokens and must
never be part of a default/offline suite. Offline validation (no LLM, no env
var) via --check.

Usage:
    python3 evals/run_layer2_probes.py --check              # offline: registry, fixtures, diffs, check self-tests
    python3 evals/run_layer2_probes.py --trials N           # without PI_LIVE_EVAL: "Skipped...", exit 0
    PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py --trials 3   # live: N trials per case
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable

from fixtures import FIXTURES, SEEDERS, diffed_paths

EVALS_DIR = Path(__file__).resolve().parent
SKILL_DIR = EVALS_DIR.parent
PROMPT_SET_PATH = EVALS_DIR / "prompt_set.json"
PROBE_TIMEOUT = 300


def parse_trials(argv: list[str]) -> int:
    """Parses --trials N (default 1); invalid N prints an error and exits 2.
    With --check or without PI_LIVE_EVAL the parsed value is ignored (each
    case/probe runs once, exactly as before); only live mode uses it."""
    trials = 1
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--trials":
            if i + 1 >= len(argv):
                print("ERROR: --trials requires an integer N >= 1 (e.g. --trials 5)")
                sys.exit(2)
            raw = argv[i + 1]
            i += 2
        elif arg.startswith("--trials="):
            raw = arg[len("--trials="):]
            i += 1
        else:
            i += 1
            continue
        try:
            trials = int(raw)
        except ValueError:
            trials = 0
        if trials < 1:
            print(f"ERROR: --trials must be an integer >= 1, got {raw!r}")
            sys.exit(2)
    return trials


def run_pi(cwd: Path, prompt: str, timeout: int = PROBE_TIMEOUT) -> tuple[list[dict], str]:
    """Runs bare pi non-interactively with the pablo-test-review skill loaded;
    returns (tool_calls, final_response_text). tool_calls is a list of
    {"name": str, "arguments": dict}. On timeout, raises RuntimeError naming
    the probe (harness-level FAIL)."""
    try:
        proc = subprocess.run(
            ["pi", "-ne", "--skill", str(SKILL_DIR), "--mode", "json", "-p", prompt],
            cwd=str(cwd), capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"probe timed out after {timeout}s (prompt: {prompt!r})")
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
        # Join the last assistant message's text items; ignore thinking
        # blocks and any other content type.
        texts = [c["text"] for c in msg.get("content", []) if c.get("type") == "text"]
        if texts:
            final_text = " ".join(texts)
        for c in msg.get("content", []):
            if c.get("type") == "toolCall":
                tool_calls.append({"name": c.get("name"), "arguments": c.get("arguments", {})})
    return tool_calls, final_text


# ---------------------------------------------------------------- report parsing

COMMENT_TIERS = {"m", "question", "i", "nit"}
BLOCKING_TIERS = {"b", "blocking", "blocker"}
_ITEM_RE = re.compile(r"^\s*\**\d+\.\s*\[(?P<tier>[^\]]+)\]\**\s*(?P<rest>.*)$")
_GAP_RE = re.compile(r"^\s*\**G\d+\.\s*(?P<rest>.*)$")
_EMPTY_LITERAL = "no test observations"


def parse_items(final_text: str) -> list[dict]:
    """Items are line-anchored: `N. [tier] ...` (comment) or `Gn. ...` (gap).
    The block runs to the next blank line, item, or heading."""
    items: list[dict] = []
    current: dict | None = None
    for line in final_text.splitlines():
        m = _ITEM_RE.match(line)
        g = _GAP_RE.match(line)
        if m:
            current = {"kind": "comment", "tier": m.group("tier").strip().lower(),
                       "head": line.strip(), "lines": [line.strip()]}
            items.append(current)
        elif g:
            current = {"kind": "gap", "tier": "g", "head": line.strip(), "lines": [line.strip()]}
            items.append(current)
        elif current is not None and (not line.strip() or re.match(r"^\s*#", line)):
            current = None
        elif current is not None:
            current["lines"].append(line.strip())
    return items


def _items_text(final_text: str) -> str:
    return "\n".join("\n".join(i["lines"]) for i in parse_items(final_text)).lower()


def _comments(items: list[dict]) -> list[dict]:
    return [i for i in items if i["kind"] == "comment"]


def _gaps(items: list[dict]) -> list[dict]:
    return [i for i in items if i["kind"] == "gap"]


# ---------------------------------------------------------------- checks

def check_no_source_or_test_mutation(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """Guardrail: the agent must never edit or write source or test code."""
    return not any(str(tc.get("name", "")).lower() in ("edit", "write", "notepad")
                   for tc in tool_calls)


# Segment-start test-runner matching: only a segment whose first token is a
# test runner matches, so read-only inspection like `grep pytest` or
# `git log | grep test` cannot false-positive.
_SEGMENT_TEST_RUNNER_RE = re.compile(
    r"^(?:pytest|jest|vitest|phpunit)(?:\s|$)"
    r"|^python3?(?:\s+-m)?\s+(?:pytest|unittest)(?:\s|$)"
    r"|^(?:npm|npx)(?:\s+run)?\s+(?:test|jest)(?:\s|$)"
    r"|^(?:mvn|gradle|gradlew|mvnw|cargo|go|dotnet)\s+test(?:\s|$)"
)


def _bash_command_segments(tool_calls: list[dict]) -> list[str]:
    segments: list[str] = []
    for tc in tool_calls:
        if tc.get("name") != "bash":
            continue
        args = tc.get("arguments") or {}
        if not isinstance(args, dict):
            continue
        command = str(args.get("command", ""))
        for raw in re.split(r"[;&|\n]", command):
            seg = raw.strip()
            if not seg:
                continue
            # Normalize: strip leading `sudo`, env assignments (NAME=value,
            # not just NAME= , otherwise `FOO=1 pytest` would reduce to
            # `1 pytest` and slip past the runner match), and `./`. Repeat
            # until stable so `FOO=1 sudo pytest` also reduces.
            for _ in range(4):
                new = re.sub(r"^sudo\s+", "", seg)
                new = re.sub(r"^[A-Za-z_][A-Za-z0-9_]*=\S*\s*", "", new)
                new = re.sub(r"^\./", "", new).strip()
                if new == seg:
                    break
                seg = new
            segments.append(seg)
    return segments


def _matching_test_segments(tool_calls: list[dict]) -> list[str]:
    """Bash segments that would trip check_no_test_execution , printed on a
    no_test_execution failure so the offending command is diagnosable (a
    genuine test run vs a regex false positive)."""
    return [seg for seg in _bash_command_segments(tool_calls)
            if _SEGMENT_TEST_RUNNER_RE.match(seg)]


def check_no_test_execution(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """Guardrail: no test/build command in any bash call, no delegated
    test-runner tool call."""
    for seg in _bash_command_segments(tool_calls):
        if _SEGMENT_TEST_RUNNER_RE.match(seg):
            return False
    for tc in tool_calls:
        if tc.get("name") in ("run_tests", "test_runner"):
            return False
    return True



def _section_body(text: str, heading: str) -> list[str] | None:
    """Non-blank lines under `heading` up to the next heading; None if absent."""
    lines = text.splitlines()
    for idx, line in enumerate(lines):
        if re.match(r"^\s*#{1,6}\s*%s\s*$" % heading, line):
            body: list[str] = []
            for nxt in lines[idx + 1:]:
                if re.match(r"^\s*#", nxt):
                    break
                if nxt.strip():
                    body.append(nxt.strip())
            return body
    return None


def _section_ok(low: str, heading: str, item_re: re.Pattern) -> bool:
    """Heading present; a section with no items holds exactly the line `none.`."""
    body = _section_body(low, heading)
    if body is None:
        return False
    if any(item_re.match(l) for l in body):
        return True
    # trailing prose after a blank line is not part of the section
    first = next((l for l in body if l.strip()), None)
    return first == "none."


def check_report_structure(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """Title heading, then either the global empty literal or both sections
    (heading; an item-less section holds exactly `none.`)."""
    low = final_text.lower().replace("*", "")
    if re.search(r"^\s*#{1,6}\s*test review", low, re.MULTILINE) is None:
        return False
    if _EMPTY_LITERAL in low:
        return True
    return (_section_ok(low, "comments", re.compile(r"^\d+\.\s*\["))
            and _section_ok(low, "critical gaps", re.compile(r"^g\d+\.")))


def check_tier_vocab_valid(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    return all(i["tier"] in COMMENT_TIERS | BLOCKING_TIERS
               for i in _comments(parse_items(final_text)))


def check_no_b_tier(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    return not any(i["tier"] in BLOCKING_TIERS for i in _comments(parse_items(final_text)))


def check_items_have_file_line(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """Every item head carries a path:line anchor. Vacuous-true when empty."""
    return all(re.search(r"\S+:\d+", i["head"]) for i in parse_items(final_text))


def _has_code_token(line: str) -> bool:
    return re.search(r"`[^`]+`", line) is not None


def check_items_have_change_token(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """Comments need a `Change:` line and gaps a `Test:` line, each with a
    backticked code token (gate G-A)."""
    for item in parse_items(final_text):
        label = "change" if item["kind"] == "comment" else "test"
        ok = any(re.match(r"^\W*%s\s*:" % label, l, re.IGNORECASE) and _has_code_token(l)
                 for l in item["lines"][1:] + item["lines"][:1])
        if not ok:
            return False
    return True


def check_gap_cap_le_1(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    return len(_gaps(parse_items(final_text))) <= 1


def check_visible_cap_le_3(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """Gate G-G: comments (any tier, Nit included) plus gaps, at most 3 in total."""
    return len(parse_items(final_text)) <= 3


def check_nit_cap_le_1(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    return len([i for i in _comments(parse_items(final_text)) if i["tier"] == "nit"]) <= 1


def check_question_form(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """Every Question-tier item head contains a question mark."""
    return all("?" in i["head"] for i in _comments(parse_items(final_text))
               if i["tier"] == "question")


def check_found_expected_item(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """Item text names the fixture file and at least one expected token.
    Registered as found_p1..found_p8, which differ only via ctx."""
    text = _items_text(final_text)
    filename = os.path.basename(ctx.get("file", "")).lower()
    if filename and filename not in text:
        return False
    return any(str(t).lower() in text for t in ctx.get("tokens", []))


def check_absent_forbidden_tokens(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """No item (any tier) mentions a forbidden token (silent case)."""
    text = _items_text(final_text)
    return not any(str(t).lower() in text for t in ctx.get("forbidden", []))


def check_no_non_nit_items(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """Silent case: no comment above Nit and no gap."""
    items = parse_items(final_text)
    return not _gaps(items) and all(i["tier"] == "nit" for i in _comments(items))


def check_silent_result(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    low = final_text.lower().replace("*", "")
    return _EMPTY_LITERAL in low and not parse_items(final_text)


def check_question_tier_only(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """Waits and calibration: at least one Question item anchored on the
    fixture file, and no M item."""
    comments = _comments(parse_items(final_text))
    filename = os.path.basename(ctx.get("file", "")).lower()
    on_file = [i for i in comments if filename in i["head"].lower()]
    return (any(i["tier"] == "question" for i in on_file)
            and not any(i["tier"] == "m" for i in comments))


def check_has_gap(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    return len(_gaps(parse_items(final_text))) >= 1


def check_gap_ranked_first(tool_calls: list[dict], final_text: str, **ctx) -> bool:
    """The first gap names an expected token."""
    gaps = _gaps(parse_items(final_text))
    if not gaps:
        return False
    first = "\n".join(gaps[0]["lines"]).lower()
    return any(str(t).lower() in first for t in ctx.get("tokens", []))


CHECK_REGISTRY: dict[str, Callable[..., bool]] = {
    "no_source_or_test_mutation": check_no_source_or_test_mutation,
    "no_test_execution": check_no_test_execution,
    "report_structure": check_report_structure,
    "tier_vocab_valid": check_tier_vocab_valid,
    "no_b_tier": check_no_b_tier,
    "items_have_file_line": check_items_have_file_line,
    "items_have_change_token": check_items_have_change_token,
    "gap_cap_le_1": check_gap_cap_le_1,
    "visible_cap_le_3": check_visible_cap_le_3,
    "nit_cap_le_1": check_nit_cap_le_1,
    "question_form": check_question_form,
    **{f"found_p{n}": check_found_expected_item for n in range(1, 9)},
    **{f"absent_n{n}": check_absent_forbidden_tokens for n in range(1, 6)},
    "no_non_nit_items": check_no_non_nit_items,
    "silent_result": check_silent_result,
    "question_tier_only": check_question_tier_only,
    "has_gap": check_has_gap,
    "gap_ranked_first": check_gap_ranked_first,
}

TOKEN_CHECKS = ("found_p", "gap_ranked_first")


# ---------------------------------------------------------------- harness

def load_prompt_set() -> list[dict]:
    return json.loads(PROMPT_SET_PATH.read_text(encoding="utf-8"))


def grade_case(case: dict, tool_calls: list[dict], final_text: str) -> dict[str, bool]:
    ctx = case.get("ctx", {})
    return {
        check_id: CHECK_REGISTRY[check_id](tool_calls, final_text, **ctx)
        for check_id in case["expected_checks"]
    }


def run_probe(case: dict) -> dict:
    """One isolated trial: fresh temp dir -> seed fixture -> run pi -> grade."""
    with tempfile.TemporaryDirectory() as tmp_str:
        cwd = SEEDERS[case["seed"]](Path(tmp_str))
        prompt = case["prompt"].replace("<repo>", str(cwd))
        start = time.monotonic()
        tool_calls, final_text = run_pi(cwd, prompt)
        elapsed_s = round(time.monotonic() - start, 1)
        checks = grade_case(case, tool_calls, final_text)
        return {
            "id": case["id"],
            "checks": checks,
            "passed": all(checks.values()) if checks else True,
            "tool_calls": [tc["name"] for tc in tool_calls],
            "response": final_text,
            "tool_call_count": len(tool_calls),
            "elapsed_s": elapsed_s,
            "test_segments": _matching_test_segments(tool_calls),
        }


# Import seam for judge.py: probe_id -> zero-arg runnable probe.
PROBES: dict[str, Callable[[], dict]] = {
    case["id"]: (lambda c=case: run_probe(c)) for case in load_prompt_set()
}


def check_consistency() -> list[str]:
    """Offline validation of prompt_set.json against the registry/seeders."""
    errors: list[str] = []
    required = {"id", "kind", "prompt", "should_trigger", "seed", "ctx", "expected_checks"}
    cases = load_prompt_set()
    ids = [c.get("id", "") for c in cases]
    for prefix, count in (("P", 8), ("N", 8)):
        found = [i for i in ids if i.startswith(prefix)]
        if len(found) != count:
            errors.append(f"expected {count} {prefix}-probes, found {len(found)}")
    if len(set(ids)) != len(ids):
        errors.append("duplicate probe ids")
    for case in cases:
        cid = case.get("id", "?")
        missing = required - set(case.keys())
        if missing:
            errors.append(f"{cid}: missing keys {sorted(missing)}")
            continue
        if case["should_trigger"] is not True:
            errors.append(f"{cid}: should_trigger must be true (preference skill invoked by name)")
        if case["seed"] not in SEEDERS:
            errors.append(f"{cid}: unknown seed {case['seed']!r}")
        ctx = case["ctx"]
        for check_id in case["expected_checks"]:
            if check_id not in CHECK_REGISTRY:
                errors.append(f"{cid}: unknown expected_check {check_id!r}")
            if check_id.startswith(TOKEN_CHECKS) and not ctx.get("tokens"):
                errors.append(f"{cid}: check {check_id!r} needs non-empty ctx['tokens']")
            if check_id.startswith("absent_") and not ctx.get("forbidden"):
                errors.append(f"{cid}: check {check_id!r} needs non-empty ctx['forbidden']")
        if "<repo>" not in case["prompt"]:
            errors.append(f"{cid}: prompt lacks the <repo> placeholder")
    return errors


def _hunk_errors(case: dict, repo: Path) -> list[str]:
    """Every context/added line of the prompt diff must match the seeded file
    at the line number the hunk header states."""
    errors: list[str] = []
    m = re.search(r"```diff\n(.*?)\n```", case["prompt"], re.DOTALL)
    if not m:
        return [f"{case['id']}: no diff block in prompt"]
    path = None
    lines = m.group(1).splitlines()
    i = 0
    seen: list[str] = []
    while i < len(lines):
        line = lines[i]
        if line.startswith("+++ b/"):
            path = line[len("+++ b/"):]
            seen.append(path)
            i += 1
            continue
        hm = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
        if hm and path:
            target = (repo / path).read_text(encoding="utf-8").splitlines()
            idx = int(hm.group(1)) - 1
            i += 1
            while i < len(lines) and not lines[i].startswith(("@@", "--- ")):
                body = lines[i]
                if body.startswith("-"):
                    i += 1
                    continue
                text = body[1:]
                if idx >= len(target) or target[idx] != text:
                    errors.append(f"{case['id']}: {path}:{idx + 1} does not match the diff line {text!r}")
                    return errors
                idx += 1
                i += 1
            continue
        i += 1
    expected = [p for p in diffed_paths(case["seed"])]
    if seen != expected:
        errors.append(f"{case['id']}: diff paths {seen} != fixture paths {expected}")
    return errors


def fixture_smoke_test() -> list[str]:
    """Seed every fixture into a fresh temp dir; assert the files exist and
    that each prompt's diff matches the seeded working tree."""
    errors: list[str] = []
    cases = {c["seed"]: c for c in load_prompt_set()}
    for key, spec in FIXTURES.items():
        if key not in cases:
            errors.append(f"{key}: fixture has no probe")
            continue
        with tempfile.TemporaryDirectory() as tmp_str:
            repo = SEEDERS[key](Path(tmp_str))
            for rel in spec["files"]:
                if not (repo / rel).exists():
                    errors.append(f"{key}: expected {rel} missing")
            if not errors:
                errors.extend(_hunk_errors(cases[key], repo))
    return errors


GOOD_REPORT = """## Test review: feature/widget
Read: 1 changed tests; production 1-hop: WidgetMapper.java

### Comments
1. [M] WidgetMapperTest.java:12: Should we keep asserting the status?
   Change: `assertEquals(Status.ARCHIVED, dto.status())`
   Evidence: dropping the status copy keeps this test green.
2. [Question] ReplayIT.java:9: Can we get a few runs to confirm 250 ms?
   Change: `POLL_MS = 250`
   Evidence: value changed with no run data.

### Critical gaps
G1. WidgetService.java:12: The dry-run branch has no test.
    Test: `submitDryRunStoresNothing`: dryRun=true -> preview, nothing saved
"""


def self_test_checks() -> list[str]:
    """Offline: the deterministic checks accept a well-formed report and
    reject the malformed variants they are meant to catch."""
    errors: list[str] = []

    def expect(check: str, text: str, want: bool, **ctx) -> None:
        got = CHECK_REGISTRY[check]([], text, **ctx)
        if got != want:
            errors.append(f"self-test {check}: expected {want}, got {got}")

    for name in ("report_structure", "tier_vocab_valid", "no_b_tier", "items_have_file_line",
                 "items_have_change_token", "gap_cap_le_1", "visible_cap_le_3", "nit_cap_le_1",
                 "question_form"):
        expect(name, GOOD_REPORT, True)
    expect("found_p1", GOOD_REPORT, True, file="WidgetMapperTest.java", tokens=["status"])
    expect("found_p1", GOOD_REPORT, False, file="Other.java", tokens=["status"])
    expect("gap_ranked_first", GOOD_REPORT, True, tokens=["dry-run"])
    expect("has_gap", GOOD_REPORT, True)
    expect("question_tier_only", GOOD_REPORT, False, file="ReplayIT.java")
    expect("no_non_nit_items", GOOD_REPORT, False)
    expect("absent_n1", GOOD_REPORT, True, forbidden=["assertNotNull"])
    expect("absent_n1", GOOD_REPORT + "\n1. [I] A.java:1: x\n   Change: `assertNotNull(x)`", False,
           forbidden=["assertNotNull"])
    expect("tier_vocab_valid", "1. [Major] A.java:1: x", False)
    expect("no_b_tier", "1. [B] A.java:1: x", False)
    expect("items_have_file_line", "1. [M] no anchor here", False)
    expect("items_have_change_token", "1. [M] A.java:1: x\n   Change: add an assertion", False)
    expect("items_have_change_token", "G1. A.java:1: x\n    Change: `foo`", False)
    expect("question_form", "1. [Question] A.java:1: statement only", False)
    expect("gap_cap_le_1", "\n".join(f"G{n}. A.java:{n}: x\n    Test: `t`: a -> b\n" for n in range(1, 3)), False)
    expect("nit_cap_le_1", "1. [Nit] A.java:1: a\n\n2. [Nit] A.java:2: b", False)
    expect("visible_cap_le_3", "\n\n".join(f"{n}. [I] A.java:{n}: x" for n in range(1, 5)), False)
    expect("silent_result", "## Test review: x\nNo test observations.", True)
    expect("silent_result", GOOD_REPORT, False)
    expect("report_structure", "## Test review: x\nNo test observations.", True)
    expect("report_structure", "## Test review: x\n### Comments\nnone.\n\n### Critical gaps\nnone.", True)
    expect("report_structure", "## Test review: x\nComments: none.\nCritical gaps: none.", False)
    expect("report_structure", "## Test review: x\n### Comments\n\n### Critical gaps\nnone.", False)
    expect("report_structure", "## Test review: x\n### Comments\n", False)
    expect("no_source_or_test_mutation", "", True)
    if CHECK_REGISTRY["no_source_or_test_mutation"]([{"name": "Edit", "arguments": {}}], "") is not False:
        errors.append("self-test no_source_or_test_mutation: Edit call not rejected")
    if CHECK_REGISTRY["no_test_execution"]([{"name": "bash", "arguments": {"command": "mvn test"}}], "") is not False:
        errors.append("self-test no_test_execution: mvn test not rejected")
    return errors


def main(argv: list[str]) -> int:
    trials = parse_trials(argv)
    if "--check" in argv:
        errors = check_consistency() + fixture_smoke_test() + self_test_checks()
        if errors:
            for err in errors:
                print(f"ERROR: {err}")
            print(f"check: FAIL ({len(errors)} error(s))")
            return 1
        print("check: OK - registry valid, all fixtures seed, every diff matches its files, "
              "check self-tests pass")
        return 0

    if os.environ.get("PI_LIVE_EVAL") != "1":
        print("Skipped (set PI_LIVE_EVAL=1 to run; costs real LLM tokens).")
        return 0

    preflight = check_consistency()
    if preflight:
        for err in preflight:
            print(f"pre-flight ERROR: {err}")
        return 1

    all_passed = True
    for case in load_prompt_set():
        case_id = case["id"]
        print(f"== {case_id} ==")
        passed_trials = 0
        for i in range(1, trials + 1):
            try:
                result = run_probe(case)
            except RuntimeError as exc:
                all_passed = False
                print(f"trial {i}/{trials}: FAIL, harness error: {exc}")
                continue
            failed = [check_id for check_id, ok in result["checks"].items() if not ok]
            if failed:
                all_passed = False
                print(f"trial {i}/{trials}: FAIL: {', '.join(failed)}")
                print(f"    response: {result['response'][:300]!r}")
                print(f"    tool_calls: {result['tool_calls']}")
                if "no_test_execution" in failed:
                    print(f"    offending test segments: {result.get('test_segments')}")
            else:
                passed_trials += 1
                print(f"trial {i}/{trials}: PASS "
                      f"({sum(result['checks'].values())}/{len(result['checks'])} checks, "
                      f"{result['tool_call_count']} calls, {result['elapsed_s']}s)")
        print(f"{case_id}: {passed_trials}/{trials} trials passed")
        print()

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
