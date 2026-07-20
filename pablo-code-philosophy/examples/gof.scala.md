# GoF — Code Examples (Scala)

### Premature Strategy — one implementation, no second in sight

```scala
trait DiscountStrategy { def apply(price: BigDecimal): BigDecimal }
class StandardDiscount extends DiscountStrategy {
  def apply(price: BigDecimal): BigDecimal = price
}
// One implementation, no plan for a second.
```

### FP subsumes GoF — no shared state, a function replaces the hierarchy

```scala
type Discount = BigDecimal => BigDecimal
val seasonal: Discount = price => price * 0.9
val loyalty: Discount = price => price - 5
// Selected by config; no class hierarchy needed for a stateless variation.
```

Reach for the trait-per-variant hierarchy only when a variant needs to carry state or when
there are ≥3 real, current implementations — otherwise a `Function1` value is the natural
expression of Strategy in Scala.

### Named/default parameters subsume Builder

```scala
// Builder ceremony rarely earns its keep in Scala
case class Report(includeCharts: Boolean = false, format: String = "PDF", timeoutSeconds: Int = 30)

val report = Report(includeCharts = true, timeoutSeconds = 30)
// Named + default parameters already give Builder's readability, no extra class needed.
```

Reach for an actual Builder class in Scala only when construction needs real multi-step
validation across steps; for plain optional fields, case class defaults are simpler.
