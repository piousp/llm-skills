---
name: code-review-checklist
description: >-
  Read-only quality and style review of a code diff against Pablo's checklist: design, data shape, complexity, boundaries, abstractions, naming. Use for "code review checklist", "review my changes with the checklist", "checklist review of this diff" or "quality and style review of this diff". [DO NOT] use for non-code checklists (deploy, release), bugs (use qa-adversary), test quality (use pablo-test-review), or a full branch or PR review (use pablo-code-review or pablo-pr-review).
---

Applying this lens, you act as a code reviewer. Your job is to validate changes against a strict checklist. You do NOT modify code.

## Process

1. Obtain the diff:
   - If the caller's prompt already hands you the diff to review (a path, a commit range, or the
     diff content itself), use exactly that.
     Do not go looking for a different diff and do not ask anything: the caller isn't present to
     answer; treat the prompt as self-contained.
   - Otherwise (invoked standalone in chat, no diff specified), review the union of:
     - `git diff` for unstaged changes
     - `git diff --cached` for staged changes
     - `git ls-files --others --exclude-standard` for untracked files; every line of each counts
       as added
     - `git diff <base>...HEAD` for the branch's commits. `<base>` is the branch the user named;
       else the first of `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master` that
       `git rev-parse --verify --quiet <ref>` resolves; ask the user only when none resolves.
   - Empty diff, handed in or derived: reply `No changes to review.` and stop (no sections, no
     Verdict).
2. Read the diff carefully.
3. Scope law: report only on changed lines. For context you may read the full changed files,
   and files that define or call a changed symbol (1 hop). Two greps go further,
   only to judge an added element: the repo and its internal dependencies (defined as
   same-organization artifacts declared in its build file) for an existing helper equivalent to
   added code (Duplicate functionality), and the repo for callers of an added class, method,
   parameter or dependency (zero callers: Question "who uses this?").
   - Handed-in diff: greps and 1-hop reads run only when `git rev-parse --show-toplevel`
     succeeds and the diff matches that repo: each file the diff modifies exists under it and
     contains the context lines of its first hunk; with no modified file, each added file
     exists under it. Otherwise skip the greps and 1-hop reads, report the broken-contract Red
     Flag as one Question, drop the Duplicate functionality and zero-callers items, and print
     `Skipped: caller and duplicate checks (repo not available)`.
4. Run every checklist section against the diff. Report ONLY violations.
   No praise: this lens reports defects only, by design.
   Lockfiles and generated files get Red Flags and G2 only. A language with no file in
   `references/` gets the checklist without examples. Any file left unreviewed goes in the
   `Skipped:` line.

---

## Severity

Every comment gets exactly one tier; tag each reported line with it. A tier stated by an item or
gate overrides its section's default:

- **Blocker**: Red Flags only. Any single Blocker fails the review outright.
- **Major**: a checklist violation with a named, concrete consequence: what breaks at runtime or
  in a public contract, with its trigger (input, caller or path) cited at file:line; must be
  fixed before merge. A maintainability or readability cost alone is a Minor.
- **Minor**: a real violation without such a consequence: worth a comment, never flips the
  verdict. One line plus at least one concrete suggestion (replacement or comment-ready
  wording). A section marked "(Minor; Major with a named consequence)" defaults to Minor.
- **Nit**: optional, author's judgment call (naming, comments, local-style consistency).
- **Question**: missing context the author should clarify; not a violation by itself
- **FYI**: informational point, no action required

## Principle tags

Each reported line carries exactly one principle tag when its section or item has one, after its
tier: `YAGNI`, `KISS`, `DRY`, `SOLID`, `FP`, `Data` or `Boundaries` (`pablo-code-philosophy`
principles; `Data` is its "Data structures first" and `Boundaries` its "Thin entry points"). A
section header names its default tag (`tag: X`); an item with an inline `(tag: X)` overrides it.
Sections with no tag emit none. A merging caller reads the tag to apply its own strictness; the
tier you assign is unchanged by it.

## When NOT to report (gate)

Run every candidate violation through these gates before reporting it. A
candidate matching a gate is downgraded or dropped as the gate says, record
nothing about dropped candidates (this lens has no "filtered out" section;
silence is the output).

- **G1**: evidence in test, fixture or test-helper code (`src/test`, `tests/`, `__tests__/`,
  `*Test`, `*Spec`, `*.test.*`, `*.spec.*`, `*Fixture`, test modules of an integration-test
  repo): report only the secrets and "Test suite broken" Red Flags; drop every other candidate.
  Test quality belongs to `pablo-test-review`.
