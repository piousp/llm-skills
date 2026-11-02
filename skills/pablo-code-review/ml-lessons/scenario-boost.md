---
id: scenario-boost
kind: presentation
category: correctness-scenario
trigger:
  category: correctness-scenario
  code_kind: null
  premise: in-diff
  tier_in:
  - B
  - M
  pattern: null
claim: 'A concrete in-diff failure scenario is the item most often acted on: list
  it first within its tier.'
action: rank_first
never_when: the scenario depends on a premise outside the diff
evidence:
  accepted: 3
  partial: 2
  ignored_seen: 3
  unseen: 2
  repos_n: 5
  refs:
  - rv-9ea9711c#M1
  - rv-0347c78a#M1
  - rv-13937699#M3
  - rv-d9b58b5b#M2
  - rv-d9b58b5b#M9
  - rv-b3ded941#M1
  - rv-b3ded941#M2
  - rv-5f9b42ea#M1
posterior:
  prior:
  - 1.0
  - 4.0
  alpha: 5.0
  beta: 8.0
  mean: 0.3846
  p_gt_015: 0.9761
confidence: low
provenance: seeded
source: backfill-audit
validated_with: {}
status: approved
codified_in: null
created: '2026-10-23'
approved_at: '2026-10-23'
last_confirmed: null
last_used: null
last_triggered: '2026-10-22'
triggers_since_explore: 0
window: 20
---
Ordering only, never a tier change.
The owner approves this at the first checkpoint.
