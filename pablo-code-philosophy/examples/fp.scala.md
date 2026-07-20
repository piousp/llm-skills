# FP — Code Examples (Scala)

### Imperative, hides the failure path

```scala
def findUser(id: String): User = {
  val u = repository.get(id)
  if (u == null) throw new UserNotFoundException(id)
  u
}
```

### Typed failure, composable

```scala
def findUser(id: String): Option[User] = repository.get(id)
```

The caller decides how to handle absence — `.getOrElse()`, `.map()`, propagate the `Option` —
instead of being forced into a try/catch for an expected outcome.

### Observable mutation vs. no mutation at all

```scala
// Problem: mutation observable outside the method's scope
class OrderTotals {
  private var total: Double = 0 // shared, mutable state
  def add(amount: Double): Unit = total += amount // callers race on this
}

// Fine: no mutation at all, not even local
def sumTotals(orders: List[Order]): Double =
  orders.foldLeft(0.0)((total, o) => total + o.amount)
```

Scala rarely even needs the "local var is fine" exception — `foldLeft` replaces the
accumulator pattern outright.

### Composition replacing a nested-conditional mess

```scala
// Nested conditionals
val names = scala.collection.mutable.ListBuffer[String]()
for (c <- customers) {
  if (c.isActive) {
    if (c.balance > 0) {
      names += c.name.toUpperCase
    }
  }
}

// Composition
val names = customers
  .filter(_.isActive)
  .filter(_.balance > 0)
  .map(_.name.toUpperCase)
```

Worth it here: three real steps (filter, filter, map) — see FP.md's `FP vs KISS` note before
reaching for a chain on a two-step transform.

### Typed failure for a multi-step expected outcome

```scala
def resolveDiscount(customer: Customer, order: Order): Either[String, Discount] =
  for {
    tier     <- findLoyaltyTier(customer)
    discount <- findDiscountFor(tier, order)
  } yield discount
```

Either step can fail with a reason; the for-comprehension short-circuits on the first `Left`,
no nested match statements.