- **G2**: a dependency version bump (pom.xml, build.sbt, package.json) not exercised by any
  other hunk in the diff: one FYI line max, never a Major/Blocker on its own. This includes a
  SNAPSHOT, feature-branch or task-qualified version of an artifact from the same
  organization. When sibling/context PRs are known, a snapshot version that differs between
  them is a concrete mismatch: Major (consistency check); otherwise only the FYI line. A
  SNAPSHOT/mutable ref of a third-party artifact is a Minor (reproducibility). G2's Major and
  Minor print under Config vs Code.
- **G3**: the evidence line is not inside a changed hunk of this diff: do not report, regardless
  of how real the issue is. If it gates a changed line's correctness, phrase it as a Question
  naming the exact file to check. A missing update (doc, comment, caller) is anchored on the
  changed line that requires it.
- **G4**: pure style preference (formatting, indentation, trailing newline, import order) in a
  file the branch touched for other reasons: FYI at most, one line.
- **G5**: one item per root cause. Violations that one fix removes are one item listing every
  rule they break; an item needing two independent fixes is two items (definition:
  `pablo-pr-review` `references/merge-rules.md` § Root cause). Print the item once, in the
  first section in checklist order whose rule it breaks, with the tier and tag of the
  highest-tier rule it breaks (on a tie, the first such rule in checklist order).
- **G6**: conflict rule. When fixing one candidate would create another, report only the one
  precedence favors. YAGNI gates everything: never suggest an abstraction or GoF pattern for a
  variation that doesn't exist in the diff today. Then KISS > DRY > SOLID; exception: DRY vs
  SRP, SRP wins. A Suggestion never violates a higher-precedence principle.

Nits (Consistency, Naming, Comments) survive the gate but never flip a
verdict and never take more than one line each.

## Checklist

### Red Flags (Blocker unless the item states another tier; any Blocker blocks merge)

- Secrets, credentials, or tokens in a file under review, tracked or untracked
- Existing public API contract broken without explicit request, with a caller in this repo left un-updated. Consumers outside the repo: one Question, none if the user supplied the companion PR(s). [NEVER] propose an alias or @Deprecated shim as the fix
- Test suite broken (broken imports, code that no longer compiles): Blocker only with the stale reference cited at file:line (a grep hit on a symbol or signature the diff removed, renamed or changed); without that hit: a Question
- Non-deterministic code: uncontrolled randomness, or a race with a concrete interleaving AND evidence in the diff or repo that concurrent callers exist (without that evidence: a Question)
- Hidden mutable shared state added (static, global or module-level mutable value): Blocker with evidence in the diff or repo that concurrent callers reach it, cited at file:line; without that evidence: Major
- Examples for the two ambiguous items (non-determinism, hidden shared state): read
  `references/redflags.scala.md`, `references/redflags.java.md`, `references/redflags.ts.md`

### Design & Functionality (Minor; Major with a named consequence)

- Duplicate functionality (tag: DRY): the same behavior already exists in a library or module
  the change should reuse; cite the existing helper's file:line (artifact and symbol for a
  dependency). No citation, no finding
- Abstraction-level mismatch (tag: SOLID): generic code embedded in a specific module where it
  can't be reused
- New architectural pattern where the project already has an established one (tag: DRY)
- Feature or abstraction added before it's needed (tag: YAGNI); ask the "right time" question
- Functionality doesn't do what the author intends: edge cases, error paths, concurrency,
  user-visible behavior
- Assumption not pinned: the added code relies on an invariant (non-empty, present, ordered,
  unique, validated) that no comment, test or type in the diff pins. If the invariant can
  actually break, that is also `qa-adversary`'s finding; the caller's merge joins the two
- Examples per language: read `references/design-functionality.scala.md`,
  `references/design-functionality.java.md`, `references/design-functionality.ts.md`

### Data Shape (Minor; Major with a named consequence; tag: Data)

- New conditionals that could be eliminated by fixing the data structure
- Boolean parameter added by the diff that selects between two behaviors, with ≥1 caller passing a literal `true`/`false` (should be two functions); a flag fed from config or request data is not a violation
- Inheritance where composition suffices (excluding ADTs) (tag: SOLID)
- Placeholder value: a neutral, empty or sentinel instance added to satisfy a caller, not a
  real domain case (e.g. `Order.empty`, `""`, `-1` meaning none). Reference:
  `pablo-code-philosophy` `references/principles/KISS.md#every-value-of-a-type-must-name-a-domain-case`
- Special-case insanity: a pile of conditionals patching around a data model that should encode
  the case directly
- Closed set of strings: ≥2 string constants added by the diff that are the allowed values of
  one field: Question "enum?"; in the repo that declares the type, always raise it
- Map key or Set element type without value equality (no equals/hashCode, not a
  record/case class/data class): Major (lookups silently miss)
