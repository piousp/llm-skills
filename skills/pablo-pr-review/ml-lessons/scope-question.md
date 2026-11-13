---
id: scope-question
kind: presentation
category: '*'
trigger:
  category: null
  code_kind: null
  premise: null
  tier_in:
  - I
  pattern: split|unrelated|separate pr|scope|why .* in this pr|dividir|separar|alcance
claim: Never 'split the PR'. An anchored 'Why is X in this PR?' question is what gets
  posted.
action: question_form
never_when: the PR objective is unknown
evidence:
  accepted: 0
  partial: 0
  ignored_seen: 3
  unseen: 0
  repos_n: 2
  refs:
  - rv-800e6bed#I1
  - rv-800e6bed#I3
  - rv-7acb5561#I1
posterior:
  prior:
  - 1.0
  - 4.0
  alpha: 1.0
  beta: 7.0
  mean: 0.125
  p_gt_015: 0.3206
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
last_triggered: '2026-10-20'
triggers_since_explore: 0
window: 20
---
Rewrites a scope remark as a question on its first added line.
The title pattern is a rough proxy for the scope kind.
