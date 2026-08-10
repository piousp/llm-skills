# Good and Bad Tests: Code Examples (Java)

Each category pairs a good and a bad snippet with the reasoning: what the good one verifies and why it survives refactors; what the bad one couples to, why it passes by construction, or what it leaves untested.

## Testing boundaries

Boundaries are the limit values of the inputs: for `divide`, null, zero, and sign changes on each operand. Every parameter gets its boundary values asserted.

### Good

```java
@Test
void dividePositiveByPositive() {
    assertEquals(5, divide(10, 2));
}
```

x > 0, y > 0 is the ordinary path: asserting it pins the baseline behavior the boundary tests protect. More happy-path values would not add coverage; every boundary still needs its own test.

```java
// divide(Integer x, Integer y), boxed operands make null expressible
@Test
void divideRejectsNullNumerator() {
    assertThrows(NullPointerException.class, () -> divide(null, 2));
}
```

x = null is a boundary value of the first parameter; without this test the null contract is unverified and a future change can start accepting null silently.

```java
@Test
void divideRejectsNullDenominator() {
    assertThrows(NullPointerException.class, () -> divide(2, null));
}
```

y = null is the same boundary on the second parameter: each parameter gets its own null test because they are independent inputs.

```java
@Test
void divideByZeroDenominatorThrows() {
    assertThrows(ArithmeticException.class, () -> divide(10, 0));
}
```

Zero is the classic division boundary: it pins the error path, so a change that starts returning garbage on y = 0 fails immediately.

```java
@Test
void divideHandlesZeroNumerator() {
    assertEquals(0, divide(0, 5));
}
```

x = 0 asserts the zero numerator goes through normal division instead of hitting the shortcut or an error path.

```java
@Test
void divideHandlesNegativeDenominator() {
    assertEquals(-5, divide(10, -2));
}
```

Sign is a boundary too: a happy-path test with positive operands leaves sign handling unverified; asserting through the public method survives internal rewrites.

```java
@Test
void divideHandlesNegativeNumerator() {
    assertEquals(-5, divide(-10, 2));
}
```

Negative numerator asserts sign handling on the first operand, the same boundary shape as the denominator: both parameters get their sign boundary covered.

### Bad

```java
@Test
void divideHandlesPositiveOperands() {
    assertEquals(5, divide(10, 2));
    assertEquals(3, divide(9, 3));
}
```

Two happy-path values are still one decision path: null, zero, and sign boundaries stay unverified, and the first assertion failure aborts the test, hiding the second. More values on the same path are not more coverage.

## Cyclomatic complexity

Every decision path, each if/else, switch/match, or guard clause, is behavior and needs its own test. The more branches, the more tests.

### Good

```java
// the shortcut compares with Objects.equals: value equality, null-safe
@Test
void divideReturnsOneWhenOperandsAreEqual() {
    assertEquals(1, divide(5, 5));
}
```

`if (Objects.equals(x, y)) return 1` is a shortcut branch: divide(5, 5) == 1 asserts the branch fires on equal operands. It does NOT pin the shortcut, because 5 / 5 is 1 either way; the test that catches a removed shortcut is divide(0, 0) below.

```java
@Test
void divideShortcutBeatsDivisionByZero() {
    assertEquals(1, divide(0, 0));
}
```

The shortcut has priority over the y = 0 error path: divide(0, 0) returns 1 instead of throwing. Remove the shortcut and it throws ArithmeticException; this is the test that pins the shortcut's existence.

```java
@Test
void divideNullsAreEqualUnderShortcut() {
    assertEquals(1, divide(null, null));
}
```

Objects.equals treats null == null as equal, so the shortcut fires before the unboxing NPE. Without the shortcut, divide(null, null) throws NPE; another pin on the shortcut, and the reason the null boundaries cannot be tested in isolation from it.

### Bad

```java
@Test
void divideHandlesAllCases() {
    assertEquals(2, divide(10, 5));
    assertEquals(1, divide(5, 5));
}
```

Two decision paths asserted in one test fail as a unit: the first failure aborts the run and hides the second, so a broken branch stays unverified. One assertion per test keeps the failing path identifiable.

## Tautological

### Good

```java
@Test
void calculateTotalSumsLineItems() {
    assertEquals(15.0, calculateTotal(List.of(new LineItem(10), new LineItem(5))));
}
```

The expected value is an independent, known literal; if the summing logic is wrong, the assertion disagrees with it. The test can fail, which is the whole point.

### Bad

```java
@Test
void calculateTotalSumsLineItems() {
    List<LineItem> items = List.of(new LineItem(10), new LineItem(5));
    double expected = items.stream().mapToDouble(LineItem::price).sum();
    assertEquals(expected, calculateTotal(items));
}
```

The expected value is recomputed exactly the way the implementation computes it, so the test passes by construction: the same bug reproduces on both sides and the assertion can never disagree with the code.

## Bypassing the interface

### Good

```java
@Test
void createUserMakesUserRetrievable() {
    User user = createUser(new UserRequest("Alice"));
    User retrieved = getUser(user.id());
    assertEquals("Alice", retrieved.name());
}
```

Verifies through the same public API a caller uses, so a renamed table or an added repository layer changes nothing: the behavior "a created user can be retrieved" is what is asserted.

### Bad

```java
@Test
void createUserSavesToDatabase() {
    createUser(new UserRequest("Alice"));
    ResultSet row = db.query("SELECT * FROM users WHERE name = ?", "Alice");
    assertNotNull(row);
}
```

Reaches around the public API into the persistence layer and couples the test to storage details: table name, schema, query API. Any storage refactor breaks the test even when the user-facing behavior is unchanged.

## Integration-style

### Good

```java
@Test
void userCanCheckoutWithValidCart() {
    Cart cart = createCart();
    cart.add(product);
    CheckoutResult result = checkout(cart, paymentMethod);
    assertEquals(CheckoutStatus.CONFIRMED, result.status());
}
```

Tests observable behavior through the real flow and reads like a specification: "user can checkout with valid cart" names the capability, not the mechanism. It survives internal refactors because it never mentions internal collaborators.

### Bad

```java
@Test
void checkoutCallsPaymentServiceProcess() {
    PaymentService mockPayment = mock(PaymentService.class);
    checkout(cart, mockPayment);
    verify(mockPayment).process(cart.total());
}
```

Asserts HOW the checkout delegates instead of WHAT it produces, coupling the test to the internal call graph. Any refactor that keeps the behavior identical breaks the test, and the actual outcome, a confirmed checkout, is never checked.
