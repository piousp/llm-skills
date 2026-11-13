---
id: test-oracle-abstract
kind: precision
category: test-oracle
trigger:
  category: test-oracle
  code_kind: test
  premise: null
  tier_in:
  - M
  pattern: ^(?!.*no longer (asserts|checks)).*
claim: A test-strength remark that names no concrete assertion is a one-line Minor,
  not a Major.
action: demote
never_when: the item names the exact assertion to add or change, or a diff loosened
  an existing assertion
evidence:
  accepted: 2
  partial: 1
  ignored_seen: 9
  unseen: 13
  repos_n: 8
  refs:
  - rv-3722fb16#M1
  - rv-9e072f6a#M4
  - rv-1f2ecc28#M8
  - rv-876739be#M3
  - rv-876739be#M4
  - rv-1b5c0d60#M2
  - rv-cc334a99#M15
  - rv-d9b58b5b#M7
  - rv-39961e36#M1
  - rv-39961e36#M2
  - rv-39961e36#M7
  - rv-5f0357c9#M8
posterior:
  prior:
  - 1.0
  - 4.0
  alpha: 3.5
  beta: 13.5
  mean: 0.2059
  p_gt_015: 0.687
confidence: low
provenance: seeded
source: backfill-audit
validated_with: {}
status: codified
codified_in: merge-rules.md § Routing
created: '2026-10-23'
approved_at: null
last_confirmed: null
last_used: null
last_triggered: '2026-10-22'
triggers_since_explore: 0
window: 20
---
Codified as the test-strength routing rule.
A concrete named assertion keeps its tier (see test-assert-concrete).
