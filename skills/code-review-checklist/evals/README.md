# Evals for `code-review-checklist`

Method adapted from Philipp Schmid's ["Practical Guide to Evaluating and
Testing Agent Skills"](https://www.philschmid.de/testing-skills) and
Anthropic's ["Demystifying evals for AI
agents"](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
`code-review-checklist` is a **process lens invoked explicitly** — the skill
is a read-only review methodology, not a base-model capability gap, and it is
triggered by name or by its trigger phrases ("checklist", "review my
changes", "am I ready to merge"), never auto-discovered from a description.
The trigger-tuning axis those articles emphasize therefore does not apply;
what is adapted is the method: define success first, build a small prompt
set, grade with deterministic checks before reaching for an LLM judge,
isolate each run, gate live layers behind `PI_LIVE_EVAL=1`.

## Success criteria (defined before any check was written)

For a review lens, "success" is **fidelity to the output contract plus
correct defect detection**:

- *Outcome* — the review is derived from the real diff (`git diff` /
  `git diff --cached` / `git diff main...HEAD`, or from a diff handed in the
  prompt) and the planted defects are found: hardcoded secret, mutable `let`,
  swallowed catch, boolean parameter, >25-line function, scope violation,
  tautological test, naming nit, redundant comment.
- *Style & instructions* — the response follows SKILL.md's exact format:
  `## Review:`, severity-tiered `### Section: pass | FAIL` blocks, `file:line`
  references, `Coverage Gaps` and `Suggested Tests` sections, `Verdict:
  READY | NEEDS WORK`, no praise (the lens "reports defects only, by
  design"), and — critically — no code mutation: "You do NOT modify code"
  is enforced as a hard check on the tool-call transcript.
- *Efficiency* — `n_tool_calls` is recorded per probe and reported in the
  summary (`Total tool calls: T`). There is no hard gate on it: a token/tool
  regression shows up in the report even when every check passes.

## Layers

### Layer 1 — omitted

The skill is 100% markdown (SKILL.md + `references/*.md`); there is no
`scripts/*` with real logic to unit-test offline. Layer 1 does not apply.

### Layer 2 — trajectory/tool-call probes, live-gated (central)

`run_layer2_probes.py` + `fixtures.py` + `prompt_set.json`: each probe seeds
a temp git repo (10 fixture builders: git init/commit, unstaged edits,
staged-only changes, a two-commit feature branch, a clean tree), runs bare
`pi -ne --skill <this dir> --mode json -p <prompt>`, parses the NDJSON
transcript for tool calls, and grades the response against 28 deterministic
checks in `CHECK_REGISTRY` (dispatch pattern per
`evaluating-agent-skills/references/check-registry-pattern.md`). Ten prompts
cover the skill's main paths and edge cases:

1. `dirty_diff_unstaged` — unstaged diff with 7 planted defects (secret,
   mutable let, swallowed catch, complexity, bool param, scope violation,
   weak test).
2. `clean_diff_all_pass` — tests-only change (no production edits),
   must come back READY.
3. `staged_diff_only` — only staged changes, must use `git diff --cached`.
4. `feature_branch_diff` — two-commit branch vs main, must use
   `git diff main...HEAD`.
5. `single_blocker_needs_work` — one Blocker fails the review outright.
6. `no_diff_graceful` — clean tree, must say there is nothing to review.
7. `diff_handed_in_prompt` — the diff is embedded in the prompt and must be
   treated as self-contained (SKILL.md Process step 1).
8. `negative_control` — a non-review question must not produce a review
   (`should_trigger: false`).
9. `english_trigger_phrase` — the description's English trigger phrases.
10. `nit_only_ready` — only nits (snake_case local + redundant "what"
    comment, no new public API), verdict must be READY with no
    Blocker/Major tags.

The offline safety net is built into the same script: `--validate` re-seeds
every fixture and asserts the exact `git diff` file set per case (unstaged /
`--cached` / `main...HEAD`), that every planted token is present in the
working files (or in the prompt-embedded diff for the self-contained case),
that fixture A's `src/orders.ts` really contains a >25-line `processOrders`,
that every `expected_checks` id exists in `CHECK_REGISTRY`, and runs
synthetic-transcript smoke tests for six checks (expected-pass /
expected-fail pairs). No LLM tokens are spent.

Live runs cost real LLM tokens and are gated behind `PI_LIVE_EVAL=1`, not
part of any default/offline suite:

```bash
cd <this-skill-dir>
python3 evals/run_layer2_probes.py --validate      # offline, free
PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py  # live, all 10 prompts
```

### Layer 3 — LLM-as-judge, live-gated

`judge.py`: re-runs two Layer 2 probes (`diff_handed_in_prompt`,
`no_diff_graceful`) and sends each transcript (tool calls + final response)
to a second `pi` call asking for a structured JSON verdict
(`{"passed": bool, "score": int, "notes": str}`). These are the qualitative
slices regex cannot reach: did the agent honor the "use exactly the handed-in
diff, treat the prompt as self-contained" rule instead of substituting a
repo-derived diff or claiming no changes, and did it handle the no-changes
repo gracefully instead of fabricating a review? Also gated behind
`PI_LIVE_EVAL=1`:

```bash
cd <this-skill-dir>
PI_LIVE_EVAL=1 python3 evals/judge.py
```

### Layer 2b — omitted

`pi-simple-agents/skills/invoking-subagents/evals/run_layer2b_pipeline.py`
loads a real `subagent` tool via an explicit pi extension to exercise
delegation. `code-review-checklist` can be handed to an `analyst` subagent as
a lens, but that is not its primary invocation path, and bare `pi -ne` does
not expose a `subagent` tool (confirmed empirically in this repo's
`invoking-subagents` eval suite). If
analyst-delegated reviews ever become a primary path, an L2b-style harness
pointed at a subagent extension would be the next addition.

## Prompt language

Prompts are predominantly Spanish (the skill owner works in Spanish); one
prompt is English verbatim (`english_trigger_phrase`) to lock in the
description's English trigger phrases ("Am I ready to merge?", "Run the code
review checklist"). The checks grade the *response* against SKILL.md's
English output contract (`## Review:`, `Verdict:`, `Coverage Gaps`,
`Suggested Tests`) regardless of input language — that is intentional: the
lens's output format is the contract.

## Commands

| Command | What it does |
|---|---|
| `python3 evals/run_layer2_probes.py --validate` | Offline validation: fixtures, planted tokens, diff sets, registry coverage, smoke checks. No tokens, no gate |
| `PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py` | Live Layer 2, all 10 prompts |
| `PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py --only <id1,id2>` | Live Layer 2, subset (comma- or space-separated) |
| `PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py --save-out <DIR>` | Live Layer 2, saving per-probe JSON results to DIR |
| `PI_LIVE_EVAL=1 python3 evals/judge.py` | Live Layer 3: 2 LLM-judge specs |

## Known limitations

- N=1 per prompt (single trial), not the 3-5 trials both source articles
  recommend for non-deterministic agent output. The harness is built to
  widen to N>1 — `run_case(case_id)` creates a fresh tempdir per call, so
  repeated trials are isolated by construction.
- `no_praise` is best-effort: it blocks a fixed phrase list, not all
  conceivable praise. The list lives in one place in
  `run_layer2_probes.py`; additions are cheap.
- Most checks grade `final_text` against SKILL.md's English output format;
  a future format change means updating the checks and re-capturing
  transcripts. The fixture/diff checks in `--validate` are format-
  independent and will catch drift in the fixtures themselves.
- Live results depend on the model behind `pi`; treat probe pass/fail as a
  snapshot, not a permanent guarantee.

## Results

First live run, N=1 per prompt (all layers, `PI_LIVE_EVAL=1`):

**Layer 2 — 10/10 probes passed, 94/94 checks.**

| Probe | Result | n_tool_calls |
|---|---|---|
| `dirty_diff_unstaged` | PASS (19/19) | 16 |
| `clean_diff_all_pass` | PASS (8/8) | 7 |
| `staged_diff_only` | PASS (11/11) | 7 |
| `feature_branch_diff` | PASS (11/11) | 5 |
| `single_blocker_needs_work` | PASS (10/10) | 4 |
| `no_diff_graceful` | PASS (3/3) | 5 |
| `diff_handed_in_prompt` | PASS (10/10) | 1 |
| `negative_control` | PASS (1/1) | 0 |
| `english_trigger_phrase` | PASS (10/10) | 4 |
| `nit_only_ready` | PASS (11/11) | 8 |

Every planted defect was found with a `file:line` reference and the
correct severity tier. The single-Blocker probes returned `NEEDS WORK`; the
clean diff and the nit-only diff returned `READY`; no probe mutated the
seeded repo; the negative control produced no review and no git commands;
the staged-only probe used `git diff --cached` and the branch probe
`git diff main...HEAD`. `--validate` passes offline on the same tree.

**Layer 3 — 2/2 judge specs passed** (`diff_handed_in_prompt` score 90,
`no_diff_graceful` score 93): the handed-in diff was reviewed exactly as
given — no substituted repo-derived diff, no requests for missing context —
and the no-changes repo was handled gracefully without fabricating a
review or a verdict.

**Development findings (harness fixes during iteration, not skill
defects):**

1. Fixture B ("clean diff") v1 was not actually clean: it introduced a
   magic string (`status === "pending"` on an untyped `status`) and left a
   branch untested, so a compliant reviewer returned two Majors. Redesigned
   as a tests-only diff — nothing left to criticize.
2. Fixture NIT ("nit-only") v1 exported a new function with no call sites,
   which is a legitimate YAGNI Major under the skill's Abstractions
   section. Redesigned so the defects are a snake_case local and a
   redundant comment inside a mechanical refactor of existing code — no
   new public API.
3. `no_code_mutation` had a false positive: `git stash list` (read-only)
   matched the `stash` verb. The matcher now excludes read-only
   invocations (`stash` alone / `list` / `show`, `-h` / `--help`,
   `commit-tree`).
4. `found_planted_secret` required the literal secret value in the
   response; a reviewer that redacts the token (`dev-token-...`) — good security
   practice — failed the check. Planted secrets now accept a list of
   alternatives (value, variable name, or distinctive prefix).

No skill defects surfaced: every planted Major/Blocker that was reported
was reported correctly per SKILL.md. Two behaviors of note: the reviewer
flagged that the planted gateway key is a clearly fake dev value
(and still tagged it Blocker, per the skill's "Secrets, credentials, or
tokens in tracked files" rule), and it answered the handed-in-diff probe
without reading the repo's committed files for a different diff.
