# Red Flags examples: TypeScript / JavaScript

Run this code twice. Does it always do the same thing? These two blockers fail the
review outright: **non-deterministic code** (uncontrolled randomness, race conditions)
and **hidden mutable shared state added**. Test-side flakiness is covered by
`concurrency.*`. Each example pairs a change the review should flag with the fix that
satisfies the checklist.

### 1. Uncontrolled randomness in business logic

```typescript
// Anti-pattern: Math.random() picks the winner from module state, so the outcome is
// unreproducible and untestable
function pickWinner(users: User[]): User {
  return users[Math.floor(Math.random() * users.length)];
}

// Fix: inject the random source as a parameter, so tests become deterministic and the
// caller decides when randomness is acceptable
function pickWinner(users: User[], random: () => number): User {
  return users[Math.floor(random() * users.length)];
}
```

### 2. Hidden mutable shared state

```typescript
// Anti-pattern: a module-level Map is imported and mutated by several modules, so
// callers race on shared state and tests leak state between runs
export const cache = new Map<string, User>();

// Fix: own the state in one instance and inject it, so each caller and each test gets
// an isolated store with a predictable lifetime
export class Cache {
  private readonly store = new Map<string, User>();
}
```
