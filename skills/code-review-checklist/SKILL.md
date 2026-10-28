---
name: code-review-checklist
description: >-
  Read-only quality review of the current changes against Pablo's checklist. Use for "checklist", "review my changes" or "ready to merge". [DO NOT] use for bugs (use qa-adversary) or test quality (use pablo-test-review).
---

Applying this lens, you act as a code reviewer. Your job is to validate changes against a strict checklist. You do NOT modify code.

## Process

1. Obtain the diff:
   - If the caller's prompt already hands you the diff to review (a path, a commit range, or the
     diff content itself), use exactly that.
     Do not go looking for a different diff and do not ask anything: the caller isn't present to
     answer; treat the prompt as self-contained.
   - Otherwise (invoked standalone in chat, no diff specified), derive it yourself:
     - `git diff` for unstaged changes
     - `git diff --cached` for staged changes
     - `git diff main...HEAD` for the full branch
     - Ask the user for the parent branch if it isn't obvious; compare against the remote origin
       parent.
2. Read the diff carefully.
3. Scope law: report only on changed lines. For context you may read the full changed files,
   and files that define or call a changed symbol (1 hop). Two greps go further,
   only to judge an added element: the repo and its internal dependencies for an existing
   helper equivalent to added code (Duplicate functionality), and the repo for callers of an
   added class, method, parameter or dependency (zero callers: Question "who uses this?").
4. Run every checklist section against the diff. Report ONLY violations.
   No praise: this lens reports defects only, by design.

---

## Severity

Every comment gets exactly one tier; tag each reported line with it:

- **Blocker**: Red Flags only. Any single Blocker fails the review outright.
- **Major**: a checklist violation with a named, concrete consequence (what breaks, for whom,
  how it surfaces); must be fixed before merge.
- **Minor**: a real violation without such a consequence: worth a comment, never flips the
  verdict. One line plus at least one concrete suggestion (replacement or comment-ready
  wording). A section marked "(Minor; Major with a named consequence)" defaults to Minor.
- **Nit**: optional, author's judgment call (naming, comments, local-style consistency).
- **Question**: missing context the author should clarify; not a violation by itself
- **FYI**: informational point, no action required

## When NOT to report (gate)

Run every candidate violation through these gates before reporting it. A
candidate matching a gate is downgraded or dropped as the gate says, record
nothing about dropped candidates (this lens has no "filtered out" section;
silence is the output).

- **G1**: test/fixture/test-helper evidence:
  - When: the evidence line is in test/fixture/test-helper code (`src/test`, `*Test`, `*Spec`,
    `*Fixture`, test modules of an integration-test repo) AND the rule comes from Complexity,
    Config vs Code, Abstractions, Immutability & FP, or Boundaries.
  - Action: do not report. Test code is judged by `pablo-test-review`; here only Red Flags
    (secrets, broken imports) apply.
  - Not a violation in tests: a hardcoded timeout, a 30-line helper, a single-use overload, or a
    mutable variable/mutated argument.
- **G2**: a dependency version bump (pom.xml, build.sbt, package.json) not exercised by any
  other hunk in the diff: one FYI line max, never a Major/Blocker on its own. This includes a SNAPSHOT,
  ticket-qualified or feature-branch version of an artifact from the same organization. When
  sibling/context PRs are known, a snapshot version that differs between them is a concrete
  mismatch: Major (consistency check); otherwise only the FYI line. A SNAPSHOT/mutable ref of a
  third-party artifact is a Minor (reproducibility).
- **G3**: the evidence line is not inside a changed hunk of this diff: do not report, regardless
  of how real the issue is. If it gates a changed line's correctness, phrase it as a Question
  naming the exact file to check.
- **G4**: pure style preference (formatting, indentation, trailing newline, import order) in a
  file the branch touched for other reasons: FYI at most, one line.
- **G5**: one item per root cause. Violations that one fix removes are one item listing every
  rule they break; an item needing two independent fixes is two items (definition:
  `pablo-code-review` `references/merge-rules.md` § Root cause).

