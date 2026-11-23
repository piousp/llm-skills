# Unit and Component Tests

## Plan the tests

Identify what the change does that existing tests don't cover:

- New behavior → write new tests.
- Modified behavior in existing methods → edit the existing tests that covered the old behavior so they assert the new behavior, before changing the code ("Changed behavior" in Rules of the loop, [SKILL.md](../SKILL.md)).
- [DO NOT] test code unrelated to the change.

[DO NOT] test code from libraries: the libraries already have their own tests.

Cover the edge cases of the behavior under test; the complexity section below defines what counts as a boundary vs a branch. Name tests for the behavior they verify, following the repo's naming convention.

Place new tests in the EXISTING test class for that service, unless explicitly told to create a new file. When no test class exists, create one next to the closest sibling test class, following its naming and framework, and say so. When the project has no test framework, [DO NOT] add one silently: ask which one to use.

Write the plan one line per test, grouped by seam:

`<seam> | <test name: the behavior> | <input> → <expected> | boundary or branch | <test class>`

`Calculator.divide | divideByZeroDenominatorThrows | (10, 0) → ArithmeticException | boundary | CalculatorTest`

## Match existing conventions before asserting

See "Before Coding" in `pablo-code-philosophy` for the general principle: check the closest precedent, verify against a broader search, surface conflicts. Applied to tests specifically:

1. Treat the immediate sibling test (same file, same endpoint or feature, the closest analogous case) as the default precedent.
2. Separately search for how the same kind of assertion is done elsewhere in the suite, with a search that can also confirm absence, not only presence.

If the sibling and a broader match disagree, [DO NOT] pick one silently: name the conflict to the user.

## Test plan across seams

A change that spans several seams needs a plan-level answer: which tests, at which seams, which edge cases. The plan (per `pablo-code-planning`) names the seams and edge cases; this skill turns them into tests, seam by seam:

- Seam confirmation, the stop after each seam and the cycles inside a seam follow Seams and Rules of the loop in [SKILL.md](../SKILL.md).
- Edge cases per seam: the boundaries and branches of that seam's behavior (see coverage below).

## Checklist: is this test worth keeping?

- Falsifiable: breaking the logic it covers turns it red.
- Reproducible: same result on every run; no shared state, clock or randomness it does not control.
- One logical assertion per test.
- Simple and straightforward, with the fewest assumptions possible.
- Describes WHAT, not HOW.

## How many tests: cyclomatic complexity and branch coverage

The higher the cyclomatic complexity, the more tests the code needs: every decision path is behavior. Two coverage kinds get mixed up; keep them apart:

- **Boundaries**: limit values of the inputs, nulls, empty, zero, extremes, error paths. Across a seam's tests, every parameter under test gets its boundary values, each in its own test.
- **Branches**: each if/else, switch/match, guard clause; every decision path *within the agreed seams* is tested. Effort concentrates on critical paths and complex logic, not on every edge case across the codebase (see Seams in [SKILL.md](../SKILL.md)).

Worked example: `divide(x, y)`.

- Boundaries of x and y: x > 0, x = 0, x < 0, x = null; the same for y, with y = 0 as the division-by-zero error path. Extremes: `divide(Integer.MIN_VALUE, -1)` overflows in Java, where plain `/` silently returns `Integer.MIN_VALUE`; a test pins the contract the code chooses, that value or an exception.
- Branch: `if (x == y) return 1` is a shortcut with priority over the y = 0 error path. It needs its own tests: divide(5, 5) == 1 (the branch fires on equal operands), divide(0, 0) == 1 (the shortcut beats division by zero; removing it makes divide(0, 0) throw), and divide(null, null) == 1 (the shortcut fires before the null unboxing). In Java, compare with `Objects.equals` (value equality, null-safe); `==` on boxed `Integer` is reference equality.

## Anti-patterns

The anti-patterns: implementation-coupled, tautological, horizontal slicing, bypassing the interface, are detailed in [SKILL.md](../SKILL.md). Review them there before writing tests.

The "Integration-style" sections in the examples are not a fifth anti-pattern: the Good case shows behavior through the real flow; the Bad case, asserting that an internal collaborator was called, is an instance of the implementation-coupled anti-pattern.

## Code Examples

See [`examples/tests.java.md`](../examples/tests.java.md) and [`examples/tests.scala.md`](../examples/tests.scala.md). For other languages they illustrate the rules; the repo's own conventions decide syntax and framework.
