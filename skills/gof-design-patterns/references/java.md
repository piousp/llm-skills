# Java Pattern Mechanics

Idiom-level guidance for applying the 12 patterns in `SKILL.md` to Java code. For worked
before/after examples, see `patterns.md`.

**Version gate first.** Several patterns below have a lighter-weight Java 17+ form using `record`
and `sealed interface`. In a multi-repo codebase, Java version commonly varies repo-by-repo — some
services may already be on Java 17, others still on Java 8 or 11. Check the target repo's
`pom.xml` `java.version`/`maven.compiler.release` before picking a form — this is the existing
build-aware-codegen rule applied to pattern implementation specifically. Java's `switch` pattern
matching over sealed types is a preview feature through Java 21, not a stable baseline unless the
target repo has confirmed otherwise — don't rely on it; `instanceof` pattern matching (stable since
Java 16) is the safe form where a sealed hierarchy is otherwise available.

**Contents:** Creational (Factory Method, Builder) · Structural (Adapter, Decorator, Composite) ·
Behavioral (Strategy, Template Method, Observer, Chain of Responsibility, State, Visitor, Command).

## Creational

### Factory Method

A method (often `static`, sometimes an instance method on a small factory class) that returns an
instance of an interface/abstract type, hiding which concrete subclass gets constructed:

```java
public interface Parser {
    Document parse(String raw);
}

public final class ParserFactory {
    public static Parser forFormat(Format format) {
        switch (format) {
            case XML: return new XmlParser();
            case JSON: return new JsonParser();
            default: throw new IllegalArgumentException("unsupported format: " + format);
        }
    }
}
```

The classic `switch` statement above compiles on every Java version in these repos (8 through 17).
On a repo confirmed to be Java 14+, the arrow-form `switch` expression (`return switch (format) {
case XML -> new XmlParser(); ... }`) is equivalent and removes the fall-through risk and the
`default` clause — but check the version first, per the gate at the top of this file.

