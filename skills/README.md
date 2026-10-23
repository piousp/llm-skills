# Skills

Short reference for every skill in this folder: what it does, and when to reach for it.
Each skill is a `<name>/SKILL.md` file. Copy or symlink the ones you need into your harness's
skill discovery path.

## Code philosophy and planning

**`pablo-code-philosophy`**
The decision pipeline for writing or editing code: YAGNI first, then KISS, then DRY, then SOLID,
with a fixed precedence when two of them pull in different directions. Also sets the style rules:
data structures before behavior, thin entry points, composition over inheritance. Most other
skills in this set lean on it. Use it any time you write, edit, or refactor code and need to
decide scope or simplicity.

**`pablo-code-planning`**
Strict planning, no code written. Analyzes what you're about to touch, names reuse and
abstraction opportunities, and specifies the public API and the test plan before anyone writes a
line. Use it before implementation starts, not during.

**`pablo-goal-discovery`**
For the case where the ask is vague. Runs a structured interview, one numbered decision at a
time with a recommendation attached, and only stops on explicit confirmation. Writes the
confirmed goal to `goal.md`. Skip it if the goal is already clear.

**`pablo-tdd`**
The red-to-green loop, and what makes a test worth keeping: where tests belong, which mocks are
legitimate, which patterns are anti-patterns. Apply it whenever a code change needs a test plan.

## Review and QA

**`pablo-code-review`**
Runs four read-only lenses on the same diff and merges them into one report: `qa-adversary` for
bugs, `code-review-checklist` for style, `refactor-identification` for structural debt, `pablo-test-review` for test quality. Use it for
a full PR review in one pass. For a narrower question, call one of the lenses directly
instead.

**`qa-adversary`**
Adversarial QA. Assumes the change is broken until proven otherwise and goes looking for logic
bugs, data-handling mistakes, and regressions. Reads tests to judge coverage, never runs them,
never touches code. Use it before merging, or whenever someone asks "will this break anything".

**`code-review-checklist`**
Checks a diff against Pablo's quality checklist. Read-only, and
focused on style and structure rather than correctness. Pair it with `qa-adversary` if you also
need a bug hunt.

**`pablo-test-review`**
Read-only lens for the tests in a diff: can the changed tests actually fail, which brittle or
missing assertions to fix or add. Each item is written as a PR comment.

**`refactor-identification`**
A deeper, evidence-based dive into structural problems in a branch's diff: missing abstractions,
leaky encapsulation, primitive types standing in for real domain types, switch statements that
want to be a sealed type. Every finding needs a file and line number. Use it when the question is
whether a refactor is worth the investment, not whether the diff passes review.

**`pablo-code-simplify`**
Produces a simplification plan for existing code without changing its behavior. Runs two
read-only analyses in parallel, one structural and one on readability, filters the results
through a "does this actually need to change" gate, and hands back an ordered plan. It never
writes code itself; someone else implements the plan.

## Language-specific technique

FP and GoF pattern mechanics are reference material inside `pablo-code-philosophy` itself
(see its `references/fp/` and `references/gof/` directories; the philosophy's principal files
also cover the same topics: immutability/pure functions/typed errors and 12 GoF patterns with
smell-to-pattern and over-engineering guard tables).

## Skill authoring

**`writing-agent-skills`**
How to write a skill: the SKILL.md structure, frontmatter rules, and how to keep the trigger
description tight enough that the harness picks the right skill at the right time. Use it before
authoring or refactoring any skill, including the ones in this list.

**`evaluating-agent-skills`**
The follow-up to `writing-agent-skills`: how to build an eval suite for a skill once it exists,
combining offline tests, live trajectory probes, and LLM-as-judge checks. Use it before shipping
a skill or after changing one.

## Writing

**`human-like-writing`**
Rules and a workflow for writing text that reads as written by a person: a banned-word list, a
ban on em dashes and formula closers, and a push toward varied sentence rhythm and a visible
stance. Applies to code comments, PR reviews, emails, and prose alike. Use it before drafting or
revising anything longer than a one-line reply.

## How these fit together

The `pablo-*` skills form a loose pipeline: `pablo-goal-discovery` clarifies the ask,
`pablo-code-planning` scopes the work, `pablo-tdd` drives the implementation, and
`pablo-code-review` (or its component lenses) gates the result before merge.
`pablo-code-philosophy` sits underneath all of them as the shared rulebook; when a decision needs
mechanical detail rather than a principle, its `references/fp/` and `references/gof/` carry that
material.
