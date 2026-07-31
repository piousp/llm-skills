# Evals for `prompt-generator`

Method adapted from Philipp Schmid's ["Practical Guide to Evaluating and
Testing Agent Skills"](https://www.philschmid.de/testing-skills) and
Anthropic's ["Demystifying evals for AI
agents"](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents),
via this repo's `evaluating-agent-skills` skill. `iterative-design/evals/`
is the worked example this suite follows structurally; it's adapted down
here because `prompt-generator` is much simpler: no `scripts/` of its own,
and no dependency on a subagent/delegation tool.

## Classification

`prompt-generator` is a **preference skill** — it encodes a specific,
always-the-same workflow (fast scan → propose → confirm/adjust loop →
verbatim block → stop unless told to continue), not a base-model capability
gap. Per SKILL.md's opening line it is **always invoked by explicit name**.
That means the `should_trigger` / description-tuning axis both source
articles emphasize does not apply here — there are no negative-trigger
cases in `prompt_set.json`, and `should_trigger` is `true` on every entry
purely for schema consistency with the template, not because it's being
tested.

## Success criteria (defined before any check was written)

For this skill, "success" is **process fidelity** to the six numbered steps
in "How to run", the Ask-vs-assume rule, the block format, and the Handoff
boundary — not "did it write correct code" (it never writes code).

- **Outcome** — a fenced, two-part verbatim block (context lines, blank
  line, sharpened prompt) is emitted, and only after the user explicitly
  confirms. Nothing in the fixture repo is mutated (no `Edit`/`Write` calls,
  file contents unchanged) — this skill only sharpens a prompt, it never
  starts the work.
- **Style & instructions** — the specific directives in SKILL.md are
  honored: scope-changing ambiguity gets a direct, targeted question naming
  the actual candidates (`direct_question_asked`, `no_silent_pick`);
  low-impact ambiguity gets assumed-and-flagged instead of asked
  (`no_question_about_lowimpact`, `assumption_flagged`); an adjustment
  always triggers a re-proposal, never a jump straight to the block
  (`no_block_on_adjust_turn`, `reproposal_after_adjust`); the block appears
  only at/after explicit confirmation (`block_only_after_confirm`); the
  skill doesn't continue the task afterward unless told to
  (`no_task_continuation_after_block`,
  `task_continuation_allowed_when_explicit`).
- **Efficiency** — the fast scan stays fast: bounded tool-call count before
  the first proposal (`scan_bounded`), reads land on the file(s) the prompt
  actually names (`scan_read_named_area`), and the question budget stays
  low — "a few targeted questions at most" per the Ask-vs-assume guard
  (`question_budget_low`, capped at 3 across a whole run).

All 17 check IDs above are implemented in `run_layer2_probes.py`'s
`CHECK_REGISTRY`, one pure function per ID, per
`evaluating-agent-skills/references/check-registry-pattern.md`.

## The `turns` schema deviation

`evaluating-agent-skills/templates/prompt_set.json` defines single-turn
cases (`"prompt": "..."`). This skill's core behavior is a **confirm/adjust
loop across turns** (step 4 of "How to run"), which a single-shot prompt
can't exercise. `prompt_set.json` here extends the schema with an optional
`"turns": ["turn 1 text", "turn 2 text", ...]` field used instead of
`"prompt"` for 5 of the 14 cases (`loop_confirm_first`, `loop_one_adjust`,
`loop_two_adjusts`, `post_block_stop`, `post_block_continue_here`). JSON has
no comment syntax, so this deviation is documented here instead of inline.
`run_layer2_probes.py`'s `run_case()` drives each turn sequentially against
the same `pi --session <path>` file (the same pattern
`iterative-design/evals/run_layer2b_pipeline.py` uses for its Phase 2→3
multi-call sequence), and every check function receives the **full
multi-turn record** (not just the final turn), because checks like
`reproposal_after_adjust` need to see turn 2's response, not just the last
turn's. Since this skill is always invoked by explicit name (never
auto-triggered), every case's first turn — the `"prompt"` field, or turn 1
of a `"turns"` array — is prefixed with an explicit invocation phrase
(e.g. "Using the prompt-generator skill, sharpen this ask: ...");
subsequent turns in a multi-turn case do not repeat the prefix.

## Layers built — and why L1 / L2b are skipped entirely

- **L1 (code-based, offline)** — skipped. `prompt-generator` ships no
  `scripts/*`; the entire skill is markdown instructions, so there is no
  first-party code to unit-test.
- **L2 (trajectory probes)** — built (`run_layer2_probes.py`). This is the
  default layer every skill should have, and it's sufficient here: every
  behavior in "How to run" and "Ask vs. assume" is checkable by inspecting
  tool calls and transcript text (no fenced block before confirmation, no
  mutation, bounded scan, question targets the named ambiguity, etc.).