Nits (Consistency, Naming, Comments) survive the gate but never flip a
verdict and never take more than one line each.

## Checklist

### Red Flags (Blocker: instant fail, any one blocks merge)

- Secrets, credentials, or tokens in tracked files
- Existing public API contract broken without explicit request, with a caller in this repo left un-updated. Consumers outside the repo: one Question, none if the user supplied the companion PR(s). [NEVER] propose an alias or @Deprecated shim as the fix
- Test suite broken (broken imports, code that no longer compiles)
- Non-deterministic code: uncontrolled randomness, or a race with a concrete interleaving AND evidence in the diff or repo that concurrent callers exist (without that evidence: a Question)
- Hidden mutable shared state added
- Examples for the two ambiguous items (non-determinism, hidden shared state): read
  `references/redflags.scala.md`, `references/redflags.java.md`, `references/redflags.ts.md`

### Design & Functionality (Minor; Major with a named consequence)

- Duplicate functionality: the same behavior already exists in a library or module the change
  should reuse
- Abstraction-level mismatch: generic code embedded in a specific module where it can't be reused
- New architectural pattern where the project already has an established one
- Feature or abstraction added before it's needed (YAGNI); ask the "right time" question
- Functionality doesn't do what the author intends: edge cases, error paths, concurrency,
  user-visible behavior
- Examples per language: read `references/design-functionality.scala.md`,
  `references/design-functionality.java.md`, `references/design-functionality.ts.md`

### Data Shape (Minor; Major with a named consequence)

- New conditionals that could be eliminated by fixing the data structure
- Boolean parameter added by the diff that selects between two behaviors, with ≥1 caller passing a literal `true`/`false` (should be two functions); a flag fed from config or request data is not a violation
- Inheritance where composition suffices (excluding ADTs)
- Special-case insanity: a pile of conditionals patching around a data model that should encode
  the case directly
- Closed set of strings: ≥2 string constants added by the diff that are the allowed values of
  one field: Question "enum?"; in the repo that declares the type, always raise it
- Map key or Set element type without value equality (no equals/hashCode, not a
  record/case class/data class): Major (lookups silently miss)
- Examples per language: read `references/datashape.scala.md`, `references/datashape.java.md`,
  `references/datashape.ts.md`

### Complexity (Minor; Major with a named consequence)

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

### Boundaries (Minor; Major with a named consequence)

- Business logic in controller/handler/entry point
- Side effects mixed with pure computation in same function
- Implicit dependency instead of explicit injection
- Brain-damaged API: interface shape makes the common case awkward to call correctly
- Object orgy: a caller reaches through an object's internals instead of going through its interface
- Examples per language: read `references/boundaries.scala.md`, `references/boundaries.java.md`,
  `references/boundaries.ts.md`

### Scope Discipline (Question, at most 1 per review)

- A file or element unrelated to the task: one Question anchored on its first added line
  ("why is X in this change?"); [NEVER] ask to split the PR
- Adjacent code reformatted beyond the request, or imports/variables removed that weren't
  left unused by this change: Nit
- Garbage patch (broad, unrelated changes disguised as cleanup): the one Question above,
  naming them

### Abstractions (Minor; Major with a named consequence)

- New abstraction without a second concrete use case today (YAGNI)
- Generic utility for a single call site
- Error handling for a scenario that cannot occur
- Enterprise sludge: factories/builders/managers/config knobs layered onto a trivial task
- Added class, method, parameter or dependency with zero callers in the repo: Question "who uses this?" (Scope law grep, Process step 3)
- Examples per language: read `references/abstractions.scala.md`, `references/abstractions.java.md`,
  `references/abstractions.ts.md`
- For a quantified, branch-scoped deep-dive on SRP/OCP violations and structural duplication,
  see `refactor-identification`.

### Config vs Code (Minor; Major with a named consequence)

