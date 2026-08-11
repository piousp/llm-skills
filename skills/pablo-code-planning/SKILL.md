---
name: pablo-code-planning
description: >
  Strict code planning: analyze the code to be touched, name reuse
  opportunities and abstraction candidates, decide scope through the
  decision pipeline, and specify the public API and the test plan.
  Trigger when: the task is to plan code before implementation -
  analyzing current code, reuse and abstraction opportunities, public
  API and data shapes, and the test plan at seams. [ALWAYS] deliver the
  plan as the output, with a verification criterion on every step.
  [DO NOT] use for implementing: the plan never writes or edits code;
  test mechanics live in `pablo-tdd`, refactor methodology in
  `refactor-identification`, principles in `pablo-code-philosophy`.
---

# Code Planning

A plan in the strict sense - [NEVER] write or edit code; the output is
the plan (analysis + decisions + contracts), and nothing else.

Planning is a three-phase pass: Analyze → Decide → Specify. The phases
are ordered; the plan is complete only when all three have produced
their part of the output.

## Session working directory

All pablo-* skills share the current pi session's working directory for
session-scoped artifacts. Resolve it once at the start of the pass:

```bash
SESSION_DIR=$(python3 <skill-dir>/scripts/pi_session.py)
```

`<skill-dir>` is the directory this SKILL.md was loaded from. Persistent
sessions keep artifacts next to the session file
(`<session-storage>/<project>/<session>.files/`); ephemeral sessions fall
back to `/tmp/pi/session/<PI_SESSION_ID>`.

## Phase 1 - Analyze

Read the code to be touched before planning. Two analyses produce the
analysis part of the plan.

**Reuse analysis.** Name what already exists that the plan reuses:
existing functions, data shapes, patterns. This is "Reuse existing
code" and "Don't reinvent the wheel" from `pablo-code-philosophy`,
applied as analysis, not as implementation. [ALWAYS] state what exists
to reuse before proposing a new shape.

**Abstraction analysis.** Scan the code to be touched for abstraction
candidates and report one signal line per category - no thresholds, no
gates, no tables:

- **A1 Missing or misplaced abstractions** - same logic repeated, or a class or function carrying more than one reason to change.
- **A2 Weak encapsulation** - mutable state or invariants exposed, callers doing the validation the object should own.
- **A3 Poor data types** - primitives or null standing in for a domain type; exceptions used for expected control flow.
- **A4 Flag/enum-modeled variants** - a discriminator drives dispatch that a sealed ADT would express directly.

This mini-summary is the signal, not the method. The full methodology
(tables, thresholds, gates N1-N8, priorities, and worked examples in
its `references/examples.md`) lives in the `refactor-identification`
skill; consult it there when a candidate needs a formal verdict.

## Phase 2 - Decide

Run every abstraction and scope decision through the decision pipeline
YAGNI → KISS → DRY → SOLID of `pablo-code-philosophy` and its conflict
precedence KISS > DRY > SOLID. The pipeline, its gates, and the
conflict matrix live there as the single source; this skill does not
restate them.

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
- **Verification criteria.** Every step of the plan carries one. For
  multi-step tasks, define verifiable success criteria:
  1. [Step] → verify: [check]
  2. [Step] → verify: [check]

## Ambiguity

If multiple interpretations or approaches exist, present them; [DO NOT]
pick one silently. State assumptions explicitly, name the confusion,
ask. The "Before Coding" section of `pablo-code-philosophy` governs
this behavior.

## Output

The plan is the deliverable: analysis, decisions, and contracts, and
nothing else.

- Analysis - reuse opportunities and the A1-A4 signal lines.
- Decisions - pipeline verdicts, cited to `pablo-code-philosophy` by name.
- Contracts - public API signatures, data shapes, seams, test plan.
- Verification - every step with "[Step] → verify: [check]".

The four blocks are first-class output: [ALWAYS] deliver analysis and
verification alongside decisions and contracts; do not drop them when
converting to a consumer's format. The plan may be delivered as a single
document or split per the consumer's contract (e.g. the planner
agent's PLAN / TECHNICAL sections); whatever the format, [ALWAYS]
preserve the per-step verification criteria.

## Cross-references

Load methodology from its owner by name; never duplicate it.

- `pablo-code-philosophy` - decision pipeline, conflict precedence,
  "Data structures first", "Thin entry points", "Reuse existing code",
  "Don't reinvent the wheel", "Before Coding".
- `refactor-identification` - the full A1-A4 methodology: tables,
  thresholds, gates N1-N8, priorities, and worked examples in its
  `references/examples.md`.
- `pablo-tdd` - what a good test is, seams, test-plan standards.
