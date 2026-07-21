# KISS — Keep It Simple, Stupid

## Maxim

> Keep It Simple Stupid. If 50 lines solve it, 500 is a confession. An orchestrator method that sequences N genuinely different steps is not the same as a method with N nested conditionals. The former reflects domain complexity; the latter means the data model needs fixing.

## Explanation

Simplicity is the primary goal, not a side effect. Every line of code carries a maintenance cost. Every conditional, every abstraction, every indirection — all debt until proven otherwise.

This is not about writing dumb code. It's about writing code that a developer (including you, six months from now) can read once and understand. Clever is not a compliment. Terse is not a virtue.

Three rules of thumb:

1. If a function fits on one screen, keep it there.
2. If a data structure has special cases, fix the structure, not the algorithm.
3. If you're explaining how clever the code is, you've already lost.

Nested logic is a symptom of the same disease: `fun1 -> fun2 -> fun3 -> fun4` call chains hide the actual control flow. Prefer flat, early-return code with single-level orchestration over deep nesting.

## Code Examples

See [`../examples/kiss.java.md`](../examples/kiss.java.md) and [`../examples/kiss.scala.md`](../examples/kiss.scala.md).

## Warnings

- Simplicity is not the same as brevity. A one-liner that uses five obscure operators is not simple.
- Don't confuse "simple" with "short." Two clear functions are better than one dense function.
- Refactoring to simplicity is a process. The first working version is rarely the simplest. Iterate.
- KISS can conflict with DRY — a generic abstraction removes duplication but adds complexity. When they conflict, KISS wins.

## Related Principles

- **YAGNI** → See [YAGNI.md](YAGNI.md)
- **Unix philosophy** → See [UNX.md](UNX.md)