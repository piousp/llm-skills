# Planner Delegation (T2)

Reference file for the T2 planning template in SKILL.md. Read this when
the coordinator is about to send a plan request to the planner agent.
The template lives at the end of this file; the sections below cover context
assembly, the goal cap, gated phases, the expected plan contract, and a
worked example.

## Use when / Do NOT use when

Use when:

- Non-trivial work that needs sequencing, seams, or a test plan.
- The goal is confirmed and the prior decisions are recorded.

Do NOT use when:

- The work is already planned: that goes to T3 implementation.
- The goal is not confirmed yet: confirm it before planning.

## 1. Assembling the coordinator context

The planner runs with no project context of its own; the prompt is the
whole world it sees. Assemble it in this order.

### 1.1 Goal verbatim, authoritative

Paste the confirmed goal from goal.md exactly as written, inside the
"Goal (verbatim, authoritative)" block. The planner treats that text as
the authority. [NEVER] paraphrase, summarize, or "improve" the goal
while pasting it; every rephrasing is a silent decision that can drift
the plan.

Marker contract: the goal block is delimited by the marker "Goal
(verbatim, authoritative):" and the end of the block. Inside the block
the text is quoted, never edited. Everything outside the block
(decisions, constraints, out of scope) is context for planning, not
goal text, and the planner must not read new authority into it.

### 1.2 Decisions and constraints

List the decisions already made (from decisions.md) and the constraints
(environment, time, conventions, boundaries). The planner plans within
the decisions; it does not re-litigate them.

### 1.3 Out of scope

Explicitly list what the plan must NOT cover. An absent out-of-scope
list invites scope creep inside the plan itself.

### 1.4 What/why before stack

The planner proposes the stack and the architecture; the prompt supplies
what and why, never the how:

- Who uses the result.
- What problem it solves.
- What success looks like.

Dictating a stack in the prompt is a common failure: it forces the
planner to plan around a technology choice instead of around the goal.

## 2. Goal cap: ~4000 characters

A goal past ~4000 characters is not a goal; it is a spec or a design
document. A long goal pushes the planner toward transcribing constraints
instead of planning.

Rules:

- If the goal text exceeds ~4000 characters, cut it to the core intent
  and move the detail into Decisions and constraints or Out of scope.
- Keep the goal block one paragraph when possible.

## 3. Gated phases

Each phase of a plan ends with a check that must pass before the next
phase starts. T2 asks for "a verification criterion with a check for
every step", which is also the demand of the pablo-code-planning lens.

Gated phases make the plan executable: every step is either done and
checked, or not done. Ungated phases produce plans that read like prose
and cannot be tracked.

## 4. The expected plan contract

The planner selects its lens internally (per its system prompt) and
receives pablo-code-planning and pablo-tdd from settings. The task does
not force a lens path and does not set skills: [] (which would strip the
settings pin). What the coordinator controls is the contract: the
returned plan must carry four blocks: analysis, decisions, public
contracts, and a verification criterion with a check for every step.
[NEVER] accept a plan in a different shape; a plan in the wrong shape is
a delegation failure. Resend with the contract restated, do not improvise
a different review.

## 5. Ambiguity and open questions

The planner will meet ambiguity. T2 dictates the handling:

- Present the interpretations considered and the one chosen; [NEVER]
  pick silently.
- Contracts the goal does not support: surface them as open questions;
  [NEVER] invent them.
- The plan may end with open questions. The coordinator answers them and
  the next iteration closes them.

## 6. Worked example

Context: a confirmed goal for a small CLI tool, one prior decision, two
constraints.

Assembled T2 prompt:

```
Goal (verbatim, authoritative):
Build a command-line tool that converts Markdown files with fenced code
blocks into a single self-contained HTML document with syntax
highlighting, writing the result to stdout.

Decisions and constraints:
- Decision: the tool must produce a single static binary with no runtime
  dependencies.
- Constraint: it must work fully offline.
- Constraint: output must be deterministic for identical input.

What/why: developers write Markdown docs with code examples and paste
them into internal wikis. The tool turns a file into one HTML page with
readable highlighted code and no external assets. Success looks like a
one-command conversion that produces the same HTML for the same input,
with no network access at runtime.

Out of scope:
- Watch mode and incremental rebuilds.
- Configuration files and plugin systems.
- Non-Markdown input formats.

Explore read-only first, then produce ONE plan with these four blocks:
analysis, decisions, public contracts, and a verification criterion with
a check for every step.

Ambiguity: present the interpretations you considered and the one you
chose; [NEVER] pick silently. Contracts the goal does not support:
surface them as open questions, [NEVER] invent them.

Limits:
- The plan is the deliverable and nothing else.
- No scope creep beyond the confirmed goal.
- Do not re-write the methodology of other skills; load them by name.
```

What the coordinator checks on return:

- The plan carries the four blocks (analysis, decisions, contracts,
  verification).
- Every step carries a verification check (gated phases).
- The goal text was not drifted; decisions are respected.
- Out-of-scope items do not appear in the plan.
- Ambiguities are declared, not hidden; open questions are explicit.

## Template (T2)

Use when: non-trivial work that needs sequencing, seams, or a test plan. Do
NOT use when: the work is already planned (T3).

Composition: the planner selects its lens internally (per its system
prompt) and receives its planning skills from settings. The task does not
force a lens path and does not set skills: []; it states the contract and
the expected plan shape.

```text
Goal (verbatim, authoritative):
<paste the confirmed goal; keep it under ~4000 characters>

Decisions and constraints:
- <decision 1>
- <constraint 1>

What/why: <who uses the result, what problem it solves, what success
looks like>. The stack and architecture are for you to propose in the
plan, not inputs dictated here.

Out of scope: <explicit list>

Explore read-only first, then produce ONE plan with these four blocks:
analysis, decisions, public contracts, and a verification criterion with
a check for every step.

Ambiguity: present the interpretations you considered and the one you
chose; [NEVER] pick silently. Contracts the goal does not support:
surface them as open questions, [NEVER] invent them.

Limits:
- The plan is the deliverable and nothing else.
- No scope creep beyond the confirmed goal.
- Do not re-write the methodology of other skills; load them by name.
```
