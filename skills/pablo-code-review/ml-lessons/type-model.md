---
id: type-model
kind: recall
category: type-modelling
trigger:
  category: type-modelling
  code_kind: prod
  premise: null
  tier_in: null
  pattern: null
claim: Look for closed string sets, keys without equals and hashCode, and read-only
  data with setters.
action: none
never_when: ''
evidence:
  accepted: 3
  partial: 0
  ignored_seen: 1
  unseen: 7
  repos_n: 2
  refs:
  - rv-1f2ecc28#M1
  - rv-cc334a99#M9
  - rv-cc334a99#I2
  - rv-5f0357c9#M6
posterior:
  prior:
  - 1.0
  - 4.0
  alpha: 4.0
  beta: 5.0
  mean: 0.4444
  p_gt_015: 0.9786
confidence: low
provenance: seeded
source: backfill-audit
validated_with: {}
status: candidate
codified_in: null
created: '2026-10-23'
approved_at: null
last_confirmed: null
last_used: null
last_triggered: '2026-10-23'
triggers_since_explore: 0
window: 20
---
Recall lesson: injected as 'Also check:' at dispatch, never applied at merge.
The enum part is already a static rule.
