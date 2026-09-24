---
name: pablo-code-simplify
description: >
  Produces a behavior-preserving simplification plan for existing code (a diff/branch, a
  single file, or one function/symbol): runs two read-only `analyst` subagents in parallel,
  one on `refactor-identification` and one on `pablo-code-philosophy`'s readability axis, then
  filters every candidate through a mechanical-change gate and emits an ordered plan the
  coordinator or another actor implements. Never writes or edits code itself. Trigger on
  "simplify this", "clean this up", "this is over-engineered", "hazlo más simple", "limpia
  este código", "reduce complexity", or any request to plan a readability refactor without
  changing behavior. [DO NOT] trigger for bug-hunting (use `qa-adversary`), a pre-merge quality
  gate on a diff (use `code-review-checklist` or `pablo-code-review`), planning new behavior
  (use `pablo-code-planning`), or identifying structural candidates without a mechanical filter
  (use `refactor-identification` directly).
---

# pablo-code-simplify

Coordinator-only orchestration, read-only end to end. [NEVER] write or edit code. The
deliverable is a plan; someone else (the coordinator in a later turn, or another actor)
implements it.

## What makes this skill different

`refactor-identification` identifies structural candidates without judging whether applying
one changes behavior. `pablo-code-philosophy` is written to guide someone who is already
writing code. This skill's job is narrower and stricter than either: take their output and
keep only the changes that provably preserve behavior, in an order a reviewer can verify step
by step.

## Process

1. **Get the scope.** Ask the user for exactly one of:
   - A diff/branch/PR link → resolve like `pablo-code-review` step 1 (`gh pr diff <url>`,
     `git diff <range>`, or `git diff origin/<parent>...HEAD`).
   - A file path → read it in full.
   - A function/symbol name → locate it and read its containing file in full.
   [NEVER] auto-detect the scope or guess between these three.

2. **Normalize the scope into a supplied-diff contract.** `refactor-identification`'s Scope
   law only accepts a diff, a commit range, or diff content; anything else it treats as
   out-of-scope and filters via N4. When the scope is a file or a function, don't fight this:
   hand the actor the verbatim content and state explicitly in its task prompt: "Treat this
   supplied content as the diff in full; every line is in-scope for anchoring. Do not derive a
   different scope, do not run git, do not narrow to a hunk." The 1-hop context rule still
   applies on top of that content.

3. **Dispatch two `analyst` subagents in parallel** (never sequential, never merged into one
   call):

   - `agent: "analyst"`, `skills: ["refactor-identification"]`, `timeoutMs: 1200000`: task:
     the normalized scope (step 2's framing) plus "Apply the refactor-identification lens to
     this content. Report structural candidates (A1-A4) only, each with file:line evidence. Do
     not propose fixes."
   - `agent: "analyst"`, `skills: ["pablo-code-philosophy"]`, `timeoutMs: 1200000`: task: the
     same scope content plus this explicit axis list, since the philosophy skill is written
     for someone writing code, not reviewing it: "Report readability/simplicity problems only,
     each with file:line evidence, read-only, no fixes: cyclomatic complexity and nesting depth
     (KISS), speculative or unused abstractions (YAGNI), an abstraction that reads worse than
     the duplication it replaces (KISS > DRY), dead code, deep nested call chains, business
     logic leaked into a thin entry point, comments substituting for code, and any non-flat
     control flow that a data-shape fix would remove."

   Both dispatches pass the identical scope content. Leave `tools` at the analyst default
   (read-only). [NEVER] ask either subagent for a fix, correction, or implementation: that step
   happens later, in the coordinator.

4. **Merge, then gate every candidate through the mechanical-change table below.** Same-root
   candidates raised by both actors collapse into one line, tagged `Lens: both`. When scope was
   normalized from a file or function (step 2), ignore `refactor-identification`'s P1/P2/P3
   priorities: under that framing every line reads as "added", so the priorities carry no
   signal. Ordering comes from step 6, not from them.

5. **Resolve call sites for internal-signature candidates.** Both subagents stay capped at 1
   hop by their own scope rules. For any candidate that needs a signature change, the
   coordinator itself searches for every call site (codegraph if `.codegraph/` exists in the
   repo, otherwise grep), up to 3 hops. Record the search performed and the sites found on the
   step. If a call site can't be confirmed within 3 hops, move the candidate to "Not
   mechanical" instead of asserting safety on no evidence.

6. **Order the surviving steps** so each one is independently applicable and leaves the code
   in a working state (no step depends on a later step's result).

7. **Draft the plan** in the Output format below, in the language of the user's request (no
   canonical output language). [NEVER] persist it to a file: chat output only, same as
   `pablo-code-review`.

## The mechanical-change gate

This is the filter that makes the plan safe to hand off; a candidate that doesn't clear it
never becomes a step.

**Qualifies, no signature change:**
extract or inline a method/variable, flatten with early-return, collapse duplicated branches,
remove dead code or an unused import/variable, rename a non-exported symbol, move a pure
computation, replace a conditional that the data's own shape already resolves, de-nest a call
chain.

**Qualifies, internal signature change (separate risk tier):** changing the signature of a
private/package-private/non-exported symbol, when every call site is found and updated within
the scope plus up to 3 hops of context (resolved per Process step 5), and no caller-visible
behavior changes as a result. Mark every such step with `[internal-signature]` so the reviewer
weighs it deliberately.

**Disqualifies, moves to "Not mechanical":** any change to a public/exported signature or
contract, changed exception/error semantics, changed null/Option visibility to a caller,
changed evaluation order, laziness, or short-circuiting, an added/removed/reordered side
effect (log, metric, mutation, I/O), changed thread-safety or externally visible mutability,
or a new type crossing a module boundary. `refactor-identification`'s A3 (introduce
Option/Either/domain type) and A4 (sealed ADT) candidates land here almost every time they
cross a signature: report them, never plan them.

