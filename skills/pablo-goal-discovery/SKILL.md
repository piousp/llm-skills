---
name: pablo-goal-discovery
description: >
  Use when a vague or under-specified ask must become a confirmed goal before
  code work begins. Runs the mattpocock grilling interview: rounds of numbered
  decisions with a recommendation each, fact lookups via scout, exit only on
  explicit user confirmation. Writes goal.md and the first decisions.md entry.
  Invocable by name: goal-discovery.
---

# pablo-goal-discovery

Turn a vague or under-specified ask into a confirmed goal: the original
prompt, the discovery decisions, and the constraints, written to `goal.md`
with the first `decisions.md` entry. Uses the mattpocock grilling method.
Coordinator-only: no subagent cast beyond fact-lookup scouts.

Grilling method sourced from mattpocock/skills; adapted (recommendation-first,
emoji markers, no auto-advance).

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

## Entry conditions

- The user named `goal-discovery`, or the task matches this description and
  the user confirms in the same turn.
- The coordinator states in the same turn what the goal-discovery pass will
  do and which artifacts it will write (`goal.md` + the first `decisions.md`
  entry).
- [DO NOT] run the grilling when a confirmed `goal.md` already exists for
  this work - that is `pablo-code-planning`'s entry condition.

## Step 0 - quick scan (pre-round)

Before the first round, a fast context scan only - no spec, no code, no full
investigation. Read any project-level index the repo maintains and open the
obvious files the ask names. Identify what makes the ask weak:

- Ambiguous terms (names, paths, scopes that could mean two things).
- Missing context (constraints, boundaries, consumers).
- Unverified assumptions baked into the wording.

The scan feeds the first round's frontier; it does not answer anything.

## The grilling loop

The coordinator maintains a working **design tree** in scratch context: every
decision branches into the decisions that hang off it. [NEVER] persist the
tree to a file until exit - `goal.md` is written only when the loop ends.

**Rounds.** The **frontier** is every decision whose prerequisites are
already settled. [ALWAYS] ask the whole frontier in one round: numbered
questions, a recommended answer for each, then wait. [NEVER] ask one question
at a time, [NEVER] ask a question whose prerequisite is unsettled.

**Frontier filtering (ask vs. assume).** Only decisions that change scope -
what gets built, which system/files are touched, what success means - enter
the round. Low-impact decisions (naming, format, defaults, ordering) are
assumed and flagged as explicit assumptions in `goal.md`. This keeps rounds
short; the user can always correct an assumption.

**Recommended answers.** [ALWAYS] give a recommendation for every question -
the user should be able to answer "recommended" for the whole round. [NEVER]
ask open-ended questions without one.

**Exit.** The frontier is empty, every branch visited, nothing silently
assumed. [DO NOT] close with "any questions?" - no auto-advance. Exit
requires explicit user confirmation of the synthesis.

## Text markers

KISS, plain text. Emoji markers for readability:

- 🧭 `Round N - frontier:` - round header
- ❓ `Q<N> - <title>:` - question
- 🔹 `Option<N>: <text>` - a numbered listed answer option (when options are spelled out)
- ✅ `Recommendation: <text>` - recommended answer
- 💡 `Fact: <text>` - fact the coordinator looked up via subagent

## Fact lookups via subagent

A frontier question that needs a fact from the environment (filesystem,
tools, docs, web) is [NEVER] asked of the user - the user is asked only the
**decisions**. [ALWAYS] dispatch `scout` or `web-scout` for the lookup and
treat the running exploration as an **unsettled prerequisite**: only the
questions downstream of it wait; the rest of the round proceeds.
Non-blocking by design.

## Exit criteria

- Frontier empty, every branch visited, nothing silently assumed.
- The coordinator writes `goal.md` (the confirmed goal: original prompt +
  discovery decisions + constraints, including flagged assumptions) and the
  first `decisions.md` entry (load-bearing decisions, gate answers, rejected
  alternatives).
- The coordinator presents the synthesis and gets explicit user confirmation.
  [DO NOT] auto-advance to another skill - see When to chain.

## Artifact writes (coordinator carve-outs)

- `$SESSION_DIR/goal.md` - created. The confirmed goal.
- `$SESSION_DIR/decisions.md` - created with the first entry.
- Both are coordinator carve-outs. [NEVER] delegate the write; [NEVER] let a
  subagent write into `$SESSION_DIR`.

## Reporting

- After writing the artifacts: a key-findings synthesis - the goal in one or
  two sentences, the decisions that shaped it, the constraints. [NEVER] a
  bare "done, continue".
- Anti-noise: if the goal is trivial (single decision, no branches), the
  synthesis collapses to a single line.

## Anti-patterns

- Asking the user for facts the coordinator can look up.
- Running the quick scan as a full investigation, or starting to build.
- Persisting the working tree before exit.
- Auto-advancing to `pablo-code-planning` after confirmation.
- Emoji markers outside the round text.

## When to chain

Natural follow-ups: `pablo-code-planning` (design from the confirmed goal) or
`pablo-tdd` (directly, no plan, with the goal as bare input). [DO NOT]
auto-dispatch - present the follow-ups as a list; the user names the next
skill.

## **CRITICAL**

**[NEVER]** proceed to implementation if this skill is called.
**[NEVER]** skip the grilling, that's *the whole point* of this skill
