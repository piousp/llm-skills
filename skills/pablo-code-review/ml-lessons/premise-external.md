---
id: premise-external
kind: precision
category: '*'
trigger:
  category: null
  code_kind: null
  premise: external-unverified
  tier_in:
  - B
  - M
  pattern: null
claim: A scenario that needs state outside the diff, or that the agent could not run,
  is a question and not a finding.
action: demote
never_when: every premise of the scenario is visible in the diff or one hop away
evidence:
  accepted: 1
  partial: 2
  ignored_seen: 1
  unseen: 2
  repos_n: 3
  refs:
  - rv-9ea9711c#B1
  - rv-3722fb16#M1
  - rv-7acb5561#M1
  - rv-cc334a99#M3
posterior:
  prior:
  - 1.0
  - 4.0
  alpha: 3.0
  beta: 6.0
  mean: 0.3333
  p_gt_015: 0.8948
confidence: low
provenance: seeded
source: backfill-audit
validated_with: {}
status: codified
codified_in: merge-rules.md § Blocker gate
created: '2026-10-23'
approved_at: null
last_confirmed: null
last_used: null
last_triggered: '2026-10-20'
triggers_since_explore: 0
window: 20
---
Codified in the Blocker gate: tallied only to expose a wrong static rule.
The trigger is the external-unverified premise at tier B or M.
