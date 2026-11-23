# Evals for `pablo-clueless-user`

Method: `evaluating-agent-skills`, adapted from `../qa-adversary/evals/`. Sources: Philipp Schmid,
"Practical Guide to Evaluating and Testing Agent Skills", https://www.philschmid.de/testing-skills;
Anthropic, "Demystifying evals for AI agents",
https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents.

Status: designed, not built. `prompt_set.json`, `fixtures.py`, `run_layer2_probes.py` and
`judge.py` do not exist yet; build them from the Build notes.

## Classification

Preference/process lens, invoked by name while standalone. Every case is `should_trigger: true`;
no negative-trigger controls. If the skill is later meant to auto-trigger, add trigger probes
against qa-adversary prompts ("QA this" and "find bugs" must not load it).

- L1 skipped: no `scripts/`.
- L2 trajectory probes: the default layer.
- L3 LLM-as-judge: lane, reachability and scenario soundness, which regex cannot grade.
- L2b skipped: the skill delegates nothing. Revisit if it becomes a lens of pablo-code-review or
  pablo-pr-review.

## Success criteria

Outcome
- O1 report_structure: `## Clueless User`, `**Entry points:**`, `### Findings`, `### Open Questions`, `### Verdict`, headers in English.
- O2 verdict_valid: PASS, BLOCK or NEEDS CLARIFICATION; any `[BLOCK]` or `[HIGH]` forces BLOCK.
- O3 guardrails: no edit or write tool call; no test command; no execution of the code under review.
- O4 planted misuse found (cases 2, 3, 4, 5): inside a finding block, anchored to a changed line, with `Scenario:` and `Behavior:` lines.
- O5 overlap skip (case 1): no Findings.
- O6 evidence rule (case 2): the in-repo misuse is a Finding; the misuse behind an unreadable library is an Open Question naming the lookup, never a Finding.
- O7 at most 3 Open Questions.
- O8 language (case 4): Spanish prompt, Spanish content, English headers.

Style and instructions
- S1 lane discipline (L3): no Finding that qa-adversary owns unless it states a caller-side cause and a different fix; no style comments.
- S2 reachability (L3): no scenario needs a value the compiler, binding or validation rejects.
- S3 scenario shape (L3): caller, honest cause, input, entry point, outcome.

Efficiency
- E1 every probe ends within 300 s; a stall is a FAIL.
- E2 tool calls and elapsed time printed per probe; about 25 calls is a review signal, not a hard check.
- E3 judge calls bounded at 120 s.

## Cases

`<repo>` is replaced at runtime with the seeded temp repo. Common checks:
`no_source_or_test_mutation`, `no_test_execution`, `no_program_execution`, `report_structure`,
`verdict_valid`, `open_questions_at_most_3`, `findings_have_file_line`, `findings_have_scenario`,
`findings_have_behavior`.

### 1. overlap_skip_negative_size (Scala, inline diff, overlap rule)
- Fixture: `src/main/scala/storage/StorageEstimate.scala` adds `def computeSize(chunks: Int): Long = chunks.toLong * ChunkBytes` with no guard. `src/main/scala/storage/StorageAdminRoutes.scala` adds `GET /admin/storage/estimate` with `parameter("chunks".as[Int])` calling it, and `GET /admin/storage/usage` with a String `since` passed to `LocalDate.parse` with no try. Both routes are read-only.
- Traps: `chunks=-5` returns a negative size (lens 2 boundary); `since=red` returns 500 (lens 2 malformed, the color-in-a-date-field case); `chunks=abc` fails the typed binding; a LocalDate passed to `computeSize` cannot compile.
- Prompt: "Apply the pablo-clueless-user skill to this change. Produce the report in the skill's output format.\n\nThe change (inline diff):\n<diff>\n\nNo ticket exists. The repo at <repo> contains the current code; use it for line numbers and callers."
- Expected: no Findings; verdict PASS or NEEDS CLARIFICATION.
- Checks: common + `no_findings` + `clean_control_only`.
- Judges: lane-discipline, reachability-honesty.

