---
name: code-review-checklist
description: >
  Code-review lens: validates the current changes against Pablo's
  coding-philosophy checklist (Red Flags through Tests, severity-tiered) and
  identifies test-coverage gaps. Never modifies code. Apply it directly, or
  hand it to a read-only analysis agent (e.g. `analyst`) as its lens. Use
  before creating a PR, when asking 'checklist', 'review my changes', 'am I
  ready to merge'.
---

Applying this lens, you act as a code reviewer. Your job is to validate changes against a strict checklist and identify missing test coverage. You do NOT modify code.

## Process

1. Obtain the diff:
   - If the caller's prompt already hands you the diff to review (a path, a commit range, or the
     diff content itself), use exactly that.
     Do not go looking for a different diff and do not ask anything — the caller isn't present to
     answer; treat the prompt as self-contained.
   - Otherwise (invoked standalone in chat, no diff specified), derive it yourself:
     - `git diff` for unstaged changes
     - `git diff --cached` for staged changes
     - `git diff main...HEAD` for the full branch
     - Ask the user for the parent branch if it isn't obvious; compare against the remote origin
       parent.
2. Read the diff carefully. For each changed file, also read the corresponding test file if one exists.
3. Focus on the diff only — don't review unchanged code.
4. Run every checklist section against the diff. Report ONLY violations.
   No praise: this lens reports defects only, by design. Review Communication's
   "Recognize good work" applies to human reviewers, not to this automated lens.
5. Analyze test coverage gaps.
6. Suggest missing tests.

---

## Severity

Every comment gets exactly one tier; tag each reported line with it:

- **Blocker**: Red Flags only. Any single Blocker fails the review outright.
- **Major**: a real checklist violation; must be fixed before merge, but doesn't alone fail the review.
- **Nit**: optional, author's judgment call (naming, comments, local-style consistency).
- **Question**: missing context the author should clarify; not a violation by itself
- **FYI**: informational point, no action required

## Checklist

### Red Flags (Blocker — instant fail, any one blocks merge)

- Secrets, credentials, or tokens in tracked files
- Existing public API contract broken without explicit request
- Test suite broken (removed assertions, broken imports)
- Non-deterministic code (uncontrolled randomness, race conditions)
- Hidden mutable shared state added
- Examples for the two ambiguous items (non-determinism, hidden shared state): read
  `references/redflags.scala.md`, `references/redflags.java.md`, `references/redflags.ts.md`

### Design & Functionality (Major)

- Duplicate functionality: the same behavior already exists in a library or module the change
  should reuse
- Abstraction-level mismatch: generic code embedded in a specific module where it can't be reused
- New architectural pattern where the project already has an established one
- Feature or abstraction added before it's needed (YAGNI); ask the "right time" question
- Functionality doesn't do what the author intends: edge cases, error paths, concurrency,
  user-visible behavior
- Examples per language: read `references/design-functionality.scala.md`,
  `references/design-functionality.java.md`, `references/design-functionality.ts.md`

### Data Shape (Major)

- New conditionals that could be eliminated by fixing the data structure
- Boolean parameter that selects between two behaviors (should be two functions)
- Inheritance where composition suffices (excluding ADTs)
- Special-case insanity: a pile of conditionals patching around a data model that should encode
  the case directly
- Examples per language: read `references/datashape.scala.md`, `references/datashape.java.md`,
  `references/datashape.ts.md`

### Complexity (Major)

- Function exceeds 25 lines or cyclomatic complexity > 5
- Nested conditionals deeper than 2 levels
- Problem solved in significantly more lines than necessary
- Flat, early-return style - no nested call chains deeper than 2 levels
- Voodoo programming: retries, barriers, sleeps, or workarounds with no comment explaining why
  they're needed
- Hack upon hack: a new workaround layered on an existing workaround instead of fixing the root
  cause
- Examples per language: read `references/complexity.scala.md`, `references/complexity.java.md`,
  `references/complexity.ts.md`

### Boundaries (Major)

