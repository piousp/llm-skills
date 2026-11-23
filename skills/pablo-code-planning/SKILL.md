---
name: pablo-code-planning
description: >-
  Plans a code change before it is written: reuse, abstractions, decisions, public API, test plan and verifiable steps. Use for "plan this change", "design the API" or "before we code". Takes the goal from the dispatch task (or a goal.md path it names); if vague, plans on a stated assumption and flags the plan provisional. [NEVER] edit code. [DO NOT] use for simplification (pablo-code-simplify), test-only plans (pablo-tdd) or non-code plans.
---

# Code Planning

A plan in the strict sense: [NEVER] write or edit code. Contracts may
hold signatures and data shapes, never bodies.

Planning is a three-phase pass: Analyze → Decide → Specify. The phases
are ordered; the plan is complete only when all three have produced
their part of the output, per the `## Output` contract below.

## Entry

This skill runs inside a planner subagent: it cannot ask the user or
invoke other skills, and it can only hand something back to whoever
dispatched it. Take the goal from the dispatch task. If the task names a
`goal.md` path, read it and, when present, the `decisions.md` beside it.
Then:

- **Clear and scoped** (one sentence says what changes and how success is
  checked): proceed, and open the assumptions with
  `Goal (no goal.md): <that sentence>`.
- **Vague**: keep planning anyway. Open the assumptions with
  `Goal (assumed): <best reading in one sentence>`, add the line
  `Status: provisional (goal assumed)` right after it, list each
  unstated piece as a `Q<n>` line carrying the assumption taken, and
  recommend in one sentence that the dispatcher run `pablo-goal-discovery`.
- **No goal at all** (the task states no objective and names nothing to
  read): [DO NOT] plan. Return a `## BLOCKED` block listing what is
  missing, instead of the five `## Output` blocks.

Constraints and settled decisions in `goal.md` and `decisions.md` bind
the plan; [NEVER] reopen them silently: a fact read in the code that
contradicts one becomes a `Q<n>` line.

## Phase 1 - Analyze

[ALWAYS] load `pablo-code-philosophy` before this phase; all three
phases apply its rules.

Read before planning, starting from the goal: search (grep or the
repo's code-navigation tool) for the symbols, paths and terms it names;
read those files in full plus their direct callers and callees (one
hop). Go further only for a fact a decision needs, cited as
`path:line`. Greenfield (nothing to touch yet): read the closest
existing module and the dependency manifest; reuse is then limited to
repo patterns and declared libraries.

List each existing contract the change touches (public API, data shape,
caller), per "Don't Break What Exists" in `pablo-code-philosophy`:
`Affected: <contract or caller> at <path:line>`, or `Affected: none`.

**Reuse analysis.** Before proposing a new shape, name what already
exists that the plan reuses: functions, data shapes, patterns (the Code
Manifesto's reuse rule in `pablo-code-philosophy`; for patterns, its
"Don't reinvent the wheel"). One line per item, backed by a definition
read in the code: `Reuse: <symbol> <signature> at <path:line>`. For a
declared library, cite the manifest entry and the API source or doc
read; for a repo pattern, cite one instance at `path:line`. Nothing
found: `Reuse: none (searched: <pattern or tool>; scope: <dirs>)`.
[NEVER] name a symbol whose definition was not read.

**Abstraction analysis.** Check the code read against the four
categories of `refactor-identification` (definitions: its
"The four categories" table; calibration: its `references/examples.md`).
Write exactly four lines, no thresholds, gates or tables, each either
`A<n> <category>: <signal> at <path:line>` (several signals joined by
`;`) or `A<n> <category>: no signal`:

- A1 Missing or misplaced abstractions
- A2 Weak encapsulation
- A3 Poor data types
- A4 Flag/enum-modeled variants

The A1-A4 lines are signals for Phase 2, never a verdict. [DO NOT]
apply `refactor-identification`'s process (tables, thresholds, gates,
priorities) while planning: it judges only code already in a branch
diff. Its formal verdict comes after implementation, on that diff.

