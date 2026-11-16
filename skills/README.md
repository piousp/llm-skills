# Skills

What each skill does and when to use it. Each one is a `<name>/SKILL.md`; copy or symlink the ones you need into your harness.

## Code and planning

`pablo-code-philosophy`: the rules for writing code. YAGNI first, then KISS, DRY and SOLID, with a fixed order when they conflict. It also sets style: data before behavior, thin entry points, composition over inheritance. Use it whenever you write, edit or refactor code.

`pablo-code-planning`: plans the change without writing it. Names what to reuse, which abstractions to add, the public API and the test plan. Use it before implementation.

`pablo-goal-discovery`: for vague asks. Interviews you one numbered decision at a time, each with a recommendation, and stops only when you confirm. Writes `goal.md`. Skip it when the goal is already clear.

`pablo-tdd`: the red-green loop, where tests go, which mocks are fair, and which patterns to avoid. Use it when a change needs tests.

## Review and QA

`pablo-pr-review`: runs the four review lenses below on one diff and merges them into a single report. Use it for a full PR review. For a narrower question, call a lens directly.

`pablo-code-review`: the same four lenses on your own branch, before the PR. Diffs against the merge-base and groups findings by tier. Any `pablo-code-philosophy` violation counts as Major. Print-only.

`qa-adversary`: assumes the change is broken and looks for logic bugs, bad data handling and regressions. Reads tests, never runs them, never edits code.

`code-review-checklist`: checks a diff against the quality checklist. Style and structure, not correctness. Read-only.

`pablo-test-review`: checks whether the changed tests can fail and flags brittle or missing assertions. Read-only.

`refactor-identification`: finds structural problems in a diff: missing abstractions, leaky encapsulation, primitives standing in for domain types. Every finding cites a file and line.

`pablo-code-simplify`: plans a simplification that keeps behavior. Runs a structural and a readability analysis, filters out changes that aren't needed, and returns an ordered plan. It never writes code.

## Language-specific technique

FP and GoF mechanics live inside `pablo-code-philosophy`, in `references/fp/` and `references/gof/`.

## Skill authoring

`writing-agent-skills`: how to write a SKILL.md, its frontmatter, and a trigger description tight enough to fire at the right time.

`evaluating-agent-skills`: how to build an eval suite for a finished skill, with offline tests, live probes and LLM-as-judge checks.

## Writing

`human-like-writing`: rules and a workflow for text that reads as human: a banned-word list, no em dashes or formula closers, varied rhythm, a visible stance. Use it before drafting anything longer than a one-line reply.

## How they fit together

The `pablo-*` skills form a loose pipeline. `pablo-goal-discovery` clarifies the ask, `pablo-code-planning` scopes it, `pablo-tdd` drives the build, and `pablo-code-review` checks the branch before the PR. `pablo-pr-review` reviews the open PR. `pablo-code-philosophy` is the shared rulebook under all of them.
