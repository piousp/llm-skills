---
name: pablo-code-review
description: >-
  Reviews a diff in one pass and writes one report: bugs (qa-adversary), quality (code-review-checklist), refactors (refactor-identification) and tests (pablo-test-review). Looks at changed lines only. Use for "review this PR" or "review my PR". Also "harvest PR <url>". [DO NOT] use for a single-lens request or a whole-repo review.
---

# pablo-code-review

Coordinator-only orchestration. Runs four `analyst` subagents on the same
diff, then merges their output into one report. [NEVER] delegate the merge
step to a subagent.

## Process

1. **Get the diff.** Ask the user which branch/commit range to compare, or
   a direct GitHub PR link. [NEVER] auto-detect it. Accept either form in
   the same answer, no need to ask which kind first:
   - A URL matching `https://<host>/<org>/<repo>/pull/<n>` (e.g.
     `https://github.example.com/acme/widget-service/pull/170`)
     → resolve with `gh pr diff <url>`.
   - A branch/commit range → resolve with `git diff <range>` or
     `git diff origin/<parent>...HEAD`.
   Context PRs (e.g. sibling PRs of the same ticket): fetch each with `gh pr diff <url>` and
   append it under the heading `CONTEXT ONLY, not under review: <url>`; no finding is ever
   anchored in one.
   Re-review: if the user already commented on this PR, follow
   `references/merge-rules.md` § Re-review before dispatching (it also covers a rebased or
   force-pushed PR: no incremental diff, prior open items carried over, not re-reported).
   Head unchanged since the last round and no full re-run requested: print only the
   `No changes since round r<k> (head <sha7>).` line and the status table (§ Re-review).
   Reuse the exact same diff text for all four subagents below. A diff too large to paste
   goes in one `mktemp` file passed to all four; delete it at the end (Persist).

2. **Identify the diff's objective(s).** Before dispatching, read the diff/PR description/commit
   messages and name what the change sets out to do. If it serves a single purpose, one line is
   enough. If it bundles distinct purposes (e.g. removing dead code + a refactor + new logic),
   [ALWAYS] enumerate each one explicitly. This drives the Summary and lets the reader judge
   whether unrelated purposes belong in the same change (Scope Discipline territory, but stated
   up front rather than buried in a finding).

3. **Dispatch the four lenses concurrently: one `subagent` call per lens, issued in the same
   turn.** Each call starts its own independent background job, so the four run at once.
   [NEVER] wait for one lens's result before issuing the next.

  How to invoke, as four standalone calls:

  ```
  {"agent": "analyst", "task": "<diff>\n\nApply the qa-adversary lens to this diff only. Analyze only the changed lines of the diff; pre-existing code may surface only as 1-hop context per your own Scope law. Do not tighten your Scope boundaries.", "skills": ["qa-adversary"], "timeoutMs": 1200000}
  {"agent": "analyst", "task": "<diff>\n\nApply the code-review-checklist lens to this diff only. Analyze only the changed lines of the diff; pre-existing code may surface only as 1-hop context per your own Scope law. Do not tighten your Scope boundaries.", "skills": ["code-review-checklist"], "timeoutMs": 1200000}
  {"agent": "analyst", "task": "<diff>\n\nApply the refactor-identification lens to this diff. Analyze only the changed lines of the diff; pre-existing code may surface only as 1-hop context per your own Scope law. Do not tighten your Scope boundaries.", "skills": ["refactor-identification"], "timeoutMs": 1200000}
  {"agent": "analyst", "task": "<diff>\n\nApply the pablo-test-review lens to this diff only. Analyze only the changed lines of the diff; pre-existing code may surface only as 1-hop context per your own Scope law. Do not tighten your Scope boundaries.", "skills": ["pablo-test-review"], "timeoutMs": 1200000}
  ```

   Skip the `pablo-test-review` dispatch only when the diff has no test files AND no production
   source files (build/infra/docs only); then print `Test lens: not applicable.` as its own
   line, the first line of the Summary section.

   Use each lens as-is: its Scope law already 1-hops into pre-existing code for context, and
   its P1/P2/P3 table restricts an actionable recommendation to a smell whose root cause the
   branch added or modified (P1); P2/P3 stay observations. [NEVER] loosen or tighten its
   Boundaries section.

4. **Merge, don't append.** Wait for all four results to arrive (each call's result is delivered
   as its own message), then build one report grouped by changed file, not by lens. [NEVER] print
   four sub-reports back to back: that is the audit-report shape this skill exists to avoid.
   The coordinator may run read-only lookups (`gh api`, `grep`) to answer a lens's Question. A
   Question resolved by lookup is removed from the report and printed as one Summary line,
   `Resolved by lookup: <id> <one-line answer>` (max 3); if the answer creates a finding, it
   becomes a finding.