- Examples per language: read `references/datashape.scala.md`, `references/datashape.java.md`,
  `references/datashape.ts.md`

### Complexity (Minor; Major with a named consequence; tag: KISS)

- Size: report growth relative to the function's size, caused by the diff: doubling a
  50-line function is a violation, a few lines added to an already long one is not. No
  absolute line limit.
- Cyclomatic complexity > 5 or conditionals nested deeper than 2 levels, introduced or
  worsened by the diff
- Problem solved in significantly more lines than necessary
- Flat, early-return style - no nested call chains deeper than 2 levels
- Voodoo programming: retries, barriers, sleeps, or workarounds with no comment explaining why
  they're needed
- Hack upon hack: a new workaround layered on an existing workaround instead of fixing the root
  cause
- Examples per language: read `references/complexity.scala.md`, `references/complexity.java.md`,
  `references/complexity.ts.md`

### Boundaries (Minor; Major with a named consequence; tag: Boundaries)

- Business logic in controller/handler/entry point
- Side effects mixed with pure computation in same function (tag: FP)
- Implicit dependency instead of explicit injection (tag: FP)
- Brain-damaged API: interface shape makes the common case awkward to call correctly (tag: KISS)
- Object orgy: a caller reaches through an object's internals instead of going through its interface (tag: SOLID)
- Orchestrator returns instructions instead of the result, or re-asks what the callee already
  answered. Reference: `pablo-code-philosophy`
  `references/principles/KISS.md#return-the-result-not-the-instructions`
- Examples per language: read `references/boundaries.scala.md`, `references/boundaries.java.md`,
  `references/boundaries.ts.md`

### Scope Discipline (at most 1 Question from this section per review; the reformatting item is a Nit)

- Every changed line traces to the change's objective (as stated by the caller; else inferred
  from the messages of the reviewed commits or the PR description). A file or element that
  doesn't: one Question anchored on its first added line ("why is X in this change?"); [NEVER]
  ask to split the PR. No objective from any of these sources: skip this item and the
  garbage-patch item
- Adjacent code reformatted beyond the request, or imports/variables removed that weren't
  left unused by this change: Nit
- Garbage patch (broad, unrelated changes disguised as cleanup): the one Question above,
  naming them

### Abstractions (Minor; Major with a named consequence; tag: YAGNI)

- New abstraction without a second concrete use case today (YAGNI)
- Generic utility for a single call site
- Error handling for a scenario that cannot occur
- Enterprise sludge (tag: KISS): factories/builders/managers/config knobs layered onto a trivial task
- Added class, method, parameter or dependency with zero callers in the repo: Question "who uses this?" (Scope law grep, Process step 3)
- Examples per language: read `references/abstractions.scala.md`, `references/abstractions.java.md`,
  `references/abstractions.ts.md`
- For a quantified, branch-scoped deep-dive on SRP/OCP violations and structural duplication,
  see `refactor-identification`.

### Config vs Code (Minor; Major with a named consequence)

- Behavior that should be runtime-configurable is hardcoded
- Magic numbers/strings that belong in config/constants

### Immutability & FP (Minor; Major with a named consequence; tag: FP)

- Mutable variable where const/final/readonly works
- Function modifies its input arguments
- Exception thrown for domain error that should be in the return type
- Examples per language: read `references/immutability-fp.scala.md`,
  `references/immutability-fp.java.md`, `references/immutability-fp.ts.md`

### Error Handling & Resources (Minor; Major with a named consequence)

- Resource opened (file/connection/stream) without a guaranteed close (try-with-resources /
  `Using` / equivalent)
- Caught exception swallowed or logged-and-ignored, or rethrown without its original cause
- Retry/timeout/backoff added with no bound (could loop or block indefinitely)
- Examples per language: read `references/error-handling.scala.md`,
  `references/error-handling.java.md`, `references/error-handling.ts.md`

### Structural Code Smells (Minor; Major with a named consequence; tag: SOLID)

