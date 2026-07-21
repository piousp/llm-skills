# FP — Code Examples (Java)

### Imperative, hides the failure path

```java
public User findUser(String id) {
    User u = repository.get(id);
    if (u == null) {
        throw new UserNotFoundException(id);
    }
    return u;
}
```

### Typed failure, composable

```java
public Optional<User> findUser(String id) {
    return repository.get(id);
}
```

The caller decides how to handle absence — `.orElseThrow()`, `.map()`, a default — instead of
being forced into a try/catch for an expected outcome.

### Observable mutation vs. local mutation

```java
// Problem: mutation observable outside the method's scope
public class OrderTotals {
    private double total; // shared, mutable state
    public void add(double amount) { total += amount; } // callers race on this
}

// Fine: mutation contained inside the function, dies with the stack frame
public double sumTotals(List<Order> orders) {
    double total = 0;
    for (Order o : orders) { total += o.getAmount(); }
    return total;
}
```

Same `+=` habit, different scope. The field is a chapter of hidden state; the local variable
is never observed outside this call.

### Composition replacing a nested-conditional mess

```java
// Nested conditionals
List<String> names = new ArrayList<>();
for (Customer c : customers) {
    if (c.isActive()) {
        if (c.getBalance() > 0) {
            names.add(c.getName().toUpperCase());
        }
    }
}

// Composition
List<String> names = customers.stream()
    .filter(Customer::isActive)
    .filter(c -> c.getBalance() > 0)
    .map(c -> c.getName().toUpperCase())
    .collect(toList());
```

Worth it here: three real steps (filter, filter, map). A single filter-then-map wouldn't earn
a stream chain over a plain loop — see FP.md's `FP vs KISS` note.

### Typed failure for a multi-step expected outcome

```java
public Optional<Discount> resolveDiscount(Customer customer, Order order) {
    return findLoyaltyTier(customer)
        .flatMap(tier -> findDiscountFor(tier, order));
}
```

Either step can come up empty; `flatMap` propagates that without a chain of null-checks or a
thrown exception per step.
