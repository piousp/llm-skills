# Detection Cues: TypeScript

**[ALWAYS] read `references/javascript.md` first.** Every cue there applies to TypeScript
unchanged. This file adds the type-system cues only. Rows tagged **override** replace their
JavaScript counterpart.

## A1: Missing or misplaced abstractions

| Cue | What to look for | What to record |
|---|---|---|
| Duplicate modulo type parameter | Two functions identical except the element type or interface; one generic function covers both | Both `file:line`, "identical modulo type: `<T1>` vs `<T2>`" |
| Overload set with duplicated body (Structural duplication) | Function overloads whose single implementation repeats the same branch per signature | Overload lines, impl `file:line`, branch count |
| Second unrelated interface implemented (SRP violation in a touched class) | `implements A, B` where the branch adds `B`, and `B`'s members share no fields with `A`'s | Class `file:line`, both interface names, added member lines |

## A2: Weak encapsulation

| Cue | What to look for | What to record |
|---|---|---|
| Missing `readonly` on exposed state (Public mutable field; Mutable internals escaping for an accessor) | `grep -n "readonly"` absent on an `interface`/class property or accessor returning `T[]`/`Map`/object; no `readonly T[]`/`ReadonlyArray<T>` | Declaration `file:line`, escaping type |
| `private` bypassed across a boundary (Public mutable field, when the bypass writes) | `private` field (compile-time only) reached via `as any`, `obj['field']`, or a plain-JS caller | Field `file:line`, bypass `file:line` |

## A3: Poor data types

| Cue | What to look for | What to record |
|---|---|---|
| `any` / unbounded `unknown` at a boundary (Untyped boundary value) | `grep -n ": any\|<any>\|as any\|: unknown"` on a touched signature, field, or generic argument | Each `file:line`, what the value actually is |
| Primitive alias without a brand (**override**) | `type Email = string` / `type Cents = number` interchangeable with raw primitives, no nominal wrapper; an opaque id (`type UserId = string`) the branch only passes, stores or compares never counts (A3 Primitive obsession exclusion) | Alias `file:line`, each signature or validation site `file:line` |
| Optional `?` or `T \| null` as domain absence (**override**) | Optional member or `T \| null \| undefined` return standing for an expected domain outcome; callers narrow with `!`, `?.`, `??` | Declaration `file:line`, each narrowing caller `file:line` |
| Throw where the return type could carry the outcome (Exceptions as control flow) | `T`/`Promise<T>` that throws for an expected domain failure and a caller catching to branch; no `Result`/union return | `throw` `file:line`, catching `file:line`, the proposed union |
| Anonymous inline object param (Data clump) | The same inline `{ a: string; b: number; c: Date }` param shape in ≥2 touched signatures, no named type | Each signature `file:line`, clump members |

## A4: Flag/enum-modeled variants

| Cue | What to look for | What to record |
|---|---|---|
| Non-exhaustive discriminated-union dispatch (Type-check cascade on unsealed hierarchy) | `switch (x.kind)` over a union with no `never`/`assertNever` default, or an `if/else if` narrowing chain over the union | Dispatch `file:line`, union `file:line`, missing exhaustive branch |
| Union without a discriminant | `type X = A \| B` separated by `'field' in obj`, `typeof`, or truthiness instead of a shared `kind` literal | Union `file:line`, each narrowing `file:line` |
| `enum` with duplicated switch | `grep -n "enum "`, then ≥2 `switch` over that enum where variants carry different data | Enum `file:line`, each dispatch `file:line`, variant count |
| Optional-members-as-variants (**override**) | `interface`/`type` with ≥2 optional members whose presence depends on one discriminant field | Type `file:line`, discriminant, optional member lines |

## Notes

- `catch (e: unknown)` / `catch (e: any)` and `.d.ts` shims for untyped third-party packages are
  not A3 findings.
- A discriminated union already dispatched exhaustively with a `never` check is the target
  shape, not a smell. Only missing discriminants, missing exhaustiveness, or duplicated dispatch
  qualify.
- `strict` / `strictNullChecks` in `tsconfig.json` matter for the refactor-direction line, never
  for whether a smell counts. With `strict: false` the compiler hides absence bugs, so detect
  from the code shape and name the flag as context in the direction line.
- These cues are starting greps, not exhaustive detectors; read the surrounding code before
  recording a candidate; a matching grep line without the shape described is not evidence.
