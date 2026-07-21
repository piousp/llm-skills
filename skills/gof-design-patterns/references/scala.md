# Scala Pattern Mechanics

Idiom-level guidance for applying the 12 patterns in `SKILL.md` to Scala code. The central fact
to internalize before writing any of
these in Scala: **several GoF patterns exist specifically to work around gaps in Java's type
system that Scala doesn't have.** `sealed trait`/case classes give you closed algebraic data types
with compiler-checked exhaustive matching; function values are first-class. Before implementing
the Java-style class-based form of a pattern here, check whether the language feature already
covers it — that's the point of this file. For worked before/after examples, see `patterns.md`.

## Patterns largely subsumed by language features

### Visitor → pattern matching over a sealed hierarchy

Visitor's `accept`/`visit` double dispatch exists in Java because Java has no exhaustive `switch`
over a closed type hierarchy. Scala's `sealed trait` + case classes gives you that directly:

```scala
sealed trait Expression
final case class Literal(value: Int) extends Expression
final case class BinaryOp(op: String, left: Expression, right: Expression) extends Expression

def eval(expr: Expression): Int = expr match {
  case Literal(value)             => value
  case BinaryOp("+", l, r)        => eval(l) + eval(r)
  case BinaryOp("*", l, r)        => eval(l) * eval(r)
}
```

The compiler flags a non-exhaustive `match` on a sealed hierarchy (with `-Xfatal-warnings` or
equivalent) — the same safety net Visitor gives you in Java, with none of the `accept`/`visit`
boilerplate. **Do not implement a Java-style Visitor class in Scala** when the node types are
already (or could be) a `sealed trait` — see `SKILL.md`'s anti-pattern table. Reach for something
Visitor-shaped only if the operations genuinely need to be added from *outside* the module that
owns the sealed hierarchy, which the compiler-checked `match` can't help with — and even then,
prefer a typeclass (see below) over hand-rolled double dispatch.

### Strategy / Command → function values

Both patterns exist in Java to smuggle behavior through an object because Java (pre-lambdas)
couldn't pass behavior directly. Scala functions are values from the start:

```scala
type PricingStrategy = Order => BigDecimal

def total(order: Order, pricing: PricingStrategy): BigDecimal = pricing(order)

// Command: a deferred action is just a () => Unit, or a case class if it needs undo/inspection
val submitDistribution: () => Unit = () => client.send(request)
```

Only reach for a named trait (`trait PricingStrategy { def price(order: Order): BigDecimal }`)
when the strategy needs more than one method or carries meaningful state beyond a closure — a
single-method, stateless variation point is a function value, full stop.

### Builder → case class with named/default parameters

Java's Builder exists largely to work around the lack of named/default parameters and the
awkwardness of telescoping constructors. Scala doesn't have that problem:

```scala
final case class RetryPolicy(
  maxAttempts: Int = 3,
  backoff: FiniteDuration = 1.second
)

val policy = RetryPolicy(maxAttempts = 5)
```

Reach for an actual builder only when construction needs multi-step validation that can't be
expressed as a single case class constructor (e.g., accumulating errors across several optional
fields before allowing `build()`) — and even there, prefer the accumulating-errors ADT from
`functional-programming`'s `scala.md` over a mutable builder object.

### Factory Method → companion object `apply`

```scala
sealed trait Parser
final case class XmlParser() extends Parser
final case class JsonParser() extends Parser

object Parser {
  def forFormat(format: Format): Parser = format match {
    case Format.Xml  => XmlParser()
    case Format.Json => JsonParser()
  }
}
```

This is idiomatic Scala regardless of whether you think of it as "the Factory Method pattern" —
the companion object's `apply`/named factory method is simply where construction logic for a type
lives.

## Patterns that still earn their keep in Scala

These aren't erased by language features — they address a structural concern the type system
doesn't solve for you. Implement them, but still check `SKILL.md`'s anti-pattern table first.

### Adapter → an implementation of the target trait, or an implicit conversion

The plain form (a class implementing the trait your code expects, wrapping the incompatible one)
is identical in spirit to Java:

```scala
trait DistributionClient {
  def send(request: DistributionRequest): Unit
}

final class LegacyDistributionAdapter(legacy: LegacySoapClient) extends DistributionClient {
  override def send(request: DistributionRequest): Unit =
    legacy.submitJob(toLegacyPayload(request))
}
```

Scala also offers an `implicit` conversion or a typeclass instance as an Adapter mechanism. Prefer
the explicit class form above for anything crossing a module boundary — an implicit conversion
that silently adapts a type is exactly the kind of "magic" that makes code harder to trace, which
cuts against `pablo-code-philosophy`'s "Scientific code: no hidden state, no implicit
dependencies" principle. Reserve implicit-based adaptation for typeclass instances that are
already the established idiom in the codebase you're touching (check for precedent before
introducing the style).

