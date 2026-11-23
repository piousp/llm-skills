---
name: pablo-code-simplify
description: >-
  Plans a behavior-preserving simplification of a diff, branch, PR, file, function or pasted code as ordered steps, each pinned by a test; structural analysis covers Java, Scala, JS and TS. [NEVER] edits code. Use for "simplify this code", "clean up this function" or "clean up this code". [DO NOT] use for refactor candidates (refactor-identification), bug hunting (qa-adversary), branch or PR review (pablo-code-review, pablo-pr-review), applying the changes, or non-code text.
---

# pablo-code-simplify

Turns one scope into an ordered plan of behavior-preserving steps. Coordinator-only and
read-only on the repository: [NEVER] write or edit code; someone else applies the plan.

`refactor-identification` finds structural candidates without judging whether applying one
changes behavior; `pablo-code-philosophy` guides code being written. [ALWAYS] keep only the
changes that provably preserve behavior, in an order a reviewer can verify step by step.

## Process

1. **Get the scope.** Take it from the request when it names exactly one of these; otherwise
   ask once for one. [NEVER] auto-detect it from the working tree or guess between kinds.
   - A PR link, branch or commit range → resolve like `pablo-pr-review` step 1
     (`gh pr diff <url>`, `git diff <range>`, or `git diff origin/<parent>...HEAD`).
   - A file path → read the file in full.
   - A function or symbol name → locate its definition and read the containing file in full.
   - Code pasted in the chat → treat it as the full content of a file named `pasted.<ext>`,
     with the extension of its language.
   Record `Read at`, the code the line numbers refer to: the PR head
   (`gh pr view <url> --json headRefOid --jq .headRefOid`, first 7 characters), the range's
   end commit, or `git rev-parse --short HEAD`, plus `+uncommitted` when
   `git status --porcelain` lists a scoped file; `pasted` for pasted code.
   For a PR, branch or range, `Read at` must be the checked-out HEAD, because the subagents and
   steps 5 and 6 read the checked-out files; otherwise stop (Failure handling).

2. **Normalize the scope into a diff.** Both lenses get the same diff text.
   - A diff from step 1 → use it as is.
   - A file → `git diff --no-index /dev/null <file>`; exit code 1 there means "differences
     found", not an error.
   - A function → the same synthetic diff, trimmed to one hunk that covers only the symbol's
     lines (`@@ -0,0 +<start>,<count> @@`).
   - Pasted code → the same shape built by hand: `--- /dev/null`, `+++ b/pasted.<ext>`, one
     hunk, every line prefixed with `+`.
   A synthetic diff marks every scoped line as added, so `refactor-identification` reads it
   under its own Scope law. [NEVER] reframe non-diff content in a task prompt instead.

3. **Dispatch two `analyst` subagents in the same turn**, one call per lens, each with the
   identical diff from step 2. [NEVER] run them sequentially or merge them into one call:

   ```
   {"agent": "analyst", "task": "<diff>\n\nApply the refactor-identification lens to this diff only. Analyze only the changed lines; pre-existing code may surface only as 1-hop context per your own Scope law. Report structural candidates (A1-A4) with file:line evidence in your output template. Do not propose fixes.", "skills": ["refactor-identification"], "timeoutMs": 1200000}
   {"agent": "analyst", "task": "<diff>\n\nRead-only, no fixes. Report readability and simplicity problems in this diff only. Read at most 1 hop beyond it: files that directly define or use a symbol it contains. Anchor every finding on an added or modified line of the diff. Axes: cyclomatic complexity and nesting depth (KISS); speculative or unused abstractions (YAGNI); a middle-man method or class that only forwards to another object; a single-method wrapper or command class with no state; an interface or class hierarchy with exactly one implementation (YAGNI); an abstraction that reads worse than the duplication it replaces (KISS > DRY); dead code; deep nested call chains; business logic leaked into a thin entry point; comments substituting for code, including a comment that explains a misleading name; non-flat control flow that a data-shape fix would remove. Do not report a finding whose only evidence lives in test, spec or fixture code. Output one line per finding, `file:line | axis | principle | evidence`, naming the principle as pablo-code-philosophy names it, or `(none)`.", "skills": ["pablo-code-philosophy"], "timeoutMs": 1200000}
   ```

   When no file in scope is Java, Scala, JavaScript or TypeScript, dispatch only the second
   call and print `refactor-identification: out of language scope` under `### Scope`.

