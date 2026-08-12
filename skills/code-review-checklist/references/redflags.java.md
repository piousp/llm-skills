# Red Flags examples: Java

Run this code twice. Does it always do the same thing? These two blockers fail the
review outright: **non-deterministic code** (uncontrolled randomness, race conditions)
and **hidden mutable shared state added**. Test-side flakiness is covered by
`concurrency.*`. Each example pairs a change the review should flag with the fix that
satisfies the checklist.

### 1. Uncontrolled randomness in business logic

```java
// Anti-pattern: Math.random() makes the fee depend on execution state, so the result
// is unreproducible and untestable
double fee(double base) {
    return base * (0.9 + Math.random() * 0.2);
}

// Fix: inject the random source as a parameter, so tests become deterministic and the
// caller decides when randomness is acceptable
double fee(double base, Random random) {
    return base * (0.9 + random.nextDouble() * 0.2);
}
```

### 2. Hidden mutable shared state

```java
// Anti-pattern: a static list is mutated in place from anywhere in the process, so
// concurrent callers race on it and tests leak state between runs
private static final List<Order> pending = new ArrayList<>();

// Fix: own the state in one instance and inject it, so each caller and each test gets
// an isolated collection with a predictable lifetime
final class OrderQueue {
    private final List<Order> pending = new ArrayList<>();
}
```
