---
name: pablo-tdd
description: >-
  Writes and plans unit tests test-first (TDD, red-green loop): seams, test anti-patterns, mocking at boundaries. Use for "TDD", "write tests", "add tests" or "test plan for this change". [DO NOT] use for reviewing existing tests or "what tests are missing" (use pablo-test-review), or for a bare snippet with no repo or change context.
---

<!-- Attribution: adapted from mattpocock/skills -->

# Test-Driven Development

TDD is the red → green loop. Apply it so tests are worth keeping: know what a good test is, where tests go, the anti-patterns, how Pablo's principles apply to tests, and the rules of the loop. Every section applies on every cycle; consult them before and during the loop, not after.

**Scope:** unit and component tests that run in-process, with system boundaries mocked or faked (see [references/mocking.md](references/mocking.md)). Integration and end-to-end tests follow the repo's existing conventions.

**Tests are part of the deliverable.** Every change to existing code and every new piece of code ships with a unit-test plan, one line per test in the format of [references/tests.md](references/tests.md) (Plan the tests). When the request is the change, carry the plan out through the loop; when the request is only the plan, deliver it and write no tests.

**Exception: bare snippet request.** A bare snippet request with no repo/change context → Surgical Changes wins, no test plan: deliver only the snippet, and add a test plan only when the user asks for one.

## What a good test is

A good test verifies behavior through public interfaces, not implementation details, so it reads like a specification and survives refactors.

A good test also encodes WHY the behavior matters, not just WHAT it does. Two checks: its name states the business rule (`divideShortcutBeatsDivisionByZero`, not `testDivide2`), and breaking the logic it covers turns it red. A test that stays green when that logic breaks asserts shape, not intent.

The operational checklist and code examples live in [references/tests.md](references/tests.md); mocking guidelines in [references/mocking.md](references/mocking.md).

## Seams: where tests go

A **seam** is the public boundary where tests observe behavior without reaching inside. Tests live at seams, never against internals.

[ALWAYS] **test only at pre-agreed seams.** Not everything can be tested; agreeing the seams up front puts the testing effort on critical paths and complex logic instead of every edge case outside those seams.

- Before the first test, list the seams under test and confirm the list with the user once. Ask: "What's the public interface, and which seams should we test?" Seams proposed by a plan (per `pablo-code-planning`) stay proposals until the user confirms them.
- [MUST] stop after each seam: report its tests and their run output, and wait for the user's go-ahead before the next seam.
- Without a user to ask (a subagent or a non-interactive run), seams listed in a plan or lens that the caller says the user approved count as confirmed, and the stop after each seam becomes a per-seam section of the final report. With no approved seams, stop and return the proposed seams as the question; for any other question that blocks writing a test (which test framework, a conflicting precedent or ADR), stop and return it the same way. [NEVER] self-confirm seams.
- [DO NOT] write a test at an unconfirmed seam.

## Anti-patterns

- **Implementation-coupled**: tests internal structure, mocks internal collaborators, calls private methods, asserts call counts or call order, or names the test for HOW instead of WHAT. The tell: the test breaks on refactor while behavior is unchanged. Exception: when the behavior is an effect on an external system (an email sent, a card charged), verifying that call and its arguments on the boundary mock is the assertion; [NEVER] verify calls on internal collaborators.
- **Tautological**: the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`), so it passes by construction and can never disagree with the code. Expected values [MUST] come from an independent source of truth: a known-good literal, a worked example, the spec.
- **Horizontal slicing**: all tests written first, then all implementation. Bulk tests verify imagined behavior: they test the shape of things rather than user-facing behavior, go insensitive to real changes, and commit to test structure before the implementation is understood. [ALWAYS] work in **vertical slices**: one test → one implementation → repeat, each test a tracer bullet that responds to what the last cycle taught.
- **Bypassing the interface**: verifies through a side channel, such as querying the database directly, instead of using the public interface the caller would use. The offense is in verification, not setup: mocking the repository or DAO that fronts the database, or seeding a test database, is legitimate (see [references/mocking.md](references/mocking.md)); the test must still assert through the public interface.

## Pablo's principles, applied to tests

How the `pablo-code-philosophy` principles apply to test writing. The theory lives in that skill; only the application is stated here.

- **KISS**: write the simplest test that covers the case; one test per behavior; no abstraction hierarchies inside tests. (theory: KISS in `pablo-code-philosophy`)
- **DRY**: extract test setup at its third copy (Three Strikes, applied to tests) into a helper or a parameterized test; KISS wins when the helper obscures the test. (theory: DRY in `pablo-code-philosophy`)
- **YAGNI**: do not test speculation; every test answers for a behavior that exists today. (theory: YAGNI in `pablo-code-philosophy`)
- **FP**: prefer pure functions: they test without state mocks, typed errors assert failure modes, immutability reduces setup. (theory: FP in `pablo-code-philosophy`)
- **GoF**: fixture builders and factories only when the tests justify them, never for decoration. (theory: GoF in `pablo-code-philosophy`)
- **UNX**: fail loud: the test fails with actionable information, what was expected, what was found, where. (theory: UNX in `pablo-code-philosophy`)

## Rules of the loop

One cycle is one test, then the minimal code that passes it. Repeat cycles inside a seam until its boundaries and branches are covered (see [references/tests.md](references/tests.md)); then move to the next seam, after the stop described in Seams.

- **Red, verified.** Run the new test before touching production code. It [MUST] fail or error because of the behavior under test, such as a failed assertion or an exception the code under test raises; quote the failure. A compile error, a missing symbol or a setup exception is not red yet: add the smallest stub that lets the test run, then run it again. A new test that passes on its first run stays only if breaking the logic it covers turns it red: break that logic and quote the red run, then restore the code and quote the green run. When no break turns it red, the test pins nothing: stop and report it. Characterization tests, which pin behavior the code already has before a refactor, are the exception: they pass on their first run.
- **Green, verified.** Write only enough code to pass the test; [DO NOT] anticipate future tests or add speculative features. Run the test and the affected suite, and quote the result.
- **No run, no claim.** When the tests cannot run, say so and mark the cycle unverified; [NEVER] report red or green without a run.
- **Changed behavior.** First edit the existing test so it asserts the new behavior, and see it fail. [NEVER] delete a test or loosen an assertion to reach green. When the request removes a behavior, delete only the tests of that behavior and list them in the report. When a test outside the planned change fails, stop and report it with its output; [DO NOT] edit it.
- **Done** when every confirmed seam has its boundaries and branches covered and the affected suite is green, with the run quoted.
- **Refactoring is not part of the loop.** With the suite green, find candidates with `refactor-identification` and plan them with `pablo-code-simplify`.

## Context and decisions

When exploring the codebase, read `CONTEXT.md` at the repo root (if it exists) so test names and interface vocabulary match the project's domain language. Respect the ADRs that cover the area being touched (usually under `docs/adr/`); when a test would contradict one, stop and name the conflict.
