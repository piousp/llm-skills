# Abstractions examples: Scala

Does this abstraction earn its existence today? This file covers: **new abstraction
without a second concrete use case**, **generic utility for a single call site**,
**error handling for a scenario that cannot occur**, and **enterprise sludge**
(factories/builders/managers/config knobs layered onto a trivial task). Each example
pairs a change the review should flag with the fix that satisfies the checklist.

### 1. Abstraction with a single use case

```scala
// Anti-pattern: a Cache wrapper class has one call site and one implementation, so the
// indirection adds a layer without a second user to justify it
class Cache {
  private val store = mutable.Map.empty[String, User]
  def get(key: String): Option[User] = store.get(key)
}
def loadUser(id: Long): Option[User] = cache.get(id.toString)

// Fix: delete the wrapper and call the concrete thing; add the abstraction only when a
// second use case appears (YAGNI)
def loadUser(id: Long): Option[User] = userStore.load(id)
```

### 2. Error handling for a scenario that cannot occur

```scala
// Anti-pattern: the type guarantees a non-null value, so the null check is dead code
// that distracts the reader and invites "what if" questions
def greet(user: User): String = {
  if (user == null) "hello" else s"hello ${user.name}" // User is not nullable
}

// Fix: remove the branch and let the types guarantee the invariant
def greet(user: User): String = s"hello ${user.name}"
```

### 3. Enterprise sludge around a trivial task

```scala
// Anti-pattern: a factory with config knobs to construct a two-field value; the
// machinery outweighs the task
final class UserFactory(userConfig: UserConfig) {
  def create(name: String, email: String): User =
    User(name = name.trim, email = email.trim, retries = userConfig.retries)
}

// Fix: the plain constructor; remove the factory layer entirely
User(name = name.trim, email = email.trim)
```