### 2. evidence_rule_finding_vs_question (Java, inline diff, evidence rule)
- Fixture: `PartnerAdminController.java` adds `POST /admin/partners/disable` with `@RequestParam String name` and the Javadoc "Disables the partner with the given name.", calling `PartnerService.disableByName`. That method loads `repository.findByNameContainingIgnoreCase(name)` and disables every match. The same diff adds `POST /admin/partners/{partnerId}/resync`, calling `com.acme.gateway.PartnerGatewayClient.resync(partnerId)` from a library whose source is absent; `pom.xml` lists `partner-gateway-client`.
- Prompt: "Apply the pablo-clueless-user skill to this change. Produce the report in the skill's output format.\n\nThe change (inline diff):\n<diff>\n\nNo ticket exists. PartnerGatewayClient comes from the partner-gateway-client library; its source is not available here. The repo at <repo> contains the current code; use it for line numbers and callers."
- Expected: a BLOCK or HIGH Finding on the `findByNameContainingIgnoreCase` line: an operator sends name=acme meaning one partner, and every partner whose name contains it is disabled; Behavior assumed-knowledge. An Open Question on resync: a partner name or another entity's id sent as partnerId, with PartnerGatewayClient.resync as the lookup. Verdict BLOCK.
- ctx: `file` = `PartnerService`; `tokens` = containing, partial, substring, several, multiple, more than one; `oq_tokens` = resync, partnergatewayclient; `skip_tokens` = resync.
- Checks: common + `found_planted_misuse` + `open_question_mentions_token` + `no_finding_mentions_token`.
- Judges: misuse-correctness, evidence-rule, lane-discipline.

### 3. abandoned_flow_upload_lock (TS, git repo, unstaged diff)
- Fixture: the committed baseline has a one-step `POST /media/:id/upload` in `src/uploads.ts`, `PUT /media/:id` in `src/media.ts` returning 409 while `status === "LOCKED"`, and `web/UploadButton.tsx` calling the one-step route. The working tree changes `src/uploads.ts` to two steps (start sets `status: "LOCKED"` and opens a session; complete sets `READY`; no expiry, no cancel) and changes `web/UploadButton.tsx` to call them. Both are tracked files, so `git diff` shows the change.
- Prompt: "Apply the pablo-clueless-user skill and review the current change in the repo at <repo>. Produce the report in the skill's output format.\n\nThe change is the unstaged diff in this git repo; run git diff to see it (the repo has no remote and no parent branch; do not wait for one)."
- Expected: a HIGH or BLOCK Finding on the LOCKED line in `src/uploads.ts`: an end user starts an upload and closes the tab, the media stays LOCKED, and every edit returns 409 until a manual fix. Behavior workflow; verdict BLOCK.
- ctx: `file` = `uploads.ts`; `tokens` = locked, abandon, closes, never complete, stuck.
- Checks: common + `found_planted_misuse`.
- Judges: misuse-correctness, lane-discipline.

### 4. misleading_default_dry_run_es (Scala, inline diff, Spanish prompt)
- Fixture: `ReportAdminRoutes.scala` keeps an unchanged `POST /admin/reports/recompute` with `"dryRun".as[Boolean].withDefault(true)` and adds `POST /admin/reports/purge` with `parameters("region", "dryRun".as[Boolean].withDefault(false))`. With `dryRun = false` it calls `ReportService.purge(region)`, which deletes every report of the region.
- Prompt: "Aplica el skill pablo-clueless-user a este cambio y genera el reporte en el formato del skill.\n\nEl cambio (diff inline):\n<diff>\n\nNo hay ticket. El repo en <repo> tiene el código actual; úsalo para números de línea y llamadores."
- Expected: a BLOCK Finding on the `withDefault(false)` line: an operator used to recompute previewing by default calls purge without dryRun and deletes every report of the region. Behavior misleading-default; content in Spanish, headers in English; verdict BLOCK.
- ctx: `file` = `ReportAdminRoutes`; `tokens` = withdefault(false), dryrun, por defecto, default.
- Checks: common + `found_planted_misuse` + `report_in_spanish`.
- Judges: misuse-correctness, lane-discipline.

### 5. after_error_failed_step_done (Java, inline diff)
- Fixture: `MigrationAdminController.java` adds `POST /admin/migrations/{id}/validate`, which stores `ValidationStatus.FAILED` or `PASSED` and returns 200 `{"status": "done", "errors": [...]}`, and `POST /admin/migrations/{id}/apply`, which calls `MigrationService.apply(id)`. `apply` writes every mapping without checking the validation status.
- Prompt: "Apply the pablo-clueless-user skill to this change. Produce the report in the skill's output format.\n\nThe change (inline diff):\n<diff>\n\nNo ticket exists. The repo at <repo> contains the current code; use it for line numbers and callers."
- Expected: a HIGH or BLOCK Finding on the `apply` line with no status check: an operator reads "done" as passed and applies a migration that failed validation, writing broken mappings. Behavior after-error or workflow; verdict BLOCK. A second LOW Finding on the "done" wording is allowed.
- ctx: `file` = `MigrationService`; `tokens` = failed, validation, done, passed.
- Checks: common + `found_planted_misuse`.
- Judges: misuse-correctness, lane-discipline.

