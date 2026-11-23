# Well-formed findings: the reporting standard

This file fixes the *reporting discipline* of qa-adversary, not a bug taxonomy. It shows what a
finding looks like when it meets the contract of the output template: a concrete, reproducible
failure scenario (named inputs and state in, wrong output out) anchored to a `file:line`, with
every premise placed in the diff or 1 hop away. Read it before writing the report, then close
it. The finding you report must come from the diff in front of you. If you are matching an
example instead of constructing a scenario, you are manufacturing.

## Anatomy of a finding

Take example 1 below and note its six parts:

1. **Severity** - `[BLOCK]`. It meets the BLOCK clause: the default path loses data (the audit
   record) for ordinary inputs, and the caller is named on the Premises line.
2. **Anchor** - `services/orders/ShipmentService.kt:88:`. Path with extension, line, colon.
3. **One-line defect** - names the wrongness without proposing a fix.
4. **Failure scenario** - named inputs and state, an entry path that exists, and the wrong
   output they produce. This is the load-bearing part. "Could produce wrong totals" is not a
   scenario; `admin = false, isInternalIp = true` is.
5. **Premises** - every fact the scenario rests on, each with its `file:line` tagged `(diff)`
   or `(1 hop, read)`, plus the quoted rule when the severity rests on one. A premise that
   fits neither tag makes the item an Open Question (SKILL.md Scope law).
6. **Lens** - the hunting category it came from.

A scenario is concrete when every variable has a value, the state is named, and a real caller
can reach the path. If you cannot name those, the suspicion is a doubt, not a finding (see
Doubt vs finding).

## Lens 1: Logic-change

### 1. Audit gate narrowed from OR to AND

```pseudocode
# before: if (userIsAdmin or isInternalIp): writeAudit()
if (userIsAdmin and isInternalIp):
    writeAudit()
ship()
```

```
1. [BLOCK] services/orders/ShipmentService.kt:88: audit gate narrowed from OR to AND
   Failure scenario: a regular employee on the office network (admin = false,
   isInternalIp = true) ships order 1042; the AND gate skips writeAudit() and ship() still
   runs → every order shipped by a non-admin internal user leaves no audit record.
   Premises: ShipmentService.kt:86-89 (diff); OrderController.kt:57 calls ship() on every
   checkout (1 hop, read)
   Lens: logic
```

### 2. Constraint-inversion probe: errors assumed to be values, arrive as exceptions

```pseudocode
# before: try: client.fetch(page) except HttpServerError: retry(page)
def syncPage(page):
    result = client.fetch(page)
    if result == FAILURE:
        retry(page)
```

While `client` comes from an external library, its 5xx behavior is a premise outside scope,
so the suspicion is a doubt:
```
- services/sync/SyncJob.kt:41 - every transient 5xx ends the sync with no retry if fetch()
  throws instead of returning FAILURE; does it? - read how the HTTP library is configured
  to report 5xx (exception or status)
```

When `fetch()` is defined in the same repo and read (1 hop), it is a finding:
```
2. [HIGH] services/sync/SyncJob.kt:41: retry branch checks a FAILURE value, 5xx errors
   arrive as exceptions
   Failure scenario: syncPage(7) while the upstream answers 503; fetch() throws
   HttpServerError before line 42 runs, so retry(7) never fires → the job stops on its
   first transient error.
   Premises: SyncJob.kt:40-43 (diff); SyncClient.kt:27 throws HttpServerError on status
   >= 500 (1 hop, read); NightlyScheduler.kt:12 calls syncPage() (1 hop, read)
   Lens: logic
```

## Lens 2: Data-handling

### 3. Optional.get without presence check (Java / Scala)

```java
// services/pricing/CacheQuoteProvider.java
// before: Price quote = cache.get(key).orElseGet(() -> db.quote(key));
Price quote = cache.get(key).get();   // Optional<Price>
```

```
3. [HIGH] services/pricing/CacheQuoteProvider.java:57: Optional.get without presence check
   Failure scenario: first quote for SKU-9981 after a restart (cold cache); cache.get(key)
   is empty and .get() throws NoSuchElementException → checkout returns 500 where the
   removed fallback read the price from the database.
   Premises: CacheQuoteProvider.java:57 (diff, fallback removed); CheckoutController.java:44
   calls quote() (1 hop, read)
   Lens: data
```

### 4. Equivalence-class probe: one class of inputs split by line layout

```pseudocode
# before: if sum(item.qty for item in order.items) < 3: return 0
def applyPromo(order):
    if len(order.items) < 3: return 0
    return percent(order.subtotal)
```

