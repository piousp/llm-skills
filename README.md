# LLMs

Skills and agents for coding harnesses such as Claude Code and pi. Portable reference material only; no project- or employer-specific content.

## Setup

Skills live under `skills/<name>/SKILL.md`. Agents live under `agents/<name>.md` or `agents/<name>/AGENT.md`. Symlink or copy what you need into the harness discovery path, for example `~/.claude/skills/` and `~/.claude/agents/`.

Frontmatter, such as `tools`, `model`, and turn limits, is harness-specific. The files use generic placeholders, so adjust them after copying.

## Skills

| Skill | What it does |
|---|---|
| `pablo-code-philosophy` | Decision pipeline for code: YAGNI, KISS, DRY, SOLID, plus style rules. Most other skills here delegate to it. |
| `pablo-goal-discovery` | Turns a vague ask into a confirmed goal through a structured interview. |
| `pablo-code-planning` | Plans the code to touch: reuse opportunities, scope, public API, and test plan, before any implementation. |
| `pablo-tdd` | The red-green loop: what a good test is, where tests go, anti-patterns. |
| `pablo-toolkit` | Session-scoped transparency for the pablo-* skills: prompt preview before delegation, change tree after edits. |
| `functional-programming` | Mechanical FP guidance for Java and Scala: immutability, composition, typed error handling. |
| `gof-design-patterns` | 12 GoF patterns with a code-smell to pattern table and an over-engineering guard. |
| `refactor-identification` | Detects structural refactor candidates in a branch diff: missing abstractions, weak encapsulation, poor data types. |
| `iterative-design` | Coordinator method that ties the others together: goal discovery, planner, one vertical TDD loop, refactor, QA gate. Invoked by name only. |
| `code-review-checklist` | Review lens: checks a diff against the coding philosophy and flags test coverage gaps. Read-only. |
| `qa-adversary` | Adversarial QA lens: hunts correctness bugs and regressions in a diff. Read-only. |
| `agent-prompting` | How to write and assemble delegation prompts for subagents: flow map, templates, delegate-vs-do criteria. |
| `writing-agent-skills` | Authoring a skill's SKILL.md and support files, with an eval suite. |
| `evaluating-agent-skills` | Building an eval suite for an existing skill: success criteria, prompt set, layered checks. |
| `human-like-writing` | Rewrites text so it reads as written by a person, in any genre. |

## Agents

| Agent | What it does |
|---|---|
| `analyst` | Read-only analysis for any domain. Takes a lens file to specialize. |
| `planner` | Read-only planning; picks an internal lens or applies an external one. |
| `worker` | Executor for delegated tasks: code, writing, research, shell. |
| `scout` | Fast read-only codebase recon: files, symbols, references. |
| `web-scout` | Fast web search: parallel queries, picks the best source. |
| `code-implementer` | Writes source and test files only, under a caller-supplied lens. |
| `critical-thinker` | Antagonistic critic of another agent's decisions; catches hidden assumptions. |

All agents also work standalone in chat, independent of `iterative-design`.

## Other

- `pi-simple-agents/` is an npm package for pi with its own README and CHANGELOG, not a skill or agent file.
- `pi-themes/monokai-soda.json` is a pi TUI theme, the only pi-specific file here.
