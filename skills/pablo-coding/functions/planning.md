# planning function — pablo-coding method

Function spec for the `pablo-coding` skill. Invoked when the user names
`planning` (or the dispatch ladder maps a strong keyword to it and the user
confirms).

## Purpose

Produce the design for a confirmed goal: `plan.md` (the logistical sequence of
work, seams grouped into explicit numbered buckets) and `technical.md` (public
interfaces, contracts, data structures, chosen tradeoffs and alternatives
rejected, gotchas for the implementer). The coordinator orchestrates; the
`planner` subagent authors the design content under `lens/planner-lens.md`.

## Entry conditions

- `$DESIGN_DIR/goal.md` exists (goal discovery already ran), OR a direct user
  prompt with enough context to design from. [DO NOT] start from a vague ask —
  that is `goal-discovery`'s entry condition.
- The coordinator confirms in the same turn what the function will do and what
  artifacts it will write (`plan.md` + `technical.md` + a `decisions.md` entry).

## Coordinator steps

1. [ALWAYS] delegate to `planner` with `lens/planner-lens.md` as the lens, in
   **design mode**. Pass the input: `$DESIGN_DIR/goal.md` (typically after goal
   discovery; it wins over any restated goal text elsewhere in the prompt) or
   the direct prompt's gathered context. Resolve the lens path to an absolute
   path once at session start; pass it verbatim.
2. Verify the four markers appear exactly once each, in order: `<!-- BEGIN
   PLAN -->`, `<!-- END PLAN -->`, `<!-- BEGIN TECHNICAL -->`, `<!-- END
   TECHNICAL -->`. If any is missing, duplicated, or out of order: [DO NOT]
   split — return the document to the planner with the exact problem.
3. Split the document: the PLAN section becomes `plan.md`, the TECHNICAL
   section becomes `technical.md`. [NEVER] author design content — the
   coordinator only splits and persists.
4. Append the chosen approach and the rejected alternatives (from the
   planner's "Key findings for the coordinator" block) to `decisions.md`.
5. Apply the seam-sizing discipline verbatim from the lens: every seam is one
   TDD loop iteration in the `tdd` function — one failing test, then the
   minimal code to pass it, then stop.

## Subagent cast

- `planner` + `lens/planner-lens.md` (design mode) — the only delegation in
  this function. The planner loads `pablo-code-philosophy` itself as its design
  standard.
- [NEVER] delegate the artifact writes to the planner or any subagent — see
  Artifact writes.

## Artifact writes (coordinator carve-outs)

- `$DESIGN_DIR/plan.md` — created (the PLAN section, verbatim).
- `$DESIGN_DIR/technical.md` — created (the TECHNICAL section, verbatim).
- `$DESIGN_DIR/decisions.md` — appended: chosen approach + rejected
  alternatives.
- Subagents never write into `$DESIGN_DIR`.

## Reporting

- Synthesis of the plan and the technical design: the chosen approach, the
  rejected alternatives, and the seams list (from `plan.md`). [NEVER] a bare
  "plan written, continue".
- Anti-noise (S5): if the plan is a single seam, the synthesis and the
  `state.md` history entry collapse to a single line.
- Mirror into `state.md` history (S4).

## Anti-patterns

- The coordinator writing design content — splitting and persisting only.
- The planner picking seams that diverge from the confirmed goal.
- Splitting on the agent's default `## PLAN` / `## TECHNICAL` markdown headers
  instead of the HTML-comment markers the lens mandates.

## When to chain

The natural follow-up is `tdd` (implement the seams from `plan.md` with the
co-designed `spec.md`). With no plan, `tdd` can still be called in
`tdd-no-plan` mode with a bare goal. [DO NOT] auto-dispatch — the user names
the next function.
