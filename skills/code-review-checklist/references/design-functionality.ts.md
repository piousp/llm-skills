# Design & Functionality examples: TypeScript / JavaScript

Does this change belong where it is, and does it do what the author intends? This file
covers: **abstraction-level mismatch** (generic code embedded in a specific module),
**new architectural pattern where the project has an established one**, **feature or
abstraction added before it's needed** (YAGNI), and **functionality that doesn't do what
the author intends** (edge cases, error paths, concurrency). Each example pairs a change
the review should flag with the fix that satisfies the checklist.

### 1. Generic code embedded in a specific module, added before needed

```typescript
// Anti-pattern: a generic slugify helper sits in a component file with a single call
// site, so the module leaks generic concerns and the helper is unreusable
function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "-");
}
function profileUrl(user: User): string {
  return `/users/${slugify(user.name)}`;
}

// Fix: inline the tiny logic at the call site; extract a shared util only when a second
// caller appears (YAGNI)
function profileUrl(user: User): string {
  return `/users/${user.name.trim().toLowerCase().replace(/\s+/g, "-")}`;
}
```

### 2. New architectural pattern where the project has an established one

```typescript
// Anti-pattern: the codebase calls service functions directly, but this change wraps
// one operation in an event emitter; the new pattern adds machinery with no payoff here
class CreateOrderHandler {
  constructor(private readonly bus: CommandBus) {}
  handle(order: Order): void {
    this.bus.handle(new CreateOrderCommand(order)); // why not just orderService.create(order)?
  }
}

// Fix: call the service function directly, matching the surrounding code
orderService.create(order);
```

### 3. Functionality that doesn't do what the author intends

```typescript
// Anti-pattern: the author intended to prevent negative balances, but the error path is
// missing: transfer lets the balance go negative
function transfer(from: Account, to: Account, amount: number): void {
  from.balance -= amount; // can go negative
  to.balance += amount;
}

// Fix: guard the edge case and return a typed result, so the intent is enforced and the
// caller sees the failure
type TransferResult = { ok: true } | { ok: false; reason: "insufficient-funds" };
function transfer(from: Account, to: Account, amount: number): TransferResult {
  if (amount > from.balance) return { ok: false, reason: "insufficient-funds" };
  from.balance -= amount;
  to.balance += amount;
  return { ok: true };
}
```
