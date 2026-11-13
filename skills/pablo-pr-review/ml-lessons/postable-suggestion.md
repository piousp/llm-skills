---
id: postable-suggestion
kind: precision
category: '*'
trigger:
  category: domain-assumption
  code_kind: null
  premise: null
  tier_in:
  - Q
  pattern: null
claim: A finding needs a concrete suggestion the reviewer can post; a question that
  only asks the author to state a fact is not posted.
action: demote
never_when: the answer would create or remove a Major
evidence:
  accepted: 0
  partial: 1
  ignored_seen: 19
  unseen: 17
  repos_n: 9
  refs:
  - rv-3722fb16#Q3
  - rv-3722fb16#Q4
  - rv-9e072f6a#Q2
  - rv-9e072f6a#Q3
  - rv-1f2ecc28#Q2
  - rv-1f2ecc28#Q3
  - rv-876739be#Q4
  - rv-7acb5561#Q1
  - rv-7acb5561#Q4
  - rv-13937699#Q2
  - rv-13937699#Q3
  - rv-13937699#Q5
  - rv-eddf2255#Q1
  - rv-cc334a99#Q3
  - rv-fed005bb#Q1
  - rv-617cbdfb#Q3
  - rv-617cbdfb#Q6
  - rv-617cbdfb#Q7
  - rv-5f9b42ea#Q1
  - rv-5f9b42ea#Q5
posterior:
  prior:
  - 1.0
  - 4.0
  alpha: 1.5
  beta: 23.5
  mean: 0.06
  p_gt_015: 0.0522
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
From a single owner signal, so it is a candidate.
Never applies to a question that gates a Major.
