# Boundaries examples: Java

Where does this code live, and what does it touch? This file covers: **business logic in
controller/handler/entry point**, **side effects mixed with pure computation**,
**implicit dependency instead of explicit injection**, **brain-damaged API** (interface
shape that makes the common case awkward to call), and **object orgy** (a caller reaching
through an object's internals). Each example pairs a change the review should flag with
the fix that satisfies the checklist.

### 1. Business logic in the entry point, reaching through internals

```java
// Anti-pattern: the controller parses, validates, computes and persists, and it reaches
// through order.getCustomer().getAddress().getCity() to pull a city
Response handle(Request req) {
    String city = order.getCustomer().getAddress().getCity(); // object orgy
    double discount = city.equals("San Jose") ? 0.1 : 0.0;    // business rule in the handler
    saveOrder(order, discount);
    return new Response(200);
}

// Fix: the controller delegates to a service method and asks the object for the answer,
// so the entry point stays thin
Response handle(Request req) {
    orderService.create(req.order()); // thin entry point
    return new Response(200);
}
```

### 2. Implicit dependency instead of explicit injection

```java
// Anti-pattern: the method pulls its dependencies from a global, so the caller cannot
// see what it needs and tests cannot substitute a fake
void createOrder(Order order) {
    Database.getInstance().save(order); // hidden dependency
}

// Fix: take the dependency as a parameter, so the caller sees it and tests inject a fake
void createOrder(Order order, Database db) {
    db.save(order);
}
```

### 3. Side effects mixed with pure computation

```java
// Anti-pattern: computeTotal logs and persists while computing, so the caller cannot
// reuse the math without repeating the effects
BigDecimal computeTotal(List<Item> items) {
    BigDecimal total = items.stream().map(Item::price)
        .reduce(BigDecimal.ZERO, BigDecimal::add);
    logger.info("total: " + total); // side effect inside the computation
    saveTotal(total);               // side effect inside the computation
    return total;
}

// Fix: the pure method returns the value; the caller decides when to log or persist
BigDecimal computeTotal(List<Item> items) {
    return items.stream().map(Item::price)
        .reduce(BigDecimal.ZERO, BigDecimal::add);
}
```

### 4. Brain-damaged API: common case awkward to call

```java
// Anti-pattern: the common case needs eight arguments, so every call site repeats the
// same defaults and a wrong retry value slips in
void sendEmail(String from, String to, String subject, String body,
               int retries, List<String> cc, List<String> bcc, long timeout) { /* ... */ }

// Fix: focused overloads, so the common case is one obvious call and the knobs stay
// available
void sendEmail(String to, String subject, String body) { /* ... */ }
void sendEmail(String to, String subject, String body, EmailOptions options) { /* ... */ }
```
