# SOLID - Tools, Not Religion

## Maxim

> SOLID is a toolkit, not a dogma. A fifty-line script doesn't need five interfaces. Apply each
> sub-principle when the pain it prevents is real, not when the theory feels good.

## Rules

- [ALWAYS] apply each sub-principle only when the pain it prevents is real, not on theory alone.
- [NEVER] add a layer, interface, or split because the rule exists; add it because a variation
  or a swap already needs it.

### S - Single Responsibility

{BAD} a class that changes for two unrelated business reasons.
{GOOD} one class per axis of change.

- [ALWAYS] split a class when two rules inside it change at different rates.
- [NEVER] confuse "one thing to do" with "one reason to change"; a class can do several things
  that all change together.
- [ALWAYS] keep a guard with the rule it enforces. If the caller has to write
  `if (x.nonEmpty) report(x)`, the emptiness rule belongs inside `report`, not at the call site.
  This holds even at a single call site; it's a cohesion question, not a duplication count.

### O - Open/Closed

{BAD} a switch statement that grows a case every time a new variant appears.
{GOOD} a new implementation added beside the existing ones; nothing existing changes.

- [ALWAYS] prefer adding new code (a new strategy, a new case) over editing existing code for a
  new variant.
- [NEVER] read this as "never touch a file"; it means prefer extension, not a ban on
  modification.

### L - Liskov Substitution

{BAD} a subtype that throws or returns the wrong result in a case its base type promises to
handle.
{GOOD} every subtype is swappable for its base type with no surprise.

- [ALWAYS] prefer composition over inheritance, unless the hierarchy is a closed set of variants
  (an ADT: Java `sealed` classes/interfaces, Scala `sealed trait` + case classes).
- [NEVER] keep a hierarchy where a subclass can't do what the parent promises.

### I - Interface Segregation

{BAD} a fat interface that forces unrelated implementors to stub methods they don't use.
{GOOD} narrow interfaces, one per client need.

- [ALWAYS] split an interface when a client depends on methods it never calls.
- [NEVER] fragment into one-method interfaces without a real client driving the split.

### D - Dependency Inversion

{BAD} high-level policy code importing a concrete low-level class directly.
{GOOD} high-level code depending on an abstraction; the concrete class is swapped in underneath.

- [ALWAYS] depend on an abstraction when the concrete implementation actually needs to be
  swapped (tests, multiple providers).
- [NEVER] add an interface for every class "just in case"; one implementation behind an
  interface is indirection, not architecture.

## Code Examples

See [`../../examples/solid.java.md`](../../examples/solid.java.md) and [`../../examples/solid.scala.md`](../../examples/solid.scala.md).

## Warnings

- [NEVER] apply SOLID to a throwaway script; it's overhead there, not quality.
- [NEVER] inject a dependency for a one-implementation interface; that's indirection, not
  architecture.
- [ALWAYS] merge fragmented interfaces back until a real split is justified.
- [ALWAYS] read Open/Closed as "prefer extension", not "never change a file".
- The worst SOLID code follows all five rules to the letter and is impossible to navigate.

## Related Principles

- **KISS** → See [KISS.md](KISS.md). Covered by the `KISS vs SOLID` row in the conflict matrix, [SKILL.md](../../SKILL.md).
- **YAGNI** → See [YAGNI.md](YAGNI.md). Covered by the `YAGNI vs SOLID` row in the conflict matrix, [SKILL.md](../../SKILL.md).
- **DRY** → See [DRY.md](DRY.md). Covered by the `DRY vs SRP` row in the conflict matrix, [SKILL.md](../../SKILL.md).
- **GoF** → See [GoF.md](GoF.md). Covered by the `GoF vs SOLID` row in [references/interactions.md](../interactions.md).
- **FP** → See [FP.md](FP.md). Covered by the `FP vs SOLID` row in [references/interactions.md](../interactions.md).
- **UNIX** → See [UNX.md](UNX.md). Covered by the `UNIX vs SOLID` row in [references/interactions.md](../interactions.md).
