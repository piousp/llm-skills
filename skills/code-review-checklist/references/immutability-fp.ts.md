# Immutability & FP examples: TypeScript / JavaScript

Is this state necessary, and does the error live where the caller can see it? This file
covers: **mutable variable where `const` works**, **function that modifies its input
arguments**, and **exception thrown for a domain error that should be in the return
type**. Each example pairs a change the review should flag with the fix that satisfies
the checklist.

### 1. Mutable variable where const works

```typescript
// Anti-pattern: the let is never reassigned, so the mutability is pure cost: readers
// must check every line for a hidden reassignment
function total(items: Item[]): number {
  let sum = 0;
  for (const i of items) sum += i.price;
  return sum;
}

// Fix: const makes the binding permanent, and the compiler now rejects accidental
// reassignment
function total(items: Item[]): number {
  return items.reduce((acc, i) => acc + i.price, 0);
}
```

### 2. Function modifies its input arguments

```typescript
// Anti-pattern: sort() mutates the caller's array, so the caller loses its data order
// and the function has a hidden side effect
function topN(xs: number[], n: number): number[] {
  xs.sort((a, b) => a - b); // mutates the caller's array
  return xs.slice(0, n);
}

// Fix: return a new value, so the caller keeps its array intact and the function stays pure
function topN(xs: number[], n: number): number[] {
  return [...xs].sort((a, b) => a - b).slice(0, n);
}
```

### 3. Exception for a domain error that belongs in the return type

```typescript
// Anti-pattern: a lookup failure throws, so the caller must remember to catch and the
// compiler cannot prove the error path is handled
function findUser(id: number): User {
  const user = users.find((u) => u.id === id);
  if (!user) throw new UserNotFound(id);
  return user;
}

// Fix: the error lives in the return type, so the caller must handle both cases and
// the compiler enforces it
function findUser(id: number): User | undefined {
  return users.find((u) => u.id === id);
}
```
