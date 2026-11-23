# pablo-tdd evals

## Offline guardrail

`check_load_bearing_rules.py` makes no model calls and uses only the standard library. It runs string checks on `SKILL.md`, `references/` and the mocking examples to confirm the load-bearing rules are still there:

- Frontmatter: the name matches the directory; the description has the trigger phrases, `[DO NOT]`, the `pablo-test-review` pointer and the bare-snippet case.
- `SKILL.md` stays under 500 lines.
- Red and green: the new test runs before production code; red is a failure or error caused by the behavior under test, and a compile error is not red; green runs the affected suite; both runs are quoted; no claim without a run.
- First-run passes: a new test that passes on its first run stays only if breaking its logic turns it red and the code is restored; characterization tests stay exempt, as `pablo-code-simplify` expects.
- Loop: cycles repeat inside a seam, a done criterion, no deleted tests or loosened assertions, and a failing test outside the change is reported, not edited.
- Seams: one confirmation of the list, the stop after each seam, the fallback without a user.
- Refactoring points to `refactor-identification` and `pablo-code-simplify`, not to `code-review-checklist`.
- The bare-snippet sentence that `pablo-code-philosophy/evals/README.md` quotes.
- Mocking: the external-effect exception, the repository or DAO as the database boundary, `CartValidator` and no `CartRepository` in both mocking examples.
- Every `references/` and `examples/` path the skill mentions exists.

When a rule's wording changes on purpose, update its check in the same change.

Run:

    cd <skills-dir>/pablo-tdd && python3 -B evals/check_load_bearing_rules.py

Prints one PASS/FAIL line per check and `N/N passed`. Exit code is 1 if any check fails.

## Layer 2 probes (D15)

`run_layer2_probes.py` sends each case of `prompt_set.json` through `pi -ne --skill <this skill> --mode json -p <prompt>`, one temp directory per trial, and grades the final reply, the tool calls and the files left behind. It closes D15: the three test-planning probes that `pablo-code-philosophy` moved here after the split (`trigger_write_new_service`, `trigger_suggest_tests`, `trigger_implement_scala_function`), plus `edge_changed_behavior_red_first` for the verified red → green loop.

- `--skill` forces the load; there are no trigger probes and no negative controls.
- Fixtures are Python with `unittest`, so no probe needs Maven, sbt or npm.
- `tests_planned` needs a plan line in the reply: at least four `|` and the word `boundary` or `branch`. `asks_seam_confirmation` needs `seam` and `?` in the same sentence. `no_test_files_written` flags test file names (`test_*.py`, `*_test.*`, `*Test.java`, `*Spec.scala`, `*.spec.ts`, `*.test.ts`) and test directories (`test/`, `tests/`, `__tests__/`, `spec/`), not every path that contains "test".
- One trial per case and run; repeat the run 3 to 5 times before trusting a result.
- `trigger_implement_scala_function` only checks that no test file is written; a test plan that appears only in the reply text is not detected.

Run (costs real LLM tokens):

    cd <skills-dir>/pablo-tdd && PI_LIVE_EVAL=1 python3 -B evals/run_layer2_probes.py

Without `PI_LIVE_EVAL=1` it prints a skip message and exits 0.