4. **Merge, then gate.** Wait for every dispatched result, then:
   - Same root (one fix removes both, per `pablo-pr-review` `references/merge-rules.md`
     § Root cause) → one candidate tagged `Lens: both`.
   - `refactor-identification` P3 → Not mechanical: its fix exceeds 1 hop, touches a public
     contract or crosses a module boundary. P1 and P2 enter the gate; neither sets the order.
   - `refactor-identification` Unresolved → Not mechanical, naming the missing fact. Its
     Filtered out items never become steps.
   - Drop a philosophy finding that is not anchored on an added or modified line of the diff.
   - Run every remaining candidate through the mechanical-change gate below.

5. **Resolve references.** The subagents read at most 1 hop, so for each candidate whose gate
   row cites step 5 the coordinator searches for every reference itself: codegraph if
   `.codegraph/` exists in the repo, otherwise grep, up to 3 hops.
   One hop is one reference edge: direct references are hop 1; references to a wrapper,
   override, alias or method reference that re-exposes the symbol are hop 2, and so on.
   Record the search and the sites found on the step. Move the candidate to Not mechanical
   when a reference can't be confirmed within 3 hops, when the symbol is reachable by name
   through reflection, serialization, DI, config strings or a framework naming convention,
   or when the scope is pasted code.

6. **Find pinning tests.** For each surviving candidate, search the test sources (codegraph or
   grep) for the touched symbol and its public entry point. Cite a test as `test_file:line`
   (`testName`) only after opening it and confirming that it reaches the touched code and
   asserts on the result. With no such test, or for pasted code, the step's Verify is a
   characterization test (Output format).

7. **Order the steps.** Steps apply in list order: after each one the code compiles and its
   Verify passes, and no step needs a later one. Merge steps whose line ranges overlap into
   one step: its Operation lists every merged operation, and its Tier is internal-signature
   when any of them is. With no dependency between two steps, list mechanical before
   internal-signature.

8. **Draft the plan** in the Output format below. Headings and field labels stay in English
   exactly as written, and so do the Lens, Principle, Operation and Tier values, copied from
   their source; the other field values follow the language of the user's request.

## The mechanical-change gate

A candidate becomes a step only through a row of this table; any other operation is Not
mechanical. A failed precondition moves the candidate to Not mechanical, citing it. Catalog
operations keep their names from `refactor-identification` `references/fowler-catalog.md`;
the other rows are local to this gate.

