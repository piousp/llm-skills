# Planner — Design, No Implementation

Anchors on the confirmed goal (Phase 1) and produces `plan.md`: the durable design artifact that
Phase 3 (TDD) and Phase 4 (refactor) implement against. The planner subagent is read-only end to
end — it never writes or edits code.

## How to run

1. Delegate to the **planner** subagent — the most capable model/subagent your harness offers for
   this. Self-contained prompt, built from durable artifacts (not just chat context):

   > Confirmed goal (Phase 1): <paste verbatim>. Explore the existing codebase relevant to this
   > goal and design a solution: public interfaces, seams (what needs a test boundary), sequencing
   > of work, data structures, and tradeoffs between viable approaches. Apply
   > `pablo-code-philosophy` as your design lens. Do not implement anything — no code, no tests.
   > Write your design to `plan.md` at the repo root (or working directory root).

2. The planner explores freely (existing code, related modules, prior art) but only *reads*. It
   returns a design, not a diff.
3. Review `plan.md` with the user: surface every load-bearing decision (seam boundaries, chosen
   approach where multiple were viable, sequencing) and get explicit confirmation before Phase 3
   starts building against it.
4. If the design reveals the goal (Phase 1) was underspecified, stop and go back to Phase 1 rather
   than letting the planner guess.

## Exit criteria

`plan.md` exists, is confirmed by the user, and is specific enough for Phase 3 to derive seams and
tests from it without re-deriving the design from scratch. No code or tests have been written yet.
