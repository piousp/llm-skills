---
id: test-assert-concrete
kind: presentation
category: test-oracle
trigger:
  category: test-oracle
  code_kind: test
  premise: null
  tier_in:
  - I
  pattern: null
claim: One named missing assertion stays visible, phrased as 'Should we also assert
  X?'.
action: question_form
never_when: the remark names no assertion
evidence:
  accepted: 1
  partial: 0
  ignored_seen: 2
  unseen: 1
  repos_n: 2
  refs:
  - rv-fbb87a64#I1
  - rv-3722fb16#I1
  - rv-d9b58b5b#I4
posterior:
  prior:
  - 1.0
  - 4.0
  alpha: 2.0
  beta: 6.0
  mean: 0.25
  p_gt_015: 0.7166
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
last_triggered: '2026-10-22'
triggers_since_explore: 0
window: 20
---
Presentation only: keep the item, rewrite it as the question the reviewer would post.
Candidate until the first harvests confirm it.
