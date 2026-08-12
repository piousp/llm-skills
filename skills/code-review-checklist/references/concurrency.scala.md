# Concurrency in tests: Scala

Tests of concurrent or parallel code must not depend on thread scheduling. Each example
pairs a scheduling-dependent test with a deterministic version.

### 1. Sleeping a fixed time to wait for an async result

```scala
// Code under test
def fetchUser(id: Long): Future[User] = // async call

// Flaky: sleeps a fixed time, assumes the future has completed
"fetchUser" should "return the user" in {
  val f = fetchUser(1)
  Thread.sleep(500) // passes or fails depending on machine load
  f.value shouldBe defined
}

// Deterministic: wait for completion, not for a wall-clock guess
"fetchUser" should "return the user" in {
  Await.result(fetchUser(1), 5.seconds).name shouldBe "ana"
}
```

### 2. Asserting a global total that depends on scheduling

```scala
// Code under test: increment is not atomic
class Counter {
  private var count = 0
  def inc(): Unit = count += 1
  def value: Int = count
}

// Non-deterministic: result depends on thread scheduling
"Counter" should "reach 100 after 10 threads x 10 increments" in {
  val c = new Counter
  (1 to 10).par.foreach(_ => (1 to 10).foreach(_ => c.inc()))
  c.value shouldBe 100 // flaky: lost updates under races
}

// Deterministic: assert a post-condition that holds regardless of order,
// or make the counter atomic and then assert the total
"Counter" should "not lose increments with an atomic counter" in {
  val c = new AtomicCounter
  (1 to 10).par.foreach(_ => (1 to 10).foreach(_ => c.inc()))
  c.value shouldBe 100
}
```
