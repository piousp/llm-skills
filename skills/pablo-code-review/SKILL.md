---
name: pablo-code-review
description: >
  Unifies three read-only review lenses on a single diff: `qa-adversary`
  (correctness/regression bugs), `code-review-checklist` (Pablo's quality
  checklist), and `refactor-identification` (structural refactor candidates,
  recommendations scoped to code the branch added or modified), into one
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
   a direct GitHub PR link. [NEVER] auto-detect it. Accept either form in
   the same answer, no need to ask which kind first:
   - A URL matching `https://<host>/<org>/<repo>/pull/<n>` (e.g.
     `https://github.twdcgrid.net/MediaDistributionEngineering/origin-map-reader/pull/170`)
     → resolve with `gh pr diff <url>`.
   - A branch/commit range → resolve with `git diff <range>` or
     `git diff origin/<parent>...HEAD`.
   Reuse the exact same diff text for all three subagents below. This keeps
   their scope identical.

2. **Identify the diff's objective(s).** Before dispatching, read the diff/PR description/commit
   messages and name what the change sets out to do. If it serves a single purpose, one line is
   enough. If it bundles distinct purposes (e.g. removing dead code + a refactor + new logic),
   [ALWAYS] enumerate each one explicitly. This drives the Summary and lets the reader judge
   whether unrelated purposes belong in the same change (Scope Discipline territory, but stated
   up front rather than buried in a finding).

3. **Dispatch the three lenses in parallel** (never three separate calls).
   Each subagent reports problems only. [NEVER] ask a subagent to propose
   fixes/corrections/alternatives; that step happens later, in the
   coordinator, once all three results are in.:

   - `agent: "analyst"`, `skills: ["qa-adversary"]`,
     `timeoutMs: 1200000` - task: the diff, plus "Apply the qa-adversary
     lens to this diff only. Do not analyze code outside the diff."
   - `agent: "analyst"`, `skills: ["code-review-checklist"]`,
     `timeoutMs: 1200000` - task: the diff, plus "Apply the
     code-review-checklist lens to this diff only. Do not analyze code
     outside the diff."
   - `agent: "analyst"`, `skills: ["refactor-identification"]`,
     `timeoutMs: 1200000` - task: the diff, plus "Apply the
     refactor-identification lens to this diff." Use it as-is: its own
     Scope law already 1-hops into pre-existing code for context and its
     P1/P2/P3 table already restricts an actionable recommendation to a
     smell whose root cause was added or modified by the branch (P1). A
     P2/P3 candidate rooted in pre-existing code stays a reported
     observation, never a recommendation. [NEVER] loosen its Boundaries
     section to widen the scan.

   Each `skills` array is a total replacement: the analyst loads only that
   one lens, nothing else. Leave `tools` at the analyst default (read-only,
   no Write/Edit).

  [MUST] invoke the subagents in parallel with timeout of 20 minutes:
  {
  "tasks": [
    {"agent": "analyst", "task": "XX", "skills": "X"},
    {"agent": "analyst", "task": "XX", "skills": "X"},
    {"agent": "analyst", "task": "XX", "skills": "X"}
  ]
}

4. **Merge, don't append.** Wait for all three results, then build one
   report grouped by changed file, not by lens. [NEVER] print three
   sub-reports back to back: that is the audit-report shape this skill
   exists to avoid.

5. **Add corrections yourself.** Once the merge is done, the coordinator,
   not a subagent, drafts the ≥2 corrections/alternatives per finding
   required by the Output format below, using its own judgment plus the
   subagents' problem descriptions as input. [NEVER] send a fourth
   subagent call, or re-invoke any of the three, to ask for fixes.

## Merge rules

- Same `file:line` (or same overlapping line range/set) and same root
  cause across lenses → one finding. Tag it with every lens that raised it,
  e.g. `[qa-adversary + code-review-checklist]`.
- On a severity disagreement for a merged finding, keep the higher severity.
- `refactor-identification`'s P1 candidates fold in as recommendations, tagged
  `[refactor-identification]`, counted like any other finding. Its P2/P3
  candidates fold in as a labeled observation ("pre-existing, not actionable
  in this diff"): mention them in the file's narrative for context, but
  [NEVER] count them toward the Summary's blocking/major tally.
- If a lens's section comes back clean ("pass" / "No confirmed defects" /
  "(none)"), say so in one line. [DO NOT] pad the narrative when there is
  nothing to explain.
- Nits, FYIs, and P2/P3 observations get exactly one line each, in the
  file's closing "Observaciones (no accionables)" list: [NEVER] give
  them the four-part finding structure, [NEVER] count them in the
  Summary tally, and [NEVER] interleave them with actionable findings.

## Output format

Not an audit report: a walkthrough. The reader finishes understanding what
changed and *why* it matters, not just a list of line numbers.

