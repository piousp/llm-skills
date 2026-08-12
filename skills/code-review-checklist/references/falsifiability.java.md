# Falsifiability examples: Java

The question behind every test: **"if this code were broken, would this test catch it?"**
If the answer is no, the test verifies nothing. Each example pairs a test that passes on
broken code with the fix that makes it falsifiable.

### 1. Test that only checks nothing was thrown

```java
// Code under test
public int divide(int a, int b) { return a / b; }

// Won't catch a bug: only proves the method ran
@Test
void divideDoesNotThrowForPositiveInputs() {
    divide(10, 2); // passes even if the result is wrong
}

// Falsifiable: asserts the result
@Test
void divideReturnsTheQuotient() {
    assertEquals(5, divide(10, 2));
}
```

### 2. Test coupled to implementation details

```java
// Code under test
public record User(String name, int age) {}

// Won't catch a bug: checks the record's toString instead of behavior
@Test
void userToStringContainsTheName() {
    User u = new User("ana", 30);
    assertTrue(u.toString().contains("ana")); // breaks on any formatting change, not on wrong behavior
}

// Falsifiable: asserts the behavior a caller relies on
@Test
void userExposesTheName() {
    User u = new User("ana", 30);
    assertEquals("ana", u.name());
}
```
