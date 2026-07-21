# Pattern Catalog

Worked before/after examples for the recurring implementation shapes referenced from `SKILL.md`.
Each pattern shows the imperative/OOP starting point and its FP equivalent, in both Java and Scala.
Read the "when this is worth it" note before applying — none of these are worth doing unconditionally
(see the anti-pattern table in `SKILL.md`).

## Pattern 1: Validation pipeline with typed errors (errors as data)

Replace exception-driven validation with a return type that makes the failure path visible in the
signature, and let failures short-circuit the pipeline instead of unwinding the stack.

**When it's worth it:** the failure is an expected domain outcome (bad input, business-rule
violation), and there's more than one step in the pipeline where it can fail. For a single validation
check with one caller, a direct `if`/throw is simpler — see `SKILL.md`'s anti-pattern table.

### Java

Before (exceptions carry control flow):

```java
public Output process(RawInput input) {
    try {
        Validated validated = validate(input);      // throws ValidationException
        Enriched enriched = enrich(validated);       // throws EnrichmentException
        return toOutput(enriched);
    } catch (ValidationException | EnrichmentException e) {
        throw new ProcessingException(e.getMessage(), e);
    }
}
```

After (Java 17+, `sealed interface` result type from `java.md`):

```java
public Result<Output> process(RawInput input) {
    return validate(input)
        .flatMap(this::enrich)
        .map(this::toOutput);
}
// validate: RawInput -> Result<Validated>
// enrich:   Validated -> Result<Enriched>
```

For Java 8/11, the same shape holds with the `abstract class` + nested `final` subclasses form of
`Result<T>` from `java.md` — the call site (`validate(input).flatMap(...).map(...)`) is identical;
only the `Result` type's own definition changes with the version gate.

### Scala

Before (`throw` carries control flow):

```scala
def process(input: RawInput): Output = {
  val validated = validate(input)   // throws
  val enriched = enrich(validated)  // throws
  toOutput(enriched)
}
```

After (`Either`, chained with a for-comprehension):

```scala
def process(input: RawInput): Either[String, Output] =
  for {
    validated <- validate(input)   // RawInput => Either[String, Validated]
    enriched  <- enrich(validated) // Validated => Either[String, Enriched]
  } yield toOutput(enriched)
```

The first `Left` returned by `validate` or `enrich` short-circuits the rest of the chain — no
`try`/`catch` needed, and the possibility of failure is visible in the return type.

## Pattern 2: Fold vs. a loop with a mutable accumulator

Replace a loop whose only job is collapsing a collection into one value with `reduce`/`fold`, when
that's genuinely all the loop does.

**When it's worth it:** the loop body is a single accumulation step with no early-exit logic, no
side effect other than updating the accumulator, and no index dependency. If the loop also logs,
short-circuits conditionally, or needs the index, keep the loop — see `SKILL.md`'s anti-pattern
table ("a simple loop with one clear side effect").

### Java

Before:

```java
int total = 0;
for (Order order : orders) {
    total += order.getAmount();
}
```

After:

```java
int total = orders.stream()
    .mapToInt(Order::getAmount)
    .sum();
```

For a more general accumulation than a numeric sum, `reduce` with an explicit identity and combiner
makes the same shape explicit:

```java
int total = orders.stream()
    .map(Order::getAmount)
    .reduce(0, Integer::sum);
```

### Scala

Before:

```scala
var total = 0
for (order <- orders) {
  total += order.amount
}
```

After:

```scala
val total = orders.foldLeft(0)(_ + _.amount)
```

or, when the transform-then-sum shape is clearer split apart:

```scala
val total = orders.map(_.amount).sum
```

## Pattern 3: Function composition vs. method chains / nested calls

Replace either (a) a chain of nested calls that reads inside-out, or (b) a long procedural sequence
of intermediate variables, with explicit composition — when the steps are genuinely a fixed pipeline
of independent transformations.

**When it's worth it:** the steps are pure transformations with no branching between them, and naming
the composed function communicates the pipeline's intent better than reading each step. If the steps
interleave decisions or side effects, a flat sequence of statements is more legible — composing it
doesn't remove the complexity, it just hides where it lives.

### Java

Before (nested calls, reads inside-out):

```java
Output result = toOutput(enrich(validate(normalize(rawInput))));
```

After (`Function` composition with `andThen`, reads left-to-right in the order operations happen):

```java
Function<RawInput, Output> pipeline = this::normalize
    .andThen(this::validate)
    .andThen(this::enrich)
    .andThen(this::toOutput);

Output result = pipeline.apply(rawInput);
```

Note the tradeoff: this reads well when the pipeline itself is a stable, named concept worth
extracting. If `pipeline` is only ever used once at this one call site, the nested-call form (or a
flat sequence of named intermediate variables) is arguably just as clear and avoids introducing a
`Function` value purely for its own sake.

### Scala

Before (nested calls):

```scala
val result = toOutput(enrich(validate(normalize(rawInput))))
```

After (`andThen` composition):

```scala
val pipeline: RawInput => Output =
  normalize _ andThen validate andThen enrich andThen toOutput

val result = pipeline(rawInput)
```

Same tradeoff as the Java case: worth it when the composed pipeline is a reusable, nameable concept;
not worth it for a single inline call where a flat sequence of `val`s is equally readable and easier
to step through in a debugger.
