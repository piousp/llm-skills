# Rubric R1-R12

Read before reporting. Each row is one rule. Tier names: M (major), Question, I (minor), Nit, G (critical gap). The lens never emits B.

How to read a row:
- **Report when**: the condition that must hold, visible in the diff or 1 hop away.
- **Silent when**: any one of these drops the item.
- **`Change:` must contain**: the code token the item has to name (gate G-A). Prose alone fails the gate.
- **Calibration**: the shape of past review comments that were posted or left unposted, described generically.

| # | Rule | Report when | Tier | Silent when | `Change:` must contain | Calibration |
|---|---|---|---|---|---|---|
| R1 | Oracle removed or loosened | The diff deletes or weakens an assertion (exact → contains, specific exception → generic, value → not-null, count → non-empty) and no equivalent assertion appears elsewhere in the diff | M | The PR objective declares the behavior removed; an equivalent assertion is added elsewhere; the production method the assertions exercised is deleted from this repo in the same diff (moved to a library or another repo: its tests move with it, and cross-repo coverage is qa-adversary's lane) | The assertion to keep or restore, e.g. `assertEquals(Status.ARCHIVED, dto.status())` | Posted: "Should we also assert the status field?" on a deleted status assertion. Posted as a question: a loosened equality. Left unposted: the same pattern buried in a 22-item report |
| R2 | Claim not checked, or test cannot fail | A test added or changed whose name or description claims a behavior no assertion checks, **or** the G-C exception holds (a named mutation of a changed production line passes, and this test is its only coverage) | M if it is the only coverage of a changed production line and the mutation is named; else I | No production mutation can be named | The exact assertion, e.g. `assertEquals(123L, event.getDereferencedAt())` | Partially posted: a test named for a timestamp that asserts only the status. Left unposted: smoke tests whose behavior another test covers |
| R3 | Assertion the sibling tests make | A new test in a group omits the assertion or helper its siblings use for the same guarantee | I (question form) | The siblings differ in intent | The helper call, e.g. `assertSourceUntouched(source)` | Posted: "Should this also call the helper the other copy tests use?" |
| R4 | Brittle literal | The test asserts exact text or JSON owned by another module or a serializer, and a typed or structural drop-in exists | I | No drop-in exists. A wire format the diff introduces is still R4 when its type has a codec the test can decode into (e.g. `responseAs[T] shouldEqual T(...)`) | The drop-in, e.g. `assertThrows(ParseException.class, ...)` plus `contains("3.0.0")`; or `responseAs[T] shouldEqual T(...)` | Posted twice, each time with a drop-in |
| R5 | Critical gap | (a) A new branch, public method, overload or config-flag value in the diff has no test in the repo; (b) changed behavior whose existing tests assert only the old value, so reverting the line keeps the suite green; (c) in IT repos, the production-likely sequence that differs from every existing scenario | G, max 1; pick by the ordered keys in § Gap ranking | Null, empty or boundary cases unless the change is about that boundary; library behavior; paths only another repo's integration tests could cover; DI/bean or config wiring whose failure surfaces at application startup | `testName`: input → expected | Posted: a missing flag-value test, a missing happy path, a missing round-trip scenario. Low yield overall for long gap lists, hence the cap of 1 |
| R6 | Timing and waits in integration tests | A sleep, poll interval, retry count or timeout is added or changed with no calibration evidence (or a comment claims a TTL without the number); negative-wait windows only under the Waits rule in SKILL.md | Question only, never M | Unit tests; values the diff does not change | The value plus the question, e.g. `POLL_MS = 250`: "Can we get a few runs to confirm these values?" | Posted once as a question; most other wait comments were left unposted |
| R7 | Mocking at system boundaries | Only through R2: the mock replaces the very code the diff changes | via R2 | Everything else | via R2 | Many mocking critiques, none posted |
| R8 | Seams and coupling to internals | Only through R2 | via R2 | Reflection, call-count verification, `toString` assertions | via R2 | Reflection critique, not posted |
| R9 | Config placement | A production config key added in the diff is missing from the test resources (e.g. `src/test/resources/application.yaml`) | Question | General placement critiques | The key and the file | Posted once |
| R10 | Fixture and test-data hygiene | A shared fixture, constant set or validation helper changes meaning for other tests; or a constant set omits a member its production counterpart has | Question; name the other test or constant | Fixture naming; relative paths | The constant or fixture plus the affected test | Posted: a fixture identifier that changes meaning ("just noting"); a constant set missing a member |
| R11 | Naming | A name that contradicts its assertions goes to R2; any other case is a pure rename | Nit, max 1 | Everything else | The new name | Naming remarks were ignored |
| R12 | Determinism | The diff introduces time, random or iteration-order dependence, or removes serial execution, **and** two runs that diverge can be named | Question | Anything else; deploy-order or version dependence: if the two runs diverge only while another service's change is undeployed or older, it is not this lens, however it is phrased | The two runs and the fix point | One case, not posted |

## Tier rules

- M needs R1, or R2 with a named mutation of a changed line. Everything else tops out at I or Question.
- Waits, fixtures, config and determinism are Question only.
- A Question names the lookup or the value that would settle it, inside the comment.
- Overflow past the caps is dropped (gate G-G), never summarized.

## Gap ranking (R5)

Pick the one gap by these keys, in order; the first key that separates the candidates decides. Do not re-rank by intuition about impact.
1. A new public method, overload, branch or config-flag value with zero tests in the repo (R5(a)).
2. The untested outcome of a new branch whose existing tests cover only its other outcome; the success (happy) path first.
3. Changed behavior where reverting the changed line to its old form keeps the suite green (R5(b)). For a step inserted into or moved within a chain, the test pins the new step against the step it now pre-empts (the one right after it).
4. A production-likely sequence in an IT repo that no existing scenario covers (R5(c)).
5. One operand of a changed condition that no test isolates, or a production-doc claim (ordering, memory bound) that no test checks.
6. Edge cases: only when the change is about that edge.
Still tied: the candidate anchored on the earliest changed line in diff order (file order of the diff, then line number).

## Required content per item

- Comment line: the sentence to post, question form preferred.
- `Change:`: backticked code (an assertion, helper call, value or rename).
- `Evidence:`: one of: the mutation of a changed production line that passes today, the sibling test that already does it, the value with no calibration.
- Gap lines carry `Test:` with a backticked test name, input → expected.
