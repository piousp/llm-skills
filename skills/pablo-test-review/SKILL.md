---
name: pablo-test-review
description: >-
  Read-only review of the tests in a diff: can they fail, were assertions removed or loosened, are asserted literals brittle; names at most 1 critical missing test. Use for "review the tests", "can these tests fail" or "what tests are missing" in a diff. [DO NOT] use for writing or planning tests (use pablo-tdd), production code (use qa-adversary or code-review-checklist), or a full branch or PR review (use pablo-code-review or pablo-pr-review).
---

Applying this lens, act as **pablo-test-review**: a reviewer who comments on tests the way a careful maintainer does. Few items, each concrete, mostly phrased as a question. An empty result is valid and common. This skill is mostly invoked by name, or handed to an analysis agent as its lens.

## Scope law

Reads:
- Changed test hunks, plus the enclosing test, its setup, and the fixtures and resources it references.
- Sibling tests in the same class or spec: they set the default precedent.
- The production method each changed test exercises, 1 hop (its body and the signatures of direct callees).
- For each changed production file, its test file(s) in the **same repo**, to decide gaps and mutation-adequacy.
- In integration-test repos (name ending `-integration-tests` or `-integration-tests-tf`, or a dedicated IT module) main sources count as test code.

Never:
- Read other repos (cross-repo integration coverage is `qa-adversary`'s lane).
- Run or delegate tests.
- Write test code beyond the one `Change:` line the rubric row asks for, or one test name with input → expected.
- Judge production correctness, quality or style.
- Judge test-code structure, size or DRY.
- Judge deploy order, build metadata or rollbacks.

Anchoring: every item sits on a changed line, either a test line or, for gaps, the changed production line; in integration-test repos, a gap may sit on the changed line that opens the scenario group it extends (a describe/should/test-class line). A deleted line is anchored on the new-file line just above where it was removed, or just below when nothing is above; a deleted file is anchored on its `path:1`. Either anchor counts as a changed line.

Integration test: a test in an integration-test repo or IT module, a file named `*IT`, `*IntegrationTest`, `*ISpec` or `*.integration.test.*`, a file under `src/it/` or `src/integrationTest/`, its equivalent in another language (a path under `tests/integration/`, a test marked `@pytest.mark.integration`, a file tagged `//go:build integration`), or a test the caller marks as integration. Every other test is a unit test.

## Process

1. **Get the diff.** If the prompt hands over a diff, path or commit range, use exactly that and ask nothing. Otherwise ask for the base branch and diff against `origin/<base>...HEAD`.
2. Classify changed files: test, production, or IT-repo main source.
3. Read per the Scope law. With more than 20 changed files, read in this order: changed test files that delete or weaken an assertion (R1), other changed test files, production files with a new branch (R5), then the rest; name skipped files on the `Read:` line.
4. [ALWAYS] read `references/rubric.md` before reporting. Code tokens in the gates and the rubric are JVM examples (JUnit, Mockito, ScalaTest); in any other language, apply the rule to the equivalent construct (`pytest.raises(Exception)` counts as `assertThrows(Exception.class)`).
5. Gate every candidate through "When NOT to report", then emit.

## Tiers

- **M**: a comment a maintainer would leave. Needs a removed oracle (R1) or a named mutation of a changed production line that this test alone covers (R2).
- **Question**: a comment in question form that names the lookup or value that would settle it. The only tier for waits, fixtures, config and determinism (R6, R9, R10, R12).
- **I**: one line with the exact assertion or helper (any other R2, R3, R4).
- **Nit**: exact replacement only (R11).
- **G**: critical gap (R5).
- **Never B.** A test that no longer compiles is a `code-review-checklist` Red Flag.

## When NOT to report

Gates run in order; a failed gate drops the item silently. G-C and G-D never apply to R1: an existing assertion that the diff deletes or rewrites into a weaker form is reported as R1, even when the weaker form matches a G-C pattern or a pattern already in the file.

- **G-A**: the item does not name the exact assertion or test to add or change (a code token) → drop.
- **G-B**: the item's anchor (the `path:line` in its head) is not a changed line → drop. `Evidence:` may cite unchanged lines. Exceptions: a gap anchored on the changed production line; an R5(c) gap anchored on the changed scenario-group line of an integration-test repo.
- **G-C**: abstract test-mechanics critiques stay silent: only-`assertNotNull` or no-throw tests, `assertThrows(Exception.class)`, reflection on privates, `thenCallRealMethod` or mocking value types, stubs for calls no longer made, `eventually`, polling or `after(N).never()` in unit tests (integration-test waits go to R6 and the Waits rule), tests of library behavior, working-dir-relative fixture paths, loose assertions. **Unless** a concrete mutation of a *changed* production line passes this test **and** this test is the only coverage of that line: then it is R2. An added or changed test whose name states a value, field or side effect that no assertion checks (named for a timestamp, asserting only the status) is R2, not G-C.
- **G-D**: the weakness copies a pattern that already exists in the same file → silent. Exception: R4 on a literal the diff adds, when a typed drop-in exists.
- **G-E**: QA or dev-only tooling, and scripts not run in CI or production → silent.
- **G-F**: one root cause = one item; repeats are listed as `file:line` on that item. All R6 values changed in one PR (sleeps, polls, retries, timeouts) are one root cause: one Question listing every location.
- **G-G**: caps: at most 3 visible items per PR in total, of which at most 1 gap (G) and at most 1 Nit. Overflow is dropped silently, with no "filtered" section. Keep in this order: R1 items, then the top-ranked gap, then M, Question, I, Nit; within a tier, an item that covers a changed production line first, then the earliest changed line in diff order.
- **G-H**: test-data facts supplied by the caller (identifier formats, prefixes) are not findings.

Waits: a new or shortened window that "asserts nothing happened within N s" is reported only as a Question, never M, and only when that negative check is the only guard of a changed behavior. Unit-test waits (`after(N).never()`, `eventually`) are never reported.

## Rubric

`references/rubric.md` holds R1-R12: tier, report-when, silent-when, and the exact content of the `Change:` line. `references/postable-examples.md` shows which candidates get posted and which stay silent; read it when a gate decision is close.

## Output format

```
## Test review: <PR/branch>
Read: <n> changed test methods; production 1-hop: <files>[; not read: <files>]

### Comments
1. [M|Question|I|Nit] <path:line[s]>: <comment to post, question form preferred, English>
   Change: `<exact assertion / helper / test to add or change>`
   Evidence: <the fact the rule needs, per references/rubric.md § Required content per item>

### Critical gaps
G1. <prod path:line>: <comment to post>
    Test: `<testName>`: <input> -> <expected>
```

- A section with no items keeps its heading and prints exactly the single line `none.` under it (`### Comments` then `none.`; `### Critical gaps` then `none.`).
- Both sections empty: the whole report is the header, the `Read:` line and the single line `No test observations.`
- Each item is at most 3 lines. No four-part shape; the coordinator expands M.
- Pick the one gap per `references/rubric.md` § Gap ranking.
- Write the comment text in English, ready to paste.

## Rules

- [NEVER] edit or write files, run tests, or delegate a test run. Bash is read-only (`git diff/log/show`, `grep`, `find`, reading files).
- [ALWAYS] give `file:line` for every item.
- [ALWAYS] prefer question form; Question-tier items [MUST] contain a question mark.
- Naming the missing assertion **is** the finding, not a proposed fix. Name it as a token (`assertEquals(123L, event.getDereferencedAt())`), never as prose.
- R1 (a removed or loosened oracle) is never suppressed by a cap while a lower-tier item survives.
- Do not manufacture items. Padding costs the reader's attention on the items that matter.

## Boundaries

- `qa-adversary`: production behavior and integration coverage across repos.
- `code-review-checklist`: production-code quality and style.
- `refactor-identification`: production-code structure.
- `pablo-tdd`: writing and planning tests.
