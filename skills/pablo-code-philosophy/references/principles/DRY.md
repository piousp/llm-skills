# DRY - Don't Repeat Yourself

## Maxim

> Don't Repeat Yourself. Three similar methods are better than one generic method that requires
> a PhD to understand. But if two functions do the same thing for different types, abstract
> immediately - that's not duplication, that's a missing generic.

## Rules

- [ALWAYS] treat DRY as about knowledge, not syntax. Two blocks that look identical can encode
  unrelated rules; two blocks that look different can encode the same business decision.
- [ALWAYS] apply Three Strikes to *business logic* duplication: see it once, leave it. See it
  twice, still leave it. See it a third time, consider an abstraction.
- [NEVER] abstract business rules before the third occurrence; premature abstraction creates
  false coupling between use cases that should evolve independently.
- Before extracting, ask: "if I change this, do both places change?" Yes → extract. "Maybe" or
  "depends on context" → leave the duplication.

### Structural duplication (exception)

{BAD} the same algorithm copy-pasted for two different types, waiting for a third occurrence.
{GOOD} a generic extracted at the second occurrence, because the duplication is a missing type
parameter, not a business rule.

- [ALWAYS] abstract at 2 when two functions implement the same algorithm for different types.
- [NEVER] treat this as premature abstraction; it's recognizing a missing generic, not coupling
  two business rules.

### Naming a value is not extracting an abstraction

{BAD} the same predicate re-evaluated in a `filter`, then an `exists`, then a `filterNot`, in the
same function, and nobody names the result.
{GOOD} classify once into a named value, work off that name for the rest of the function.

- [ALWAYS] name an intermediate result the second time a function needs the same answer; naming
  a local binding costs nothing and couples nothing.
- [NEVER] gate naming behind Three Strikes. That gate is for extraction (a shared function or
  type across call sites), not for a value named inside the one function that already computes
  it.

## Code Examples

See [`../../examples/dry.java.md`](../../examples/dry.java.md) and [`../../examples/dry.scala.md`](../../examples/dry.scala.md).

## Warnings

- [NEVER] treat two validation methods that look the same but validate different fields as a DRY
  violation. Don't merge them.
- [ALWAYS] use different thresholds for "same algorithm, different types" (abstract at 2) and
  "same business rule, different contexts" (wait for 3).
- [NEVER] let premature abstraction make you afraid to change one use case because it might
  break another.
- [NEVER] trust static-analysis duplication reports as a proxy for knowledge duplication; blind
  extraction makes code worse.
- [ALWAYS] remember DRY targets repeated meaning, not repeated structure. Repetition of
  structure is fine.
- [ALWAYS] check "too many passes over the same data" for a missing name before reaching for a
  performance argument. On small collections the extra passes rarely cost anything; the same
  question answered N times with no name attached is the real defect.

## Related Principles

- **KISS** → See [KISS.md](KISS.md). Covered by the `KISS vs DRY` row in the conflict matrix, [SKILL.md](../../SKILL.md).
- **YAGNI** → See [YAGNI.md](YAGNI.md). Covered by the `DRY vs YAGNI` row in [references/interactions.md](../interactions.md), which points back here for the threshold.
- **SOLID** → See [SOLID.md](SOLID.md). Covered by the `DRY vs SRP` row in the conflict matrix, [SKILL.md](../../SKILL.md).
- **GoF** → See [GoF.md](GoF.md). Covered by the `GoF vs DRY` row in [references/interactions.md](../interactions.md).
- **FP** → See [FP.md](FP.md). Covered by the `FP vs DRY` row in [references/interactions.md](../interactions.md), which points back here for the threshold.
- **UNIX** → See [UNX.md](UNX.md). Covered by the `DRY vs UNIX` row in [references/interactions.md](../interactions.md).
