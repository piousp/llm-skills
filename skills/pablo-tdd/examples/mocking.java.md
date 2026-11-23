# When to Mock: Code Examples (Java)

## Designing for Mockability

**1. Use dependency injection**

Pass external dependencies in rather than creating them internally:

```java
// Easy to mock
BigDecimal processPayment(Order order, PaymentClient paymentClient) {
    return paymentClient.charge(order.total());
}

// Hard to mock
BigDecimal processPayment(Order order) {
    PaymentClient client = new StripeClient(System.getenv("STRIPE_KEY"));
    return client.charge(order.total());
}
```

**2. Prefer SDK-style interfaces over generic fetchers**

Create specific methods for each external operation instead of one generic method with conditional logic:

```java
// GOOD: Each method is independently mockable
interface Api {
    User getUser(String id);
    List<Order> getOrders(String userId);
    Order createOrder(OrderRequest data);
}

// BAD: Mocking requires conditional logic inside the mock
interface Api {
    Response fetch(String endpoint, RequestOptions options);
}
```

The SDK approach means:

- Each mock returns one specific shape
- No conditional logic in test setup
- Easier to see which endpoints a test exercises
- Type safety per endpoint

## Mocking at the boundary

[ALWAYS] mock at system boundaries only, the project's adapter to the external system, never its domain logic:

```java
// GOOD: mock the external gateway, assert the service's behavior
@Test
void checkoutConfirmsWhenGatewayCharges() {
    PaymentGateway gateway = mock(PaymentGateway.class);
    when(gateway.charge(cart.total())).thenReturn(ChargeResult.success());

    CheckoutService service = new CheckoutService(gateway, new CartValidator());
    CheckoutResult result = service.checkout(cart);

    assertEquals(CheckoutStatus.CONFIRMED, result.status());
}
```

The mock stands at the system boundary (external payment gateway), exactly where references/mocking.md draws the line; `CartValidator`, the project's own domain rule, runs for real. The test asserts observable behavior with a controlled external dependency, not the service's internals.

```java
// BAD: mock of the project's own domain logic
@Test
void checkoutMocksInternalCartValidator() {
    PaymentGateway gateway = mock(PaymentGateway.class);
    when(gateway.charge(cart.total())).thenReturn(ChargeResult.success());
    CartValidator validator = mock(CartValidator.class);
    when(validator.isValid(cart)).thenReturn(true);

    CheckoutService service = new CheckoutService(gateway, validator);
    CheckoutResult result = service.checkout(cart);

    assertEquals(CheckoutStatus.CONFIRMED, result.status());
}
```

`CartValidator` is the project's own domain rule, under the project's control; references/mocking.md: [DO NOT] mock the project's own classes or modules. Stubbed to `true`, the rule never runs: the test stays green when validation breaks, and it couples to the service's internal wiring. The gateway mock is still right: the gateway is the boundary.
