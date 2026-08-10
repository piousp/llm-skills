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

[ALWAYS] mock at system boundaries only, the external dependency, not the project's own code:

```java
// GOOD: mock the external gateway, assert the service's behavior
@Test
void checkoutConfirmsWhenGatewayCharges() {
    PaymentGateway gateway = mock(PaymentGateway.class);
    when(gateway.charge(cart.total())).thenReturn(ChargeResult.success());

    CheckoutService service = new CheckoutService(gateway);
    CheckoutResult result = service.checkout(cart);

    assertEquals(CheckoutStatus.CONFIRMED, result.status());
}
```

The mock stands at the system boundary (external payment gateway), exactly where mocking.md draws the line. The test asserts observable behavior with a controlled external dependency, not the service's internals.

```java
// BAD: mock of the project's own collaborator
@Test
void checkoutMocksInternalCartRepository() {
    CartRepository repo = mock(CartRepository.class);
    CheckoutService service = new CheckoutService(repo);

    CheckoutResult result = service.checkout(cart);

    assertEquals(CheckoutStatus.CONFIRMED, result.status());
}
```

The repository is the project's own class, under the project's control; mocking.md: [DO NOT] mock the project's own classes or modules. The test now couples to internal wiring and breaks on refactors that change nothing observable.
