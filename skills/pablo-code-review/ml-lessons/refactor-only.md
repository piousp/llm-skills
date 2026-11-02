---
id: refactor-only
kind: precision
category: abstraction-structure
trigger:
  category:
  - abstraction-structure
  - encapsulation
  - complexity-size
  code_kind: null
  premise: null
  tier_in:
  - M
  pattern: null
  lens_only: refactor-identification
claim: A structural finding raised by the refactor lens alone is a Minor, unless merged
  with a Major on the same root cause.
action: demote
never_when: another lens raised the same root cause
evidence:
  accepted: 0
  partial: 0
  ignored_seen: 0
  unseen: 2
  repos_n: 0
  refs: []
posterior:
  prior:
  - 1.0
  - 4.0
  alpha: 1.0
  beta: 4.0
  mean: 0.2
  p_gt_015: 0.522
confidence: low
provenance: seeded
source: backfill-audit
validated_with: {}
status: codified
codified_in: merge-rules.md § Tier map
created: '2026-10-23'
approved_at: null
last_confirmed: null
last_used: null
last_triggered: '2026-10-16'
triggers_since_explore: 0
window: 20
---
Codified in the tier map (refactor P1 is Minor).
Trigger matches only items whose sole lens is refactor-identification (lens_only); checklist-only structural items are out of scope. Refs rv-fbb87a64#M2-M4, rv-1f2ecc28#M2 and #M5, rv-cc334a99#M6 and #M7, rv-617cbdfb#M3 are checklist-only and must be re-tallied.
