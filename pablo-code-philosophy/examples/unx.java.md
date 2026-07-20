# UNIX — Code Examples (Java)

### Transparency

```java
// Opaque: no way to inspect progress without side effects
class ImportJob {
    void run(List<Row> rows) {
        for (Row r : rows) { process(r); }
    }
}

// Transparent: state is inspectable without changing behavior
class ImportJob {
    private int processed;
    private int total;
    void run(List<Row> rows) {
        total = rows.size();
        for (Row r : rows) { process(r); processed++; }
    }
    Snapshot snapshot() { return new Snapshot(processed, total); } // read-only, no side effect
}
```

`snapshot()` lets a caller (a health check, a log line, a dashboard) observe progress without
instrumenting `run()` itself or changing its behavior.

### Silence Is Golden

```java
// Before: noisy
public class Deployer {
    public void deploy(String version) {
        System.out.println("Starting deployment of version " + version);
        runDeploy(version);
        System.out.println("Deployment completed successfully");
    }
}

// After: silent
public class Deployer {
    public void deploy(String version) {
        runDeploy(version); // success produces no output
    }
}
```

### Fail Early, Fail Loud

```java
// Before: swallow errors, partial results
public List<Item> processItems(List<Item> items) {
    List<Item> result = new ArrayList<>();
    for (Item item : items) {
        try {
            result.add(process(item));
        } catch (Exception e) {
            // caller doesn't know it failed
        }
    }
    return result;
}

// After: fail at the point of failure
public void processItems(List<Item> items) {
    for (Item item : items) {
        process(item); // first failure propagates with full context
    }
}
```

### Text Is the Universal Interface

```java
// Before: opaque binary format
public byte[] exportReport(Order order) { return serialize(order); }

// After: text stream, line-oriented
public String exportReport(Order order) {
    StringBuilder sb = new StringBuilder();
    sb.append("order_id: ").append(order.getId()).append("\n");
    sb.append("status: ").append(order.getStatus()).append("\n");
    sb.append("total: ").append(order.getTotal()).append("\n");
    return sb.toString();
}
// Human-readable. Pipeable. Parseable line by line.
```

### Least Surprise

```java
// Before: surprising — "get" implies read-only
public class UserService {
    public User get(String userId) {
        User user = repo.find(userId);
        if (user == null) {
            user = repo.create(userId); // side effect!
        }
        return user;
    }
}

// After: predictable
public class UserService {
    public User get(String userId) {
        return repo.find(userId); // read-only, as expected
    }

    public User getOrCreate(String userId) {
        User existing = repo.find(userId);
        return existing != null ? existing : repo.create(userId);
    }
}
```
