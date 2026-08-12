# Data Shape examples: Scala

Could this conditional disappear if the data had a better shape? This file covers:
**boolean parameter that selects between two behaviors**, **conditionals that could be
eliminated by fixing the data structure**, **inheritance where composition suffices**,
and **special-case insanity**. Each example pairs a change the review should flag with
the fix that satisfies the checklist.

### 1. Boolean parameter that selects between two behaviors

```scala
// Anti-pattern: verbose is a flag that branches inside, so every call site must read
// the body to know what it does and new modes grow the flag list
def buildLabel(user: User, verbose: Boolean): String =
  if (verbose) s"${user.name} <${user.email}>"
  else user.name

// Fix: two functions, one behavior each, so the call site names what it wants
def buildLabel(user: User): String = user.name
def buildVerboseLabel(user: User): String = s"${user.name} <${user.email}>"
```

### 2. Conditionals patching a data model that should encode the case

```scala
// Anti-pattern: the status is a string, so every check duplicates the same branch pile
// and a new status must be added in N places
def summary(order: Order): String =
  if (order.status == "paid" && order.discountCode.isEmpty) "paid in full"
  else if (order.status == "paid") "paid with discount"
  else "pending"

// Fix: encode the state in the type, so the match collapses the pile and the compiler
// checks every case
sealed trait OrderStatus
case class Paid(discountCode: Option[String]) extends OrderStatus
case object Pending extends OrderStatus

def summary(status: OrderStatus): String = status match {
  case Paid(None)    => "paid in full"
  case Paid(Some(_)) => "paid with discount"
  case Pending       => "pending"
}
```

### 3. Inheritance where composition suffices

```scala
// Anti-pattern: Penguin inherits fly() it cannot honor, so callers can invoke a
// behavior that throws; the hierarchy lies about its capabilities
class Penguin extends Bird {
  override def fly(): Unit = throw new UnsupportedOperationException("penguins don't fly")
}

// Fix: separate the capability and compose it, so only real flyers expose fly()
trait Flies { def fly(): Unit }
class Penguin extends Bird // no fly
class Sparrow extends Bird with Flies {
  override def fly(): Unit = // ...
}
```
