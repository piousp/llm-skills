# Scala FP Mechanics

Idiom-level guidance for applying the principles in `SKILL.md` to Scala code. These repos use
**stdlib-only** functional types — no Cats, no ZIO (see "Boundaries" in `SKILL.md`). For worked
before/after examples, see `patterns.md`.

## `Option`

- **Prefer it over `null`** for any value that may legitimately be absent — that's the whole point of
  having it in the type system. A `null` that survives past a boundary (e.g., a Java interop point)
  should be converted to `Option` immediately via `Option(nullableValue)`.
- **Chain with `map`/`flatMap`/`filter`/`getOrElse`**, not `if (opt.isDefined) opt.get`. As in Java,
  reaching for `.get` after an `isDefined`/`isEmpty` check defeats the purpose — it's the same null
  check with extra steps.
- **Use a `for`-comprehension when chaining several `Option`s together** — it reads as the sequential
  steps of "if all of these are present, compute the result," which is exactly the intent:

```scala
val result: Option[Summary] =
  for {
    user   <- findUser(id)
    prefs  <- findPreferences(user)
    region <- prefs.region
  } yield Summary(user, region)
```

## `Either`

- **`Either[L, R]` is right-biased** in current Scala (2.13+/3): `.map`/`.flatMap` operate on the
  `Right` case directly, no `.right` projection needed. Use `Left` for the failure case, `Right` for
  success — that convention (not enforced by the compiler) is what every idiomatic usage assumes.
- **Use it when the failure case carries information the caller needs to act on** (a validation
  message, an error code) — that's the difference from `Option`, which only says "absent," not "why."
- **Chain with a `for`-comprehension** the same way as `Option` — this is exactly what makes `Either`
  a "chainable" (monad-like) type per `SKILL.md`'s Functor/Monad section:

```scala
def process(input: RawInput): Either[String, Output] =
  for {
    validated <- validate(input)
    enriched  <- enrich(validated)
  } yield toOutput(enriched)
```

  The first `Left` short-circuits the rest of the chain — this is the "pipeline with `Either`"
  pattern in `patterns.md`.

## `Try`

- **Use `Try[T]` specifically to wrap an operation that can throw** (parsing, an external library
  call, I/O) at the boundary where you convert exception-based failure into a typed value. Don't use
  it as a general substitute for `Either` in domain logic — `Try`'s failure case is always a
  `Throwable`, which loses the ability to represent a specific, meaningful domain error the way a
  custom `Left` type does.
- Convert to `Either` (`.toEither`) as soon as you're past the boundary, so downstream code deals with
  a domain-shaped error type rather than an arbitrary exception.

## Pattern matching and case classes

- **Case classes** are the idiomatic immutable data carrier — `equals`/`hashCode`/`toString`/`copy`
  come for free, and they're the natural fit for the `Right`/`Ok`/`Err` shapes used throughout this
  skill.
- **`sealed trait` + case classes/objects** is Scala's algebraic data type — the direct analogue of
  Java 17's `sealed interface` + `record`, but available regardless of Scala version and checked for
  exhaustiveness by the compiler (with `-Xfatal-warnings` or equivalent, a non-exhaustive `match` on a
  sealed hierarchy is a compile-time signal, not a runtime surprise). This is the shape used by the
  existing `DomainResult`-style sealed hierarchy elsewhere in the codebase — follow that precedent
  rather than inventing a new result-type shape per module.
- **Match on the shape, not on a type tag/`isInstanceOf` chain.** Pattern matching against a sealed
  hierarchy is what gives you the compiler's exhaustiveness check; an `if`/`isInstanceOf` chain
  achieves the same runtime behavior without that safety net.

```scala
sealed trait Result[+A]
final case class Ok[A](value: A) extends Result[A]
final case class Err(messages: List[String]) extends Result[Nothing]

result match {
  case Ok(value)        => value
  case Err(messages)    => throw new IllegalStateException(messages.mkString(", "))
}
```

## Accumulating multiple errors (the "Validated" use case)

No Cats `Validated` here — none of these repos depend on Cats (see "Boundaries" in `SKILL.md`). The
same effect — collect *all* validation failures instead of stopping at the first one — is built with
a stdlib-only accumulating result type, following whatever `DomainResult`-style accumulating ADT
precedent already exists in the codebase (e.g., a result type with a dedicated case for surfacing
warnings alongside a value):

```scala
final case class Err(messages: List[String]) extends Result[Nothing]

def combine[A, B](ra: Result[A], rb: Result[B]): Result[(A, B)] =
  (ra, rb) match {
    case (Ok(a), Ok(b))       => Ok((a, b))
    case (Err(e1), Err(e2))   => Err(e1 ++ e2)
    case (Err(e), _)          => Err(e)
    case (_, Err(e))          => Err(e)
  }
```

The key difference from a plain `Either`/for-comprehension chain: `combine` inspects *both* sides
before short-circuiting, so two independent field validations both get reported even if both fail.
Reach for this only when a caller genuinely benefits from seeing every error at once (e.g., form-like
validation with several independent fields) — a single-field validation doesn't need it; a
`for`-comprehension short-circuiting on the first `Left` is simpler and correct there.
