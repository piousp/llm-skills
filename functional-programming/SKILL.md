---
name: functional-programming
description: >
  Mechanical, intermediate-level FP guidance for Java and Scala: immutability,
  pure functions, composition, referential transparency, higher-order functions, fold/reduce, and
  typed error handling (Option/Either, custom accumulating-error ADTs). TRIGGER when: refactoring
  imperative/OOP code toward FP, designing/reviewing typed error handling (Either/Option/Result/
  Validated-style types), reviewing heavy mutable state, nested conditionals, exception-driven
  control flow, or Streams/Optional/records/sealed interfaces/pattern matching/for-comprehensions.
  Also use when pablo-code-philosophy's "Light FP" bullet needs mechanical detail — that skill
  delegates here. Provides a code-smell → FP-principle table AND a when-NOT-to-apply-FP table.
  SKIP: monad transformers, tagless final, or FP libraries not already a dependency (Cats, Vavr,
  ZIO) — out of scope, see "Boundaries" below.
---

# Functional Programming — Mechanics

Mechanical companion to `pablo-code-philosophy`'s "Light FP" bullet. That skill states the
philosophy in one paragraph; this skill provides the recognition heuristics, the per-language
idioms, and the worked pattern catalog needed to apply it correctly in Java and Scala service
code.

FP here is a tool for readability and correctness, not an aesthetic to maximize. Every section below
exists to help you recognize when reaching for it pays off — and, just as importantly, when it
doesn't.

## Principles (intermediate level)

These are the concepts this skill assumes and applies. Boundaries are listed at the end.

- **Immutability**: prefer values that don't change after construction (`final` fields, `val`,
  immutable collections). A mutable accumulator is acceptable *inside* a single function when the
  alternative is awkward — the boundary that matters is whether mutation is observable outside the
  function's scope, not whether a `var`/non-final local exists at all.
- **Pure functions**: given the same input, always return the same output, with no observable side
  effect (no I/O, no mutation of shared state, no hidden dependency on ambient state/time). Push side
  effects (logging, persistence, network calls) to the edges of a pipeline; keep the transformation
  logic in between pure.
- **Referential transparency**: an expression can be replaced by its value without changing program
  behavior. This is what makes pure functions composable and testable in isolation — no mocking
  required to test the logic itself.
- **Composition over sequencing**: build behavior by combining small functions (`f andThen g`,
  `.map().flatMap()`) rather than writing one large procedure that inlines every step. Composition
  is not automatically more readable than a flat imperative sequence — see the anti-pattern table.
- **Higher-order functions (HOFs)**: functions that take or return other functions (`map`, `filter`,
  `andThen`, passing a validator as a parameter). Use them to parameterize *behavior*, not just data.
- **Fold/reduce**: collapse a collection into a single value via an accumulator function
  (`reduce`/`fold` in Java Streams, `foldLeft`/`foldRight` in Scala). This is the FP alternative to a
  loop with a mutable accumulator — see `references/patterns.md` for when the swap is worth it.
- **Functor/Monad, informally**: you don't need the category-theory vocabulary — you need the
  *shape*. A type is "mappable" (Functor-like) if it has a `.map` that transforms the contents
  without changing the container (`Optional<T>.map`, `Option[T].map`, `Stream<T>.map`). A type is
  "chainable" (Monad-like) if it also has `.flatMap`/`.andThen` to sequence operations that
  themselves return the same container type, avoiding nested wrapping (`Optional<Optional<T>>`,
  `Option[Option[T]]`). `Optional`/`Option`, `Either`, and `Stream`/collections are the three shapes
  you'll use constantly; that's the full scope here.
