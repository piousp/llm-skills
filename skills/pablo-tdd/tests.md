# Unit Tests

The definition of a good test and the anti-patterns live in [SKILL.md](SKILL.md). This file is the operational companion: planning coverage for a change, the working checklist, and how many tests a piece of code needs.

## Plan the tests

Identify what the change does that existing tests don't cover:

- New behavior → write new tests.
- Modified behavior in existing methods → adjust the existing tests that covered the old behavior so they assert the new behavior.
- [DO NOT] test code unrelated to the change.

[DO NOT] test code from libraries: the libraries already have their own tests.

Cover the edge cases of the behavior under test; the complexity section below defines what counts as a boundary vs a branch. Place new tests in the EXISTING test class for that service, unless explicitly told to create a new file. Name tests for the behavior they verify, following the repo's naming convention.

## Test plan across seams

A change that spans several seams needs a plan-level answer: which tests, at which seams, which edge cases. The plan (per `pablo-code-planning`) names the seams and edge cases; this skill converts that into tests:

- One vertical slice per seam: one test, then the minimal implementation to pass it, then the next seam. [NEVER] write all tests first - that is horizontal slicing (see Anti-patterns in [SKILL.md](SKILL.md)).
- Confirm each seam with the user before writing its tests (see Seams in [SKILL.md](SKILL.md)).
- Place each test in the EXISTING test class for its seam, unless told otherwise.
- Edge cases per seam: the boundaries and branches of that seam's behavior (see coverage below).

## Checklist: is this test worth keeping?

- Scientific: reproducible, falsifiable, testing a hypothesis.
- One logical assertion per test.
- Simple and straightforward, with the fewest assumptions possible.
- Describes WHAT, not HOW.
- Asserts boundary values for every parameter under test.

## How many tests: cyclomatic complexity and branch coverage

The higher the cyclomatic complexity, the more tests the code needs: every decision path is behavior. Two coverage kinds get mixed up; keep them apart:

- **Boundaries**: limit values of the inputs, nulls, empty, zero, extremes, error paths.
- **Branches**: each if/else, switch/match, guard clause; every decision path is tested.

Worked example: `divide(x, y)`.

- Boundaries of x and y: x > 0, x = 0, x < 0, x = null; the same for y, with y = 0 as the division-by-zero error path.
- Branch: `if (x == y) return 1` is a shortcut with priority over the y = 0 error path. It needs its own tests: divide(5, 5) == 1 (the branch fires on equal operands), divide(0, 0) == 1 (the shortcut beats division by zero; removing it makes divide(0, 0) throw), and divide(null, null) == 1 (the shortcut fires before the null unboxing). In Java, compare with `Objects.equals` (value equality, null-safe); `==` on boxed `Integer` is reference equality.

## Anti-patterns

The anti-patterns: implementation-coupled, tautological, horizontal slicing, bypassing the interface, are detailed in [SKILL.md](SKILL.md). Review them there before writing tests.

## Code Examples

See [`examples/tests.java.md`](examples/tests.java.md) and [`examples/tests.scala.md`](examples/tests.scala.md).
