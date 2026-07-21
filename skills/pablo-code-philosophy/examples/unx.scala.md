# UNIX — Code Examples (Scala)

### Transparency

```scala
// Opaque: no way to inspect progress without side effects
class ImportJob {
  def run(rows: List[Row]): Unit = rows.foreach(process)
}

// Transparent: state is inspectable without changing behavior
class ImportJob {
  private var processed = 0
  private var total = 0
  def run(rows: List[Row]): Unit = {
    total = rows.size
    rows.foreach { r => process(r); processed += 1 }
  }
  def snapshot: Snapshot = Snapshot(processed, total) // read-only, no side effect
}
```

`snapshot` lets a caller (a health check, a log line, a dashboard) observe progress without
instrumenting `run()` itself or changing its behavior.

### Silence Is Golden

```scala
// Before: noisy
class Deployer {
  def deploy(version: String): Unit = {
    println(s"Starting deployment of version $version")
    runDeploy(version)
    println("Deployment completed successfully")
  }
}

// After: silent
class Deployer {
  def deploy(version: String): Unit = runDeploy(version) // success produces no output
}
```

### Fail Early, Fail Loud

```scala
// Before: swallow errors, partial results
def processItems(items: List[Item]): List[Item] = {
  items.flatMap { item =>
    try {
      Some(process(item))
    } catch {
      case _: Exception => None // caller doesn't know it failed
    }
  }
}

// After: fail at the point of failure
def processItems(items: List[Item]): List[Item] = {
  items.foreach(process(_)) // first failure propagates with full context
  items
}
```

### Text Is the Universal Interface

```scala
// Before: opaque binary format
def exportReport(order: Order): Array[Byte] = serialize(order)

// After: text stream, line-oriented
def exportReport(order: Order): String = {
  s"""order_id: ${order.id}
     |status: ${order.status}
     |total: ${order.total}
     |items:
     |${order.items.map(i => s"  - ${i.name}: ${i.price}").mkString("\n")}
     |""".stripMargin
}
// Human-readable. Pipeable. Parseable line by line.
```

### Least Surprise

```scala
// Before: surprising — "get" implies read-only
class UserService {
  def get(userId: String): User =
    repo.find(userId).getOrElse(repo.create(userId)) // side effect!
}

// After: predictable
class UserService {
  def get(userId: String): Option[User] = repo.find(userId) // read-only, as expected
  def getOrCreate(userId: String): User = repo.find(userId).getOrElse(repo.create(userId))
}
```
