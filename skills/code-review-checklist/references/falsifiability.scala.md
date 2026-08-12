# Falsifiability examples: Scala

The question behind every test: **"if this code were broken, would this test catch it?"**
If the answer is no, the test verifies nothing. Each example pairs a test that passes on
broken code with the fix that makes it falsifiable.

### 1. Test with no assertion (passes no matter what)

```scala
// Code under test
def parseUserId(raw: String): Option[Long] =
  raw.toLongOption

// Won't catch a bug: executes the code, asserts nothing
"parseUserId" should "return a value for valid input" in {
  parseUserId("42") // passes even if the method returns None or a wrong value
}

// Falsifiable: fixes the expected result
"parseUserId" should "return Some(42) for '42'" in {
  parseUserId("42") shouldBe Some(42L)
}
```

### 2. Test that duplicates the implementation logic

```scala
// Code under test
def isAdult(age: Int): Boolean = age >= 18

// Won't catch a bug: replicates the operator, so it breaks together with the code
"isAdult" should "apply the adult threshold" in {
  isAdult(17) shouldBe (17 >= 18) // tautology: same expression on both sides
}

// Falsifiable: fixes the expected behavior
"isAdult" should "be false for 17 and true for 18" in {
  isAdult(17) shouldBe false
  isAdult(18) shouldBe true
}
```
