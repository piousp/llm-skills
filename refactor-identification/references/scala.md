# Detection Cues — Scala (MDOM, Scala modules of MDOD)

Grep-able starting points per category. These narrow where to look; every candidate must still
be anchored per the Scope law (branch diff / 1-hop context) and pass the gate before being
reported.

## A1 — Missing or misplaced abstractions

| Cue | What to look for | What to record |
|---|---|---|
| Duplicate pipeline shape | Compare `.map(`/`.filter(`/`.fold(`/for-comprehension chains across changed methods — same shape, only the type/field differs | Both `file:line`, the differing type/field names |
| Duplicate predicate | Same domain condition repeated in an `if`/`match` guard across files | All `file:line`, the shared predicate in one sentence |
| New unrelated import/collaborator in a touched class | `git diff` on the file's import block — new imports from an unrelated domain package | Class `file:line`, new import lines |
| Added match/if-else branch | `grep -n "case \|else if"` inside a `match`/if-else chain the diff touches; count total branches after the change | Chain `file:line`, added branch hunk lines, branch count |
| Feature envy | Count accessor calls (`\.[a-z][a-zA-Z]*\b` on a foreign case class instance) per foreign type inside a touched method vs. calls to `this.`/own fields | Method `file:line`, "N foreign vs M own" |

## A2 — Weak encapsulation

| Cue | What to look for | What to record |
|---|---|---|
| Public mutable field | `grep -n "var "` inside a public `class`/`case class`/`trait` member (not a private local) | `file:line` of the declaration |
| Mutable internals escaping | A `val`/`def` returns `scala.collection.mutable.*` (`Buffer`, `Map`, `Set`) directly from a field, no `.toList`/`.toVector`/immutable copy | Accessor `file:line`, field `file:line` |
| Invariant bypassed by mutator | A smart constructor / `apply` in the companion validates a condition; `copy` or a public `var` setter on the same field bypasses it | Validation `file:line`, unguarded mutator `file:line` |
| Check-then-act at call sites | Same guard (`if (x.isDefined)`, `if (x.nonEmpty)`) immediately before calling the same method, repeated at ≥2 call sites | Each caller `file:line`, callee `file:line` |
| Reach-through mutation | `a.b.c = x` or `a.getB.getC.setX(...)` chains mutating another object's internals | `file:line` of the chain |

## A3 — Poor data types

| Cue | What to look for | What to record |
|---|---|---|
| Primitive obsession | A `String`/`Int`/`Double` parameter carrying domain meaning (id, code, amount) appearing in ≥3 changed signatures, or format-validated in ≥2 places | Each signature `file:line`, the domain concept name |
| Stringly-typed state | `grep -n "== \"" ` comparing a field against a string literal to branch | Each comparison `file:line`, literal set |
| null as domain absence | Any `null` literal, `.get` on an `Option`, or `.getOrElse(null)` in touched code | `file:line` of the occurrence |
| Exceptions as control flow | `throw` for an expected outcome, with a nearby `try`/`catch` or `Try(...)` that branches on it instead of propagating | `throw` `file:line`, catching `file:line` |
| Data clump | Same 3+ parameter names/types repeated in order across ≥2 touched signatures (not already a case class) | Each signature `file:line`, clump members |

## A4 — Flag/enum-modeled variants

| Cue | What to look for | What to record |
|---|---|---|
| Boolean parameter | Touched method signature has a `Boolean` param, body has an `if (thatParam)` | Signature `file:line`, branching `if` `file:line` |
| Duplicated dispatch over one enum/flag | Same discriminator (`Int` flag, `String` tag, non-sealed enum) matched in ≥2 places repo-wide, once one is anchored in the diff | Each dispatch `file:line`, discriminator name, variant count |
| isInstanceOf / unsealed match cascade | `grep -n "isInstanceOf\|asInstanceOf"`, or `match` with `case _: T` branches over a trait that isn't `sealed` | Cascade `file:line`, branch count, hierarchy root |
| Mode field checked repeatedly | Same field name appears in an `if`/`match` guard at the top of ≥3 methods of the touched class | Field `file:line`, each method `file:line` |
| Nullable-fields-as-variants | Case class has ≥2 `Option[_]` (or nullable) fields whose presence depends on one discriminator field | Class `file:line`, discriminator, conditional field lines |

## Notes

- `null` threshold in A3 is 1 occurrence, not 2 — `null` in Scala is always avoidable (`Option`
  is idiomatic and available everywhere), unlike Java where interop sometimes forces it.
- A `sealed trait` hierarchy already matched exhaustively via `match` is NOT a candidate for A4 —
  that is the target shape, not the smell. Only unsealed hierarchies or duplicated dispatch over
  the same discriminator qualify.
- These cues are starting greps, not exhaustive detectors — read the surrounding code before
  recording a candidate; a matching grep line without the shape described is not evidence.
