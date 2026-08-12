# Abstractions examples: Java

Does this abstraction earn its existence today? This file covers: **new abstraction
without a second concrete use case**, **generic utility for a single call site**,
**error handling for a scenario that cannot occur**, and **enterprise sludge**
(factories/builders/managers/config knobs layered onto a trivial task). Each example
pairs a change the review should flag with the fix that satisfies the checklist.

### 1. Abstraction with a single use case

```java
// Anti-pattern: a Cache wrapper class has one call site and one implementation, so the
// indirection adds a layer without a second user to justify it
class Cache {
    private final Map<String, User> store = new HashMap<>();
    Optional<User> get(String key) { return Optional.ofNullable(store.get(key)); }
}
Optional<User> loadUser(long id) { return cache.get(String.valueOf(id)); }

// Fix: delete the wrapper and call the concrete thing; add the abstraction only when a
// second use case appears (YAGNI)
Optional<User> loadUser(long id) { return userStore.load(id); }
```

### 2. Error handling for a scenario that cannot occur

```java
// Anti-pattern: the API guarantees a non-null value, so the null check is dead code
// that distracts the reader and invites "what if" questions
String greet(User user) {
    if (user == null) return "hello"; // the API returns non-null
    return "hello " + user.name();
}

// Fix: remove the branch and let the types guarantee the invariant
String greet(User user) { return "hello " + user.name(); }
```

### 3. Enterprise sludge around a trivial task

```java
// Anti-pattern: a factory with config knobs to construct a two-field value; the
// machinery outweighs the task
class UserFactory {
    User create(String name, String email) {
        return new User(name.trim(), email.trim());
    }
}

// Fix: the plain constructor; remove the factory layer entirely
new User(name.trim(), email.trim());
```
