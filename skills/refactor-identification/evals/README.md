# Evals for `refactor-identification`

Method from `evaluating-agent-skills` (itself adapting Philipp Schmid's
"Practical Guide to Evaluating and Testing Agent Skills" and Anthropic's
"Demystifying evals for AI agents").

## Classification (step 1)

Unlike a name-only-invoked preference skill, this skill has a
real "when" clause and explicit negative cases in its `description`
(`TRIGGER: deciding if a refactor belongs in this branch, "refactor
candidates" requests, or as the deep-dive behind a broader code-review pass.
SKIP: renames, trivial extraction, executing fixes, whole-repo scans, merge
gating.`). That makes `should_trigger` a real, checkable axis *in addition
to* process fidelity once active — both are built here.

It ships no `scripts/*.py` (pure markdown + `references/`), so there is no
target for a Layer 1 unit-test-the-script pass. `test_harness.py` instead
guards the eval suite's own scripts/schemas (offline, free) — a regression
net, not a test of the skill itself.

## Success criteria (step 2, defined before any check was written)

- **Trigger axis**: fires on genuine "refactor candidates in my branch"
  requests and the code-review-checklist deep-dive case; does NOT fire on
  its own stated SKIP list (executing a refactor, whole-repo scans, trivial
  renames).
- **Process fidelity once active**:
  - Never mutates repo code (`edit`/`write` on a repo file) — identification
    only, per Boundaries.
  - Output follows the mandatory template verbatim: `### Scope`,
    `### Findings`, `### Filtered out`, `### Summary`.
  - Every finding is anchored with real `file:line` evidence inside the
    diff, and carries a gate note referencing N1–N8.
  - A genuine structural duplicate (the skill's own A1 worked example,
    reproduced live) is correctly categorized A1 with P1.
  - A speculative single-implementation "candidate" (the skill's own
    "rejected by the gate" worked example, reproduced live) lands in
    Filtered out citing N1, never as a Finding.

Outcome over transcript throughout: checks inspect tool calls (`edit`/`write`
targets) and structural markers in the final text, not whether the response
merely *claims* to have followed the process.

## Layers

### Layer 1 — offline, free (harness regression guard)

`test_harness.py`: both prompt sets have the required schema and unique ids,
every `expected_checks`/fixture id referenced by a prompt set is actually
registered in the corresponding script, and all three live-gated scripts
exit 0 with a skip message when `PI_LIVE_EVAL` is unset (never shells out to
`pi` by accident).

```bash
cd <this-skill-dir>
python3 -m unittest evals.test_harness -v
```

### Layer 2a — trigger-only probes, live-gated

`run_trigger_probes.py` + `trigger_prompt_set.json`: 5 prompts run via bare
`pi -ne` with **no** `--skill` flag (real discovery). Trigger signal: an
early `read` of this skill's own `SKILL.md` (the same proxy validated by
`evaluating-agent-skills`' own trigger probes).

```bash
cd <this-skill-dir>
PI_LIVE_EVAL=1 python3 evals/run_trigger_probes.py
```

**N=1 finding: 5/5 passed** (after fixing a fixture defect — see below).
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

`run_layer2_probes.py` + `prompt_set.json`: 2 prompts, each seeding a real
git fixture repo (`main` branch + a `feature` branch) reproducing one of the
skill's own worked examples verbatim, run via `pi -ne --skill <this dir>`.

```bash
cd <this-skill-dir>
PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py
```

**N=1 finding: 2/2 probes passed, 9/9 checks.**
- `detects_a1_structural_duplication`: correctly found `[RF-1] A1 Structural
  duplication ... — P1`, evidence anchored at both methods' real line
  numbers, gate note citing N1/N3 as inapplicable, refactor direction
  pointing at `functional-programming`'s higher-order-function row — no
  repo file was ever edited/written.
- `rejects_single_implementation_by_n1`: correctly emitted `### Findings\n-
  (none)` and moved all three considered candidates to `Filtered out`
  (N1, N3, N7), never fabricating an `[RF-n]` Finding for the
  single-implementation discount rule.

### Layer 3 — LLM-as-judge, live-gated

`judge.py`: re-runs the same two Layer 2b probes and sends each transcript
to a second `pi` call for a qualitative verdict — was the A1-vs-other-
category call actually correct (not just keyword-present), was the P1
priority justified, was the N1 rejection rationale faithful to the skill's
own worked example rather than a generic dismissal.

```bash
cd <this-skill-dir>
PI_LIVE_EVAL=1 python3 evals/judge.py
```

Not run for this pass (Layer 2b's deterministic checks already covered the
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
- The fixed `positive_branch_refactor_question` fixture is now
  case-specific (`seed_branch_with_real_diff`) rather than using the shared
  generic fixture the other four cases use — a reasonable asymmetry (this
  is the only case whose prompt claims specific files exist), but worth
  remembering if a future case needs the same treatment: prefer a real,
  minimal git fixture over an empty workdir whenever the prompt references
  concrete file/repo state.
