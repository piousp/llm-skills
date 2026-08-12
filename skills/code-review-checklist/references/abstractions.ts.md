# Abstractions examples: TypeScript / JavaScript

Does this abstraction earn its existence today? This file covers: **new abstraction
without a second concrete use case**, **generic utility for a single call site**,
**error handling for a scenario that cannot occur**, and **enterprise sludge**
(factories/builders/managers/config knobs layered onto a trivial task). Each example
pairs a change the review should flag with the fix that satisfies the checklist.

### 1. Abstraction with a single use case

```typescript
// Anti-pattern: a Cache wrapper class has one call site and one implementation, so the
// indirection adds a layer without a second user to justify it
class Cache {
  private readonly store = new Map<string, User>();
  get(key: string): User | undefined { return this.store.get(key); }
}
function loadUser(id: number): User | undefined { return cache.get(String(id)); }

// Fix: delete the wrapper and call the concrete thing; add the abstraction only when a
// second use case appears (YAGNI)
function loadUser(id: number): User | undefined { return userStore.load(id); }
```

### 2. Error handling for a scenario that cannot occur

```typescript
// Anti-pattern: the type guarantees a non-null value, so the null check is dead code
// that distracts the reader and invites "what if" questions
function greet(user: User): string {
  if (!user) return "hello"; // User is not nullable
  return `hello ${user.name}`;
}

// Fix: remove the branch and let the types guarantee the invariant
function greet(user: User): string {
  return `hello ${user.name}`;
}
```

### 3. Enterprise sludge around a trivial task

```typescript
// Anti-pattern: a factory with config knobs to construct a two-field value; the
// machinery outweighs the task
class UserFactory {
  create(name: string, email: string): User {
    return new User(name.trim(), email.trim());
  }
}

// Fix: the plain constructor; remove the factory layer entirely
new User(name.trim(), email.trim());
```