| Operation | Tier | Precondition |
|---|---|---|
| Extract Function, Extract Variable, Decompose Conditional | mechanical | Same statements, same evaluation order |
| Inline Variable, Replace Temp with Query | mechanical | The expression is pure and cheap to re-evaluate |
| Inline Function, Inline Class, Remove Middle Man | mechanical | Non-exported target (a middle man only forwards, with no logic of its own); references resolved (step 5) |
| Rename Variable, Rename Field, rename of any non-exported symbol | mechanical | Non-exported symbol; references resolved (step 5) |
| Remove Dead Code: an unused non-exported symbol, import or variable | mechanical | Zero references (step 5) |
| Remove Dead Code: a branch behind a constant guard | mechanical | The guard is constant inside the 1-hop radius; never when it comes from config, DI or another service (`refactor-identification` N9) |
| Replace Nested Conditional with Guard Clauses, Replace Control Flag with Break | mechanical | Same conditions, checked in the same order |
| Consolidate Conditional Expression | mechanical | Short-circuit order unchanged |
| Collapse duplicated branches | mechanical | `refactor-identification` N3 does not apply; folding a duplicated mutation, log, metric or other side effect into one method always fails N3 (its ‡ note) |
| Slide Statements, Split Loop | mechanical | No data dependency crossed, no side effect reordered |
| Move Statements into Function, Move Statements to Callers | mechanical | Non-exported function; references resolved (step 5); no data dependency crossed, no side effect reordered |
| Replace Loop with Pipeline | mechanical | Laziness, short-circuiting and the point where an exception is thrown unchanged |
| Split Variable, Encapsulate Variable (local only) | mechanical | Every read sees the same value as before |
| Replace Inline Code with Function Call | mechanical | The existing function returns the same result with the same effects |
| Remove a conditional that the data's shape already resolves | mechanical | The removed case is impossible by type or by an invariant visible within 1 hop |
| De-nest a call chain into named intermediate results | mechanical | Evaluation order unchanged |
| Change Function Declaration of a private, package-private or non-exported symbol | internal-signature | References resolved (step 5); no caller-visible behavior change |
| Move Field (private) | internal-signature | References resolved (step 5) |
| Replace Parameter with Query | internal-signature | The query is pure over the same object; references resolved (step 5) |

**Disqualifies (always Not mechanical):** any change to a public or exported signature or
contract, changed exception or error semantics, changed null/Option visibility to a caller,
changed evaluation order, laziness or short-circuiting, an added, removed or reordered side
effect (log, metric, mutation, I/O), changed thread-safety or externally visible mutability,
or a new type crossing a module boundary. `refactor-identification`'s A3 (Option/Either/domain
type) and A4 (sealed ADT) candidates land here almost every time they cross a signature:
report them, never plan them.

## Failure handling

- Empty scope (no diff lines, an empty file or an empty paste): print
  `No changes in <scope>.` and stop.
- A scope command fails (`gh` missing or not authenticated, unknown range, missing file):
  print `Scope error: <command>: <error>` and stop. [NEVER] guess another scope.
- `Read at` is not the checked-out HEAD: print
  `Scope error: Read at <sha7> is not checked out.` and stop. [NEVER] check it out yourself.
- A symbol name matches several definitions: list them as `file:line` and ask once which
  one. No match is a scope error.
- A diff too large to paste into a task: write it once to a `mktemp` file, pass the same
  path to both subagents in place of `<diff>`, and delete it before the final message. It
  is the only file this skill writes.
- A subagent fails or times out: print `<lens>: failed (<error>)` under `### Scope` and
  plan from the other lens alone. When no dispatched lens succeeds, print every failure line
  and stop. [NEVER] invent a lens's candidates.
- No `subagent` tool or no `analyst` agent: print
  `pablo-code-simplify needs the subagent tool and the analyst agent.` and stop.
  [NEVER] run the lenses inline.

## Output format

```markdown
## Simplification Plan: <scope description>

### Scope
- Source: <PR link | diff range | file path | function/symbol | pasted code>
- Read at: <sha7>[+uncommitted] or pasted
- Normalized as: <diff | synthetic diff>
- Files in scope: <N> | Context files read (hop count): <M>
- <lens>: failed (<error>)   <- only when a lens failed
- refactor-identification: out of language scope   <- only when step 3 skipped it

### Steps

1. `file:line` (`symbol`): <what changes>
   - Lens: <refactor-identification | pablo-code-philosophy | both>
   - Principle: <pablo-code-philosophy principle name, or refactor-identification A<n> smell row>
   - Operation: <gate table operation>
   - Tier: <mechanical | internal-signature>
   - References: <search performed, hop count, sites found; only when the gate row cites step 5>
   - Behavior-preservation argument: <one line: why this edit cannot change observable behavior>
   - Verify: <`test_file:line` (`testName`) | write a characterization test first: <test name> at <seam> (seam to confirm per `pablo-tdd` before implementation)>

2. ...

- (none)   <- only when no candidate clears the gate

### Not mechanical (follow-up)
- <candidate> at `file:line`, disqualified: <gate row, failed precondition, P3, or missing fact>
- (none)

### Summary: <N> steps (<x> mechanical, <y> internal-signature), <z> deferred as not mechanical
```

