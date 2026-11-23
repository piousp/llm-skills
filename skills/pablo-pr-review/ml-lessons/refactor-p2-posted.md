---
id: refactor-p2-posted
kind: presentation
category: '*'
trigger:
  category:
  - duplication-reuse
  - abstraction-structure
  code_kind: prod
  premise: null
  tier_in:
  - O
  pattern: null
  lens_only: refactor-identification
claim: Refactor P2 observations anchored in a method the branch modified were posted
  as review comments; list them first in Observations.
action: rank_first
never_when: the observation is anchored in code the branch did not touch
evidence:
  accepted: 2
  partial: 0
  ignored_seen: 0
  unseen: 0
  repos_n: 1
  refs:
  - rv-d461f7d2#O1
  - rv-d461f7d2#O2
posterior:
  prior:
  - 1.0
  - 4.0
  alpha: 3.0
  beta: 4.0
  mean: 0.4286
  p_gt_015: 0.9527
confidence: low
provenance: observed
source: harvest d461f7d2
validated_with: {}
status: candidate
codified_in: null
created: '2026-11-04'
approved_at: null
last_confirmed: null
last_used: null
last_triggered: null
triggers_since_explore: 0
window: 20
---
Candidate from one harvested PR: two P2 observations (a repeated null-safe tag read, and a
predicate that belongs on the type it inspects) were both posted as comments although the
report listed them as not actionable. One PR, one reviewer: do not approve before more
harvests confirm it. Presentation only: it never changes a tier or the verdict.
