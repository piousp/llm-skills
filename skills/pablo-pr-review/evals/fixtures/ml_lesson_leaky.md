---
id: leaky-example
kind: precision
category: correctness-scenario
trigger:
  category: correctness-scenario
  pattern: FooBarService\.java
claim: acme-widget-svc fails when ACME-123 is read from src/main/FooBarService.java
action: demote
evidence:
  refs:
  - rv-0123abcd#M1
  - not-an-opaque-ref
status: candidate
---
l1
l2
l3
l4
l5
l6
l7 the seventh body line, acme-corp on h.example
