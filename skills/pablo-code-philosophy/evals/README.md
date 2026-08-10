# Evals for `pablo-code-philosophy`

## Classification (step 1) - post-split state (2025-08-08)

The 2025-08-08 split (OQ2) restructured the skill into three: `pablo-code-philosophy`
keeps the judgment layer (pipeline, precedence, conflict matrix, surgical changes);
`pablo-tdd` absorbed `tdd` and owns test knowledge (what a good test is, seams,
anti-patterns, the red → green loop, the bare-snippet exception); `pablo-code-planning`
owns strict plans (analysis, decisions, contracts). All three skills carry
auto-trigger-capable frontmatter descriptions per OQ2: an explicit "Trigger when:"
clause, a negative case with [DO NOT], and enforcement keys ([ALWAYS]/[DO NOT]) per
`writing-agent-skills` §2/§3. The philosophy's "Tests are part of the deliverable"
bullet is now a pointer to `pablo-tdd`.

Empirical validation of the auto-trigger and the corresponding eval updates are
deferred to a separate step (explicit deferral, OQ2; the evals/README ↔ SKILL.md sync
stays pending until that step). This harness adds no trigger probes: it keeps
measuring behavioral outcome with `--skill` forced.

Historical record (pre-split): an N=1 run in auto-discovery mode (bare `pi -ne`, no
`--skill`) measured 0/10 real auto-triggers, and a round-2 re-test with a broadened
description was reverted. That record drove OQ2's user decision: auto-trigger
descriptions with deferred validation, instead of continuing with name-only.

## What's built

- **L1** - not built. This skill has no scripts of its own beyond these
  evals (it's markdown + reference docs); there's no template syntax or
  skip-gate convention to regression-test independently of L2.
- **L2 (behavioral outcome) - `run_layer2_probes.py`**: 10 prompts
  (`prompt_set.json`), each run with `--skill <SKILL_DIR>` **forced**  - 
  loading is not the question (trigger validation is deferred, OQ2); the
  question is whether the skill's rules actually show up in the
  response/tool calls once loaded.
  - Every fixture lives inside the trial's own temp dir
    (`server.js`, `order_service.py`, `changes.diff`, `messy_module.py`,
    `other_module.py`, `validations.scala`, and a throwaway git repo)  - 
    never a real skill directory or a real repo file (see the incident
    documented in `evaluating-agent-skills/evals/README.md`; the same rule
    applies here).
  - Fixtures were rebuilt to fix mismatches the N=1 run's fixture noise
    exposed: an "existing API" prompt now has a real `server.js` Express
    endpoint; the diff prompt references a real `order_service.py` (was a
    nonexistent `service.py`); the Scala/FP prompt now has a real
    `validations.scala` file to reason about; the refactor and clean-file
    prompts run against a real `messy_module.py` inside a throwaway git
    repo with a committed baseline and an uncommitted change.
- **L3 (LLM-as-judge)** - still explicitly deferred, YAGNI. Checks stay
  structural/keyword-based (an edit/write tool call's target path, or a
  simple substring match on the response text) - no judgment calls to
  outsource to a second model.

## Prompt set composition (10 cases)

- **7 scenario cases** exercising the philosophy's core rules: adding an
  endpoint to an existing API (surgical edits), a DRY extraction decision,
  a GoF/Strategy gate decision, reviewing a diff (no edits), a refactor
  where the YAGNI cut-off is the central decision, a request mixing design
  philosophy with FP mechanics (both this skill and `functional-programming`
  may be relevant), and a "clean up this file" request that must exercise
  the "Surgical Changes" section (edit only the named file, not an
  unrelated one).
- **3 core-coverage cases** (AUD-14/OQ3) exercising the center of the skill:
  the decision pipeline order (YAGNI → KISS → DRY → SOLID), the precedence
  conflict KISS > DRY > SOLID, and a conflict-matrix resolution (DRY vs SRP).

The three test-planning probes (`trigger_write_new_service`,
`trigger_suggest_tests`, `trigger_implement_scala_function`) were re-homed
to `pablo-tdd`'s deferred evals (D15) after the split: test planning now
lives in that skill, not here.

There are no `should_trigger: false` / negative-control cases: the harness
measures behavior with the load forced, and trigger validation is deferred
per OQ2.

## Check registry

`CHECK_REGISTRY` in `run_layer2_probes.py` (all behavioral, evaluated with
the skill's load forced - none of them test discovery):

- `mentions_keywords:<kw1>|<kw2>|...` - the response names at least one
  relevant principle/edge-case keyword (e.g. `yagni|kiss|dry|solid`,
  `pipeline`, `srp`, `premature`) instead of jumping straight to
  code/approval with no stated rationale. Simple substring match, no
  LLM-as-judge.
- `no_unrelated_edits[:<file1>,<file2>,...]` - fails if any `edit`/`write`
  tool call targets a file outside the ones named (default:
  `messy_module.py`) - the skill's "Surgical Changes" rule.
- `no_file_edits` - for the pure-review prompt: no `edit`/`write` tool call
  should occur at all.
- `sibling_loaded:<name>` - early `read` of a named sibling skill's
  `SKILL.md` (still meaningful: forcing *this* skill's load says nothing
  about whether an unforced sibling also fires for a mixed-topic prompt).

Retired: `skill_loaded` / `skill_not_loaded` (early-read-of-own-SKILL.md
checks) - meaningless once `--skill` forces the load every time.
`tests_planned` was retired with the test probes: no probe in the re-scoped
set plans tests, and test-planning behavior itself now belongs to
`pablo-tdd`.

## How to run

```bash
cd <this-skill-dir>
PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py
```

Skipped with exit 0 and a message if `PI_LIVE_EVAL` is unset - costs real
LLM tokens, never part of a default/offline test suite.

## Finding: Tests rule vs. Surgical Changes (bare snippets)

Historical finding (pre-split): `trigger_write_new_service` (a full
multi-file service) went 3/3 on `tests_planned` after the check fix.
`trigger_implement_scala_function` (a single standalone function, no
repo/change context) went **0/3** even after promoting the Tests rule into
the `Coding Principles` bullet list ("Tests are part of the deliverable")  - 
the model consistently returned the function with no test plan, across 3
trials.

Decision (Pablo, confirmed): **this is correct behavior, not a defect.**
For an isolated snippet request with no stated change/repo context,
`Surgical Changes` ("every changed line must trace directly to the
request", don't add what wasn't asked for) outweighs the Tests rule.

Post-split (AUD-4): the exception now lives in the skill text, not only in
the evals. The philosophy's Tests bullet became a pointer - "every change
or new code ships with a unit-test plan; the how, and the bare-snippet
exception where Surgical Changes wins, lives in `pablo-tdd`" - and
`pablo-tdd` declares the exception in its own text ("bare snippet request
with no repo/change context → Surgical Changes wins, no test plan"). The
three test probes were re-homed to `pablo-tdd`'s deferred evals (D15); this
set no longer includes them, so the finding is recorded here as history
rather than enforced here.

Do not overfit eval prompts to the skill text - see `writing-agent-skills`
on testing a skill without overfitting it to a handful of prompts.

## Note on original analysis finding #5

Finding #5 (retirement criteria from the original article, see
`writing-agent-skills` "Source" - tied to model capability improvements,
and applying mainly to capability skills) does not apply to this skill: it
is a **preference** skill encoding Pablo's own judgment calls (conflict
resolutions, cut-off thresholds), not a capability gap a stronger model
would close on its own. Its only legitimate retirement/rewrite trigger is a
change in Pablo's own process or judgment - never "the model got smarter."
