---
id: gap-volume
kind: precision
category: coverage-gap
trigger:
  category: coverage-gap
  code_kind: null
  premise: null
  tier_in:
  - G
  pattern: null
claim: Show at most 3 coverage gaps, the new untested branch first.
action: cap_full:3
never_when: the gap is a new branch with no test at all
evidence:
  accepted: 0
  partial: 1
  ignored_seen: 19
  unseen: 77
  repos_n: 10
  refs:
  - rv-1f2ecc28#G2
  - rv-0347c78a#G5
  - rv-0347c78a#G6
  - rv-876739be#G1
  - rv-7acb5561#G1
  - rv-7acb5561#G2
  - rv-1b5c0d60#G5
  - rv-eddf2255#G3
  - rv-cc334a99#G1
  - rv-cc334a99#G2
  - rv-cc334a99#G5
  - rv-cc334a99#G6
  - rv-cc334a99#G7
  - rv-d9b58b5b#G2
  - rv-d9b58b5b#G6
  - rv-d9b58b5b#G9
  - rv-39961e36#G2
  - rv-5f9b42ea#G1
  - rv-5f9b42ea#G2
  - rv-5f9b42ea#G3
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
last_triggered: '2026-10-23'
triggers_since_explore: 0
window: 20
---
Codified as the coverage-gap cap.
Gaps past the cap collapse into the one-line list.
