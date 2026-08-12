# Error Handling & Resources examples: Java

What happens when this fails, and can it fail forever? This file covers: **resource
opened without a guaranteed close**, **caught exception swallowed, logged-and-ignored,
or rethrown as a less specific type**, and **retry/timeout/backoff with no bound**. Each
example pairs a change the review should flag with the fix that satisfies the checklist.

### 1. Resource opened without a guaranteed close

```java
// Anti-pattern: if readLine throws, close never runs and the file handle leaks; the
// guaranteed close is missing on the error path
String firstLine(Path path) throws IOException {
    BufferedReader reader = Files.newBufferedReader(path);
    return reader.readLine();
}

// Fix: try-with-resources closes the resource on every exit path, including exceptions
String firstLine(Path path) throws IOException {
    try (BufferedReader reader = Files.newBufferedReader(path)) {
        return reader.readLine();
    }
}
```

### 2. Caught exception swallowed or logged-and-ignored

```java
// Anti-pattern: the catch discards the failure, so the caller believes the operation
// succeeded and the error is invisible
void charge(long userId) {
    try {
        chargeCard(userId);
    } catch (CardDeclinedException e) {
        // swallowed: caller sees success
    }
}

// Fix: propagate the failure in a typed result, so the caller decides how to react
ChargeResult charge(long userId) {
    try {
        chargeCard(userId);
        return ChargeResult.ok();
    } catch (CardDeclinedException e) {
        return ChargeResult.declined();
    }
}
```

### 3. Retry with no bound

```java
// Anti-pattern: while(true) retries forever, so a persistently failing call blocks the
// thread indefinitely
Response callWithRetry() {
    while (true) {
        try {
            return doCall();
        } catch (TimeoutException e) {
            // loops without bound
        }
    }
}

// Fix: a visible bound on attempts, so the call terminates and the caller can react
Response callWithRetry(int maxAttempts) throws TimeoutException {
    for (int attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return doCall();
        } catch (TimeoutException e) {
            // try again, the bound is visible above
        }
    }
    throw new TimeoutException("after " + maxAttempts + " attempts");
}
```