```
## Code Review: <branch/range>

### Summary
Verdict: PASS | NEEDS WORK | BLOCK - <N> blocking, <N> major, <N> coverage gaps
<one or two lines if the diff serves a single purpose. If it bundles multiple distinct
purposes (e.g. dead-code removal + a refactor + new logic), enumerate each one as its own
line: "1. <purpose>; 2. <purpose>; ..." This must appear before any file's findings.>

### <file path>
<diff hunk for this file>

**Qué hace este código:** <plain-language walkthrough, several sentences,
no jargon: what this file did BEFORE the change, what it does AFTER, and
why the author changed it. [ALWAYS] include at least one concrete
worked example with real-looking data flowing through the changed code
(input → each transformation step → output), the way a colleague would
explain it at a whiteboard. Longer is better than terse here. This block
is what the reader uses to judge every finding below it.>

<then every finding for this file, each in this four-part shape:>

**[<severity> - <lens(es)>] <file:line or file:L12-L18 or file:L12,L27,L41>: <one-line title>**
- **Qué:** what the defect/violation is, in one or two plain sentences.
- **Por qué pasa:** the mechanism that produces it, with at least 2
  concrete examples (two input scenarios that break it, or two cases
  where the violated principle bites), using the same real-looking data
  as the walkthrough when possible.
- **Consecuencias:** what actually happens if merged as-is: who/what is
  affected (users, operators, another service, future maintainers), and
  how it would surface (wrong output, alert, silent drift).
- **Soluciones:** at least 2 corrections/alternatives with their
  trade-offs, so the user picks which one (if any) to apply. [NEVER]
  apply a fix yourself, [NEVER] present a single "the fix is X" without
  an alternative to weigh against it.

Cite the exact location inline; when the problem spans, repeats across,
or is caused by the interaction of multiple lines, cite the full set:
[NEVER] collapse a multi-line issue to just its first or most visible
line.

**Observaciones (no accionables):** <compact one-line-each list at the end
of the file's section: refactor-identification P2/P3 observations
("pre-existing, not actionable in this diff") and checklist Nits/FYIs.
One line per item, no four-part structure, never counted in the Summary.>

### <next file>
...

### Open Questions / Doubts
<carried over from qa-adversary, if any>

### Coverage Gaps
<carried over from code-review-checklist and qa-adversary's integration
coverage assessment>
```

## Rules

- [ALWAYS] identify and state the diff's objective(s) before any file's findings; when the
  diff bundles distinct purposes (cleanup + refactor + new feature, etc.), enumerate each one
  by name in the Summary: [NEVER] fold multiple purposes into one vague sentence.
- [ALWAYS] pass the identical diff text to all three subagents; [NEVER] let
  any of them derive its own scope.
- [NEVER] treat pre-existing, unmodified code as a finding or
  recommendation. `refactor-identification` may cite it as 1-hop context
  or as a P2/P3 observation; keep those, but never promote them to an
  actionable item.
- [ALWAYS] verify, while merging, that every finding's cited file:line
  falls inside the diff. A finding anchored in another repo, an
  unavailable dependency, or unchanged code is not a finding: move it to
  Open Questions / Doubts with the exact lookup that would confirm it,
  regardless of the severity the lens assigned.
- [NEVER] edit or write code, in the coordinator or any subagent. This pass
  is read-only end to end.
- [ALWAYS] show a file's diff hunk before discussing its findings.
- [ALWAYS] cite every line actually involved in a finding, not just one
  representative line: use a range or an explicit list when the issue is
  general/spread across the hunk (e.g. a pattern repeated in several
  places, or a bug caused by two non-adjacent lines interacting).
- [ALWAYS] open every file's section with the "Qué hace este código"
  walkthrough (before/after behavior + at least one worked data example)
  BEFORE any finding: a reader who skips the diff hunk must still
  understand what the code does from that block alone.
- [ALWAYS] structure every actionable finding as Qué / Por qué pasa (≥2
  concrete examples) / Consecuencias / Soluciones (≥2 alternatives): the
  user decides which comments are worth acting on; [NEVER] present a
  single "the fix is X" without an alternative to weigh against it.
- [ALWAYS] draft the corrections/alternatives yourself, after the merge,
  from the coordinator's own judgment. [NEVER] instruct a subagent to
  suggest fixes: each lens stays focused on identifying problems; the
  three parallel dispatches never ask for or receive corrections.
- [NEVER] persist the report to a file: chat output only.
- [NEVER] preview the three subagent prompts before dispatching. The diff
  and the lens are already fixed; there is nothing left for the user to
  decide at that point.
- [WHEN] considering a change to the output format, the four-part finding
  structure, or any lens's gates, read `references/lessons-learned.md` first:
  it explains why the current shape exists and what evidence backs each
  decision.
