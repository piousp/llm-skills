# Error Handling & Resources examples: TypeScript / JavaScript

What happens when this fails, and can it fail forever? This file covers: **resource
opened without a guaranteed close**, **caught exception swallowed, logged-and-ignored,
or rethrown as a less specific type**, and **retry/timeout/backoff with no bound**. Each
example pairs a change the review should flag with the fix that satisfies the checklist.

### 1. Resource opened without a guaranteed close

```typescript
// Anti-pattern: if the query throws, the client is never released and the connection
// pool leaks; the guaranteed close is missing on the error path
async function firstUser(): Promise<User | undefined> {
  const client = await db.connect();
  const row = await client.query("SELECT * FROM users LIMIT 1"); // throws: client leaks
  return row[0];
}

// Fix: finally releases the resource on every exit path, including exceptions
async function firstUser(): Promise<User | undefined> {
  const client = await db.connect();
  try {
    const row = await client.query("SELECT * FROM users LIMIT 1");
    return row[0];
  } finally {
    await client.release();
  }
}
```

### 2. Caught exception swallowed or logged-and-ignored

```typescript
// Anti-pattern: the catch discards the failure, so the caller believes the operation
// succeeded and the error is invisible
async function charge(userId: number): Promise<void> {
  try {
    await chargeCard(userId);
  } catch {
    // swallowed: caller sees success
  }
}

// Fix: propagate the failure in a typed result, so the caller decides how to react
async function charge(userId: number): Promise<ChargeResult> {
  try {
    await chargeCard(userId);
    return { ok: true };
  } catch {
    return { ok: false, reason: "card-declined" };
  }
}
```

### 3. Retry with no bound

```typescript
// Anti-pattern: the setTimeout re-invokes forever, so a persistently failing call never
// terminates
function callWithRetry(): Promise<Response> {
  return doCall().catch(() => setTimeout(() => callWithRetry(), 100));
}

// Fix: a visible bound on attempts, so the call terminates and the caller can react
async function callWithRetry(maxAttempts: number): Promise<Response> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await doCall();
    } catch {
      // try again, the bound is visible above
    }
  }
  throw new Error(`failed after ${maxAttempts} attempts`);
}
```
