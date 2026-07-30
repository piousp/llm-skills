# Evals for `invoking-subagents`

Method adapted from Philipp Schmid's ["Practical Guide to Evaluating and
Testing Agent Skills"](https://www.philschmid.de/testing-skills) and
Anthropic's ["Demystifying evals for AI
agents"](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents),
via this repo's `evaluating-agent-skills` skill.

## Classification (step 1)

`invoking-subagents` is a **capability skill**: it teaches mechanics the
base model has no generic way to know (the `subagent` tool's exact schema —
single vs. `tasks: [...]` mode exclusivity, the 8-task cap, model-override
precedence and format). It is auto-discoverable (the package README states
it "loads automatically once installed"), so trigger-tuning matters and
negative controls are included — unlike a name-only preference skill.

## Success criteria (step 2, defined before any check was written)

Outcome over transcript: grade the actual `subagent` tool-call arguments
emitted, not the chat text describing what the agent did.

- **Mode exclusivity** — a call never mixes top-level `agent`/`task` with
  `tasks: [...]` in the same call.
- **The 8-task cap** — no single call's `tasks` array exceeds 8 entries.
- **Model format** — any `model` value, top-level or per-task, is
  `provider/modelId` (contains `/`), never a bare alias (`sonnet`, `opus`,
  etc.).
- **Model placement** — single mode puts `model` top-level; parallel mode
  puts it per `tasks[]` entry, never top-level alongside `tasks`.
- **Trigger discipline** — off-topic prompts and prompts answerable
  directly produce no `subagent` call at all.

## Why L1/L2 don't apply here

- **L1 (code-based)** — the skill is pure `SKILL.md`, no `scripts/`. No L1
  target exists.
- **L2 (bare `pi -ne` trajectory probes)** — bare `pi -ne` never exposes a
  `subagent` tool (confirmed in this repo's own `iterative-design` and
  `revisor-textos` eval suites: bare discovery yields only
  Read/Bash/Edit/Write). Unlike those two skills, `invoking-subagents`
  defines **no degraded-path behavior** for a missing `subagent` tool — its
  entire content is mechanics of a tool that must already exist. Running
  probes in an environment where the tool is structurally absent would only
  ever pass trivially (nothing to call), so L2 is skipped rather than
  padded with vacuous checks.

Both gaps collapse onto a single applicable layer: **L2b**, run directly
against a real `subagent` tool loaded via `-e <path>` to an extension that
provides one.

## Why no L3

Every check in step 2's criteria is structural (dict-shape / regex on tool
arguments) — mode exclusivity, task count, and `provider/modelId` format
are all mechanically checkable. There is no qualitative "is the reasoning
sound in spirit" residue here the way there is for a coordinator skill's
prose (e.g. `iterative-design`'s gate wording) — so no LLM-as-judge layer
was built.

## Layer 2b — real subagent-tool probes, live-gated

`run_layer2b_pipeline.py` loads a real `subagent` tool via an explicit
`-e <path>` to a pi extension that provides one (e.g. this package's own
`extensions/` dir), runs each of `prompt_set.json`'s 9 cases as an
independent single-turn `pi -p` call (no multi-turn/gate sequencing needed
— unlike a coordinator skill, nothing here spans phases), and grades the
emitted `subagent` call(s) against the deterministic `CHECK_REGISTRY`.

Every case delegates to the `worker` agent with a trivial one-word-reply
task, to keep real subagent runs fast and cheap. The one exception,
`nine_tasks_respect_cap`, deliberately asks for 9 independent replies (one
over the tool's 8-task cap) to exercise the cap-respecting check — it alone
spawns up to 9 real `worker` runs.

Costs real LLM tokens and, for that one case, real subagent runtime — gated
behind `PI_LIVE_EVAL=1`, never part of a default/offline suite:

```bash
cd <this-skill-dir>
export PI_SUBAGENT_EXTENSION_PATH=/path/to/pi-simple-agents/extensions
PI_LIVE_EVAL=1 python3 evals/run_layer2b_pipeline.py
```

## Prompt set (step 3)

9 cases in `prompt_set.json`: single mode, parallel mode, model override in
each mode, a bare-alias case (must resolve to `provider/modelId`, never
pass the alias through), the 8-task-cap edge case, two negative controls
(`should_trigger: false` — unrelated question, directly-answerable request),
and one mixed-request case checking mode exclusivity isn't violated when a
user's phrasing blends a solo task with a parallel pair.

## N=1 findings (full run, 2026-07-30)

9/9 cases passed, including all trigger-discipline checks (both negative
controls correctly emitted no `subagent` call).

One format-vs-semantic gap surfaced by `bare_alias_resolved`, kept as a
finding rather than silently patched: asked to force the `'sonnet'` alias,
the agent emitted `"model": "anthropic/sonnet"` — syntactically
`provider/modelId`-shaped (passes `model_format_valid_everywhere`), but not
a real model ID; it's a naive alias-prefixed composite, not genuine
resolution to something like `anthropic/claude-sonnet-4-5`. This confirms
empirically the "Model-choice checks are format-only, not semantic"
limitation below, rather than leaving it a guess. Tightening this would
need either a curated alias→family regex or an L3 judge; out of scope for
this pass.

## Known limitations

- **N=1.** All cases are single-trial, not the 3–5 trials both source
  articles recommend for non-deterministic agent output. Start here; widen
  if flakiness appears.
- **Model-choice checks are format-only, not semantic**, except where a
  literal string match is trivial (e.g. `bare_alias_resolved` only checks
  the resolved model is `provider/modelId`-shaped — it does not verify the
  agent picked a model actually *in the sonnet family* when translating a
  bare "sonnet" alias; that would need either a curated alias→family map
  or an L3 judge, neither built here).
- **No coverage of `agentOverrides`/settings-level precedence** — this
  skill's `SKILL.md` only documents the invocation-level `model` param, so
  the eval doesn't drive settings.json overrides either; out of scope by
  design (see `SKILL.md`'s own "Not covered here").
