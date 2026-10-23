# Evals for `pablo-test-review`

Method adapted from Philipp Schmid's ["Practical Guide to Evaluating and Testing Agent Skills"](https://www.philschmid.de/testing-skills) and Anthropic's ["Demystifying evals for AI agents"](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), as applied by the `evaluating-agent-skills` skill. The structure follows `qa-adversary/evals/`.

`pablo-test-review` is a **preference/process lens**: read-only, invoked by name or handed to an analysis agent as its lens. The harness loads it with `--skill <dir>`, so `should_trigger` cannot regress. Every probe is `should_trigger: true`; negative-trigger controls are omitted by design. What the suite grades is process fidelity: a read-only run, a report in the output contract, one anchored item per root cause that names the exact assertion, caps respected, and silence where the gates require it.

## Success criteria

**Outcome**
- **O1 report_structure.** Title heading, then both sections (an empty section keeps its heading and prints exactly `none.` under it), or the global `No test observations.` line when both are empty.
- **O2 guardrails.** Zero `edit`/`write` calls and zero test-execution commands, verified from the tool-call log.
- **O3 positives.** P1-P8 report the planted item with the expected token (`found_p1` ... `found_p8`).
- **O4 negatives.** N1-N8 produce no item above Nit and no gap (N8: at most 1 gap).

**Style and instructions**
- **S1 contract.** Tier vocabulary is `M | Question | I | Nit`; never `B`. Every item has `file:line`; every comment has a backticked `Change:` token; every gap has a backticked `Test:` token (gate G-A).
- **S2 caps.** At most 3 visible items in total (comments + gaps), of which at most 1 gap and 1 Nit.
- **S3 question form.** Question-tier items contain a question mark.
- **S4 waits.** An integration-test polling change is a Question, never M (P6); unit-test waits stay silent (N3, N5).

**Efficiency**
- **E1** each probe completes within 300 s (a stall is a FAIL).
- **E2** tool-call count and elapsed time are printed per probe; about 25 calls or fewer is the norm (a review signal, not a check).
- **E3** judge calls are bounded at 120 s.

## Layers

- **L1 skipped.** The skill ships no scripts.
- **L2 `run_layer2_probes.py`.** Seeds a fresh temp repo per trial from `fixtures.py`, runs `pi -ne --skill <this skill> --mode json -p <prompt>`, parses the NDJSON transcript, and runs the deterministic checks.
- **L3 `judge.py`.** Re-runs six probes and sends each transcript to a second `pi` call, without `--skill`. Verdict JSON: `{"passed", "score", "notes"}`.
- **L2b skipped.** Delegation to an analysis agent is the caller's choice and is not exercised here.

Offline validation (no model, no tokens):

```bash
cd <this-skill-dir>
python3 -m py_compile evals/*.py
python3 evals/run_layer2_probes.py --check   # registry, fixtures, diff/file consistency, check self-tests
python3 evals/judge.py --check               # judge specs reference known probes
```

Live runs, gated behind `PI_LIVE_EVAL=1`:

```bash
PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py --trials 1   # all 16 probes
PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py --trials 3   # widen on any probe that fails or flips
PI_LIVE_EVAL=1 python3 evals/judge.py --trials 3
```

## Prompt set

Sixteen probes (`prompt_set.json`) on synthetic Java fixtures (N3 is Scala). `<repo>` is replaced at runtime with the seeded temp repo. The inline diff in each prompt is generated from `fixtures.py`; `--check` verifies that each hunk matches the seeded files.

| id | Shape | Rubric | Expectation |
|---|---|---|---|
| P1 | assertion deleted from a mapper test | R1 | M or I naming `assertEquals(Status.ARCHIVED, dto.status())` |
| P2 | new test omits the sibling helper | R3 | I naming `assertSourceUntouched` |
| P3 | exact parser message asserted | R4 | I with an `assertThrows` + `contains(...)` drop-in |
| P4 | new dry-run branch, no test | R5 | G with a test name, picked first by the ordered Gap ranking keys (key 1: zero tests) |
| P5 | test named for a timestamp asserts only status | R2 | item naming `getDereferencedAt` |
| P6 | integration test: new poll interval and cap | R6 | Question, never M |
| P7 | integration repo, many candidate gaps | R5 | at most 1 G, the archive/restore round trip |
| P8 | only test of a new function asserts nothing | R2 | item naming the `"hello-world"` assertion |
| N1 | `assertNotNull` smoke test, behavior covered elsewhere | G-C | silent |
| N2 | reflection plus real-method mock | G-C | silent |
| N3 | `eventually` in a Scala unit spec | G-C | silent |
| N4 | `assertThrows(Exception.class)` copying the file's pattern | G-D | silent |
| N5 | `after(2000).never()` in a unit test | G-C | silent |
| N6 | clean tests-only diff | none | `No test observations.` |
| N7 | production style issue, tests fine | lane | silent |
| N8 | seven untested production paths | G-G | at most 1 G |

## Check registry

| check id | Semantics |
|---|---|
| `no_source_or_test_mutation` | No `edit`/`write`/`notepad` tool call |
| `no_test_execution` | No bash segment starts a test runner; no `run_tests`/`test_runner` tool call |
| `report_structure` | Title plus both headings; a section with no items has exactly `none.` under it; or `No test observations.` |
| `tier_vocab_valid` | Comment tiers are `M`, `Question`, `I`, `Nit` (or a blocking tier, caught by `no_b_tier`) |
| `no_b_tier` | No `[B]`, `[Blocking]` or `[Blocker]` item |
| `items_have_file_line` | Every item head has a `path:line` anchor |
| `items_have_change_token` | Comments carry a backticked `Change:` line; gaps a backticked `Test:` line |
| `gap_cap_le_1` / `visible_cap_le_3` / `nit_cap_le_1` | Gate G-G caps |
| `question_form` | Question-tier heads contain `?` |
| `found_p1` ... `found_p8` | Item text names the fixture file and one expected token |
| `absent_n1` ... `absent_n5` | No item mentions a forbidden token |
| `no_non_nit_items` | No comment above Nit and no gap |
| `silent_result` | `No test observations.` and zero items |
| `question_tier_only` | At least one Question on the fixture file; no M anywhere |
| `has_gap` | At least one gap |
| `gap_ranked_first` | The one gap, picked by the ordered Gap ranking keys, names an expected token |

## Layer 3 specs

| probe | family | Judged |
|---|---|---|
| P1, P2, P5 | post-ready | Would a careful maintainer post the line as written? Targets the planted defect, one or two sentences, changed line, exact assertion as code |
| P7 | gap-ranking | At most 1 gap picked by the ordered keys, the round trip, concrete test names, no padding |
| N6, N7 | honest-silence | No padding, no production commentary |

## Pass bar

- Positives found in at least 90% of N=3 trials.
- Each negative has no non-Nit item in at least 2 of 3 trials.
- Structural checks pass 100%.
- Each probe finishes under 300 s.

## Limitations

- N=1 is a development default; widen to N=3 on any failing or flipping probe.
- Token matching (`found_*`) confirms the right item exists, not that its wording is good; that is the L3 post-ready judge.
- The fixtures are synthetic. Replaying real pull requests is a manual step outside this suite.