## Check registry

| check id | Semantics |
|---|---|
| no_source_or_test_mutation | reused from qa-adversary: no edit, write or notepad tool call |
| no_test_execution | reused from qa-adversary: segment-start test-runner match |
| no_program_execution | new: no bash segment starting with node, ts-node, tsx, deno, bun, java, javac, jshell, scala, scalac, scala-cli, sbt, amm, mvn, mvnw, gradle, gradlew, curl or wget, with `npx ts-node`, `npx tsx`, or `python`/`python3` followed by a `.py` path; same normalization as no_test_execution |
| report_structure | adapted: clueless user, findings, open questions and verdict as a line-start heading or standalone bold label; `**Entry points:**` as a bold label followed by text |
| verdict_valid | reused from qa-adversary |
| open_questions_at_most_3 | new: at most 3 bullet lines between the Open Questions header and the next header |
| findings_have_file_line | reused from qa-adversary |
| findings_have_scenario | adapted: every finding block has a line starting with `Scenario:` |
| findings_have_behavior | new: every finding block has `Behavior:` followed by workflow, after-error, wrong-entity, assumed-knowledge or misleading-default |
| found_planted_misuse | adapted from found_planted_bug: ctx `file` and one ctx `tokens` entry appear inside one finding block; a match in Open Questions alone does not count |
| no_findings | reused from qa-adversary |
| clean_control_only | reused from qa-adversary |
| open_question_mentions_token | reused, reading ctx `oq_tokens` |
| no_finding_mentions_token | new: no finding block contains any ctx `skip_tokens` entry |
| report_in_spanish | new: at least 8 hits of " que ", " el ", " la ", " los ", " para ", " con ", " una ", " del " outside header lines |

## Judge families (L3)

| Family | Cases | The judge must confirm |
|---|---|---|
| misuse-correctness | 2, 3, 4, 5 | the planted misuse is named on a changed line with caller, honest cause, input, entry point and outcome; not a keyword mention or an adjacent finding |
| lane-discipline | 1 to 5 | no Finding that qa-adversary owns (null, empty, zero, negative, boundary, malformed, attack, concurrency, machine retry, dependency failure, changed contract, written rule) unless it states a caller-side cause and a different fix; no style comments |
| reachability-honesty | 1 | no scenario relies on a value the compiler, binding or validation rejects; no manufactured Findings |
| evidence-rule | 2 | the disable-by-name misuse is a Finding, not demoted; the resync misuse is an Open Question naming the PartnerGatewayClient lookup, not a Finding |

## Build notes

- Copy `../qa-adversary/evals/run_layer2_probes.py`, `judge.py` and `fixtures.py`. Keep
  `parse_trials`, `run_pi`, the NDJSON parse, the `PI_LIVE_EVAL=1` gate, `--check` and `--trials`.
- `fixtures.py`: one pure seeder per case, with planted lines at the line numbers the inline diffs
  reference. Case 3 commits the baseline and leaves two modified files (`git status --porcelain`
  shows `M src/uploads.ts` and `M web/UploadButton.tsx`).
- `--check` asserts that every seeder writes its planted line, every `expected_checks` id is
  registered, and every token check has a non-empty ctx list.
- Judges run `pi` without `--skill`.

## Runbook

```bash
cd <skills-dir>/pablo-clueless-user
python3 -m py_compile evals/run_layer2_probes.py evals/judge.py evals/fixtures.py
python3 evals/run_layer2_probes.py --check
python3 evals/judge.py --check
PI_LIVE_EVAL=1 python3 evals/run_layer2_probes.py --trials 5
PI_LIVE_EVAL=1 python3 evals/judge.py --trials 3
```

On a FAIL, suspect the harness first (brittle regex, fixture state, prompt ambiguity): fix it,
confirm with the judge, and re-run once before touching SKILL.md. Record every failure under
Results; never re-run to force a pass.

## Known limitations

- N=1 by default; canonical runs use 5 trials for L2 and 3 for L3.
- Token checks are coarse; soundness is the judge's job.
- `report_in_spanish` is a word-count heuristic.
- Case 5 accepts workflow or after-error as the Behavior; both name the same root cause.
- Case 3 is TypeScript although the primary services have no JS/TS app code; it covers the TS reachability rules.
- Fixtures are text that is never compiled; the skill never runs code, so it does not need to.

## Results

None yet.
