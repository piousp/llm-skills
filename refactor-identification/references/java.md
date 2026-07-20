# Detection Cues — Java (MDS, Java modules of MDOD)

Grep-able starting points per category. These narrow where to look; every candidate must still
be anchored per the Scope law (branch diff / 1-hop context) and pass the gate before being
reported.

## A1 — Missing or misplaced abstractions

| Cue | What to look for | What to record |
|---|---|---|
| Duplicate pipeline shape | `grep -n "stream()"` in changed files; compare `.filter().map().collect(` chains across methods | Both `file:line`, the differing type/field names |
| Duplicate predicate | `grep -n "if (.*&&\|if (.*||"` around domain fields in changed hunks; compare condition bodies across files | All `file:line`, the shared predicate in one sentence |
| New unrelated import in a touched class | `git diff` on the file's import block — new imports from a package unrelated to the class's existing domain | Class `file:line`, new import lines |
| Added switch/if-else branch | `grep -n "case \|else if"` inside a chain the diff touches; count total branches after the change | Chain `file:line`, added branch hunk lines, branch count |
| Feature envy | Count `\.get[A-Z]` calls per foreign type inside a touched method vs. calls to `this.` | Method `file:line`, "N foreign vs M own" |

## A2 — Weak encapsulation

| Cue | What to look for | What to record |
|---|---|---|
| Public mutable field | `grep -n "public \(int\|String\|List\|boolean\).*;" ` without `final` on a class field | `file:line` of the field |
| Mutable internals escaping | Getter body is `return this.<field>;` where the field type is `ArrayList`/`HashMap`/array, no `Collections.unmodifiable*`/copy | Getter `file:line`, field `file:line` |
| Invariant bypassed by mutator | Constructor has a validation `if`/`Objects.requireNonNull`/throw; a `setX` on the same field has none | Constructor validation `file:line`, unguarded setter `file:line` |
| Check-then-act at call sites | Same `if (x.isValid())`/`if (x != null)` guard immediately before calling the same method, repeated at ≥2 call sites | Each caller `file:line`, callee `file:line` |
| Reach-through mutation | `grep -n "\.get[A-Z][a-zA-Z]*()\.\(get\|set\)"` — chained accessor followed by a mutator | `file:line` of the chain |

## A3 — Poor data types

| Cue | What to look for | What to record |
|---|---|---|
| Primitive obsession | A `String id`/`String code`/`double amount` parameter appearing in ≥3 changed method signatures, or validated via regex/format check in ≥2 places | Each signature `file:line`, the domain concept name |
| Stringly-typed state | `grep -n "\.equals(\"" ` or `== "` comparing a field against a literal | Each comparison `file:line`, literal set |
| null as domain absence | Method returns `null` on a not-found path; `grep -n "== null\|!= null"` at each call site of that method | Producer `file:line`, each caller `file:line` |
| Exceptions as control flow | `throw new .*Exception` where the immediate or nearby caller has a `catch` that branches on it (not a top-level handler) | `throw` `file:line`, catching `file:line` |
| Data clump | Same 3+ parameter names/types repeated in order across ≥2 touched signatures | Each signature `file:line`, clump members |

## A4 — Flag/enum-modeled variants

| Cue | What to look for | What to record |
|---|---|---|
| Boolean parameter | Touched method signature has a `boolean`/`Boolean` param, body has an `if (thatParam)` | Signature `file:line`, branching `if` `file:line` |
| Duplicated dispatch over one enum | `grep -rn "switch (.*Status\|switch (.*Type"` — same enum name in ≥2 switch statements repo-wide, once one is anchored in the diff | Each dispatch `file:line`, discriminator name, variant count |
| instanceof cascade | `grep -n "instanceof"` — ≥2 branches checking concrete types of one non-sealed hierarchy | Cascade `file:line`, branch count, hierarchy root |
| Mode field checked repeatedly | Same field name appears in an `if` at the top of ≥3 methods of the touched class | Field `file:line`, each method `file:line` |
| Nullable-fields-as-variants | Class has ≥2 fields whose null-ness depends on one discriminator field (comments like "only set when...") | Class `file:line`, discriminator, conditional field lines |

## Notes

- `java.version` in the module's `pom.xml` matters for the refactor direction, not for
  detection — check it only when writing the "Refactor direction" line (e.g. `sealed
  interface`/`record` only from Java 17), never to decide whether a smell counts.
- These cues are starting greps, not exhaustive detectors — read the surrounding code before
  recording a candidate; a matching grep line without the shape described is not evidence.