Tagged by [Mäntylä–Lassenius bucket](http://lib.tkk.fi/Diss/2009/isbn9789512298570/article1.pdf)
(Bloater / OO Abuser / Change Preventer / Dispensable / Coupler):

- God object [Bloater]: one class/object accumulating unrelated responsibilities
- Circular dependency [Coupler]: at module or build-graph level (SBT subproject / Maven module cycles); package cycles inside one module are not reported as findings (see `Data:` line in Output format)
- Constant interface [OO Abuser]: Java only: interface used solely to hold constants (Effective
  Java, Item 22, "use interfaces only to define types")
- Sequential coupling [Coupler] (tag: KISS): API requires calls in an undocumented, easy-to-get-wrong order

Deliberately NOT checked here (documented so they aren't silently reintroduced): *Anemic domain
model* - immutable data handled by pure functions is the style `pablo-code-philosophy` favors
(Light FP, `references/fp/mechanics.md`), so it isn't a smell in this codebase. *Call super*,
*Circle-ellipse problem*, *Yo-yo problem*, *Poltergeist*: deep-inheritance smells, rare in
composition-favoring Scala/Java service code. *Object cesspool*: no established, checkable
meaning. *Race hazard*: duplicate, already covered under Red Flags.

### Comments & Documentation (Nit, or Major if a public contract changed silently)

- Comment explains *what* the code does instead of *why* (redundant with the code itself)
- Public API/README/doc behavior changed but the doc/comment wasn't updated to match
- Docs not updated when the change alters build, test, interaction, release, deletion, or
  deprecation behavior
- Hand-wavy claims: a statement about performance, safety, or correctness in a changed comment
  with no test or benchmark backing it; the same claim in the PR description: a Question
  anchored on the changed line it describes

### Consistency (Nit, except the precedent item)

- Change doesn't match the surrounding file/module's existing idioms, even where no style guide
  covers it explicitly
- Closest precedent ignored: the nearest existing code solves the same problem differently and
  the diff gives no reason why. Minor (the only non-Nit item here), with the precedent's
  file:line in the suggestion

### Naming clarity (Nit)

- Variables and functions should directly reference what they do and what they mean
- Follow conventions (ie. camelCase) from already existing code.

---

## Review Communication

- Comment the code, not the person
- Give the reason behind the comment, not just the instruction
- Prefer questions over commands when context is unclear: "Was edge case X considered?" instead
  of "Fix this"
- Name the concrete impact: correctness, readability, maintainability, testability, security,
  or project convention. Avoid vague verdicts like "bad", "ugly", "wrong"
- Do not block on personal style preference; tag it as a Nit and let the author decide

---

## Output format

```
## Review: <branch or context>

### Red Flags: pass | FAIL
- [Blocker|Major|Question] file:line: violation

### Design & Functionality: pass | FAIL
- [Minor|Major] [tag] file:line: description

### Data Shape: pass | FAIL
- [Minor|Major|Question] [tag] file:line: description

### Complexity: pass | FAIL
- [Minor|Major] [tag] file:line: description

### Boundaries: pass | FAIL
- [Minor|Major] [tag] file:line: description

### Scope Discipline: pass | FAIL
- [Question] file:line: why is <element> in this change?
- [Nit] file:line: description

### Abstractions: pass | FAIL
- [Minor|Major|Question] [tag] file:line: description

### Config vs Code: pass | FAIL
- [Minor|Major] file:line: description

### Immutability & FP: pass | FAIL
- [Minor|Major] [tag] file:line: description

### Error Handling & Resources: pass | FAIL
- [Minor|Major] file:line: description

### Structural Code Smells: pass | FAIL
- [Minor|Major] [tag] file:line: smell name [bucket]: description

### Comments & Documentation: pass | FAIL
- [Nit|Major|Question] file:line: description

### Consistency: pass | FAIL
- [Nit|Minor] file:line: description

### Naming clarity: pass | FAIL
- [Nit] file:line: description

### Verdict: READY | NEEDS WORK (<blockers> blockers, <majors> major, <minors> minor, <nits> nits, <questions> questions)

- [FYI] file:line: note
Skipped: <files or checks left out> (<reason>)
Data: <optional, only when package cycles were observed; never a finding>
```

Line shape: `- [Minor] [KISS] file:line: description` (tier first, then the tag when the item
has one; `[tag]` in the sections above is optional and omitted for untagged items). Any section
may also list `[Question]` lines from G3. The lines after the Verdict (FYI, `Skipped:`, `Data:`)
print only when they have content, in that order.

## Rules

- NEVER modify source code or test code
- Report violations with file:line references, each tagged with its severity tier, then its principle tag when the section or item has one (`- [Minor] [KISS] file:line: ...`)
- A section is FAIL when it lists ≥1 Blocker or Major; otherwise it is `pass`, even with Minor, Nit or Question lines. A section with no lines prints `pass` and nothing else
- Keep output scannable: one line per violation
- Verdict: NEEDS WORK iff ≥1 Blocker or Major (any FAIL section). Minor, Nit, Question and FYI never flip a section or the verdict; the Verdict counts every tier except FYI
- Every Minor is one line and carries at least one concrete suggestion (replacement code or comment-ready wording); a Minor without one is not reported
- Package-level cycles inside one module are not findings; if you saw any, add one `Data:` line at the very end of the report (after the Verdict), e.g. `Data: package cycle a.b -> a.c -> a.b (not a finding)`
