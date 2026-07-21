---
name: pablo-code-philosophy
description: >
  Pablo's code philosophy for writing and generating code.
---

# Code Philosophy

Simple and readable code over elegant and terse.
Write code for the version of yourself months from now who will maintain it without the task's context. Write code so anyone can read it years after you're gone.
Being able to maintain code effectively is of great value.

# Coding Principles

- **YAGNI** — You Ain't Gonna Need It. → See [principles/YAGNI.md](principles/YAGNI.md)
- **KISS** — Keep It Simple, Stupid. → See [principles/KISS.md](principles/KISS.md)
- **Low cyclomatic complexity** — If the data has the right shape, conditionals disappear. See [principles/KISS.md](principles/KISS.md)
- **Avoid nested logic calls** — Flat, early-return style over deep call chains. See [principles/KISS.md](principles/KISS.md)
- **DRY** — Don't Repeat Yourself. → See [principles/DRY.md](principles/DRY.md)
- **SOLID** — Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion. → See [principles/SOLID.md](principles/SOLID.md)
- **GoF patterns** — Design patterns with judgment, not religion. → See [principles/GoF.md](principles/GoF.md)
- **Unix philosophy** — Design for Composition. → See [principles/UNX.md](principles/UNX.md)
- **Light FP** — Immutability, typed errors, composition with judgment. → See [principles/FP.md](principles/FP.md)
- **Data structures first**: start with the data model. If the structure is wrong, the algorithm is irrelevant. Eliminate special cases by fixing the shape of the data, not by piling up conditionals.
- **Composition over inheritance** (except for Algebraic Data Types).
- **Config over code**: prefer runtime configuration (routing rules, policies) over compile-time conditionals. Business behavior changes should not require a redeploy. However, don't introduce feature flags or backwards-compatibility shims when you can just change the code directly — config is for genuine runtime variability, not for hedging against changes you're already making.
- **Scientific code**: no hidden state, no implicit dependencies, no non-determinism. If it can't be tested in isolation, the design is wrong.
- **Thin entry points**: controllers, handlers, and entry points delegate immediately. Business logic belongs in services, not in the glue.

## Principle Interactions

KISS, DRY, YAGNI, and SOLID are not orthogonal. They interact, conflict, and reinforce each other. When they conflict: **KISS > DRY > SOLID**. YAGNI is a pre-condition that gates everything — no point debating how to implement something you shouldn't be building.

UNIX and FP operate on a separate axis from the structural pipeline below — they are transversal, not phases. UNIX governs *system behavior* (output discipline, runtime observability, error propagation, data formats). FP governs *code style/discipline* (immutability, composition, typed errors). Both apply throughout the four structural phases.

### Decision pipeline

```
YAGNI → KISS → DRY → SOLID
```

| Phase | Gate | Question |
|-------|------|----------|
| 1. YAGNI | Scope | Does this feature need to exist at all? |
| 2. KISS | Implementation | Is this the simplest expression of it? |
| 3. DRY | Extraction | Business: 3 strikes? Structural (same algorithm, different type): abstract at 2. |
| 4. SOLID | Architecture | Does the design pain justify the layer? |

GoF patterns are SOLID's implementation toolbox (Phase 4) — gated by Phases 1–2: don't reach for one until the variation it manages already exists.

### Conflict matrix

| Conflict | Resolution |
|----------|-----------|
| **KISS vs DRY** | KISS wins. A simple duplication is better than a complex abstraction. |
| **KISS vs SOLID** | KISS wins. If SOLID makes the code harder to read, don't apply it. |
| **YAGNI vs SOLID** | YAGNI wins. Don't add an abstraction layer until the pain of not having it is real. |
| **DRY vs YAGNI** | Allies. Business logic: 3 strikes. **Structural duplication (same algorithm, different type): abstract at 2 — YAGNI yields.** |
| **DRY vs SRP** | SRP wins. Don't extract shared code if the two contexts change for different reasons. |
| **UNIX vs KISS** | Allies. Transparency reveals complexity; KISS reduces it. They form a feedback loop. |
| **UNIX vs YAGNI** | Allies. Fail Early, Fail Loud is YAGNI applied to error handling — don't speculatively handle errors that haven't occurred. |
| **UNIX vs SOLID** | Allies. Least Surprise governs interface contracts. ISP governs dependencies. Together they define clean boundaries. |
| **DRY vs UNIX** | Allies. Invest in Tools automates repetition. Fail Early prevents repeating error-handling patterns across the codebase. |
| **FP vs KISS** | Allies. Composition and immutability are usually more concise, not less — but if composition adds indirection without reducing real complexity, KISS wins. |
| **FP vs DRY** | Allies. Higher-order functions are the mechanism for structural duplication — abstract at 2, same as DRY's own rule. |
| **FP vs YAGNI** | Orthogonal, with a YAGNI gate: don't build a composable pipeline for a two-step chain nobody will extend. |
| **FP vs SOLID** | Allies. ISP is natural with functional interfaces/typeclasses; DIP is trivial when the dependency is a passed parameter. |
| **FP vs UNIX** | Allies (strongest pair). Function composition is pipeline composition in another paradigm; immutability reinforces Least Surprise. |
| **GoF vs KISS** | KISS wins unless the variation the pattern manages is real and current — not anticipated. |
| **GoF vs YAGNI** | YAGNI wins. Applying a pattern before the variation exists is the canonical over-engineering case. |
| **GoF vs DRY** | Allies. Template Method and Strategy remove duplicated skeleton/branching — a DRY mechanism. |
| **GoF vs SOLID** | Allies. GoF patterns implement SOLID concretely (Strategy → OCP, Adapter → DIP); they don't duplicate it. |
| **GoF vs FP** | FP subsumes GoF when there's no shared state (Strategy → HOF, Command → lambda). The pattern is still justified with mutable state or open dispatch. |
| **GoF vs UNIX** | Allies. Composition-of-handlers (Chain of Responsibility, Composite) is the OO echo of pipeline composition. |

## Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name the confusion. Ask.
- When debugging or investigating issues, do NOT assume a fix is already deployed or declare success until the user confirms the issue is resolved. Ask rather than assume.

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

## Tests

Always plan unit tests for changes. For planning and generating tests:
- Identify what the changes do that existing tests don't cover
- Changed behavior in existing methods where tests only cover the old behavior
- Edge cases: nulls, empty collections, boundary values, error paths
- Place new tests in the EXISTING test class for that service unless explicitly told to create a new file.

Tests should be:
- Scientific: reproducible, falsifiable, testing the hypothesis.
- Test the boundaries (edge cases).
- Simple, straightforward, with the fewest assumptions possible.
- Names correspond to what the test is testing while following the repo's naming convention
- Should not test other than the added code
- Should not test code from libraries: the libraries already have tests

## Verification

For multi-step tasks, define verifiable success criteria:

```text
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```
