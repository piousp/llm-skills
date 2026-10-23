# Lessons learned — `pablo-code-review` calibration

*Working notes from calibrating this skill and its four lenses against real usage.
Read before changing the output format or adding/removing checklist rules — it explains
why the current shape exists and what evidence (or lack of it) backs each decision.*

## 2026 — Session-mining pass (format + false positives)

**Trigger:** Pablo reported the skill generates many false positives he has to filter
manually, and asked for two format changes: (1) a longer, plain-language "what this code
does" explanation with more examples, and (2) every finding structured as
what / why it happens / consequences / solutions.

**Method:** mined ~40 real session transcripts (the agent session directory) where
`pablo-code-review` or its four lenses (`qa-adversary`, `code-review-checklist`,
`refactor-identification`) were used, looking for explicit rejections and implicit
signals (silence, selective posting) in Pablo's follow-up turns.

**Key finding — the real rejection signal is silence, not pushback.** Pablo does not
usually say "this is wrong"; he ignores what he disagrees with. Only 3 explicit verbal
rejections were found across the whole corpus — too few to draw lens-specific conclusions
from words alone. This invalidates any future analysis that only greps sessions for
disagreement language; it must also check what got **acted on** (posted as a PR comment,
or fixed in code) vs. silently dropped.

**Confirmed rejections (kept for reference):**
1. `refactor-identification` compared call-site polarity instead of predicate extension
   under gate row N2 — already fixed in the current SKILL.md (N9/Unresolved path, the
   N2 footnote, evidence-ceiling rule).
2. `qa-adversary` anchored a BLOCK finding in another repo's code,
   outside the diff under review, when invoked standalone without the orchestrator's
   "this diff only" instruction.
3. `refactor-identification` proposed a P1 abstraction (DRY-at-2 threshold) that hid a
   side effect three duplicated call sites performed in plain sight; Pablo kept the
   duplication.

**Edits applied as a result** (all in the 4 skill files, before/after in commit history):
- `pablo-code-review/SKILL.md`: mandatory "What this code does" walkthrough per file
  (plain language, ≥1 worked data example) before any finding; every actionable finding
  restructured as What / Why it happens (≥2 examples) / Consequences / Solutions (≥2
  alternatives); non-actionable P2/P3 observations and nits compacted into a one-line
  list, excluded from the Summary tally; merge-time rule requiring every finding's
  `file:line` to fall inside the diff.
- `code-review-checklist/SKILL.md`: added a "When NOT to report" gate (G1–G4) — it had
  none before, making it the most likely source of unfiltered noise (test code judged by
  production-code rules, dependency bumps as Blockers, evidence outside the diff, pure
  style preference).
- `qa-adversary/SKILL.md`: blast-radius tracing informs risk but never relocates a
  finding outside the diff; a failure scenario that requires a hypothetical
  misconfiguration nobody made is a doubt, not a finding.
- `refactor-identification/SKILL.md`: new gate row N10 (test/fixture/spec code — filtered
  out, structure quality there belongs to a tests-focused review, not this lens); N3
  footnote clarifying that hiding a side effect inside a new abstraction counts as
  "harder to read" (KISS > DRY still wins); renumbered N1–N9 → N1–N10 everywhere,
  including `references/examples.md` and `evals/run_layer2_probes.py` (the substring-match
  eval checks for `"N1"`/`"N9"` literally — any future gate-row addition must grep the
  `evals/` dir too, this has bitten a prior edit once already).

**Cheap ongoing calibration metric (validated, not yet automated):** compare what a
lens proposes against what Pablo actually posts as a GitHub PR review comment
(`gh api repos/{org}/{repo}/pulls/{n}/comments`, filtered to his own login). A finding
neither posted nor fixed in a later commit in the same file (`git log --since/--until`
on the review window) is a genuine silent-drop, not a "fixed without commenting" false
alarm — spot-checked 3 such findings, none were fixed either.

