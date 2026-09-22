# YAGNI - You Ain't Gonna Need It

## Maxim

> You Ain't Gonna Need It. Code for what the code does today, not for what you imagine it might do next year. Every speculative abstraction is a tax on readability with no known return.

## Rules

- [NEVER] write code for a future that hasn't arrived. Every speculative feature, every generic
  interface with exactly one implementation, every switch statement with branches for "future
  types" is waste.
- [ALWAYS] treat planning as cheap and code as expensive. A feature's cost isn't the time to
  write it - it's the ongoing cognitive load on every reader, the maintenance burden, the test
  surface, and the risk of coupling things that shouldn't be coupled.
- [ALWAYS] add a feature only if it's confidently needed soon (e.g. next sprint). [NEVER] add it
  for "maybe next quarter" or "sometime in the future" - trust your ability to add it when the
  time comes.

### Speculative interface vs. current need

{BAD} a `UserRepository` interface with a single implementation, built for a swap that isn't
planned.
{GOOD} a concrete type used directly; the interface is extracted when a second implementation
is real.

- [NEVER] add an interface, abstract class, or plugin point before a second concrete case exists.
- [ALWAYS] wait for the second real implementation to justify the abstraction.

## Code Examples

See [`../../examples/yagni.java.md`](../../examples/yagni.java.md) and [`../../examples/yagni.scala.md`](../../examples/yagni.scala.md).

## Warnings

- [NEVER] confuse YAGNI with no design; write simple design focused on current requirements.
- [NEVER] confuse YAGNI with no planning; build only what's needed now, while keeping the code
  easy to change.
- [NEVER] use YAGNI as an excuse to write unmaintainable code. Simple code that works today and
  is easy to refactor is the goal.
- [ALWAYS] watch the "just a small abstraction" trap: small abstractions compound. One interface
  with one implementation becomes two, then three, then a framework.
- [ALWAYS] treat two functions implementing the same algorithm for different types as a missing
  generic, not speculative abstraction; type parameterization is not the kind of abstraction
  YAGNI targets.
- [ALWAYS] invest in tests before applying YAGNI aggressively; if you cannot refactor safely,
  YAGNI is risky.

## Related Principles

- **KISS** → See [KISS.md](KISS.md). Covered by the decision pipeline in [SKILL.md](../../SKILL.md): YAGNI gates everything, phase 1 precedes phase 2.
- **DRY** → See [DRY.md](DRY.md). Covered by the `DRY vs YAGNI` row in [references/interactions.md](../interactions.md).
- **SOLID** → See [SOLID.md](SOLID.md). Covered by the `YAGNI vs SOLID` row in the conflict matrix, [SKILL.md](../../SKILL.md).
- **GoF** → See [GoF.md](GoF.md). Covered by the `GoF vs YAGNI` row in the conflict matrix, [SKILL.md](../../SKILL.md).
- **FP** → See [FP.md](FP.md). Covered by the `FP vs YAGNI` row in [references/interactions.md](../interactions.md).
- **UNIX** → See [UNX.md](UNX.md). Covered by the `UNIX vs YAGNI` row in [references/interactions.md](../interactions.md).
