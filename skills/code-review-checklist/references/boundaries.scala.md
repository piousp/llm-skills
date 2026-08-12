# Boundaries examples: Scala

Where does this code live, and what does it touch? This file covers: **business logic in
controller/handler/entry point**, **side effects mixed with pure computation**,
**implicit dependency instead of explicit injection**, **brain-damaged API** (interface
shape that makes the common case awkward to call), and **object orgy** (a caller reaching
through an object's internals). Each example pairs a change the review should flag with
the fix that satisfies the checklist.

### 1. Business logic in the entry point, reaching through internals

```scala
// Anti-pattern: the controller parses, validates, computes and persists, and it reaches
// through order.getCustomer.getAddress to pull a city
def handle(req: Request): Response = {
  val city = order.getCustomer.getAddress.getCity // object orgy
  val discount = if (city == "San Jose") 0.1 else 0.0 // business rule in the handler
  saveOrder(order, discount)
  Response(200)
}

// Fix: the controller delegates to a service method and asks the object for the answer,
// so the entry point stays thin
def handle(req: Request): Response = {
  orderService.create(req.order) // thin entry point
  Response(200)
}
```

### 2. Implicit dependency instead of explicit injection

```scala
// Anti-pattern: the function pulls its dependencies from a global, so the caller cannot
// see what it needs and tests cannot substitute a fake
def createOrder(order: Order): Unit =
  Database.getInstance().save(order) // hidden dependency

// Fix: take the dependency as a parameter, so the caller sees it and tests inject a fake
def createOrder(order: Order, db: Database): Unit =
  db.save(order)
```

### 3. Side effects mixed with pure computation

```scala
// Anti-pattern: computeTotal logs and persists while computing, so the caller cannot
// reuse the math without repeating the effects
def computeTotal(items: Seq[Item]): BigDecimal = {
  val total = items.map(_.price).sum
  logger.info(s"total: $total") // side effect inside the computation
  saveTotal(total)              // side effect inside the computation
  total
}

// Fix: the pure function returns the value; the caller decides when to log or persist
def computeTotal(items: Seq[Item]): BigDecimal =
  items.map(_.price).sum
```

### 4. Brain-damaged API: common case awkward to call

```scala
// Anti-pattern: the common case needs eight arguments, so every call site repeats the
// same defaults and a wrong retry value slips in
def sendEmail(from: String, to: String, subject: String, body: String,
              retries: Int, cc: List[String], bcc: List[String], timeout: Long): Unit

// Fix: focused signature with defaults, so the common case is one obvious call and the
// knobs stay available
def sendEmail(to: String, subject: String, body: String,
              cc: List[String] = Nil, bcc: List[String] = Nil,
              retries: Int = 0, timeout: Long = 5000L): Unit
```