5. **Sort by issue tier:** blocking, major, question, minor, coverage gap.
  Give each issue a unique identifier: B1, M1, Q1, I1, G1, etc.
  (B = blocking, M = major, Q = question, I = minor, G = coverage gap.) Number ids by tier,
  then rank, across the whole report; within a file print by tier, then id. Assign tiers only
  with the tier map in `references/merge-rules.md`; Nits get T1, T2… and observations O1, O2…,
  so every printed item has an id, and the id and tier open its head (Output format).

6. **Add corrections yourself.** Once the merge is done, the coordinator,
   not a subagent, drafts the ≥2 corrections/alternatives per Blocking/Major finding
   required by the Output format below, using its own judgment plus the
   subagents' problem descriptions as input. [NEVER] send a fifth
   subagent call, or re-invoke any of the four, to ask for fixes.
7. **Print, then persist.** The final assistant message of a run is the COMPLETE report: never
   a recap, never preceded by a preamble or followed by a closing note such as "Report saved
   to ...", nothing outside the template. Then tag every item (`references/taxonomy.md`) and
   persist (`references/learning-loop.md` § Report file): write that exact text to a `mktemp`
   file and pass it via `--body`; `write-report` stores it verbatim as the body. Temp files MUST be
   created with `mktemp` (never fixed paths such as `/tmp/<name>.diff`) and deleted at the end:
   delete every temp file (body, meta, diff files given to subagents). Paths are relative to this
   skill's directory.

## Merge rules

- Same `file:line` (or same overlapping line range/set) and same root
  cause across lenses → one finding. Tag it with every lens that raised it,
  e.g. `[qa-adversary + code-review-checklist]`. Root cause = the one fix that removes the item; full definition in `references/merge-rules.md` § Root cause.
- On a tier disagreement for a merged finding, take the tier of the lens that supplied a concrete in-diff failure scenario; without one, take the lower tier. Doubt never raises a tier.
- `refactor-identification`'s P1 candidates fold in as Minor (I), tagged
  `[refactor-identification]`; they become Major only when merged with a
  qa-adversary or checklist Major on the same root cause. Its P2/P3
  candidates fold in as a labeled observation ("pre-existing, not actionable
  in this diff"): mention them in the file's narrative for context, but
  [NEVER] count them toward the Summary's tally.
- If a lens's section comes back clean ("pass" / "No confirmed defects" /
  "(none)"), say so in one line; [DO NOT] pad.
- `pablo-test-review` items keep their tier (M→M, Question→Q, I→I, G→G, never Blocking); merge
  with qa-adversary and cap gaps per `references/merge-rules.md` § Tier map and § Caps.
- Checklist Nits go in the file's closing **Nits (optional):** list and
  P2/P3 observations in its **Observations (not actionable):** list, one
  line each: [NEVER] give them the four-part structure, [NEVER] count them
  in the Summary tally, [NEVER] interleave them with tiered findings, and
  [NEVER] print Filtered-out items or FYIs that ask for no action.

## Output format

Not an audit report: a walkthrough. The reader finishes understanding what
changed and *why* it matters, not just a list of line numbers.

