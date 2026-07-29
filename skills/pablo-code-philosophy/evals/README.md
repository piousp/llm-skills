# Evals for `pablo-code-philosophy`

## Classification (step 1) — name-only invocation, confirmed empirically

`pablo-code-philosophy` is a **name-only skill**: it is loaded only via
explicit delegation (see the calling agent's `AGENTS.md`), never
auto-triggered from natural-language requests.

This was not the original classification. The skill's description used to
carry a `TRIGGER when:` clause plus explicit negative cases, on the
assumption it should auto-trigger like a capability skill. An N=1 run of
this harness in auto-discovery mode (bare `pi -ne`, no `--skill`) tested
that assumption directly and falsified it:

- **0/10** of the `should_trigger: true` cases produced a real early `read`
  of this skill's own `SKILL.md` — no genuine auto-trigger, across writing
  new code, reviewing diffs, DRY/GoF judgment calls, and edge cases.
- pi's discovery mechanism itself was confirmed working in the same run —
  other skills' probes *did* show real auto-loads under the identical
  harness — so the failure is specific to this skill's description, not a
  broken mechanism.
- One apparent pass in that N=1 run was a false positive caused by a weak
  check (the `skill_loaded` fallback treated the skill's name appearing in
  prose as evidence of loading, which is not the same as a tool-call
  `read`). That check has since been retired along with the discovery
  harness itself (see below) — it is not carried forward.

Given a real (if small) empirical result plus the a priori argument (this
is Pablo's own preference/judgment skill, already invoked by name from
`AGENTS.md` delegation rules — there is no natural-language trigger to
discover), the skill is reclassified as name-only per
`writing-agent-skills` §2: the description only needs to be accurate, and
the body states plainly that it's invoked by name (see the "Invocation"
line in `SKILL.md`'s Scope section).

Per that same guidance, `should_trigger`/negative-control cases are dropped
entirely — nobody accidentally invokes a skill by its exact name, so a
"does this NOT trigger" case is a no-op for this skill category.

## Re-test attempt (auto-trigger, round 2) — reverted

After the initial name-only reclassification, the description was broadened
to explicitly name every principle (YAGNI, KISS, DRY, SOLID, Unix, ADTs, FP,
GoF) with a `TRIGGER when:` clause, on the hypothesis that richer keyword
coverage would fix the discovery miss. Re-tested in auto-discovery mode
(bare `pi -ne`, no `--skill`) against a representative 6-case subset:

| Case | Result |
|---|---|
| `trigger_dry_extract_decision` | 2/3 |
| `edge_yagni_refactor_cutoff` | 0/3 |
| `edge_mixed_philosophy_fp` | 2/2 (1 timeout, discarded) |
| `trigger_write_new_service` | 0/3 |
| `trigger_review_diff` | 0/3 |
| `trigger_suggest_tests` | 0/3 |

Partial, unreliable triggering (0-2/3) only on prompts that already state
design-decision vocabulary (duplication, composition, abstraction) in the
user's own words. **Zero** improvement on generic codegen, diff review, or
test-suggestion prompts — the same failure mode as round 1. Confirms the
root cause is structural (pi does not treat "write/review code" as a
capability gap this skill's description can close), not a wording/keyword
coverage problem. Reverted to the name-only description and Scope wording.
**Do not re-open this by further description iteration** — a different
intervention (e.g. changing what triggers this skill at the calling-agent
level, not the skill's own description) would be required, and that is out
of this skill's scope.

## What's built

- **L1** — not built. This skill has no scripts of its own beyond these
  evals (it's markdown + reference docs); there's no template syntax or
  skip-gate convention to regression-test independently of L2.
- **L2 (behavioral outcome) — `run_layer2_probes.py`**: 10 prompts
  (`prompt_set.json`), each run with `--skill <SKILL_DIR>` **forced** —
  loading is no longer the question (it's name-only, always loaded when
  invoked); the question is whether the skill's rules actually show up in
  the response/tool calls once it's loaded. This replaces the prior
  auto-discovery harness (bare `pi -ne`, no `--skill`), which is retired
  along with the `skill_loaded`/`skill_not_loaded` checks and the negative
  controls — all three only made sense while auto-trigger was the
  hypothesis under test.
  - Every fixture lives inside the trial's own temp dir
    (`server.js`, `order_service.py`, `changes.diff`, `messy_module.py`,
    `other_module.py`, `validations.scala`, and a throwaway git repo) —
    never a real skill directory or a real repo file (see the incident
    documented in `evaluating-agent-skills/evals/README.md`; the same rule
    applies here).
  - Four fixtures were rebuilt to fix mismatches the N=1 run's fixture
    noise exposed: an "existing API" prompt now has a real `server.js`
    Express endpoint; the diff prompt references a real `order_service.py`
    (was a nonexistent `service.py`); the "tests for the change I just
    made" prompt now runs against a real git repo with a committed
    baseline and an uncommitted `messy_module.py` change; the Scala/FP
    prompt now has a real `validations.scala` file to reason about.
- **L3 (LLM-as-judge)** — still explicitly deferred, YAGNI. Checks stay
  structural/keyword-based (an edit/write tool call's target path, or a
  simple substring match on the response text) — no judgment calls to
  outsource to a second model.

## Prompt set composition (10 cases)

- **7 cases** exercising the description's core scenarios: writing a new
  service, adding an endpoint to an existing API, implementing a function
  (Scala), a DRY extraction decision, a GoF/Strategy gate decision,
  reviewing a diff, and suggesting tests for a change.
- **3 edge cases**: a refactor where the YAGNI cut-off is the central
  decision; a request that mixes design philosophy with FP mechanics (both
  this skill and `functional-programming` may be relevant); and a "clean up
  this file" request that must exercise the skill's own "Surgical Changes"
  section (edit only the named file, not an unrelated one).

There are no `should_trigger: false` / negative-control cases — dropped per
the name-only reclassification above.

## Check registry

`CHECK_REGISTRY` in `run_layer2_probes.py` (all behavioral, evaluated with
the skill's load forced — none of them test discovery):

- `mentions_keywords:<kw1>|<kw2>|...` — the response names at least one
  relevant principle/edge-case keyword (e.g. `yagni|kiss|dry|solid`,
  `test|edge case|boundary|null`) instead of jumping straight to
  code/approval with no stated rationale. Simple substring match, no
  LLM-as-judge.
- `tests_planned` — passes if a unit-test plan shows up via ANY of: a
  `write`/`edit` tool call whose path matches `test|spec`, a `write` whose
  content mentions `test`/`prueba`, or `final_text` mentioning `test`/
  `prueba` (EN/ES). Prefers tool-call evidence over `final_text` — an
  earlier version of this check only grepped `final_text` and produced
  false negatives (a model that wrote a test file without saying "test" in
  its prose summary still failed the old check). See the finding below on
  `trigger_implement_scala_function`.
- `no_unrelated_edits[:<file1>,<file2>,...]` — fails if any `edit`/`write`
  tool call targets a file outside the ones named (default:
  `messy_module.py`) — the skill's "Surgical Changes" rule.
- `no_file_edits` — for the pure-review prompt: no `edit`/`write` tool call
  should occur at all.
- `sibling_loaded:<name>` — early `read` of a named sibling skill's
  `SKILL.md` (still meaningful: forcing *this* skill's load says nothing
  about whether an unforced sibling also fires for a mixed-topic prompt).

Retired: `skill_loaded` / `skill_not_loaded` (early-read-of-own-SKILL.md
checks) — meaningless once `--skill` forces the load every time.

## How to run

```bash
cd <this-skill-dir>
PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py
```

Skipped with exit 0 and a message if `PI_LIVE_EVAL` is unset — costs real
LLM tokens, never part of a default/offline test suite.

## Finding: Tests rule vs. Surgical Changes (standalone snippets)

`trigger_write_new_service` (a full multi-file service) went 3/3 on
`tests_planned` after the check fix above. `trigger_implement_scala_function`
(a single standalone function, no repo/change context) went **0/3** even
after promoting the Tests rule into the `Coding Principles` bullet list
("Tests are part of the deliverable") — the model consistently returned the
function with no test plan, across 3 trials.

Decision (Pablo, confirmed): **this is correct behavior, not a defect.**
For an isolated snippet request with no stated change/repo context,
`Surgical Changes` ( "every changed line must trace directly to the
request", don't add what wasn't asked for) outweighs the Tests rule. The
Tests rule is intended for changes to existing code, not bare snippet
requests. `SKILL.md` is left as-is; `trigger_implement_scala_function`'s
`expected_checks` was set to `[]` to reflect this as the expected outcome
rather than a failure. Do not re-open this by further wording tweaks — see
`writing-agent-skills` §3/§7 on not overfitting a skill to eval prompts.

## Note on original analysis finding #5

Finding #5 (retirement criteria per `writing-agent-skills` §8, tied to model
capability improvements) does not apply to this skill: it is a **preference**
skill encoding Pablo's own judgment calls (conflict resolutions, cut-off
thresholds), not a capability gap a stronger model would close on its own.
Its only legitimate retirement/rewrite trigger is a change in Pablo's own
process or judgment — never "the model got smarter."
