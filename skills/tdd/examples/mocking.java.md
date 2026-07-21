# When to Mock — Code Examples (Java)

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
