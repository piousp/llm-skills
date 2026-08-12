# Data Shape examples: Java

Could this conditional disappear if the data had a better shape? This file covers:
**boolean parameter that selects between two behaviors**, **conditionals that could be
eliminated by fixing the data structure**, **inheritance where composition suffices**,
and **special-case insanity**. Each example pairs a change the review should flag with
the fix that satisfies the checklist.

### 1. Boolean parameter that selects between two behaviors

```java
// Anti-pattern: verbose is a flag that branches inside, so every call site must read
// the body to know what it does and new modes grow the flag list
String buildLabel(User user, boolean verbose) {
    return verbose ? user.name() + " <" + user.email() + ">" : user.name();
}

// Fix: two methods, one behavior each, so the call site names what it wants
String buildLabel(User user) { return user.name(); }
String buildVerboseLabel(User user) { return user.name() + " <" + user.email() + ">"; }
```

### 2. Conditionals patching a data model that should encode the case

```java
// Anti-pattern: the status is a string, so every check duplicates the same branch pile
// and a new status must be added in N places
String summary(Order order) {
    if ("paid".equals(order.status()) && order.discountCode() == null) return "paid in full";
    if ("paid".equals(order.status())) return "paid with discount";
    return "pending";
}

// Fix: encode the state in the type, so a switch collapses the pile and the compiler
// checks every case
sealed interface OrderStatus {}
record Paid(String discountCode) implements OrderStatus {}
record Pending() implements OrderStatus {}

String summary(OrderStatus status) {
    return switch (status) {
        case Paid p when p.discountCode() == null -> "paid in full";
        case Paid p -> "paid with discount";
        case Pending p -> "pending";
    };
}
```

### 3. Inheritance where composition suffices

```java
// Anti-pattern: Penguin inherits fly() it cannot honor, so callers can invoke a
// behavior that throws; the hierarchy lies about its capabilities
class Penguin extends Bird {
    @Override
    void fly() { throw new UnsupportedOperationException("penguins don't fly"); }
}

// Fix: separate the capability and compose it, so only real flyers expose fly()
interface Flies { void fly(); }
class Sparrow extends Bird implements Flies {
    @Override public void fly() { /* ... */ }
}
// Penguin extends Bird without Flies
```
