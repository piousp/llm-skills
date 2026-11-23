# Bad findings: what not to report, and how to say it right

This file is the negative of the reporting standard. Each case shows a bad finding, the rule
it breaks, and the same suspicion reported properly. Read both reference files before writing
the report, then close them. The point is discipline, not a bug catalog to pattern-match.

### 1. Vague finding, no failure scenario

**Bad:**
```
1. [HIGH] services/pricing/Calculator.kt:40: unusual quantities produce wrong totals
```

**Why it fails:** breaks the SKILL rule that every finding needs a
"concrete, reproducible failure scenario". "Unusual quantities" names no input, no state, no
wrong output. No one can verify it and no one can fix from it.

**Reported properly:** promote it with named inputs, or downgrade to a doubt if the scenario
cannot be built:
```
1. [HIGH] services/pricing/Calculator.kt:40: quantity 0 is no longer rejected and becomes a
   free line
   Failure scenario: quantity = 0, unitPrice = 10; the removed `quantity < 1` check no
   longer fires, line 40 computes 0 * 10 = 0 and InvoiceBuilder bills a 0.00 line → a
   zero-quantity line reaches the invoice instead of being rejected.
   Premises: Calculator.kt:38-40 (diff, check removed); InvoiceBuilder.kt:57 adds every
   line total as-is (1 hop, read)
   Lens: data
```
(see findings-examples.md #3 for the shape)

### 2. Hand-wavy risk, not a scenario

**Bad:**
```
2. [MEDIUM] services/ingest/Handler.kt:61: this might be slow under load
```

**Why it fails:** no threshold, no measurement, no concrete degradation. "Might be slow" is a
feeling, not a defect; the SKILL explicitly bans hand-wavy "this might be slow" findings.

**Reported properly:** drop it (no scenario means it is not a finding) or make the degradation
path concrete with premises in the diff:
```
2. [MEDIUM] services/ingest/Handler.kt:61: exponential backoff replaced by a fixed 200 ms
   delay, the retry budget now lasts 2 s
   Failure scenario: the upstream is down for 30 s; with maxAttempts = 10 and a fixed
   200 ms delay each message exhausts its attempts after 2 s and is dead-lettered, where
   the removed 1-2-4-8-16 s backoff outlasted the outage.
   Premises: Handler.kt:61 (diff, fixed delay); Handler.kt:58 maxAttempts = 10 (1 hop,
   read); Handler.kt:70 dead-letters after the last attempt (1 hop, read)
   Lens: degradation
```

### 3. Manufactured finding to look thorough

**Bad:**
```
3. [BLOCK] services/orders/ShipmentService.kt:88: admin gate inverted
   Failure scenario: an admin on a non-internal IP is blocked from shipping
```

**Why it fails:** the diff does not touch ShipmentService.kt:88; the scenario was invented to
make the report look complete. The SKILL says
"Be strict but honest: do not manufacture findings to look thorough".

**Reported properly:** delete it. An empty Findings list with a sharp Open Questions section
is a valid, useful result.

### 4. Style comment in the wrong lane

**Bad:**
```
4. [MEDIUM] services/orders/ShipmentService.kt:88: method is 60 lines, hard to follow
```

**Why it fails:** this is quality/style, the lane of code-review-checklist, not behavior. The
SKILL forbids style comments: "If you catch yourself writing a style comment, delete it."

**Reported properly:** drop it. Keep it only if the size causes a reachable wrong output:
```
4. [MEDIUM] services/orders/ShipmentService.kt:88: new early return skips the audit write
   at line 120
   Failure scenario: an admin order from an external IP takes the early return at line 88,
   after ship() at line 85 and before the audit write at line 120 → the order ships with no
   audit record.
   Premises: ShipmentService.kt:85-88 (diff, early return added); ShipmentService.kt:120
   writes the audit record (1 hop, read)
   Lens: logic
```

### 5. Doubt presented as a BLOCK finding

**Bad:**
```
5. [BLOCK] services/checkout/GeoGate.kt:112: sanction rule probably wrong
   Lens: business-rule
```

**Why it fails:** no intent source (ticket or wiki) was consulted and no scenario exists;
"probably" is the signature of a doubt. The SKILL requires a
"concrete, reproducible failure scenario" for every finding, and a rule
"quoted from the ticket or task description (section) or wiki (page:line)" before a rule violation rates
HIGH; this has neither.

**Reported properly:** file it under Open Questions with the missing piece named, and mark the
verdict NEEDS CLARIFICATION:
```
### Open Questions / Doubts
- services/checkout/GeoGate.kt:112 - sanctioned customers can still buy if "sanctioned
  customer" means the billing country; the gate keys on the ship country and the ticket
  does not say which - ask the ticket owner which country defines a sanctioned customer
### Verdict: NEEDS CLARIFICATION
```

### 6. Severity inflation

**Bad:**
```
6. [HIGH] services/notifications/Backoff.kt:74: backoff multiplier changed
```

**Why it fails:** no consumer of the backoff value was traced, so the blast radius is unknown.
HIGH requires "wrong output for a traced consumer"; without one the severity is not justified.

**Reported properly:** trace the caller first; with no traced consumer it is not HIGH. When
the ticket asks for the new multiplier and the diff removes no assertion, it is not a
Finding: report it on the Integration Coverage line, naming the one missing assertion:
```
- services/notifications/Backoff.kt:74 (multiplier 3 → 2): NOT COVERED (missing: assert the
  retry schedule)
```
(see findings-examples.md #7 for the shape). When no ticket line covers the change, it is a
deliberate behavior change: a MEDIUM finding written as "before → after: intended?".

### 7. Unreachable scenario

**Bad:**
```
7. [HIGH] services/pricing/DealPicker.kt:28: input order changes the decision
   Failure scenario: the caller reorders deals before calling bestDeal
   Lens: oracle
```

**Why it fails:** the premise is not verified. If the caller's contract fixes the input order,
the scenario cannot occur and the invariant is not checkable at this boundary.

**Reported properly:** read the caller; if it fixes the order, the suspicion becomes residual
risk, not a finding:
```
- services/pricing/DealPicker.kt:28 - ties would pick a different deal if a caller fed deals
  in varying order; the only caller, RankingService.kt:22 (read), sorts by score first -
  grep other repos for bestDeal() callers
```
(contrast with findings-examples.md #11, where the caller feeds unsorted input)

### 8. Finding without file:line

**Bad:**
```
8. [MEDIUM] there is a race in the state update
```

**Why it fails:** no anchor; the SKILL requires "Report `file:line` for everything". Without a
line, the author cannot find the defect and the reviewer cannot verify it.

**Reported properly:**
```
8. [HIGH] services/ledger/Account.kt:19: non-atomic read-modify-write replaces the atomic
   update
   Failure scenario: two POST /accounts/77/credit requests of 50 arrive together; both read
   100 before either writes → final balance 150 instead of 200.
   Premises: Account.kt:19-21 (diff); AccountController.kt:52 maps POST /credit to credit()
   on the multi-threaded request pool (1 hop, read)
   Lens: concurrency
```
(see findings-examples.md #9 for the shape)

### 9. PASS without residual risk

**Bad:**
```
### Verdict: PASS
```

**Why it fails:** the SKILL template requires PASS to "state residual risk and any NOT COVERED
paths explicitly". A bare PASS certifies without evidence and reads like a rubber stamp.

**Reported properly:**
```
### Verdict: PASS
- Residual risk: the dedup guard at services/queue/QueueConsumer.kt:22 is NOT COVERED by any
  integration test; a redelivery scenario is plausible but unconfirmed and is documented
  under Open Questions.
- NOT COVERED: QueueConsumer redelivery path.
```
