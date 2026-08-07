# goal-discovery function — pablo-coding method

Function spec for the `pablo-coding` skill. Invoked when the user names
`goal-discovery` (or the dispatch ladder maps a strong keyword to it and the
user confirms). Coordinator-only: no subagent cast beyond fact-lookup scouts.

## Purpose

Turn a vague or under-specified ask into a confirmed goal: the original prompt,
the discovery decisions, and the constraints, written to `goal.md` with the
first `decisions.md` entry. Uses the mattpocock grilling method — the only
function that does; the other four do not.

## Entry conditions

- The user named `goal-discovery` explicitly, or the dispatch ladder mapped a
  strong keyword to it and the user confirmed in the same turn.
- The coordinator confirms in the same turn what the function will do and what
  artifacts it will write (`goal.md` + the first `decisions.md` entry).
- [DO NOT] run grilling when a confirmed `goal.md` already exists for this
  work — that is `planning`'s entry condition.

## The grilling loop

The coordinator maintains a working **design tree** in its scratch context:
every decision branches into the decisions that hang off it. [NEVER] persist
the tree to a file until exit — `goal.md` is written only when the loop ends.

**Rounds.** The **frontier** is every decision whose prerequisites are already
settled. [ALWAYS] ask the whole frontier in one round: numbered questions, a
recommended answer for each, then wait. [NEVER] ask one question at a time,
[NEVER] ask a question whose prerequisite is unsettled.

**Recommended answers.** [ALWAYS] give a `Recommendation:` for every question —
the user should be able to answer "recommended" for the whole round. [NEVER]
ask open-ended questions without one.

**Exit.** The frontier is empty, every branch visited, nothing silently
assumed. [DO NOT] close with "any questions?" — no auto-advance. Exit requires
explicit user confirmation of the synthesis.

## Text markers

KISS, plain text, [NEVER] emoji (mattpocock's original emoji style is
explicitly rejected):

- `Round N — frontier:` — round header
- `Q<N> — <title>:` — question
- `Recommendation: <text>` — recommended answer
- `Fact: <text>` — fact the coordinator looked up via subagent

## Fact lookups via subagent

A frontier question that needs a fact from the environment (filesystem, tools,
docs, web) is [NEVER] asked of the user — the user is asked only the
**decisions**. [ALWAYS] dispatch `scout` or `web-scout` (per the planner's
defaults) for the lookup and treat the running exploration as an **unsettled
prerequisite**: only the questions downstream of it wait; the rest of the round
proceeds. Non-blocking by design.

## Exit criteria

- Frontier empty, every branch visited, nothing silently assumed.
- The coordinator writes `goal.md` (the goal-discovery outcome: original prompt
  + discovery decisions + constraints) and the first `decisions.md` entry.
- The coordinator presents the synthesis and gets explicit user confirmation.
  [DO NOT] auto-advance to another function — see When to chain.

## Artifact writes (coordinator carve-outs)

- `$DESIGN_DIR/goal.md` — created. The confirmed goal.
- `$DESIGN_DIR/decisions.md` — created with the first entry: the load-bearing
  discovery decisions, gate answers, and rejected alternatives (the why).
- Both are coordinator carve-out artifacts. [NEVER] delegate the write; [NEVER]
  let a subagent write into `$DESIGN_DIR`.

## Reporting

- After writing the artifacts: a key-findings synthesis — the goal in one or
  two sentences, the decisions that shaped it, the constraints. [NEVER] a bare
  "done, continue".
- Anti-noise (S5): if the goal is trivial (single decision, no branches), the
  synthesis collapses to a single line and the `state.md` history entry is
  single-line.
- Mirror the synthesis into the `state.md` history entry (S4) — the coordinator
  is the single writer of `state.md`.

## Anti-patterns

- Asking the user for facts the coordinator can look up.
- Emoji markers in the round text.
- Persisting the working tree before exit.
- Auto-advancing to `planning` after confirmation.

## When to chain

The natural follow-ups are `planning` (design from the confirmed goal) or `tdd`
(directly, in `tdd-no-plan` mode, with the goal as the bare input). [DO NOT]
auto-dispatch — present the follow-ups as a list; the user names the next
function.
