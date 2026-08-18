#!/usr/bin/env python3
"""Layer 2 (trajectory probe) harness for mistakes-memory.

Runs each prompt through bare pi against the skill, in an isolated temp cwd
with an isolated PI_MISTAKES_ROOT, then grades tool calls + filesystem state.

Outcome over transcript: checks inspect the log/AGENTS.md files on disk, not
the chat text, wherever possible.

Gated behind PI_LIVE_EVAL=1 - costs real LLM tokens.

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

# A mistake logged three times (same tag/symptom) - triggers graduation.
LOG_3X = """# Mistakes — /repo
<!-- Private LLM mistake log. Not committed. Consolidate when > 40 entries. -->

### 2026-01-01 · assumed Maven, was sbt · #build
- **Symptom:** ran mvn on an sbt project
- **Root cause:** did not check build files first
- **Fix applied:** checked for build.sbt
- **Detection cue:** no pom.xml present
- **Source:** user
- **Tag:** build

### 2026-01-05 · assumed Maven, was sbt · #build
- **Symptom:** ran mvn compile on an sbt module
- **Root cause:** skipped build-file check again
- **Fix applied:** used sbt compile
- **Detection cue:** build.sbt at root
- **Source:** user
- **Tag:** build

### 2026-01-09 · assumed Maven, was sbt · #build
- **Symptom:** wrong build tool a third time
- **Root cause:** no build-file check
- **Fix applied:** switched to sbt
- **Detection cue:** build.sbt present
- **Source:** advisor
- **Tag:** build
"""

# Same mistake only twice - under the graduation threshold.
LOG_2X = "\n\n".join(LOG_3X.split("\n\n")[:3]) + "\n"

# Spanish, three recurrences - graduated rule must still be English. Bodies
# are fully Spanish (not just titles) so an English-leak check can actually
# fail if the agent copies the log verbatim.
LOG_3X_ES = """# Mistakes — /repo
<!-- Log privado de errores del LLM. No se commitea. Consolidar si > 40 entradas. -->

### 2026-01-01 · asumio Maven, era sbt · #build
- **Symptom:** corri mvn en un proyecto sbt
- **Root cause:** no revise los archivos de build primero
- **Fix applied:** revise si habia build.sbt
- **Detection cue:** no hay pom.xml presente
- **Source:** user
- **Tag:** build

### 2026-01-05 · asumio Maven, era sbt · #build
- **Symptom:** corri mvn compile en un modulo sbt
- **Root cause:** volvi a saltarme la revision de archivos de build
- **Fix applied:** use sbt compile
- **Detection cue:** build.sbt en la raiz
- **Source:** user
- **Tag:** build

### 2026-01-09 · asumio Maven, era sbt · #build
- **Symptom:** herramienta de build equivocada por tercera vez
- **Root cause:** sin revision de archivos de build
- **Fix applied:** cambie a sbt
- **Detection cue:** build.sbt presente
- **Source:** advisor
- **Tag:** build
"""

# A pre-existing single-entry log, to exercise append-only on a write case.
LOG_EXISTING = """# Mistakes — /repo
<!-- Private LLM mistake log. Not committed. Consolidate when > 40 entries. -->