## Output format

```markdown
## Simplification Plan: <scope description>

### Scope
- Source: <diff range | file path | function/symbol> | Normalized as: <diff | verbatim content>
- Files in scope: <N> | Context files read (1-hop or further, note the hop count): <M>

### Steps

1. `file:line`: <what changes>
   - Lens: <refactor-identification | pablo-code-philosophy | both>
   - Principle: <KISS | DRY | YAGNI | SOLID | A1-A4 category>, cited to its source skill
   - Tier: <mechanical | internal-signature>
   - Call sites (internal-signature steps only): <search performed, hop count, sites found>
   - Behavior-preservation argument: <one line: why this specific edit cannot change
     observable behavior>
   - Verify: <existing test that pins this behavior, or "write a characterization test first"
     if none exists, cross-ref `pablo-tdd`>

2. ...

(if no candidate qualifies as mechanical: `- (none)`)

### Not mechanical (follow-up)
- <candidate> at `file:line`, disqualified: <which rule from the gate table>
- (none)

### Summary: <N> steps (<x> mechanical, <y> internal-signature), <z> deferred as not mechanical
```

Emit this template verbatim. If a step has no existing test pinning its behavior, its Verify
line names the characterization test to write first, never skips verification. [NEVER] add an
implementation, a diff, or applied code to this output: it is a plan.

## Rules

- [NEVER] write, edit, or apply any code change, in the coordinator or either subagent. This
  pass is read-only end to end.
- [ALWAYS] pass the identical, normalized scope content to both subagents.
- [ALWAYS] run every surviving candidate through the mechanical-change gate before it becomes
  a step; a candidate that changes a public contract or an observable side effect is a
  follow-up item, never a step.
- [ALWAYS] tag an internal-signature step explicitly and confirm all call sites were found
  within the stated hop count; if a call site can't be confirmed within reach, move the
  candidate to "Not mechanical" instead of guessing.
- [NEVER] loosen `refactor-identification`'s Boundaries or Scope law; supply scope via the
  verbatim-content framing in step 2, never by asking it to scan more broadly.
- [NEVER] ask a subagent for a fix or correction; the coordinator drafts every step itself
  after the merge.
- [NEVER] persist the plan to a file: chat output only.
- [ALWAYS] order steps so each is independently applicable without depending on a later step.

## Cross-references

Load methodology from its owner by name; never duplicate it.

- `refactor-identification`: full A1-A4 methodology, thresholds, gates, worked examples.
- `pablo-code-philosophy`: YAGNI to KISS to DRY to SOLID pipeline and conflict precedence.
- `pablo-code-planning`: the Analyze, Decide, Specify shape this plan adapts for existing code
  instead of new behavior.
- `pablo-tdd`: what a characterization test is and how to write one at a seam.
- `pablo-code-review`: the diff-resolution and parallel-dispatch pattern this skill follows.
