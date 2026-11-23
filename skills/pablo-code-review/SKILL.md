---
name: pablo-code-review
description: >-
  Strict code-quality review of the user's own branch before a PR: diffs commits, staged and unstaged changes against the merge-base with origin's default branch, runs four lenses (qa-adversary, code-review-checklist, refactor-identification, pablo-test-review) and prints one tier-grouped report where any checklist violation tagged with a pablo-code-philosophy principle and introduced by the branch is Major. Use for "review my code", "review my branch", or "before I open the PR". [DO NOT] use for a PR URL or someone else's PR (use pablo-pr-review), a CodeIQ review (use codeiq), a single-lens request, or a whole-repo review.
---

# pablo-code-review

Coordinator-only orchestration. Runs four `analyst` subagents on the same
diff, then merges their output into one tier-grouped report. [NEVER]
delegate the merge to a subagent. [NEVER] edit code. Print-only: no ledger,
no lessons, no files kept.

## Process

1. **Resolve the diff.** Read-only git: no `fetch`, no `remote set-head`.
   - `DEFAULT=$(git symbolic-ref --short refs/remotes/origin/HEAD)`; if that fails try
     `origin/main`, then `origin/master`; if none exists, ask the user for the base.
   - `BASE=$(git merge-base $DEFAULT HEAD)`.
   - Parent check: `git log --simplify-by-decoration --decorate-refs=refs/heads --decorate-refs=refs/remotes --format='%h %D' $BASE..HEAD`.
     Remove the current branch and its upstream from the decorations. If a branch tip remains,
     ask once: "Base on <parent> or <DEFAULT>?". On the parent, recompute the merge-base against
     it and print the parent as the base. With no tip left, [NEVER] ask.
   - Diff = `git diff $BASE` (commits, staged and unstaged) plus each untracked file via
     `git diff --no-index /dev/null <f>`. Add `+uncommitted` to the header iff
     `git status --porcelain` is non-empty.
   - Branch = `git branch --show-current`; empty means `detached@<sha7>`.
   - Empty diff: print `No changes vs <base>.` and stop.
   - A diff too large to paste goes in one `mktemp` file shared by all four lenses; delete it
     at the end.

2. **Infer the objective(s).** A goal, task or spec the user gave comes first. If the branch
   name carries a task or ticket id, note it in the objective. Then read the commit subjects in `$BASE..HEAD`, the branch name
   and the uncommitted file names. One purpose: one line. Several distinct purposes: enumerate
   each ("1. ...; 2. ..."). The objective goes to every lens and into the report.

