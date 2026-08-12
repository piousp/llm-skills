# Data Shape examples: TypeScript / JavaScript

Could this conditional disappear if the data had a better shape? This file covers:
**boolean parameter that selects between two behaviors**, **conditionals that could be
eliminated by fixing the data structure**, **inheritance where composition suffices**,
and **special-case insanity**. Each example pairs a change the review should flag with
the fix that satisfies the checklist.

### 1. Boolean parameter that selects between two behaviors

```typescript
// Anti-pattern: verbose is a flag that branches inside, so every call site must read
// the body to know what it does and new modes grow the flag list
function buildLabel(user: User, verbose: boolean): string {
  return verbose ? `${user.name} <${user.email}>` : user.name;
}

// Fix: two functions, one behavior each, so the call site names what it wants
function buildLabel(user: User): string { return user.name; }
function buildVerboseLabel(user: User): string { return `${user.name} <${user.email}>`; }
```

### 2. Conditionals patching a data model that should encode the case

```typescript
// Anti-pattern: the status is a string, so every check duplicates the same branch pile
// and a new status must be added in N places
function summary(order: Order): string {
  if (order.status === "paid" && !order.discountCode) return "paid in full";
  if (order.status === "paid") return "paid with discount";
  return "pending";
}

// Fix: encode the state in the type, so a switch collapses the pile and the compiler
// checks every case
type OrderStatus =
  | { kind: "pending" }
  | { kind: "paid"; discountCode?: string };

function summary(status: OrderStatus): string {
  switch (status.kind) {
    case "paid":
      return status.discountCode ? "paid with discount" : "paid in full";
    case "pending":
      return "pending";
  }
}
```

### 3. Inheritance where composition suffices

```typescript
// Anti-pattern: Penguin inherits fly() it cannot honor, so callers can invoke a
// behavior that throws; the hierarchy lies about its capabilities
class Penguin extends Bird {
  override fly(): void {
    throw new Error("penguins don't fly");
  }
}

// Fix: separate the capability and compose it, so only real flyers expose fly()
interface Flies {
  fly(): void;
}
class Sparrow extends Bird implements Flies {
  fly(): void {
    /* ... */
  }
}
// Penguin extends Bird without Flies
```