**Result of the first run of this metric (Sept 2026 cohort, 15 PRs with reachable
comment history):** all three original lenses land in the same 22–27% "Pablo commented on this
file" band — no single lens is disproportionately noisier at file-level granularity.
The dominant problem was volume/format (too many non-actionable items narrated with the
same weight as real findings), which the edits above target directly, not a rogue lens.
**Caveat:** line-level matching failed almost completely during this pass (the older
narrative report format doesn't reliably pin `file:line` next to every finding) — the
new four-part format's `file:line` header should make the next run of this metric far
more precise. Re-run it after a few weeks of the new format before trusting any
lens-specific conclusion.

> **Correction (2026-10-23):** line-level matching on 18 PRs (413 items) contradicts the
> "same 22–27% band" result above: qa-adversary items were posted or partially posted at
> ~45% (~27/60), the whole skill at ~19%, checklist test-code Majors at ~0/25, refactor-only
> items at ~2/40. File-level granularity hid the difference. See the 2026-10-23 entry below.

**Limitation to carry forward:** conclusions above are anecdotal (small N, one engineer,
one domain). Treat every rule change as a calibratable hypothesis, not a proven fix,
until the next metric run confirms or refutes it.

## 2026 — Diff objective(s) must be stated up front

**Trigger:** Pablo noted the skill should name the PR's/diff's objective(s) at the very
start of the analysis, and if the diff bundles multiple distinct purposes (e.g. removing
dead code + a refactor + new logic), it must enumerate them explicitly rather than
folding them into one vague sentence.

**Why it matters:** a reader judging a mixed-purpose diff needs to know upfront which
lines serve which purpose — it reframes findings ("is this Major finding part of the
declared refactor, or scope creep riding along with it?") and gives Scope Discipline
violations a named baseline to be checked against, instead of discovering the mixing
mid-review.

**Edit applied:** `pablo-code-review/SKILL.md` — new Process step "Identify the diff's
objective(s)" before dispatching the lenses; the `### Summary` output block now
requires an enumerated list when multiple purposes are present; a corresponding
`[ALWAYS]` rule was added under `## Rules`.

## 2026-10-23 — 18-PR outcome audit (posted vs not posted)

**Trigger:** most report items were ignored. **Method:** for 18 PRs reviewed with this skill,
every item (primary findings + Open Questions + Coverage Gaps, 413) was matched against
Pablo's own inline PR comments (80; 52 phrased as questions). Posted ~49 (12%), partial ~29
(7%). Approximate: per-item outcomes were not saved; they are recomputed when the 18 PRs are
backfilled into the planned review ledger.

**Findings:** noise came mostly from the merge layer (no tier map, "keep the higher
severity", no Blocker gate, uncapped Open Questions/Coverage Gaps, four-part format for every
tier), not from the lenses' methods. Concrete in-diff scenarios and cheap local fixes with a
named remedy were posted; speculative cross-repo findings, test-strength Majors, SNAPSHOT
bumps, "split the PR" and standalone open questions were not.

**Edits applied (static):** `references/merge-rules.md` (new: tier map incl. the Question
tier, Blocker gate, one root-cause definition the lenses point to, routing, caps, format by
tier, re-review); qa-adversary severity rubric, outside-diff premise rule, Open Questions cap
5, coverage lines only where they matter; checklist Minor tier, SNAPSHOT as one FYI line,
relative size rule, scope as one question, no "less specific exception type" rule; refactor
2-copy duplication rule, added-copy tie-break, out-of-language files. Report language is now
English throughout (the skills are public); positives go in an uncounted Strengths note.

**Supersedes:** the 2026 session-mining format (lines 9-12, 38-43): the four-part structure
with ≥2 examples now applies to Blocking/Major only; Question and Minor are one line (default
for open decision 3). Rejection #3 (lines 33-35) still holds as the N3 hidden-side-effect
exception, although duplication is now extracted at 2 copies.

**Limitation:** one reviewer, 18 PRs, implicit labels; ignored ≠ wrong. Every edit is a
hypothesis to re-check with the review ledger and harvest loop.

## 2026-10-23 — Splitting out the test lens

**Why:** in the outcome audit, checklist Majors whose evidence was all test code were almost
never acted on, and the test rules (assertion strength, brittle literals, missing tests) were
duplicated across qa-adversary and the checklist, so the same test item was often raised
twice with different tiers.

**What moved:** unit/integration test quality and test-coverage rules now live only in
`pablo-test-review`, dispatched as the fourth lens. Its items map to tiers by identity (never
Blocking), dedupe against qa by `file:line` and root cause, and its coverage gaps share one
list capped at 3 with qa's NOT COVERED/PARTIAL lines. Naming the missing assertion/test is
part of its findings. The checklist no longer emits test or coverage items.

**What stayed in qa-adversary:** Integration Coverage (whether a changed production path is
exercised end to end), which is a correctness question about behavior, not test quality.
