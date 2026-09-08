---
name: pablo-code-review
description: >
  Unifies three read-only review lenses on a single diff — `qa-adversary`
  (correctness/regression bugs), `code-review-checklist` (Pablo's quality
  checklist), and `refactor-identification` (structural refactor candidates,
  recommendations scoped to code the branch added or modified) — into one
  narrative report the reader can follow end to end. Analyzes ONLY the
  changed lines of the current PR/branch for findings and recommendations;
  pre-existing, untouched code may only surface as 1-hop context, never as
  a standalone finding. Trigger on "review this PR", "revisa mi PR", "will
  this break anything and is the code good", or any request that combines
  correctness + quality + structural review in one pass. [DO NOT] trigger
  for a single-lens request (use `qa-adversary` or `code-review-checklist`
  directly) or to review unchanged/whole-repo code.
---

# pablo-code-review

Coordinator-only orchestration. Runs three `analyst` subagents on the same
diff, then merges their output into one report. [NEVER] delegate the merge
step to a subagent.

## Process

1. **Get the diff.** Ask the user which branch/commit range to compare, or
   a direct GitHub PR link — [NEVER] auto-detect it. Accept either form in
   the same answer, no need to ask which kind first:
   - A URL matching `https://<host>/<org>/<repo>/pull/<n>` (e.g.
     `https://github.twdcgrid.net/MediaDistributionEngineering/origin-map-reader/pull/170`)
     → resolve with `gh pr diff <url>`.
   - A branch/commit range → resolve with `git diff <range>` or
     `git diff origin/<parent>...HEAD`.
   Reuse the exact same diff text for all three subagents below. This keeps
   their scope identical.

2. **Dispatch the three lenses in parallel**, one `subagent` call with a
   `tasks` array (never three separate calls):

   - `agent: "analyst"`, `skills: ["qa-adversary"]`, `timeoutMs: 1200000`
     — task: the diff, plus "Apply the qa-adversary lens to this diff only.
     Do not analyze code outside the diff."
   - `agent: "analyst"`, `skills: ["code-review-checklist"]`,
     `timeoutMs: 1200000` — task: the diff, plus "Apply the
     code-review-checklist lens to this diff only. Do not analyze code
     outside the diff."
   - `agent: "analyst"`, `skills: ["refactor-identification"]`,
     `timeoutMs: 1200000` — task: the diff, plus "Apply the
     refactor-identification lens to this diff." Use it as-is: its own
     Scope law already 1-hops into pre-existing code for context and its
     P1/P2/P3 table already restricts an actionable recommendation to a
     smell whose root cause was added or modified by the branch (P1). A
     P2/P3 candidate rooted in pre-existing code stays a reported
     observation, never a recommendation — [NEVER] loosen its Boundaries
     section to widen the scan.

   Each `skills` array is a total replacement — the analyst loads only that
   one lens, nothing else. Leave `tools` at the analyst default (read-only,
   no Write/Edit).

3. **Merge, don't append.** Wait for all three results, then build one
   report grouped by changed file, not by lens. [NEVER] print three
   sub-reports back to back — that is the audit-report shape this skill
   exists to avoid.

## Merge rules

- Same `file:line` and same root cause across lenses → one finding. Tag it
  with every lens that raised it, e.g. `[qa-adversary + code-review-checklist]`.
- On a severity disagreement for a merged finding, keep the higher severity.
- `refactor-identification`'s P1 candidates fold in as recommendations, tagged
  `[refactor-identification]`, counted like any other finding. Its P2/P3
  candidates fold in as a labeled observation ("pre-existing, not actionable
  in this diff") — mention them in the file's narrative for context, but
  [NEVER] count them toward the Summary's blocking/major tally.
- If a lens's section comes back clean ("pass" / "No confirmed defects" /
  "(none)"), say so in one line — [DO NOT] pad the narrative when there is
  nothing to explain.

## Output format

Not an audit report — a walkthrough. The reader finishes understanding what
changed and *why* it matters, not just a list of line numbers.

```
## Code Review: <branch/range>

### Summary
Verdict: PASS | NEEDS WORK | BLOCK — <N> blocking, <N> major, <N> coverage gaps
<one or two lines: what the diff sets out to do>

### <file path>
<diff hunk for this file>

<narrative: what changed and why, with every finding for this file folded
into the explanation. Cite file:line inline, name the lens(es), give the
concrete reasoning — a failure scenario for a qa-adversary finding, the
violated principle for a checklist/philosophy finding.>

### <next file>
...

### Open Questions / Doubts
<carried over from qa-adversary, if any>

### Coverage Gaps
<carried over from code-review-checklist and qa-adversary's integration
coverage assessment>
```

## Rules

- [ALWAYS] pass the identical diff text to all three subagents; [NEVER] let
  any of them derive its own scope.
- [NEVER] treat pre-existing, unmodified code as a finding or
  recommendation. `refactor-identification` may cite it as 1-hop context
  or as a P2/P3 observation — keep those, but never promote them to an
  actionable item.
- [NEVER] edit or write code, in the coordinator or any subagent. This pass
  is read-only end to end.
- [ALWAYS] show a file's diff hunk before discussing its findings.
- [NEVER] persist the report to a file — chat output only.
- [NEVER] preview the three subagent prompts before dispatching. The diff
  and the lens are already fixed; there is nothing left for the user to
  decide at that point.