- **L3 (LLM-as-judge)** — built, small (`judge.py`, 3 of the 14 probes).
  Reserved for the handful of questions regex genuinely can't answer:
  whether a reformulation is *materially* sharper or just cosmetic
  paraphrase, whether a mid-loop adjustment was *faithfully* folded into the
  re-proposal (not just acknowledged), and whether a clarifying question
  targets the *actual* fork between two seeded candidates rather than a
  generic "can you clarify?" that dodges naming either one.
- **L2b (real delegation/tool pipeline)** — skipped, and skipped
  intentionally, not by oversight. `prompt-generator` has no dependency on
  `subagent` or any other tool absent from bare `pi -ne`; it hands off to a
  *fresh session* the user pastes into themselves, it doesn't drive that
  session itself. There is nothing for an L2b-style real-tool-pipeline
  layer to exercise.

## Live-run history

`run_layer2_probes.py` (Layer 2) has been run live four times so far, each
time root-causing and fixing what failed before the next run. `judge.py`
(Layer 3) exists but **has not yet been executed in any of these runs** —
it is built but currently unexercised; nothing below should be read as
implying otherwise.

- **Run 1 — 1/14 PASS.** The skill never triggered: prompts lacked an
  explicit invocation phrase, so bare `pi -ne` never loaded
  `prompt-generator` at all. Root-caused and fixed by prefixing every
  case's first turn with an explicit invocation phrase (see "The `turns`
  schema deviation" above).
- **Run 2 — 8/14 PASS.** After the invocation-prefix fix. Remaining
  failures were fixture/check-function issues, not skill-behavior issues.
- **Run 3 — 9/14 PASS.** After fixing `question_budget_low` to count
  per-round instead of cumulatively across the whole run, and removing a
  check from `detailed_buried_gap` that didn't match what that fixture
  actually asserts.
- **Run 4 — 11/14 PASS.** After widening `gap_surfaced`'s doubt-word list
  (it was missing legitimate hedging phrasing the model used) and removing
  a self-contradictory check from `post_block_continue_here`.

### Accepted, not-further-chased cases

Two cases remain failing/flaky and are accepted as-is rather than chased
further:

- **`lowimpact_default`** — the model consistently judges the seeded
  ambiguity as scope-changing (asks a direct question) despite fixture
  enrichment intended to nudge it toward low-impact. This reads as a
  legitimate borderline judgment call by the model, not a bug in the check
  or the fixture.
- **`lowimpact_naming`** — flipped pass/fail across runs with an unchanged
  fixture. Accepted as N=1 model variance per "Known limitations" below,
  not chased further.

### `question_budget_low` is intentional, not a bug to relax

`question_budget_low` enforces SKILL.md's own Ask-vs-assume guard — "a few
targeted questions at most" / "one targeted question at a time." If it
occasionally fails on a turn where the model asks multiple questions at
once, that is the check correctly flagging real spec-adherence variance in
the model's output, not a check-function bug. Do not relax this check
further to make such failures disappear.

## Known limitations

- **`ask_user_question` likely absent in bare `pi -ne`.** Confirmed
  empirically in `iterative-design/evals/` that bare `pi -ne` (no
  extensions) exposes only Read/Bash/Edit/Write/Grep/find/ls — no
  `ask_user_question` tool. SKILL.md's Ask-vs-assume section says to prefer
  `ask_user_question` "if available, plain chat otherwise" — this harness
  necessarily exercises the plain-chat fallback path. `direct_question_asked`
  and related checks therefore detect a scope-changing question as a
  plain-text line ending in `?` within the transcript, not as a structured
  tool call. Same documented workaround as `iterative-design/evals/`.
- **N=1 during development.** Every probe here has been run/reasoned about
  at single-trial granularity while building this harness, not the 3–5
  trials both source articles recommend for non-deterministic agent output.
  Widen trial count once the harness itself is trusted (per
  `evaluating-agent-skills/SKILL.md` step 5) — this is a known gap, not a
  hidden one.
- **`block_format_valid` and related checks are structurally loose by
  design.** They check for "two paragraphs separated by a blank line inside
  a fenced block", not exact prose matching — SKILL.md doesn't mandate
  specific wording inside the block, only the two-part shape (context, then
  sharpened prompt), so a stricter check would over-fit to one phrasing.

## Run commands

```bash
cd /Users/pabloperaza/.pi/agent/skills/prompt-generator   # or wherever this skill lives locally
PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py
PI_LIVE_EVAL=1 python3 evals/judge.py
```

Both are gated behind `PI_LIVE_EVAL=1` — unset (or any other value) skips
with a clear message, since both cost real LLM tokens/time and must never
run as part of a default/offline test suite.
