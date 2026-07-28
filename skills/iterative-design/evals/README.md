# Evals for `iterative-design`

Method adapted from Philipp Schmid's ["Practical Guide to Evaluating and
Testing Agent Skills"](https://www.philschmid.de/testing-skills) and
Anthropic's ["Demystifying evals for AI
agents"](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
`iterative-design` is a **preference skill** (a specific coordinator
workflow, not a base-model capability gap), always invoked by name — so the
trigger-tuning axis those articles emphasize (rewriting `description` to
fix `should_trigger` failures) does not apply here. What's adapted is the
method: define success first, build a small prompt set, grade with
deterministic checks before reaching for an LLM judge, run multiple
trials, isolate each run.

## Success criteria (defined before any check was written)

For a coordinator/process skill, "success" is **process fidelity**, not
"the code compiles":

- Correct phase order (1 → 2 → 3, gates 4/5 only when reached).
- Delegation happened — or was correctly refused with an explicit reason
  when the harness can't delegate. The coordinator never authors repo code
  itself.
- The four load-bearing contract strings are honored: `phase3-green`,
  gate headers (phase label + the word "gate"), Phase 4 completion
  ("complete"/"combined review"), Phase 5 completion ("complete").
- Gate answers come from the user, never inferred or decided unilaterally
  by the coordinator.
- `$DESIGN_DIR` artifacts and `decisions.md`'s append-only format are
  honored as durable files, not chat messages.

## A first-class environment finding

Bare `pi -ne` (no extensions) exposes only **Read / Bash / Edit / Write** —
confirmed empirically, no `subagent` tool, no `ask_user_question` tool. The
skill's real delegation pipeline (`pablo-planner` → `pablo-implementer` →
green) **cannot execute** in that environment; only a harness that has a
subagent mechanism (like the one this skill normally runs in) can exercise
that pipeline. This shapes every layer below: Layers 1–3 run in bare `pi`
and assert the *degraded-path* behavior the skill itself mandates ("if
your harness has no subagent/delegation mechanism, say so explicitly
before proceeding rather than doing the work yourself") — they do not, and
currently cannot, exercise the real planner/implementer pipeline
end-to-end. See "Known limitations" below.

## Layers

### Layer 1 — code-based, offline, free

`test_state.py`: a `unittest` suite over `scripts/state.py` — phase
derivation (1→2→3), gate detection, the 4 contract strings, and `sessions`
keying by `basename(cwd)` (never `--dir`). No LLM calls, runs in under a
second, safe to run on every change to `state.py`.

```bash
cd <this-skill-dir>   # the directory containing this evals/ folder
python3 -m unittest evals.test_state -v
```

### Layer 2 — trajectory/tool-call probes, live-gated

`run_layer2_probes.py`: seeds a temp repo + `$DESIGN_DIR`, runs bare `pi
-ne --skill <this dir> --mode json -p <prompt>`, parses the NDJSON
transcript for tool calls, and grades against deterministic checks (no
repo-code mutation, no unilateral gate decisions, gate wording present,
mechanical use of `state.py`). Each probe injects `$DESIGN_DIR` directly
in the prompt to bypass Phase 0's session-resolution/`ask_user_question`
step — that step needs a tool this environment doesn't have (a known,
documented scoping choice, not an oversight).

Costs real LLM tokens — gated behind `PI_LIVE_EVAL=1`, not part of any
default/offline suite:

```bash
cd <this-skill-dir>
PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py
```

### Layer 3 — LLM-as-judge, live-gated

`judge.py`: re-runs the same three Layer 2 probes and sends each
transcript (prompt, tool calls, final response) to a second `pi` call
asking for a structured JSON verdict — for the qualitative slice regex
checks can't reach (was the delegation-refusal rationale actually sound,
is the gate wording faithful *in spirit*, not just keyword-present). Also
gated behind `PI_LIVE_EVAL=1`.

```bash
cd <this-skill-dir>
PI_LIVE_EVAL=1 python3 evals/judge.py
```

### Layer 2b — real delegation pipeline (Phase 2 → 3), live-gated

`run_layer2b_pipeline.py`: unlike Layer 2a, this loads a *real* `subagent`
tool via an explicit `-e <path>` to a pi extension that provides one (e.g.
the `pi-simple-agents` package's `extensions/` dir) — not bare discovery,
which auto-installs npm packages on every launch and is both slow and
racy under repeated invocations. This path is machine-specific, so it is
**not hardcoded**: set the `PI_SUBAGENT_EXTENSION_PATH` env var to your own
subagent extension's path before running this layer; the script skips
with a clear message if it's unset. Confirmed deterministic across
repeated runs once pointed at a real extension: exactly
Read/Bash/Edit/Write/subagent, no unrelated tools polluting the
transcript. `ask_user_question` is still not available this way, so scope
is capped at Phase 2→3 — the run is expected to stop at any gate needing
an explicit user answer, never proceed past one unasked.

Because the skill has *multiple* confirmation checkpoints beyond the
optional-phase gates (the mandatory "never advance without user
confirmation" rule applies at the Phase 2→3 boundary and again at the
co-designed spec before delegating a seam), this harness drives a **multi-
turn** conversation via `--session <path>` across separate `pi` subprocess
calls — not a single `-p` shot.

Costs real, multi-minute, real-token delegation (planner on fable-5/xhigh,
implementer on sonnet). Start with N=1 before considering repeated trials:

```bash
cd <this-skill-dir>
export PI_SUBAGENT_EXTENSION_PATH=/path/to/pi-simple-agents/extensions
PI_LIVE_EVAL=1 python3 evals/run_layer2b_pipeline.py
```

**N=1 finding (kept as a documented result, not silently re-run to force a
pass):** 8/9 checks passed — real delegation to both `pablo-planner` and
`pablo-implementer` happened, the coordinator (not the subagents) wrote
`plan.md`/`technical.md`/`spec.md`, repo code and a test file were produced,
and all three confirmation gates hit during the run were correctly
respected. The one failing check (`phase3_green_recorded`) is a genuine
**environment gap, not a skill defect**: the evaluating machine's subagent
configuration had no Python test-runner agent (only JVM build agents were
configured), so the coordinator correctly refused to run the test suite
itself to fabricate a green checkpoint — citing the skill's own harness
carve-out verbatim. Reaching `phase3-green` in this harness requires
whatever test-runner subagent matches the target repo's language, out of
scope for this eval.

## Known limitations

- Layers 2a/3 exercise the **degraded path** (no subagent tool available);
  Layer 2b exercises the **real path** but only through Phase 2→3, and only
  as far as the evaluating machine's configured subagents allow (see the
  Layer 2b finding above — results depend on what test-runner subagents are
  configured locally). Driving Phase 4/5 gates programmatically remains out
  of reach without a scriptable `ask_user_question`.
- All live layers (2a, 2b, 3) are single-trial, not the 3–5 trials both
  source articles recommend for non-deterministic agent output. Acceptable
  for now given low run count and stable/repeatable results across the runs
  performed during development; revisit if flakiness appears.
