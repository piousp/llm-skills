---
id: question-form
kind: presentation
category: '*'
trigger:
  category: null
  code_kind: null
  premise: null
  tier_in:
  - M
  - Q
  - I
  pattern: null
claim: 'Most posted comments are questions: write each title as the comment the reviewer
  would post.'
action: question_form
never_when: the item is Blocking, or a question would hide the failure scenario
evidence:
  accepted: 1
  partial: 1
  ignored_seen: 18
  unseen: 105
  repos_n: 3
  refs:
  - rv-617cbdfb#Q2
  - rv-617cbdfb#Q3
  - rv-617cbdfb#Q4
  - rv-617cbdfb#Q5
  - rv-617cbdfb#Q6
  - rv-617cbdfb#Q7
  - rv-5f9b42ea#M1
  - rv-5f9b42ea#M2
  - rv-5f9b42ea#M3
  - rv-5f9b42ea#I1
  - rv-5f9b42ea#Q1
  - rv-5f9b42ea#Q2
  - rv-5f9b42ea#Q4
  - rv-5f9b42ea#Q5
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
  alpha: 2.5
  beta: 22.5
  mean: 0.1
  p_gt_015: 0.1828
confidence: low
provenance: seeded
source: backfill-audit
validated_with: {}
status: codified
codified_in: merge-rules.md § Format by tier
created: '2026-10-23'
approved_at: null
last_confirmed: null
last_used: null
last_triggered: '2026-10-23'
triggers_since_explore: 0
window: 20
---
Codified: every title is the comment to post, plain language first.
The tally keeps the form (question or assertion) per posted item.
