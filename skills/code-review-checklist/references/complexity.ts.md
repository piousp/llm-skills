# Complexity examples: TypeScript / JavaScript

Can a reader follow this function top to bottom in one breath? This file covers:
**function exceeding 25 lines or cyclomatic complexity > 5**, **nested conditionals
deeper than 2 levels**, **voodoo programming** (retries, barriers, sleeps with no comment
explaining why), and **hack upon hack** (a new workaround layered on an existing
workaround). Each example pairs a change the review should flag with the fix that
satisfies the checklist.

### 1. Long function with deep nesting

```typescript
// Anti-pattern: the function runs past 25 lines and nests if inside if inside forEach,
// so the reader must hold several branches in memory at once
function process(orders: Order[]): string[] {
  const result: string[] = [];
  for (const order of orders) {
    if (order.isValid) {
      for (const item of order.items) {
        if (item.isAvailable) {
          result.push(item.name);
        }
      }
    }
  }
  return result;
}

// Fix: flat filters and single-level steps keep each line obvious and the function
// under the size budget
function process(orders: Order[]): string[] {
  return orders
    .filter((o) => o.isValid)
    .flatMap((o) => o.items)
    .filter((i) => i.isAvailable)
    .map((i) => i.name);
}
```

### 2. Voodoo programming: magic timeout with no explanation

```typescript
// Anti-pattern: a fixed timeout before the call has no comment, so the reader cannot
// tell whether it papers over a race, a warmup, or a mistake
async function callAfterWarmup(): Promise<Response> {
  await new Promise((r) => setTimeout(r, 1000)); // why?
  return service.call();
}

// Fix: explain the reason in a comment, or remove the magic; if it hides a real race,
// fix the race instead
async function callAfterWarmup(): Promise<Response> {
  // The pool needs one beat to register the new worker; remove once the pool is fixed
  await new Promise((r) => setTimeout(r, 1000));
  return service.call();
}
```

### 3. Hack upon hack

```typescript
// Anti-pattern: each fix patches the previous patch instead of the source: a bad
// serialization format is trimmed, then double-parsed
function parse(raw: string): number {
  return parseInt(raw.trim().replace(/\s/g, ""), 10) || 0; // second workaround layered on the first
}

// Fix: fix the root cause at the source, so the workarounds disappear
function parse(raw: string): number {
  return parseInt(raw, 10); // the writer now emits clean integers
}
```
