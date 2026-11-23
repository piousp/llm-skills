# Findings: good and bad

Read before writing the report, then close it. The examples fix the reporting standard, not a bug
catalog. A Finding comes from tracing the diff under review.

## Anatomy (example 1 below)

- **Severity:** BLOCK. One honest click by a named caller (`web/OrderPage.tsx:88` renders Cancel)
  triggers an irreversible refund, and nothing stops it.
- **Anchor:** a changed line, `file:line`.
- **Defect:** one line that names the wrongness and proposes no fix.
- **Scenario:** caller, honest cause, input, entry point, outcome. Every part has a value.
- **Behavior:** one of workflow, after-error, wrong-entity, assumed-knowledge, misleading-default.

## Good findings

### 1. workflow: a cancel accepted after the flow moved on (Java)

```java
// services/orders/OrderController.java, changed lines
@PostMapping("/orders/{id}/cancel")
OrderView cancel(@PathVariable String id) {
    Order order = orders.get(id);
    refunds.issue(order);                  // order.status() is never checked
    return OrderView.of(orders.save(order.cancelled()));
}
```

```
1. [BLOCK] services/orders/OrderController.java:47: cancel refunds an order that already shipped
   Scenario: end user, still seeing Cancel on the order page after shipping (web/OrderPage.tsx:88), clicks it → POST /orders/{id}/cancel issues the refund and marks the order CANCELLED → the parcel arrives and the money is gone
   Behavior: workflow
```

In lane: the cause is the caller acting after the flow moved on, and no rule in the ticket or
wiki covers cancel after shipping. The fix is a status check (409 once shipped), not a value check.

### 2. after-error: exit code 0 after failed items (TS CLI)

```ts
// tools/reprocess.ts, changed lines
for (const id of ids) {
  try { await reprocess(id); } catch (e) { console.error(`FAILED ${id}: ${e}`); }
}
console.log(`Done: ${ids.length} ids`);
process.exit(0);
```

```
2. [HIGH] tools/reprocess.ts:41: exits 0 and prints "Done" when items fail
   Scenario: operator, following docs/runbooks/reprocess.md:12 ("exit code 0 means every id was reprocessed"), runs reprocess with 40 ids; 7 fail and their errors scroll away → the tool prints "Done: 40 ids" and exits 0 → the incident is closed and the 7 ids stay broken
   Behavior: after-error
```

In lane: the errors are printed, not swallowed (not lens 1), and the exit code is new, not
changed (not lens 7). The fix is a non-zero exit and a failure count.

### 3. wrong-entity: a fallback lookup lets the wrong id succeed (Scala)

```scala
// admin/AssetAdminRoutes.scala, changed lines
def resolve(id: String): Future[Option[Asset]] =
  assets.find(id).flatMap {
    case found @ Some(_) => Future.successful(found)
    case None            => titles.find(id).map(_.map(_.primaryAsset))   // convenience fallback
  }
```

```
3. [HIGH] admin/AssetAdminRoutes.scala:77: a title id silently resolves to the title's primary asset
   Scenario: operator copies the id from the title page instead of the episode asset page and sends it to POST /admin/assets/{id}/reingest (AssetAdminRoutes.scala:52) → the primary asset is reingested and the route returns 202 → the broken episode asset is never reingested and the ticket is closed
   Behavior: wrong-entity
```

In lane: honest confusion, not id probing (lens 8), and the id matches something, so nothing
crashes (lens 2). The fix is rejecting ids that are not asset ids.

### 4. assumed-knowledge: the unit lives only in the code (Scala, no traced caller)

```scala
// scheduling/Retry.scala, changed lines
def retryIn(delay: Long, job: Job): Unit =
  queue.schedule(job, clock.millis() + delay * 1000)   // seconds; every sibling takes milliseconds
```

```
4. [LOW] scheduling/Retry.scala:9: retryIn takes seconds while every sibling scheduler takes milliseconds
   Scenario: developer, following scheduleAt(atMillis) and delayBy(millis) in the same object, calls retryIn(5000, job) for a five-second retry → the job runs 83 minutes later
   Behavior: assumed-knowledge
```

LOW: no caller of `retryIn` exists yet, so the trap is latent. A traced caller that passes
milliseconds is a bug on the default path, which belongs to qa-adversary.

### 5. misleading-default: a resend that defaults to every partner (Java)

```java
// services/resend/ResendController.java, changed lines
@PostMapping("/resend/events")
ResendResult resendEvents(@RequestParam String mediaId,
                          @RequestParam(defaultValue = "ALL") String partner) {
    return resender.resend(mediaId, partner);
}
```

```
5. [BLOCK] services/resend/ResendController.java:58: partner defaults to ALL on a resend endpoint
   Scenario: operator, used to POST /resend/media rejecting a request without a partner (ResendController.java:31), calls POST /resend/events?mediaId=m-123 to fix one partner's feed and leaves partner out → the events of m-123 are re-sent to every partner
   Behavior: misleading-default
```

BLOCK: one honest request at an operator route triggers a mass resend with no confirmation, and
the sibling route taught the caller that a missing partner is an error.

## Bad findings

### 1. Impossible by construction

```
1. [MEDIUM] src/storage/Size.scala:12: computeSize accepts a date
   Scenario: developer passes LocalDate.now() to computeSize(x: Int) → wrong size
```

Fails: the compiler rejects it, so the scenario cannot exist. Non-numeric text sent to a
`@RequestParam int` fails the same way (400 before the handler). Right: drop it without mention.

### 2. A qa-adversary case dressed as confusion

```
2. [MEDIUM] api/ListController.java:30: pageSize=-1 returns every row
   Scenario: confused API caller sends pageSize=-1 → 2 million rows
```

Fails: a negative value with no check is lens 2 (boundary), and "reject negatives" is the fix
qa-adversary asks for. A malformed date that crashes a parser, two contradictory flags and a
machine retry that applies twice fail the same way. Right: skip it, with no Finding and no Open
Question.

### 3. Attack, not confusion

```
3. [HIGH] api/SearchController.java:44: name=' OR '1'='1 returns every partner
```

Fails: crafted input is lens 8 (security); an attacker is not a confused caller. Right: skip it.

### 4. A premise outside the repo

```
4. [HIGH] api/PartnerAdminController.java:33: operators pause the wrong partner
   Scenario: operator copies the ID column of the ops dashboard into POST /admin/partners/{id}/pause → pauses partner 1042 instead of distribution 1042
```

Fails: the dashboard lives in another repo; what it shows is a premise nobody read. Right:

```
- api/PartnerAdminController.java:33 - partner and distribution ids share one numeric space, so a swapped id pauses a live partner; does the ops dashboard show distribution ids where operators copy partner ids? - a column that invites the swap makes this a Finding (look up the dashboard's partner table)
```

### 5. No consequence

```
5. [LOW] api/ImportController.java:63: the error says "Invalid request" without naming the field
```

Fails: no wrong next step and no state change are named; an unhelpful message alone is a
complaint, not a scenario. Right: drop it, or name the wrong next step the message causes and
the state it leaves.

### 6. Severity without a named caller

```
6. [HIGH] internal/RightsClient.scala:88: territory "UK" accepted where "GB" is expected
   Scenario: a client service sends UK → no rights found → content hidden
```

Fails: no client of this internal API was found, and HIGH needs a named caller. Right: MEDIUM
with "caller untraced" in the scenario, or an Open Question when no lookup can find a caller.
