# Pattern Catalog

Worked before/after examples for all 12 patterns covered by `SKILL.md`, in both Java and Scala.
Each entry shows the smell-driven starting point and the pattern applied. Read the "when it's
worth it" note before applying — check it against `SKILL.md`'s anti-pattern table; none of these
are worth doing unconditionally.

**Contents:** Creational (Factory Method, Builder) · Structural (Adapter, Decorator, Composite) ·
Behavioral (Strategy, Template Method, Observer, Chain of Responsibility, State, Visitor, Command).

## Creational

### Factory Method

**When it's worth it:** the decision of which concrete type to construct is duplicated at more
than one call site, or is expected to grow a new case. For a single call site with a fixed, stable
type, a direct constructor call is simpler.

Java — before (the decision is inline, and will be copy-pasted at the next call site):

```java
Parser parser = format == Format.XML ? new XmlParser() : new JsonParser();
```

Java — after:

```java
Parser parser = ParserFactory.forFormat(format);
```

Scala — before:

```scala
val parser = if (format == Format.Xml) new XmlParser() else new JsonParser()
```

Scala — after:

```scala
val parser = Parser.forFormat(format) // companion object apply; see scala.md
```

### Builder

**When it's worth it:** several optional fields with defaults, or assembly steps that need
validating together before construction. For 2-3 required fields with no optional logic, skip it —
see `SKILL.md`'s anti-pattern table.

Java — before (telescoping constructors, or one constructor with 6 parameters most callers barely
use):

```java
RetryPolicy policy = new RetryPolicy(3, Duration.ofSeconds(1), true, false, null, 0);
```

Java — after:

```java
RetryPolicy policy = RetryPolicy.builder()
    .maxAttempts(5)
    .backoff(Duration.ofSeconds(2))
    .build();
```

Scala — before/after collapse into one step, since the "before" telescoping-constructor problem
doesn't exist in Scala:

```scala
val policy = RetryPolicy(maxAttempts = 5, backoff = 2.seconds) // named + default params
```

If Scala code needs multi-step validation before construction, see `functional-programming`'s
accumulating-errors ADT — that's the correct Scala replacement for a validating Builder, not a
mutable builder object.

## Structural

### Adapter

**When it's worth it:** more than one call site would otherwise repeat its own translation logic
against the same incompatible interface.

Java — before (translation logic repeated at each call site):

```java
legacyClient.submitJob(new LegacyPayload(request.id(), request.destination(), request.payloadBytes()));
```

Java — after:

```java
DistributionClient client = new LegacyDistributionAdapter(legacyClient);
client.send(request);
```

Scala — before:

```scala
legacyClient.submitJob(LegacyPayload(request.id, request.destination, request.payloadBytes))
```

Scala — after:

```scala
val client: DistributionClient = new LegacyDistributionAdapter(legacyClient)
client.send(request)
```

### Decorator

**When it's worth it:** two or more behaviors need to layer/compose over a base implementation. For
a single fixed wrapping, a plain wrapper method is equally clear.

Java — before (logging and retry logic hardcoded inside the base implementation, coupling
unrelated concerns):

```java
public final class DirectDistributionClient implements DistributionClient {
    @Override
    public void send(DistributionRequest request) {
        log.info("sending {}", request.id());
        for (int attempt = 0; attempt < 3; attempt++) {
            try { doSend(request); return; } catch (Exception e) { /* retry */ }
        }
    }
}
```

Java — after (each concern is its own layer, composed at construction):

```java
DistributionClient client = new LoggingDistributionClient(
    new RetryingDistributionClient(new DirectDistributionClient(), 3));
```

Scala — before:

```scala
final class DirectDistributionClient extends DistributionClient {
  override def send(request: DistributionRequest): Unit = {
    logger.info(s"sending ${request.id}")
    (1 to 3).iterator.map(_ => Try(doSend(request))).collectFirst { case Success(_) => () }
  }
}
```

Scala — after:

```scala
val client: DistributionClient =
  new LoggingDistributionClient(new RetryingDistributionClient(new DirectDistributionClient(), 3))
```

### Composite

**When it's worth it:** the tree has more than one level of nesting and client code currently
special-cases leaf vs. group at more than one call site.

Java — before (type-checking leaf vs. group at the call site):

```java
boolean matches(FilterNode node, Event event) {
    if (node instanceof LeafNode leaf) {
        return leaf.predicate().test(event);
    } else if (node instanceof AndNode and) {
        for (FilterNode child : and.children()) {
            if (!matches(child, event)) return false;
        }
        return true;
    }
    throw new IllegalStateException("unknown node type");
}
```

