---
name: pablo-code-review
description: >-
  Strict code-quality review of the user's own branch before a PR: diffs commits, staged and unstaged changes against the merge-base with origin's default branch, runs four lenses (qa-adversary, code-review-checklist, refactor-identification, pablo-test-review) and prints one tier-grouped report where any named pablo-code-philosophy violation introduced by the branch is Major. Use for "review my code", "review my branch" or "before I open the PR". [DO NOT] use for a PR URL or someone else's PR (use pablo-pr-review), a single-lens request, or a whole-repo review.
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

2. **Infer the objective(s).** Read the commit subjects in `$BASE..HEAD`, the branch name and
   the uncommitted file names. One purpose: one line. Several distinct purposes: enumerate
   each ("1. ...; 2. ..."). The objective goes to every lens and into the report.

3. **Dispatch the four lenses concurrently: one `subagent` call per lens, all in the same
   turn.** [NEVER] wait for one result before issuing the next. One call per lens
   (`<lens>` = `qa-adversary`, `code-review-checklist`, `refactor-identification`, `pablo-test-review`):

   ```
   {"agent": "analyst", "task": "<diff>\n\nObjective: <objective>\n\nApply the <lens> lens to this diff only. Analyze only the changed lines of the diff; pre-existing code may surface only as 1-hop context per your own Scope law. Do not tighten your Scope boundaries.", "skills": ["<lens>"], "timeoutMs": 1200000}
   ```

   Skip `pablo-test-review` only when the diff has no test files AND no production source
   files; then print `Test lens: not applicable.` as its own line under Verdict.
   [NEVER] preview the prompts. [NEVER] make a fifth call.

4. **Merge, don't append.** Read `references/merge-rules.md` first. Wait for all results, then
   in this order:
   1. Map each lens item through the tier map, then apply the strict bump.
   2. A lens part whose premise is outside the diff becomes its own Question; it does not
      merge into in-diff parts.
   3. Merge the in-diff parts by root cause and take the highest tier (qa+test Dedupe rule
      excepted). Blocking requires the Blocker gate; failing it gives a Question.
   4. Verify that every cited file:line falls inside the diff and every premise is in the
      diff or 1 hop away. Otherwise the item is a Question with its lookup, or dropped past
      the cap.
   Pre-existing code is never a finding. A P2 Minor anchors on the branch-added occurrence.
   The coordinator may settle a Question with a read-only lookup (`grep`, reading files); if
   the answer creates a finding, it becomes one.

5. **Draft Fix and Alt yourself.** The coordinator writes the Fix and one Alt (with its
   trade-off) for each Blocking and Major item. Subagents never do.

## Output format

Tier order: Blocking, Major, Questions, Minor, Nits, Coverage gaps, Observations. Omit empty
tiers. Ids run by tier, then rank: B1, M1, Q1, I1, T1, G1, O1.

```
## Code Review: <branch> vs <base> (<base sha7>..<HEAD sha7>[, +uncommitted])
Verdict: PASS | NEEDS WORK | BLOCK - <N> blocking, <N> major, <N> minor (outside the verdict: <N> questions, <N> coverage gaps)
Test lens: not applicable.   <- only when step 3 skipped it
Objective: <one line, or the enumerated purposes>
Rules hit: KISS 2, DRY 1    <- count of the Rule principle of B/M items only; omit if none

### Major
**M1 [Major - <lens(es)>] <file:line | file:L12-L18 | file:L12,L27>: <title: the comment to post>**
- **Rule:** <the principle or rule broken, e.g. Data: every value of a type must name a domain case>
- **Evidence:** <the changed lines and what they do>
- **Impact:** <named consequence; for a strict-bumped item, the principle's concrete cost in this diff, never an invented failure>
- **Fix:** <primary fix> · **Alt:** <alternative + trade-off>

### Questions
**Q1 [Question - <lens>] <file:line>: <question to post>** · What to check: <lookup> · If <answer>: <tier>

### Minor
**I1 [Minor - <lens>] <file:line>: <comment to post>** · Suggestion: <concrete replacement or wording>

### Nits
**T1 [Nit - <lens>] <file:line>: <comment> → <exact replacement>**

### Coverage gaps
**G1 [Gap - <lens>] <file:line>: <input> → <expected>, suggested test: <name>**

### Observations
**O1 [Observation - refactor-identification] <file:line>: <note>**
```

Blocking uses the Major shape with `B1 [Blocking - ...]` under `### Blocking`. Cite every line
involved, never only the first. [NEVER] print a walkthrough, diff hunks, Strengths, FYI lines,
a `Data:` line or any harvest step. The final message is the complete report with the English
headers above; nothing before or after it.

## Rules

- [ALWAYS] pass the identical diff and objective to all four lenses; [NEVER] let one derive its own scope.
- [ALWAYS] derive the verdict from tiers only: BLOCK iff at least one B, NEEDS WORK iff at least one M, else PASS. Q, I, T, G and O never change it.
- [ALWAYS] read `references/merge-rules.md` before merging.
- [ALWAYS] keep gates G1-G6 as the checklist lens defines them; the coordinator adds none and drops none.
- [NEVER] loosen or tighten a lens's Boundaries section.
- [NEVER] treat pre-existing, unmodified code as a finding.
- [NEVER] write or edit code, in the coordinator or any subagent. The pass is read-only.
- [ALWAYS] create temp files with `mktemp` and delete them before the final message.
