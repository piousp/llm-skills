---
id: nit-exact
kind: precision
category: naming-docs-style
trigger:
  category: naming-docs-style
  code_kind: null
  premise: null
  tier_in:
  - T
  pattern: null
claim: A nit survives only with the exact replacement text.
action: demote
never_when: the title carries the exact replacement
evidence:
  accepted: 3
  partial: 1
  ignored_seen: 13
  unseen: 14
  repos_n: 5
  refs:
  - rv-9ea9711c#T1
  - rv-800e6bed#T1
  - rv-800e6bed#T2
  - rv-fbb87a64#T1
  - rv-fbb87a64#T2
  - rv-7acb5561#T1
  - rv-1b5c0d60#T1
  - rv-cc334a99#T1
  - rv-cc334a99#T2
  - rv-cc334a99#T3
  - rv-cc334a99#T4
  - rv-cc334a99#T5
  - rv-cc334a99#T6
  - rv-617cbdfb#T1
  - rv-617cbdfb#T2
  - rv-5f0357c9#T1
  - rv-5f0357c9#T2
posterior:
  prior:
  - 1.0
  - 4.0
  alpha: 4.5
  beta: 17.5
  mean: 0.2045
  p_gt_015: 0.7161
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
last_triggered: '2026-10-23'
triggers_since_explore: 0
window: 20
---
The trigger cannot see the replacement text, so it is an upper bound.
Shadow mode will show which nits would collapse.
Retired: its trigger cannot see the replacement text, so it emptied the naming category.
