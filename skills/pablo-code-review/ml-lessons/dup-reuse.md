---
id: dup-reuse
kind: presentation
category: duplication-reuse
trigger:
  category: duplication-reuse
  code_kind: null
  premise: null
  tier_in:
  - M
  - I
  pattern: null
claim: 'Duplication at two copies is recalled and boosted: extract at 2 copies unless
  very expensive.'
action: rank_first
never_when: the extraction crosses a module boundary or a public contract
evidence:
  accepted: 9
  partial: 0
  ignored_seen: 4
  unseen: 2
  repos_n: 4
  refs:
  - rv-9ea9711c#M2
  - rv-fbb87a64#M1
  - rv-876739be#I1
  - rv-876739be#I2
  - rv-13937699#M2
  - rv-13937699#I7
  - rv-cc334a99#M10
  - rv-cc334a99#M13
  - rv-cc334a99#I1
  - rv-cc334a99#M14
  - rv-d9b58b5b#M8
  - rv-d9b58b5b#I2
  - rv-d9b58b5b#I3
posterior:
  prior:
  - 1.0
  - 4.0
  alpha: 10.0
  beta: 8.0
  mean: 0.5556
  p_gt_015: 1.0
confidence: medium
provenance: seeded
source: backfill-audit
validated_with: {}
status: codified
codified_in: refactor-identification skill (duplication rule at 2 copies)
created: '2026-10-23'
approved_at: null
last_confirmed: null
last_used: null
last_triggered: '2026-10-22'
triggers_since_explore: 0
window: 20
---
Codified in the refactor lens; duplication is also never-suppress.
The tally keeps tracking it to expose a wrong rule.
