---
id: oq-standalone
kind: precision
category: '*'
trigger:
  category: null
  code_kind: null
  premise: null
  tier_in:
  - Q
  pattern: null
claim: Show at most 3 questions; a question no one-hop lookup can answer goes to the
  single business-assumptions line.
action: cap_full:3
never_when: the answer would create or remove a Blocking or Major item
evidence:
  accepted: 0
  partial: 1
  ignored_seen: 19
  unseen: 64
  repos_n: 5
  refs:
  - rv-13937699#Q5
  - rv-13937699#Q6
  - rv-eddf2255#Q1
  - rv-eddf2255#Q2
  - rv-eddf2255#Q3
  - rv-eddf2255#Q4
  - rv-cc334a99#Q3
  - rv-d9b58b5b#Q3
  - rv-fed005bb#Q1
  - rv-617cbdfb#Q1
  - rv-617cbdfb#Q2
  - rv-617cbdfb#Q3
  - rv-617cbdfb#Q4
  - rv-617cbdfb#Q5
  - rv-617cbdfb#Q6
  - rv-617cbdfb#Q7
  - rv-5f9b42ea#Q1
  - rv-5f9b42ea#Q2
  - rv-5f9b42ea#Q4
  - rv-5f9b42ea#Q5
posterior:
  prior:
  - 1.0
  - 4.0
  alpha: 1.5
  beta: 23.5
  mean: 0.06
  p_gt_015: 0.0522
confidence: medium
provenance: seeded
source: backfill-audit
validated_with: {}
status: codified
codified_in: merge-rules.md § Caps
created: '2026-10-23'
approved_at: null
last_confirmed: null
last_used: null
last_triggered: '2026-10-22'
triggers_since_explore: 0
window: 20
---
Codified as the question cap.
Run the read-only lookup first; ask only what it cannot settle.