## Phase 2 - Decide

Check each decision, A1-A4 signals included, against the scope rules
of `pablo-code-philosophy` first ("Don't Break What Exists", then
"Surgical Changes", per its "Principle Interactions"), then run it
through its "Decision pipeline" and settle conflicts with its
"Conflict matrix". Extraction thresholds come from its
`references/principles/DRY.md`; the 2-copy override in
`refactor-identification` applies only to that skill's diff review.

One line per decision:
`D<n>: <decision>; gate: <scope rule, pipeline phase or Conflict matrix row>; evidence: <path:line or [ASSUMED] <assumption>>`.

## Phase 3 - Specify

Specify the contracts the plan commits to.

- **Public API.** Signatures of public functions and the shapes of
  their data. Start from the data model: "Data structures first" and
  "Thin entry points" from `pablo-code-philosophy` govern the shapes,
  and the testable boundary is the seam, per `pablo-tdd`.
- **Test plan.** Which tests, at which seams, which edge cases. The
  standards for a good test and seam confirmation live in `pablo-tdd`;
  the plan names seams and edge cases, it does not re-state the
  standards. The seams the plan lists are proposals: `pablo-tdd`
  requires confirming them with the user before tests are written.
- **Steps.** Ordered implementation steps, each with its own check, in
  the Steps format of `## Output`.

## Ambiguity

The "Before Coding" section of `pablo-code-philosophy` governs this
behavior: [DO NOT] pick silently among interpretations, state
assumptions, name the confusion, ask. Write each assumption as
`[ASSUMED] <assumption>` and each question as
`Q<n>: <question>; recommended: <answer>`.

- Scope-changing question (what gets built, which files, what success
  means) and a user who can answer: fill in only the first two blocks
  of `## Output`, hold back the other three, then wait.
- Nobody can answer (non-interactive run, such as a subagent): build
  the plan on the recommended answer, chosen as the most conservative
  interpretation that keeps the requested scope, and tag that `Q<n>`
  line `[ASSUMED]`.

## Output

The plan is the deliverable: these five blocks, in this order, and
nothing else.

1. **Assumptions & open questions**: the goal source (the `goal.md`
   path, the `Goal (no goal.md):` line or the `Goal (assumed):` line
   with its `Status: provisional (goal assumed)` line), then the
   `[ASSUMED]` and `Q<n>` lines.
2. **Analysis**: the `Affected:`, `Reuse:` and A1-A4 lines.
3. **Decisions**: pipeline verdicts as `D<n>` lines.
4. **Contracts**: public API signatures, data shapes, seams, test plan.
5. **Steps**: one line per step, in execution order:
   `N. <step> → verify: <command or observable check>`. A step without
   a check is incomplete.

[NEVER] drop a block: one with nothing to report is a single line
saying so, and one held back by an `## Ambiguity` stop is the single
line `pending Q<n>`. A consumer's format (e.g. the planner agent's
PLAN / TECHNICAL sections) may rename, regroup or add fields but never
drops a line, least of all a step's `→ verify:` check.

## Cross-references

Load methodology from its owner by name; never duplicate it.

- `pablo-goal-discovery` - upstream: writes `goal.md` and `decisions.md`;
  `## Entry` has a vague goal recommend it to the dispatcher.
- `pablo-code-philosophy` - "Principle Interactions", decision pipeline,
  conflict matrix, DRY thresholds (`references/principles/DRY.md`),
  "Data structures first", "Thin entry points", the Code Manifesto's
  reuse rule, "Don't reinvent the wheel", "Before Coding",
  "Surgical Changes", "Don't Break What Exists".
- `refactor-identification` - A1-A4 definitions ("The four categories"
  table), calibration examples (`references/examples.md`), and the
  diff-scoped verdict after implementation.
- `pablo-tdd` - what a good test is, seams, test-plan standards.
