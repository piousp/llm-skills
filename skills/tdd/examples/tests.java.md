# Good and Bad Tests — Code Examples (Java)

## Good Tests

**Integration-style**: Test through real interfaces, not mocks of internal parts.

```java
// GOOD: Tests observable behavior
@Test
void userCanCheckoutWithValidCart() {
    Cart cart = createCart();
    cart.add(product);
    CheckoutResult result = checkout(cart, paymentMethod);
    assertEquals(CheckoutStatus.CONFIRMED, result.status());
}
```

## Bad Tests

**Implementation-detail tests**: Coupled to internal structure.

```java
// BAD: Tests implementation details
@Test
void checkoutCallsPaymentServiceProcess() {
    PaymentService mockPayment = mock(PaymentService.class);
    checkout(cart, mockPayment);
    verify(mockPayment).process(cart.total());
}
```

```java
// BAD: Bypasses interface to verify
@Test
void createUserSavesToDatabase() {
    createUser(new UserRequest("Alice"));
    ResultSet row = db.query("SELECT * FROM users WHERE name = ?", "Alice");
    assertNotNull(row);
}

// GOOD: Verifies through interface
@Test
void createUserMakesUserRetrievable() {
    User user = createUser(new UserRequest("Alice"));
    User retrieved = getUser(user.id());
    assertEquals("Alice", retrieved.name());
}
```

**Tautological tests**: Expected value restates the implementation, so the test passes by construction.

```java
// BAD: Expected value is recomputed the way the code computes it
@Test
void calculateTotalSumsLineItems() {
    List<LineItem> items = List.of(new LineItem(10), new LineItem(5));
    double expected = items.stream().mapToDouble(LineItem::price).sum();
    assertEquals(expected, calculateTotal(items));
}

// GOOD: Expected value is an independent, known literal
@Test
void calculateTotalSumsLineItems() {
    assertEquals(15.0, calculateTotal(List.of(new LineItem(10), new LineItem(5))));
}
```