Keep the factory a plain method, not a class hierarchy of factories — that step up is Abstract
Factory, which is out of scope (see `SKILL.md`'s Boundaries) unless whole families of related
objects genuinely need to vary together.

### Builder

Use a nested `static` builder class (or, for one that must validate before construction, a
`build()` that returns a `Result`/throws on invalid combinations — see `functional-programming`'s
typed-error-handling section for the former):

```java
public final class RetryPolicy {
    private final int maxAttempts;
    private final Duration backoff;

    private RetryPolicy(Builder b) {
        this.maxAttempts = b.maxAttempts;
        this.backoff = b.backoff;
    }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private int maxAttempts = 3;
        private Duration backoff = Duration.ofSeconds(1);

        public Builder maxAttempts(int v) { this.maxAttempts = v; return this; }
        public Builder backoff(Duration v) { this.backoff = v; return this; }
        public RetryPolicy build() { return new RetryPolicy(this); }
    }
}
```

On Java 17+, if the object is a plain immutable data carrier with no conditional
assembly/validation logic, a `record` with a compact canonical constructor for validation is
simpler than a Builder — check the anti-pattern table in `SKILL.md` ("2-3 required parameters, no
optional/conditional logic") before reaching for the Builder form at all.

## Structural

### Adapter

A thin class implementing the interface your code expects, wrapping the incompatible one:

```java
public interface DistributionClient {
    void send(DistributionRequest request);
}

public final class LegacyDistributionAdapter implements DistributionClient {
    private final LegacySoapClient legacy;

    public LegacyDistributionAdapter(LegacySoapClient legacy) { this.legacy = legacy; }

    @Override
    public void send(DistributionRequest request) {
        legacy.submitJob(toLegacyPayload(request));
    }
}
```

Keep the translation logic entirely inside the adapter — the moment a call site starts doing its
own partial translation on top of the adapter, the adapter isn't covering the full mismatch.

### Decorator

Same interface, wraps an instance of that interface, adds behavior before/after delegating:

```java
public final class LoggingDistributionClient implements DistributionClient {
    private final DistributionClient delegate;

    public LoggingDistributionClient(DistributionClient delegate) { this.delegate = delegate; }

    @Override
    public void send(DistributionRequest request) {
        log.info("sending {}", request.id());
        delegate.send(request);
    }
}
```

Layers compose by construction: `new LoggingDistributionClient(new RetryingDistributionClient(base))`.
If you only ever need one fixed layer, a plain wrapper method is equally clear and skips the
interface ceremony — see `SKILL.md`'s anti-pattern table.

### Composite

Leaf and composite share one interface; the composite delegates the operation to its children:

```java
public interface FilterNode {
    boolean matches(Event event);
}

public final class AndNode implements FilterNode {
    private final List<FilterNode> children;

    public AndNode(List<FilterNode> children) { this.children = children; }

    @Override
    public boolean matches(Event event) {
        return children.stream().allMatch(child -> child.matches(event));
    }
}
```

Client code calls `.matches()` on any `FilterNode` without checking whether it's a leaf or a
group — that uniformity is the entire point.

## Behavioral

### Strategy

A functional interface (or `java.util.function.Function`/`BiFunction` directly) parameterizing the
varying behavior:

```java
public interface PricingStrategy {
    BigDecimal price(Order order);
}

public final class OrderProcessor {
    private final PricingStrategy pricing;

    public OrderProcessor(PricingStrategy pricing) { this.pricing = pricing; }

    public BigDecimal total(Order order) { return pricing.price(order); }
}
```

If the "strategy" is a single pure function with no state, skip the named interface and take a
`Function<Order, BigDecimal>` parameter directly, or even a method reference — a dedicated
interface is only worth it when the strategy needs more than one method or carries its own state.

### Template Method

An `abstract` class fixes the algorithm's skeleton; subclasses override only the varying steps:

```java
public abstract class IngestJob {
    public final void run() {
        RawBatch raw = fetch();
        ValidatedBatch validated = validate(raw);
        persist(validated);
    }

    protected abstract RawBatch fetch();
    protected abstract ValidatedBatch validate(RawBatch raw);
    protected abstract void persist(ValidatedBatch validated);
}
```

(Explicit types here, not `var` — local-variable type inference needs Java 10+; many repos in this
codebase are still on Java 8, per the gate at the top of this file.)

`run()` is `final` on purpose — the skeleton is the part that must not vary; only the abstract
steps are extension points. If subclasses need to override the skeleton itself, Template Method is
the wrong pattern (that's closer to plain polymorphism/Strategy).

### Observer

Register listeners against a functional interface; notify them without the subject knowing what
each listener does:

```java
public interface JobCompletionListener {
    void onCompleted(JobResult result);
}

public final class Job {
    private final List<JobCompletionListener> listeners = new ArrayList<>();

    public void addListener(JobCompletionListener listener) { listeners.add(listener); }

    private void complete(JobResult result) {
        listeners.forEach(l -> l.onCompleted(result));
    }
}
```

If the underlying transport is already a message broker/event bus (check whether a queue/topic
already carries this event elsewhere in the codebase), publishing to it is the actual
integration point — don't build an in-process Observer on top of an already-decoupled pub/sub path.

### Chain of Responsibility

Each handler decides to handle or delegate to the next; the chain is built as a list, not
hardcoded nesting:

```java
public interface ValidationHandler {
    Optional<String> handle(RawInput input);
}

public final class ValidationChain {
    private final List<ValidationHandler> handlers;

    public ValidationChain(List<ValidationHandler> handlers) { this.handlers = handlers; }

    public Optional<String> validate(RawInput input) {
        for (ValidationHandler handler : handlers) {
            Optional<String> result = handler.handle(input);
            if (result.isPresent()) return result;
        }
        return Optional.empty();
    }
}
```

(A plain loop with early return, not `handlers.stream().flatMap(h -> h.handle(input).stream())` —
`Optional.stream()` needs Java 9+, and many repos in this codebase are still on Java 8, per the
gate at the top of this file. On a confirmed Java 9+ repo, the stream form is equivalent and
arguably reads more declaratively.)

Note this is also exactly `functional-programming`'s "composition of small validators" case — for
a chain that stops at the first failure, decide there whether you need the full Chain of
Responsibility object structure or whether a `Stream`/`Optional` pipeline like the one above is
already the whole answer (it usually is, in Java, once you strip the pattern down to its essence).

### State

An interface per state, held as a field on the context and swapped on transition:

```java
public interface OrderState {
    OrderState onPaymentReceived(Order order);
    boolean isFinal();
}

public final class PendingState implements OrderState {
    @Override
    public OrderState onPaymentReceived(Order order) { return new PaidState(); }

    @Override
    public boolean isFinal() { return false; }
}
```

The `Order` context holds an `OrderState` field and delegates; the state object returned by the
transition method *is* the new current state, so the transition logic lives in exactly one place
per state rather than in a big `switch` on a status enum scattered across the class.

### Visitor

Double dispatch via an `accept`/`visit` pair, used when new *operations* over a fixed set of node
types need to be added without touching the node classes:

```java
public interface ExpressionVisitor<R> {
    R visitLiteral(Literal literal);
    R visitBinaryOp(BinaryOp op);
}

public interface Expression {
    <R> R accept(ExpressionVisitor<R> visitor);
}

public final class Literal implements Expression {
    @Override
    public <R> R accept(ExpressionVisitor<R> visitor) { return visitor.visitLiteral(this); }
}
```

This is the one pattern where Java 17+'s `sealed interface` + `instanceof` pattern matching starts
to close the gap with Scala's `match` (see `scala.md`) — for a small, stable node set, a
`switch`/chained-`instanceof` dispatch method in one place can replace the full Visitor
double-dispatch machinery. Reach for the real Visitor structure when the *set of operations* grows
independently and needs to be added without recompiling the node classes; for a fixed, small node
set with a handful of operations, the simpler dispatch method is enough.

### Command

A functional interface (or `Runnable`/`Callable`) representing a deferred/queueable/undoable
action:

```java
public interface Command {
    void execute();
    void undo();
}

public final class SubmitDistributionCommand implements Command {
    private final DistributionClient client;
    private final DistributionRequest request;

    public SubmitDistributionCommand(DistributionClient client, DistributionRequest request) {
        this.client = client;
        this.request = request;
    }

    @Override
    public void execute() { client.send(request); }

    @Override
    public void undo() { client.cancel(request.id()); }
}
```

If there's no undo/queue/retry requirement — the action just needs to happen once, right now — a
direct method call is simpler than wrapping it in a Command object; the pattern earns its cost only
when the request needs to outlive the call that created it.
