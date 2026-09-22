# GoF - Design Patterns With Judgment

## Maxim
> A pattern is a name for a recurring shape, not a goal to hit. Apply one when real variation exists; applying one before it exists is over-engineering with a design-patterns book as an alibi.

## Rules

- [ALWAYS] apply a pattern only when the variation it manages is real and current - a second
  implementation that exists today, not one anticipated for later. Strategy manages multiple
  algorithms, Builder/Factory Method manage multiple construction paths, Decorator manages
  behaviors layered at runtime.
- [NEVER] apply a pattern to a problem with only one variant; an interface, abstract class, and
  factory for something that will only ever have one shape is ceremony, the same failure mode
  YAGNI names for any other abstraction.
- [ALWAYS] check whether a modern language feature already subsumes the pattern before
  hand-rolling it.

### Pattern subsumed by a language feature

{BAD} in Scala, a `Visitor` interface with a class per operation, hand-rolled double dispatch,
over a hierarchy that's already (or could be) sealed.
{GOOD} a `sealed trait` with `match` - the same double-dispatch behavior plus compiler-checked
exhaustiveness, without accept/visit boilerplate.

- [ALWAYS] prefer `sealed trait` + pattern matching over Visitor or State in Scala, unless the
  operations must be defined outside the module owning the sealed trait - the expression-problem
  case Visitor still solves.
- [ALWAYS] prefer a `Function<A,B>`/`A => B` parameter over a Strategy class hierarchy when
  there's no shared state to carry.

## Code Examples

See [`../../examples/gof.java.md`](../../examples/gof.java.md) and [`../../examples/gof.scala.md`](../../examples/gof.scala.md).

## Warnings
- [NEVER] apply a pattern for a single implementation with no concrete second one; YAGNI
  overrides it. There is no imaginary flexibility: if the variation doesn't exist today, the
  pattern is ceremony.
- [ALWAYS] check Scala's `sealed trait` + `match` before reaching for Visitor or State; it
  already gives double-dispatch behavior and exhaustiveness checking.
- [NEVER] wrap a "family of algorithms" that's really just a couple of pure functions in a
  Strategy class hierarchy; a function parameter suffices.
- [NEVER] hand-roll Singleton; use dependency injection or a language-level `object` instead,
  which covers the same need without the hidden global state.
- [ALWAYS] weigh that patterns are not free - every one adds a layer of indirection a future
  reader must learn before understanding the actual logic underneath.

## Related Principles
- **KISS** → See [KISS.md](KISS.md). Covered by the `GoF vs KISS` row in the conflict matrix, [SKILL.md](../../SKILL.md).
- **YAGNI** → See [YAGNI.md](YAGNI.md). Covered by the `GoF vs YAGNI` row in the conflict matrix, [SKILL.md](../../SKILL.md).
- **DRY** → See [DRY.md](DRY.md). Covered by the `GoF vs DRY` row in [references/interactions.md](../interactions.md).
- **SOLID** → See [SOLID.md](SOLID.md). Covered by the `GoF vs SOLID` row in [references/interactions.md](../interactions.md).
- **FP** → See [FP.md](FP.md). Covered by the `GoF vs FP` row in the conflict matrix, [SKILL.md](../../SKILL.md).
- **UNIX** → See [UNX.md](UNX.md). Covered by the `GoF vs UNIX` row in [references/interactions.md](../interactions.md).
- **Mechanics** - for the curated 12-pattern catalog, per-language idioms, and worked examples, see the `gof-design-patterns` skill.
