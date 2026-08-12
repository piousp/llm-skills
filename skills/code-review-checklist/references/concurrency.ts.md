# Concurrency in tests: TypeScript / JavaScript

Tests of concurrent or parallel code must not depend on timing or scheduling. Each example
pairs a timing-dependent test with a deterministic version.

### 1. Waiting a fixed delay for an async result

```typescript
// Code under test
export async function fetchUser(id: number): Promise<string> { /* async call */ }

// Flaky: assumes the async work finished after a fixed delay
test("fetchUser returns the name", async () => {
  let name = "";
  fetchUser(1).then((n) => (name = n));
  await new Promise((r) => setTimeout(r, 500)); // fails on slow machines, passes on fast ones
  expect(name).toBe("ana");
});

// Deterministic: await the actual promise
test("fetchUser returns the name", async () => {
  expect(await fetchUser(1)).toBe("ana");
});
```

### 2. Depending on real timers instead of controlling the clock

```typescript
// Code under test: retries with backoff
export async function retry(fn: () => Promise<void>, times: number): Promise<void> { /* ... */ }

// Flaky: asserts wall-clock time, depends on machine speed
test("retry gives up after the attempts", async () => {
  const start = Date.now();
  await retry(failingFn, 3);
  expect(Date.now() - start).toBeGreaterThan(1000); // slow on CI, flaky
});

// Deterministic: control the clock with fake timers
test("retry gives up after the attempts", async () => {
  jest.useFakeTimers();
  const p = retry(failingFn, 3);
  await jest.runAllTimersAsync();
  await expect(p).rejects.toThrow();
  jest.useRealTimers();
});
```
