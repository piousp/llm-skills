# Well-formed findings: the reporting standard

This file fixes the *reporting discipline* of qa-adversary, not a bug taxonomy. It shows what a
finding looks like when it meets the contract of the output template: a concrete, reproducible
failure scenario (named inputs and state in, wrong output out) anchored to a `file:line`. Read
it before writing the report, then close it. The finding you report must come from the diff in
front of you. If you are matching an example instead of constructing a scenario, you are
manufacturing.

## Anatomy of a finding

Take example 1 below and note its five parts:

1. **Severity** - `[BLOCK]`. Justified by the blast radius: an admin gate that skips the audit
   write changes the compliance record of every order shipped by a non-internal admin.
2. **Anchor** - `services/orders/ShipmentService:88`. A line a human can open in the diff.
3. **One-line defect** - names the wrongness without proposing a fix.
4. **Failure scenario** - named inputs and state, an entry path that exists, and the wrong
   output they produce. This is the load-bearing part. "Could produce wrong totals" is not a
   scenario; `admin = true, isInternalIp = false` is.
5. **Lens** - the hunting category it came from, so the author knows which family of reasoning
   found it.

A scenario is concrete when every variable has a value, the state is named, and a real caller
can reach the path. If you cannot name those, the suspicion is a doubt, not a finding (see
Doubt vs finding).

## Lens 1: Logic-change

### 1. Admin gate narrowed from OR to AND, early return skips a required step

```pseudocode
# before: if (userIsAdmin or isInternalIp) { writeAudit(); ship() }
if (userIsAdmin and isInternalIp):
    writeAudit()
ship()
```

```
1. [BLOCK] services/orders/ShipmentService:88 - admin gate narrowed from OR to AND
   Failure scenario: admin user on an external IP (admin = true, isInternalIp = false);
   the gate fails, writeAudit() is skipped and the order ships without an audit record →
   a compliance breach no operator can trace.
   Lens: logic
```

### 2. Constraint-inversion probe: errors assumed to be values, arrive as exceptions

```pseudocode
def shouldRetry(result):
    return result == FAILURE      # caller: HTTP client throws on 5xx
```

```
2. [HIGH] services/sync/RetryPolicy:41 - retry gate reads a result value, errors arrive as
   exceptions
   Failure scenario: the sync job hits a 503 and the client throws; RetryPolicy:41 never
   sees FAILURE so shouldRetry() returns false → the job gives up on the first transient
   error and the nightly sync silently skips 12,000 records.
   Lens: logic
```

## Lens 2: Data-handling

### 3. Optional.get without presence check (Java / Scala)

```java
// services/pricing/CacheQuoteProvider.java
Price quote = cache.get(key).get();   // Optional<Price>
```

```
3. [HIGH] services/pricing/CacheQuoteProvider:57 - Optional.get without presence check
   Failure scenario: cache miss on first request for SKU-9981 (cold start);
   cache.get(key) is empty and .get() throws NoSuchElementException → the checkout page
   returns 500 instead of falling back to the database.
   Lens: data
```

### 4. Equivalence-class probe: one class of inputs behaves differently under a config flag

```pseudocode
def applyPromo(order):
    if order.items.len < 3: return 0
    return percent(order.subtotal)    # percent uses config flag promoMax
```

```
4. [MEDIUM] services/promo/Applicator:23 - eligible class pays differently under promoMax
   Failure scenario: two orders in the same class (both 4 items, subtotal 400); with
   promoMax = 50 the discount caps at 50, with promoMax = 100 it reaches 100 → identical
   inputs produce different totals under a flag the caller does not pass, so the cap = 50
   rollout bills 50 units too much per order.
   Lens: data
```

## Lens 3: Business-rule & discrepancy

### 5. Letter-vs-spirit: rule applied to ship country, ticket targets sanctioned customers

```pseudocode
def gate(order):
    if order.shipCountry in SANCTIONED: reject(order)
    allow(order)
```

```
5. [BLOCK] services/checkout/GeoGate:112 - sanction rule keys on ship country, ticket means
   billing country
   Failure scenario: customer pays from the US (billing = US) and ships a gift to a
   sanctioned country; GeoGate:112 rejects the order although the ticket targets sanctioned
   *customers* → legitimate international orders are blocked and the support queue spikes.
   Lens: business-rule
```

### 6. Implicit rule made wrong: zero-balance gate weakened from strict positive

```pseudocode
if account.balance >= 0:          # before: balance > 0
    allowWithdrawal(amount)
```

```
6. [HIGH] services/accounts/Withdrawal:31 - zero-balance check weakened from strict positive
   Failure scenario: account balance = 0, withdrawal = 50; Withdrawal:31 passes the
   balance >= 0 gate → balance becomes -50, which the accounting system treats as an
   unauthorized overdraft and flags the whole statement as invalid.
   Lens: business-rule
```

## Lens 4: Regression risk

### 7. Mutation-adequacy probe: changed line with no test that would fail

