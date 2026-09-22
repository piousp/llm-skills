# KISS - Code Examples (Java)

### Over-engineered

```java
public class ResponseParser {
    public ParsedResponse parse(String raw) {
        try {
            ObjectMapper mapper = new ObjectMapper();
            JsonNode root = mapper.readTree(raw);
            if (root == null || !root.isObject()) {
                return ParsedResponse.failure("invalid structure");
            }
            // ... 30 more lines of validation
            return ParsedResponse.success(root);
        } catch (JsonProcessingException e) {
            logger.error("Failed to parse: {}", raw, e);
            return ParsedResponse.failure("parse error");
        }
    }
}
```

### Keep it simple

```java
public Optional<JsonNode> parseResponse(String raw) {
    try {
        return Optional.of(new ObjectMapper().readTree(raw));
    } catch (JsonProcessingException e) {
        return Optional.empty();
    }
}
```

Same job. No ceremony. Add validation when the *caller* needs it, not preemptively.

### Nested calls vs. flat early-return

```java
// Nested call chain hides the actual control flow
public Response handle(Request req) {
    return validate(req) ? process(prepare(req)) : reject(req);
}
private Response process(Request req) { return authorize(req) ? execute(req) : deny(req); }

// Flat, early-return - the control flow is visible at the top level
public Response handle(Request req) {
    if (!validate(req)) return reject(req);
    if (!authorize(req)) return deny(req);
    return execute(req);
}
```

### Orchestrator returns the result, not the instructions

```java
// The callee returns a flag; the caller re-applies the rule against shared state
Outcome classify(List<Item> items) { return new Outcome(true); }

List<Item> select(List<Item> items) {
    Outcome outcome = classify(items);
    return items.stream()
        .filter(item -> !(outcome.dropLowPriority && item.priority() == Priority.LOW))
        .toList();
}

// The callee returns the decided value; the orchestrator only sequences
List<Item> classify(List<Item> items) {
    return items.stream().filter(item -> item.priority() != Priority.LOW).toList();
}

List<Item> select(List<Item> items) { return classify(items); }
```

### Fix the data shape, kill the conditionals

```java
// Special cases piling up as conditionals
double fee(String accountType) {
    if (accountType.equals("BASIC")) return 5.0;
    if (accountType.equals("PREMIUM")) return 2.0;
    if (accountType.equals("VIP")) return 0.0;
    throw new IllegalArgumentException();
}

// Fix the shape: the fee belongs on the type, not in a lookup chain
enum AccountType {
    BASIC(5.0), PREMIUM(2.0), VIP(0.0);
    final double fee;
    AccountType(double fee) { this.fee = fee; }
}
double fee(AccountType accountType) { return accountType.fee; }
```


← Back to [KISS.md](../references/principles/KISS.md)
