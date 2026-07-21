# LLMs

Public skills and agents for coding agents (Claude Code, pi, and similar harnesses). Everything
here is harness-agnostic reference material — no project- or employer-specific content.

Skills live under `skills/<name>/SKILL.md`; agents live under `agents/<name>/AGENT.md`. Symlink
(or copy) the ones you want into your harness's discovery path (e.g. `~/.claude/skills/`,
`~/.claude/agents/`).

## Skills

| Skill | Purpose |
|---|---|
| [`pablo-code-philosophy`](skills/pablo-code-philosophy/SKILL.md) | Core code philosophy: simplicity, readability, YAGNI, data-first design. The lens most other skills/agents here delegate to. |
| [`functional-programming`](skills/functional-programming/SKILL.md) | Mechanical FP guidance for Java/Scala — immutability, composition, typed error handling (Option/Either) — plus a when-NOT-to-apply table. |
| [`gof-design-patterns`](skills/gof-design-patterns/SKILL.md) | Curated subset of 12 GoF patterns with a code-smell → pattern table and an over-engineering guard. |
| [`refactor-identification`](skills/refactor-identification/SKILL.md) | Evidence-based detection of structural refactor candidates in a branch diff (missing abstractions, weak encapsulation, poor data types, flag-modeled variants). Identifies direction only. |
| [`tdd`](skills/tdd/SKILL.md) | Reference for the red → green loop: what a good test is, where tests go, anti-patterns. |
| [`iterative-design`](skills/iterative-design/SKILL.md) | Coordinator method tying the above together: TODO list → goal discovery → planner (`plan.md`) → one vertical TDD loop → one combined refactor phase → `qa-adversary` gate. The lead agent only delegates, never implements. |
| [`prompt-generator`](skills/prompt-generator/SKILL.md) | Sharpens a vague ask into a precise, portable prompt before any exploration or spec work begins. |

## Agents

| Agent | Purpose |
|---|---|
| [`code-review-checklist`](agents/code-review-checklist/AGENT.md) | Read-only reviewer: runs a strict checklist (red flags, data shape, complexity, boundaries, abstractions, structural smells, tests) against a diff and reports coverage gaps. |
| [`qa-adversary`](agents/qa-adversary/AGENT.md) | Read-only adversarial QA critic: hunts correctness bugs, regressions, and business-rule violations via a 7-lens process; never judges style, never runs tests. Complements `code-review-checklist`. |

Both agents are self-contained prompt targets for `iterative-design`'s refactor/QA phases, but also
work standalone in chat.

## Using these files

Frontmatter (`tools`, `model`, turn limits, etc.) is harness-specific — the files here use a
generic placeholder and a portability note. Adjust to your harness's conventions when you copy or
symlink them in.
