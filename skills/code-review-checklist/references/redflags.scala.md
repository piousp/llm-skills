# Red Flags examples: Scala

Run this code twice. Does it always do the same thing? These two blockers fail the
review outright: **non-deterministic code** (uncontrolled randomness, race conditions)
and **hidden mutable shared state added**. Test-side flakiness is covered by
`concurrency.*`. Each example pairs a change the review should flag with the fix that
satisfies the checklist.

### 1. Uncontrolled randomness in business logic

```scala
// Anti-pattern: Random.nextInt makes the result depend on execution state, so the
// outcome is unreproducible and untestable
def pickWinner(users: List[User]): User =
  users(Random.nextInt(users.size))

// Fix: inject the random source as a parameter, so tests become deterministic and the
// caller decides when randomness is acceptable
def pickWinner(users: List[User], random: Random): User =
  users(random.nextInt(users.size))
```

### 2. Hidden mutable shared state

```scala
// Anti-pattern: a global object with a private var is mutated from anywhere in the
// process, so call sites interleave and tests leak state between runs
object Cache {
  private var hits = 0
  def register(): Unit = hits += 1
}

// Fix: own the state in one instance and inject it, so each caller and each test gets
// an isolated counter with a predictable lifetime
final class Cache {
  private var hits = 0
  def register(): Unit = hits += 1
}
```
