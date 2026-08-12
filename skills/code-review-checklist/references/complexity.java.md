# Complexity examples: Java

Can a reader follow this method top to bottom in one breath? This file covers:
**method exceeding 25 lines or cyclomatic complexity > 5**, **nested conditionals
deeper than 2 levels**, **voodoo programming** (retries, barriers, sleeps with no comment
explaining why), and **hack upon hack** (a new workaround layered on an existing
workaround). Each example pairs a change the review should flag with the fix that
satisfies the checklist.

### 1. Long method with deep nesting

```java
// Anti-pattern: the method runs past 25 lines and nests if inside if inside for, so
// the reader must hold several branches in memory at once
List<String> process(List<Order> orders) {
    List<String> result = new ArrayList<>();
    for (Order order : orders) {
        if (order.isValid()) {
            for (Item item : order.items()) {
                if (item.isAvailable()) {
                    result.add(item.name());
                }
            }
        }
    }
    return result;
}

// Fix: flat filters and single-level steps keep each line obvious and the method under
// the size budget
List<String> process(List<Order> orders) {
    return orders.stream()
        .filter(Order::isValid)
        .flatMap(o -> o.items().stream())
        .filter(Item::isAvailable)
        .map(Item::name)
        .toList();
}
```

### 2. Voodoo programming: magic sleep with no explanation

```java
// Anti-pattern: a fixed sleep before the call has no comment, so the reader cannot tell
// whether it papers over a race, a warmup, or a mistake
Response callAfterWarmup() throws InterruptedException {
    Thread.sleep(1000); // why?
    return service.call();
}

// Fix: explain the reason in a comment, or remove the magic; if it hides a real race,
// fix the race instead
Response callAfterWarmup() throws InterruptedException {
    // The pool needs one beat to register the new worker; remove once the pool is fixed
    Thread.sleep(1000);
    return service.call();
}
```

### 3. Hack upon hack

```java
// Anti-pattern: each fix patches the previous patch instead of the source: a bad
// serialization format is trimmed, then null-checked, then double-parsed
int parse(String raw) {
    if (raw == null) return 0; // second workaround layered on the first
    return Integer.parseInt(raw.trim().replaceAll("\\s", ""));
}

// Fix: fix the root cause at the source, so the workarounds disappear
int parse(String raw) { return Integer.parseInt(raw); } // the writer now emits clean integers
```