```
4. [MEDIUM] services/promo/Applicator.kt:23: promo eligibility now counts lines, not units
   Failure scenario: order A has one line with qty 3 (subtotal 300), order B three lines
   with qty 1 (subtotal 300); both are 3 units and both got the promo before, now A gets 0
   and B keeps it → before → after: intended?
   Premises: Applicator.kt:23 (diff); no ticket line covers the change
   Lens: data
```

## Lens 3: Business-rule & discrepancy

### 5. Letter-vs-spirit: gate meets the acceptance criterion, misses the ticket's goal

```pseudocode
def gate(order):
    if order.shipCountry in SANCTIONED: reject(order)
    allow(order)
```

```
5. [HIGH] services/checkout/GeoGate.kt:112: sanction gate checks the ship country only, the
   ticket's goal targets the billing country
   Failure scenario: a customer billed in a sanctioned country (billing = IR) ships to the
   US (ship = US); GeoGate.kt:112 allows the order → a sanctioned customer completes the
   purchase the ticket exists to stop.
   Premises: GeoGate.kt:112 (diff); the ticket, Goal: "customers billed in a sanctioned
   country must not complete a purchase"; AC 1 ("reject when the shipping country is
   sanctioned") is met to the letter only
   Lens: business-rule
```
HIGH, not BLOCK: a quoted-rule violation is rated at least HIGH, and no data is lost.

### 6. Implicit rule made wrong: zero-balance gate weakened from strict positive

```pseudocode
if account.balance >= 0:          # before: balance > 0
    allowWithdrawal(amount)
```

```
6. [MEDIUM] services/accounts/Withdrawal.kt:31: zero-balance accounts can now withdraw
   Failure scenario: balance = 0, withdrawal = 50; the gate passes and the balance becomes
   -50, where before the request was rejected → before → after: intended?
   Premises: Withdrawal.kt:31 (diff); Withdrawal.kt:40 allowWithdrawal() debits without a
   balance check (1 hop, read); no ticket or wiki line states the rule
   Lens: business-rule
```
MEDIUM, not HIGH: the rule is inferred from the pre-change code, not quoted.

## Lens 4: Regression risk

### 7. Changed line with no integration test: Integration Coverage line, not a Finding

```pseudocode
# changed line: retryDelay = retryDelay * 2   (was: retryDelay * 3)
```

Not a Finding: the ticket asks for the new multiplier, and no integration test exercises the
changed line. It goes on the Integration Coverage line, naming the one missing assertion:
```
- services/notifications/Backoff.kt:74 (retry multiplier 3 → 2): NOT COVERED (no test reads
  retryDelay; missing: assert the 2nd retry waits 2× the first)
```
Whether a unit test can fail is graded by `pablo-test-review`, not here.

### 8. Cross-service ripple: DTO field renamed, consumer binds by name

```json
// before: {"orderId": "..."}   after: {"id": "..."}
```

Consumer in another repo: an Open Question, even after a read confirms it:
```
- services/orders/OrderEvent.kt:33 - invoices lose their orderId after deploy if billing
  binds OrderEvent by field name; does it? - billing-service repo, InvoiceMapper: cite the
  "orderId" binding (the item stays a question)
```

Consumer in the same repo, read (1 hop): a finding:
```
8. [BLOCK] services/orders/OrderEvent.kt:33: DTO field orderId renamed to id, the invoice
   mapper still reads "orderId"
   Failure scenario: order 1042 is published as {"id": "1042"}; InvoiceMapper reads
   json["orderId"], gets null and stores the invoice with orderId = null → every invoice
   after deploy loses its order link.
   Premises: OrderEvent.kt:33 (diff); billing/InvoiceMapper.kt:41 reads "orderId"
   (1 hop, read)
   Lens: regression
```

## Lens 5: Concurrency & state

### 9. Non-atomic read-modify-write on a balance, with an evidenced concurrent caller

```pseudocode
# before: UPDATE account SET balance = balance + :amount
def credit(acct, amount):
    bal = read(acct.balance)
    write(acct.balance, bal + amount)
```

```
9. [HIGH] services/ledger/Account.kt:19: non-atomic read-modify-write replaces the atomic
   update
   Failure scenario: two POST /accounts/77/credit requests of 50 arrive together; both read
   100 before either writes and both write 150 → final balance 150 instead of 200, one
   credit lost.
   Premises: Account.kt:19-21 (diff); AccountController.kt:52 maps POST /credit to credit()
   on the multi-threaded request pool (1 hop, read)
   Lens: concurrency
```
Without the controller line there is no evidenced concurrent caller, and the race is an Open
Question.

### 10. Idempotency: the diff drops the key, the retry stays

```pseudocode
# before: charge(order, idempotencyKey = order.id)
def applyPayment(order):
    charge(order)
    notify(order)
```

