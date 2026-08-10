---
name: pablo-code-philosophy
description: >
  Pablo's opinionated code philosophy: the YAGNI → KISS → DRY → SOLID decision
  pipeline, conflict resolutions with precedence KISS > DRY > SOLID, code style
  rules (data structures first, thin entry points, composition over inheritance,
  FP principles, GoF patterns with judgment, Unix philosophy), and the surgical
  change contract. Trigger when: writing, editing, refactoring, or planning
  code, or deciding scope, simplicity, duplication, or architecture for a code
  change. [ALWAYS] run each decision through the decision pipeline. [DO NOT]
  trigger for non-code prose, documentation, general questions, web research,
  configuration files, or test planning; the mechanical how-to lives in
  `pablo-tdd`, `functional-programming`, `gof-design-patterns`, and
  `refactor-identification`.
---

Invocation: this skill loads when the trigger conditions in the description
match. It is the judgment layer for code changes: it decides scope, simplicity,
duplication, and architecture. The mechanical how-to for FP idioms, the GoF
pattern catalog, refactor detection, and test planning lives in
`functional-programming`, `gof-design-patterns`, `refactor-identification`, and
`pablo-tdd` respectively.

# Code Manifesto

- **Simple and readable code** over elegant and terse.
- **Explicit and to the point** over smart and implicit.
- **Direct and flat** invocations over deep nested calls.
- **Code verbosity** over long comments explanation.
- **Reuse existing code** over writing new. The less written, the fewer bugs introduced

# Coding Principles

- **YAGNI** - You Ain't Gonna Need It. → See [principles/YAGNI.md](principles/YAGNI.md)
- **KISS** - Keep It Simple, Stupid. → See [principles/KISS.md](principles/KISS.md)
- **DRY** - Don't Repeat Yourself. → See [principles/DRY.md](principles/DRY.md)
- **SOLID** - Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion. → See [principles/SOLID.md](principles/SOLID.md)
- **Low cyclomatic complexity** - If the data has the right shape, conditionals disappear. → See [principles/KISS.md](principles/KISS.md#low-cyclomatic-complexity)
- **Avoid nested logic calls** - Flat, early-return style over deep call chains. A coordinator function calls and receives results. → See [principles/KISS.md](principles/KISS.md#avoid-nested-logic-calls)
- **GoF patterns** - Design patterns with judgment, not religion. → See [principles/GoF.md](principles/GoF.md)
- **No speculative abstractions** - an abstraction for a variation that doesn't exist yet is speculative; YAGNI gates it. → See [principles/YAGNI.md](principles/YAGNI.md), [principles/GoF.md](principles/GoF.md)
- **Don't reinvent the wheel** - follow known design patterns and reuse existing code over writing new shapes. → See [principles/GoF.md](principles/GoF.md)
- **Unix philosophy** - Design for Composition. → See [principles/UNX.md](principles/UNX.md)
- **Light FP** - Monads, immutability, typed errors, composition with judgment. → See [principles/FP.md](principles/FP.md)
- **Tests are part of the deliverable** - every change or new code ships with a unit-test plan; the how, and the bare-snippet exception where Surgical Changes wins, lives in `pablo-tdd`.
- **Data structures first**: start with the data model. If the structure is wrong, the algorithm is irrelevant. Eliminate special cases by fixing the shape of the data, not by piling up conditionals. → See [principles/KISS.md](principles/KISS.md), rule of thumb 2
- **Composition over inheritance** (except for Algebraic Data Types). → See [principles/SOLID.md](principles/SOLID.md), the L section prefers composition over inheritance
- **Scientific code** (referential transparency): no hidden state, no implicit dependencies, no non-determinism. If it can't be tested in isolation, the design is wrong. → See [principles/FP.md](principles/FP.md), the "Scientific code / Referential transparency" section
- **Thin entry points**: controllers, handlers, and entry points delegate immediately. Business logic belongs in services, not in the glue.

## Principle Interactions

KISS, DRY, YAGNI, and SOLID are not orthogonal. They interact, conflict, and reinforce each other. When they conflict: **KISS > DRY > SOLID**. YAGNI is a pre-condition that gates everything - no point debating how to implement something you shouldn't be building.

UNIX and FP operate on a separate axis from the structural pipeline below - they are transversal, not phases. UNIX governs *system behavior* (output discipline, runtime observability, error propagation, data formats). FP governs *code style/discipline* (immutability, composition, typed errors). Both apply throughout the four structural phases.

### Decision pipeline

```
YAGNI → KISS → DRY → SOLID
```

| Phase | Gate | Question |
|-------|------|----------|
| 1. YAGNI | Scope | Does this feature need to exist at all? |
| 2. KISS | Implementation | Is this the simplest expression of it? |
| 3. DRY | Extraction | See [principles/DRY.md](principles/DRY.md) - the 2-vs-3 rule |
| 4. SOLID | Architecture | Does the design pain justify the layer? |

GoF patterns are SOLID's implementation toolbox (Phase 4) - gated by Phases 1–2: don't reach for one until the variation it manages already exists.

### Conflict matrix

| Conflict | Resolution |
|----------|-----------|
| **KISS vs DRY** | KISS wins. A simple duplication is better than a complex abstraction. |
| **KISS vs SOLID** | KISS wins. If SOLID makes the code harder to read, don't apply it. |
| **YAGNI vs SOLID** | YAGNI wins. Don't add an abstraction layer until the pain of not having it is real. |
| **DRY vs SRP** | SRP wins. Don't extract shared code if the two contexts change for different reasons. |
| **GoF vs KISS** | KISS wins unless the variation the pattern manages is real and current - not anticipated. |
| **GoF vs YAGNI** | YAGNI wins. Applying a pattern before the variation exists is the canonical over-engineering case. |
| **GoF vs FP** | FP subsumes GoF when there's no shared state (Strategy → HOF, Command → lambda). The pattern is still justified with mutable state or open dispatch. |

For the non-conflicting interactions (allies/synergies), see [references/interactions.md](references/interactions.md).

## Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations or approaches exist, present them to the user. [DO NOT] pick one silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name the confusion. Ask.

## Surgical Changes

Touch only what's necessary. Don't clean what you didn't mess up.

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor what isn't broken.
- Respect existing style, even if you'd do it differently.
- Only remove imports/variables/functions that YOUR changes left unused.
- Unrelated problems: mention them, don't fix them.
- Every changed line must trace directly to the request.

## Don't Break What Exists

- Existing behavior matters more than design purity.
- Regressions are not acceptable because the new model "feels better".
- Don't break APIs, contracts, established workflows, or existing interfaces unless explicitly asked and the cost is understood.
