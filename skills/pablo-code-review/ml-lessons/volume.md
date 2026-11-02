---
id: volume
kind: precision
category: '*'
trigger:
  category: null
  code_kind: null
  premise: null
  tier_in:
  - M
  pattern: null
claim: Past 8 full-format items, the lowest-posterior ones drop to one-liners.
action: cap_full:8
never_when: the item is never-suppress
evidence:
  accepted: 3
  partial: 4
  ignored_seen: 13
  unseen: 32
  repos_n: 5
  refs:
  - rv-39961e36#M1
  - rv-39961e36#M2
  - rv-39961e36#M5
  - rv-39961e36#M7
  - rv-fed005bb#M1
  - rv-b3ded941#M1
  - rv-b3ded941#M2
  - rv-617cbdfb#M1
  - rv-617cbdfb#M2
  - rv-617cbdfb#M3
  - rv-617cbdfb#M4
  - rv-5f9b42ea#M1
  - rv-5f9b42ea#M2
  - rv-5f9b42ea#M3
  - rv-5f0357c9#M1
  - rv-5f0357c9#M3
  - rv-5f0357c9#M6
  - rv-5f0357c9#M4
  - rv-5f0357c9#M5
  - rv-5f0357c9#M8
posterior:
  prior:
  - 1.0
  - 4.0
  alpha: 6.0
  beta: 19.0
  mean: 0.24
  p_gt_015: 0.8606
confidence: low
provenance: seeded
source: backfill-audit
validated_with: {}
status: retired
codified_in: null
created: '2026-10-23'
approved_at: null
last_confirmed: null
last_used: null
last_triggered: '2026-10-22'
triggers_since_explore: 0
window: 20
---
Confounded by report length and format changes, so it stays a candidate.
Shadow mode only until real harvests exist.
Retired: its cap past 8 full items hid posted findings in replay; the trigger cannot see rank.
