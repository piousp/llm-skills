# KISS - Keep It Simple, Stupid

## Maxim

> Keep It Simple Stupid. If 50 lines solve it, 500 is a confession. An orchestrator method that
> sequences N genuinely different steps is not the same as a method with N nested conditionals.
> The former reflects domain complexity; the latter means the data model needs fixing.

## Rules

- [ALWAYS] pick the simplest expression of the code. Every conditional, abstraction, and
  indirection is debt until proven otherwise.
- [ALWAYS] write code a reader understands in one pass, including yourself six months from now.
- [NEVER] add cleverness for its own sake. Clever is not a compliment; terse is not a virtue.
- [ALWAYS] keep a function on one screen. Split it if it doesn't fit.
- [NEVER] explain how clever the code is in a comment. Needing that comment means the code
  already lost.

### Low cyclomatic complexity

{BAD} a conditional for every special case.
{GOOD} a data shape that removes the distinction, so the conditional disappears.

- [ALWAYS] fix the data model before adding a branch for a special case.

### Avoid nested logic calls

{BAD} `fun1 -> fun2 -> fun3 -> fun4` chains that hide the actual control flow.
{GOOD} a flat, early-return sequence with single-level orchestration.

- [ALWAYS] prefer a flat call sequence over deep nesting.

### Return the result, not the instructions

{BAD} a function returns a flag plus a rule the caller must re-check against shared state.
{GOOD} a function returns the finished value; the caller only sequences and concatenates.

- [NEVER] have a function return the ingredients of a decision (a flag, an id set to exclude).
  The caller ends up re-implementing the decision, and the rule lives in two places.
- [ALWAYS] have the callee return the decided value itself: the final collection, the resolved
  object.
- Symptom to check in your own diff: the orchestrator's last line has a `filter`, `filterNot`,
  or conditional consulting shared state (a field, a config set) the callee already consulted.

### Every value of a type must name a domain case

{BAD} `Outcome(Set.empty, Seq.empty)` returned so the caller has something to match on.
{GOOD} the function returns the finished value; the wrapper type disappears.

- [NEVER] add a constructor whose only meaning is "nothing to say here". That value models the
  caller's control flow, not the domain.
- [ALWAYS] name the value in domain words without mentioning the caller. "The rows kept for this
  component" is a domain fact; "the ids the caller must filter out" is an instruction the callee
  should have applied.

### No field that another field already carries

{BAD} a type carries `id` as its own field when a nested value already exposes it.
{GOOD} the type derives `id` from the nested value at the point of use; there is one field for
it, not two.

- [NEVER] add a field the type could read off another field it already holds. A duplicated fact
  is a second source of truth that can drift, and it forces every construction site to supply
  data it doesn't own.
- [ALWAYS] derive it at the point of use instead, and only where the invariant that makes the
  derivation total is real and visible in the same file (see "Partial access needs a visible
  invariant" in [FP.md](FP.md)).

## Code Examples

See [`../../examples/kiss.java.md`](../../examples/kiss.java.md) and [`../../examples/kiss.scala.md`](../../examples/kiss.scala.md).

## Warnings

- [NEVER] confuse simplicity with brevity. A one-liner with five obscure operators is not simple.
- [ALWAYS] prefer two clear functions over one dense function.
- [ALWAYS] treat simplification as iterative. The first working version is rarely the simplest.
- [WHEN] KISS conflicts with DRY, KISS wins. A generic abstraction that removes duplication but
  adds complexity is not worth the trade.

## Related Principles

- **YAGNI** → See [YAGNI.md](YAGNI.md). Covered by the decision pipeline in [SKILL.md](../../SKILL.md): YAGNI gates everything, phase 1 precedes phase 2.
- **DRY** → See [DRY.md](DRY.md). Covered by the `KISS vs DRY` row in the conflict matrix, [SKILL.md](../../SKILL.md), and by the KISS > DRY precedence in the pipeline section.
- **SOLID** → See [SOLID.md](SOLID.md). Covered by the `KISS vs SOLID` row in the conflict matrix, [SKILL.md](../../SKILL.md).
- **GoF** → See [GoF.md](GoF.md). Covered by the `GoF vs KISS` row in the conflict matrix, [SKILL.md](../../SKILL.md).
- **FP** → See [FP.md](FP.md). Covered by the `FP vs KISS` row in [references/interactions.md](../interactions.md).
- **Unix philosophy** → See [UNX.md](UNX.md). Covered by the `UNIX vs KISS` row in [references/interactions.md](../interactions.md).
