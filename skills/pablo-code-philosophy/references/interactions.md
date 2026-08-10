# Principle Interactions - Allies (non-conflicting)

These are synergy relationships between principles, not conflicts requiring a resolution or
directive. Where two principles genuinely conflict, see the Conflict matrix in
[../SKILL.md](../SKILL.md) instead.

| Interaction | Rationale |
|----------|-----------|
| **UNIX vs KISS** | Allies. Transparency reveals complexity; KISS reduces it. They form a feedback loop. |
| **UNIX vs YAGNI** | Allies. Fail Early, Fail Loud is YAGNI applied to error handling - don't speculatively handle errors that haven't occurred. |
| **UNIX vs SOLID** | Allies. Least Surprise governs interface contracts. ISP governs dependencies. Together they define clean boundaries. |
| **DRY vs UNIX** | Allies. Invest in Tools automates repetition. Fail Early prevents repeating error-handling patterns across the codebase. |
| **DRY vs YAGNI** | Allies. YAGNI yields to structural duplication, per DRY's rule. The 2-vs-3 threshold and its rationale are defined once in [DRY.md](../principles/DRY.md). |
| **FP vs DRY** | Allies. Higher-order functions are the mechanism for structural duplication. The threshold is DRY's own rule, see [DRY.md](../principles/DRY.md). |
| **FP vs SOLID** | Allies. ISP is natural with functional interfaces/typeclasses; DIP is trivial when the dependency is a passed parameter. |
| **FP vs UNIX** | Allies (strongest pair). Function composition is pipeline composition in another paradigm; immutability reinforces Least Surprise. |
| **FP vs KISS** | Allies. Composition and immutability are usually more concise, not less - but if composition adds indirection without reducing real complexity, KISS wins. |
| **FP vs YAGNI** | Orthogonal, with a YAGNI gate: don't build a composable pipeline for a two-step chain nobody will extend. |
| **GoF vs DRY** | Allies. Template Method and Strategy remove duplicated skeleton/branching - a DRY mechanism. |
| **GoF vs SOLID** | Allies. GoF patterns implement SOLID concretely (Strategy → OCP, Adapter → DIP); they don't duplicate it. |
| **GoF vs UNIX** | Allies. Composition-of-handlers (Chain of Responsibility, Composite) is the OO echo of pipeline composition. |

← Back to [SKILL.md](../SKILL.md)
