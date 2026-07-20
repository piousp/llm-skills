# GoF — Design Patterns With Judgment

## Maxim
> A pattern is a name for a recurring shape, not a goal to hit. Apply one when real variation exists; applying one before it exists is over-engineering with a design-patterns book as an alibi.

## Explanation
Most GoF patterns exist to manage variation: multiple algorithms (Strategy), multiple construction paths (Builder, Factory Method), multiple behaviors layered at runtime (Decorator). The pattern is only worth its indirection when that variation is real and current — a second implementation that exists today, not one anticipated for later.

A pattern applied to a problem with only one variant is pure ceremony: an interface, an abstract class, and a factory for something that will only ever have one shape. This is the same failure mode YAGNI names for any other abstraction.

Several classic patterns are also partially or fully subsumed by modern language features — Scala's `sealed trait` + pattern matching replaces most uses of Visitor and State; a `Function<A,B>`/`A => B` parameter replaces a Strategy class hierarchy when there's no shared state to carry.

## Code Examples

See [`../examples/gof.java.md`](../examples/gof.java.md) and [`../examples/gof.scala.md`](../examples/gof.scala.md).

## Warnings
- A pattern for a single implementation with no concrete second one is speculative abstraction — YAGNI overrides it.
- Visitor and State are frequently unnecessary in Scala: a `sealed trait` with `match` already gives double-dispatch behavior and exhaustiveness checking.
- A "family of algorithms" that's really just a couple of pure functions doesn't need a Strategy class hierarchy — a function parameter suffices.
- Singleton is almost never the right hand-rolled pattern; dependency injection or a language-level `object` covers the same need without the hidden global state.
- Patterns are not free — every one adds a layer of indirection a future reader must learn before understanding the actual logic underneath.

## Related Principles
- **KISS** → See [KISS.md](KISS.md)
- **YAGNI** → See [YAGNI.md](YAGNI.md)
- **SOLID** → See [SOLID.md](SOLID.md)
- **FP** → See [FP.md](FP.md)
- **DRY** → See [DRY.md](DRY.md)
- **UNIX** → See [UNX.md](UNX.md)
- **Mechanics** — for the curated 12-pattern catalog, per-language idioms, and worked examples, see the `gof-design-patterns` skill.
