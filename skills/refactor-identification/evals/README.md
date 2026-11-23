# Evals for `refactor-identification`

Method from `evaluating-agent-skills` (itself adapting Philipp Schmid's
"Practical Guide to Evaluating and Testing Agent Skills" and Anthropic's
"Demystifying evals for AI agents").

## Classification (step 1)

Unlike a name-only-invoked preference skill, this skill has a real "when" clause and explicit negative cases in its `description` (`Use for "refactor candidates" or "is a refactor worth it in this branch". [DO NOT] use for renames, applying fixes, a simplification or cleanup plan (use pablo-code-simplify), bugs (use qa-adversary), a full branch or PR review (use pablo-code-review or pablo-pr-review), or whole-repo scans.`). That makes `should_trigger` a real, checkable axis in addition to process fidelity once active; both are built here.

It ships no `scripts/*.py` (pure markdown + `references/`), so there is no
target for a Layer 1 unit-test-the-script pass. `test_harness.py` instead
guards the eval suite's own scripts/schemas (offline, free) — a regression
net, not a test of the skill itself.

## Success criteria (step 2, defined before any check was written)

- **Trigger axis**: fires on genuine "refactor candidates in my branch" requests (including a differently phrased one) and the merge-readiness deep-dive case; does NOT fire on its own [DO NOT] list (executing a refactor, a cleanup plan for `pablo-code-simplify`, whole-repo scans, trivial renames).
- **Process fidelity once active**:
  - Never mutates repo code (`edit`/`write` on a repo file) — identification
    only, per Boundaries.
  - Output follows the mandatory template verbatim: `### Scope`,
    `### Findings`, `### Unresolved`, `### Filtered out`, `### Summary`.
  - Every finding is anchored with real `file:line` evidence inside the diff, and its gate note names the closest row and why it doesn't apply (`N<k> doesn't apply because …`).
  - A genuine structural duplicate (the skill's own A1 worked example,
    reproduced live) is correctly categorized A1 with P1.
  - A speculative single-implementation "candidate" (the skill's own
    "rejected by the gate" worked example, reproduced live) lands in
    Filtered out citing N1, never as a Finding.
  - `### Scope` always carries a `Coverage:` line.
  - A base ref that does not exist yields the Blocked form (`### Scope` with `- Blocked: <error>`), never `### Findings`.

Outcome over transcript throughout: checks inspect tool calls (`edit`/`write`
targets) and structural markers in the final text, not whether the response
merely *claims* to have followed the process.

## Layers

### Layer 1 — offline, free (harness regression guard)

`test_harness.py`: both prompt sets have the required schema and unique ids,
every `expected_checks`/fixture id referenced by a prompt set is actually
registered in the corresponding script, and all three live-gated scripts
exit 0 with a skip message when `PI_LIVE_EVAL` is unset (never shells out to
`pi` by accident). `CheckFunctionTest` pins `gate_note_present`, `scope_has_coverage_line` and `reports_blocked_without_findings` on literal transcripts.
`TriggerFixtureTest` seeds the trigger fixture with git's default branch forced to
`master` and checks that `main` exists and carries the diff (skipped without `git`
on PATH).

```bash
cd <this-skill-dir>
python3 -m unittest evals.test_harness -v
```

### Layer 2a — trigger-only probes, live-gated

`run_trigger_probes.py` + `trigger_prompt_set.json`: 6 prompts run via bare
`pi -ne` with **no** `--skill` flag (real discovery). Trigger signal: an
early `read` of this skill's own `SKILL.md` (the same proxy validated by
`evaluating-agent-skills`' own trigger probes).

```bash
cd <this-skill-dir>
PI_LIVE_EVAL=1 python3 evals/run_trigger_probes.py
```

**N=1 finding, previous description: 5/5 passed** (after fixing a fixture defect, see below). Re-run required: the description changed, and `negative_cleanup_routes_to_simplify` was added.
- `negative_execute_the_refactor`, `negative_whole_repo_scan`,
  `negative_trivial_rename` correctly did NOT trigger this skill (one even
  cited its own scope: *"my `refactor-identification` skill is explicitly
  scoped to the current branch's diff and excludes whole-repo scans by
  design"* — for an unrelated whole-repo-scan ask, meaning discovery
  correctly rejected it, not merely stayed silent).
- `edge_deep_dive_from_review` correctly triggered (read this skill's
  `SKILL.md`, then reached for `git`/file context).
