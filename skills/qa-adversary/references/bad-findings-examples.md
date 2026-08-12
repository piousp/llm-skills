# Bad findings: what not to report, and how to say it right

This file is the negative of the reporting standard. Each case shows a bad finding, the rule
it breaks, and the same suspicion reported properly. Read both reference files before writing
the report, then close them. The point is discipline, not a bug catalog to pattern-match.

### 1. Vague finding, no failure scenario

**Bad:**
```
1. [HIGH] services/pricing/Calculator:40 - unusual quantities produce wrong totals
```

**Why it fails:** breaks the SKILL rule "Every finding needs a concrete, reproducible failure
scenario". "Unusual quantities" names no input, no state, no wrong output. No one can verify
it and no one can fix from it.

**Reported properly:** promote it with named inputs, or downgrade to a doubt if the scenario
cannot be built:
```
1. [HIGH] services/pricing/Calculator:40 - quantity 0 bypasses the unit-price branch
   Failure scenario: quantity = 0, unitPrice = 10; line 40 computes 0 * 10 = 0 and the
   order total passes 0 to the invoice as a valid charge → a zero-quantity line becomes a
   free line item instead of being rejected.
   Lens: data
```
(see findings-examples.md #4 for the shape)

### 2. Hand-wavy risk, not a scenario

**Bad:**
```
2. [MEDIUM] services/ingest/Handler:61 - this might be slow under load
```

**Why it fails:** no threshold, no measurement, no concrete degradation. "Might be slow" is a
feeling, not a defect; the SKILL explicitly bans hand-wavy "this might be slow" findings.

**Reported properly:** drop it (no scenario means it is not a finding) or make the degradation
path concrete:
```
2. [MEDIUM] services/ingest/Handler:61 - retry loop has no backoff, queue drains at
   producer rate
   Failure scenario: upstream outage of 30s, producer emits 1,000 msgs/s, consumer retries
   every 200ms with no backoff → the queue grows 30,000 msgs and processing latency rises
   past the SLO of 5s until the outage ends.
   Lens: degradation
```

### 3. Manufactured finding to look thorough

**Bad:**
```
3. [BLOCK] services/orders/ShipmentService:88 - admin gate inverted
   Failure scenario: an admin on a non-internal IP is blocked from shipping
```

**Why it fails:** the diff does not touch ShipmentService:88; the scenario was invented to
make the report look complete. The SKILL says "be strict but honest: do not manufacture
findings to look thorough".

**Reported properly:** delete it. An empty Findings list with a sharp Open Questions section
is a valid, useful result.

### 4. Style comment in the wrong lane

**Bad:**
```
4. [MEDIUM] services/orders/ShipmentService:88 - method is 60 lines, hard to follow
```

**Why it fails:** this is quality/style, the lane of code-review-checklist, not behavior. The
SKILL forbids style comments: "If you catch yourself writing a style comment, delete it."

**Reported properly:** drop it. Keep it only if the size causes a reachable wrong output:
```
4. [MEDIUM] services/orders/ShipmentService:88 - early return at line 88 skips the audit
   write in the long-method tail
   Failure scenario: admin order with an external IP reaches line 88 before the audit
   write at line 120 → the order ships with no audit record.
   Lens: logic
```

### 5. Doubt presented as a BLOCK finding

**Bad:**
```
5. [BLOCK] services/checkout/GeoGate:112 - sanction rule probably wrong
   Lens: business-rule
```

**Why it fails:** no intent source (ticket or wiki) was consulted and no scenario exists;
"probably" is the signature of a doubt. The SKILL gates BLOCK on "a reproducible scenario,
OR a business-rule violation" - this has neither.

**Reported properly:** file it as Open Questions with the missing piece named, and mark the
verdict NEEDS CLARIFICATION:
```
Open Questions: GeoGate:112 applies the sanction rule to the ship country; the ticket says
"sanctioned customers" without defining whether billing or shipping country is meant. Intent
cannot be established from the diff alone.
Verdict: NEEDS CLARIFICATION
```

### 6. Severity inflation

**Bad:**
```
6. [HIGH] services/notifications/Backoff:74 - backoff multiplier changed
```

**Why it fails:** no consumer of the backoff value was traced, so the blast radius is unknown.
HIGH requires an affected caller; without one the severity is not justified.

**Reported properly:** trace the caller first; downgrade when nothing consumes the value:
```
6. [LOW] services/notifications/Backoff:74 - backoff multiplier changed from 3 to 2
   Failure scenario: the multiplier is read only in the email retry path; reverting the
   change still passes every existing test, so the change is under-covered but low-blast.
   Lens: regression
```
(see findings-examples.md #7 for the shape)

### 7. Unreachable scenario

**Bad:**
```
7. [HIGH] services/pricing/DealPicker:28 - input order changes the decision
   Failure scenario: the caller reorders deals before calling bestDeal
   Lens: oracle
```

**Why it fails:** the premise is not verified. If the caller's contract fixes the input order,
the scenario cannot occur and the invariant is not checkable at this boundary.

**Reported properly:** verify the contract; if the order is fixed upstream, the suspicion
becomes residual risk, not a finding:
```
Open Questions: DealPicker:28 is order-sensitive under ties; the caller sorts by score
ascending before the call, so ties arrive in score order. If a caller ever feeds a different
order, the decision changes. No such caller is visible in the diff.
```

### 8. Finding without file:line

**Bad:**
```
8. [MEDIUM] there is a race in the state update
```

**Why it fails:** no anchor; the SKILL requires "Report file:line for everything". Without a
line, the author cannot find the defect and the reviewer cannot verify it.

**Reported properly:**
```
8. [HIGH] services/ledger/Account:19 - non-atomic read-modify-write on balance
   Failure scenario: two concurrent credit() calls read 100 before either writes; both
   write 100 + 50 → final balance 150 instead of 200.
   Lens: concurrency
```
(see findings-examples.md #9 for the shape)

### 9. PASS without residual risk

**Bad:**
```
Verdict: PASS
```

**Why it fails:** the SKILL template requires PASS to "state residual risk and any NOT COVERED
paths explicitly". A bare PASS certifies without evidence and reads like a rubber stamp.

**Reported properly:**
```
Verdict: PASS
- Residual risk: the dedup guard at services/queue/QueueConsumer:22 is NOT COVERED by any
  integration test; a redelivery scenario is plausible but unconfirmed and is documented
  under Open Questions.
- NOT COVERED: QueueConsumer redelivery path.
```