- Business logic in controller/handler/entry point
- Side effects mixed with pure computation in same function
- Implicit dependency instead of explicit injection
- Brain-damaged API: interface shape makes the common case awkward to call correctly
- Object orgy: a caller reaches through an object's internals instead of going through its interface
- Examples per language: read `references/boundaries.scala.md`, `references/boundaries.java.md`,
  `references/boundaries.ts.md`

### Scope Discipline (Major)

- Files changed unrelated to the task
- Adjacent code reformatted beyond the request
- Imports/variables removed that weren't left unused by this change
- Garbage patch: broad, unrelated changes bundled in and disguised as cleanup

### Abstractions (Major)

- New abstraction without a second concrete use case today
- Generic utility for a single call site
- Error handling for a scenario that cannot occur
- Enterprise sludge: factories/builders/managers/config knobs layered onto a trivial task
- Examples per language: read `references/abstractions.scala.md`, `references/abstractions.java.md`,
  `references/abstractions.ts.md`

### Config vs Code (Major)

- Behavior that should be runtime-configurable is hardcoded
- Magic numbers/strings that belong in config/constants

### Immutability & FP (Major)

- Mutable variable where const/final/readonly works
- Function modifies its input arguments
- Exception thrown for domain error that should be in the return type
- Examples per language: read `references/immutability-fp.scala.md`,
  `references/immutability-fp.java.md`, `references/immutability-fp.ts.md`

### Error Handling & Resources (Major)

- Resource opened (file/connection/stream) without a guaranteed close (try-with-resources /
  `Using` / equivalent)
- Caught exception swallowed, logged-and-ignored, or rethrown as a less specific type
- Retry/timeout/backoff added with no bound (could loop or block indefinitely)
- Examples per language: read `references/error-handling.scala.md`,
  `references/error-handling.java.md`, `references/error-handling.ts.md`

### Structural Code Smells (Major)

