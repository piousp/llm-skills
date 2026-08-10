# FP - Light Functional Programming

## Maxim
> Prefer values over variables, functions over procedures, composition over sequencing. Immutability is the default; mutation is a local, contained exception - not an architecture.

## Explanation
FP here is pragmatic, not academic. The goal is readability and correctness, not category theory. Three defaults change:

1. Values don't change after construction - a mutable local variable is fine *inside* a function; it becomes a problem when mutation is observable outside that scope.
2. Failure that's an expected outcome (not found, invalid input) is encoded in the return type (`Either`, `Option`) instead of thrown as an exception. Exceptions are reserved for truly unrecoverable conditions.
3. Behavior is composed from small functions (`map`, `filter`, `andThen`) rather than inlined into one large procedure - but only when the composition actually has more than two steps and genuinely benefits from being pipelined.

FP is not a mandate to eliminate every loop or every `var`. A three-line loop with one obvious side effect is clearer as a loop. Composition earns its keep when it replaces real duplication or a real nested-conditional mess, not as a style preference.

## Scientific code / Referential transparency

A unit that depends on hidden state, implicit dependencies, or non-determinism cannot be tested in isolation; when that happens, the design is wrong: the test would have to reconstruct the environment instead of exercising the code. Referential transparency is the property that enables isolation: the same input always produces the same output, with no observable side effects.

Mutation is acceptable when it is local and contained. A mutable accumulator inside a single function dies with the stack frame and is never observed outside the call; a shared field mutated by callers is hidden state. The observable-vs-local mutation distinction is worked out in [`../examples/fp.java.md`](../examples/fp.java.md) and [`../examples/fp.scala.md`](../examples/fp.scala.md).

## Code Examples

See [`../examples/fp.java.md`](../examples/fp.java.md) and [`../examples/fp.scala.md`](../examples/fp.scala.md).

## Warnings
- Immutability is not a religion. A mutable accumulator inside a single function's scope is not a violation.
- `.map().flatMap()` chains are not automatically more readable than an imperative sequence - see the anti-pattern table in `functional-programming` for when composition hurts.
- Typed error handling (`Either`/`Option`) is for *expected* failure. Don't wrap genuine bugs or unrecoverable I/O errors in `Either` just to avoid throwing.
- FP does not make testing free. Pure functions are easier to test, but the tests still need to be written.
- Don't introduce a functional library (Cats, Vavr, ZIO) to reach for a pattern expressible in stdlib `Optional`/`Option`/`Either`/`Stream`.

## Related Principles
- **KISS** → See [KISS.md](KISS.md). Covered by the `FP vs KISS` row in [references/interactions.md](../references/interactions.md).
- **DRY** → See [DRY.md](DRY.md). Covered by the `FP vs DRY` row in [references/interactions.md](../references/interactions.md), which points back to DRY.md for the threshold.
- **YAGNI** → See [YAGNI.md](YAGNI.md). Covered by the `FP vs YAGNI` row in [references/interactions.md](../references/interactions.md).
- **SOLID** → See [SOLID.md](SOLID.md). Covered by the `FP vs SOLID` row in [references/interactions.md](../references/interactions.md).
- **GoF** → See [GoF.md](GoF.md). Covered by the `GoF vs FP` row in the conflict matrix, [SKILL.md](../SKILL.md).
- **UNIX** → See [UNX.md](UNX.md). Covered by the `FP vs UNIX` row in [references/interactions.md](../references/interactions.md).
- **Mechanics** - for per-language idioms, the smell → principle table, and worked examples, see the `functional-programming` skill.
