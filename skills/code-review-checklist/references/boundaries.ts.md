# Boundaries examples: TypeScript / JavaScript

Where does this code live, and what does it touch? This file covers: **business logic in
controller/handler/entry point**, **side effects mixed with pure computation**,
**implicit dependency instead of explicit injection**, **brain-damaged API** (interface
shape that makes the common case awkward to call), and **object orgy** (a caller reaching
through an object's internals). Each example pairs a change the review should flag with
the fix that satisfies the checklist.

### 1. Business logic in the entry point, reaching through internals

```typescript
// Anti-pattern: the handler parses, validates, computes and persists, and it reaches
// through order.customer.address.city to pull a city
function handle(req: Request): Response {
  const city = order.customer.address.city; // object orgy
  const discount = city === "San Jose" ? 0.1 : 0; // business rule in the handler
  saveOrder(order, discount);
  return { status: 200 };
}

// Fix: the handler delegates to a service function and asks the object for the answer,
// so the entry point stays thin
function handle(req: Request): Response {
  orderService.create(req.order); // thin entry point
  return { status: 200 };
}
```

### 2. Implicit dependency instead of explicit injection

```typescript
// Anti-pattern: the function pulls its dependencies from a global, so the caller cannot
// see what it needs and tests cannot substitute a fake
function createOrder(order: Order): void {
  Database.getInstance().save(order); // hidden dependency
}

// Fix: take the dependency as a parameter, so the caller sees it and tests inject a fake
function createOrder(order: Order, db: Database): void {
  db.save(order);
}
```

### 3. Side effects mixed with pure computation

```typescript
// Anti-pattern: computeTotal logs and persists while computing, so the caller cannot
// reuse the math without repeating the effects
function computeTotal(items: Item[]): number {
  const total = items.reduce((acc, i) => acc + i.price, 0);
  logger.info(`total: ${total}`); // side effect inside the computation
  saveTotal(total);               // side effect inside the computation
  return total;
}

// Fix: the pure function returns the value; the caller decides when to log or persist
function computeTotal(items: Item[]): number {
  return items.reduce((acc, i) => acc + i.price, 0);
}
```

### 4. Brain-damaged API: common case awkward to call

```typescript
// Anti-pattern: the common case needs eight arguments, so every call site repeats the
// same defaults and a wrong retry value slips in
function sendEmail(from: string, to: string, subject: string, body: string,
                   retries: number, cc: string[], bcc: string[], timeout: number): void { /* ... */ }

// Fix: focused signature with defaults, so the common case is one obvious call and the
// knobs stay available
function sendEmail(to: string, subject: string, body: string,
                   options: EmailOptions = {}): void { /* ... */ }
```
