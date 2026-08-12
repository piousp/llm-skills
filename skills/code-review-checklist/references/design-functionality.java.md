# Design & Functionality examples: Java

Does this change belong where it is, and does it do what the author intends? This file
covers: **abstraction-level mismatch** (generic code embedded in a specific module),
**new architectural pattern where the project has an established one**, **feature or
abstraction added before it's needed** (YAGNI), and **functionality that doesn't do what
the author intends** (edge cases, error paths, concurrency). Each example pairs a change
the review should flag with the fix that satisfies the checklist.

### 1. Generic code embedded in a specific module, added before needed

```java
// Anti-pattern: a generic slugify helper sits inside the controller with a single call
// site, so the class leaks generic concerns and the helper is unreusable
class UserController {
    String slugify(String s) { return s.trim().toLowerCase().replaceAll("\\s+", "-"); }
    String profileUrl(User user) { return "/users/" + slugify(user.name()); }
}

// Fix: inline the tiny logic at the call site; extract a shared util only when a second
// caller appears (YAGNI)
class UserController {
    String profileUrl(User user) {
        return "/users/" + user.name().trim().toLowerCase().replaceAll("\\s+", "-");
    }
}
```

### 2. New architectural pattern where the project has an established one

```java
// Anti-pattern: the codebase calls service methods directly, but this change wraps one
// operation in a Command object; the new pattern adds machinery with no payoff here
class CreateOrderHandler {
    void handle(CommandBus bus, Order order) {
        bus.handle(new CreateOrderCommand(order)); // why not just orderService.create(order)?
    }
}

// Fix: call the service method directly, matching the surrounding code
orderService.create(order);
```

### 3. Functionality that doesn't do what the author intends

```java
// Anti-pattern: the author intended to prevent negative balances, but the error path is
// missing: transfer lets the balance go negative
void transfer(Account from, Account to, BigDecimal amount) {
    from.balance = from.balance.subtract(amount); // can go negative
    to.balance = to.balance.add(amount);
}

// Fix: guard the edge case and return a typed result, so the intent is enforced and the
// caller sees the failure
TransferResult transfer(Account from, Account to, BigDecimal amount) {
    if (amount.compareTo(from.balance) > 0) return TransferResult.insufficientFunds(from.id());
    from.balance = from.balance.subtract(amount);
    to.balance = to.balance.add(amount);
    return TransferResult.ok();
}
```
