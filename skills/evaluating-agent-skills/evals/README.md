# Evals for `evaluating-agent-skills` (dogfooding)

This skill evaluates itself, applying its own method (SKILL.md steps 1–4) to
decide which layers are worth building.

## Classification (step 1)

Unlike a name-only-invoked preference skill, `evaluating-agent-skills` has a
real "when" clause and explicit negative cases in its `description` ("Do NOT
use for authoring... Do NOT use for general product evals"). It is meant to
**auto-trigger** from natural requests. That makes `should_trigger` the
single highest-value, cheapest axis to check here — the skill's own step 1
says exactly this.

## Feasibility finding

Confirmed empirically before building anything: bare `pi` with **no**
`--skill` flag *does* discover skills from `~/.pi/agent/skills/` by
description match (real discovery, not forced loading), and the trigger is
observable in the NDJSON transcript as an early `read` tool call on the
matched skill's own `SKILL.md`. This is the proxy used by every check below.

**A real incident happened while confirming this.** The first manual check
used a real skill name ("build evals for the writing-agent-skills skill") as
the target instead of a disposable fixture. The skill triggered correctly,
followed its own method faithfully, and — because the check ran with full
write tools and no sandbox — **actually wrote** a real, correct `evals/`
suite into `writing-agent-skills/`. That output was reviewed and kept (see
`writing-agent-skills/evals/`); it wasn't reverted since it's genuinely
correct and useful. But it was unintended and unreviewed at write-time — a
first-class example of the skill's own rule violated in the act of testing
it: *"no hardcoded personal paths / isolate every run"* (step 5) also implies
*never point a live probe's task target at a real skill directory*. Every
probe below fixes this: all fixture paths live inside the trial's own temp
dir, never a real skill.

## What's built

- **L1 — `test_templates.py`**, offline, free: every `.py` in `templates/`
  parses; `prompt_set.json` template has the required keys;
  `run_layer2_probes.py`/`judge.py` templates exit 0 with a skip message when
  `PI_LIVE_EVAL` is unset. Regression guard against a future edit breaking
  template syntax or the skip-gate convention.

  ```bash
  cd <this-skill-dir>
  python3 -m unittest evals.test_templates -v
  ```

- **L2 (trigger-only) — `run_trigger_probes.py`**: 3 prompts
  (`prompt_set.json`), each run via bare `pi -ne` (no `--skill`), checking
  only whether the transcript shows an early `read` of this skill's own
  `SKILL.md` — a positive case ("what eval layers would you use for the
  skill at `{FIXTURE_SKILL_DIR}}`?") and two negatives mapped directly onto
  the description's stated negative cases (writing a new SKILL.md → belongs
  to `writing-agent-skills`; a general product/LLM-feature eval → outside
  scope entirely). Every fixture path is generated inside the trial's own
  temp dir (see incident above) — never a real skill.

  ```bash
  cd <this-skill-dir>
  PI_LIVE_EVAL=1 python3 evals/run_trigger_probes.py
  ```

  **N=1 finding:** 3/3 passed. The positive case triggered correctly (`read`
  on this skill's `SKILL.md`, then classified the fixture honestly as "too
  trivial to need a real eval plan" rather than fabricating one). Both
  negatives correctly did *not* trigger this skill — the SKILL.md-write
  negative triggered `writing-agent-skills` instead (contained write, inside
  the temp dir) and the general-product-eval negative did no tool calls at
  all, explicitly noting it wasn't "a Pi Skill eval."

## Explicitly out of scope

- **Full L2** (spin up a fixture target skill, have the agent build a
  complete eval suite for it, then grade the *quality* of that output
  directory) — high cost (the first attempt at this, before narrowing the
  prompt to trigger-only, timed out at 480s), fuzzy grading criteria, low
  marginal ROI over the trigger tests above. Not built, not faked.
- **L3 (LLM-as-judge)** — nothing here is qualitative enough to need a
  second model pass; the trigger signal is a deterministic tool-call check.
- **L2b (real delegation pipeline)** — N/A by design. This skill doesn't
  delegate to subagents; it produces markdown and file templates directly.
  A live demonstration of the skill's own claim: "not every skill needs
  every layer."
