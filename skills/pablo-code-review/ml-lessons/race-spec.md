---
id: race-spec
kind: precision
category: concurrency
trigger:
  category: concurrency
  code_kind: null
  premise: external-unverified
  tier_in:
  - M
  pattern: null
claim: A race with no evidenced concurrent caller is a question, not a finding.
action: demote
never_when: the repo states or evidences concurrent callers (a repo lesson overrides
  this one)
evidence:
  accepted: 1
  partial: 0
  ignored_seen: 0
  unseen: 0
  repos_n: 1
  refs:
  - rv-7acb5561#M1
posterior:
  prior:
  - 1.0
  - 4.0
  alpha: 2.0
  beta: 4.0
  mean: 0.3333
  p_gt_015: 0.8352
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
Small sample. A repo lesson that documents concurrent callers wins over this one.