Emit this template verbatim, in this order. Line numbers refer to the code at `Read at`; the
symbol keeps a step findable after earlier steps shift lines. A characterization test pins the
behavior the code already has, so `pablo-tdd`'s Red, verified rule exempts it. The plan
proposes the seam; [NEVER] ask the user to confirm it during this skill. [NEVER] add an
implementation, a diff, or applied code: the output is a plan.

### Mini example

Merged candidates from `Order.java`: (a) a dead branch at line 90 and (b) a private helper
`normalize(row)` at line 41 with two callers in the same file, both from the philosophy lens;
(c) `refactor-identification` A3 "null as domain absence" on the public `findOrder(id)` at
line 12, P3.

```markdown
## Simplification Plan: src/main/java/shop/Order.java

### Scope
- Source: src/main/java/shop/Order.java
- Read at: 7c41e9a
- Normalized as: synthetic diff
- Files in scope: 1 | Context files read (hop count): 1

### Steps

1. `Order.java:90` (`applyDiscount`): remove the branch behind `if (LEGACY_MODE)`.
   - Lens: pablo-code-philosophy
   - Principle: YAGNI
   - Operation: Remove Dead Code: a branch behind a constant guard
   - Tier: mechanical
   - Behavior-preservation argument: `LEGACY_MODE` is a `private static final boolean` set to `false` in this file, so no executed path changes.
   - Verify: `OrderTest.java:57` (`appliesNoDiscountBelowThreshold`)

2. `Order.java:41` (`normalize`): inline the helper into its two callers.
   - Lens: pablo-code-philosophy
   - Principle: KISS
   - Operation: Inline Function
   - Tier: mechanical
   - References: grep `normalize(` in the repo, hop 1, 2 sites (`Order.java:58`, `Order.java:73`)
   - Behavior-preservation argument: the helper is pure and both callers already hold its input.
   - Verify: write a characterization test first: `totalSumsNormalizedRows` at `Order.total()` (seam to confirm per `pablo-tdd` before implementation)

### Not mechanical (follow-up)
- A3 null as domain absence at `Order.java:12` (`findOrder`), disqualified: P3, an Option return type changes a public signature

### Summary: 2 steps (2 mechanical, 0 internal-signature), 1 deferred as not mechanical
```

## Rules

- [NEVER] write, edit, or apply any code change, in the coordinator or either subagent.
- [NEVER] ask a subagent for a fix or correction; the coordinator drafts every step after the
  merge.
- [ALWAYS] plan only operations from the gate table; a change to a public contract or an
  observable side effect is a follow-up item, never a step.
- [NEVER] loosen `refactor-identification`'s Boundaries or Scope law; hand it a diff (step 2),
  never a request to scan more broadly.
- [NEVER] persist the plan to a file: chat output only.

## Cross-references

Load methodology from its owner by name; never duplicate it.

- `refactor-identification`: A1-A4 methodology, gates N1-N10, priorities P1-P3, and the
  operation names in `references/fowler-catalog.md`.
- `pablo-code-philosophy`: the YAGNI to KISS to DRY to SOLID pipeline, conflict precedence and
  principle names.
- `pablo-code-planning`: the Analyze, Decide, Specify shape this plan adapts for existing code
  instead of new behavior.
- `pablo-tdd`: seams; the plan proposes them and the user confirms them before any test is
  written.
- `pablo-pr-review`: diff resolution (step 1), the parallel-dispatch pattern, and the Root
  cause definition in `references/merge-rules.md`.
