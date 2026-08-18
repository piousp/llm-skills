# mistakes-memory evals

Layered eval suite for the `mistakes-memory` skill, per the
`evaluating-agent-skills` method (4-layer taxonomy). Modeled on
`qa-adversary/evals/`.

## Classification

`mistakes-memory` is a **preference skill**: it encodes a workflow (read /
write / graduate a per-directory mistake log), not a capability the base model
lacks. The read flow is auto-triggered by the global `AGENTS.md` hook, not by
the skill `description`; write and graduation are explicit name invocations.
Triggering never depends on the `description`, so `should_trigger` /
negative-trigger tuning is moot - there are no negative-control prompts.

## Layers

| Layer | File | What it checks | Gate |
|---|---|---|---|
| **L1** | `test_layer1_mistakes_path.py` | `scripts/mistakes_path.py`: cwd-key sanitization, root resolution, env override | none (offline, free) |
| **L2** | `run_layer2_probes.py` | The three flows end-to-end: log read silently, entry appended only after confirmation, all 7 fields present, source recorded, graduation writes to `AGENTS.md` only after confirmation | `PI_LIVE_EVAL=1` |
| **L3** | `judge.py` | Fuzzy judgments regex can't reach: the 3x-recurrence call (no counter, "in spirit") and the confirmation gate honored, not just mentioned | `PI_LIVE_EVAL=1` |

**L2b is skipped by design.** The skill delegates to no subagent. `advisor` /
`critical-thinker` are the *coordinator's* calls; the skill only records which
one originated a finding, as the `source` field. There is no in-skill tool
pipeline to wire.

## Success criteria (three axes)

- **Outcome** - the correct `mistakes.md` path resolves; an entry is appended
  only after explicit confirmation; graduation writes to repo-root `AGENTS.md`
  under `## Learned rules` in English, only after confirmation; **no write ever
  happens without confirmation**; nothing is auto-pruned. Graded on file state,
  not chat text.
- **Style** - each entry carries all 7 fields; `source` is one of
  {user, advisor, critical-thinker}; a graduated rule is English even when the
  log entry is not; the read flow surfaces silently, never prompting.
- **Efficiency** - the read flow is one file read, no repo re-scan; the write
  flow does not grep the whole repo.

## Running

```bash
# L1 - offline, free, sub-second
cd /Users/pabloperaza/.pi/agent/skills/mistakes-memory
python3 -m unittest evals.test_layer1_mistakes_path -v

# L2 - live, costs tokens
PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py

# L3 - live, 2x tokens per probe
PI_LIVE_EVAL=1 python3 evals/judge.py
```

Each L2 trial runs in a fresh temp cwd with a fresh `PI_MISTAKES_ROOT` under a
temp dir, and passes `-nc` so the global `AGENTS.md` hook (which names the real
store path literally, env-blind) is not loaded. That combination keeps a run
from touching the real `~/.pi/agent/mistakes` or any real repo. L3 also passes
`-nc` for the same reason. `run_pi` raises on a nonzero `pi` exit so a broken
CLI fails loudly instead of producing vacuous passes.

Runs are N=1: the harness executes each prompt once. The numbers are a smoke
signal, not a statistical result - agent output is nondeterministic, so a
single pass/fail is noise. Re-run manually to gauge stability; there is no
built-in trial aggregation yet.

## Limitations

- N=1: the numbers are a smoke signal, not a statistical result.
- The `learned_rule_in_english` check is a leak-detector (rejects known Spanish
  source words from the fixture), not a full language classifier.
- Deferred, not covered (YAGNI or false-FAIL-only): a `NAME_MAX` overflow in
  the path script for very long cwds; `--cwd` path normalization; an amendment
  flow for a stale `pending` field; the keyword-based `no_error_on_missing_log`
  / `no_confirmation_prompt` / `log_was_read` checks are noisy on false FAILs
  (they never produce a false PASS).
- Q7 ("write = explicit invocation only") is not directly testable here:
  `--skill` force-loads the skill on every case, so trigger-by-invocation
  cannot be probed.
- Auto-read-via-hook is not testable under `-nc`: firing the read flow without
  being asked depends on the global `AGENTS.md` hook, and loading that hook
  breaks isolation. The read/graduate prompts therefore name "the mistakes
  log" explicitly, which tests the skill body's resolve+read+surface, not the
  hook's auto-fire.

## Baseline (N=1, 2026-08-18)

Single run. Numbers are a smoke signal, not a statistical result.

### L2 - 15/17

PASS: read_existing_log, read_no_log, write_from_user, write_no_basis_asks,
write_needs_confirmation, write_denied, write_source_advisor,
write_advisor_no_confirm, write_fields_complete, write_appends_not_rewrites,
graduate_3x, graduate_under_3x, graduate_confirmation_gate, graduate_english,
graduate_log_survives.

FAIL (documented, not fixed):
- `write_nonenglish_ok` - `log_entry_appended`. The agent drafted the entry
  and said it would save ("Voy a guardar ... registraré") but emitted no write
  in the turn, despite the same-turn "Guardalo". This is the same-turn-write
  nondeterminism: 1/6 write cases deferred the write this run (2/6 in a prior
  run). Known observation; the same-turn-counts-as-confirmation wording is the
  mitigation, unverified at N>1.
- `graduate_creates_agents_md` - `has_learned_rules_section`. The agent wrote
  the graduated rule to `AGENTS.md` (`agents_md_written` passed) but not under
  the exact `## Learned rules` heading the check looks for. Real minor finding:
  the section-header convention is not reliably honored when the file is
  created from scratch.

### L3 - 3/3

PASS: recurrence_judgment_sound_3x (98), recurrence_judgment_sound_under_3x
(100), confirmation_gate_honored (95). The fuzzy graduation judgments (3x vs
2x recurrence, and honoring the confirmation gate) held.