### 2026-01-01 · wrong config file · #config
- **Symptom:** edited application-test.yml instead of application.yml
- **Root cause:** did not check the active profile
- **Fix applied:** edited the right file
- **Detection cue:** run picked up test values
- **Source:** user
- **Tag:** config
"""


def run_pi(cwd: Path, prompt: str, mistakes_root: Path, timeout: int = 300):
    env = dict(os.environ)
    env["PI_MISTAKES_ROOT"] = str(mistakes_root)
    # -nc: do not load the global context. The global AGENTS.md hook states the
    # real store path literally (env-blind), so loading it would let the agent
    # bypass PI_MISTAKES_ROOT and touch the developer's real store.
    try:
        proc = subprocess.run(
            ["pi", "-ne", "-nc", "--skill", str(SKILL_DIR), "--mode", "json", "-p", prompt],
            cwd=str(cwd), capture_output=True, text=True, timeout=timeout, env=env,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"pi timed out after {timeout}s")
    if proc.returncode != 0:
        raise RuntimeError(
            f"pi exited {proc.returncode} - eval results would be vacuous.\n"
            f"stderr: {proc.stderr[:500]}"
        )
    tool_calls, final_text = [], ""
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


def cwd_key(cwd: Path) -> str:
    stripped = str(cwd).strip("/")
    return f"--{stripped.replace('/', '-')}--"


def seed_env(case_id: str, tmp: Path) -> tuple[Path, Path]:
    """Build fixture state for one trial. Returns (cwd, mistakes_root), both
    isolated under tmp. Seeds a pre-existing log where the case needs one."""
    repo = tmp / "repo"
    repo.mkdir()
    # Resolve symlinks: on macOS tempfile yields /var/... which pi's getcwd()
    # reports as /private/var/..., changing the cwd-key. Seed and checks must
    # use the same real path pi will see.
    repo = repo.resolve()
    mistakes_root = (tmp / "mistakes")
    mistakes_root.mkdir()
    mistakes_root = mistakes_root.resolve()

    seed = {
        "read_existing_log": LOG_3X,
        "write_appends_not_rewrites": LOG_EXISTING,
        "graduate_3x": LOG_3X,
        "graduate_under_3x": LOG_2X,
        "graduate_confirmation_gate": LOG_3X,
        "graduate_english": LOG_3X_ES,
        "graduate_log_survives": LOG_3X,
        "graduate_creates_agents_md": LOG_3X,
    }.get(case_id)

    if seed is not None:
        log_dir = mistakes_root / cwd_key(repo)
        log_dir.mkdir(parents=True)
        (log_dir / "mistakes.md").write_text(seed)

    return repo, mistakes_root


# --- checks: (tool_calls, final_text, **ctx) -> bool ---

def _log_path(ctx) -> Path:
    return ctx["mistakes_root"] / cwd_key(ctx["cwd"]) / "mistakes.md"


def log_was_read(tool_calls, final_text, **ctx) -> bool:
    return any(
        tc["name"] == "read" and "mistakes.md" in str(tc["arguments"].get("path", ""))
        for tc in tool_calls
    )


def no_write_occurred(tool_calls, final_text, **ctx) -> bool:
    before = ctx.get("log_before", "")
    after = _log_path(ctx).read_text() if _log_path(ctx).exists() else ""
    return before == after


def no_confirmation_prompt(tool_calls, final_text, **ctx) -> bool:
    # Read flow surfaces silently - no question back to the user.
    return "?" not in final_text


def no_error_on_missing_log(tool_calls, final_text, **ctx) -> bool:
    low = final_text.lower()
    return not any(w in low for w in ("error", "traceback", "exception", "no such file"))


def log_entry_appended(tool_calls, final_text, **ctx) -> bool:
    p = _log_path(ctx)
    if not p.exists():
        return False
    after = p.read_text()
    return len(after) > len(ctx.get("log_before", "")) and "###" in after


def entry_has_all_fields(tool_calls, final_text, **ctx) -> bool:
    p = _log_path(ctx)
    if not p.exists():
        return False
    text = p.read_text()
    return all(f in text for f in (
        "**Symptom:**", "**Root cause:**", "**Fix applied:**",
        "**Detection cue:**", "**Source:**", "**Tag:**",
    ))


def _source_is(ctx, value: str) -> bool:
    p = _log_path(ctx)
    if not p.exists():
        return False
    return f"**Source:** {value}" in p.read_text()


def source_is_user(tool_calls, final_text, **ctx) -> bool:
    return _source_is(ctx, "user")


def source_is_advisor(tool_calls, final_text, **ctx) -> bool:
    return _source_is(ctx, "advisor")


def entry_drafted_in_response(tool_calls, final_text, **ctx) -> bool:
    return "**Symptom:**" in final_text or "**Root cause:**" in final_text


def asked_for_basis(tool_calls, final_text, **ctx) -> bool:
    # No substance was given, so the model must ask rather than fabricate.
    low = final_text.lower()
    return "?" in final_text or any(
        w in low for w in ("what was", "which", "can you", "could you", "tell me", "what mistake")
    )


def graduation_proposed(tool_calls, final_text, **ctx) -> bool:
    # Affirmative proposal only. Keyword substrings echo the prompt ("...become
    # a hard rule"), so require an affirmative recurrence finding and no
    # negation. The nuanced 3x-in-spirit judgment lives in L3 (judge.py).
    low = final_text.lower()
    mentions = any(w in low for w in ("graduat", "promote", "learned rule"))
    declines = any(w in low for w in (
        "not recur", "only twice", "only 2", "under the threshold",
        "not enough", "has not", "hasn't", "no mistake has recurred",
        "not yet", "should not",
    ))
    return mentions and not declines


def no_agents_md_write_yet(tool_calls, final_text, **ctx) -> bool:
    # Filesystem truth, not tool-call names: a bash-mediated write must not slip
    # through the Q13 confirmation gate.
    return not (ctx["cwd"] / "AGENTS.md").exists()


def agents_md_written(tool_calls, final_text, **ctx) -> bool:
    return (ctx["cwd"] / "AGENTS.md").exists()


def has_learned_rules_section(tool_calls, final_text, **ctx) -> bool:
    p = ctx["cwd"] / "AGENTS.md"
    return p.exists() and "Learned rules" in p.read_text()


def learned_rule_in_english(tool_calls, final_text, **ctx) -> bool:
    p = ctx["cwd"] / "AGENTS.md"
    if not p.exists():
        return False
    text = p.read_text()
    # Spanish source words must not leak into the graduated rule.
    return "Learned rules" in text and not any(
        w in text.lower() for w in ("asumio", "asumió", "corri ", "revise", "era sbt")
    )


def entry_appended_only(tool_calls, final_text, **ctx) -> bool:
    # Append-only: pre-existing content survives verbatim as a prefix and the
    # file grew.
    p = _log_path(ctx)
    if not p.exists():
        return False
    before = ctx.get("log_before", "")
    after = p.read_text()
    return bool(before) and after.startswith(before) and len(after) > len(before)


def log_unchanged(tool_calls, final_text, **ctx) -> bool:
    # The private log entry must survive graduation unchanged (not moved out).
    p = _log_path(ctx)
    after = p.read_text() if p.exists() else ""
    return after == ctx.get("log_before", "")


CHECK_REGISTRY = {
    "log_was_read": log_was_read,
    "no_write_occurred": no_write_occurred,
    "no_confirmation_prompt": no_confirmation_prompt,
    "no_error_on_missing_log": no_error_on_missing_log,
    "log_entry_appended": log_entry_appended,
    "entry_has_all_fields": entry_has_all_fields,
    "source_is_user": source_is_user,
    "source_is_advisor": source_is_advisor,
    "entry_drafted_in_response": entry_drafted_in_response,
    "asked_for_basis": asked_for_basis,
    "graduation_proposed": graduation_proposed,
    "no_agents_md_write_yet": no_agents_md_write_yet,
    "agents_md_written": agents_md_written,
    "has_learned_rules_section": has_learned_rules_section,
    "learned_rule_in_english": learned_rule_in_english,
    "entry_appended_only": entry_appended_only,
    "log_unchanged": log_unchanged,
}


def run_probe(case: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        cwd, mistakes_root = seed_env(case["id"], tmp)
        log_path = mistakes_root / cwd_key(cwd) / "mistakes.md"
        log_before = log_path.read_text() if log_path.exists() else ""
        tool_calls, final_text = run_pi(cwd, case["prompt"], mistakes_root)
        ctx = {"cwd": cwd, "mistakes_root": mistakes_root, "log_before": log_before}
        checks = {
            cid: CHECK_REGISTRY[cid](tool_calls, final_text, **ctx)
            for cid in case["expected_checks"]
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
        all_passed = all_passed and result["passed"]
        print(f"[{status}] {result['id']}")
        for check, ok in result["checks"].items():
            print(f"    {'ok' if ok else 'FAIL'}: {check}")
        print(f"    tool_calls: {result['tool_calls']}")
        print(f"    response: {result['response'][:200]!r}\n")
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
