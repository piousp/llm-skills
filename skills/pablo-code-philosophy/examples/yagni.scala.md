# YAGNI — Code Examples (Scala)

### Violation — speculative abstraction

```scala
trait PaymentProcessor { def processPayment(order: Order): Unit }

class CreditCardProcessor extends PaymentProcessor {
  def processPayment(order: Order): Unit = ???
}
class PayPalProcessor extends PaymentProcessor {
  def processPayment(order: Order): Unit = ???
}
class ApplePayProcessor extends PaymentProcessor {
  def processPayment(order: Order): Unit = ???
}
```

Three implementations. The system only accepts credit cards. The other two are guesses.

### Following YAGNI

```scala
def processPayment(order: Order): Unit =
  throw new UnsupportedOperationException("only credit card supported")
```

When PayPal gets added, refactor. The interface will emerge from the actual need, not from
speculation.

### Speculative parameter

```scala
// Speculative parameter: always false in practice, no caller needs it
def search(query: String, strictMode: Boolean = false): List[Item] =
  if (strictMode) strictSearch(query) else fuzzySearch(query)

// Following YAGNI: drop the flag until a caller actually needs strict mode
def search(query: String): List[Item] = fuzzySearch(query)
```

### Unused extension hooks

```scala
// Hooks "for subclasses later" — no subclass exists
abstract class ReportGenerator {
  def generate(): Report = {
    val r = build()
    beforeSave(r) // hook, never overridden
    save(r)
    afterSave(r) // hook, never overridden
    r
  }
  protected def beforeSave(r: Report): Unit = ()
  protected def afterSave(r: Report): Unit = ()
}

// Following YAGNI: no hooks until a second implementation needs one
class ReportGenerator {
  def generate(): Report = { val r = build(); save(r); r }
}
```
