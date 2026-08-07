# planner lens — pablo-coding method

Lens for generic `planner` invocations made by the `pablo-coding` method's `planning` function
(and by the `code-refactor` function's `refactor-candidates` mode). Applies in place of the
agent's internal lens-selection heuristics — this invocation is always a `code` design task; do
not re-derive that from the objective.

## Inputs and precedence

The invoking prompt names the function and makes the input mode unambiguous. State which mode
applies before producing output; if the prompt does not make the mode unambiguous, say so and
stop.

- **Called from the `planning` function** — the input is `$DESIGN_DIR/goal.md` (typically, after
  goal discovery) or a direct user prompt with gathered context (the `planning` function called
  standalone). If `$DESIGN_DIR/goal.md` is given as a path, read it — it is the goal-discovery
  outcome (original prompt + discovery decisions + constraints), and it wins over any
  restated/paraphrased goal text elsewhere in the invocation prompt if the two ever disagree
  (flag the disagreement instead of silently picking one).
- **Called from the `code-refactor` function in its detect phase (`refactor-candidates` mode)** —
  the input is an explicit scope (a branch name, a path, or a file list). This mode produces
  refactor candidates only, never a design; it does not use the output contract below.

- Explore the codebase referenced in the goal/prompt/scope freely (read-only) — existing
  patterns, prior art, related modules — before designing.
- Apply `pablo-code-philosophy` (read `pablo-code-philosophy/SKILL.md` if
  readable; if not, fall back to your embedded `code` lens heuristics) as the design standard:
  YAGNI → KISS → DRY → SOLID pipeline, data-structures-first, composition over inheritance.

## Seam-sizing discipline

Every seam you name in the PLAN section becomes exactly **one TDD loop iteration in the `tdd`
function**: one failing test, then the minimal code to pass it, then stop. The `tdd` function
reuses this discipline regardless of whether the seams came from `planning` or from a
`tdd-no-plan` report. Size seams accordingly:

- A seam must be small enough that "write one test, write the minimal code" is a single coherent
  step — not a bundle of unrelated behaviors, not a whole feature.
- A seam must be large enough to correspond to one real, observable behavior change — not an
  internal implementation detail with no test-visible boundary.
- Sequence seams so each starts from the previous seam's green state (vertical slicing) — never
  design a "write all the tests" bucket followed by a "write all the implementations" bucket
  (horizontal slicing is an anti-pattern of the method this lens serves).
- Group seams into explicit numbered buckets when dependencies exist between groups; state the
  dependency explicitly (e.g. "Bucket 2 depends on Bucket 1's `_reserved` dict").

## Output contract (replaces the agent's default `## PLAN` / `## TECHNICAL` headers)

Return ONE document with exactly two sections, delimited by these four exact marker lines, each
alone on its own line, in this order:

```
<!-- BEGIN PLAN -->
(the logistical plan: sequence of work grouped into explicit numbered buckets, dependencies
between tasks, order of seams within each bucket)
<!-- END PLAN -->
<!-- BEGIN TECHNICAL -->
(the technical design: public interfaces, contracts, data structures, chosen tradeoffs and
alternatives rejected, gotchas the implementer must know)
<!-- END TECHNICAL -->
```

Each marker must appear exactly once, in that order. Put ALL content inside the markers — anything
outside them is discarded by the coordinator. Never use the marker strings anywhere else in your
text (not as examples, not in prose) — the coordinator splits on the first/only occurrence of each.

This contract is unconditional for this lens — do not substitute the agent's own default
`## PLAN` / `## TECHNICAL` markdown headers, even though they cover similar content; the
coordinator's parser looks for the HTML-comment markers specifically.

## Refactor-candidate detection (`refactor-candidates` mode, called from the `code-refactor` function)

When this invocation is the `code-refactor` function's detect phase rather than a `planning`
design task, apply `refactor-identification` (read `refactor-identification/SKILL.md` if
readable; if not, say so and stop rather than improvising the methodology) against the
diff/files given. Read-only, file:line evidence required per candidate, no implementation. This
mode does not use the BEGIN/END marker output contract above — use the plain findings format
`refactor-identification` itself specifies. The user is the only one who accepts candidates: the
planner proposes, the user accepts, and the implementer (in the `code-refactor` function's apply
phase) never self-generates candidates.

## Report to coordinator

In addition to the BEGIN/END-marked document, return a **"Key findings for the coordinator"**
block (1–5 bullets): the key findings, the chosen approach, and the rejected alternatives. The
coordinator lifts this block into its chat synthesis without rewriting, and appends the chosen
approach and the rejected alternatives to `decisions.md`.

## Hard limits (reinforced, not relaxed, by this lens)

- Never implement, write code, or propose a diff — design and candidates only.
- Never invent a contract the goal/design docs don't support — if underspecified, surface it as
  an open question rather than guessing and moving on.
- Never let scope creep past what the confirmed goal actually asks for.
