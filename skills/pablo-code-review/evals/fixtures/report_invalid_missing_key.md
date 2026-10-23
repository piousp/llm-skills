---
review_id: b076db44
host: github.example.com
org: acme
repo: widget
pr: 42
round: 1
branch: feature/retry-budget
base_sha: 1a2b3c4d5e6f
head_sha: 9f8e7d6c5b4a
date: '2026-01-15T10:30:00Z'
context_prs: []
lens_versions:
  qa-adversary: '11111111'
  code-review-checklist: '22222222'
  refactor-identification: '33333333'
lessons_applied: []
lessons_shadow: []
diff_stats:
  files: 2
  additions: 40
  deletions: 6
items_shown_full: 1
items_shown_total: 6
verdict: NEEDS WORK
tally:
  B: 0
  M: 1
  Q: 1
  I: 1
  G: 1
findings:
- id: M1
  lens:
  - qa-adversary
  - code-review-checklist
  lens_sev:
  - HIGH
  - Major
  tier: M
  category: correctness-scenario
  code_kind: prod
  premise: in-diff
  kind: finding
  location:
    path: src/main/java/com/acme/widget/RetryPolicy.java
    lines: 41-47
  title: Retry budget is never decremented when the first attempt throws
  rank: 1
  shown_as: normal
  lessons: []
- id: Q1
  lens:
  - qa-adversary
  lens_sev:
  - Open Question
  tier: Q
  category: contract-compat
  code_kind: prod
  premise: external-unverified
  kind: question
  location:
    path: src/main/java/com/acme/widget/RetryPolicy.java
    lines: '12'
  title: Does any consumer read maxAttempts as zero-based?
  rank: 2
  shown_as: normal
  lessons: []
- id: I1
  lens:
  - refactor-identification
  lens_sev:
  - P1
  tier: I
  category: duplication-reuse
  code_kind: prod
  premise: in-diff
  kind: finding
  location:
    path: src/main/java/com/acme/widget/Backoff.java
    lines: 20-31
  title: Reuse Backoff.next() instead of the second inline delay formula
  rank: 3
  shown_as: normal
  lessons: []
- id: G1
  lens:
  - code-review-checklist
  lens_sev:
  - Coverage gap
  tier: G
  category: coverage-gap
  code_kind: test
  premise: in-diff
  kind: gap
  location:
    path: src/main/java/com/acme/widget/RetryPolicy.java
    lines: 41-47
  title: 'Exhausted budget: 3 failures -> RetryExhaustedException'
  rank: 4
  shown_as: normal
  lessons: []
- id: T1
  lens:
  - code-review-checklist
  lens_sev:
  - Nit
  tier: T
  category: naming-docs-style
  code_kind: prod
  premise: in-diff
  kind: nit
  location:
    path: src/main/java/com/acme/widget/Backoff.java
    lines: '8'
  title: Rename tmp to delayMillis
  rank: 5
  shown_as: normal
  lessons: []
- id: O1
  lens:
  - refactor-identification
  lens_sev:
  - P2
  tier: O
  category: abstraction-structure
  code_kind: prod
  premise: 1-hop
  kind: finding
  location:
    path: src/main/java/com/acme/widget/Backoff.java
    lines: 50-90
  title: Pre-existing class mixes delay math and logging
  rank: 6
  shown_as: normal
  lessons: []
---
## Code Review: feature/retry-budget

### Summary
Verdict: NEEDS WORK - 0 blocking, 1 major, 1 minor (outside the verdict: 1 questions, 1 coverage gaps)
Adds a retry budget to the widget client.

### src/main/java/com/acme/widget/RetryPolicy.java

**[Major - qa-adversary + code-review-checklist] RetryPolicy.java:L41-L47: Retry budget is never decremented when the first attempt throws** (M1)

**[Question - qa-adversary] RetryPolicy.java:L12: Does any consumer read maxAttempts as zero-based?** (Q1)

### src/main/java/com/acme/widget/Backoff.java

**[Minor - refactor-identification] Backoff.java:L20-L31: Reuse Backoff.next() instead of the second inline delay formula** (I1)

**Nits (optional):** T1 Backoff.java:L8: rename tmp → delayMillis

**Observations (not actionable):** O1 pre-existing class mixes delay math and logging.

### Coverage Gaps
G1 RetryPolicy.java:L41-L47: 3 failures → RetryExhaustedException, suggested test: exhaustsBudgetAfterThreeFailures
