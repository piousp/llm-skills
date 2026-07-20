# YAGNI — You Ain't Gonna Need It

## Maxim

> You Ain't Gonna Need It. Code for what the code does today, not for what you imagine it might do next year. Every speculative abstraction is a tax on readability with no known return.

## Explanation

The single biggest source of unnecessary complexity in software is code written for a future that never arrives. Every speculative feature, every generic interface with exactly one implementation, every switch statement with branches for "future types" — all of it is waste.

YAGNI is not an argument against thinking about the future. It's an argument against *building* for the future. Planning is cheap. Code is expensive. The cost of a feature is not just the time to write it — it's the ongoing cognitive load on every reader, the maintenance burden, the test surface, and the risk of coupling things that should not be coupled.

If you're confident the feature will be needed next sprint, add it. If it's "maybe next quarter" or "sometime in the future," don't. Trust your ability to add it when the time comes.

## Code Examples

See [`../examples/yagni.java.md`](../examples/yagni.java.md) and [`../examples/yagni.scala.md`](../examples/yagni.scala.md).

## Warnings

- YAGNI does not mean no design. It means simple design focused on current requirements.
- YAGNI does not mean no planning. It means building only what's needed now, while keeping the code easy to change.
- YAGNI is not an excuse to write unmaintainable code. Simple code that works today and is easy to refactor is the goal.
- The "but it's just a small abstraction" trap: small abstractions compound. One interface with one implementation becomes two, then three, then a framework.
- **Exception: type parameterization.** If two functions implement the same algorithm for different types, a generic is not speculative — it's the natural expression of the code. This is not the kind of abstraction YAGNI targets.
- YAGNI pairs with refactoring skill. If you cannot refactor safely, YAGNI is risky. Invest in tests.

## Related Principles

- **KISS** → See [KISS.md](KISS.md)
- **DRY** → See [DRY.md](DRY.md)