# KISS — Code Examples (Scala)

### Over-engineered

```scala
def parse(raw: String): ParsedResponse = {
  try {
    val root = mapper.readTree(raw)
    if (root == null || !root.isObject) ParsedResponse.failure("invalid structure")
    else {
      // ... 30 more lines of validation
      ParsedResponse.success(root)
    }
  } catch {
    case e: JsonProcessingException =>
      logger.error(s"Failed to parse: $raw", e)
      ParsedResponse.failure("parse error")
  }
}
```

### Keep it simple

```scala
def parseResponse(raw: String): Option[JsonNode] =
  Try(mapper.readTree(raw)).toOption
```

Same job. No ceremony. Add validation when the *caller* needs it, not preemptively.

### Nested calls vs. flat early-return

```scala
// Nested call chain hides the actual control flow
def handle(req: Request): Response =
  if (validate(req)) process(prepare(req)) else reject(req)
def process(req: Request): Response =
  if (authorize(req)) execute(req) else deny(req)

// Flat, early-return — the control flow is visible at the top level
def handle(req: Request): Response = {
  if (!validate(req)) return reject(req)
  if (!authorize(req)) return deny(req)
  execute(req)
}
```

### Fix the data shape, kill the conditionals

```scala
// Special cases piling up as conditionals
def fee(accountType: String): Double = accountType match {
  case "BASIC"   => 5.0
  case "PREMIUM" => 2.0
  case "VIP"     => 0.0
  case _         => throw new IllegalArgumentException()
}

// Fix the shape: the fee belongs on the type, not in a lookup chain
sealed trait AccountType { def fee: Double }
case object Basic   extends AccountType { val fee = 5.0 }
case object Premium extends AccountType { val fee = 2.0 }
case object Vip     extends AccountType { val fee = 0.0 }
```
