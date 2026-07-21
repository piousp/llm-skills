# SOLID — Tools, Not Religion

## Maxim

> SOLID is a toolkit, not a dogma. A fifty-line script doesn't need five interfaces. Apply each sub-principle when the pain it prevents is real, not when the theory feels good.

## Explanation

Each sub-principle solves a specific class of problem. None applies universally. The art is knowing *when* each one helps and *when* it adds cost.

### S — Single Responsibility

A class should have one reason to change. Not "one thing to do" — one *axis of change*. If two business rules change at different rates, keep them in different classes.

### O — Open/Closed

Open for extension, closed for modification. Prefer adding new code over changing existing code. Strategy pattern, not switch statements.

### L — Liskov Substitution

A subtype must be substitutable for its base type without breaking correctness. If a subclass can't do what the parent promises, the hierarchy is wrong. Prefer composition over inheritance.

### I — Interface Segregation

Clients should not depend on interfaces they don't use. Fat interfaces force implementors to provide empty stubs. Split them.

### D — Dependency Inversion

Depend on abstractions, not concretions. High-level policy should not depend on low-level details. But don't add an interface for every single class — only when the dependency actually needs to be swapped.

## Code Examples

See [`../examples/solid.java.md`](../examples/solid.java.md) and [`../examples/solid.scala.md`](../examples/solid.scala.md).

## Warnings

- SOLID applied to a throwaway script is overhead, not quality.
- Dependency injection for one-implementation interfaces is indirection, not architecture.
- Interface Segregation can fragment into too many tiny interfaces. Merge them until the split is justified.
- Open/Closed does not mean "never change a file." It means prefer extension over modification — not forbid modification.
- The worst SOLID code is the one that follows all five rules to the letter and is impossible to navigate.

## Related Principles

- **KISS** → See [KISS.md](KISS.md)
- **YAGNI** → See [YAGNI.md](YAGNI.md)