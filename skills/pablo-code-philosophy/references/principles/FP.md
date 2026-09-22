# FP - Light Functional Programming

## Maxim

> Prefer values over variables, functions over procedures, composition over sequencing.
> Immutability is the default; mutation is a local, contained exception, not an architecture.

## Rules

- [ALWAYS] treat values as immutable after construction. A mutable local variable is fine inside
  a function; it becomes a problem when the mutation is observable outside that scope.
- [ALWAYS] encode expected failure (not found, invalid input) in the return type (`Either`,
  `Option`) instead of throwing. Reserve exceptions for truly unrecoverable conditions.
- [ALWAYS] compose behavior from small functions (`map`, `filter`, `andThen`) only when the
  composition has more than two steps and genuinely benefits from being pipelined.
- [NEVER] treat FP as a mandate to eliminate every loop or every `var`. A three-line loop with
  one obvious side effect is clearer as a loop.
- [ALWAYS] reach for composition when it replaces real duplication or a real nested-conditional
  mess, not as a style preference.

### Scientific code / Referential transparency

{BAD} a unit that depends on hidden state, implicit dependencies, or non-determinism; testing it
means reconstructing an environment instead of exercising the code.
{GOOD} the same input always produces the same output, with no observable side effect.

- [ALWAYS] treat "can't be tested in isolation" as a design defect, not a testing problem.
- [ALWAYS] allow mutation that's local and contained. An accumulator inside one function dies
  with the stack frame and is never observed outside the call.
- [NEVER] mutate a shared field from inside a function that callers depend on; that's hidden
  state, not a local exception.

### Partial access needs a visible invariant

{BAD} `.head`, `.get`, `.apply(i)` on a value whose emptiness is a fact about today's producer,
not about the type.
{GOOD} the same access, guarded by an invariant a reader can verify in the same function or file
(a non-empty type, a prior check).

- [NEVER] use `head`, `last`, `apply(i)`, `Option.get`, or `!!` on an input the type allows to be
  empty, unless the invariant that rules the empty case out is established in code the reader
  can see.
- [NEVER] accept "it never happens in practice" as the invariant; that's a fact about today's
  caller, not something the compiler or the file enforces.
- [ALWAYS] change the type (`NonEmptyList`, `Option`, a smart constructor) or handle the empty
  case when the invariant lives elsewhere.

### Normalizing to compare is not normalizing to emit

{BAD} reusing the input that survived a normalized-match `filter`, assuming the normalization
carried over to the value itself.
{GOOD} normalizing again, explicitly, on the path that emits, logs, or persists the value.

- [NEVER] assume a value is normalized because it passed a predicate that normalized a throwaway
  key to compare it. `filter` selects; only `map` transforms.
- [ALWAYS] normalize explicitly on the output path when the emitted value must be in normalized
  form.
- [ALWAYS] name the consumer before deleting a transformation as "redundant". Two
  normalizations of the same field are duplicates only if they feed the same consumer.

### Structural equality is not identity

{BAD} `Set`, `distinct`, `contains`, or `filterNot(set)` over case classes/records used to
identify entities.
{GOOD} keying by id (or by position) when the elements are entities; structural equality
reserved for values.

- [NEVER] use a `Set`/`distinct`/membership check over full records as an identity check. Two
  distinct entities that are field-for-field equal collapse into one, and a membership-based
  removal then drops both or neither.
- [ALWAYS] key entities by their id when membership or dedup matters.

## Code Examples

See [`../../examples/fp.java.md`](../../examples/fp.java.md) and [`../../examples/fp.scala.md`](../../examples/fp.scala.md).

## Warnings

- [NEVER] treat immutability as a religion. A mutable accumulator inside a single function's
  scope is not a violation.
- [NEVER] assume `.map().flatMap()` chains are automatically more readable than an imperative
  sequence; see the anti-pattern table in `functional-programming` for when composition hurts.
- [ALWAYS] reserve typed error handling (`Either`/`Option`) for *expected* failure. Don't wrap
  genuine bugs or unrecoverable I/O errors in `Either` just to avoid throwing.
- [ALWAYS] write the tests. Pure functions are easier to test, not tested for free.
- [NEVER] introduce a functional library (Cats, Vavr, ZIO) to reach for a pattern already
  expressible in stdlib `Optional`/`Option`/`Either`/`Stream`.

## Related Principles

- **KISS** → See [KISS.md](KISS.md). Covered by the `FP vs KISS` row in [references/interactions.md](../interactions.md).
- **DRY** → See [DRY.md](DRY.md). Covered by the `FP vs DRY` row in [references/interactions.md](../interactions.md), which points back to DRY.md for the threshold.
- **YAGNI** → See [YAGNI.md](YAGNI.md). Covered by the `FP vs YAGNI` row in [references/interactions.md](../interactions.md).
- **SOLID** → See [SOLID.md](SOLID.md). Covered by the `FP vs SOLID` row in [references/interactions.md](../interactions.md).
- **GoF** → See [GoF.md](GoF.md). Covered by the `GoF vs FP` row in the conflict matrix, [SKILL.md](../../SKILL.md).
- **UNIX** → See [UNX.md](UNX.md). Covered by the `FP vs UNIX` row in [references/interactions.md](../interactions.md).
- **Mechanics** - for per-language idioms, the smell → principle table, and worked examples, see the `functional-programming` skill.
