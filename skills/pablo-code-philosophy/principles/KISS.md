# KISS - Keep It Simple, Stupid

## Maxim

> Keep It Simple Stupid. If 50 lines solve it, 500 is a confession. An orchestrator method that sequences N genuinely different steps is not the same as a method with N nested conditionals. The former reflects domain complexity; the latter means the data model needs fixing.

## Explanation

Simplicity is the primary goal, not a side effect. Every line of code carries a maintenance cost. Every conditional, every abstraction, every indirection - all debt until proven otherwise.

This is not about writing dumb code. It's about writing code that a developer (including you, six months from now) can read once and understand. Clever is not a compliment. Terse is not a virtue.

Three rules of thumb:

1. If a function fits on one screen, keep it there.
2. If a data structure has special cases, fix the structure, not the algorithm.
3. If you're explaining how clever the code is, you've already lost.

### Low cyclomatic complexity

Complexity is a symptom of the data model: when the shape of the data carries the distinction, the conditional disappears. A conditional per special case is a sign that the data model needs fixing, not more branches - see rule of thumb 2 above.

### Avoid nested logic calls

Nested logic is a symptom of the same disease: `fun1 -> fun2 -> fun3 -> fun4` call chains hide the actual control flow. Prefer flat, early-return code with single-level orchestration over deep nesting.

## Code Examples

See [`../examples/kiss.java.md`](../examples/kiss.java.md) and [`../examples/kiss.scala.md`](../examples/kiss.scala.md).

## Warnings

- Simplicity is not the same as brevity. A one-liner that uses five obscure operators is not simple.
- Don't confuse "simple" with "short." Two clear functions are better than one dense function.
- Refactoring to simplicity is a process. The first working version is rarely the simplest. Iterate.
- KISS can conflict with DRY - a generic abstraction removes duplication but adds complexity. When they conflict, KISS wins.

## Related Principles

- **YAGNI** → See [YAGNI.md](YAGNI.md). Covered by the decision pipeline in [SKILL.md](../SKILL.md): YAGNI gates everything, phase 1 precedes phase 2.
- **DRY** → See [DRY.md](DRY.md). Covered by the `KISS vs DRY` row in the conflict matrix, [SKILL.md](../SKILL.md), and by the KISS > DRY precedence in the pipeline section.
- **SOLID** → See [SOLID.md](SOLID.md). Covered by the `KISS vs SOLID` row in the conflict matrix, [SKILL.md](../SKILL.md).
- **GoF** → See [GoF.md](GoF.md). Covered by the `GoF vs KISS` row in the conflict matrix, [SKILL.md](../SKILL.md).
- **FP** → See [FP.md](FP.md). Covered by the `FP vs KISS` row in [references/interactions.md](../references/interactions.md).
- **Unix philosophy** → See [UNX.md](UNX.md). Covered by the `UNIX vs KISS` row in [references/interactions.md](../references/interactions.md).
