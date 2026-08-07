# Planner — Design, No Implementation

Anchors on the confirmed goal (`$DESIGN_DIR/goal.md`, Phase 1). The planner returns ONE document
with two delimited sections; the **coordinator** splits it and persists `$DESIGN_DIR/plan.md` (the
logistical plan Phase 3 sequences work from) and `$DESIGN_DIR/technical.md` (the contracts the
implementer builds against). The planner subagent is read-only end to end — it never writes or
edits code.

## How to run

1. Delegate to the **`planner`** subagent, passing `skills: []`. It runs in a **fresh context**
   (`systemPromptMode: replace`) — it has not seen the Phase 1 conversation. The prompt must be
   fully self-contained: paste the goal verbatim (not a summary), every constraint/decision
   already made in Phase 1, and any facts already discovered (relevant file paths, existing
   patterns).

   Do not paste `pablo-code-philosophy` separately — the planner already tries to load it itself.

   > Lens: read and apply `lens/planner-lens.md` before planning;
   > if you cannot read it, make no changes and say so.
   >
   > Confirmed goal (Phase 1): <paste `$DESIGN_DIR/goal.md` verbatim — original prompt + discovery
   > outcome, every constraint and decision>. Explore the existing codebase relevant to this goal
   > and design a solution: public interfaces, seams (what needs a test boundary), sequencing of
   > work, data structures, and tradeoffs between viable approaches. Do not implement anything —
   > no code, no tests.
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
   b. Write `$DESIGN_DIR/plan.md` = the lines strictly between `<!-- BEGIN PLAN -->` and
      `<!-- END PLAN -->`; write `$DESIGN_DIR/technical.md` = the lines strictly between
      `<!-- BEGIN TECHNICAL -->` and `<!-- END TECHNICAL -->`. Trim leading/trailing blank
      lines; otherwise persist verbatim — no summarizing, no rewriting.
   c. Malformed markers (missing, duplicated, out of order): re-delegate once — "re-emit the
      exact same design with the four markers, all content inside them" (counts toward the
      iteration budget: max 2 attempts). If still malformed but `<!-- BEGIN TECHNICAL -->`
      exists, split at that marker (before = plan, after = technical), strip marker lines, and
      note the anomaly in `$DESIGN_DIR/decisions.md`. Otherwise escalate to the user.
4. Review both files with the user: surface every load-bearing decision (seam boundaries, chosen
   approach where multiple were viable, sequencing) and get explicit confirmation before Phase 3
   starts building against them. Append the chosen approach and rejected alternatives to
   `$DESIGN_DIR/decisions.md`. User-requested amendments may be applied by the coordinator directly
   to the two files (they are design docs) or re-delegated if substantial.
5. If the design reveals the goal (Phase 1) was underspecified, stop and go back to Phase 1 rather
   than letting the planner guess.

## Exit criteria

`$DESIGN_DIR/plan.md` and `$DESIGN_DIR/technical.md` exist, are confirmed by the user, and are specific
enough for Phase 3 to derive seams and tests without re-deriving the design: `plan.md` gives the
work order, `technical.md` the contracts. The chosen approach is logged in `$DESIGN_DIR/decisions.md`.
No code or tests have been written yet.
