# Design & Functionality examples: Scala

Does this change belong where it is, and does it do what the author intends? This file
covers: **abstraction-level mismatch** (generic code embedded in a specific module),
**new architectural pattern where the project has an established one**, **feature or
abstraction added before it's needed** (YAGNI), and **functionality that doesn't do what
the author intends** (edge cases, error paths, concurrency). Each example pairs a change
the review should flag with the fix that satisfies the checklist.

### 1. Generic code embedded in a specific module, added before needed

```scala
// Anti-pattern: a generic slugify helper sits inside UserService with a single call
// site, so the module leaks generic concerns and the helper is unreusable
object UserService {
  def slugify(s: String): String = s.trim.toLowerCase.replaceAll("\\s+", "-")
  def profileUrl(user: User): String = s"/users/${slugify(user.name)}"
}

// Fix: inline the tiny logic at the call site; extract a shared util only when a second
// caller appears (YAGNI)
object UserService {
  def profileUrl(user: User): String =
    s"/users/${user.name.trim.toLowerCase.replaceAll("\\s+", "-")}"
}
```

### 2. New architectural pattern where the project has an established one

```scala
// Anti-pattern: the codebase calls service functions directly, but this change wraps
// one operation in a command bus; the new pattern adds machinery with no payoff here
class CreateOrderHandler(bus: CommandBus, order: Order) {
  bus.handle(CreateOrderCommand(order)) // why not just orderService.create(order)?
}

// Fix: call the service function directly, matching the surrounding code
orderService.create(order)
```

### 3. Functionality that doesn't do what the author intends

```scala
// Anti-pattern: the author intended to prevent negative balances, but the error path is
// missing: transfer lets the balance go negative
def transfer(from: Account, to: Account, amount: BigDecimal): Unit = {
  from.balance -= amount // can go negative
  to.balance += amount
}

// Fix: guard the edge case and return a typed result, so the intent is enforced and the
// caller sees the failure
def transfer(from: Account, to: Account, amount: BigDecimal): Either[TransferError, Unit] =
  if (amount > from.balance) Left(InsufficientFunds(from.id))
  else {
    from.balance -= amount
    to.balance += amount
    Right(())
  }
```
