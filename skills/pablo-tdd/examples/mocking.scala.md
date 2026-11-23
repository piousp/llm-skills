# When to Mock: Code Examples (Scala)

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

## Mocking at the boundary

[ALWAYS] mock at system boundaries only, the project's adapter to the external system, never its domain logic:

```scala
// GOOD: mock the external gateway, assert the service's behavior
test("checkout confirms when gateway charges") {
  val gateway = mock[PaymentGateway]
  when(gateway.charge(cart.total)).thenReturn(ChargeResult.success())

  val service = CheckoutService(gateway, CartValidator())
  val result = service.checkout(cart)

  assert(result.status == CheckoutStatus.Confirmed)
}
```

The mock stands at the system boundary (external payment gateway), exactly where references/mocking.md draws the line; `CartValidator`, the project's own domain rule, runs for real. The test asserts observable behavior with a controlled external dependency, not the service's internals.

```scala
// BAD: mock of the project's own domain logic
test("checkout mocks internal cart validator") {
  val gateway = mock[PaymentGateway]
  when(gateway.charge(cart.total)).thenReturn(ChargeResult.success())
  val validator = mock[CartValidator]
  when(validator.isValid(cart)).thenReturn(true)

  val service = CheckoutService(gateway, validator)
  val result = service.checkout(cart)

  assert(result.status == CheckoutStatus.Confirmed)
}
```

`CartValidator` is the project's own domain rule, under the project's control; references/mocking.md: [DO NOT] mock the project's own classes or modules. Stubbed to `true`, the rule never runs: the test stays green when validation breaks, and it couples to the service's internal wiring. The gateway mock is still right: the gateway is the boundary.
