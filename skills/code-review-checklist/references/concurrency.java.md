# Concurrency in tests: Java

Tests of concurrent or parallel code must not depend on thread scheduling. Each example
pairs a scheduling-dependent test with a deterministic version.

### 1. Sleeping a fixed time to wait for an async result

```java
// Code under test
public CompletableFuture<String> fetchUser(int id) { /* async call */ }

// Flaky: sleeps a fixed time, assumes the future has completed
@Test
void fetchUserReturnsTheName() throws Exception {
    CompletableFuture<String> f = fetchUser(1);
    Thread.sleep(500); // passes or fails depending on machine load
    assertTrue(f.isDone());
}

// Deterministic: wait on the future itself
@Test
void fetchUserReturnsTheName() throws Exception {
    assertEquals("ana", fetchUser(1).get(5, TimeUnit.SECONDS));
}
```

### 2. Asserting a global total that depends on scheduling

```java
// Code under test: increment is not atomic
class Counter {
    private int count;
    public void inc() { count++; }
    public int value() { return count; }
}

// Non-deterministic: result depends on thread scheduling
@Test
void counterReachesTheExpectedTotal() throws Exception {
    Counter c = new Counter();
    ExecutorService pool = Executors.newFixedThreadPool(4);
    for (int i = 0; i < 100; i++) pool.submit(c::inc);
    pool.shutdown();
    pool.awaitTermination(5, TimeUnit.SECONDS);
    assertEquals(100, c.value()); // flaky: lost updates under races
}

// Deterministic: assert a post-condition that holds regardless of order,
// or make the counter atomic and then assert the total
@Test
void counterReachesTheExpectedTotalWithAtomicIncrement() throws Exception {
    AtomicInteger c = new AtomicInteger();
    ExecutorService pool = Executors.newFixedThreadPool(4);
    for (int i = 0; i < 100; i++) pool.submit(c::incrementAndGet);
    pool.shutdown();
    pool.awaitTermination(5, TimeUnit.SECONDS);
    assertEquals(100, c.get());
}
```