```pseudocode
# changed line: retryDelay = retryDelay * 2   (was: retryDelay * 3)
```

```
7. [MEDIUM] services/notifications/Backoff:74 - backoff multiplier changed, no test asserts
   the value
   Failure scenario: the line is reverted to * 3 and the full suite still passes (no
   assertion reads retryDelay) → the change is under-covered; a future regression in the
   retry schedule ships silently.
   Lens: regression
```

### 8. Cross-service ripple: DTO field renamed, consumer binds by shape

```json
// before: {"orderId": "..."}   after: {"id": "..."}
```

```
8. [BLOCK] services/orders/OrderEvent.kt:33 - DTO field orderId renamed to id, billing
   consumer binds by shape
   Failure scenario: the billing service deserializes OrderEvent by field name; with id
   instead of orderId its payload maps to null → every order after deploy produces an
   invoice with orderId = null and the reconciliation job drops them.
   Lens: regression
```

## Lens 5: Concurrency & state

### 9. Non-atomic read-modify-write on a balance

```pseudocode
def credit(acct, amount):
    bal = read(acct.balance)
    write(acct.balance, bal + amount)
```

```
9. [HIGH] services/ledger/Account:19 - non-atomic read-modify-write on balance
   Failure scenario: two concurrent credit() calls for the same account read 100 before
   either writes; both write 100 + 50 → final balance 150 instead of 200, one credit
   silently lost.
   Lens: concurrency
```

### 10. Idempotency: retry re-applies the charge

```pseudocode
def applyPayment(order):
    charge(order)        # no idempotency key
    notify(order)
```

```
10. [MEDIUM] services/payments/Charger:63 - retry re-applies the charge, no idempotency key
    Failure scenario: the gateway times out after charging but before responding; the
    retry charges again → the customer is billed twice for one order and the refund flow
    only fires on manual review.
    Lens: concurrency
```

## Lens 6: Oracle-hard correctness

### 11. Metamorphic relation: reordering inputs changes the decision

```pseudocode
def bestDeal(deals):
    return first(sorted(deals, by = price))    # stable sort, ties keep input order
```

```
11. [HIGH] services/pricing/DealPicker:28 - deal selection depends on input order
     Failure scenario: two deals priced 10 arrive as [A, B] then [B, A]; the stable sort
     picks whichever came first → reordering the same input set changes the winning deal,
     violating the order-independence invariant the caller relies on for consistent quotes.
     Lens: oracle
```

### 12. Metamorphic relation: filtered search drops matches the unfiltered one finds

```pseudocode
def search(q, filters):
    rows = index.query(q)              # page 1 only
    return rows.filter(filters)
```

```
12. [MEDIUM] services/search/Resolver:52 - filter applied after paging drops matches
     Failure scenario: 25 rows match query q, 5 of them beyond page 1; the resolver pages
     the unfiltered list and filters page 1 only → the filtered search returns 0 rows
     while the unfiltered search returns 25; a filtered query must never return fewer
     matches than its unfiltered superset.
     Lens: oracle
```

## Lens 7: Failure & degradation

### 13. Assumed-dependency probe: partial upstream response assumed complete

```pseudocode
def enrich(order):
    rows = upstream.query(order.id)       # assumes a full response
    return order.withLines(rows.items)    # NPE if items is absent
```

```
13. [HIGH] services/orders/Enricher:90 - upstream partial response assumed complete
     Failure scenario: the catalog service times out mid-response and returns a body
     without items; Enricher:90 dereferences rows.items → the order page crashes with an
     NPE instead of showing the order with a degraded "catalog unavailable" note.
     Lens: degradation
```

### 14. Error code changed; operators filter on the old one (honest downgrade to LOW)

```pseudocode
# before: return 404   after: return 400
```

```
14. [LOW] services/ingest/Handler:61 - error code changed from 404 to 400
     Failure scenario: operator dashboards filter on 404 to find dropped files; the new
     400 makes those files invisible in the 404 view → the on-call rotation misses the
     alert until the ingest queue backs up. Low blast: no automated consumer parses the
     code, only the manual view.
     Lens: degradation
```

## Doubt vs finding

A suspicion without a scenario is a doubt. It belongs in Open Questions, not Findings. It
becomes a finding the moment a concrete scenario exists.

Suspicion: "the dedup guard may double-apply when a message is redelivered."

- As a doubt (correct, no scenario yet): "Open Questions: dedup guard at
  services/queue/QueueConsumer:22 - does at-least-once redelivery double-apply? No
  redelivery path is visible in the diff to confirm."
- Promoted to a finding (scenario found): "1. [MEDIUM] services/queue/QueueConsumer:22 -
  dedup guard keyed on msg.id with no processed store. Failure scenario: the consumer
  restarts after apply() but before the ack; the poll re-sends the same msg and the guard
  does not recognize it → the change is applied twice. Lens: concurrency"

Some doubts never resolve, and that is fine. They stay open, named, with the missing piece
identified. A report with a sharp Open Questions section and zero findings is a valid result.
