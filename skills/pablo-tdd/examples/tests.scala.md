# Good and Bad Tests: Code Examples (Scala)

Each category pairs a good and a bad snippet with the reasoning: what the good one verifies and why it survives refactors; what the bad one couples to, why it passes by construction, or what it leaves untested.

## Testing boundaries

Boundaries are the limit values of the inputs: for `divide`, null, zero, and sign changes on each operand. Every parameter gets its boundary values asserted.

### Good

```scala
test("divide positive by positive") {
  assert(divide(10, 2) == 5)
}
```

x > 0, y > 0 is the ordinary path: asserting it pins the baseline behavior the boundary tests protect. More happy-path values would not add coverage; every boundary still needs its own test.

```scala
// divide(x: Integer, y: Integer): Integer, boxed operands keep null expressible
test("divide rejects null numerator") {
  intercept[NullPointerException](divide(null, 2))
}
```

x = null is a boundary value of the first parameter; without this test the null contract is unverified and a future change can start accepting null silently.

```scala
test("divide rejects null denominator") {
  intercept[NullPointerException](divide(2, null))
}
```

y = null is the same boundary on the second parameter: each parameter gets its own null test because they are independent inputs.

```scala
test("divide by zero denominator throws") {
  intercept[ArithmeticException](divide(10, 0))
}
```

Zero is the classic division boundary: it pins the error path, so a change that starts returning garbage on y = 0 fails immediately.

```scala
test("divide handles zero numerator") {
  assert(divide(0, 5) == 0)
}
```

x = 0 asserts the zero numerator goes through normal division instead of hitting the shortcut or an error path.

```scala
test("divide handles negative denominator") {
  assert(divide(10, -2) == -5)
}
```

Sign is a boundary too: a happy-path test with positive operands leaves sign handling unverified; asserting through the public method survives internal rewrites.

```scala
test("divide handles negative numerator") {
  assert(divide(-10, 2) == -5)
}
```

Negative numerator asserts sign handling on the first operand, the same boundary shape as the denominator: both parameters get their sign boundary covered.

### Bad

```scala
test("divide handles positive operands") {
  assert(divide(10, 2) == 5)
  assert(divide(9, 3) == 3)
}
```

Two happy-path values are still one decision path: null, zero, and sign boundaries stay unverified, and the first assertion failure aborts the test, hiding the second. More values on the same path are not more coverage.

## Cyclomatic complexity

Every decision path, each if/else, switch/match, or guard clause, is behavior and needs its own test. The more branches, the more tests.

### Good

```scala
// in Scala, == on boxed Integer is null-safe value equality
test("divide returns 1 when operands are equal") {
  assert(divide(5, 5) == 1)
}
```

`if (x == y) return 1` is a shortcut branch: divide(5, 5) == 1 asserts the branch fires on equal operands. It does NOT pin the shortcut, because 5 / 5 is 1 either way; the test that catches a removed shortcut is divide(0, 0) below.

```scala
test("divide shortcut beats division by zero") {
  assert(divide(0, 0) == 1)
}
```

The shortcut has priority over the y = 0 error path: divide(0, 0) returns 1 instead of throwing. Remove the shortcut and it throws ArithmeticException; this is the test that pins the shortcut's existence.

```scala
test("divide nulls are equal under shortcut") {
  assert(divide(null, null) == 1)
}
```

Scala's `==` treats null == null as equal, so the shortcut fires before the unboxing NPE. Without the shortcut, divide(null, null) throws NPE; another pin on the shortcut, and the reason the null boundaries cannot be tested in isolation from it.

### Bad

```scala
test("divide handles all cases") {
  assert(divide(10, 5) == 2)
  assert(divide(5, 5) == 1)
}
```

Two decision paths asserted in one test fail as a unit: the first failure aborts the run and hides the second, so a broken branch stays unverified. One assertion per test keeps the failing path identifiable.

## Tautological

### Good

```scala
test("calculateTotal sums line items") {
  assert(calculateTotal(List(LineItem(10), LineItem(5))) == 15.0)
}
```

The expected value is an independent, known literal; if the summing logic is wrong, the assertion disagrees with it. The test can fail, which is the whole point.

### Bad

```scala
test("calculateTotal sums line items") {
  val items = List(LineItem(10), LineItem(5))
  val expected = items.map(_.price).sum
  assert(calculateTotal(items) == expected)
}
```

The expected value is recomputed exactly the way the implementation computes it, so the test passes by construction: the same bug reproduces on both sides and the assertion can never disagree with the code.

## Bypassing the interface

### Good

```scala
test("createUser makes user retrievable") {
  val user = createUser(UserRequest("Alice"))
  val retrieved = getUser(user.id)
  assert(retrieved.name == "Alice")
}
```

Verifies through the same public API a caller uses, so a renamed table or an added repository layer changes nothing: the behavior "a created user can be retrieved" is what is asserted.

### Bad

```scala
test("createUser saves to database") {
  createUser(UserRequest("Alice"))
  val row = db.query("SELECT * FROM users WHERE name = ?", "Alice")
  assert(row.isDefined)
}
```

Reaches around the public API into the persistence layer and couples the test to storage details: table name, schema, query API. Any storage refactor breaks the test even when the user-facing behavior is unchanged.

## Integration-style

### Good

```scala
test("user can checkout with valid cart") {
  val cart = createCart()
  cart.add(product)
  val result = checkout(cart, paymentMethod)
  assert(result.status == CheckoutStatus.Confirmed)
}
```

Tests observable behavior through the real flow and reads like a specification: "user can checkout with valid cart" names the capability, not the mechanism. It survives internal refactors because it never mentions internal collaborators.

### Bad

```scala
test("checkout calls paymentService.process") {
  val mockPayment = mock[PaymentService]
  checkout(cart, mockPayment)
  verify(mockPayment).process(cart.total)
}
```

Asserts HOW the checkout delegates instead of WHAT it produces, coupling the test to the internal call graph. Any refactor that keeps the behavior identical breaks the test, and the actual outcome, a confirmed checkout, is never checked.
