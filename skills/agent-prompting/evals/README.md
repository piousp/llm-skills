# Evals for `agent-prompting`

Method adapted from Philipp Schmid's ["Practical Guide to Evaluating and
Testing Agent Skills"](https://www.philschmid.de/testing-skills) and
Anthropic's ["Demystifying evals for AI
agents"](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents),
via this repo's `evaluating-agent-skills` skill.

## Classification

`agent-prompting` is an **auto-triggered guide skill**: it loads when the
coordinator is about to send a prompt to a subagent and shapes the
delegation message. It replaces the old `prompt-generator` (a
preference-style sharpener invoked by name); the confirm/adjust loop and
the fenced verbatim-block deliverable no longer exist. Success is
**delegation-prompt quality**: when handed a delegation task, the agent
produces a prompt carrying the skill's load-bearing elements.

## Success criteria (defined before any check was written)

- **Trigger** — the skill applies to delegation tasks (web-search,
  planning, implementation, review, transparency) and [DO NOT] applies to
  tasks the coordinator does directly: there is a negative case
  (`negative_no_delegation`, `should_trigger: false`) that must NOT get
  delegation scaffolding (`answered_directly`).
- **Prompt anatomy** — the produced prompt has an objective
  (`has_objective`), an output contract (`has_output_contract`), a stop
  rule for bounded work (`has_stop_rule`), and the skill's scaffolding is
  present at all (`auto_triggered`).
- **Mechanism rules** — the web-scout contract is INLINE, never a local
  lens path (`contract_inline_for_web`; the process finding showed an
  unreadable lens stalling the delegation, and inline keeps the contract
  visible in the transparency preview and portable to any web-only
  agent; read was later granted to web-scout but inline stays by
  design); lens-based delegation is fail-closed (`fail_closed_lens`);
  planning is case-fail-closed (`case_fail_closed`: contracts the goal
does not support surface as open questions); one lens per invocation
(`lens_single`).
- **Meta-coordination** — the transparency step shows the exact prompt
  before sending (`prompt_sent_is_shown`).
- **Guardrails** — the fixture repo is never mutated (`no_mutation`) and
  preparation scans stay bounded (`scan_bounded`).

All 12 check IDs are implemented in `run_layer2_probes.py`'s
`CHECK_REGISTRY`, one pure function per ID, per
`evaluating-agent-skills/references/check-registry-pattern.md`.

## Auto-trigger vs. prompt quality

The Layer 2 probes run with `--skill` (forced skill load) and therefore
validate prompt **quality**, not description-triggering. The real
auto-trigger (the skill loading without an explicit invocation, driven by
the frontmatter `description`) is probed separately, after the skill is
synced to `~/.pi/agent/skills/`:

```bash
cd <some repo> && pi -ne -p "delegá una búsqueda web: ..." 2>&1 | grep -i "agent-prompting"
```

The skill is considered to trigger when the description's contexts match a
delegation task; the negative case validates the [DO NOT] clause.

## Layers built — and why L1 / L2b are skipped

- **L1 (code-based, offline)** — skipped. `agent-prompting` ships no
  `scripts/*`; the entire skill is markdown instructions, so there is no
  first-party code to unit-test.
- **L2 (trajectory probes)** — built (`run_layer2_probes.py`). The default
  layer every skill should have, and sufficient here: every success
  criterion above is checkable by inspecting tool calls and transcript
  text.
- **L3 (LLM-as-judge)** — built, small (`judge.py`, 3 of the 6 probes).
  Reserved for the handful of questions regex genuinely can't answer:
  whether a web-search prompt is *materially* actionable (operative stop
  rule, real contract fields) vs. vague; whether a planner prompt carries
  the goal authoritatively with out-of-scope and a verifiable deliverable;
  whether the transparency step showed the exact paste-ready prompt vs. a
  summary.
- **L2b (real delegation pipeline)** — skipped, intentionally. The skill
  is a guide; it does not call `subagent` itself — the coordinator does,
  after reading the skill. An end-to-end integration probe (produce a
  prompt with the skill, then actually run it against a web-scout) is a
  possible future layer but costs real delegation runs; the L2 checks
  already validate the prompt's load-bearing elements.

## Run commands

```bash
cd /home/pablo/LLMs/skills/agent-prompting   # or wherever this skill lives locally
PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py
PI_LIVE_EVAL=1 python3 evals/judge.py
```

Both are gated behind `PI_LIVE_EVAL=1` — unset (or any other value) skips
with a clear message, since both cost real LLM tokens/time and must never
run as part of a default/offline test suite.

## Known limitations

- **Live run 2026-08-14: 6/6 L2 + 3/3 L3 PASS post-composition.** The
  run validates the composition adjustments (T1 slim, T-scout slim, T2
  option a, `case_fail_closed`); two evals-side fixes were needed and
  are committed: `SKILL_SIGNALS` gained the T2 (option a) vocabulary
  (out of scope / open questions / verbatim / never invent — the check
  was written against the pre-option-a T2 that carried a lens), and the
  L3 judge's planning instruction no longer demands a lens path
  (planning is case-fail-closed; the planner selects its lens from
  settings).

- **N=1 during development.** Every probe has been reasoned about at
  single-trial granularity; widen to 3–5 trials once the harness is
  trusted (per `evaluating-agent-skills/SKILL.md` step 5).
- **Regex checks are intentionally loose.** They look for presence of
  signal words (objective, output contract, stop rule, fail-closed
  wording) rather than exact template matching, because the skill does not
  mandate fixed wording — only the elements. The L3 judge covers the
  semantic gaps.
- **`auto_triggered` is a proxy.** It detects the skill's scaffolding in
  the produced text, not the harness-level skill-load event (which
  `--skill` forces). The real trigger axis is the separate probe above.