- `positive_branch_refactor_question` **initially failed** with an empty
  fixture workdir: the agent ran `bash` first (an environment probe), found
  no repository, and replied asking for the real repo path **without ever
  reading this skill's `SKILL.md`**. Root-caused as a fixture defect, not a
  description defect: nothing in the prompt referred to files that actually
  existed on disk, so the model short-circuited on "nothing to analyze yet"
  before considering which skill applies. Fixed by giving this one case a
  real git fixture (`seed_branch_with_real_diff`: a `feature` branch with an
  actual diff against `main`, touching `OrderService.java` and
  `PaymentService.java` as the prompt describes) instead of the generic
  empty-workdir fixture. Re-run: triggered correctly (read this skill's
  `SKILL.md`, then `git diff`), and — as a bonus — the fixture happened to
  contain a genuine byte-for-byte A1 duplicate, which the response also
  identified correctly (P1, N1/N2/N3 gate reasoning, correct refactor
  direction), incidentally cross-validating Layer 2's detection logic on an
  independent fixture.

### Layer 2 — process-fidelity probes, live-gated (forced `--skill`)

`run_layer2_probes.py` + `prompt_set.json`: 5 prompts, each seeding a real
git fixture repo (a `feature` branch over `main`, or over `trunk` for
`blocks_when_base_ref_missing`), run via `pi -ne --skill <this dir>`. Three
fixtures reproduce the skill's own worked examples (A1, the N1 filter and the
N9 filter); `ignores_out_of_language_files` and `blocks_when_base_ref_missing`
reproduce none.

```bash
cd <this-skill-dir>
PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py
```

**N=1 finding (pre-R18 run: 3/3 probes passed, 12/12 checks). Re-run required: the N9 probe was replaced, the out-of-language and missing-base probes were added, and the gate-note and Coverage checks changed.**
- `detects_a1_structural_duplication`: correctly found `[RF-1] A1 Structural
  duplication ... — P1`, evidence anchored at both methods' real line
  numbers, gate note citing N1/N3 as inapplicable, refactor direction
  pointing at `pablo-code-philosophy`'s `references/fp/mechanics.md`
  higher-order-function row — no
  repo file was ever edited/written.
- `rejects_single_implementation_by_n1`: correctly emitted `### Findings\n-
  (none)` and moved all three considered candidates to `Filtered out`
  (N1, N3, N7), never fabricating an `[RF-n]` Finding for the
  single-implementation discount rule.
- `routes_cross_repo_duplicate_to_filtered_out` (N9 gate): 1 local occurrence
  of a business-rule predicate whose other copy may live in an inaccessible
  repo — must land as one `### Filtered out` line naming that repo, never as
  a fabricated Finding or a silent drop. `detects_a1_structural_duplication`
  also checks the added copy is P1.
- `ignores_out_of_language_files`: the feature adds only `tools/sync.py` with
  2 identical functions — must be listed as out of language scope with no
  `[RF-n]` Finding.
- `blocks_when_base_ref_missing`: the fixture has no `main` branch while the prompt names `main` as base; the response must be the Blocked form, with no `### Findings` and no `[RF-n]`.

### Layer 3 — LLM-as-judge, live-gated

`judge.py`: re-runs 2 of the 5 Layer 2 probes and sends each transcript
to a second `pi` call for a qualitative verdict — was the A1-vs-other-
category call actually correct (not just keyword-present), was the P1
priority justified, was the N1 rejection rationale faithful to the skill's
own worked example rather than a generic dismissal.

Coverage note: the `routes_cross_repo_duplicate_to_filtered_out` (N9-routing)
probe has no judge spec — conscious decision for now (its check is
deterministic); pending if that transcript ever needs qualitative review.

```bash
cd <this-skill-dir>
PI_LIVE_EVAL=1 python3 evals/judge.py
```

Not run for this pass (Layer 2's deterministic checks already covered the
category/priority/gate-citation claims precisely enough via exact-string
matches against the fixture's real file:line values and rule IDs — see
step 4's cost/benefit guidance). Kept as a template for a future qualitative
gap (e.g. distinguishing a *subtly wrong* category from a correct one on a
messier, non-worked-example fixture).

### Layer 2b (real delegation) — N/A

This skill produces a markdown report directly; it never delegates to a
subagent or another tool. No `run_layer2b_pipeline.py`-style harness applies
(the skill's own claim: "not every skill needs every layer").

## Known limitations

- All live layers are single-trial (N=1), not the 3–5 trials both source
  articles recommend for non-deterministic agent output. Acceptable for a
  first pass given stable, non-flaky results across every check that did
  run; revisit if flakiness appears.
- `positive_branch_refactor_question` uses a
  case-specific fixture (`seed_branch_with_real_diff`) rather than the shared generic
  fixture the other five cases use, because its prompt asks about a branch diff that
  touches named files. If a future case needs the same treatment, prefer a real, minimal
  git fixture over an empty workdir whenever the prompt references concrete file/repo
  state.
