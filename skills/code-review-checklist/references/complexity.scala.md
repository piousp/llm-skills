# Complexity examples: Scala

Can a reader follow this function top to bottom in one breath? This file covers:
**function exceeding 25 lines or cyclomatic complexity > 5**, **nested conditionals
deeper than 2 levels**, **voodoo programming** (retries, barriers, sleeps with no comment
explaining why), and **hack upon hack** (a new workaround layered on an existing
workaround). Each example pairs a change the review should flag with the fix that
satisfies the checklist.

### 1. Long function with deep nesting

```scala
// Anti-pattern: the method runs past 25 lines and nests if inside if inside forEach,
// so the reader must hold several branches in memory at once
def process(orders: List[Order]): List[String] = {
  val result = ListBuffer.empty[String]
  orders.foreach { order =>
    if (order.isValid) {
      order.items.foreach { item =>
        if (item.available) {
          result += item.name
        }
      }
    }
  }
  result.toList
}

// Fix: flat filters and single-level steps keep each line obvious and the function
// under the size budget
def process(orders: List[Order]): List[String] =
  orders.filter(_.isValid)
        .flatMap(_.items)
        .filter(_.available)
        .map(_.name)
```

### 2. Voodoo programming: magic sleep with no explanation

```scala
// Anti-pattern: a fixed sleep before the call has no comment, so the reader cannot tell
// whether it papers over a race, a warmup, or a mistake
def callAfterWarmup(): Response = {
  Thread.sleep(1000) // why?
  service.call()
}

// Fix: explain the reason in a comment, or remove the magic; if it hides a real race,
// fix the race instead
def callAfterWarmup(): Response = {
  // The pool needs one beat to register the new worker; remove once the pool is fixed
  Thread.sleep(1000)
  service.call()
}
```

### 3. Hack upon hack

```scala
// Anti-pattern: each fix patches the previous patch instead of the source: a bad
// serialization format is trimmed, then null-checked, then double-parsed
def parse(raw: String): Int =
  raw.trim
     .replaceAll("\\s", "")
     .toIntOption
     .getOrElse(0) // second workaround layered on the first

// Fix: fix the root cause at the source, so the workarounds disappear
def parse(raw: String): Int = raw.toInt // the writer now emits clean integers
```
