# Evals for `revisor-textos`

Method adapted from Philipp Schmid's ["Practical Guide to Evaluating and
Testing Agent Skills"](https://www.philschmid.de/testing-skills) and
Anthropic's ["Demystifying evals for AI
agents"](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
`revisor-textos` is a **preference skill** (a specific coordinator workflow,
not a base-model capability gap), always invoked by name — so the
trigger-tuning axis those articles emphasize (rewriting `description` to
fix `should_trigger` failures) does not apply here. What's adapted is the
method: define success first, build a small prompt set, grade with
deterministic checks before reaching for an LLM judge, run multiple
trials, isolate each run.

## Success criteria (defined before any check was written)

For a coordinator/process skill, "success" is **process fidelity**, not
"the code compiles":

- Correct phase order (1 → 2 → 3 → 4 → 5 → done) as derived by `state.py`.
- Delegation to `analyst` and `worker` happens — or is correctly refused
  with an explicit reason when the harness can't delegate. The coordinator
  never authors revision content itself.
- The coordinator never writes to `working.md` directly; only `worker`
  modifies it.
- The done phase is notification-only: no `diff`, no `resumen.md`, no copy to
  output directory.
- Phase transitions require user confirmation; the coordinator never
  advances unilaterally.
- `state.py` is the sole source of phase derivation (100% read-only
  `derive_state()`), not the coordinator's manual inspection.
- Hallazgos follow the 5-field template: Severidad, Línea, Ubicación, Problema,
  Corrección sugerida.

## A first-class environment finding

Bare `pi -ne` (no extensions) exposes only **Read / Bash / Edit / Write** —
confirmed empirically, no `subagent` tool, no `ask_user_question` tool. The
skill's real delegation pipeline (`analyst` → `worker`) **cannot execute**
in that environment; only a harness that has a subagent mechanism (like the
one this skill normally runs in) can exercise that pipeline. This shapes
every layer below: Layers 1–3 run in bare `pi` and assert the *degraded-path*
behavior the skill itself mandates ("if your harness has no subagent/
delegation mechanism, say so explicitly before proceeding rather than doing
the work yourself") — they do not, and currently cannot, exercise the real
analyst/worker pipeline end-to-end. See "Known limitations" below.

## Layers

### Layer 1 — code-based, offline, free

`test_state.py`: a `unittest` suite over `state.py` — phase derivation
(1→2→3→4→5→done), read-only contract, pending order, CLI commands, session
discovery (`sessions`), the `MAX_EVALUADORES` cap, and absence of the `fase`
field in `seleccion.json`. `test_consolidado.py`:
parsing, normalization, grouping, and the `consolidate`/`group` CLI commands
of `state.py`. No LLM calls, runs in under a second, safe to run on every
change to `state.py`.

```bash
cd <this-skill-dir>   # the directory containing this evals/ folder
python3 -m unittest evals.test_state evals.test_consolidado -v
```

### Layer 2 — trajectory/tool-call probes, live-gated

`run_layer2_probes.py`: seeds a temp session dir, runs bare `pi -ne --skill
<this dir> --mode json -p <prompt>`, parses the NDJSON transcript for tool
calls, and grades against 15 deterministic checks (no working.md mutation,
no diff, no resumen, subagent-absence announced, state.py invoked, etc.).
Each probe injects the session dir path directly in the prompt to bypass
the tool gap — this step needs a tool this environment doesn't have.

Costs real LLM tokens — gated behind `PI_LIVE_EVAL=1`, not part of any
default/offline suite:

```bash
cd <this-skill-dir>
PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py
```

### Layer 3 — LLM-as-judge, live-gated

`judge.py`: re-runs 2 of the Layer 2 probes and sends each transcript
(prompt, tool calls, final response) to a second `pi` call asking for a
structured JSON verdict — for the qualitative slice regex checks can't
reach (was the delegation-refusal rationale actually sound, is the done
phase faithful *in spirit* not just keyword-present, does the confirmation
wording actually ask the user). Also gated behind `PI_LIVE_EVAL=1`.

```bash
cd <this-skill-dir>
PI_LIVE_EVAL=1 python3 evals/judge.py
```

### Layer 2b — real delegation pipeline (Phase 1→3), live-gated

`run_layer2b_pipeline.py`: unlike Layer 2, this loads a *real* `subagent`
tool via an explicit `-e <path>` to a pi extension that provides one (e.g.
the `pi-simple-agents` package's `extensions/` dir). This path is
machine-specific, so it is **not hardcoded**: set the
`PI_SUBAGENT_EXTENSION_PATH` env var to your own subagent extension's path
before running this layer; the script skips with a clear message if it's
unset.

Because the skill has multiple confirmation checkpoints, this harness
drives a **multi-turn** conversation via `--session <path>` across separate
`pi` subprocess calls — not a single `-p` shot.

Costs real, multi-minute, real-token delegation. Start with N=1 before
considering repeated trials:

```bash
cd <this-skill-dir>
export PI_SUBAGENT_EXTENSION_PATH=/path/to/pi-simple-agents/extensions
PI_LIVE_EVAL=1 python3 evals/run_layer2b_pipeline.py
```

## File structure

```
revisor-textos/evals/
├── README.md                   # este archivo
├── __init__.py                 # para imports
├── test_state.py               # L1: tests para state.py
├── test_consolidado.py         # L1: parsing/grouping + CLI tests for state.py
├── prompt_set.json             # 8 prompts con expected_checks
├── run_layer2_probes.py        # L2: 4 probes + CHECK_REGISTRY (15 checks)
├── run_layer2b_pipeline.py     # L2b: real analyst/worker delegation
└── judge.py                    # L3: 2 qualitative judges
```

## Known limitations

- Layers 2/3 exercise the **degraded path** (no subagent tool available);
  Layer 2b exercises the **real path** but only through Phase 1→3, and only
  with a single evaluator (`heuristica`). Driving Phase 4 (correct→done) and
  multi-evaluator parallel evaluation (4 concurrent analyst instances)
  remains out of reach without a scriptable `ask_user_question`.
- All live layers (2, 2b, 3) are single-trial, not the 3–5 trials both
  source articles recommend for non-deterministic agent output. Acceptable
  for now given low run count; revisit if flakiness appears.
- L2b requires that `analyst` and `worker` are configured as named
  subagents in the evaluating machine's harness. If the harness only has
  a generic `subagent` tool (without those two named slots configured), the
  `subagent_called` checks will fail with a meaningful failure message rather
  than silently passing — this is the expected outcome on a harness that has
  `subagent` but hasn't configured these two specific agents.
- The eval suite does **not** test the quality of the corrections
  (orthographic, stylistic, or content). It asserts the **mechanics** of
  the pipeline: delegation happens, files are written correctly, the
  coordinator doesn't touch what it shouldn't. The real E2E test is a
  human reading the final `working.md`.