```
## Code Review: <branch/range>

### Summary
Test lens: not applicable.   <- own line, first in the Summary, only when step 3 skipped the test lens
Verdict: PASS | NEEDS WORK | BLOCK - <N> blocking, <N> major, <N> minor (outside the verdict: <N> questions, <N> coverage gaps)
<one line if the diff serves a single purpose; if it bundles several, enumerate each as its own
line ("1. <purpose>; 2. <purpose>"). Must appear before any file's findings.>
<up to 3 lines `Resolved by lookup: <id> <one-line answer>` (step 4)>
<on a rebased PR: `PR was rebased; no incremental diff` (merge-rules.md § Re-review)>
<at most one line, only if a lens flagged build metadata: **FYI (not counted):** <artifact/version note> (merge-rules.md § Routing)>
<optional **Strengths:** 1-2 concrete lines, only if genuine; never counted.>

<re-review only: the status table first, exactly 3 columns `Prior item | Title | Status`, no prose line before the first file (merge-rules.md § Re-review)>

### <file path>   (a file with findings; one with none goes in "Other files" below)
<diff hunk for this file>

**What this code does:** <plain-language walkthrough, several sentences,
no jargon: what this file did BEFORE the change, what it does AFTER, and
why the author changed it. [ALWAYS] include at least one concrete
worked example with real-looking data flowing through the changed code
(input → each transformation step → output), the way a colleague would
explain it at a whiteboard. Longer is better than terse here. This block
is what the reader uses to judge every finding below it.>

<then every item for this file, in tier order. Every item's head opens with its id and tier, in
this one shape for B/M/Q/I/G/T/O: `**<id> [<tier> - <lens(es)>] <location>: <text>**`.
Blocking and Major use this four-part shape; Question and Minor use the one-line shapes below it:>

**M1 [Major - <lens(es)>] <file:line or file:L12-L18 or file:L12,L27,L41>: <title: the comment you would post on that line, plain language>**  (Blocking: `B1 [Blocking - ...]`)
- **What:** what the defect/violation is, in one or two plain sentences.
- **Why it happens:** the mechanism that produces it. For a behavior
  finding, at least 2 concrete input scenarios that break it; for a
  structural finding, one concrete case. Use the same real-looking data as
  the walkthrough when possible; [NEVER] argue from a hypothetical future change.
- **Consequences:** what actually happens if merged as-is: who/what is
  affected (users, operators, another service, future maintainers), and
  how it would surface (wrong output, alert, silent drift).
- **Solutions:** at least 2 corrections/alternatives with their
  trade-offs, so the user picks which one (if any) to apply. [NEVER]
  apply a fix yourself, [NEVER] present a single "the fix is X" without
  an alternative to weigh against it.

Cite the exact location inline; for a multi-line issue cite the full set,
[NEVER] just its first or most visible line.

**Q1 [Question - <lens(es)>] <file:line>: <the question to post>** · What to check: <exact lookup> · If <answer>: <tier it would become>
**I1 [Minor - <lens(es)>] <file:line>: <the comment to post>** · <one sentence: why it matters> · Suggestion: <replacement or comment-ready text>

**Nits (optional):** <one line each: `**T1 [Nit - <lens>] <file:line>: <comment to post> → <exact replacement>**`;
checklist Nits only, never counted.>

**Observations (not actionable):** <one line each: `**O1 [Observation - refactor-identification] <file:line>: <note>**`,
P2/P3 observations ("pre-existing, not actionable in this diff"). Never counted in the Summary.>

### <next file>
...

### Other files
<one line per file with no findings: `<path>: <what changed, in a few words>`. No walkthrough, no hunk.
"What this code does" and the hunk exist only for files that carry findings.>

### Unverified business assumptions
<at most one line: domain-knowledge questions no read-only lookup can answer
(merge-rules.md § Caps). Omit the section when there are none.>

### Coverage Gaps
<at most 3, ranked per merge-rules.md § Caps: `**G1 [Gap - <lens(es)>] <file:line>: <input> → <expected>, suggested test: <name>**`.
Source: pablo-test-review gaps (max 3) merged with qa-adversary NOT COVERED/PARTIAL lines.>

Data: <optional one line: package-level cycles, if any (merge-rules.md § Routing); never findings.>
```

## Harvest (user-triggered)

On "harvest PR <url>" (or when offered at a re-review) follow `references/learning-loop.md`
§ Harvest: fetch the user's comments, match them to the stored findings, then ask via
§ Approval message. [NEVER] write feedback before the user replies.

## Rules

- [ALWAYS] pass the identical diff to all four subagents; [NEVER] let any derive its own scope.
- [NEVER] treat pre-existing, unmodified code as a finding or
  recommendation. `refactor-identification` may cite it as 1-hop context
  or as a P2/P3 observation; keep those, but never promote them to an
  actionable item.
- [ALWAYS] read `references/merge-rules.md` before merging: tier map, Blocker gate, root
  cause, routing (build metadata, test strength, scope, scripts, cycles), caps, format by
  tier, re-review.
- [ALWAYS] derive the verdict from tiers only: BLOCK iff ≥1 blocking, NEEDS WORK iff ≥1
  major, else PASS. Questions, minor items and coverage gaps never change it.
- [ALWAYS] verify, while merging, that every finding's cited file:line
  falls inside the diff and that every premise of its failure scenario is
  visible in the diff or 1 hop away in the same repo. A finding anchored in
  another repo, an unavailable dependency, or unchanged code, or one that
  needs an unverified premise, is a Question with the exact lookup that
  would confirm it (or dropped past the cap), whatever severity the lens gave.
- [NEVER] edit or write code, in the coordinator or any subagent. The pass is read-only on code
  end to end; the report ledger file is the only write.
- [ALWAYS] for each file with findings: diff hunk, then the "What this code does"
  walkthrough (a reader who skips the hunk must still understand the code), then its findings.
  Cite every line actually involved (range or explicit list).
- [ALWAYS] write the report's headers and finding labels in English as
  designed ("What this code does", "What", "Why it happens", "Consequences",
  "Solutions", "Question", "Nits (optional)", "Observations (not actionable)",
  "Unverified business assumptions", "Strengths"): [NEVER] swap them for
  other phrasings.
- [ALWAYS] structure every Blocking and Major finding as What / Why it happens /
  Consequences / Solutions (≥2 alternatives); Question and Minor items
  are one line each (a Minor always carries at least one concrete suggestion).
  [NEVER] present a single "the fix is X" for a B/M finding.
- [NEVER] ask a subagent for fixes (the coordinator drafts them, step 6). Exception: naming
  the missing assertion/test is part of a pablo-test-review finding.
- [ALWAYS] persist per step 7 (`scripts/store.py write-report`, git-ignored `reviews/`
  ledger): the only file this skill keeps from a review.
- [NEVER] preview the four subagent prompts before dispatching: the diff
  and the lens are already fixed.
- [WHEN] changing the output format, four-part structure or lens gates, read
  `references/lessons-learned.md` first.
