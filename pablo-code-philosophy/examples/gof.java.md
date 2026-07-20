# GoF — Code Examples (Java)

### Premature Strategy — one implementation, no second in sight

```java
public interface DiscountStrategy { BigDecimal apply(BigDecimal price); }
public class StandardDiscount implements DiscountStrategy {
    public BigDecimal apply(BigDecimal price) { return price; }
}
// One implementation, no plan for a second.
```

### Earns its keep — real, growing variation

```java
public interface DiscountStrategy { BigDecimal apply(BigDecimal price); }
public class SeasonalDiscount implements DiscountStrategy { /* ... */ }
public class LoyaltyDiscount implements DiscountStrategy { /* ... */ }
public class BundleDiscount implements DiscountStrategy { /* ... */ }
// Selected by config; new discount types ship without touching existing ones.
```

### FP subsumes GoF — no shared state, a lambda replaces the hierarchy

```java
Function<BigDecimal, BigDecimal> seasonal = price -> price.multiply(BigDecimal.valueOf(0.9));
Function<BigDecimal, BigDecimal> loyalty = price -> price.subtract(BigDecimal.valueOf(5));
// Selected by config; a Function reference plays the Strategy role directly.
```

Reach for the interface + implementing classes only when a variant needs to carry state or
there are real, growing implementations — otherwise a `Function` is the natural Strategy.

### Builder earning its keep vs. ceremony

```java
// Telescoping constructor — unreadable at the call site
new Report(true, false, "PDF", null, 30);

// Builder earns its keep: many optional params, self-documenting
Report report = Report.builder()
    .includeCharts(true)
    .format("PDF")
    .timeoutSeconds(30)
    .build();
```

Worth it once optional parameters pile up. For 2–3 params, a constructor plus overloads is
simpler — don't reach for Builder preemptively.
