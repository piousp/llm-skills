---
name: pablo-tdd
description: >
  Test-driven development: the red → green loop that produces tests worth
  keeping. Use when writing, planning, or reviewing unit tests and test plans
  for code changes: what a good test is, where tests go (seams), test
  anti-patterns, mocking at system boundaries, and how Pablo's principles
  (KISS, DRY, YAGNI, FP, GoF, UNX) apply to test writing. Trigger when: the
  task involves tests or a test plan for a code change. [ALWAYS] plan unit
  tests for every code change, unless the bare-snippet exception applies
  ("Tests are part of the deliverable" in pablo-code-philosophy). [DO NOT]
  trigger for non-code prose, documentation, general questions, or web research.
---

# Test-Driven Development

> Sourced from [mattpocock/skills](https://github.com/mattpocock/skills/tree/main/skills/engineering/tdd).

TDD is the red → green loop. Apply it so tests are worth keeping: know what a good test is, where tests go, the anti-patterns, how Pablo's principles apply to tests, and the rules of the loop. Every section applies on every cycle; consult them before and during the loop, not after.

**Tests are part of the deliverable.** Every change to existing code and every new piece of code ships with a unit-test plan; see the bullet of the same name in the `pablo-code-philosophy` skill.

**Exception: bare snippet request.** A bare snippet request with no repo/change context → Surgical Changes wins, no test plan. When the user asks for a standalone snippet with no repository and no change context to test against, [DO NOT] invent a test plan; follow the `pablo-code-philosophy` Surgical Changes contract and deliver the snippet.

## What a good test is

A good test verifies behavior through public interfaces, not implementation details, so it reads like a specification and survives refactors.

The operational checklist and code examples live in [tests.md](tests.md); mocking guidelines in [mocking.md](mocking.md).

## Seams: where tests go

A **seam** is the public boundary where tests observe behavior without reaching inside. Tests live at seams, never against internals.

[ALWAYS] **test only at pre-agreed seams.** Before writing any test, write down the seams under test and confirm them with the user. When a plan proposes the seams (per `pablo-code-planning`), confirm those seams with the user before implementing - the plan proposes, the user confirms, tests follow. [DO NOT] write a test at an unconfirmed seam. Ask: "What's the public interface, and which seams should we test?" Not everything can be tested; agreeing the seams up front is how testing effort lands on critical paths and complex logic instead of every edge case.

## Anti-patterns

- **Implementation-coupled**: tests internal structure, mocks internal collaborators, calls private methods, asserts call counts or call order, or names the test for HOW instead of WHAT. The tell: the test breaks on refactor while behavior is unchanged.
- **Tautological**: the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`), so it passes by construction and can never disagree with the code. Expected values [MUST] come from an independent source of truth: a known-good literal, a worked example, the spec.
- **Horizontal slicing**: all tests written first, then all implementation. Bulk tests verify imagined behavior: they test the shape of things rather than user-facing behavior, go insensitive to real changes, and commit to test structure before the implementation is understood. [ALWAYS] work in **vertical slices**: one test → one implementation → repeat, each test a tracer bullet that responds to what the last cycle taught.
- **Bypassing the interface**: verifies through a side channel, such as querying the database directly, instead of using the public interface the caller would use.

## Pablo's principles, applied to tests

How the `pablo-code-philosophy` principles apply to test writing. The theory lives in that skill; only the application is stated here.

- **KISS**: write the simplest test that covers the case; one test per behavior; no abstraction hierarchies inside tests. (theory: KISS in `pablo-code-philosophy`)
- **DRY**: apply the 3-strikes rule to test setup: repeated setup becomes a helper or a parameterized test; KISS wins when the helper obscures the test. (theory: DRY in `pablo-code-philosophy`)
- **YAGNI**: do not test speculation; every test answers for a behavior that exists today. (theory: YAGNI in `pablo-code-philosophy`)
- **FP**: prefer pure functions: they test without state mocks, typed errors assert failure modes, immutability reduces setup. (theory: FP in `pablo-code-philosophy`)
- **GoF**: fixture builders and factories only when the tests justify them, never for decoration. (theory: GoF in `pablo-code-philosophy`)
- **UNX**: fail loud: the test fails with actionable information, what was expected, what was found, where. (theory: UNX in `pablo-code-philosophy`)

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to pass it. [DO NOT] anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Refactoring is not part of the loop.** It belongs to the review stage (see the `code-review-checklist` skill), not the red → green implementation cycle.

## Context and decisions

When exploring the codebase, read `CONTEXT.md` (if it exists) so test names and interface vocabulary match the project's domain language. Respect ADRs in the area being touched.
