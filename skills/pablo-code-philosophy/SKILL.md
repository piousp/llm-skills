---
name: pablo-code-philosophy
description: >
  Pablo's opinionated code philosophy: the YAGNI → KISS → DRY → SOLID decision
  pipeline, conflict resolutions with precedence KISS > DRY > SOLID, code style
  rules (data structures first, thin entry points, composition over inheritance,
  FP principles, GoF patterns with judgment, Unix philosophy), and the surgical
  change contract. Trigger when: writing, editing, or refactoring code, or
  deciding scope, simplicity, duplication, or architecture for a code change.
  [DO NOT] trigger for non-code prose, documentation, general questions, web
  research, configuration files, planning code before implementation, or test
  planning; the mechanical how-to lives in `pablo-code-planning`, `pablo-tdd`,
  `functional-programming`, `gof-design-patterns`, and `refactor-identification`.
---

# Code Philosophy

## Code Manifesto

- [ALWAYS] prefer simple and readable code over elegant and terse code.
- [ALWAYS] prefer explicit and to the point code over smart and implicit code.
- [ALWAYS] prefer direct and flat invocations over deep nested calls.
- [ALWAYS] prefer code verbosity over long comment explanations.
- [ALWAYS] reuse existing code over writing new code. The less written, the fewer bugs introduced.

## Coding Principles

- **YAGNI** - You Ain't Gonna Need It. [WHEN] deciding if a feature or abstraction needs to exist yet, read [references/principles/YAGNI.md](references/principles/YAGNI.md).
- **KISS** - Keep It Simple, Stupid. [WHEN] deciding if the code is the simplest expression of the problem, read [references/principles/KISS.md](references/principles/KISS.md).
- **DRY** - Don't Repeat Yourself. [WHEN] deciding whether to extract duplicated code, read [references/principles/DRY.md](references/principles/DRY.md).
- **SOLID** - Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion. [WHEN] deciding on architecture, layering, or responsibilities, read [references/principles/SOLID.md](references/principles/SOLID.md).
- **Low cyclomatic complexity** - [ALWAYS] fix the shape of the data so the conditional disappears, instead of adding a branch. [WHEN] tempted to add a branch for a special case, read [references/principles/KISS.md#low-cyclomatic-complexity](references/principles/KISS.md#low-cyclomatic-complexity).
- **Avoid nested logic calls** - [ALWAYS] prefer flat, early-return style over deep call chains; a coordinator function calls and receives results. [WHEN] reviewing a deep call chain, read [references/principles/KISS.md#avoid-nested-logic-calls](references/principles/KISS.md#avoid-nested-logic-calls).
- **GoF patterns** - [ALWAYS] apply design patterns with judgment, not religion. [WHEN] considering a design pattern, read [references/principles/GoF.md](references/principles/GoF.md).
- **No speculative abstractions** - [NEVER] add an abstraction for a variation that doesn't exist yet; YAGNI gates it. [WHEN] tempted to add an abstraction for a future variation, read [references/principles/YAGNI.md](references/principles/YAGNI.md) and [references/principles/GoF.md](references/principles/GoF.md).
- **Don't reinvent the wheel** - [ALWAYS] follow known design patterns and reuse existing code over writing new shapes. [WHEN] about to write a new shape from scratch, read [references/principles/GoF.md](references/principles/GoF.md).
- **Unix philosophy** - [ALWAYS] design for composition. [WHEN] designing component boundaries, CLI, or tool behavior, read [references/principles/UNX.md](references/principles/UNX.md).
- **Light FP** - Monads, immutability, typed errors, composition with judgment. [WHEN] choosing between imperative and functional style, read [references/principles/FP.md](references/principles/FP.md).
- **Tests are part of the deliverable** - [ALWAYS] ship every change or new code with a unit-test plan; the how, and the bare-snippet exception where Surgical Changes wins, lives in `pablo-tdd`.
- **Data structures first** - [ALWAYS] start with the data model; if the structure is wrong, the algorithm is irrelevant. [ALWAYS] eliminate special cases by fixing the shape of the data, not by piling up conditionals. [ALWAYS] make every value the type can take name a real case of the domain; a neutral/placeholder instance exists to satisfy the caller, not the model. [WHEN] designing the data model or checking for placeholder values, read [references/principles/KISS.md#every-value-of-a-type-must-name-a-domain-case](references/principles/KISS.md#every-value-of-a-type-must-name-a-domain-case).
- **Composition over inheritance** - [ALWAYS] prefer composition over inheritance, except for Algebraic Data Types. [WHEN] deciding between composition and inheritance, read [references/principles/SOLID.md](references/principles/SOLID.md), the L section.
- **Scientific code** (referential transparency) - [NEVER] rely on hidden state, implicit dependencies, or non-determinism; if it can't be tested in isolation, the design is wrong. [WHEN] checking a function's hidden state or determinism, read [references/principles/FP.md](references/principles/FP.md), the "Scientific code / Referential transparency" section.
- **Thin entry points** - [ALWAYS] have controllers, handlers, and entry points delegate immediately; business logic belongs in services, not in the glue. [ALWAYS] treat this as the rule for every orchestrator, not just the outermost one: sequence calls, pass results along. [NEVER] re-ask a question the callee already answered. [WHEN] reviewing a controller, handler, or orchestrator function, read [references/principles/KISS.md#return-the-result-not-the-instructions](references/principles/KISS.md#return-the-result-not-the-instructions).

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
| 3. DRY | Extraction | [WHEN] deciding whether to extract, read [references/principles/DRY.md](references/principles/DRY.md) - the 2-vs-3 rule |
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

- [ALWAYS] state assumptions explicitly. Ask if uncertain.
- [DO NOT] pick silently among multiple interpretations or approaches; present them to the user.
- [ALWAYS] say so if a simpler approach exists. Push back when warranted.
- [ALWAYS] stop and name the confusion when something is unclear. Ask.
- [ALWAYS] check the closest precedent first, then broaden the search. A positive match can't
  rule out a closer, contradicting precedent; surface conflicts, don't pick silently.
- [ALWAYS] keep an assumption that survives into merged code in the code itself: a comment on
  the line, a test that pins it, or a type that makes it unviolatable. Never only in the
  conversation that produced it - "we agreed it can't happen" is not reviewable six months from
  now.
- [ALWAYS] diagnose the cause behind a vague review comment before patching. "This feels like
  too many passes" or "I don't like this" reports a symptom, not a specification of the fix.
- [ALWAYS] verify a cause the reviewer states before acting on it ("this is redundant because X
  already does it"). Treat the stated reasoning as a hypothesis; the cheapest check is usually
  the test suite.

## Surgical Changes

Touch only what's necessary. Don't clean what you didn't mess up.

- [NEVER] "improve" adjacent code, comments, or formatting.
- [NEVER] refactor what isn't broken.
- [ALWAYS] respect existing style, even when you'd do it differently.
- [ALWAYS] remove only the imports/variables/functions that YOUR changes left unused.
- [ALWAYS] mention unrelated problems; don't fix them.
- [ALWAYS] trace every changed line directly to the request.

## Don't Break What Exists

- [ALWAYS] treat existing behavior as more important than design purity.
- [NEVER] accept a regression because the new model "feels better".
- [NEVER] break APIs, contracts, established workflows, or existing interfaces unless explicitly
  asked, with the cost understood.
