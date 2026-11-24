# LLMs

Skills and agents for coding harnesses such as Claude Code and pi. Portable reference material, with no project- or employer-specific content outside `academia/`.

## Setup

Skills live in `skills/<name>/SKILL.md`. Agents live in `agents/<name>.md` or `agents/<name>/AGENT.md`. Copy or symlink what you need into your harness, for example `~/.claude/skills/` and `~/.claude/agents/`.

`install-sync.sh` does it for you: it syncs skills, agents and scripts into the harnesses it finds, by symlink or copy, and never deletes anything. Use `--dry-run` to preview and `--help` for the options.

Frontmatter such as `tools`, `model` and turn limits is harness-specific. The files use generic placeholders, so adjust them after copying.

## Skills

Each skill is described in [skills/README.md](skills/README.md).

| Skill | What it does |
|---|---|
| `pablo-code-philosophy` | Rules for writing code: YAGNI, KISS, DRY, SOLID, plus style. Most other skills lean on it. |
| `pablo-goal-discovery` | Turns a vague ask into a confirmed goal through an interview. |
| `pablo-code-planning` | Plans reuse, scope, public API and tests before any code. |
| `pablo-tdd` | The red-green loop, test placement, anti-patterns. |
| `pablo-code-simplify` | Plans a behavior-preserving simplification. Never edits code. |
| `refactor-identification` | Finds refactor candidates in a branch diff. |
| `code-review-checklist` | Read-only review of a diff against the coding philosophy. |
| `pablo-test-review` | Read-only review of the tests in a diff. |
| `qa-adversary` | Hunts bugs and regressions in a diff. Read-only. |
| `pablo-pr-review` | Reviews a PR in one pass by running the four review lenses. |
| `pablo-code-review` | Reviews your own branch before the PR. Print-only. |
| `writing-agent-skills` | How to write a skill. |
| `evaluating-agent-skills` | How to build an eval suite for a skill. |
| `human-like-writing` | Rewrites text so it reads as written by a person. |

## Agents

| Agent | What it does |
|---|---|
| `analyst` | Read-only analysis; takes a lens file to specialize. |
| `planner` | Read-only planning, with an internal or external lens. |
| `worker` | Executes delegated tasks: code, writing, research, shell. |
| `scout` | Fast read-only recon of files, symbols and references. |
| `web-scout` | Fast web search with parallel queries. |
| `code-implementer` | Implements one named slice through a persisted S0-S9 TDD state machine with fixed evidence. |
| `critical-thinker` | Challenges another agent's decisions and hidden assumptions. |

All agents also work standalone in chat.

## Other

- `pi-simple-agents/`, `pi-simple-sri/`, `pi-memory-lite/` and `pi-syntax-highlight/` are npm packages for pi, each with its own README and CHANGELOG.
  - `pi-simple-agents`: subagents as Markdown files, run with one tool call.
  - `pi-simple-sri`: improvement loop for skills (diagnose, propose, gate).
  - `pi-memory-lite`: global memory kept out of the system prompt.
  - `pi-syntax-highlight`: highlighting for tool output and untagged code fences.
- `pi-themes/monokai-soda.json` is a pi TUI theme.
- `academia/` has Spanish skills for thesis work, installed with its own `install-tesis.sh`. They are tied to one thesis project.
- `CHANGELOG.md` tracks repo-level changes.
