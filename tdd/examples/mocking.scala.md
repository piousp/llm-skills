# When to Mock — Code Examples (Scala)

## Designing for Mockability

**1. Use dependency injection**

Pass external dependencies in rather than creating them internally:

```scala
// Easy to mock
def processPayment(order: Order, paymentClient: PaymentClient): BigDecimal =
  paymentClient.charge(order.total)

// Hard to mock
def processPayment(order: Order): BigDecimal =
  val client = new StripeClient(sys.env("STRIPE_KEY"))
  client.charge(order.total)
```

**2. Prefer SDK-style interfaces over generic fetchers**

Create specific methods for each external operation instead of one generic method with conditional logic:

```scala
// GOOD: Each method is independently mockable
trait Api:
  def getUser(id: String): User
  def getOrders(userId: String): List[Order]
  def createOrder(data: OrderRequest): Order

// BAD: Mocking requires conditional logic inside the mock
trait Api:
  def fetch(endpoint: String, options: RequestOptions): Response
```

The SDK approach means:
- Each mock returns one specific shape
- No conditional logic in test setup
- Easier to see which endpoints a test exercises
- Type safety per endpoint
