# SOLID — Code Examples (Java)

### S — Single Responsibility: Shipping calculator

```java
// Two reasons to change: shipping rules AND logging
public class ShippingCalculator {
    public double calculate(Order order) { /* ... */ }
    public void logCalculation(Order order) { /* ... */ }
}

// Better
public class ShippingCalculator {
    public double calculate(Order order) { /* ... */ }
}
public class CalculationLogger {
    public void log(Order order, double cost) { /* ... */ }
}
```

### O — Open/Closed: Payment processing

```java
// Violation: modify every time a new type appears
public double calculate(Order o, String type) {
    if ("credit".equals(type)) { /* ... */ }
    else if ("paypal".equals(type)) { /* ... */ } // add else for each
}

// Better: extend via strategy
interface ShippingStrategy { double calculate(Order o); }
class CreditShipping implements ShippingStrategy { }
class PayPalShipping implements ShippingStrategy { }
```

### L — Liskov Substitution: Bird hierarchy

```java
// Violation: Ostrich extends Bird with fly() but can't fly
class Bird { void fly() { /* ... */ } }
class Ostrich extends Bird {
    @Override void fly() { throw new UnsupportedOperationException(); }
}

// Better: model the capability, not the bird
interface Flyable { void fly(); }
class Sparrow extends Bird implements Flyable { public void fly() { /* ... */ } }
class Ostrich extends Bird { } // no fly
```

### I — Interface Segregation: Document processing

```java
// Violation: fat interface
interface DocumentHandler { void read(); void write(); void print(); }

// Better: segregated
interface DocumentReader { void read(); }
interface DocumentWriter { void write(); }
interface DocumentPrinter { void print(); }
```

### D — Dependency Inversion: Database access

```java
// Violation: depends on concrete
class UserService {
    private final MySQLDatabase db = new MySQLDatabase();
}

// Better: depends on abstraction
interface Database { ResultSet query(String sql); }
class UserService {
    private final Database db;
    UserService(Database db) { this.db = db; }
}
```

### Anti-example: DI for a single implementation that will never be swapped

```java
interface StringUpperCaser { String upper(String s); }
class JdkStringUpperCaser implements StringUpperCaser {
    public String upper(String s) { return s.toUpperCase(); }
}
class LabelFormatter {
    private final StringUpperCaser caser;
    LabelFormatter(StringUpperCaser caser) { this.caser = caser; } // indirection, no real swap point
}

// Better: call the stdlib method directly
class LabelFormatter {
    String format(String s) { return s.toUpperCase(); }
}
```

Dependency injection for an interface with one implementation and no test-swap need is
indirection, not architecture.
