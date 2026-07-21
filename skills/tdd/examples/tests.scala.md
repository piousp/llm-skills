# Good and Bad Tests — Code Examples (Scala)

## Good Tests

**Integration-style**: Test through real interfaces, not mocks of internal parts.

```scala
// GOOD: Tests observable behavior
test("user can checkout with valid cart") {
  val cart = createCart()
  cart.add(product)
  val result = checkout(cart, paymentMethod)
  assert(result.status == CheckoutStatus.Confirmed)
}
```

## Bad Tests

**Implementation-detail tests**: Coupled to internal structure.

```scala
// BAD: Tests implementation details
test("checkout calls paymentService.process") {
  val mockPayment = mock[PaymentService]
  checkout(cart, mockPayment)
  verify(mockPayment).process(cart.total)
}
```

```scala
// BAD: Bypasses interface to verify
test("createUser saves to database") {
  createUser(UserRequest("Alice"))
  val row = db.query("SELECT * FROM users WHERE name = ?", "Alice")
  assert(row.isDefined)
}

// GOOD: Verifies through interface
test("createUser makes user retrievable") {
  val user = createUser(UserRequest("Alice"))
  val retrieved = getUser(user.id)
  assert(retrieved.name == "Alice")
}
```

**Tautological tests**: Expected value restates the implementation, so the test passes by construction.

```scala
// BAD: Expected value is recomputed the way the code computes it
test("calculateTotal sums line items") {
  val items = List(LineItem(10), LineItem(5))
  val expected = items.map(_.price).sum
  assert(calculateTotal(items) == expected)
}

// GOOD: Expected value is an independent, known literal
test("calculateTotal sums line items") {
  assert(calculateTotal(List(LineItem(10), LineItem(5))) == 15.0)
}
```
