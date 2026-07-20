---
name: refactor-identification
description: >
  Evidence-based detection of structural refactor candidates within the current branch's diff
  (Java/MDS, Scala/MDOM/MDOD). Covers: (A1) missing/misplaced abstractions (SRP/OCP,
  duplication), (A2) weak encapsulation, (A3) poor data types (primitives, clumps, null-checks
  instead of Option/Either/ADT), (A4) flags/switch where a sealed ADT fits. Findings need
  file:line evidence + a When-NOT-to-report (YAGNI/KISS) gate; rejects listed too. Identifies
  direction only, defers how to gof-design-patterns/functional-programming. TRIGGER: deciding
  if a refactor belongs in this branch, "refactor candidates" requests, or as code-review-
  checklist's deep-dive. SKIP: renames, trivial extraction, executing fixes, whole-repo scans,
  merge gating.
---

# Refactor Identification — Branch-Scoped Structural Candidates

This skill is a specialized zoom-in, not a replacement for `code-review-checklist`. That agent
already touches two of these categories superficially (its "Abstractions" and "Structural Code
Smells" checklist sections) as part of a broad, fast merge gate. This skill goes deeper on exactly
4 structural categories, with quantified evidence, and answers a different question: not "does
this diff pass review" but "is there a structural refactor worth investing in here". It
identifies candidates only — it never executes a refactor and never explains *how* to apply a
pattern once one is chosen. The "how" lives in `gof-design-patterns` (pattern catalog) and
`functional-programming` (FP mechanics); the cut-off criterion (when NOT to bother) lives in
`pablo-code-philosophy`.

## Scope law: the branch's work only

This skill never scans a whole repository. It only looks at what the current branch changed.

1. **Derive the diff** — identical to `code-review-checklist`'s step 1:
   - If the caller's prompt already hands you a diff (a path, a commit range, or diff content),
     use exactly that. Do not go looking for a different diff and do not ask anything.
   - Otherwise, derive it yourself: `git diff` (unstaged), `git diff --cached` (staged),
     `git diff main...HEAD` (full branch). Ask for the parent branch only if invoked standalone
     and it isn't obvious.
2. **Anchoring rule**: every finding needs at least one `file:line` inside a changed hunk, or on
   a symbol the branch changed. A finding with no such anchor does not exist for this skill.
3. **1-hop context rule**: you may read (a) the full contents of every changed file, and (b)
   files that directly define or use a symbol the branch changed (use `codegraph node <symbol>`
   if `.codegraph/` exists in the repo, otherwise grep). Do not expand further than one hop.
4. **Occurrence-counting exception**: once a candidate is anchored inside the branch's diff, a
   repo-wide grep is allowed *solely* to count how many total occurrences exist, because the DRY
   thresholds below (2 for structural duplication, 3 for business duplication) count all
   occurrences, not just the ones inside the diff. This exception never originates a new
   candidate — it only measures one already anchored in step 2.

## The four categories

| ID | Category | One-line definition | Threshold anchor |
|---|---|---|---|
| A1 | Missing or misplaced abstractions | SRP/OCP violated, or the same structural/business logic duplicated | Structural dup ≥2, business dup ≥3 (`pablo-code-philosophy` DRY rule) |
| A2 | Weak encapsulation | Mutable state exposed, invariants unprotected or checked by callers instead of the object | 1 occurrence anchored in the diff, unless noted otherwise |
| A3 | Poor data types | Primitives/data clumps standing in for a domain type; null or exceptions used for expected control flow | Varies per smell, see table 5.3 |
| A4 | Flag/enum-modeled variants | A discriminator (boolean/enum/string) drives dispatch that a sealed ADT + pattern matching would express directly | Varies per smell, see table 5.4 |

## A1 — Missing or misplaced abstractions

A class or function carries more than one reason to change, or the same shape of logic is
copy-pasted with only the types or literals differing.

| Smell | Detection cue (Java / Scala) | Evidence to record | Threshold |
|---|---|---|---|
| Structural duplication (same algorithm, different type) | Two methods/functions identical modulo types: same pipeline shape (`stream().filter().collect` / `map`/`fold` chains), same control flow, only types/field-accessors differ. At least one copy in a changed hunk; count the rest repo-wide. | Both `file:line` spans + "identical modulo type: `<T1>` vs `<T2>`" | ≥2 occurrences (DRY structural rule — abstract at 2) |
| Business-rule duplication | Same domain decision (same predicate over the same domain fields) encoded in multiple places; literals/field names match even if syntax differs. | All `file:line` sites + the rule in one sentence | ≥3 occurrences (3-strikes), ≥1 touched by the branch |
| SRP violation in a touched class | Diff adds methods/fields serving a second axis of change: new imports/collaborators from an unrelated domain; methods that share no fields with the rest of the class. | Class `file:line` + list of the ≥2 axes of change + the added members' lines | ≥2 distinct reasons-to-change, ≥1 introduced/extended by the branch |
| OCP violation (dispatch modified, not extended) | The branch ADDS a case/branch to an existing `switch`/`if-else` chain selecting behavior, instead of extending via a new implementation. | Chain `file:line`, the added branch's hunk lines, chain length after change | Chain length ≥3 after the change |
| Misplaced logic (feature envy) | Touched method calls ≥3 getters/fields of one foreign type and ≤1 of its own class; the computation belongs on the foreign type. | Method `file:line` + count "N foreign accessor calls vs M own" | ≥3 foreign accessor calls (calibrable) |

## A2 — Weak encapsulation

State that should be private and self-protecting is instead exposed, mutable, or trusted to be
validated by every caller.

| Smell | Detection cue (Java / Scala) | Evidence to record | Threshold |
|---|---|---|---|
| Public mutable field | Java: non-final `public`/package-private field. Scala: `var` in a public class/case class or trait member. | `file:line` of the declaration | 1 |
| Mutable internals escaping | Getter returning an internal mutable collection/array without defensive copy or immutable wrapper (`return this.list;` where field is `ArrayList`; Scala: exposing `mutable.Buffer`/`Map` fields). | Getter `file:line` + field `file:line` + "escapes: `<type>`" | 1 |
| Invariant bypassed by mutator | Constructor/factory validates a condition but a setter/mutator on the same field doesn't (or `copy` in Scala bypasses a smart-constructor check). | Validation `file:line` + unguarded mutator `file:line` | 1 |
| Invariant enforced by callers (check-then-act) | ≥2 call sites perform the same precondition check before calling the same method — the check belongs inside the callee. | Each caller `file:line` + callee `file:line` | ≥2 call sites, ≥1 touched by the branch |
| Mutation through reached-into internals | Touched code does `a.getB().getC().setX(...)` / `a.b.c = x` — mutating another object's internals through a chain. | `file:line` of the chain + depth | Chain depth ≥2 with terminal mutation |

## A3 — Poor data types

Domain concepts are carried by bare primitives or `null`, or expected outcomes are signaled by
throwing instead of by the return type.

| Smell | Detection cue (Java / Scala) | Evidence to record | Threshold |
|---|---|---|---|
| Primitive obsession | `String`/`int`/`long`/`double` carrying domain meaning (id, ISO code, currency, email, status) crossing method signatures; or the same primitive format-validated in multiple places. | Each signature `file:line` + the domain concept name | Crosses ≥3 signatures in scope, OR validated in ≥2 places (calibrable) |
| Stringly-typed state | Field compared against string literals to branch (`"Active".equals(status)` / `status == "Active"`). | Each comparison `file:line` + the literal set observed | ≥2 distinct literal comparisons on the same field |
| null as domain absence | Java: method returns `null` for an expected "not found"/"missing" outcome; callers null-check. Scala: any `null`, `Option.get`, `.getOrElse(null)`. | Producer `file:line` + each null-checking caller `file:line` | Java: ≥2 null-checks on the same value; Scala: 1 |
| Exceptions as control flow | `throw` for an expected domain outcome (validation failed, not found) with a caller that catches to branch on it. | `throw` `file:line` + catching caller `file:line` | 1 (throw+catch pair present) |
| Data clump | The same group of ≥3 parameters traveling together through multiple signatures (same names/types in the same order). | Each signature `file:line` + the clump members | Group of ≥3 params in ≥2 touched signatures |

## A4 — Flag/enum-modeled variants

A discriminator drives behavior that varies by case, in a shape that a sealed ADT + pattern
matching would express more directly and exhaustively.

| Smell | Detection cue (Java / Scala) | Evidence to record | Threshold |
|---|---|---|---|
| Boolean parameter selects behavior | Touched signature takes a `boolean`/`Boolean` that branches the method body into two behaviors. | Signature `file:line` + the branching `if` `file:line` | 1 |
| Duplicated dispatch over the same enum/flag | ≥2 `switch`/`match`/if-else chains over the same enum/int-flag/string discriminator, where variants carry different data or behavior → sealed ADT candidate. Count extra dispatch sites repo-wide once anchored. | Each dispatch `file:line` + the discriminator + variant count | ≥2 dispatch sites (structural-dup-at-2 rule) |
| Type-check cascade on unsealed hierarchy | Java: `instanceof` chains. Scala: `isInstanceOf`/`case x: T` matches on a non-sealed trait/class. | Cascade `file:line` + branch count + "hierarchy not sealed: `<root>`" | ≥2 branches |
| Mode field checked across methods | A status/mode field checked at the top of several methods of a touched class (State candidate — direction only). | Field `file:line` + each checking method `file:line` | ≥3 methods check the same field |
| Nullable-fields-as-variants | Class where certain fields are only meaningful for some values of a discriminator (null-guards conditioned on it; comments like "only set when..."). | Class `file:line` + discriminator + the conditional fields' lines | 1 class with ≥2 discriminator-dependent fields |

## When NOT to report (gate)

Every candidate must pass through every row below before it becomes a finding. Check every row
against every candidate — a candidate passes only if no row matches. Record the row IDs checked
in the finding's gate note. A candidate that matches any row goes to "Filtered out" with that
row's ID — it is not silently dropped.

| ID | Situation | Governing rule | Action |
|---|---|---|---|
| N1 | Only one variant/implementation exists today and the branch adds no concrete second one | YAGNI — no imaginary flexibility | Filtered out |
| N2 | The similar blocks encode different business rules that change for different reasons (accidental duplication) | DRY vs SRP → SRP wins | Filtered out |
| N3 | The abstraction removing the smell would be harder to read than the duplication/conditional it replaces | KISS > DRY, KISS > SOLID | Filtered out |
| N4 | No evidence line falls inside a changed hunk or on a symbol the branch changed | Scope law — branch work only | Filtered out |
| N5 | Flag/mode has exactly 2 simple states with trivial behavior difference | State pattern only earns its cost past this | Filtered out (A4) |
| N6 | Single failure point already handled inline by the immediate caller | Either/Option is ceremony here | Filtered out (A3) |
| N7 | Primitive/clump stays local: crosses no signature boundary and is validated in <2 places | KISS — a domain type adds ceremony | Filtered out (A3) |
| N8 | The "finding" is really a rename, formatting, or trivial extract-method in disguise | Skill boundary — non-structural | Filtered out |

## Priority assignment

Assign strictly by this table — no judgment outside it.

| Priority | Mechanical rule (all conditions checkable) |
|---|---|
| P1 | Evidence includes lines ADDED/modified by the branch (the branch introduces or worsens the smell) AND the fix stays within files the branch already changed → do it in this branch |
| P2 | Smell pre-exists; the branch extends it (adds an occurrence/case/call site); the fix stays within changed files + 1-hop context → candidate for this branch or an immediate follow-up |
| P3 | Anchored in changed code, but the fix exceeds 1-hop context, touches a public contract, or crosses module boundaries → follow-up ticket material, never inline |

## Step-by-step process

```
1. Derive the scope. If the caller's prompt hands you a diff (path, range, or content), use
   exactly that — do not ask. Otherwise: `git diff` (unstaged), `git diff --cached` (staged),
   `git diff main...HEAD` (full branch); ask for the parent branch only if invoked standalone
   and it isn't obvious.
   Verify: you can list every changed file with its hunks.
2. Build the scope table: one row per changed file — path, language (Java/Scala), changed
   line ranges.
   Verify: row count == changed-file count.
3. Expand context, 1 hop max: for each changed symbol you may read (a) its full containing
   file, (b) files that directly define or use it (`codegraph node <symbol>` if .codegraph/
   exists, else grep). Never expand further.
   Verify: every context file read maps to a named changed symbol.
4. Detection pass A1 over changed hunks + context, using the A1 table and the language cues
   in references/. Record raw candidates: category, smell row, file:line list, measure.
5. Detection pass A2, same procedure.
6. Detection pass A3, same procedure.
7. Detection pass A4, same procedure.
8. Count occurrences for threshold-based candidates: grep repo-wide for the anchored
   pattern; update each candidate's measure. Drop candidates below threshold.
   Verify: every surviving candidate's measure meets its row's threshold.
9. Gate every candidate through N1–N8. Passing candidates get a one-line gate note naming
   the rows checked; failing candidates move to Filtered out with the failing row ID.
   Verify: every candidate appears in exactly one of Findings / Filtered out.
10. Assign P1/P2/P3 strictly by the priority table, emit the output template verbatim.
    Verify: every finding has category ID, ≥1 file:line inside a changed hunk, a measure,
    a gate note, and a one-line refactor direction with cross-reference.
```

## Output format

```markdown
## Refactor Candidates: <branch or context>

### Scope
- Base: <ref> | Diff source: <command or caller-provided>
- Files in scope: <N> | Context files read (1-hop): <M>

### Findings

#### [RF-1] A<n> <smell row name> — P<1|2|3>
- Evidence: `file:line`, `file:line` (<measure, e.g. "2 occurrences, identical modulo type">)
- Anchored in branch: `file:line` (<added|modified> hunk)
- Gate: checked N1–N8 — passes; <one line: why the closest row doesn't apply>
- Refactor direction: <one line naming the target shape> → see `<skill>` <row/section>
  (direction only — the how lives there)

#### [RF-2] ...

### Filtered out
- <smell> at `file:line` — rejected by N<k> (<one line>)
- (none)

### Summary: <N> candidates (<x> P1, <y> P2, <z> P3), <k> filtered out
```

Emit this template verbatim. One line per evidence item. If there are no findings, still emit
`### Findings` with `- (none)` and the Summary line. Never add sections beyond this template —
no implementation plans, no step-by-step refactor instructions.

## Cross-references (the "how" lives elsewhere)

| Category | This skill (identification) | The "how" — cross-reference, never duplicate |
|---|---|---|
| A1 | detect + measure | `gof-design-patterns`: Strategy / Template Method / Factory Method rows; `functional-programming`: higher-order-function row (structural dup with no shared state); `pablo-code-philosophy` `principles/DRY.md` (2-vs-3 rule) |
| A2 | detect + measure | `functional-programming`: immutability principle; `gof-design-patterns`: Builder row (validated construction); `pablo-code-philosophy`: "Scientific code" |
| A3 | detect + measure | `functional-programming`: typed error handling + `references/patterns.md` (validation pipeline, accumulating errors); its `references/java.md` / `references/scala.md` for idioms |
| A4 | detect + measure | `functional-programming` `references/scala.md` (sealed trait + case classes + match); `gof-design-patterns`: State row (complex per-state behavior), and its Visitor caveat (never Visitor an ADT) |
| Gate | — | `pablo-code-philosophy`: pipeline YAGNI→KISS→DRY→SOLID; conflict matrix KISS > DRY > SOLID — the gate N1–N8 is its instantiation |

Never restate a gof/fp table row here. Point to it by skill name and row/section so the
implementer reads the recipe from its source of truth.

## Per-language detection cues

- **Java (MDS, and the Java modules of MDOD)** → `references/java.md` — grep-able cues per
  category.
- **Scala (MDOM, and the Scala modules of MDOD)** → `references/scala.md` — grep-able cues per
  category.

## Worked examples

`references/examples.md` has 4 resolved examples (one per category, snippet → filled `[RF-n]`
block) plus 1 rejected-by-gate example. Read it before your first run.

## Boundaries (explicitly out of scope)

- Renames, formatting, trivial extract-method, comment/doc-only changes — none of these alter
  the code's structural shape.
- Executing the refactor or giving implementation steps — `gof-design-patterns` and
  `functional-programming` own the "how".
- Whole-repo scanning, or any finding not anchored in the branch's diff.
- Merge verdicts or review severities — `code-review-checklist` owns the pass/FAIL gate. Some
  overlap with its checklist is intentional and expected: a boolean parameter or an
  exception-as-control-flow smell may appear in both outputs — the checklist reports the
  symptom as a gate item, this skill decides whether a refactor behind it is worth doing.
- Smells outside the 4 categories that `code-review-checklist` already checks (circular
  dependency, constant interface, sequential coupling, generic god object) — those stay in the
  checklist only; A1 here only deepens SRP/OCP for classes the branch touches.
- Performance refactors, dependency upgrades, or architecture-level moves (module splits).