- Behavior that should be runtime-configurable is hardcoded
- Magic numbers/strings that belong in config/constants
- Production code only: constants in test code (timeouts, poll intervals,
  fixture values) are test data, not config candidates; see gate G1

### Immutability & FP (Minor; Major with a named consequence)

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

### Structural Code Smells (Minor; Major with a named consequence)

Tagged by [Mäntylä–Lassenius bucket](http://lib.tkk.fi/Diss/2009/isbn9789512298570/article1.pdf)
(Bloater / OO Abuser / Change Preventer / Dispensable / Coupler):

- God object [Bloater]: one class/object accumulating unrelated responsibilities
- Circular dependency [Coupler]: at module or build-graph level (SBT subproject / Maven module cycles); package cycles inside one module are not reported as findings (see `Data:` line in Output format)
- Constant interface [OO Abuser]: Java only: interface used solely to hold constants (Effective
  Java, Item 22, "use interfaces only to define types")
- Sequential coupling [Coupler]: API requires calls in an undocumented, easy-to-get-wrong order

Deliberately NOT checked here (documented so they aren't silently reintroduced): *Anemic domain
model* - contradicts `pablo-code-philosophy`'s (and its FP mechanics reference's) prescribed separation of
data from behavior, so it isn't a smell in this codebase. *Call super*, *Circle-ellipse problem*,
*Yo-yo problem*, *Poltergeist*: deep-inheritance smells, rare in composition-favoring Scala/Java
service code. *Object cesspool*: no established, checkable meaning. *Race hazard*: duplicate,
already covered under Red Flags.

### Comments & Documentation (Nit, or Major if a public contract changed silently)

- Comment explains *what* the code does instead of *why* (redundant with the code itself)
- Public API/README/doc behavior changed but the doc/comment wasn't updated to match
- Docs not updated when the change alters build, test, interaction, release, deletion, or
  deprecation behavior
- Hand-wavy claims: a statement about performance, safety, or correctness in a comment/PR
  description with no test or benchmark backing it

### Consistency (Nit)

- Change doesn't match the surrounding file/module's existing idioms, even where no style guide
  covers it explicitly

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
- [Blocker] file:line: violation

### Design & Functionality: pass | FAIL
- [Minor|Major] file:line: description

### Data Shape: pass | FAIL
- [Minor|Major] file:line: description

### Complexity: pass | FAIL
- [Minor|Major] file:line: description

### Boundaries: pass | FAIL
- [Minor|Major] file:line: description

### Scope Discipline: pass | FAIL
- [Question] file:line: why is <element> in this change?

### Abstractions: pass | FAIL
- [Minor|Major] file:line: description

### Config vs Code: pass | FAIL
- [Minor|Major] file:line: description

### Immutability & FP: pass | FAIL
- [Minor|Major] file:line: description

### Error Handling & Resources: pass | FAIL
- [Minor|Major] file:line: description

### Structural Code Smells: pass | FAIL
- [Minor|Major] file:line: smell name [bucket]: description

### Comments & Documentation: pass | FAIL
- [Nit|Major] file:line: description

### Consistency: pass | FAIL
- [Nit] file:line: description

### Naming clarity: pass | FAIL
- [Nit] file:line: description

### Verdict: READY | NEEDS WORK (B blockers, N major, m minor, M nits, Q questions)

Data: <optional, only when package cycles were observed; never a finding>
```

## Rules

- NEVER modify source code or test code
- Report violations with file:line references, each tagged with its severity tier
- If a section has zero violations, print "pass", do not elaborate
- Keep output scannable: one line per violation
- A single Blocker means the verdict is NEEDS WORK regardless of everything else; otherwise NEEDS WORK iff ≥1 Major. Minor, Nit, Question and FYI never flip the verdict
- Every Minor is one line and carries at least one concrete suggestion (replacement code or comment-ready wording); a Minor without one is not reported
- Package-level cycles inside one module are not findings; if you saw any, add one `Data:` line at the very end of the report (after the Verdict), e.g. `Data: package cycle a.b -> a.c -> a.b (not a finding)`
