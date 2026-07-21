# DRY — Don't Repeat Yourself

## Maxim

> Don't Repeat Yourself. Three similar methods are better than one generic method that requires a PhD to understand. But if two functions do the same thing for different types, abstract immediately — that's not duplication, that's a missing generic.

## Explanation

DRY is about knowledge, not syntax. Two blocks can look identical and not violate DRY (they encode unrelated rules). Two blocks can look completely different and violate DRY (they encode the same business decision in two places).

The Three Strikes rule applies to *business logic* duplication: see it once, leave it. See it twice, still leave it. See it a third time, *then* consider an abstraction. Premature abstraction of business rules creates false coupling — you'll be afraid to change one use case because it might break the other.

**Exception: structural duplication (same algorithm, different types).** If two functions implement the same algorithm for different types, abstract at 2. This is not premature abstraction — it's recognizing a missing type parameter. The duplication is in the *structure*, not the *business rule*, and the abstraction is a generic, not a coupled dependency.

Before you DRY something up, ask: "If I change this logic, will I need to change both places?" If the answer is yes, extract. If the answer is "maybe" or "depends on context," leave the duplication. The cost of coupling two things that evolve independently exceeds the cost of duplicate lines.

## Code Examples

See [`../examples/dry.java.md`](../examples/dry.java.md) and [`../examples/dry.scala.md`](../examples/dry.scala.md).

## Warnings

- **Accidental duplication ≠ real duplication.** Two validation methods that look the same but validate different fields are not DRY violations. Don't merge them.
- **Structural duplication ≠ business duplication.** Same algorithm, different types → abstract at 2. Same business rule, different contexts → wait for 3.
- **Premature abstraction creates false coupling.** You'll be afraid to change one use case because it might break the other.
- **Static analysis tools catch syntactic duplication, not knowledge duplication.** Blindly following tool suggestions makes code worse.
- **DRY does not mean "never repeat anything."** Repetition of structure is fine. Repetition of meaning is not.

## Related Principles

- **KISS** → See [KISS.md](KISS.md)
- **YAGNI** → See [YAGNI.md](YAGNI.md)