### Decorator → trait mixins or explicit wrapping

```scala
final class LoggingDistributionClient(delegate: DistributionClient) extends DistributionClient {
  override def send(request: DistributionRequest): Unit = {
    logger.info(s"sending ${request.id}")
    delegate.send(request)
  }
}
```

Scala's stackable trait pattern (`trait Logging extends DistributionClient { abstract override def
send(...) = { ...; super.send(...) } }`) is an alternative when the decorators are meant to be
mixed in at construction time rather than composed via constructor wrapping. Use plain wrapping
(above) by default — it's easier to trace at the call site than trait linearization order, which
is a real cost of the mixin form when more than one or two decorators stack.

### Composite → a recursive sealed ADT

```scala
sealed trait FilterNode {
  def matches(event: Event): Boolean
}

final case class AndNode(children: List[FilterNode]) extends FilterNode {
  override def matches(event: Event): Boolean = children.forall(_.matches(event))
}

final case class LeafNode(predicate: Event => Boolean) extends FilterNode {
  override def matches(event: Event): Boolean = predicate(event)
}
```

Same shape as Java's Composite, expressed as a sealed hierarchy — client code calls `.matches()`
uniformly without checking leaf vs. group, and you additionally get exhaustive `match` support if
you ever need to walk the tree for a different operation.

### Template Method → a trait with an abstract step, or a higher-order function

```scala
trait IngestJob {
  final def run(): Unit = {
    val raw = fetch()
    val validated = validate(raw)
    persist(validated)
  }
  protected def fetch(): RawBatch
  protected def validate(raw: RawBatch): ValidatedBatch
  protected def persist(validated: ValidatedBatch): Unit
}
```

Equivalent, and often more idiomatic when there's only one varying step: pass that step in as a
function parameter to a fixed skeleton function instead of subclassing at all —

```scala
def runIngest(fetch: () => RawBatch, validate: RawBatch => ValidatedBatch): Unit = {
  persist(validate(fetch()))
}
```

Prefer the function-parameter form when a single step varies; keep the trait form when several
related steps vary together and are naturally grouped as one subclass per variant (e.g., one
subclass per external source system).

### Observer → still valid, consider existing reactive infrastructure first

The listener-registration shape is unchanged in Scala. Before implementing it in-process, check
whether the actual integration point is a message broker/event bus already used elsewhere in the
service (check the codebase for existing queue/topic wiring) — an in-process
Observer duplicates what pub/sub over an existing topic already gives you, and Scala services in
this codebase are frequently already event-driven at the architecture level.

### Chain of Responsibility → `PartialFunction` composition

```scala
val handlers: List[RawInput => Option[String]] = List(checkRequiredFields, checkFormat, checkBusinessRules)

def validate(input: RawInput): Option[String] =
  handlers.view.flatMap(h => h(input)).headOption
```

(`.view.flatMap(...).headOption` short-circuits on the first match and works on any Scala 2.11+/3
— `Iterator.nextOption()` is Scala 2.13+ only; verify the target repo's Scala version before using
it, the same way `functional-programming`'s `scala.md` gates right-biased `Either` on 2.13+/3.)

Or, when each handler is naturally a `PartialFunction`, `orElse` chains them directly:

```scala
val handler: PartialFunction[RawInput, String] = handleXml orElse handleJson orElse handleFallback
```

Same note as Java: this overlaps with `functional-programming`'s validator-composition case —
decide whether you need the full Chain-of-Responsibility framing or whether the function-list
form above is already the entire answer (in Scala, it usually is).

### State → a sealed trait with the transition method returning the next state

```scala
sealed trait OrderState {
  def onPaymentReceived(order: Order): OrderState
}
final case class Pending() extends OrderState {
  override def onPaymentReceived(order: Order): OrderState = Paid()
}
final case class Paid() extends OrderState {
  override def onPaymentReceived(order: Order): OrderState = this
}
```

Same shape as Java's State, expressed as a sealed hierarchy — the transition method's return type
being the sealed trait itself is what keeps every possible next-state compiler-checked at every
call site.

## Boundaries specific to this file

Don't introduce Cats' `Free` monad, tagless-final effect encodings, or a typeclass-heavy
reimplementation of any pattern above as a way to make it "more functional" — that's out of scope
for the same reason `functional-programming`'s Boundaries section excludes monad transformers and
tagless final: no repo here depends on Cats/ZIO, and every idiom above is expressible in stdlib
Scala. If a real need for one of those surfaces, raise it as a dependency decision, not something
introduced silently while implementing a pattern from this catalog.