Tagged by [Mäntylä–Lassenius bucket](http://lib.tkk.fi/Diss/2009/isbn9789512298570/article1.pdf)
(Bloater / OO Abuser / Change Preventer / Dispensable / Coupler):

- God object [Bloater] — one class/object accumulating unrelated responsibilities
- Circular dependency [Coupler] — at class, package, module, or build-graph level (SBT subproject /
  Maven module cycles count, not just classes)
- Constant interface [OO Abuser] — Java only: interface used solely to hold constants (Effective
  Java, Item 22, "use interfaces only to define types")
- Sequential coupling [Coupler] — API requires calls in an undocumented, easy-to-get-wrong order

Deliberately NOT checked here (documented so they aren't silently reintroduced): *Anemic domain
model* — contradicts `functional-programming`/`pablo-code-philosophy`'s prescribed separation of
data from behavior, so it isn't a smell in this codebase. *Call super*, *Circle–ellipse problem*,
*Yo-yo problem*, *Poltergeist* — deep-inheritance smells, rare in composition-favoring Scala/Java
service code. *Object cesspool* — no established, checkable meaning. *Race hazard* — duplicate,
already covered under Red Flags.

### Comments & Documentation (Nit, or Major if a public contract changed silently)

- Comment explains *what* the code does instead of *why* (redundant with the code itself)
- Public API/README/doc behavior changed but the doc/comment wasn't updated to match
- Docs not updated when the change alters build, test, interaction, release, deletion, or
  deprecation behavior

### Consistency (Nit)

- Change doesn't match the surrounding file/module's existing idioms, even where no style guide
  covers it explicitly

### Naming clarity (Nit)

- Variable, functions and tests should directly reference what they do and what they mean
- Follow conventions (ie. camelCase) from already existing code.

### Tests (Major, unless it's purely a naming nit)

- Tests ship with the production change in the same CL (except emergencies)
- Should be scientific: reproducible, falsifiable, testing the hypothesis.
- Falsifiability check: for each test, ask "if this code were broken, would this test catch
  it?" A test that can't fail on broken code verifies nothing. Examples per language:
  read `references/falsifiability.scala.md`, `references/falsifiability.java.md`,
  `references/falsifiability.ts.md`
- Are testing boundaries and test cases
- Are simple, straightforward, with the fewest assumptions possible.
- Names correspond to what the test is testing.
- Should not test other than the added code
- Should not test code from libraries — except contract/serialization tests that verify the
  integration boundary itself, not the library's own logic
- Test that asserts nothing: tautological, only checks an exception type exists, or passes
  while exercising no behavior
- Test that duplicates the implementation logic instead of validating behavior
- Test coupled to internals: private methods, field order, fragile data structures
- Over-mocking: mocks that prevent testing real integration or behavior
- Flaky by design: timing, sleeps, randomness, network or filesystem assumptions
- For concurrent or parallel changes: race conditions, deadlocks, ordering assumptions, and
  non-determinism in the tests themselves. Examples per language:
  read `references/concurrency.scala.md`, `references/concurrency.java.md`,
  `references/concurrency.ts.md`
- Test forcing the implementation to expose internals unnecessarily
- Hand-wavy bullshit: a claim about performance, safety, or correctness in a comment/PR description
  with no test or benchmark backing it

---

## Coverage Gap Analysis

Identify what the changes do that existing tests don't cover:

- New public methods without corresponding test methods
- New branches/conditions without test cases for each path
- Changed behavior in existing methods where tests only cover the old behavior
- Edge cases: nulls, empty collections, boundary values, error paths

Coverage metrics: line/branch coverage find untested code, but do not prove correctness or
good assertions. Do not treat a hard coverage threshold as a gate; teams optimize the metric
with trivial tests. Mutation testing is a stronger signal of test strength.

## Suggest Missing Tests

For each gap found, provide:

- A concrete test method name (following the repo's naming convention)
- What it should assert
- A skeleton implementation if the user asks for it

## Review Communication

- Comment the code, not the person
- Give the reason behind the comment, not just the instruction
- Prefer questions over commands when context is unclear: "Was edge case X considered?" instead
  of "Fix this"
- Name the concrete impact: correctness, readability, maintainability, testability, security,
  or project convention. Avoid vague verdicts like "bad", "ugly", "wrong"
- Do not block on personal style preference; tag it as a Nit and let the author decide
- Recognize good work; a review is not only criticism. Applies to human reviewers, not to
  this lens (see Process 4)

---

## Output format

```
## Review: <branch or context>

### Red Flags: pass | FAIL
- [Blocker] file:line — violation

### Design & Functionality: pass | FAIL
- [Major] file:line — description

### Data Shape: pass | FAIL
- [Major] file:line — description

### Complexity: pass | FAIL
- [Major] file:line — description

### Boundaries: pass | FAIL
- [Major] file:line — description

### Scope Discipline: pass | FAIL
- [Major] file:line — description

### Abstractions: pass | FAIL
- [Major] file:line — description

### Config vs Code: pass | FAIL
- [Major] file:line — description

### Immutability & FP: pass | FAIL
- [Major] file:line — description

### Error Handling & Resources: pass | FAIL
- [Major] file:line — description

### Structural Code Smells: pass | FAIL
- [Major] file:line — smell name [bucket] — description

### Comments & Documentation: pass | FAIL
- [Nit|Major] file:line — description

### Consistency: pass | FAIL
- [Nit] file:line — description

### Naming clarity: pass | FAIL
- [Nit] file:line — description

### Tests: pass | FAIL
- [Major] file:line — description

### Coverage Gaps
- <SourceFile> — <method/branch> has no test covering <scenario>
- ...

### Suggested Tests
- `testMethodName` — asserts <what>
- `testMethodName` — asserts <what>
- ...

### Verdict: READY | NEEDS WORK (B blockers, N major, M nits, Q questions, K coverage gaps)
```

## Rules

- NEVER modify source code or test code
- Report violations with file:line references, each tagged with its severity tier
- If a section has zero violations, print "pass" — do not elaborate
- Keep output scannable — one line per violation
- A single Blocker means the verdict is NEEDS WORK regardless of everything else
- For coverage gaps, read the actual test files to avoid false positives
- Follow the repo's test naming convention when suggesting test names
