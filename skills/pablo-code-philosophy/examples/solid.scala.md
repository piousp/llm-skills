# SOLID — Code Examples (Scala)

### S — Single Responsibility: Shipping calculator

```scala
// Two reasons to change: shipping rules AND logging
class ShippingCalculator {
  def calculate(order: Order): Double = ???
  def logCalculation(order: Order): Unit = ???
}

// Better
class ShippingCalculator {
  def calculate(order: Order): Double = ???
}
class CalculationLogger {
  def log(order: Order, cost: Double): Unit = ???
}
```

### O — Open/Closed: Payment processing

```scala
// Violation: modify every time a new type appears
def calculate(o: Order, kind: String): Double = kind match {
  case "credit" => ???
  case "paypal" => ??? // add case for each
}

// Better: extend via strategy
trait ShippingStrategy { def calculate(o: Order): Double }
class CreditShipping extends ShippingStrategy { def calculate(o: Order) = ??? }
class PayPalShipping extends ShippingStrategy { def calculate(o: Order) = ??? }
```

### L — Liskov Substitution: Bird hierarchy

```scala
// Violation: Ostrich extends Bird with fly() but can't fly
class Bird { def fly: Unit = ??? }
class Ostrich extends Bird { override def fly: Unit = throw new Exception }

// Better: model the capability, not the bird
trait Flyable { def fly: Unit }
class Sparrow extends Bird with Flyable
class Ostrich extends Bird // no fly
```

### I — Interface Segregation: Document processing

```scala
// Violation: fat interface
trait DocumentHandler { def read(): Unit; def write(): Unit; def print(): Unit }

// Better: segregated
trait DocumentReader { def read(): Unit }
trait DocumentWriter { def write(): Unit }
trait DocumentPrinter { def print(): Unit }
```

### D — Dependency Inversion: Database access

```scala
// Violation: depends on concrete
class UserService {
  val db = new MySQLDatabase()
}

// Better: depends on abstraction
trait Database { def query(sql: String): ResultSet }
class UserService(db: Database) {
  db.query("SELECT * FROM users")
}
```

### Anti-example: DI for a single implementation that will never be swapped

```scala
trait StringUpperCaser { def upper(s: String): String }
class JdkStringUpperCaser extends StringUpperCaser {
  def upper(s: String): String = s.toUpperCase
}
class LabelFormatter(caser: StringUpperCaser) // indirection, no real swap point

// Better: call the stdlib method directly
class LabelFormatter {
  def format(s: String): String = s.toUpperCase
}
```

Dependency injection for a trait with one implementation and no test-swap need is indirection,
not architecture.
