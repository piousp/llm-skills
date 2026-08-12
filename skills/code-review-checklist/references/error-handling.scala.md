# Error Handling & Resources examples: Scala

What happens when this fails, and can it fail forever? This file covers: **resource
opened without a guaranteed close**, **caught exception swallowed, logged-and-ignored,
or rethrown as a less specific type**, and **retry/timeout/backoff with no bound**. Each
example pairs a change the review should flag with the fix that satisfies the checklist.

### 1. Resource opened without a guaranteed close

```scala
// Anti-pattern: if getLines throws, close never runs and the file handle leaks; the
// guaranteed close is missing on the error path
def firstLine(path: Path): String = {
  val source = Source.fromFile(path.toFile)
  source.getLines().next()
}

// Fix: Using closes the resource on every exit path, including exceptions
def firstLine(path: Path): String =
  Using.resource(Source.fromFile(path.toFile))(_.getLines().next())
```

### 2. Caught exception swallowed or logged-and-ignored

```scala
// Anti-pattern: the catch discards the failure, so the caller believes the operation
// succeeded and the error is invisible
def charge(userId: Long): Unit =
  try chargeCard(userId)
  catch { case _: CardDeclined => () } // swallowed: caller sees success

// Fix: propagate the failure in a typed result, so the caller decides how to react
def charge(userId: Long): Either[ChargeError, Unit] =
  try Right(chargeCard(userId))
  catch { case _: CardDeclined => Left(CardDeclined) }
```

### 3. Retry with no bound

```scala
// Anti-pattern: while(true) retries forever, so a persistently failing call blocks the
// thread indefinitely
def callWithRetry(): Response = {
  while (true) {
    try return doCall()
    catch { case _: Timeout => } // loops without bound
  }
  throw new IllegalStateException("unreachable")
}

// Fix: a visible bound on attempts, so the call terminates and the caller can react
def callWithRetry(maxAttempts: Int): Either[Timeout, Response] = {
  @tailrec
  def go(attempt: Int): Either[Timeout, Response] =
    if (attempt >= maxAttempts) Left(Timeout(maxAttempts))
    else
      try Right(doCall())
      catch { case _: Timeout => go(attempt + 1) }
  go(0)
}
```
