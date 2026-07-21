# YAGNI — Code Examples (Java)

### Violation — speculative abstraction

```java
public interface PaymentProcessor {
    void processPayment(Order order);
}

public class CreditCardProcessor implements PaymentProcessor {
    @Override
    public void processPayment(Order order) { /* ... */ }
}

public class PayPalProcessor implements PaymentProcessor {
    @Override
    public void processPayment(Order order) { /* ... */ }
}

public class ApplePayProcessor implements PaymentProcessor {
    @Override
    public void processPayment(Order order) { /* ... */ }
}
```

Three implementations. The system only accepts credit cards. The other two are guesses. All
that code compiles, tests, and rots.

### Following YAGNI

```java
public void processPayment(Order order) {
    // Only credit card in production. Add more when the contract is signed.
    throw new UnsupportedOperationException();
}
```

When PayPal gets added, refactor. The interface will emerge from the actual need, not from
speculation.

### Speculative parameter

```java
// Speculative parameter: always false in practice, no caller needs it
public List<Item> search(String query, boolean strictMode) {
    return strictMode ? strictSearch(query) : fuzzySearch(query);
}

// Following YAGNI: drop the flag until a caller actually needs strict mode
public List<Item> search(String query) { return fuzzySearch(query); }
```

### Unused extension hooks

```java
// Hooks "for subclasses later" — no subclass exists
public abstract class ReportGenerator {
    public Report generate() {
        Report r = build();
        beforeSave(r); // hook, never overridden
        save(r);
        afterSave(r); // hook, never overridden
        return r;
    }
    protected void beforeSave(Report r) { }
    protected void afterSave(Report r) { }
}

// Following YAGNI: no hooks until a second implementation needs one
public class ReportGenerator {
    public Report generate() { Report r = build(); save(r); return r; }
}
```
