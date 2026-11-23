# Worked Examples

One resolved example per category (plus one for the A3 "Redundant derived field" row), one
candidate filtered by the gate (N1), and one candidate filtered by N9 (copy in another repo). Each shows the
before-snippet (as it appears in a branch's diff) and the exact block it produces.

## A1: Structural duplication (Java)

Branch diff adds `computeInvoiceTotal` to `InvoiceService.java`; `computeRefundTotal`, identical
except for its line type, already exists in the same file, untouched by this branch.

```java
// InvoiceService.java:41 (touched by this branch)
double computeInvoiceTotal(List<InvoiceLine> lines) {
    double total = 0;
    for (InvoiceLine l : lines) { total += l.getAmount() * l.getQuantity(); }
    return total;
}

// InvoiceService.java:58 (pre-existing, not touched)
double computeRefundTotal(List<RefundLine> lines) {
    double total = 0;
    for (RefundLine l : lines) { total += l.getAmount() * l.getQuantity(); }
    return total;
}
```

```markdown
#### [RF-1] A1 Structural duplication (same algorithm, different type): P1
- Evidence: `InvoiceService.java:41`, `InvoiceService.java:58` (2 occurrences, identical modulo type: `InvoiceLine` vs `RefundLine`; count: `grep -rnF "l.getAmount() * l.getQuantity()" --include=*.java .` → 2 hits)
- Anchored in branch: `InvoiceService.java:41` (added hunk)
- Gate: passes; closest row N2 doesn't apply because both apply the same line-total rule, amount × quantity, through the same accessors; a change to that rule changes both
- Refactor direction: extract one line-total helper that takes the amount and quantity accessors as parameters → see `pablo-code-philosophy` `references/fp/mechanics.md` recognition table, "same three-line transformation... copy-pasted" row (direction only; the how lives there)
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
- Evidence: `OrderTracker.scala:14` (getter), `OrderTracker.scala:13` (field) (escapes: `mutable.ListBuffer[Order]`, returned live with no copy); also: A2 Public mutable field
- Anchored in branch: `OrderTracker.scala:12-15` (added hunk)
- Gate: passes; closest row N3 doesn't apply because returning `pendingOrders.toList` is no more complex than returning the buffer
- Refactor direction: return an immutable snapshot (`pendingOrders.toList`) and keep the
  mutable buffer private → see `pablo-code-philosophy` `references/fp/mechanics.md`
  Immutability section (direction
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
  `OrderService.java:33` (2 null-checks on the same producer's result; count:
  `grep -rnF ".findById(" --include=*.java .` → 2 hits)
- Anchored in branch: `CustomerLookup.java:104`, `OrderService.java:33` (both added hunks)
- Gate: passes; closest row N6 doesn't apply because there are 2 checking call sites, not 1
- Refactor direction: change `findById` to return `Optional<Customer>` → see
  `pablo-code-philosophy` `references/fp/java.md`, `Optional` "Return type, not parameter
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

`PaymentView.scala` entered only through the occurrence count (Scope law 4): the branch changes no
symbol that file defines or uses, so it lies outside the 1-hop radius. Replacing the flag edits
that file, so the fix exceeds 1-hop context: P3. The root-cause line, the flag's declaration in
`PaymentStatus.scala`, pre-exists, so the branch-added dispatch site alone could never make it P1.

```markdown
#### [RF-1] A4 Duplicated dispatch over the same enum/flag: P3
- Evidence: `PaymentView.scala:22`, `PaymentNotifier.scala:45` (2 dispatch sites over the same `Int` status flag, 3 variants each; count: `grep -rn "status match" --include=*.scala .` → 2 hits)
- Anchored in branch: `PaymentNotifier.scala:45` (added hunk)
- Gate: passes; closest row N5 doesn't apply because there are 3 variants, not 2 trivial ones
- Refactor direction: replace the `Int` flag with a sealed `PaymentStatus` ADT
  (`Pending`/`Settled`/`Failed`) and match on it → see `pablo-code-philosophy`
  `references/fp/scala.md` sealed trait + case classes + match section (direction only; the how
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

## Filtered by N9: duplicate whose other copy lives in another repo (Java)

Branch diff adds `qualifiesForFreeShipping` to `ShippingCalculator.java`, encoding an
eligibility predicate; the caller's prompt says the same predicate is also used in the separate pricing-engine repo.

```java
// ShippingCalculator.java:2 (touched by this branch)
boolean qualifiesForFreeShipping(Customer customer, Order order) {
    return customer.getTier() == Tier.PREMIUM && order.getTotal() > 500;
}
```

This repo has 1 local occurrence (threshold ≥2). The caller points to a copy outside this repo, so step 8 carries it to the gate instead of filtering it as below threshold. The pricing-engine repo is not checked out here. A cross-repo helper is P3 at best, so N9 sends it to one Filtered out line naming the repo; it is never a Finding and never silently dropped.

```markdown
### Filtered out
- A1 Business-rule duplication at `ShippingCalculator.java:2`, filtered by N9 (other copy, if any, lives in pricing-engine; not checkable here, and a cross-repo fix is P3 at best)
```

## A3: Redundant derived field (Java)

Branch diff adds a `fullName` field to `Customer.java`, set once in the constructor from two
fields the same class already holds.

```java
// Customer.java:9 (touched by this branch: lines 12 and 17 are added)
class Customer {
    private final String firstName;
    private final String lastName;
    private final String fullName;

    Customer(String firstName, String lastName) {
        this.firstName = firstName;
        this.lastName = lastName;
        this.fullName = firstName + " " + lastName;
    }
}
```

```markdown
#### [RF-1] A3 Redundant derived field: P1
- Evidence: `Customer.java:12` (`fullName` duplicates `firstName` + `lastName`, both held by the
  same object)
- Anchored in branch: `Customer.java:12`, `Customer.java:17` (both added hunks)
- Gate: passes; closest row N8 doesn't apply because removing the field eliminates a second source of truth, not a trivial extract
- Refactor direction: derive `fullName()` as a method at the point of use instead of storing it
  → see `pablo-code-philosophy` `references/principles/KISS.md`, "No field that another field
  already carries" (direction only; the how lives there)
```
