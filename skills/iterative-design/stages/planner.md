# Planner — Design, No Implementation

Anchors on the confirmed goal (`.design/goal.md`, Phase 1). The planner returns ONE document
with two delimited sections; the **coordinator** splits it and persists `.design/plan.md` (the
logistical plan Phase 3 sequences work from) and `.design/technical.md` (the contracts the
implementer builds against). The planner subagent is read-only end to end — it never writes or
edits code.

## How to run

1. Delegate to the **`pablo-planner`** subagent by name if your harness has it configured
   (portable, no model pinned in its definition — pass the most capable model/subagent your
   harness offers explicitly at invocation, since nothing else guarantees that tier). Otherwise
   fall back to the generic **planner** role: the most capable model/subagent your harness offers
   for this. Either way it runs in a **fresh context** — it has not seen the Phase 1 conversation.
   The prompt must be fully self-contained: paste the goal verbatim (not a summary), every
   constraint/decision already made in Phase 1, and any facts already discovered (relevant file
   paths, existing patterns).

   `pablo-planner` does not inherit skills either, but has the `pablo-code-philosophy` lens built
   into its own system prompt — do not paste the skill content when invoking it, that would just
   duplicate what it already has. Only the generic **planner** fallback needs the skill pasted in
   full (or an accessible file path), since it has no built-in lens.

   > Confirmed goal (Phase 1): <paste `.design/goal.md` verbatim — original prompt + discovery
   > outcome, every constraint and decision>. Explore the existing codebase relevant to this goal
   > and design a solution: public interfaces, seams (what needs a test boundary), sequencing of
   > work, data structures, and tradeoffs between viable approaches. [Generic planner fallback
   > only: Apply `pablo-code-philosophy` (<paste full skill content or path>) as your design
   > lens.] Do not implement anything — no code, no tests.
   >
   > Return ONE document with exactly two sections, delimited by these four exact marker lines,
   > each alone on its own line:
   >
   > <!-- BEGIN PLAN -->
   > (the logistical plan: sequence of work grouped into explicit numbered buckets, dependencies
   > between tasks, order of seams within each bucket)
   > <!-- END PLAN -->
   > <!-- BEGIN TECHNICAL -->
   > (the technical design: public interfaces, contracts, data structures, chosen tradeoffs and
   > alternatives rejected, gotchas the implementer must know)
   > <!-- END TECHNICAL -->
   >
   > Each marker must appear exactly once, in that order. Put ALL content inside the markers —
   > anything outside them is discarded. Never use the marker strings anywhere else in the text.

   Do not tell the planner a filesystem path to write to — its configured output is rerouted by
   the harness; the coordinator works from the returned document.

2. The planner explores freely (existing code, related modules, prior art) but only *reads*. It
   returns a design, not a diff.
3. **Split and persist (coordinator).** Take the planner's returned document and:
   a. Verify each of the four markers appears exactly once and in order
      (`BEGIN PLAN` < `END PLAN` < `BEGIN TECHNICAL` < `END TECHNICAL`). Also verify the plan
      section groups work into explicit numbered buckets — if it doesn't, re-delegate once with
      "re-emit the plan section grouped into explicit numbered buckets" (same budget as 3c).
   b. Write `.design/plan.md` = the lines strictly between `<!-- BEGIN PLAN -->` and
      `<!-- END PLAN -->`; write `.design/technical.md` = the lines strictly between
      `<!-- BEGIN TECHNICAL -->` and `<!-- END TECHNICAL -->`. Trim leading/trailing blank
      lines; otherwise persist verbatim — no summarizing, no rewriting.
   c. Malformed markers (missing, duplicated, out of order): re-delegate once — "re-emit the
      exact same design with the four markers, all content inside them" (counts toward the
      iteration budget: max 2 attempts). If still malformed but `<!-- BEGIN TECHNICAL -->`
      exists, split at that marker (before = plan, after = technical), strip marker lines, and
      note the anomaly in `.design/decisions.md`. Otherwise escalate to the user.
4. Review both files with the user: surface every load-bearing decision (seam boundaries, chosen
   approach where multiple were viable, sequencing) and get explicit confirmation before Phase 3
   starts building against them. Append the chosen approach and rejected alternatives to
   `.design/decisions.md`. User-requested amendments may be applied by the coordinator directly
   to the two files (they are design docs) or re-delegated if substantial.
5. If the design reveals the goal (Phase 1) was underspecified, stop and go back to Phase 1 rather
   than letting the planner guess.

## Exit criteria

`.design/plan.md` and `.design/technical.md` exist, are confirmed by the user, and are specific
enough for Phase 3 to derive seams and tests without re-deriving the design: `plan.md` gives the
work order, `technical.md` the contracts. The chosen approach is logged in `.design/decisions.md`.
No code or tests have been written yet.
