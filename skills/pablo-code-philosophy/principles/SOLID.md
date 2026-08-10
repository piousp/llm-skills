# SOLID - Tools, Not Religion

## Maxim

> SOLID is a toolkit, not a dogma. A fifty-line script doesn't need five interfaces. Apply each sub-principle when the pain it prevents is real, not when the theory feels good.

## Explanation

Each sub-principle solves a specific class of problem. None applies universally. The art is knowing *when* each one helps and *when* it adds cost.

### S - Single Responsibility

A class should have one reason to change. Not "one thing to do" - one *axis of change*. If two business rules change at different rates, keep them in different classes.

### O - Open/Closed

Open for extension, closed for modification. Prefer adding new code over changing existing code. Strategy pattern, not switch statements.

### L - Liskov Substitution

A subtype must be substitutable for its base type without breaking correctness. If a subclass can't do what the parent promises, the hierarchy is wrong. Prefer composition over inheritance. ADT = a closed set of variants where the sealed hierarchy is the point (Java `sealed` classes/interfaces, Scala `sealed trait` + case classes).

### I - Interface Segregation

Clients should not depend on interfaces they don't use. Fat interfaces force implementors to provide empty stubs. Split them.

### D - Dependency Inversion

Depend on abstractions, not concretions. High-level policy should not depend on low-level details. But don't add an interface for every single class - only when the dependency actually needs to be swapped.

## Code Examples

See [`../examples/solid.java.md`](../examples/solid.java.md) and [`../examples/solid.scala.md`](../examples/solid.scala.md).

## Warnings

- SOLID applied to a throwaway script is overhead, not quality.
- Dependency injection for one-implementation interfaces is indirection, not architecture.
- Interface Segregation can fragment into too many tiny interfaces. Merge them until the split is justified.
- Open/Closed does not mean "never change a file." It means prefer extension over modification - not forbid modification.
- The worst SOLID code is the one that follows all five rules to the letter and is impossible to navigate.

## Related Principles

- **KISS** → See [KISS.md](KISS.md). Covered by the `KISS vs SOLID` row in the conflict matrix, [SKILL.md](../SKILL.md).
- **YAGNI** → See [YAGNI.md](YAGNI.md). Covered by the `YAGNI vs SOLID` row in the conflict matrix, [SKILL.md](../SKILL.md).
- **DRY** → See [DRY.md](DRY.md). Covered by the `DRY vs SRP` row in the conflict matrix, [SKILL.md](../SKILL.md).
- **GoF** → See [GoF.md](GoF.md). Covered by the `GoF vs SOLID` row in [references/interactions.md](../references/interactions.md).
- **FP** → See [FP.md](FP.md). Covered by the `FP vs SOLID` row in [references/interactions.md](../references/interactions.md).
- **UNIX** → See [UNX.md](UNX.md). Covered by the `UNIX vs SOLID` row in [references/interactions.md](../references/interactions.md).
