# Detection Cues — JavaScript

Grep-able starting points per category. These narrow where to look; every candidate must still
be anchored per the Scope law (branch diff / 1-hop context) and pass the gate before being
reported.

Applies to `.js`, `.mjs`, `.cjs`, `.jsx`. For `.ts`/`.tsx`, read `references/typescript.md` as
well.

## A1 — Missing or misplaced abstractions

| Cue | What to look for | What to record |
|---|---|---|
| Duplicate pipeline shape | `grep -n "\.map(\|\.filter(\|\.reduce("` in changed files; compare chains across functions — same op order, only the callback's field or literal differs | Both `file:line`, the differing field/literal |
| Duplicate predicate | Same domain condition in an `if`, ternary, or `.filter()` callback across files (same field names, same literals) | All `file:line`, the shared rule in one sentence |
| Duplicate async orchestration | Two functions with the same `await` / `try` / retry / `Promise.all` sequence, only the called API differs | Both `file:line`, the differing call target |
| New unrelated import in a touched module | `git diff` on the import block — new `import`/`require` from a folder unrelated to the module's domain | Module `file:line`, new import lines |
| Added switch/else-if branch | `grep -n "case \|else if"` inside a chain the diff touches; count branches after the change | Chain `file:line`, added hunk lines, branch count |
| Feature envy | In a touched function, count property reads on one foreign object (`obj.a`, `obj.getX()`) vs `this.`/own params | Function `file:line`, "N foreign vs M own" |

## A2 — Weak encapsulation

| Cue | What to look for | What to record |
|---|---|---|
| Exported mutable binding | `grep -n "export let\|export var"`, or an `export const` object/array mutated from another module | Declaration `file:line`, each mutating `file:line` |
| Externally written instance field | Class field set in `constructor` without a `#` prefix, assigned from outside the class | Field `file:line`, external write `file:line` |
| Mutable internals escaping | Getter or method returns `this.<field>` where the field is an array/`Map`/`Set`/plain object, with no spread copy or `Object.freeze` | Accessor `file:line`, field `file:line`, escaping type |
| Invariant bypassed by mutator | Constructor or factory validates (guard/`throw`), but a setter, `Object.assign(obj, …)`, or a direct property write on the same field does not | Validation `file:line`, unguarded mutator `file:line` |
| Check-then-act at call sites | Same guard (`if (x && x.length)`, `if (x !== null)`) immediately before calling the same function, at ≥2 call sites | Each caller `file:line`, callee `file:line` |
| Reach-through mutation | Chain into another object's internals ending in a write: `a.b.items.push(...)`, `a.b.c = x`, `.splice(` | Chain `file:line`, depth |

## A3 — Poor data types

| Cue | What to look for | What to record |
|---|---|---|
| Primitive obsession | A `string`/`number` param carrying domain meaning (id, code, currency, email) in ≥3 changed signatures, or regex/format-validated in ≥2 places | Each signature `file:line`, the concept name |
| Stringly-typed state | `grep -n "=== '\|=== \""` comparing one field against literals to branch | Each comparison `file:line`, literal set |
| null/undefined as domain absence | Function returns `null`/`undefined` for an expected "not found"; callers guard with `== null`, `!x`, `?.`, `??` | Producer `file:line`, each guarding caller `file:line` |
| Exceptions as control flow | `throw new Error(...)` for an expected outcome, with a nearby `catch` branching on `err.message`/`err.code` instead of rethrowing | `throw` `file:line`, catching `file:line`, the sniffed field |
| Data clump | Same 3+ params, or the same ad-hoc object-literal shape, repeated in order across ≥2 touched signatures | Each signature `file:line`, clump members |
| Untyped boundary payload | `JSON.parse` / `res.json()` / `req.body` consumed field-by-field with inline guards in ≥2 places, no single parse-into-domain-object step | Each consumption `file:line`, the fields read |

## A4 — Flag/enum-modeled variants

| Cue | What to look for | What to record |
|---|---|---|
| Boolean parameter | Touched signature has a flag-named param (`isX`, `force`, `dryRun`) with `if (thatParam)` in the body; `grep -n ", true)\|, false)"` for call sites | Signature `file:line`, branching `if` `file:line`, call sites |
| Duplicated dispatch over one discriminator | ≥2 `switch (x.type)`, `if (kind === '…')` chains, or lookup-object maps over the same field, once one is anchored in the diff | Each dispatch `file:line`, discriminator, variant count |
| typeof / instanceof cascade | `grep -n "typeof \|instanceof \|Array.isArray"` — ≥2 branches distinguishing shapes of one conceptual input | Cascade `file:line`, branch count, the shapes distinguished |
| Mode field checked across methods | Same `this.<mode>` field in a guard at the top of ≥3 methods of a touched class | Field `file:line`, each method `file:line` |
| Optional-fields-as-variants | Object or class where ≥2 fields are meaningful only for some values of a `type`/`kind` field (guards on it, JSDoc "only when…") | Shape `file:line`, discriminator, conditional field lines |
| Dispatch with no closed-set default | `switch` over a fixed literal set with no `default`, or a silent one — an unknown variant passes unnoticed | Dispatch `file:line`, literal set, missing-default line |

## Notes

- `null`/`undefined` threshold is ≥2 guards on the same value, not 1 as in Scala: absence is
  idiomatic in JS. A single `?.` on one optional result is **N6**.
- `#private` fields, closures, and `Object.freeze` are the encapsulation mechanisms available.
  The absence of a `private` keyword is never the finding; state reachable and written from
  outside is.
- Lint-owned issues (`prefer-const`, `==` vs `===`, unused vars) are not structural: **N8**.
- Framework-mandated shapes are not smells: React props objects and hook dependency arrays are
  not data clumps; Express `(req, res, next)` is not a boolean-flag signature.
- These cues are starting greps, not exhaustive detectors — read the surrounding code before
  recording a candidate; a matching grep line without the shape described is not evidence.