Java — after (uniform interface, no type-check at the call site):

```java
boolean matches = node.matches(event); // AndNode and LeafNode both implement FilterNode.matches
```

Scala — before (matching on node type at the call site instead of inside the ADT):

```scala
def matches(node: FilterNode, event: Event): Boolean = node match {
  case LeafNode(predicate)   => predicate(event)
  case AndNode(children)     => children.forall(c => matches(c, event))
}
```

Scala — after (the behavior moves onto the ADT itself, so callers stop pattern-matching on
structure they don't need to know about):

```scala
val result = node.matches(event) // matches is defined once per case in the sealed trait
```

Note the Scala "before" already reads fine for a lot of cases — reach for pushing `matches` onto
the trait only once several call sites duplicate the same `match`, not on the first occurrence.

## Behavioral

### Strategy

**When it's worth it:** more than one interchangeable algorithm exists today, or the set is
concretely expected to grow — not "might grow" speculatively.

Java — before (branching on a type/enum to select behavior):

```java
BigDecimal price(Order order, PricingMode mode) {
    if (mode == PricingMode.STANDARD) return standardPrice(order);
    else if (mode == PricingMode.DISCOUNT) return discountPrice(order);
    else return premiumPrice(order);
}
```

Java — after:

```java
BigDecimal price(Order order, PricingStrategy strategy) {
    return strategy.price(order);
}
```

Scala — before:

```scala
def price(order: Order, mode: PricingMode): BigDecimal = mode match {
  case PricingMode.Standard  => standardPrice(order)
  case PricingMode.Discount => discountPrice(order)
  case PricingMode.Premium  => premiumPrice(order)
}
```

Scala — after (a function value, not a named trait, since pricing is a single stateless
computation — see `scala.md`):

```scala
def price(order: Order, pricing: Order => BigDecimal): BigDecimal = pricing(order)
```

### Template Method

**When it's worth it:** the same multi-step skeleton is copy-pasted across more than one
implementation, with only a couple of steps differing each time.

Java — before (the skeleton duplicated, with only `validate` differing):

```java
public final class XmlIngestJob {
    public void run() {
        RawBatch raw = fetchXml();
        ValidatedBatch validated = validateXml(raw);
        persist(validated);
    }
}
public final class JsonIngestJob {
    public void run() {
        RawBatch raw = fetchJson();
        ValidatedBatch validated = validateJson(raw);
        persist(validated);
    }
}
```

Java — after:

```java
public abstract class IngestJob {
    public final void run() {
        persist(validate(fetch()));
    }
    protected abstract RawBatch fetch();
    protected abstract ValidatedBatch validate(RawBatch raw);
    protected void persist(ValidatedBatch validated) { /* shared */ }
}
```

Scala — before: same duplication, one class per format.

Scala — after (function-parameter form, since only `fetch`/`validate` vary and there's no
meaningful per-format subclass identity beyond that):

```scala
def runIngest(fetch: () => RawBatch, validate: RawBatch => ValidatedBatch): Unit =
  persist(validate(fetch()))

runIngest(fetchXml, validateXml)
runIngest(fetchJson, validateJson)
```

### Observer

**When it's worth it:** more than one independent listener needs to react to the same event, and
that set of listeners is expected to change.

Java — before (the subject calls each interested party directly, coupling it to all of them):

```java
public void complete(JobResult result) {
    metricsService.recordCompletion(result);
    notificationService.notify(result);
    auditLog.record(result);
}
```

Java — after:

```java
public void complete(JobResult result) {
    listeners.forEach(listener -> listener.onCompleted(result));
}
// metricsService, notificationService, and auditLog are each registered as a JobCompletionListener
```

Scala — before/after follow the identical shape; the Scala-specific question to ask first is
whether these three reactions are already better modeled as subscribers to an existing event topic
rather than in-process listeners (see `scala.md`).

### Chain of Responsibility

**When it's worth it:** more than one validation/handling step exists, each independently
deciding to handle or pass on, and the set of applicable steps varies (e.g., by config).

Java — before (nested if/else, each condition also encoding "did a previous check already fail"):

```java
Optional<String> validate(RawInput input) {
    if (!hasRequiredFields(input)) return Optional.of("missing fields");
    if (!isValidFormat(input)) return Optional.of("bad format");
    if (!passesBusinessRules(input)) return Optional.of("business rule violation");
    return Optional.empty();
}
```

Java — after (a plain loop with early return — `Optional.stream()` needs Java 9+, so this is the
Java-8-safe form; see `java.md`'s note on the Java 9+ stream alternative):

```java
Optional<String> validate(RawInput input) {
    for (ValidationHandler handler : handlers) {
        Optional<String> result = handler.handle(input);
        if (result.isPresent()) return result;
    }
    return Optional.empty();
}
```

Scala — before:

```scala
def validate(input: RawInput): Option[String] =
  if (!hasRequiredFields(input)) Some("missing fields")
  else if (!isValidFormat(input)) Some("bad format")
  else if (!passesBusinessRules(input)) Some("business rule violation")
  else None
```

Scala — after (works on any Scala 2.11+/3 — see `scala.md`'s note on the 2.13+-only
`Iterator.nextOption()` alternative):

```scala
def validate(input: RawInput): Option[String] =
  handlers.view.flatMap(h => h(input)).headOption
```

Note both "after" forms are also just `functional-programming`'s validator-composition pattern —
naming it Chain of Responsibility doesn't change the code, only clarifies intent when discussing
the design.

### State

**When it's worth it:** the object has more than two or three states, and each state's behavior is
non-trivial enough that a status-field `switch` at the top of every method has become hard to
follow.

Java — before (status field checked at the top of every method):

```java
public void onPaymentReceived() {
    if (status == OrderStatus.PENDING) {
        status = OrderStatus.PAID;
    } else {
        throw new IllegalStateException("cannot pay from " + status);
    }
}
```

Java — after:

```java
public void onPaymentReceived() {
    this.state = state.onPaymentReceived(this);
}
// PendingState.onPaymentReceived returns new PaidState(); PaidState.onPaymentReceived returns `this`
```

Scala — before:

```scala
def onPaymentReceived(): OrderStatus = status match {
  case OrderStatus.Pending => OrderStatus.Paid
  case other               => throw new IllegalStateException(s"cannot pay from $other")
}
```

Scala — after:

```scala
def onPaymentReceived(): OrderState = state.onPaymentReceived(this)
// Pending().onPaymentReceived returns Paid(); Paid().onPaymentReceived returns itself
```

The Scala "before" is already a `sealed trait`-friendly `match` — the "after" is worth it only once
each state's *behavior* (not just its label) grows enough to want its own type, per `SKILL.md`'s
anti-pattern table.

### Visitor

**When it's worth it:** the set of *operations* over a fixed node hierarchy grows independently of
the node types, and needs to be added without modifying/recompiling those node classes.

Java — before (a growing `instanceof` cascade repeated for every new operation):

```java
Object eval(Expression expr) {
    if (expr instanceof Literal lit) return lit.value();
    if (expr instanceof BinaryOp op) return evalBinary(op);
    throw new IllegalStateException();
}
// a render(Expression) method needs its own separate instanceof cascade, and so does export(...)
```

Java — after:

```java
public interface ExpressionVisitor<R> {
    R visitLiteral(Literal literal);
    R visitBinaryOp(BinaryOp op);
}
int result = expr.accept(new EvalVisitor());
String rendered = expr.accept(new RenderVisitor());
```

Scala — before/after: in Scala, prefer collapsing this entirely into pattern matching over the
sealed hierarchy rather than implementing a real Visitor — see `scala.md`'s "Visitor → pattern
matching" section. Only reach for a Scala Visitor/typeclass-per-operation shape if the operations
must be defined outside the module owning the sealed trait.

### Command

**When it's worth it:** the request needs to be queued, retried, logged, or undone independently
of the code that created it. For a fire-once, no-undo call, invoke the method directly.

Java — before (the action happens immediately, with no way to defer/undo/queue it):

```java
distributionClient.send(request);
```

Java — after:

```java
Command command = new SubmitDistributionCommand(distributionClient, request);
commandQueue.enqueue(command); // executed, retried, or undone later
```

Scala — before:

```scala
distributionClient.send(request)
```

Scala — after (a function value is enough unless undo/inspection is required — see `scala.md`):

```scala
val command: () => Unit = () => distributionClient.send(request)
commandQueue.enqueue(command)

// if undo is required, a small case class carries both actions:
final case class SubmitDistributionCommand(client: DistributionClient, request: DistributionRequest) {
  def execute(): Unit = client.send(request)
  def undo(): Unit = client.cancel(request.id)
}
```