- **Typed error handling**: when a failure is an expected outcome of the domain (validation failed,
  record not found), encode it in the return type (`Either<Error, T>`, `Option<T>`) instead of
  throwing. Reserve exceptions for truly exceptional, unrecoverable conditions (bugs, I/O failures
  the caller can't reasonably handle). See `references/patterns.md` for the accumulating-errors
  pattern (the "Validated" use case) built on stdlib types.

## Recognition heuristic: code smell → FP principle

Use this table when reviewing or writing imperative/OOP code to decide *which* FP principle, if any,
addresses what you're looking at.

| Code smell | FP principle to apply | Why |
|---|---|---|
| A `var`/mutable field is reassigned across many branches to track "the result so far" | Fold/reduce, or an immutable accumulator threaded through recursion/pipeline stages | The mutation isn't the logic — it's bookkeeping. Replacing it makes the actual transformation visible. |
| A method throws a checked/custom exception for a condition the caller is expected to handle (not found, invalid input) | Typed error handling (`Either`/`Option`/custom result ADT) | Exceptions for expected outcomes hide the failure path from the type signature; callers can forget to catch. |
| Deeply nested `if`/`else` validating one field after another, each branch returning early | Composition of small validators + accumulating-errors pattern | Nesting depth tracks incidental control flow, not domain complexity; flattening surfaces the actual validation rules. |
| A method's output depends on a field/global/current time not visible in its signature | Pure function — pass the dependency as a parameter | Hidden inputs make the function untestable in isolation and its behavior a function of when it's called. |
| The same three-line transformation (map a field, filter a condition) is copy-pasted across several methods with only the field/condition changed | Higher-order function — extract the varying part as a parameter | The repetition is in the *shape*, not the specific field; parameterizing behavior removes the duplication without a class hierarchy. |
| A long method interleaves "compute" and "log/persist/notify" at every step | Composition — separate the pure transformation from the side-effecting steps, sequence them explicitly | Untangling pure and impure code makes the transformation testable without mocking the side effects. |
| A collection is iterated with an index-based loop just to build a new collection element-by-element | `.map`/`.filter`/`.stream()` pipeline | The loop is standing in for a mapping/filtering operation stdlib already expresses directly. |

## When NOT to apply FP

FP applied where it doesn't fit reads as ceremony, not clarity. Check this table before reaching for
a pattern above.

| Situation | Why FP hurts here |
|---|---|
| A simple 3-4 line loop with one clear side effect (logging, a single print, a single mutation of a local counter) | `fold`/`reduce` adds a layer of indirection over something already obvious; a plain loop is more legible. |
| A single failure point that the immediate caller already handles inline | `Either`/`Option` here is ceremony for its own sake; a direct null-check or a simple thrown exception is enough. |
| A chain of two transformations | `.map().flatMap()` doesn't read better than two straightforward statements; save composition for chains that actually grow. |
| Code whose imperative form already matches how a domain expert would describe the steps out loud | Rewriting it as a point-free composition can *reduce* readability for the next maintainer who thinks procedurally about this specific domain. |
| A one-off script or a genuinely single-use transformation with no reuse in sight | The payoff of composability (reuse, isolated testability) doesn't materialize if there's nothing to compose with or test against. |

If a smell from the table above is present but the situation also matches a row here, default to the
simpler code — don't apply FP reflexively. This mirrors `pablo-code-philosophy`'s "No speculative
abstractions" principle: don't buy composability nobody is going to use.

## Per-language mechanics

The concepts above are language-agnostic; the idioms to express them are not. Read the file for the
language you're touching:

- **Java** → `references/java.md`. Covers Streams, `Optional`, and the Java-17+ vs. Java-8/11
  split for records/sealed interfaces — check the target repo's `pom.xml` `java.version` before
  picking a form, per the existing build-aware-codegen rule.
- **Scala** → `references/scala.md`. Covers `Option`/`Either`/`Try`, pattern matching, case
  classes, and for-comprehensions.

## Pattern catalog

`references/patterns.md` has worked before/after examples, in both languages, for the recurring
implementation patterns: a validation pipeline built on `Either`, folding vs. a mutable-accumulator
loop, and function composition vs. method-chaining. Read it when implementing one of these shapes
rather than re-deriving the pattern from principles each time.

## Boundaries (explicitly out of scope)

This skill stops at stdlib-only, intermediate FP. It deliberately does not cover:

- **Monad transformers** (`EitherT`, `OptionT`) — not needed for the two-level nesting these
  codebases actually have; if you find yourself wanting one, the simpler fix is usually flattening
  the pipeline, not adding a transformer.
- **Tagless final / typeclass-polymorphic effect systems** — no repo here uses this style; don't
  introduce it.
- **FP libraries not already a dependency** — Cats, Vavr, and ZIO are not declared dependencies in
  any repo in this codebase as of this writing (verified against the build files). A Cats type such
  as `cats.effect.IO` may still show up transitively (e.g., pulled in by a library like
  `scanamo-cats-effect`) — treat that as incidental, not as license to write idiomatic Cats. Don't
  add one of these libraries to
  reach for a pattern in this skill; every pattern here is expressible in stdlib `Optional`/`Option`/
  `Either`/`Stream`. If a real need for one of these libraries arises, that's a dependency decision to
  raise explicitly, not something to introduce silently while implementing a feature.
