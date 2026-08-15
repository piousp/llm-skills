---
name: evaluating-agent-skills
description: >
  Use when building an eval suite for an existing agent Skill — defining success
  criteria, building a prompt set, and running layered checks (offline code tests,
  live CLI trajectory probes, LLM-as-judge) before shipping or after changing a
  skill. This is the expansion of writing-agent-skills' "Test it before you ship
  it" step. Do NOT use for authoring a skill's SKILL.md itself (see
  writing-agent-skills), and do NOT use for general product/application evals
  unrelated to agent Skills.
---

# Evaluating Agent Skills

Adapted from Philipp Schmid's "Practical Guide to Evaluating and Testing Agent
Skills" (https://www.philschmid.de/testing-skills) and Anthropic's "Demystifying
evals for AI agents" (https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
This is the expansion of `writing-agent-skills` §7 — read that skill first if you
haven't authored the target skill yet.

**Canonical worked example**, already built and passing:
`qa-adversary/evals/` (its `README.md` documents this same 4-layer method
applied to a real review skill, including a documented N=1 limitation). Read it
before adapting the templates below — most decisions you'll face were already
made there.

## 0. This is a method + templates, not an engine

There is no single harness that evaluates arbitrary skills — success criteria
are specific to what the skill does (a coordinator skill checks phase order and
delegation; a code-gen skill checks SDK imports and whether output compiles).
Copy `templates/` into `<target-skill>/evals/` and adapt; don't try to build one
script that runs every skill.

## 1. Classify the skill first

- **Capability skill** — teaches something the base model can't do reliably
  (e.g. calling a specific API correctly). `should_trigger`/description-tuning
  matters — a vague description is often the actual bug. Re-eval periodically
  *without* the skill loaded; retire it once the base model passes unaided.
- **Preference skill** — encodes a specific workflow (e.g. a coordinator
  process). If it's always invoked by explicit name, `should_trigger` tuning is
  moot — skip negative-trigger tests and go straight to process-fidelity checks.
  Preference skills don't get obsoleted by model improvement, only by process
  changes.

This decides which layers in step 4 are worth building.

## 2. Define success before writing any check

Write this down before touching code.

**Schmid's three axes**, per prompt:
- *Outcome* — did it work? Code compiles, file exists, API call is valid. The
  baseline; if this fails nothing else matters.
- *Style & instructions* — did it follow the skill's specific directives (right
  SDK, naming convention, contract strings, phase order)?
- *Efficiency* — tokens, tool calls, retries. Two runs can produce the same
  correct output while one burns 3x the tokens — a real, compounding
  regression, and the most commonly skipped axis.

