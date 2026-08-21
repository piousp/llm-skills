# Worked Examples

One resolved example per category, one candidate filtered by the gate, and one candidate left
Unresolved (N9). Each shows the before-snippet (as it appears in a branch's diff) and the exact
block it produces.

## A1: Structural duplication (Java)

Branch diff adds `computeInvoiceTotal` to `InvoiceService.java`; a nearly identical method
`computeRefundTotal` already exists in the same file, untouched by this branch.

```java
// InvoiceService.java:41 (touched by this branch)
double computeInvoiceTotal(List<LineItem> items) {
    double total = 0;
    for (LineItem i : items) { total += i.getAmount() * i.getQuantity(); }
    return total;
}

// InvoiceService.java:58 (pre-existing, not touched)
double computeRefundTotal(List<LineItem> items) {
    double total = 0;
    for (LineItem i : items) { total += i.getAmount() * i.getQuantity(); }
    return total;
}
```

```markdown
#### [RF-1] A1 Structural duplication (same algorithm, different type): P1
- Evidence: `InvoiceService.java:41`, `InvoiceService.java:58` (2 occurrences, identical
  loop/accumulation shape; only the method name differs, no type difference)
- Anchored in branch: `InvoiceService.java:41` (added hunk)
- Gate: checked N1–N9, passes; N3 doesn't apply because extracting a shared
  `lineItemsTotal(items)` helper is strictly shorter and equally readable
- Refactor direction: extract a shared `lineItemsTotal(List<LineItem>)` helper → see
  `functional-programming` recognition table, "same three-line transformation... copy-pasted"
  row (direction only; the how lives there)
```

## A2: Weak encapsulation (Scala)

Branch diff adds a `var` field and a getter that leaks the backing mutable collection.

```scala
// OrderTracker.scala:12 (touched by this branch)
class OrderTracker {
  var pendingOrders: mutable.ListBuffer[Order] = mutable.ListBuffer.empty
  def getPending: mutable.ListBuffer[Order] = pendingOrders
}
```

```markdown
#### [RF-1] A2 Mutable internals escaping: P1
- Evidence: `OrderTracker.scala:13` (getter returns the live `ListBuffer`, no copy; escapes:
  `mutable.ListBuffer[Order]`)
- Anchored in branch: `OrderTracker.scala:12-13` (added hunk)
- Gate: checked N1–N9, passes; N3 doesn't apply, returning `.toList` is not more complex
- Refactor direction: return an immutable snapshot (`pendingOrders.toList`) and keep the
  mutable buffer private → see `functional-programming` Immutability principle (direction
  only; the how lives there)
```

## A3: Poor data types (Java)

Branch diff adds a second call site that null-checks the same producer's return value.

```java
// CustomerLookup.java:77 (pre-existing producer, not touched)
Customer findById(String id) {
    return repository.find(id).orElse(null);
}

// CustomerLookup.java:104 (touched by this branch; first null-check)
Customer c = lookup.findById(id);
if (c != null) { ... }

// OrderService.java:33 (touched by this branch; second null-check)
Customer c = customerLookup.findById(order.getCustomerId());
if (c == null) { throw new IllegalStateException("no customer"); }
```

```markdown
#### [RF-1] A3 null as domain absence: P2
- Evidence: `CustomerLookup.java:77` (producer), `CustomerLookup.java:104`,
  `OrderService.java:33` (2 null-checks on the same producer's result)
- Anchored in branch: `CustomerLookup.java:104`, `OrderService.java:33` (both added hunks)
- Gate: checked N1–N9, passes; N6 doesn't apply because there are 2 checking call sites, not 1
- Refactor direction: change `findById` to return `Optional<Customer>` → see
  `functional-programming` `references/java.md`, `Optional` "Return type, not parameter
  type" guidance (direction only; the how lives there)
```

## A4: Flag/enum-modeled variants (Scala)

Branch diff adds a second `match` over the same status flag that already had one dispatch site.

```scala
// PaymentStatus.scala: status: Int (0 = pending, 1 = settled, 2 = failed)

// PaymentView.scala:22 (pre-existing dispatch, not touched)
status match {
  case 0 => "Pending"
  case 1 => "Settled"
  case 2 => "Failed"
}

// PaymentNotifier.scala:45 (touched by this branch; second dispatch, same discriminator)
status match {
  case 0 => sendPendingEmail(payment)
  case 1 => sendReceiptEmail(payment)
  case 2 => sendFailureEmail(payment)
}
```

```markdown
#### [RF-1] A4 Duplicated dispatch over the same enum/flag: P2
- Evidence: `PaymentView.scala:22`, `PaymentNotifier.scala:45` (2 dispatch sites over the
  same `Int` status flag, 3 variants each)
- Anchored in branch: `PaymentNotifier.scala:45` (added hunk)
- Gate: checked N1–N9, passes; N5 doesn't apply because there are 3 variants, not 2 trivial ones
- Refactor direction: replace the `Int` flag with a sealed `PaymentStatus` ADT
  (`Pending`/`Settled`/`Failed`) and match on it → see `functional-programming`
  `references/scala.md` sealed trait + case classes + match section (direction only; the how
  lives there)
```

## Filtered by the gate: speculative Strategy (Java)

Branch diff adds a single new discount calculation with no second implementation planned.

```java
// DiscountCalculator.java:9 (touched by this branch)
double applyDiscount(Order order) {
    if (order.getTotal() > 100) { return order.getTotal() * 0.9; }
    return order.getTotal();
}
```

This looks like an A1/A4 candidate (a branching rule that "could" become a Strategy), but only
one discount rule exists and the branch introduces no second one.

```markdown
### Filtered out
- Single-implementation branching mistaken for a Strategy candidate at
  `DiscountCalculator.java:9-12`, filtered by N1 (only one discount rule exists, no second
  implementation is planned by this branch)
```

## Unresolved (N9): business-rule occurrence count decided by another repo (Java)

Branch diff adds `qualifiesForFreeShipping` to `ShippingCalculator.java`, encoding the same
eligibility predicate already used once elsewhere in this repo, in `OrderValidator.java`.

```java
// OrderValidator.java:2 (pre-existing, not touched)
boolean isEligibleForLoyaltyDiscount(Customer customer, Order order) {
    return customer.getTier() == Tier.PREMIUM && order.getTotal() > 500;
}

// ShippingCalculator.java:2 (touched by this branch)
boolean qualifiesForFreeShipping(Customer customer, Order order) {
    return customer.getTier() == Tier.PREMIUM && order.getTotal() > 500;
}
```

This repo has only 2 occurrences of the predicate, below the business-rule duplication
threshold (>=3, 3-strikes). But the same predicate is also known to be encoded somewhere in
the mds-pricing-engine repo, which is not checked out here. Whether this candidate clears the
threshold (a Finding) or stays below it (correctly not a candidate at all) depends on a fact
this repo cannot supply, so the evidence-ceiling rule blocks a verdict either way rather than
assuming the occurrence count locally observed is the true count.

```markdown
### Unresolved (needs out-of-scope evidence)
- [RF-U1] A1 Business-rule duplication at `ShippingCalculator.java:2` (`customer.getTier() ==
  Tier.PREMIUM && order.getTotal() > 500`, 2 occurrences locally, below the >=3 threshold),
  missing fact: does a 3rd occurrence of this predicate exist in mds-pricing-engine, resolves
  via: `grep-across-repos` on mds-pricing-engine for the same eligibility predicate
```
