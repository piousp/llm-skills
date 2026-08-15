# Evals for `writing-agent-skills`

Method adapted from Philipp Schmid's ["Practical Guide to Evaluating and
Testing Agent Skills"](https://www.philschmid.de/testing-skills) and
Anthropic's ["Demystifying evals for AI
agents"](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents),
per `evaluating-agent-skills`'s method.

## Classification

`writing-agent-skills` is a **preference skill**: it encodes Schmid's 8
authoring tips, not a raw model capability gap. It is **not** name-only
invoked — its description ("authoring, reviewing,
or refactoring an agent Skill... writing SKILL.md frontmatter/body...")
is meant to auto-trigger from natural requests, and is explicitly
confusable with adjacent tasks (general coding, prose writing, plain
documentation) that its own §6 example calls out. So `should_trigger`
tuning (negative controls) applies here, unlike the coordinator skill.

The skill is pure markdown — no `scripts/*` — so **Layer 1 is skipped**
entirely (nothing to unit-test offline).

## Success criteria (defined before any check was written)

- **Outcome** — when asked to author/review a skill, does the agent
  produce or evaluate a description containing both WHAT and WHEN (§2),
  flag a missing negative case when the topic is confusable (§6), and
  keep any authored `SKILL.md` body reasonably lean (§4)? On negative
  controls, does it correctly *not* produce skill-authoring artifacts for
  an unrelated coding/prose/docs request?
- **Style & instructions** — does advice match the skill's specific
  directives rather than generic writing advice: constraints/goals over
  rigid step lists (§5) *unless* order is genuinely load-bearing (in
  which case the fix is "write a script," not "reword the steps"); correct
  relaxation of description-tuning advice for name-only-invoked skills
  (§2); pointing to `evaluating-agent-skills` rather than reinventing a
  full eval harness inline (§7, out of scope here); correctly citing the
  retirement criterion — re-run unaided, retire if it still passes (§8).
- **Efficiency** — not graded here; this skill's outputs are short
  markdown responses/files, not multi-step agentic work where token/tool-
  call bloat is a realistic regression axis.

Per Anthropic's outcome-vs-transcript rule: where a probe authors a real
`SKILL.md`, checks read the **written file content** (via tool-call
arguments), not just what the agent claims in its final response.

## Layers

### Layer 1 — skipped

No `scripts/*` in this skill to unit-test.

### Layer 2 — trajectory/tool-call probes, live-gated

`run_layer2_probes.py` runs bare `pi -ne --skill <this dir> --mode json -p
<prompt>` per case in `prompt_set.json` (13 cases: 9 should-trigger paths
covering authoring/review/refactor/tighten-description/negative-case/
rigid-steps/name-only/retirement/eval-deferral, and 4 negative controls —
generic code, prose, general docs, an adjacent README request). Checks are
deterministic (`CHECK_REGISTRY` in the script): frontmatter shape, written
`SKILL.md` description content, keyword-based checks on the final response
for advice-quality signals, and — for negative controls — asserting no
`SKILL.md` write ever happened.

```bash
cd <this-skill-dir>
PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py
```

### Layer 3 — LLM-as-judge, live-gated

`judge.py` re-runs three probes where a keyword check can't tell a
genuinely correct, specific answer from generic advice that happens to
contain the right words:

- `tighten_vague_description_quality` — is the rewritten description
  actually more specific (not just longer)?
- `rigid_step_sequence_quality` — did the agent correctly diagnose *this*
  example as order-independent (goal-statement fix), rather than giving
  generic conciseness advice?
- `defer_full_eval_suite_scoping` — did it defer to
  `evaluating-agent-skills` instead of building the full layered harness
  inline?

```bash
cd <this-skill-dir>
PI_LIVE_EVAL=1 python3 evals/judge.py
```

### Layer 2b — not applicable

This skill doesn't delegate to subagents/tools; there is nothing for
Layer 2b to exercise.

## Running

- Start at N=1 during development. Widen to 3–5 trials per prompt once the
  harness itself is trusted (agent output is nondeterministic — SKILL.md
  step 5 of `evaluating-agent-skills`).
- Every trial runs in a fresh temp dir (`seed_env` in
  `run_layer2_probes.py`) — no shared state across trials or prompts.
- Both layers are gated behind `PI_LIVE_EVAL=1`; never part of a default/
  offline suite.

## Known limitations

- No repo currently ships a *known-bad* SKILL.md fixture to exercise
  `review_vague_description`/`refactor_oversized_skill` against; those
  probes rely on the prompt text itself describing the bad example inline
  rather than pointing at a real file.
- Deterministic checks lean on keyword matching in the final response for
  several `expected_checks` (e.g. `flags_vague_description`,
  `mentions_retirement_process`); this is intentionally the *coarse* first
  pass — the three qualitative cases most likely to produce a false
  positive from keyword-only matching are covered by Layer 3 instead of
  trying to make the regexes ever more elaborate.
- Not yet run against `PI_LIVE_EVAL=1` — prompt set and checks are
  authored but unexecuted; run and record a first N=1 pass before
  widening to multi-trial.