3. **Dispatch the four lenses concurrently: one `subagent` call per lens, all in the same
   turn.** [NEVER] wait for one result before issuing the next. One call per lens
   (`<lens>` = `qa-adversary`, `code-review-checklist`, `refactor-identification`, `pablo-test-review`):

   ```
   {"agent": "analyst", "task": "<diff>\n\nObjective: <objective>\n\nApply the <lens> lens to this diff only. Analyze only the changed lines of the diff; pre-existing code may surface only as 1-hop context per your own Scope law. Do not tighten your Scope boundaries.", "skills": ["<lens>"], "timeoutMs": 1200000}
   ```

   Skip `pablo-test-review` only when the diff has no test files AND no production source
   files; then print `Test lens: not applicable.` as its own line under Verdict.
   Domain context: when a domain-context skill applies to the repo (the caller named one, or
   an installed skill's description covers this repo), add it to the qa-adversary call:
   `"skills": ["qa-adversary", "<domain-context-skill>"]`. With none, qa-adversary reports
   `domain context: none loaded`.
   A lens call that errors, times out or returns no report in its lens's output format gets
   one retry with the same call. If the retry also fails, print `<lens>: not run (<reason>)`
   as its own line under Verdict.
   [NEVER] print PASS with a failed lens. A skipped test lens is not a failed lens.
   [NEVER] preview the prompts. [NEVER] make a fifth call; retries of failed lenses do not count.

4. **Merge, don't append.** Read `references/merge-rules.md` first. Wait for all results, then
   follow its Merge order. The coordinator may settle a Question with a read-only lookup
   (`grep`, reading files); if the answer creates a finding, it becomes one.

5. **Draft Fix and Alt yourself.** The coordinator writes the Fix and one Alt (with its
   trade-off) for each Blocking and Major item. Subagents never do. Each Fix and Alt passes the
   YAGNI → KISS → DRY → SOLID pipeline of `pablo-code-philosophy` and touches only files in the
   diff or 1 hop away. With no second sensible fix, write
   `**Alt:** none (single sensible fix)`; [NEVER] invent one. A Minor's Suggestion comes from
   its lens (checklist suggestion, pablo-test-review `Change:`, refactor direction); when the
   lens gave none, the coordinator writes it under the same rule.

## Output format

Tier order: Blocking, Major, Questions, Minor, Nits, Coverage gaps, Observations. Omit empty
tiers. Ids run by tier, then diff order (Questions: their rank in merge-rules § Caps):
B1, M1, Q1, I1, T1, G1, O1.

```
## Code Review: <branch> vs <base> (<base sha7>..<HEAD sha7>[, +uncommitted])
Verdict: PASS | NEEDS WORK | BLOCK - <N> blocking, <N> major (outside the verdict: <N> minor, <N> questions, <N> coverage gaps)
Test lens: not applicable.   <- only when step 3 skipped it
<lens>: not run (<reason>)   <- one line per failed lens (step 3)
<lens>: skipped <files or checks> (<reason>)   <- one line per lens skip line (merge-rules § Tier map)
Objective: <one line, or the enumerated purposes>
Rules hit: KISS 2, DRY 1    <- count of B/M items whose Rule names a pablo-code-philosophy principle (YAGNI, KISS, DRY, SOLID, FP, Data, Boundaries); omit if none

### Major
**M1 [Major - <lens(es)>] <file:line | file:L12-L18 | file:L12,L27>: <title: the comment to post>**
- **Rule:** <the principle or rule broken, e.g. Data: every value of a type must name a domain case>
- **Evidence:** <the changed lines and what they do>
- **Impact:** <named consequence; for a strict-bumped item, the principle's concrete cost in this diff, never an invented failure>
- **Fix:** <primary fix> · **Alt:** <alternative + trade-off>

### Questions
**Q1 [Question - <lens>] <file:line>: <question to post>** · What to check: <lookup>[ · If <answer>: <tier>]

### Minor
**I1 [Minor - <lens>] <file:line>: <comment to post>** · Suggestion: <concrete replacement or wording>

### Nits
**T1 [Nit - <lens>] <file:line>: <comment> → <exact replacement>**

### Coverage gaps
**G1 [Gap - <lens>] <file:line>: <input> → <expected>[, suggested test: <name>]**

### Observations
**O1 [Observation - refactor-identification] <file:line>: <note>**
```

Blocking uses the Major shape with `B1 [Blocking - ...]` under `### Blocking`. Cite every line
involved, never only the first. [NEVER] print a walkthrough, diff hunks, Strengths, FYI lines,
a `Data:` line or any harvest step. The final message is the complete report; nothing before or
after it. [ALWAYS] write the headers and every item in English, ready to post, translating lens
text when needed.

## Rules

- [ALWAYS] pass the identical diff and objective to all four lenses; [NEVER] let one derive its own scope.
- [ALWAYS] read `references/merge-rules.md` before merging; the verdict comes only from its `Verdict:` rule.
- [NEVER] add, drop, loosen or tighten a lens's own gates (the checklist's G1-G6, pablo-test-review's G-A to G-H) or its Boundaries section. Report ids starting with G name Coverage gaps, never these gates.
- [NEVER] treat pre-existing, unmodified code as a finding.
- [NEVER] write or edit code, in the coordinator or any subagent. The pass is read-only.
- [ALWAYS] create temp files with `mktemp` and delete them before the final message.
