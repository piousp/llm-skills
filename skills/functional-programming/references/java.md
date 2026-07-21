# Java FP Mechanics

Idiom-level guidance for applying the principles in `SKILL.md` to Java code. For worked
before/after examples, see `patterns.md`.

## `Optional`

`Optional<T>` models "a single value that may be absent" at API boundaries — it is not a general
replacement for `null` everywhere.

- **Return type, not parameter type.** Use `Optional<T>` as a method's return type when absence is a
  normal outcome. Don't use it as a parameter type — it forces every caller to wrap a value just to
  call the method, and doesn't compose with overloading the way a plain parameter does. If a
  parameter is genuinely optional, overload the method or use a builder/parameter object instead.
- **Don't use it as a field type.** `Optional` isn't `Serializable` and adds indirection for no
  benefit inside a class that already controls its own invariants. Keep fields `null`able (with a
  clear contract) or non-null; reserve `Optional` for what a method hands back to its caller.
- **Chain, don't unwrap early.** Prefer `.map()`, `.flatMap()`, `.filter()`, `.orElse()`,
  `.orElseGet()`, `.orElseThrow()` over `if (opt.isPresent()) { opt.get()... }`. The
  `isPresent()`/`get()` pair reintroduces the null-check it was meant to replace — it's a strong
  signal the surrounding code hasn't adopted the `Optional` chain fully.
- **`orElseGet` over `orElse` for expensive defaults.** `orElse(compute())` evaluates `compute()`
  unconditionally even when the value is present; `orElseGet(() -> compute())` only evaluates it on
  the empty path.

## Streams

- **Prefer a stream pipeline over an index-based loop** when the loop's purpose is building a new
  collection, aggregating a value, or filtering — that's exactly `map`/`filter`/`collect`/`reduce`.
  Keep the index-based loop when the logic genuinely needs the index, needs to break early in a way
  that's awkward to express as a predicate, or mutates external state as its primary purpose (see the
  anti-pattern table in `SKILL.md`).
- **No side effects inside `map`/`filter`.** These are meant to be pure transformations; mutating a
  variable outside the lambda breaks referential transparency, is unsafe if the stream is ever made
  parallel, and makes the pipeline's real effect invisible at the call site. If you need a side
  effect, do it in a `.forEach()` at the very end of the pipeline, not buried in an intermediate
  step.
- **Use `Collectors`, not a manual accumulator.** `.collect(Collectors.toList())`,
  `.toMap(...)`, `.groupingBy(...)`, `.partitioningBy(...)` express common aggregations directly;
  reaching for `.reduce()` with a manually-built mutable container duplicates what a named collector
  already does more clearly.
- **Don't over-chain.** A pipeline of 4-5 stages that reads as one sentence is fine; beyond that,
  extract a named intermediate variable or a private method per stage. A stream that needs a comment
  explaining what it does is a candidate for that split.

## Records and sealed interfaces — version-gated

Whether these are available depends on the target repo's Java version. **Check `java.version` /
`maven.compiler.release` in the repo's `pom.xml` before choosing a form** — this is the existing
build-aware-codegen rule applied to FP data modeling specifically. In a multi-repo codebase, Java
version commonly varies repo-by-repo — some services may already be on Java 17, others still on
Java 8 or 11. Don't assume 17 — verify per-repo.

**Java 17+** — use `record` for immutable data carriers and `sealed interface ... permits` for
closed hierarchies (the closest Java gets to an algebraic data type):

```java
sealed interface Result<T> permits Ok, Err {}
record Ok<T>(T value) implements Result<T> {}
record Err<T>(String message) implements Result<T> {}
```

Pattern-match with `instanceof` (Java 17) or a `switch` pattern (Java 21+ preview features aside,
17's `instanceof` pattern matching is the safe baseline):

```java
if (result instanceof Ok<T> ok) {
    return ok.value();
} else if (result instanceof Err<T> err) {
    throw new IllegalStateException(err.message());
}
```

**Java 8/11** — no `record`, no `sealed`. The equivalent immutable data carrier is a `final` class
with `private final` fields, a constructor, and `equals`/`hashCode`/`toString` (hand-rolled, or via
Lombok's `@Value` if the repo already depends on Lombok — check the `pom.xml` before adding it as a
new dependency):

```java
public final class Ok<T> {
    private final T value;
    public Ok(T value) { this.value = value; }
    public T value() { return value; }
    // equals/hashCode/toString
}
```

The equivalent closed hierarchy is an `abstract` class with a `private` constructor and a fixed,
enumerable set of `static final` nested subclasses — closed because the private constructor prevents
subclassing from outside the file:

```java
public abstract class Result<T> {
    private Result() {}

    public static final class Ok<T> extends Result<T> {
        private final T value;
        public Ok(T value) { this.value = value; }
        public T value() { return value; }
    }

    public static final class Err<T> extends Result<T> {
        private final String message;
        public Err(String message) { this.message = message; }
        public String message() { return message; }
    }
}
```

Dispatch on it with `instanceof` in one place (a small "visitor-lite" method), not scattered across
callers — that keeps the closed-hierarchy discipline even without the compiler's exhaustiveness
check.

## Typed error handling in Java

Java's stdlib has no `Either`. Given no FP library is a dependency in these repos (see "Boundaries"
in `SKILL.md`), two patterns cover what's needed:

- **`Optional<T>`** when the only information needed is "found" vs. "not found" — no error detail to
  carry.
- **A minimal custom result type** (the `Result<T>`/`Ok`/`Err` shapes above) when the failure case
  needs to carry a reason. Keep it generic and reusable across the module rather than inventing a new
  one-off result type per method.

For accumulating multiple validation errors (the "Validated" use case — see `patterns.md` for the
worked example), extend the `Err` case to hold a `List<String>` of messages instead of a single
`String`, and provide a way to combine two `Result`s that merges their error lists. That's the whole
pattern — no library needed.