```
10. [MEDIUM] services/payments/Charger.kt:63: idempotency key dropped from the charge call
    Failure scenario: the gateway call for order 881 times out after the charge lands; the
    retry calls applyPayment(881) again with no key → the customer is charged twice.
    Premises: Charger.kt:63 (diff, key removed); Charger.kt:58 wraps applyPayment() in
    retry(maxAttempts = 3) on timeout (1 hop, read)
    Lens: concurrency
```

## Lens 6: Oracle-hard correctness

### 11. Metamorphic relation: reordering inputs changes the decision

```pseudocode
# before: sorted(deals, by = (price, dealId))
def bestDeal(deals):
    return first(sorted(deals, by = price))    # stable sort, ties keep input order
```

```
11. [HIGH] services/pricing/DealPicker.kt:28: tie-breaker removed, the winning deal now
    depends on input order
    Failure scenario: deals A and B, both priced 10, arrive as [A, B] in one quote and
    [B, A] in the next; the stable sort keeps input order → the same input set wins A, then
    B, and the customer sees two different quotes.
    Premises: DealPicker.kt:28 (diff); QuoteService.kt:40 passes deals in the order the two
    pricing feeds respond (1 hop, read)
    Lens: oracle
```

### 12. Metamorphic relation: filtered search drops matches the unfiltered one finds

```pseudocode
def search(q, filters):
    rows = index.query(q)              # page 1 only
    return rows.filter(filters)
```

```
12. [MEDIUM] services/search/Resolver.kt:52: filter applied after paging drops matches
    Failure scenario: 25 rows match q and the 5 that also match filter f sit beyond row 20;
    search(q, f) filters page 1 only → it returns 0 rows, although every unfiltered row
    that matches f must appear in the filtered result.
    Premises: Resolver.kt:52-53 (diff); SearchIndex.kt:18 returns 20 rows per page
    (1 hop, read)
    Lens: oracle
```

## Lens 7: Failure & degradation

### 13. Assumed-dependency probe: the diff removes the guard for a partial response

```pseudocode
# before: return order.withLines(rows.items.orEmpty())
def enrich(order):
    rows = upstream.query(order.id)
    return order.withLines(rows.items)    # items is nullable
```

```
13. [HIGH] services/orders/Enricher.kt:90: empty-items guard removed, a partial upstream
    response now crashes the order page
    Failure scenario: the catalog answers order 5531 with a body that has no items field;
    rows.items is null and withLines() dereferences it → the order page returns 500
    instead of the order without lines.
    Premises: Enricher.kt:90 (diff, orEmpty() removed); CatalogResponse.kt:12 declares
    items nullable (1 hop, read); OrderPageController.kt:31 calls enrich() (1 hop, read)
    Lens: degradation
```

### 14. Error code changed, no consumer found (honest downgrade to LOW)

```pseudocode
# before: return 404   after: return 400
```

The changed output contract, with no consumer found, is a LOW finding; the search goes on
the Premises line:
```
14. [LOW] services/ingest/Handler.kt:61: missing-file response changed from 404 to 400
    Failure scenario: a request for /in/missing.csv, absent from the store, now gets 400
    instead of 404 → a caller can no longer tell "not found" from "bad request";
    before → after: intended?
    Premises: Handler.kt:61 (diff); no caller in this repo branches on either code
    (grep "404|400" over services/, read)
    Lens: degradation
```

Operator dashboards live outside the repo, so the bigger impact stays a doubt:
```
- services/ingest/Handler.kt:61 - dropped files vanish from any operator view that filters
  on 404; does one exist? - read the ingest dashboard and alert queries for status 404
```

## Doubt vs finding

A suspicion without a scenario is a doubt. It belongs in Open Questions, not Findings. It
becomes a finding the moment a concrete scenario exists and every premise is in scope.

Suspicion: "the dedup guard may double-apply when a message is redelivered."

- As a doubt (correct, no scenario yet):
  ```
  - services/queue/QueueConsumer.kt:22 - a redelivered message is applied twice if the
    dedup guard misses it; can redelivery reach this consumer? - read the ack order in
    QueueConsumer.kt
  ```
- Promoted to a finding (scenario found, premises read):
  ```
  1. [MEDIUM] services/queue/QueueConsumer.kt:22: dedup guard keeps processed ids in memory
     only
     Failure scenario: the consumer restarts after apply(msg 314) but before the ack; the
     broker re-sends msg 314 and the empty in-memory set does not recognize it → the
     change is applied twice.
     Premises: QueueConsumer.kt:22 (diff, in-memory set); QueueConsumer.kt:30 acks after
     apply() (1 hop, read)
     Lens: concurrency
  ```

Some doubts never resolve, and that is fine. They stay open, named, with the lookup that
would settle them. A report with a sharp Open Questions section and zero findings is a valid
result.