**Anthropic's outcome-vs-transcript distinction**: grade the environment's
final state (files written, tests passing, a session log's structure), not the
chat text describing it. An agent can say "done!" without having done
anything — check the artifact, not the sentence.

## 3. Build a prompt set (10–20 to start)

Schema — see `templates/prompt_set.json`:

```json
{
  "id": "short_snake_case_id",
  "prompt": "the exact user-facing prompt to send",
  "should_trigger": true,
  "expected_checks": ["check_id_1", "check_id_2"]
}
```

Mix:
- Prompts that should trigger the skill and exercise its main paths.
- Negative controls (`should_trigger: false`) — omit entirely for
  name-only-invoked preference skills (step 1).
- Edge cases the skill explicitly calls out (deprecated APIs, degraded
  environments, missing tools).

Don't over-fit prompts to force a pass on a known bug; they must generalize
past the current run.

## 4. Pick which layers to build

Not every skill needs every layer. Taxonomy, pick the subset that matches what
the skill actually does:

| Layer | What it exercises | Cost | Build it when |
|---|---|---|---|
| **L1 — code-based** | Any `scripts/*` the skill ships, tested directly with the language's own test framework | Free, offline, sub-second | The skill has a script with real logic (parsing, path resolution, state derivation) — skip for pure-markdown skills |
| **L2 — trajectory probes** | Runs the target skill through the real CLI (`pi -ne --skill <dir> --mode json -p <prompt>`), parses the NDJSON transcript, applies deterministic checks from step 3's `expected_checks` | Real tokens, live-gated | Any skill — the default layer everyone should have |
| **L3 — LLM-as-judge** | Re-sends an L2 transcript to a second model call for a qualitative verdict (was the reasoning sound, is a rule honored *in spirit*) | Real tokens, live-gated | Only for qualitative checks regex genuinely can't reach (design quality, faithful-but-not-literal rule-following) |
| **L2b — real delegation/tool pipeline** | Loads the skill's real dependent tools (e.g. `subagent`) via explicit `-e <extension path>`, not bare discovery | Real tokens, multi-minute, live-gated | Only for skills that delegate to subagents/tools absent from bare `pi -ne` |

Building L2 alone with ~10 prompts already beats "vibe-checked with a handful
of manual runs." Add L3/L2b only when step 3's checks can't reach what you
need to verify.

## 5. Run it right

- **3–5 trials per prompt** — agent output is nondeterministic; one pass/fail
  is noise. Start at N=1 during development, widen once the harness itself is
  trusted (an L2b run at N=1 is a documented choice, not a hidden gap).
- **Isolate every run** — a fresh temp dir/repo per trial, never shared state
  between trials.
- **Gate live layers behind an env var** (`PI_LIVE_EVAL=1` convention) — never
  make L2/L3/L2b part of a default/offline test suite; they cost real tokens
  and real minutes.
- **No hardcoded personal paths.** Anything machine-specific (a sibling
  extension's path, a subagent config) goes through an env var with a clear
  skip-message when unset — see `qa-adversary/evals/run_layer2b_pipeline.py`'s
  `PI_SUBAGENT_EXTENSION_PATH` handling for the pattern.
- **If something fails, fix the description first** (Schmid: most failures are
  trigger failures, not instruction failures) — but only applies to
  capability/auto-triggered skills (step 1).

## 6. Vocabulary (Anthropic)

Use these terms in eval code/docs so results are comparable across skills:
**task** (one prompt + success criteria) → **trial** (one attempt at a task) →
**grader** (scoring logic for one aspect, made of **checks**/assertions) →
**transcript** (full record: tool calls, reasoning, outputs) → **outcome**
(final state of the environment, not the chat text) → **harness** (the infra
that runs tasks, records transcripts, grades, aggregates).

## Templates

- `templates/prompt_set.json` — starter prompt set, fill in per skill.
- `templates/run_layer2_probes.py` — skeleton L2 harness: seeds a temp env,
  shells out to `pi -ne --skill <dir> --mode json -p <prompt>`, parses NDJSON
  tool calls, dispatches `expected_checks` against a `CHECK_REGISTRY` you fill
  in.
- `templates/judge.py` — skeleton L3 LLM-as-judge: re-sends a probe's
  transcript to a second `pi` call, asks for a structured JSON verdict.
- `templates/test_layer1_template.py` — skeleton `unittest` for a skill's own
  `scripts/*.py`.
- `references/check-registry-pattern.md` — the `check_id` → function dispatch
  pattern and how to keep checks composable across prompts.
- **L2b has no template, by design** — real subagent/tool wiring is too
  skill-specific to templatize. If you need it, copy and adapt
  `qa-adversary/evals/run_layer2b_pipeline.py` directly.

Copy the templates you need into `<target-skill>/evals/`, rename, and fill in
the skill-specific pieces (`CHECK_REGISTRY` functions, prompt list, success
criteria from step 2). Write a `README.md` in that `evals/` dir documenting
which layers exist and why, following `qa-adversary/evals/README.md`'s
structure.

## Sources

- Philipp Schmid, "Practical Guide to Evaluating and Testing Agent Skills",
  https://www.philschmid.de/testing-skills (2026-03-04).
- Anthropic, "Demystifying evals for AI agents",
  https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
  (2026-01-09).
- Worked example: `qa-adversary/evals/` (this repo) — the 4-layer method
  applied to a real review skill.
